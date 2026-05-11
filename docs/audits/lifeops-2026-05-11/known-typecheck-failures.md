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

### `packages/core/src/runtime/__tests__/action-retrieval.test.ts` — "regex scoring" test

```
error: Expected and actual values must be numbers or bigints
  expect(namespaceResponse.results[0].score).toBeGreaterThanOrEqual(0.8);
```

Root cause: `retrieveActions({ candidateActions: ["calendar_*"] })` returns
zero results, so `results[0]` is `undefined`. The wildcard-namespace path in
`packages/core/src/runtime/action-retrieval.ts` (and the regex-match stage)
either no longer fires for `<name>_*` patterns, or no longer carries a `score`
field through the merge step.

Fix scope: needs investigation of the regex-fusion path in
`action-retrieval.ts` (lines 360-420 / 553 / 627). Likely > 50 LoC. Wave 5 to
decide whether to repair the regex stage or relax the test contract.

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
