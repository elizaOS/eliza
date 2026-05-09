# E2E sweep results (Cerebras / gpt-oss-120b)

Date: 2026-05-08
Run from `/Users/shawwalters/eliza-workspace/milady/eliza` with full Cerebras env (`OPENAI_BASE_URL=https://api.cerebras.ai/v1`, `OPENAI_LARGE_MODEL=OPENAI_SMALL_MODEL=gpt-oss-120b`, `ELIZA_LIVE_TEST=1`). 90s per-suite cap, sequential.

| #  | Package                          | test:e2e command                                                  | Result                | Notes                                                     |
|----|----------------------------------|-------------------------------------------------------------------|-----------------------|-----------------------------------------------------------|
| 1  | packages/core                    | npx playwright test                                               | PASS 9/9 (9.1s)       | LLM agent loop runs against Cerebras; all green           |
| 2  | packages/app                     | node scripts/run-ui-playwright.mjs                                | FAIL                  | webServer crashes: cannot resolve `app-core/src/onboarding-config` |
| 3  | plugins/plugin-sql               | run-local-plugin-live-smoke.mjs                                   | TIMEOUT (>90s, >180s) | Hangs in vitest transform/import; never reaches first test|
| 4  | plugins/plugin-elizacloud        | run-local-plugin-live-smoke.mjs                                   | SKIP 4/4 (14.3s)      | All lifecycle suites skipped (no `elizacloud` boot env)   |
| 5  | plugins/plugin-n8n-workflow      | bun test __tests__/e2e/                                           | SKIP 3/3 (0.99s)      | Missing `N8N_HOST` / `N8N_API_KEY`                        |
| 6  | plugins/plugin-edge-tts          | run-local-plugin-live-smoke.mjs                                   | TIMEOUT (>90s)        | Same hang as plugin-sql; no test output before SIGTERM    |
| 7  | plugins/plugin-music-player      | run-local-plugin-live-smoke.mjs                                   | TIMEOUT (>90s)        | Same hang in transform/import phase                       |
| 8  | plugins/plugin-discord           | run-local-plugin-live-smoke.mjs                                   | SKIP 4/4 (24.8s)      | Missing `DISCORD_API_TOKEN`/`DISCORD_BOT_TOKEN`           |
| 9  | plugins/plugin-music-library     | run-local-plugin-live-smoke.mjs                                   | TIMEOUT (>90s)        | Same hang as plugin-sql                                   |
| 10 | plugins/plugin-telegram          | run-local-plugin-live-smoke.mjs                                   | SKIP 4/4 (29.8s)      | Missing `TELEGRAM_BOT_TOKEN`                              |
| 11 | plugins/plugin-shopify           | run-local-plugin-live-smoke.mjs                                   | SKIP 4/4 (32.2s)      | Missing Shopify boot env                                  |

Totals: 1 PASS, 1 FAIL, 5 SKIP-due-to-no-key, 4 TIMEOUT.

## Failures

### packages/app — webServer module-not-found

```
[WebServer] Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/Users/shawwalters/eliza-workspace/milady/eliza/packages/app-core/src/onboarding-config'
imported from .../packages/app-core/scripts/playwright-ui-live-stack.ts
[WebServer] code: 'ERR_MODULE_NOT_FOUND'
Error: Process from config.webServer was not able to start. Exit code: 1
```

Root cause: `packages/app-core/scripts/playwright-ui-live-stack.ts` imports `../src/onboarding-config` but that module no longer exists at that path (renamed/deleted). Fix the import (likely points to a new location or barrel) — purely an import-path bug, not a runtime issue.

## Timeouts

`plugin-sql`, `plugin-edge-tts`, `plugin-music-player`, `plugin-music-library` all share the same shape: the smoke runner spawns vitest against `eliza/packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts` with `ELIZA_PLUGIN_LIFECYCLE_FILTER=<id>` and never reaches the first `RUN`/`describe` line — only the SQLite experimental warning is printed before SIGTERM. These plugins have no required env keys, so unlike discord/telegram/shopify, they are not skipped — they actually attempt to boot a child runtime via `bun run start:eliza` with a 150s ready deadline. Confirmed at 180s the plugin-sql run still hangs in the same place. Likely root cause: child runtime boot (with full plugin chain) exceeds the 90s sweep cap and the test waits on `/api/health` readiness.

## Skipped suites (no key)

- plugin-elizacloud: skipped 4 lifecycle tests (no `elizacloud` boot env recognized by the smoke harness).
- plugin-n8n-workflow: 3 tests skipped — needs `N8N_HOST` and `N8N_API_KEY`.
- plugin-discord: 4 tests skipped — needs `DISCORD_API_TOKEN`/`DISCORD_BOT_TOKEN`.
- plugin-telegram: 4 tests skipped — needs `TELEGRAM_BOT_TOKEN`.
- plugin-shopify: 4 tests skipped — needs Shopify auth env.

## Trajectory cache analysis

No suite emitted a trajectories directory (the only PASS was packages/core, which uses an in-memory test runtime that does not persist trajectories), so `scripts/analyze-trajectories.mjs` was not run.
