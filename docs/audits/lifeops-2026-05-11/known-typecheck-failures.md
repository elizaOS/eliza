# Known typecheck failures (Wave 4-B, 2026-05-11)

Status of each pre-existing typecheck failure noted during the
Wave 4-B unused/legacy/fallback removal pass.

## Fixed in Wave 4-B

| File | Issue | Fix |
| ---- | ----- | --- |
| `plugins/app-training/src/routes/trajectory-routes.test.ts:42` | `as AgentRuntime` direct cast tripped TS2352 | Cast through `unknown`. |
| `plugins/app-training/tsconfig.json` | Missing `bun` type pulled in agent's `_bridge.ts` errors transitively. Affected TS2868 / TS2339 / TS2307 in `packages/agent/src/services/permissions/probers/_bridge.ts` (lines 91, 137, 189, 303, 306, 374). | Added `"types": ["node", "bun"]`. |
| `packages/core/src/services/message.ts:8385-8386` (`ReplyGateDecision.gateMode`/`scope`) | Reported by Wave 0 as a failure; in current `develop` it compiles. | No fix needed — likely resolved by an earlier wave. |

## Still failing (out of Wave 4-B scope, > 50 LoC or > 30 min)

### `packages/core/src/runtime/__tests__/action-retrieval.test.ts` — "regex scoring" test — **fixed in Wave 5-B**

Original symptom:
```
error: Expected and actual values must be numbers or bigints
  expect(namespaceResponse.results[0].score).toBeGreaterThanOrEqual(0.8);
```

Wave-4-B hypothesis (zero results, `undefined` score) turned out to be wrong.
Actual root cause: bun's `expect(obj).toMatchObject({ field: expect.any(Number) })`
followed by `expect(obj.field).toBeGreaterThanOrEqual(N)` triggers a matcher-state
bug in bun-test where the second assertion reports "Expected and actual values
must be numbers or bigints" even though both operands are real numbers. Verified
by reducing to a 5-line repro.

Fix (Wave 5-B): split the assertions — use `expect(x.name).toBe(...)` +
`expect(x.matchedBy).toEqual(expect.arrayContaining(...))` + a direct
`expect(typeof x.score).toBe("number")` before the numeric comparison. The
regex-fusion path itself is correct (score = 0.8 exactly).

### `packages/app-core/src/browser.ts` — ambiguous `ConfigField` / `getPlugins` re-export

Reported by Wave 0. Not reproduced by `bunx tsc --noEmit` in
`packages/app-core/` on current `develop` (typecheck exits clean). If a
later wave sees it return, the fix is to disambiguate the named re-exports
in `browser.ts` (probably `export { ConfigField } from "./config";` style
instead of `export *`).

### `plugin-imessage` "not built"

The Wave 0 note was triggered by a clean checkout. `plugins/plugin-imessage/dist/`
is present on current `develop`. No action needed unless `bun run build` is
forced to re-run after a `rm -rf dist`.

## Wave 6-G6 catch-all sweep (2026-05-11)

### Fixed

| Area | Issue | Fix |
| ---- | ----- | --- |
| `packages/benchmarks/hermes-adapter/tests/test_lifeops_bench_factory.py` | F4 pre-existing failure: minimal `eliza_lifeops_bench.types` stub only exported `MessageTurn`, not `attach_usage_cache_fields`. Lazy import in `hermes_adapter.lifeops_bench` failed. | Stub now also exports `attach_usage_cache_fields` (mirror of the real helper). 2 tests recovered. |
| `packages/benchmarks/openclaw-adapter/openclaw_adapter/client.py` + `tests/test_retry.py` | 6 tests in `test_retry.py` referenced `OpenClawClient(base_url=...)` and a deleted `_send_openai_compatible` HTTP path. The HTTP loop helper `_post_with_retry` was orphaned (imports from `_retry` referenced but caller deleted; function would have crashed if called — referenced undefined `urllib`/`Any`). | Deleted the dead `_post_with_retry` helper + unused `_retry` imports in `client.py`; trimmed `test_retry.py` to the still-live `parse_retry_after` / `backoff_seconds` / `is_retryable_status` helper unit tests. |
| `packages/benchmarks/eliza-adapter/tests/test_bfcl_adapter.py` | `ModuleNotFoundError: No module named 'benchmarks'`. `eliza_adapter.bfcl` lazily imports `benchmarks.bfcl.types`, which lives under the workspace-level `packages/` namespace — that ancestor wasn't on `sys.path` when pytest ran from the adapter dir. | Added `packages/benchmarks/eliza-adapter/conftest.py` to insert `packages/` on `sys.path`. 2 tests recovered. |
| `packages/shared/src/themes/{index.ts,presets.ts}` | Botched MILADY → ELIZA rename produced two `ELIZA_DEFAULT_THEME` declarations (one circular: `ELIZA_DEFAULT_THEME = ELIZA_DEFAULT_THEME`) and a duplicate re-export. TS2300 / TS2451 / TS2448. | Dropped the redundant alias line; collapsed the duplicate re-export. |
| `packages/core/src/features/advanced-capabilities/providers/facts.test.ts` | `vi.setSystemTime` undefined under bun's vitest compat. | Mocked `Date.now()` via `vi.spyOn(Date, "now").mockReturnValue(...)` and switched cleanup to `vi.restoreAllMocks`. |
| `packages/core/src/runtime/__tests__/turn-controller.test.ts` — "two rooms run concurrently…" | Bun's `AbortController.abort(reason)` surfaces listener-thrown rejections back through the abort() call site, failing the test before the awaiting `expect(...).rejects` could observe it. | Rewrote room-B's executor to poll `signal.aborted` and throw outside the listener; attached a no-op `.catch` to prevent unhandled-rejection flagging. |
| `plugins/app-training/src/core/prompt-compare.test.ts` — "requires runtime or adapter…" | `TRAIN_MODEL_PROVIDER=cerebras` in repo `.env` short-circuited `resolveAdapter()` before the "neither provided" throw could fire. Also: `expect(() => promise()).rejects.toThrow` was the wrong syntax — `rejects` expects a Promise, not a function. | Delete the env vars for the duration of the test (restore in `finally`); pass the Promise directly to `expect(...).rejects.toThrow`. |
| `plugins/app-training/test/training-api.live.e2e.test.ts` | Imports `@elizaos/app-training` and `live-runtime-server` at module top, which transitively loaded `packages/agent/src/api/server.ts` → `@elizaos/plugin-imessage` (no `dist/` built). File failed to import even when `ELIZA_LIVE_TEST` gate was off. | Deferred both imports into the `beforeAll` block so the LIVE gate actually skips clean. |
| `plugins/plugin-imessage/dist`, `plugins/plugin-x402/dist` | Missing build artifacts in plugin-imessage and plugin-x402 caused agent server.ts import chain to fail in multiple test files. | Ran `bun run build` for both. (Build-state restoration, not a code change.) |

### Still failing — pre-existing, classified

| File | Issue | Status |
| ---- | ----- | --- |
| `packages/core/src/__tests__/tiered-action-surface.test.ts` — "repairs direct night check-ins away from the simple reply shortcut" | Test expects `parentActionHints: ["CHECKIN"]` for a runtime that registers an action named `CHECKIN`. `getStage1CheckinRepairPlan` in `message.ts:2305` returns a hard-coded `["SCHEDULED_TASKS"]` regardless of which actions are registered. Test was added in `5704c75647 fix issues` (2026-05-09) and likely never reflected the real runtime behavior. | Pre-existing. Real fix requires teaching the repair to resolve to an action name actually in the surface (action-aware parent lookup, ~50–100 LoC across `message.ts` and the parent-alias map). Out of catch-all scope — leaving the test red so the design gap stays visible. |
| `plugins/app-lifeops/src/...` (40+ TS2307 / TS2554 / TS2305 errors) | Build-state errors from missing local `node_modules/@elizaos/plugin-*` symlinks (plugin-health, plugin-browser, plugin-google, plugin-calendly, native-activity-tracker) and missing `contracts/index.js` exports (BrowserBridge* re-exports). | Pre-existing. Module resolution / missing dist artifacts in parallel-rebuild scope. Out of catch-all scope. |
| `packages/agent/src/...` + `packages/app-core/src/api/...` + `packages/ui/src/...` (~30 TS2307 errors) | Missing `@elizaos/plugin-elizacloud`, `@elizaos/plugin-browser`, `@elizaos/plugin-coding-tools`, `@elizaos/plugin-capacitor-bridge`, `@elizaos/capacitor-bun-runtime` modules. Same root cause: unbuilt plugin `dist/` directories across the workspace. | Pre-existing. Fixable by running `bun run build` repo-wide; out of catch-all scope and the user's "don't run heavy builds" guidance. |
| `packages/app-core/tsconfig.json` types config | `tsc -p packages/app-core` rejects with "Cannot find type definition file for 'bun-types'/'node'" — the package's own `node_modules` has `bun-types` but no `@types/node`. | Pre-existing dependency wiring. Not a code regression. |
