# Issue #9946 XR parity count

## Scope

- Updated `plugins/plugin-xr/src/__tests__/xr-functional-parity.test.ts` so the summary assertion matches the current XR plugin registry size.
- The focused parity suite still checks the stronger contract: every listed XR view shares the GUI bundle/component, has functional source content, exports the declared component, and keeps TUI capabilities present in shared source.
- Removed fictional SSH naming from the agent terminal TUI conversation/test fixtures; terminal-originated conversations now use the `Terminal TUI` title and `terminal-tui` source metadata.
- Documented the actual TUI auth contract in `packages/agent/docs/terminal-tui.md`: local loopback sessions can use backend loopback trust, while proxied/tunneled sessions require `ELIZA_API_TOKEN` so the TUI sends `Authorization: Bearer <token>`.
- Added a real PTY regression test for the agent terminal TUI. The test spawns the actual Bun CLI through `@lydell/node-pty`, registers a child-process terminal view through a preload, drives view open, resize, focus toggle, and chat submit, and asserts the mock backend received the expected `/api/views/:id/navigate` and `/api/conversations/:id/messages` calls.
- Added `packages/tui` to the root `test:server` package filter so its test suite runs in the PR server lane.
- Added `packages/ui test:xr-sim` and wired the XR sim Playwright spec into the client workflow.
- Added a server workflow TUI step that runs the focused PTY suite and directly executes `tui-smoke --api` against a local mock API with a 30s timeout and readiness-marker assertion.

## Verification

- `agent-terminal-tui-vitest.log`
  - `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/__tests__/agent-terminal-tui.test.ts --coverage.enabled=false`
  - Result: 1 file passed, 6 tests passed.
- `tui-client-auth-vitest.log`
  - `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/__tests__/tui-client-auth.test.ts --coverage.enabled=false`
  - Result: 1 file passed, 2 tests passed.
- `packages-tui-test.log`
  - `bun run --cwd packages/tui test`
  - Result: 25 files passed, 468 tests passed, 11 skipped.
- `xr-sim-playwright.log`
  - `bun run --cwd packages/ui test:xr-sim`
  - Result: 5 Playwright tests passed.
- `tui-pty-backend.log`
  - Real PTY evidence driver backend requests:
    - `GET /api/views?viewType=tui`
    - `POST /api/views/wallet/navigate?viewType=tui`
    - `POST /api/conversations/conv-evidence/messages`
- `tui-pty-message.json`
  - Captured submitted message with `source: "terminal-tui"` and view metadata.
- `tui-pty-terminal.raw` / `tui-pty-terminal.txt`
  - Raw and ANSI-stripped terminal transcript from the real PTY run.
- `tui-pty-terminal.png`
  - Screenshot rendering of the captured terminal session.
- `tui-pty-terminal.mp4`
  - Short video artifact from the captured terminal session.
- XR screenshots copied from `/tmp/xr-shots`:
  - `xr-view-dashboard.png`
  - `xr-view-wallet.png`
  - `xr-controller-after-select.png`
  - `xr-chat-typed.png`
  - `xr-voice-active.png`
- Connected Android artifacts:
  - `adb-devices.log` shows physical device `53081JEBF11586` and emulator `emulator-5554`.
  - `android-device-53081JEBF11586.png`
  - `android-emulator-5554.png`
  - `android-device-model.log` reports `Pixel 9a`.
