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
