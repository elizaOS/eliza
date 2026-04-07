# Changelog

All notable changes to **apps/elizaokbsc** are documented here. This file focuses on operator-visible behavior and integration contracts; monorepo-wide releases may also appear in other packages’ changelogs.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **ElizaCloud API client module** (`src/memecoin/elizacloud-api.ts`) — centralizes v1 `fetch` helpers so auth and parsing stay consistent and testable.
  - **Why:** Previously, all logic lived inside `server.ts`; duplicating header rules was error-prone and hard to unit test. A small module keeps the HTTP server readable and documents Cloud behavior in one place.

- **Dual-header auth for opaque API keys** — `Authorization: Bearer` plus `X-API-Key` when the credential is **not** JWT-shaped.
  - **Why:** ElizaCloud evaluates `X-API-Key` before `Authorization`. Sending only Bearer works for many keys, but mirroring Cloud’s SDK and avoiding JWT-in-`X-API-Key` mistakes keeps behavior aligned with production auth.

- **Hardened credit parsers** — `parseCreditsBalancePayload` / `parseCreditsSummaryPayload` accept defensive shapes (e.g. nested `data.balance`, `organization.credit_balance` fallback) and reject `NaN`.
  - **Why:** Minor API or proxy drift should not blank the dashboard credits line; rejecting invalid numbers avoids showing garbage.

- **Single 429 retry** for `GET /api/v1/credits/balance` and `GET /api/v1/credits/summary` with capped backoff (`Retry-After` or 500ms default).
  - **Why:** Summary is rate-limited on Cloud; parallel refresh calls occasionally hit 429. One retry reduces “credits syncing” flakiness without a heavy retry loop.

- **Unit tests** — `src/memecoin/elizacloud-api.test.ts` (Bun); `package.json` script `bun test` for that file.
  - **Why:** Regressions in JWT detection or parsers would break production sign-in; fast tests catch them without starting the full dashboard.

### Changed

- **`GET /api/v1/user` compatibility** — ElizaOK continues to call user with the same Bearer/API key headers as credits; relies on ElizaCloud exposing `requireAuthOrApiKey` on that route (not cookie-only).
  - **Why:** Server-side `fetch` has no ElizaCloud `privy-token` cookie; cookie-only user routes would always 401 from ElizaOK and strip profile data.

- **`buildElizaCloudApiSession` apiKey hint** — Empty or very short `apiKey` uses `"Browser session"` instead of a truncated `...` hint.
  - **Why:** App-auth flows store an empty key before overwriting the hint; the old slice produced a useless label.

### Documentation

- **`docs/elizacloud-integration.md`** — rationale for two base URLs, header order, merge order, 429 behavior, and refresh limitations.
- **`.env.example`** — comments for `ELIZAOK_ELIZA_CLOUD_URL` vs `ELIZAOK_ELIZA_CLOUD_API_URL` and credits 403 vs user 200.
- **`README.md`** — ElizaCloud section and links to docs/changelog/roadmap.

---

## Earlier history

Prior changes to ElizaOK (discovery, execution, distribution, Goo, Privy, etc.) were not tracked in this file before it was added. Use `git log -- apps/elizaokbsc` for full history.
