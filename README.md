# Vellure content bot (Render)

Cron worker: 4 PM product post, 6 PM Reel concept, 7 PM attar benefits (Asia/Dhaka).
Each slot: OpenRouter writes the Bengali caption + image, Telegram shows a preview with
Approve / Discard buttons. Type a change in the chat to get a revised preview. Approve posts the photo to your Facebook Page.
The Reel slot sends the concept only (no video is generated or posted).

## Deploy
1. Push this folder to a GitHub repo (`.env` is ignored).
2. Render dashboard -> New -> Blueprint -> pick the repo (reads `render.yaml`).
3. Fill the env vars marked `sync: false`:
   - `OPENROUTER_API_KEY`, `OPENROUTER_TEXT_MODEL`, `OPENROUTER_IMAGE_MODEL`
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
in Meta's docs and set `GRAPH_VERSION` if `v23.0` is retired.

## Notes
- Use the **Starter** plan: free web services sleep and miss cron times.
- Pending drafts live in memory; a restart or redeploy clears them (you get a message if you press an old button).
- Costs: 2 OpenRouter calls for slots 4 PM and 7 PM, 1 for 6 PM; revisions add 1 text call (+1 image call if the picture changes).
- Instagram: the Graph API needs a public image URL, so add it later with image hosting.
- Never paste keys in chat or commit them. If a key leaked, delete it and make a new one.
