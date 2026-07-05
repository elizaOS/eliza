# Issue #13696 - Packaged notification E2E slice

## Scope

- Added native shell notification diagnostics in `DesktopManager` beside the real `Utils.showNotification` call.
- Exposed loopback-only packaged test bridge support for hiding the main window without destroying it.
- Added a packaged Electrobun regression that drives the renderer RPC notification bridge while the main window is hidden, then again for a focused urgent notification, and asserts the native shell recorded the exact payloads.

## Verification

- PASS: `bun run --cwd packages/app-core/platforms/electrobun test src/native/desktop-window.test.ts`
  - Result: 1 file passed, 21 tests passed.
- PASS: `bunx @biomejs/biome check packages/app-core/platforms/electrobun/src/native/desktop.ts packages/app-core/platforms/electrobun/src/desktop-test-bridge-server.ts packages/app-core/platforms/electrobun/src/native/desktop-window.test.ts packages/app/test/electrobun-packaged/packaged-app-helpers.ts packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts`
  - Result: 5 files checked, no fixes applied.
- ENV-BLOCKED: `bun run --cwd packages/app test:desktop:packaged -- test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts -g "packaged desktop delivers renderer notifications"`
  - Result: test loaded and ran, then failed at the existing harness gate: `Packaged launcher is required for packaged desktop regressions.`
  - No packaged Electrobun launcher was present under `packages/app-core/platforms/electrobun/build`, `packages/app-core/platforms/electrobun/artifacts`, or `ELIZA_TEST_PACKAGED_LAUNCHER_PATH`.

## Typecheck Notes

- `bunx tsc --noEmit -p packages/app-core/platforms/electrobun/tsconfig.json --pretty false` was attempted and blocked by the sparse worktree dependency state. First failures include missing `electrobun/bun` and unrelated existing RPC handler/schema errors.
- `bun run --cwd packages/app typecheck` was attempted and blocked by the sparse worktree dependency state. First failures include missing Capacitor, cloud UI, route, chart, and other app dependencies outside this slice.

## Manual Review

- Reviewed the native diagnostic path: each renderer/native notification still calls `Utils.showNotification`; diagnostics only append a capped recent-history payload for the test bridge.
- Reviewed the packaged regression path: the hidden-window leg schedules `desktopShowNotification` from renderer JS, hides the main window via the bridge, then polls `/state` for the exact title/body/urgency/silent values. The focused leg restores/focuses the window and sends a critical notification through the same public renderer RPC bridge.
