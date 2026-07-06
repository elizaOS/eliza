# LifeOps live owner/agent validation matrix (#8833)

The static LifeOps split (personal-assistant + per-domain plugins) is done and
the 10 split views were audited `good` on desktop + mobile (see issue #8833
comments). What remains is **live, account-backed validation** across the OWNER
and AGENT sides, native devices, and OAuth/provider state — work that cannot be
proven in unit tests because it depends on real credentials and devices.

This document is the durable QA matrix for that pass: the prerequisites, the
exact states to exercise per connector, the expected behavior, and the
skip rules when credentials/devices are absent. Fill the **Result** columns in a
copy under `.github/issue-evidence/8833-lifeops-live-validation/` and attach the
redacted screenshots / logs called for in [`AGENTS.md`](../../../AGENTS.md).

## How to run a live session

```bash
# 1. Provide working credentials in .env (see "Env vars" per connector below).
# 2. Boot the local app (Eliza API on :31337, dashboard on :2138):
bun run dev
# 3. Open the dashboard and complete first-run onboarding as the OWNER:
open http://localhost:2138
# 4. Drive each view/action below as OWNER, then repeat as a non-owner AGENT
#    identity to confirm the permission matrix.
```

> **Agent responses require a working model provider.** If the model keys in
> `.env` are empty/expired (a `401` on first model call), the agent will not
> generate replies and connector actions that route through the planner cannot
> be exercised. Set a live `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (or a local
> inference endpoint) before a live session. This is the single most common
> blocker — confirm a model round-trips before validating connectors.

## OWNER vs AGENT permission matrix (run for every connector/action)

For each owner-only action surface, exercise and record evidence for:

| # | State | Expected |
|---|---|---|
| 1 | Unauthenticated connector | Clear "not connected" affordance; no silent failure |
| 2 | OWNER authenticated + authorized | Action succeeds; typed `DispatchResult` returned |
| 3 | AGENT authenticated, not owner-authorized | Denied with a clear permission error (`roleGate`) |
| 4 | Expired / revoked grant | Explicit, recoverable re-auth prompt |
| 5 | Missing required scope | Explicit scope error; no partial mutation |
| 6 | Multiple grants (owner-side must win) | Owner-side grant selected for owner-only ops |
| 7 | Planned-tool execution path | `roleGate` enforced |
| 8 | Direct handler invocation path | Handler-level owner check matches `roleGate` |
| 9 | UI-triggered path from the view | Same outcome as 7/8 |

Expected invariants (all paths): owner-only actions deny non-owner execution;
approval-required outbound actions route through `PgApprovalQueue` (never send
silently); connector calls return typed `DispatchResult` data (never a bare
boolean or a swallowed error).

## Connector families

Legend for **Result**: `pass` · `fail` · `blocked (no creds)` · `n/a`.

| Connector | Owner actions | Env vars / prerequisites | Result (OWNER) | Result (AGENT) |
|---|---|---|---|---|
| Google Calendar | `CALENDAR` (list/create/update/delete/availability, conflict detect) | OWNER + AGENT Google accounts w/ Calendar scope; OAuth grant | | |
| Gmail / Inbox | `INBOX` (read/search/label/archive; outbound draft→approval) | Gmail scope on same accounts; billing corpus for finances | | |
| Telegram | status/read/send-or-draft | OWNER + AGENT bot/user identities | | |
| Discord | status/read/send-or-draft | OWNER + AGENT identities | | |
| Signal | status/read/send | linked device | | |
| WhatsApp | status/read/send | `ELIZA_WHATSAPP_ACCESS_TOKEN`, `ELIZA_WHATSAPP_PHONE_NUMBER_ID` | | |
| iMessage | status/read/send | macOS + `ELIZA_IMESSAGE_BACKEND` | | |
| X | status/read/post | OWNER + AGENT identities | | |
| Slack | status/read/send | workspace tokens (if deployed) | | |
| Phone / SMS / Voice | `VOICE_CALL` (outbound call/SMS, approval) | Twilio test number + recipient allowlist | | |
| Health | `OWNER_HEALTH` (sync, permission, error paths) | Apple Health/HealthKit, Google Fit/Health Connect, Fitbit/Oura/Strava/Withings | | |
| Screen-time / Focus | `OWNER_SCREENTIME`, `BLOCK` (macOS-only) | macOS hosts/SelfControl admin; iOS Family Controls; Android Usage Access | | |
| Finances | `OWNER_FINANCES` (subscription detect, import, approval) | Gmail billing corpus / CSV fixture / Plaid or PayPal sandbox | | |
| Documents | `OWNER_DOCUMENTS` (search/review/signature) | document store + signature provider | | |
| Remote desktop | `REMOTE_DESKTOP` | `ELIZA_REMOTE_ACCESS_TOKEN` / `ELIZA_REMOTE_LOCAL_MODE` | | |

## Split views (each on desktop + mobile)

View-rendering + aesthetics already audited `good` (issue #8833 comment). For
the **live-data** pass, record empty / loading / error / populated states, plus
refresh/retry and "agent-created data shows up in the view":

`/calendar` · `/scheduling` (reminders) · `/goals` · `/inbox` · `/health` ·
`/focus` (blocker) · `/finances` · `/documents` · `/relationships` ·
`/phone` (+ `/phone/tui`). Confirm any remaining `#lifeops` deep links/aliases
in `packages/app` still resolve.

## Skip behavior for absent credentials

Live tests must skip (not fail) when their credentials/devices are absent, so a
minimal checkout stays green:

- Connector live tests are gated behind their env var(s) — e.g. an `it.skipIf`
  on the access token / sandbox key; skipped runs log the missing prerequisite.
- The LifeOps prompt benchmark only runs the live leg under
  `RUN_LIFEOPS_PROMPT_BENCHMARK=1` (see
  `test/lifeops-prompt-benchmark.activation.test.ts`); its pure scoring/report
  coverage always runs.
- Native-device flows (HealthKit, Family Controls, SMS default-role) require a
  real device/simulator and are out of scope for headless CI.

## Acceptance (per #8833)

- [ ] Every connector family has OWNER and AGENT evidence (or `blocked` w/ reason).
- [ ] Every owner-only action denies non-owner via planned-tool, direct-handler, and UI paths.
- [ ] Every split view checked desktop + mobile across empty/loading/error/populated.
- [ ] OAuth / native-permission failures are explicit and recoverable.
- [ ] Live connector failures return typed results (no silent success).
- [ ] Approval-gated outbound flows validated end to end.
- [ ] This matrix records exactly which accounts, devices, scopes, env vars, and sandboxes were used.
- [ ] Any discovered bug has a linked issue/PR before the issue is closed.
