# Vellure content bot (Render)

Cron worker: 4 PM product post, 6 PM Reel concept, 7 PM attar benefits (Asia/Dhaka).
Each slot: OpenRouter writes the Bengali caption + image, Telegram shows a preview with
Approve / Discard buttons. Type a change in the chat to get a revised preview. Approve posts the photo to your Facebook Page.
The 6 PM slot generates a vertical AI video (OpenRouter /videos), previews it in Telegram, and on Approve uploads it to the Page as a Reel.

## Deploy
1. Push this folder to a GitHub repo (`.env` is ignored).
2. Render dashboard -> New -> Blueprint -> pick the repo (reads `render.yaml`).
3. Fill the env vars marked `sync: false`:
   - `OPENROUTER_API_KEY`, `OPENROUTER_TEXT_MODEL`, `OPENROUTER_IMAGE_MODEL`, `OPENROUTER_VIDEO_MODEL`
     (image models: `https://openrouter.ai/api/v1/models?output_modalities=image`; image-only models need `OPENROUTER_IMAGE_MODALITIES=image`)
   - `TELEGRAM_BOT_TOKEN` (BotFather), `TELEGRAM_CHAT_ID` (your numeric chat id)
   - `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_TOKEN` (see below)
4. Deploy. In the logs look for `scheduled` (3 lines) and `telegram webhook set`.
5. Test: in Telegram send `/run product` to the bot, or
   `curl -X POST https://<service>.onrender.com/run/product -H "x-admin-key: <WEBHOOK_SECRET>"`.

## Facebook Page token
Create a Meta app, add the Page permissions `pages_manage_posts` and `pages_read_engagement`,
make a long-lived user token, then call `GET /me/accounts` to get the Page access token
(a Page token made from a long-lived user token does not expire). Check the current Graph API version
in Meta's docs and set `GRAPH_VERSION` if `v25.0` is retired.

## Notes
- Use the **Starter** plan: free web services sleep and miss cron times.
- Pending drafts live in memory; a restart or redeploy clears them (you get a message if you press an old button).
- Costs: video is the expensive part. Check `pricing_skus` at `https://openrouter.ai/api/v1/videos/models` (price per video second) before choosing a model; 5 s, 720p, no audio keeps it lowest. Revisions regenerate the video only when the change needs it.
- Facebook Reels API allows 30 API-published posts per 24 h; Reels must be vertical (9:16).
- Instagram: the Graph API needs a public image URL, so add it later with image hosting.
- Never paste keys in chat or commit them. If a key leaked, delete it and make a new one.

## Troubleshooting (no reply to /run product)
1. Logs must show `telegram webhook set` with `lastError: null`. `setWebhook failed` or an empty `PUBLIC_URL` means Telegram cannot reach the service.
2. Open `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` in your browser (never share the token). Check `url` ends with `/telegram/<40 hex chars>`, and read `last_error_message`.
3. Send `/run product`. Logs should show `telegram update received`. If not, the webhook is not arriving (step 1/2). If you see `ignored message from other chat`, fix `TELEGRAM_CHAT_ID`.
4. Bypass Telegram inbound: `curl -X POST https://<service>.onrender.com/run/product -H "x-admin-key: <WEBHOOK_SECRET>"`. A preview or a "draft toiri hoy ni" message means outbound Telegram works; the text says what failed (model id, OpenRouter credit, etc).
