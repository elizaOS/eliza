# Issue #12274 - Browser pinned target availability failures

## Scope

This chunk fixes the browser-service slop called out in issue #12274: when a caller pins a browser target and that target's `available()` probe throws, the failure no longer collapses into an empty target list and a generic "not available" message. `BrowserService.resolveTargets()` now throws an `ElizaError` with:

- `code`: `BROWSER_TARGET_UNAVAILABLE`
- `context`: `{ "targetId": "<target>", "subaction": "<command subaction>" }`
- `severity`: `ephemeral`
- `cause`: the original availability/probe error

Automatic unpinned target resolution still ignores unhealthy targets so the existing fallback behavior remains intact.

## Verification

Run on July 4, 2026 from branch `codex/fix-12274-browser-target-availability`.

```bash
bun run --cwd plugins/plugin-browser test -- src/__tests__/browser-service.test.ts
```

Result: passed, 1 file / 7 tests.

```bash
bun run --cwd plugins/plugin-browser test
```

Result: passed, 27 files / 147 tests.

```bash
bunx @biomejs/biome check \
  plugins/plugin-browser/src/browser-service.ts \
  plugins/plugin-browser/src/__tests__/browser-service.test.ts
```

Result: passed, 2 files checked.

```bash
bun run --cwd plugins/plugin-browser typecheck
```

Result: passed.

```bash
bun run --cwd plugins/plugin-browser build
```

Result: passed.

```bash
bun run audit:error-policy-ratchet
```

Result: passed with no new fallback slop.

## Root Verify

`bun run verify` was last run on this develop line during the preceding #12272 chunk and failed in unrelated `@elizaos/cloud-ui#lint` import/export ordering and formatting findings under `packages/cloud-ui/src/approvals/*` and `packages/cloud-ui/src/index.ts`. Those files are outside this branch's touched files.

## Evidence Matrix

- Backend logs: N/A - this is an in-process service target-resolution failure covered by the direct `BrowserService.execute({ subaction: "state" }, "bridge")` regression test.
- Frontend screenshots/video: N/A - no UI surface changed.
- Browser recording: N/A - the fixed path rejects a failing pinned target availability probe before any browser command reaches a real workspace or companion.
- Real-LLM trajectories: N/A - no prompt/action/provider/model behavior changed.
- Domain artifact: the injected `bridge health probe failed` error is preserved as the `cause` of `BROWSER_TARGET_UNAVAILABLE` in `plugins/plugin-browser/src/__tests__/browser-service.test.ts`.
