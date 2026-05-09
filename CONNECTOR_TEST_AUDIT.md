# Connector / live-test audit (post-conversion)

Total live-named files: 156

Categorization key:
- **GOOD-DESCRIBELIVE** — uses `describeLive` from `packages/app-core/test/helpers/live-agent-test.ts`. Yellow `console.warn`, visible skipped test, sets `process.env.SKIP_REASON` so `fail-on-silent-skip` is satisfied.
- **GOOD-DESCRIBE-IF** — uses `describeIf` / `itIf` from `test/helpers/conditional-tests.ts` (or local `describe.skip`-on-flag pattern). Produces a visible skipped test, **but does not set `SKIP_REASON`** — relies on caller setting it externally for CI. Loud-skip-with-reason-required.
- **NO-LIVE-GATE** — no LLM/network gating; runs always (PGlite, in-process HTTP server, pure logic). Misleading `.real`/`.live` filename but not a silent-skip risk.
- **SILENT-SKIP** — inline `if (!key) return;` inside a test body or a no-op gate that lets the test pass without making the skip visible.
- **STILL-MOCKED** — `vi.mock` / `vi.doMock` / `jest.mock` of a network/LLM boundary inside a "live" file.

Counts:
- GOOD-DESCRIBELIVE: 6
- GOOD-DESCRIBE-IF: ~50 (uses `describeIf` / `itIf` / local `describe.skip` boolean)
- NO-LIVE-GATE: ~95 (largely `plugin-sql` PGlite suites and lifeops PGlite/pure-logic suites — fine)
- SILENT-SKIP: 4 (need fixing — listed below)
- STILL-MOCKED: 0 (no `vi.mock` of network/LLM boundary in any live-named file — clean)

## Files needing fixes

| # | File | Issue | Suggested gate |
|---|------|-------|----------------|
| 1 | `plugins/plugin-wallet/src/chains/evm/__tests__/integration/transfer.live.test.ts` | Test body at L108: `if (!useElizaCloudRpc) { expect(useElizaCloudRpc).toBe(false); return; }` — when ELIZA_CLOUD_API_KEY missing the test asserts `false===false` and returns. Passes silently with no real RPC call. | Hoist the cloud-RPC requirement into `describeLive` (or `describeIf(hasKey)`) so the test is registered as skipped (visible) instead of pretending to pass. |
| 2 | `plugins/plugin-app-control/src/services/__tests__/app-verification.integration.test.ts` | L125, L144: `if (!bunAvailable && !npmAvailable) return;` inside test bodies. Test passes silently when neither package manager is on PATH. | Use `itIf(bunAvailable \|\| npmAvailable, ...)` so the skip is visible and counted by `fail-on-silent-skip`. |
| 3 | `plugins/plugin-video/src/services/binaries.integration.test.ts` | L37: `if (!ffmpegPath) return;` after an `expect(Boolean(ffmpegPath)).toBe(true)` that already failed — but there is also a pre-`describe.skip` gate at L21 (`describeIntegration`). Lower severity, but the inline `return` is dead and confusing. | Drop the `if (!ffmpegPath) return;` — the prior `expect` already covers it. |
| 4 | `plugins/plugin-openai/__tests__/openai.live.test.ts` | Uses `describeIf` only (1 occurrence). Not silent per se, but the file is the canonical live-LLM smoke test and should use `describeLive` for the yellow warning + auto `SKIP_REASON` so CI doesn't need an external env. | Migrate to `describeLive({ requiredEnv: ["OPENAI_API_KEY"] })`. |

## High-priority fix order

The 3 most important (real silent-skip risks where a test body can pass without the real call happening):

1. **`plugin-wallet/.../transfer.live.test.ts`** — most dangerous. Asserts `false===false` and returns when the cloud RPC isn't configured, masking a totally untested live-transfer path.
2. **`plugin-app-control/.../app-verification.integration.test.ts`** — two test bodies silently pass when bun/npm absent, defeating CI coverage of the verification service on minimal images.
3. **`plugin-openai/.../openai.live.test.ts`** — the canonical OpenAI live-smoke; should switch to `describeLive` so devs and CI get the yellow "skipped — set OPENAI_API_KEY" line instead of a quiet `it.skip`.

## Already-good live tests (reference list — uses `describeLive`)

- `packages/app-core/test/app/onboarding-companion.live.e2e.test.ts`
- `packages/app-core/test/app/memory-relationships.real.e2e.test.ts`
- `plugins/app-lifeops/test/apple-reminders.live.test.ts` (locally-named `describeLive`, but is `describeIf` — visible skip; fine)
- `plugins/plugin-openai/__tests__/cerebras-config.live.test.ts`
- `plugins/plugin-openai/__tests__/native-plumbing.live.test.ts`
- `plugins/plugin-openai/__tests__/trajectory.live.test.ts`
- `plugins/plugin-agent-orchestrator/__tests__/live/sub-agent-router.live.test.ts`
- `plugins/plugin-xai/__tests__/plugin.live.test.ts`
- `packages/core/src/__tests__/read-attachment-action.live.test.ts`

## Notes

- The `cloud/packages/tests/integration/*.integration.test.ts` files **throw** when `DATABASE_URL` is missing — that's loud failure, not silent skip. Fine.
- `plugin-elizacloud/__tests__/*.real.test.ts` and `cloud-services.real.test.ts` use an in-process `http.createServer` mock — no real network. Misleading filename (`.real`) but no silent-skip risk; they always run.
- `plugin-sql/typescript/__tests__/integration/**` uses real PGlite — always runs, no key gating needed. Not connector tests.
- Most `app-lifeops/test/*.real.test.ts` and `*.integration.test.ts` are PGlite/pure-logic; they always run. The ones that DO need an LLM (`lifeops-llm-extraction.live.test.ts`, `lifeops-life-chat.real.test.ts`, `lifeops-chat.live.e2e.test.ts`, etc.) all use `describe.skip` on a boolean (`provider ? describe : describe.skip`) — visible skip, but not yellow. Could be migrated to `describeLive` for parity, but not silent.
