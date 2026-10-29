# Implementation Plan — ULTRA BET User App

## Scope and architecture

Continue from the supplied ULTRA BET source and keep the published app architecture, Burmese mobile-first UI and security decisions. The current change adds the requested unapproved-ID dialog content and Bot-based approved-ID management. The shared dark navy/cyan UI system remains in `public/ultra-ui.css`; `index.html` and `user.html` keep a common approval dialog. Their existing interactions remain intact.

When platform verification succeeds but an ID is not approved, show the user's exact Burmese notice in the dialog and a clickable `@kiki20251` contact link. Display the server-verified account ID dynamically; `101479` is an example, not a constant. Preserve the existing automatic Telegram request and approval-polling behavior, with a short status note explaining whether the bot request is pending, rejected, timed out, or failed.

Extend `server.js` so the configured numeric Telegram administrator can use `/approved` in the bot's private chat to view approved `(platform, accountId)` records, with pagination and a per-ID confirmation before revocation. Keep every message and callback behind the same exact-admin-ID/private-chat check. Do not put full account IDs in callback data; use short expiring random action tokens held server-side. Revoke in a transaction by deleting the selected `approved_accounts` row, invalidating every `user_sessions` row for that identity, and marking its current approval request `revoked`. Preserve `chat_messages`; do not affect any other identity or Firebase data. Provide a session-status endpoint and client guard so an already-open app clears its local session and returns to login after server-side revocation. This does not revoke the user’s separate lottery-platform account or token.

Managed MySQL is shared between development and production. Implement additive behavior only; do not execute real approval/revoke operations as a test. Validate the revoke query/transaction through a fake executor or isolated unit tests, then run existing syntax and HTTP checks. Keep production credentials protected and unchanged. A new checkpoint may auto-publish because the current project preference was previously `publishing.auto_publish: true`; check that state before the final push, do not duplicate a publish, and do not run a development Telegram poller concurrently with production.

## Existing app structure

- `server.js` — Node HTTP/API server, platform identity verification, Managed MySQL, Telegram polling/callbacks and session controls.
- `client-services.js` — Browser login/approval workflow, session guard, and CSRF-protected Live Chat client.
- `index.html`, `user.html` — Burmese user-app pages with the shared approval dialog and common visual language.
- `public/ultra-ui.css`, `public/ultra-mark.svg` — Shared UI system and supplied brand mark.
- `manus-routes.json` — Page routes `/` and `/user.html`; API routes remain excluded.
- `Dockerfile`, `package.json`, `package-lock.json` — Public production container and pinned runtime dependencies.
- `README.md`, `TELEGRAM_APPROVAL_SETUP.md`, `plan.md`, `TODO.md` — Setup, security and delivery documentation.

## Design

- **Design movement:** Cyber-lounge gaming HUD, extending the project's existing dark neon interface rather than replacing its character.
- **Core principles:** (1) A stable shared token and component vocabulary across both pages. (2) High-contrast, readable Burmese copy. (3) Compact, mobile-first controls with touch-friendly targets and clear state feedback. (4) Restrained effects so status and action remain legible.
- **Color philosophy:** Midnight navy surfaces provide a quiet game-console backdrop; the existing cyan is the ownable focus/action color; blue supports secondary action; green, red, and amber remain semantic and reserved for success, rejection/error, and caution/results.
- **Layout paradigm:** A compact sticky HUD and stacked, readable content on phones, expanding into a balanced, bounded dashboard at larger widths without changing the interaction order.
- **Signature elements:** Fine cyan edge highlights; softly layered navy/glass panels; compact pill-shaped connection/state indicators.
- **Interaction philosophy:** Keep actions recognizable, expose hover/focus/pressed and disabled states, maintain visible status feedback, and preserve all current handlers and workflows.
- **Animation:** Short ease-out transitions for drawers, dialogs and control states; no continuous decorative movement; honor `prefers-reduced-motion`.
- **Typography system:** A consistent system sans stack with Myanmar-aware fallbacks (`Noto Sans Myanmar`, `Myanmar Text`, then system sans); clear heading/body/label hierarchy and tabular numerals for timers and IDs where supported.
- **Brand essence:** A focused Burmese-first ULTRA BET user console, recognizable by its existing cyan-on-midnight interface; clear, compact, dependable.
- **Brand voice:** Preserve the app's existing Burmese language and product terminology. Example lines: “အကောင့်အတည်ပြုမှု အခြေအနေ” and “ချိတ်ဆက်မှုကို ပြန်စစ်ရန်”.
- **Wordmark & logo:** Reuse the existing ULTRA mark supplied in `public/ultra-mark.svg`; do not invent a replacement logo.
- **Signature brand color:** Existing ULTRA cyan `#00d4ff`.
