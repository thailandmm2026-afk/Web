# TODO

## Shared, consistent Burmese UI
- [x] Keep the existing mobile-first dark ULTRA BET visual identity and make the `index.html` and `user.html` interfaces consistent through shared design tokens and component styling. Align colors, typography, spacing, cards, buttons, form controls, dialogs, status indicators, and responsive behavior while retaining page-specific content and existing interactions.
- [x] Preserve Burmese end-user text and ensure readable Burmese typography across the login, approval, app, and Live Chat interfaces. Reuse the supplied ULTRA mark.

## Unapproved-ID login dialog
- [ ] When login succeeds at the platform but the verified ID has no admin approval, show this text in the dialog: `❌ သင်၏ ID အား အတည်ပြုမထားရသေးပါ .`; `ℹ️ Admin အား ခွင့်ပြုချက်တောင်းပါ .`; `ℹ️ ခွင့်ပြုချက်တောင်းရန် @kiki20251 သို့ ID ပို့ပေးပါ:`; and `├─ သင်၏ ID: <verified account ID>`. Make `@kiki20251` a working Telegram link, keep the ID dynamic from the server-verified account, and do not hardcode the example ID `101479`.
- [ ] Keep the same polished, responsive approval-dialog styling on `index.html` and `user.html`. Preserve automatic bot requests and clearly show the current pending, rejected, timeout, or send-error state without hiding the contact instructions or verified ID.

## Telegram admin: view and revoke approved IDs
- [ ] In the Telegram bot's private chat, only the configured numeric admin ID can use `/approved` to view approved `(platform, accountId)` records. Paginate the list when needed; show the platform and complete account ID; keep unauthorized group chats and non-admin users unable to view or change the list.
- [ ] Give each listed account an explicit confirmation step before revoking it. On confirmation, revoke only that `(platform, accountId)` in a database transaction, invalidate that identity's existing server sessions, and mark its current approval request as `revoked`. Keep `chat_messages`, other users' records and all Firebase data unchanged.
- [ ] Keep revoke callbacks admin-only, private-chat-only, short, expiring and safe against stale/replayed clicks. An already-open browser session must detect that its server session/approval was revoked, clear the local session and return to login. This revokes access to this app; it does not revoke the user's separate lottery-platform account or token.
- [ ] Do not test revocation by deleting real approved IDs in the shared Managed MySQL database. Validate the transactional behavior without mutating production-shared user records.

## Platform identity and Telegram approval
- [x] Verify the platform token server-side through an allowlisted `GetUserInfo` API. Deny access if the returned Account ID differs from the user-visible ID or provider verification fails. Mock verification covered matching IDs, mismatches, invalid tokens and signed request payloads.
- [x] Do not send unverified IDs to the administrator. Send only `(platform, verifiedAccountId)` to Telegram; do not store the platform token or password in Telegram messages, MySQL or server logs.
- [x] Create a pending request for an unapproved ID. Only the configured numeric Telegram administrator can decide through the private-chat Burmese `ခွင့်ပြုမည်` or `ပယ်ချမည်` buttons. Approval resumes the current login; rejection does not grant access.
- [x] Persist `(platform, accountId)` approvals in Managed MySQL. At every later login, re-verify the platform token server-side and use the saved approval. Every former Firebase user must receive one new Telegram approval.
- [x] Show pending, rejected, timeout and Telegram error states in Burmese and allow the user to retry. Use Burmese fallbacks instead of untranslated provider/network errors.

## Server sessions and Live Chat
- [x] After approval, re-verify the platform token and real Account ID, then issue a 12-hour server session. Do not store the platform token or raw session/CSRF token; store only token hashes.
- [x] Do not trust a browser-provided account ID in Chat APIs. Derive identity from the server session, require CSRF on chat POST, and deny chat access without a session.
- [x] Keep the Live Chat UI and store new messages in Managed MySQL. Render message content as text, not HTML.
- [x] Do not read, export or import Firebase approval or chat history. Start new chat history empty and require one new Telegram approval for every user.

## Telegram, database and Firebase removal
- [x] Keep the Bot token and numeric Telegram admin ID in protected server settings only. Only the configured admin's private chat may approve/reject.
- [x] Create `approved_accounts`, `approval_requests`, `chat_messages` and `user_sessions` using `CREATE TABLE IF NOT EXISTS` without deleting existing tables or rows.
- [x] Remove Firebase SDK/config/API from `index.html` and `user.html`; do not use `admin.html` or Firebase Admin UI/dependencies. Remove the stale fallback that displayed login credentials in an alert.
- [x] Do not use old Firebase service-account or admin-password secrets in code. Do not delete those protected settings without separate owner approval.
- [x] On startup, call `deleteWebhook(drop_pending_updates: false)` and use the project's Telegram long poller while preserving pending updates. Run only one active poller for the same bot token.
- [x] On reconnect, retry webhook removal without dropping pending updates; only advance the Telegram update offset after the update handler succeeds, so transient database errors do not acknowledge an unprocessed approval callback.

## Public web link and container deployment
- [ ] The user selected “Public web link (publish လုပ်ရန် ခွင့်ပြုသည်)”. Publish the app from a recorded canonical `main` checkpoint and provide the resulting URL only after the platform confirms a successful public deployment.
- [x] Build the server app from a committed root `Dockerfile` using Node 22, the committed npm lockfile and pinned package-manager version; install production dependencies, start `npm start`, and listen on `0.0.0.0` using runtime `PORT` (default `3000`).
- [x] Configure the container health path as `/api/health`; the successful published deployment used this unauthenticated health route. Read database/Telegram credentials only at runtime and never bake them into the image or browser output.
- [x] The config reports `publishing.auto_publish: true`; the public deployment for `83ac82379eedb9eb26734bfed749f5da2bb6770d` succeeded. Do not submit a duplicate manual publish for the same checkpoint.
- [x] Stop the Preview development process before production polling starts; keep only one active Telegram poller on the bot token. Production deployment success was confirmed; the public URL still needs to be retrieved from the authenticated dashboard.

## Owner-operated live actions and handoff
- [ ] The administrator sends `/start` to the bot, performs a real platform login to trigger an approval notification, and confirms both the `ခွင့်ပြုမည်` and `ပယ်ချမည်` outcomes with a real user ID.
- [ ] With an approved real user session, the owner reads Live Chat and sends a new message. This writes persistent data to the shared Managed MySQL database, so it requires the owner's live test.
- [x] Re-check `GET /api/health` after the updated server starts and confirm database and Telegram readiness. Previous response: `databaseReady: true`, `telegramReady: true`. Startup logs showed repeated Telegram polling pause/reconnect cycles, so the owner must ensure only one active poller uses the bot token before live approval tests.
- [x] The earlier private/no-publish decision was superseded by the user's later explicit selection of a public web link. Keep secrets protected and do not share the public URL until successful publication is confirmed.
