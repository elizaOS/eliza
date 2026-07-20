# Desktop App Live native notification receipt, 2026-07-18

Issue: #16645, focused child of #16212  
Lane: native notification observation  
Owner: `[sol-orch]`

## Failure reproduced

App Live run [29636010630](https://github.com/elizaOS/eliza/actions/runs/29636010630), head `510fe68f4b58d528606fc5abdec46906e76b3be3`, failed after the real packaged Electrobun window had already closed/backgrounded successfully:

```text
Expected packaged native notification "Packaged notification background-normal" to be recorded.
Timeout 30000ms exceeded while waiting on the predicate
```

The former `/main-window/show` timeout did not recur and was not used as the diagnosis.

## Root cause and fix

1. Notification WebSocket ingress was booted only by `NotificationsShellBoot`, below App's startup/auth early-return gates. The packaged renderer could have a live WebSocket and a backgrounded native window while the notification store remained `hydrationStatus: "idle"` with no `agent_event` subscription. `NotificationsDataBoot` now mounts outside those gates, while shell-only push registration and navigation wiring remain in `NotificationsShellBoot`.
2. The authenticated test bridge had two GET/DELETE `/notifications` route pairs. The first shadowed the canonical `DesktopManager` diagnostics with a monkey-patched `Utils` recorder. The duplicate recorder and route pair were removed. Observation now reads `DesktopManager.getNotificationDiagnostics()`, whose record is appended immediately after the real `Utils.showNotification(payload)` call.
3. The test continues to launch and drive the packaged Electrobun app. It does not substitute a browser fixture. Native `DesktopManager` visibility/focus is the readiness contract; Chromium `document.hasFocus()` is not used as a native readiness signal under headless Xvfb.

## Evidence rows

| Evidence | Command or source | Result |
| --- | --- | --- |
| Baseline App Live | Run 29636010630 | Failed: `background-normal` native record absent after 30s |
| Packaged build | `node packages/app-core/scripts/desktop-build.mjs build` | PASS, real Electrobun Linux package created |
| Exact packaged notification test | `xvfb-run -a bunx playwright test --config playwright.electrobun.packaged.config.ts test/electrobun-packaged/desktop-notification.e2e.spec.ts --workers=1` | PASS, 1 test in 9.2s; background-normal and focused-urgent native records observed |
| Native bridge unit tests | app-core route contract plus Electrobun `src/native/desktop-window.test.ts` | PASS, 22 tests |
| Notification/UI unit tests | `vitest run ... notification-store.test.ts native-notifications.test.ts App.chat-overlay-first-run.test.tsx` | PASS, 53 tests |
| Formatting/static quality | `bunx @biomejs/biome check` on all touched source and test files; `git diff --check` | PASS |
| Packaged launcher digest | `packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev/bin/launcher` | SHA-256 `9cce6bcdc1bc550b6533454a8470870cc321773890c0d1bd03d10d5f441bd9cd` |

No baseline was bumped. No behavioral test was deleted. No check was suppressed.

[sol-orch]
