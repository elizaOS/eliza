# Evidence — #9947 role-gated embedded-app launch (Discord/Telegram)

Branch: `fix/9946-9961-sec-roles-tui-cloud-embed` · Host: Linux x86_64

## What shipped (high-confidence, security-critical core)
- **Single embed-auth handshake** (`packages/app-core/src/embed/embed-auth.ts`) —
  the one fail-closed security seam, not duplicated per connector:
  - `verifyTelegramInitData`: Telegram Mini App `initData` HMAC verification
    (`secret_key = HMAC_SHA256("WebAppData", bot_token)`, sorted
    `data_check_string`, **timing-safe** hash compare, stale `auth_date`
    rejection), returns the verified Telegram user id.
  - `authorizeEmbedSession`: builds a synthetic `Memory`, calls **core
    `hasRoleAccess`** (OWNER/ADMIN), mints a scoped HS256 embed session token
    with an `adminMode` claim **only** on OWNER/ADMIN; **403 on anything else**,
    401 on missing secret.
  - `verifyEmbedLaunch`: per-platform orchestrator. Telegram fully wired; Discord
    activity OAuth2 via an injectable `exchangeCode` (live token-exchange
    documented/deferred — unit-tested with mocks).
- **Iframe `/embed` CSP** (`packages/app/functions/_middleware.ts`): per-platform
  `frame-ancestors` (telegram.org / discord.com families) for the `/embed` path
  only, drops `X-Frame-Options` there; all existing proxy behavior untouched;
  reuses the single web bundle (no fork).
- **Telegram Mini App launch button**: role-gated `web_app` `InlineKeyboardButton`
  `/app` command — returns `null` for non-OWNER/ADMIN (fail-closed), reuses the
  existing keyboard path + `resolveTelegramSenderAuth` gate.
- **Discord `/app` Activity launch**: role-gated slash command
  (`requiredRole: "ADMIN"`, ephemeral) registered via `registerSlashCommands`,
  enforced by the existing `hasRoleAccess` path.

## Tests — 42 passed across 4 files
- `embed-auth.test.ts` (21): valid initData + token mint; tampered hash → fail
  closed; stale `auth_date` → fail closed; verified-but-insufficient-role → 403;
  Discord mock happy/sad/throw paths; token mint/verify scope+expiry.
- `_middleware.test.ts` (6): `/embed` emits frame-ancestors CSP & drops
  X-Frame-Options; non-embed paths unchanged.
- `embed-launch.test.ts` (9, Telegram): button only for OWNER/ADMIN; HTTPS-only
  launch URL; null otherwise.
- `slash-commands-app.test.ts` (6, Discord): role gate + registration.
- Regression: `command-registration.test.ts` 11 passed.
- `tsc --noEmit` for app-core / plugin-telegram / plugin-discord: no errors in
  touched files.

## Deferred (documented)
- The `/embed` React view + `/api/embed/launch` route wiring (the SPA catch-all
  serves `/embed`; middleware adds the CSP). Adding the React view triggers the
  mandatory `audit:app` UI loop — out of this slice's high-confidence scope.
- Discord **live** OAuth2 token exchange (`POST /oauth2/token` + `/users/@me`) —
  structured behind an injectable seam; the in-iframe handshake re-verifies
  server-side.
