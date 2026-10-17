// Vellure content bot: cron -> OpenRouter -> Telegram preview -> approve -> Facebook Page
// Node 20+. No build step. Dependencies: express, node-cron.
import express from "express";
import cron from "node-cron";
import crypto from "node:crypto";

// ---------- Config ----------
const env = (k, d = "") => (process.env[k] ?? d).trim();
const CFG = {
  tz: env("TZ", "Asia/Dhaka"),
  port: Number(env("PORT", "10000")),
  site: env("SITE_URL", "https://vellurefragrances.com"),
  whatsapp: env("WHATSAPP_NUMBER"),
  secret: env("WEBHOOK_SECRET"), // any string; used for the x-admin-key header and to derive the webhook path
  publicUrl: env("PUBLIC_URL", env("RENDER_EXTERNAL_URL")),
  orKey: env("OPENROUTER_API_KEY"),
  textModel: env("OPENROUTER_TEXT_MODEL"),
  imageModel: env("OPENROUTER_IMAGE_MODEL"),
  imageModalities: env("OPENROUTER_IMAGE_MODALITIES", "image,text").split(","),
  videoModel: env("OPENROUTER_VIDEO_MODEL"),
  videoDuration: Number(env("VIDEO_DURATION", "5")),
  videoResolution: env("VIDEO_RESOLUTION", "720p"),
  videoAudio: env("VIDEO_AUDIO", "false") === "true",
  tgToken: env("TELEGRAM_BOT_TOKEN"),
  tgChat: env("TELEGRAM_CHAT_ID"),
  fbPage: env("FACEBOOK_PAGE_ID"),
  fbToken: env("FACEBOOK_PAGE_TOKEN").replace(/^["']|["']$/g, "").trim(),
  graph: env("GRAPH_VERSION", "v25.0"),
  products: env("PRODUCTS", "Armani Style,Desire,Aqua Di Gio,Vampire Blood")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

// URL-safe token derived from the secret (the raw secret may contain "/", "+", "=")
const hookToken = crypto.createHash("sha256").update(CFG.secret || "none").digest("hex").slice(0, 40);

const SCHEDULE = {
  product: env("CRON_PRODUCT", "0 16 * * *"), // 4:00 PM
  reel: env("CRON_REEL", "0 18 * * *"), // 6:00 PM
  benefits: env("CRON_BENEFITS", "0 19 * * *"), // 7:00 PM
};

// ---------- Logging and helpers ----------
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpError(service, status, body) {
  const detail = typeof body === "string" ? body : JSON.stringify(body).slice(0, 400);
  const e = new Error(`${service} ${status}: ${detail}`);
  e.status = status;
  return e;
}

async function withRetry(fn, label, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      log("warn", `${label} failed`, { attempt: i, error: e.message });
      const fatal = [400, 401, 402, 403, 404].includes(e.status);
      if (i === tries || fatal) throw e;
      await sleep(3000 * 2 ** (i - 1));
    }
  }
}

// Detect the real image format so the upload is labelled correctly (models may return JPEG/WebP)
function sniffImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return ["image/png", "png"];
  if (buf[0] === 0xff && buf[1] === 0xd8) return ["image/jpeg", "jpg"];
  if (buf.subarray(0, 4).toString() === "RIFF") return ["image/webp", "webp"];
  return ["image/png", "png"];
}

// Page node: with a Page access token, "me" is the Page itself, so FACEBOOK_PAGE_ID is optional
const fbNode = () => CFG.fbPage || "me";

function missing(keys) {
  return keys.filter((k) => !CFG[k]);
}

function dayNumber() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: CFG.tz }));
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

function productOfTheDay(offset = 0) {
  return CFG.products[(dayNumber() + offset) % CFG.products.length];
}

// ---------- OpenRouter ----------
async function orChat(body, timeoutMs) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CFG.orKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": CFG.site,
      "X-Title": "Vellure Content Bot",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError("OpenRouter", res.status, data);
  return data;
}

function parseJson(text) {
  const clean = String(text).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(clean);
}

async function generateJson(system, user) {
  return withRetry(async () => {
    const data = await orChat(
      {
        model: CFG.textModel,
        temperature: 0.8,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      60_000
    );
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter returned no text");
    return parseJson(content);
  }, "text generation");
}

async function generateImage(prompt) {
  return withRetry(async () => {
    const data = await orChat(
      {
        model: CFG.imageModel,
        modalities: CFG.imageModalities,
        messages: [{ role: "user", content: `${prompt}. Portrait 4:5, no text, no logos, no watermark.` }],
      },
      180_000
    );
    const url = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!url) throw new Error("OpenRouter returned no image");
    if (url.startsWith("data:")) return Buffer.from(url.split(",")[1], "base64");
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw httpError("Image download", r.status, "");
    return Buffer.from(await r.arrayBuffer());
  }, "image generation");
}

async function orFetch(url, opts = {}, timeoutMs = 60_000) {
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${CFG.orKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": CFG.site,
      "X-Title": "Vellure Content Bot",
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Async job: submit -> poll -> download. Only the submit step is retried so a video is never paid for twice.
async function generateVideo(prompt) {
  const job = await withRetry(async () => {
    const res = await orFetch("https://openrouter.ai/api/v1/videos", {
      method: "POST",
      body: JSON.stringify({
        model: CFG.videoModel,
        prompt,
        duration: CFG.videoDuration,
        resolution: CFG.videoResolution,
        aspect_ratio: "9:16",
        generate_audio: CFG.videoAudio,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError("OpenRouter video submit", res.status, data);
    return data;
  }, "video submit", 2);

  const pollUrl = job.polling_url || `https://openrouter.ai/api/v1/videos/${job.id}`;
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    await sleep(15_000);
    let st;
    try {
      const r = await orFetch(pollUrl);
      st = await r.json().catch(() => ({}));
      if (!r.ok) throw httpError("OpenRouter video poll", r.status, st);
    } catch (e) {
      log("warn", "video poll error", { error: e.message });
      if ([401, 403, 404].includes(e.status)) throw e;
      continue;
    }
    log("info", "video status", { status: st.status });
    if (st.status === "failed") throw new Error(`Video generation failed: ${st.error || "unknown"}`);
    if (st.status === "completed") {
      const url = st.unsigned_urls?.[0] || `https://openrouter.ai/api/v1/videos/${job.id}/content?index=0`;
      const r = await orFetch(url, {}, 180_000);
      if (!r.ok) throw httpError("Video download", r.status, "");
      return Buffer.from(await r.arrayBuffer());
    }
  }
  throw new Error("Video generation timed out (12 minutes)");
}

// ---------- Content definitions ----------
const SYSTEM = `You are the social media copywriter for Vellure, an online attar and perfume brand in Bangladesh.
Tone: premium, warm, sophisticated. Write in Bengali script with light English words and emojis. Be concise and ready to publish.
Never invent prices, discounts, ingredients, scent notes or health claims. Describe scent only in general terms (fresh, woody, sweet, warm, aquatic).
Known facts you may use: Vellure attars are 100% pure, alcohol-free, concentrated perfume oil made for long-lasting wear.
Image prompts must not contain brand logos or text. Return ONLY valid JSON with no markdown.`;

const cta = () =>
  `a clear call to action to order via inbox or WhatsApp${CFG.whatsapp ? ` (${CFG.whatsapp})` : ""}`;

const SLOTS = {
  product: {
    label: "4:00 PM Product Showcase",
    image: true,
    publish: true,
    prompt: () => `Product showcase post for today. Feature: ${productOfTheDay()}.
Focus on premium scent, longevity and elegance. Return JSON with keys:
product, caption (max 5 short lines, ends with ${cta()}), hashtags (10 hashtags mixing Bengali and English, one string),
image_prompt (English, premium product photo, warm golden light, dark luxurious background, no people).`,
  },
  reel: {
    label: "6:00 PM Reel",
    image: false,
    video: true,
    publish: true,
    prompt: () => `Short vertical Reel for today. Feature: ${productOfTheDay(1)}.
Return JSON with keys: hook (first 2 seconds, one line, Bengali), video_concept (2-3 lines in Bengali describing what the viewer sees),
caption (punchy, trendy, ends with ${cta()}), hashtags (8 hashtags, one string),
video_prompt (English, ONE continuous cinematic scene: elegant attar bottle, golden light, slow camera move, a drop of oil or soft smoke, dark luxurious background; no people, no hands, no on-screen text, no logos).`,
  },
  benefits: {
    label: "7:00 PM Attar Benefits",
    image: true,
    publish: true,
    prompt: () => `Educational/lifestyle post about why traditional attar is great for daily wear and office use
(alcohol-free, long-lasting, concentrated oil, a little goes a long way). No medical or spiritual claims. Pick a fresh angle each day (seed ${dayNumber()}).
Return JSON with keys: topic, caption (max 6 short lines, ends with a soft Vellure plug and ${cta()}),
hashtags (10 hashtags, one string), image_prompt (English, calm lifestyle or attar-bottle photo, no people).`,
  },
};

function renderText(slotKey, d) {
  const tags = Array.isArray(d.hashtags) ? d.hashtags.join(" ") : d.hashtags || "";
  if (slotKey === "reel")
    return `🎬 Hook: ${d.hook}\n\n🎞 Concept: ${d.video_concept}\n\n${d.caption}\n\n${tags}`;
  return `${d.caption}\n\n${tags}`;
}

// ---------- Telegram ----------
async function tg(method, payload, form) {
  const res = await fetch(`https://api.telegram.org/bot${CFG.tgToken}/${method}`, {
    method: "POST",
    headers: form ? undefined : { "Content-Type": "application/json" },
    body: form ?? JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw httpError("Telegram", res.status, data);
  return data.result;
}

const sendText = (text, extra = {}) =>
  withRetry(() => tg("sendMessage", { chat_id: CFG.tgChat, text: text.slice(0, 4000), ...extra }), "telegram text");

async function notify(text) {
  try {
    await sendText(text);
  } catch (e) {
    log("error", "notify failed", { error: e.message });
  }
}

async function sendPreview(id) {
  const p = pending.get(id);
  const body = `📝 DRAFT • ${p.label}\n\n${renderText(p.slotKey, p.draft)}`;
  const buttons = {
    inline_keyboard: [
      [
        { text: p.publish ? "✅ Approve & Post" : "✅ Approve", callback_data: `ok:${id}` },
        { text: "❌ Discard", callback_data: `no:${id}` },
      ],
    ],
  };
  const hint = "\n\n✏️ Change chaile ei chat e likhe din (jemon: caption chhoto koro).";
  if (p.video) {
    const mb = p.video.length / 1048576;
    if (mb > 49) {
      await sendText(`${body}\n\n⚠️ Video ${mb.toFixed(0)}MB, Telegram e preview pathano jay na, kintu Approve korle post hobe.${hint}`, { reply_markup: buttons });
      return;
    }
    const short = (body + hint).length <= 1000;
    await withRetry(() => {
      const fd = new FormData();
      fd.append("chat_id", CFG.tgChat);
      fd.append("video", new Blob([p.video], { type: "video/mp4" }), "vellure-reel.mp4");
      fd.append("supports_streaming", "true");
      if (short) {
        fd.append("caption", body + hint);
        fd.append("reply_markup", JSON.stringify(buttons));
      }
      return tg("sendVideo", null, fd);
    }, "telegram video");
    if (!short) await sendText(body + hint, { reply_markup: buttons });
    return;
  }
  if (p.image) {
    const short = (body + hint).length <= 1000;
    await withRetry(() => {
      const fd = new FormData();
      fd.append("chat_id", CFG.tgChat);
      const [mime, ext] = sniffImage(p.image);
      fd.append("photo", new Blob([p.image], { type: mime }), `vellure.${ext}`);
      if (short) {
        fd.append("caption", body + hint);
        fd.append("reply_markup", JSON.stringify(buttons));
      }
      return tg("sendPhoto", null, fd);
    }, "telegram photo");
    if (!short) await sendText(body + hint, { reply_markup: buttons });
  } else {
    await sendText(body + hint, { reply_markup: buttons });
  }
}

// ---------- Facebook ----------
async function postToFacebook(image, text, extra = {}) {
  return withRetry(async () => {
    const fd = new FormData();
    const [mime, ext] = sniffImage(image);
    fd.append("source", new Blob([image], { type: mime }), `vellure.${ext}`);
    fd.append("caption", text);
    for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
    fd.append("access_token", CFG.fbToken);
    const res = await fetch(`https://graph.facebook.com/${CFG.graph}/${fbNode()}/photos`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(90_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw httpError("Facebook", res.status, data);
    return data;
  }, "facebook post");
}

// Facebook Reels: start -> upload binary to rupload.facebook.com -> finish (publish)
async function postReelToFacebook(video, text) {
  const base = `https://graph.facebook.com/${CFG.graph}/${fbNode()}/video_reels`;
  const form = (obj) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(obj),
    signal: AbortSignal.timeout(60_000),
  });
  const check = async (res, label) => {
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error || d.success === false) throw httpError(label, res.status, d);
    return d;
  };
  const start = await withRetry(
    async () => check(await fetch(base, form({ upload_phase: "start", access_token: CFG.fbToken })), "Facebook reel start"),
    "fb reel start"
  );
  await withRetry(
    async () =>
      check(
        await fetch(start.upload_url, {
          method: "POST",
          headers: { Authorization: `OAuth ${CFG.fbToken}`, offset: "0", file_size: String(video.length) },
          body: video,
          signal: AbortSignal.timeout(180_000),
        }),
        "Facebook reel upload"
      ),
    "fb reel upload"
  );
  const done = await withRetry(
    async () =>
      check(
        await fetch(
          base,
          form({
            upload_phase: "finish",
            video_id: start.video_id,
            video_state: "PUBLISHED",
            description: text,
            access_token: CFG.fbToken,
          })
        ),
        "Facebook reel finish"
      ),
    "fb reel finish"
  );
  return { ...done, video_id: start.video_id };
}

// Diagnostic: shows which Page the token belongs to and whether FACEBOOK_PAGE_ID matches it
async function fbCheck() {
  if (!CFG.fbToken) return "FACEBOOK_PAGE_TOKEN set kora nei.";
  const get = async (path) => {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(
      `https://graph.facebook.com/${CFG.graph}/${path}${sep}access_token=${encodeURIComponent(CFG.fbToken)}`,
      { signal: AbortSignal.timeout(30_000) }
    );
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const me = await get("me?fields=id,name");
  let msg = `Token (/me): ${me.status} ${JSON.stringify(me.body).slice(0, 300)}`;
  if (CFG.fbPage) {
    const pg = await get(`${CFG.fbPage}?fields=id,name`);
    msg += `\nFACEBOOK_PAGE_ID (${CFG.fbPage}): ${pg.status} ${JSON.stringify(pg.body).slice(0, 300)}`;
    if (me.body?.id && me.body.id !== CFG.fbPage)
      msg += `\n⚠️ Token ta Page ${me.body.id} er, kintu FACEBOOK_PAGE_ID ${CFG.fbPage}. Env theke FACEBOOK_PAGE_ID muchhe din ba ${me.body.id} boshan.`;
  } else {
    msg += "\nFACEBOOK_PAGE_ID khali, bot token er Page e post korbe.";
  }
  return msg;
}

// ---------- Draft lifecycle ----------
const pending = new Map(); // id -> draft state (in memory)
const running = new Set();
let latestId = null;

function remember(state) {
  const id = Date.now().toString(36);
  pending.set(id, state);
  latestId = id;
  while (pending.size > 5) pending.delete(pending.keys().next().value);
  return id;
}

async function runSlot(slotKey) {
  const slot = SLOTS[slotKey];
  if (!slot) throw new Error(`Unknown slot: ${slotKey}`);
  if (running.has(slotKey)) return log("warn", "slot already running", { slotKey });
  running.add(slotKey);
  try {
    const need = missing(["orKey", "textModel", "tgToken", "tgChat"]);
    if (slot.image && !CFG.imageModel) need.push("imageModel");
    if (slot.video && !CFG.videoModel) need.push("videoModel");
    if (need.length) throw new Error(`Missing config: ${need.join(", ")}`);
    log("info", "slot started", { slotKey });

    const draft = await generateJson(SYSTEM, slot.prompt());
    if (slot.video) await notify("🎬 Reel er video toiri hocche, 3-10 minute lagte pare...");
    const image = slot.image ? await generateImage(draft.image_prompt) : null;
    const video = slot.video ? await generateVideo(draft.video_prompt) : null;
    const id = remember({ slotKey, label: slot.label, publish: slot.publish, image, video, draft });
    await sendPreview(id);
    log("info", "preview sent", { slotKey, id });
  } catch (e) {
    log("error", "slot failed", { slotKey, error: e.message });
    await notify(`⚠️ ${slot.label} draft toiri hoy ni.\n${e.message}`.slice(0, 900));
  } finally {
    running.delete(slotKey);
  }
}

async function approve(id) {
  const p = pending.get(id);
  if (!p) return notify("Ei draft ta ar nei (server restart hole pending draft muche jay).");
  try {
    if (!p.publish) {
      pending.delete(id);
      return notify("✅ Reel concept approved. Video ta toiri kore nijer hate post korun.");
    }
    const need = missing(["fbToken"]);
    if (need.length) throw new Error(`Missing config: ${need.join(", ")}`);
    const text = renderText(p.slotKey, p.draft);
    const out = p.video ? await postReelToFacebook(p.video, text) : await postToFacebook(p.image, text);
    const ref = out.post_id || out.id || out.video_id || "ok";
    pending.delete(id);
    log("info", "published", { id, fb: ref });
    await notify(`✅ Facebook e post hoyeche (${ref}).`);
  } catch (e) {
    log("error", "publish failed", { id, error: e.message });
    let diag = "";
    if (/Facebook/.test(e.message) && /"code":(100|190|200|10)\b/.test(e.message))
      diag = "\n\n🔎 " + (await fbCheck().catch((x) => `fbcheck failed: ${x.message}`));
    await notify(`⚠️ Post korte parini, draft ta ekhono ache. Abar Approve chapte paren.\n${e.message}${diag}`.slice(0, 2000));
  }
}

async function revise(id, instruction) {
  const p = pending.get(id);
  if (!p) return notify("Kono pending draft nei. Notun draft er jonno schedule er opekkha korun.");
  try {
    await sendText("✏️ Change korchi, ektu opekkha korun...");
    const keys = Object.keys(p.draft).join(", ");
    const out = await generateJson(
      SYSTEM,
      `Current draft JSON:\n${JSON.stringify(p.draft)}\n\nEdit instruction from the owner: "${instruction}"\n` +
        `Apply the instruction exactly and keep everything else. Return the full JSON with the same keys (${keys}) ` +
        `plus "regenerate_image" and "regenerate_video" (each true only if the instruction changes how the picture or video should look).`
    );
    const regen = out.regenerate_image === true;
    const regenVideo = out.regenerate_video === true;
    delete out.regenerate_image;
    delete out.regenerate_video;
    p.draft = { ...p.draft, ...out };
    if (p.image && regen) p.image = await generateImage(p.draft.image_prompt);
    if (p.video && regenVideo) {
      await sendText("🎬 Notun video toiri hocche, ektu opekkha korun...");
      p.video = await generateVideo(p.draft.video_prompt);
    }
    await sendPreview(id);
  } catch (e) {
    log("error", "revision failed", { id, error: e.message });
    await notify(`⚠️ Change korte parini.\n${e.message}`.slice(0, 900));
  }
}

// ---------- Telegram webhook ----------
async function handleUpdate(u) {
  const cb = u.callback_query;
  if (cb) {
    if (String(cb.message?.chat?.id) !== CFG.tgChat) {
      log("warn", "ignored button from other chat", { chatId: cb.message?.chat?.id, expected: CFG.tgChat });
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
    const [action, id] = String(cb.data).split(":");
    if (action === "ok") return approve(id);
    if (action === "no") {
      pending.delete(id);
      return notify("🗑 Draft discard kora hoyeche.");
    }
    return;
  }
  const m = u.message;
  if (!m?.text) return;
  if (String(m.chat.id) !== CFG.tgChat) {
    log("warn", "ignored message from other chat", { chatId: m.chat.id, expected: CFG.tgChat });
    return;
  }
  const text = m.text.trim();
  if (/^\/run\s+(product|reel|benefits)$/i.test(text)) return runSlot(text.split(/\s+/)[1].toLowerCase());
  if (/^(ok|okay|approve|approved)$/i.test(text)) return latestId ? approve(latestId) : notify("Kono pending draft nei.");
  if (/^\/fbtest$/i.test(text)) {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    return postToFacebook(png, "Vellure test (unpublished)", { published: "false" })
      .then((o) => notify(`✅ fbtest OK (unpublished photo): ${JSON.stringify(o).slice(0, 300)}`))
      .catch((e) => notify(`fbtest failed: ${e.message}`));
  }
  if (/^\/fbcheck$/i.test(text)) return fbCheck().then(notify).catch((e) => notify(`fbcheck failed: ${e.message}`));
  if (text.startsWith("/")) return notify("Command: /fbcheck | /fbtest | /run product | /run reel | /run benefits");
  return revise(latestId, text);
}

// ---------- Server ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, pending: pending.size }));

app.post(`/telegram/:token`, (req, res) => {
  if (req.params.token !== hookToken) {
    log("warn", "webhook hit with wrong token");
    return res.sendStatus(404);
  }
  log("info", "telegram update received", {
    type: req.body?.callback_query ? "button" : req.body?.message ? "message" : "other",
  });
  res.sendStatus(200); // answer fast, work in background
  handleUpdate(req.body).catch((e) => log("error", "update handler failed", { error: e.message }));
});

app.post("/run/:slot", (req, res) => {
  if (!CFG.secret || req.get("x-admin-key") !== CFG.secret) return res.sendStatus(404);
  if (!SLOTS[req.params.slot]) return res.status(400).json({ error: "slot must be product, reel or benefits" });
  runSlot(req.params.slot);
  res.json({ started: req.params.slot });
});

app.listen(CFG.port, async () => {
  log("info", "server started", { port: CFG.port, tz: CFG.tz });
  const need = missing(["secret", "orKey", "textModel", "imageModel", "videoModel", "tgToken", "tgChat"]);
  if (need.length) log("warn", "config missing", { need });

  for (const [slotKey, expr] of Object.entries(SCHEDULE)) {
    if (!cron.validate(expr)) {
      log("error", "invalid cron expression", { slotKey, expr });
      continue;
    }
    cron.schedule(expr, () => runSlot(slotKey).catch((e) => log("error", "cron crash", { error: e.message })), {
      timezone: CFG.tz,
    });
    log("info", "scheduled", { slotKey, expr });
  }

  if (!CFG.publicUrl) log("error", "PUBLIC_URL / RENDER_EXTERNAL_URL is empty, webhook cannot be set");
  if (CFG.tgToken && CFG.publicUrl) {
    try {
      const base = CFG.publicUrl.replace(/\/$/, "");
      await tg("setWebhook", {
        url: `${base}/telegram/${hookToken}`,
        allowed_updates: ["message", "callback_query"],
      });
      const info = await tg("getWebhookInfo", {});
      log("info", "telegram webhook set", {
        host: base,
        pending: info.pending_update_count,
        lastError: info.last_error_message || null,
      });
    } catch (e) {
      log("error", "setWebhook failed", { error: e.message });
    }
  }
});

process.on("unhandledRejection", (e) => log("error", "unhandledRejection", { error: String(e) }));
process.on("uncaughtException", (e) => log("error", "uncaughtException", { error: String(e) }));
