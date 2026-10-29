# Telegram Account ID Approval and Live Chat Setup

This project does not use Firebase for user approval or Live Chat. There is no admin web panel; the Telegram Bot is the only admin interface for approving or rejecting account IDs. WebDev Managed MySQL is shared by Preview/development and production, so database writes affect the same persistent data.

## Server configuration

Use WebDev Managed MySQL and its `DATABASE_URL`. The server also requires these protected secrets:

- `TELEGRAM_BOT_TOKEN`: token supplied by BotFather.
- `TELEGRAM_ADMIN_USER_ID`: the administrator's numeric Telegram user ID, not a username.

Keep these values in protected server settings only. Never place them in HTML, Git, logs, setup files, Telegram messages, or chat. The old Firebase service-account and admin-password secrets are unused by this code and were not automatically deleted.

## Start the Telegram Bot

1. Create a bot with `@BotFather` using `/newbot`, or use the existing bot. Store its token only as `TELEGRAM_BOT_TOKEN`.
2. Store the administrator's numeric Telegram ID only as `TELEGRAM_ADMIN_USER_ID`. The server accepts approval callbacks only from that ID in its private chat with the bot.
3. The administrator must open the bot and send `/start`. At server startup, the app calls `deleteWebhook` with `drop_pending_updates: false`, removing the webhook while preserving pending updates. It then uses `getUpdates` long polling. On reconnect, it retries webhook removal without dropping pending updates. An approval update is acknowledged only after its handler succeeds.
4. Check `GET /api/health` for `databaseReady: true` and `telegramReady: true`. The response does not include credentials.
5. Run only one server process polling with a given bot token. Two simultaneous pollers can conflict.

Official Telegram API reference: [`getUpdates`, `deleteWebhook`, `sendMessage`, `callback_query`, `answerCallbackQuery`](https://core.telegram.org/bots/api).

## Verify user account IDs

1. A user enters lottery-platform login details on `index.html` or `user.html`. The browser sends the platform token to this app server over HTTPS.
2. The server calls only the matching allowlisted platform API `GetUserInfo` endpoint. It compares the returned Account ID with the ID shown to the user. If the provider is unavailable or the IDs differ, access is denied and no approval request is created.
3. If the verified `(platform, accountId)` pair is not already approved, the server creates a pending request and sends only the platform and verified account ID to Telegram. It does not store the password or platform token in Telegram, MySQL, or server logs.
4. The administrator selects the Burmese `ခွင့်ပြုမည်` (approve) or `ပယ်ချမည်` (reject) button in the bot's private chat. An approval is persisted in `approved_accounts` and allows the current login to continue. A rejection does not grant game access. The administrator can use `/pending` to list requests awaiting a decision.
5. At each later login, the server re-verifies the platform token and ID, then checks the saved approval. A previously approved user does not need a second Telegram approval.

## Server sessions and Live Chat

After approval, the server re-verifies the token and ID and issues a 12-hour `HttpOnly; Secure; SameSite=None` cookie. Set `SESSION_COOKIE_SECURE=false` only for plain-HTTP local testing; do not set it for Preview or production. The database stores hashes of session and CSRF tokens, not the raw tokens. The platform token is not stored in MySQL.

Chat requests use identity from the server session, not an account ID supplied by the browser. Chat POST requests require a CSRF header. Messages are rendered as text, not HTML. New chat history starts empty.

## Managed MySQL and old Firebase data

At startup, the server prepares `approved_accounts`, `approval_requests`, `chat_messages`, and `user_sessions` with `CREATE TABLE IF NOT EXISTS`. The migration is additive and does not delete tables or rows.

The app does not read, export, or import the old Firebase `approved_users` list or Firebase chat history. Every user, including someone previously approved in Firebase, must receive one new Telegram approval. This project does not modify Firebase source data or rules.

## Run and verify

Requires Node.js 20 or newer and npm:

```sh
npm ci
npm start
```

`GET /api/health` reports only database and bot readiness booleans. A real platform login is required to trigger a Telegram approval notification. Live Chat writes persist to the shared Managed MySQL database, so use a real account only for an owner-approved live check. This project has not been publicly published.
