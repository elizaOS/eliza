# Launch Readiness 09: Desktop QA

## Second-Pass Status (2026-05-05)

- Current: the core desktop runtime-mode risks remain accurate, including disabled/manual-mode UX coverage and local/runtime persistence divergence.
- Still open: packaged Electrobun Playwright regressions are not exposed by a package script, release CI references missing heavy/desktop scripts, and `test-electrobun-release.yml` still contains intentional no-op porting checks.
- Launch gate: desktop work is not fully automated; add real packaged Playwright scripts and wire release CI before treating desktop launch validation as complete.

## Current state

The desktop app is an Electrobun shell around the app-core renderer. The shell owns the main window, tray/menu behavior, detached surfaces, native OS permission bridges, auth/session bridges, and an optional embedded app-core runtime child process.

Runtime support is present for local embedded runtime, external API mode, and disabled/manual mode. The onboarding/runtime picker exposes cloud, local, and remote choices on desktop/dev builds, with cloud provisioning, local runtime startup, and remote/manual API connection flows. Restore logic can reconnect to persisted cloud, remote, or local targets, and can probe loopback when no active server is saved.

Local model support is substantial in code: there is a GGUF catalog, download/install state, active model management, provider routing, a node-llama-cpp engine path, device bridge support, and REST/SSE compatibility routes. I did not validate actual model download or inference in this pass.

Packaging/runtime configuration is present for macOS, Windows, and Linux. The config copies renderer and runtime assets into the packaged app, wires WebGPU/CEF settings, and includes macOS signing/notarization/entitlements configuration. Release docs exist, but the desktop release checklist remains sparse and still relies on human OS/hardware coverage.

## Evidence reviewed with file refs

- Root and package scripts: `package.json:20-24`, `packages/app/package.json:5-27`, `packages/app/package.json:54-73`, `packages/app-core/platforms/electrobun/package.json:5-14`.
- Electrobun packaging/runtime config: `packages/app-core/platforms/electrobun/electrobun.config.ts:8-80`, `packages/app-core/platforms/electrobun/electrobun.config.ts:107-253`.
- Desktop runtime mode/API selection: `packages/app-core/platforms/electrobun/src/api-base.ts:4-17`, `packages/app-core/platforms/electrobun/src/api-base.ts:72-140`, `packages/app-core/platforms/electrobun/src/api-base.ts:143-166`.
- Desktop shell startup and runtime orchestration: `packages/app-core/platforms/electrobun/src/index.ts:1012-1125`, `packages/app-core/platforms/electrobun/src/index.ts:1441-1660`, `packages/app-core/platforms/electrobun/src/index.ts:2077-2387`.
- Embedded runtime manager: `packages/app-core/platforms/electrobun/src/native/agent.ts:1-25`, `packages/app-core/platforms/electrobun/src/native/agent.ts:545-763`, `packages/app-core/platforms/electrobun/src/native/agent.ts:1068-1464`, `packages/app-core/platforms/electrobun/src/native/agent.ts:1533-1567`.
- Main window session/runtime test hooks: `packages/app-core/platforms/electrobun/src/main-window-session.ts:1-74`.
- Runtime picker and startup restore: `packages/app-core/src/components/shell/RuntimeGate.tsx:120-133`, `packages/app-core/src/components/shell/RuntimeGate.tsx:396-472`, `packages/app-core/src/components/shell/RuntimeGate.tsx:560-680`, `packages/app-core/src/components/shell/RuntimeGate.tsx:824-830`, `packages/app-core/src/components/shell/RuntimeGate.tsx:991-1089`, `packages/app-core/src/state/startup-phase-restore.ts:50-75`, `packages/app-core/src/state/startup-phase-restore.ts:113-205`, `packages/app-core/src/state/persistence.ts:794-920`.
- Full onboarding callbacks: `packages/app-core/src/state/useOnboardingCallbacks.ts:430-704`.
- Local inference/model stack: `packages/app-core/src/services/local-inference/catalog.ts:1-163`, `packages/app-core/src/services/local-inference/service.ts:44-195`, `packages/app-core/src/services/local-inference/engine.ts:1-17`, `packages/app-core/src/services/local-inference/engine.ts:80-214`, `packages/app-core/src/services/local-inference/active-model.ts:1-144`, `packages/app-core/src/services/local-inference/providers.ts:82-139`, `packages/app-core/src/services/local-inference/providers.ts:218-240`, `packages/app-core/src/services/local-inference/router-handler.ts:1-198`, `packages/app-core/src/runtime/ensure-local-inference-handler.ts:1-20`, `packages/app-core/src/runtime/ensure-local-inference-handler.ts:70-187`, `packages/app-core/src/runtime/ensure-local-inference-handler.ts:318-471`, `packages/app-core/src/api/local-inference-compat-routes.ts:1-12`, `packages/app-core/src/api/local-inference-compat-routes.ts:107-605`.
- Desktop permissions: `packages/app-core/platforms/electrobun/src/native/permissions-shared.ts:22-82`, `packages/app-core/platforms/electrobun/src/native/permissions.ts:20-177`, `packages/app-core/platforms/electrobun/src/native/permissions-darwin.ts:35-342`, `packages/app-core/platforms/electrobun/src/native/permissions-win32.ts:6-55`, `packages/app-core/platforms/electrobun/src/native/permissions-linux.ts:6-34`, `packages/app-core/src/platform/desktop-permissions-client.ts:15-162`, `packages/app-core/platforms/electrobun/src/runtime-permissions.ts:8-117`.
- Desktop docs and release checklist: `docs/apps/desktop.md:7-8`, `docs/apps/desktop.md:43-45`, `docs/apps/desktop.md:89-133`, `docs/apps/desktop.md:159-202`, `docs/apps/desktop/release-regression-checklist.md:1-12`.
- Packaged desktop regression tests: `packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts:762-858`, `packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts:875-1088`.

## What I could validate

- Static review confirmed desktop packaging, runtime startup, shell, permission, cloud/local/remote picker, and local inference code paths exist and are wired together.
- Targeted Electrobun tests passed:
  - Command: `bunx vitest run --config vitest.electrobun.config.ts src/electrobun-config-root.test.ts src/main-window-session.test.ts src/native/agent.test.ts src/native/auth-bridge.test.ts src/application-menu.test.ts src/surface-windows.test.ts`
  - Result: 6 test files passed, 30 tests passed.
- Targeted app-core runtime/local inference tests passed:
  - Command: `bunx vitest run --config vitest.config.ts src/runtime/ensure-local-inference-handler.test.ts src/services/local-inference/router-handler.test.ts src/services/local-inference/providers.test.ts src/services/local-inference/device-bridge.test.ts src/api/local-inference-compat-routes.test.ts src/components/shell/RuntimeGate.test.tsx`
  - Result: 6 test files passed, 54 tests passed. Only observed warning was Node's experimental SQLite warning.
- Electrobun typecheck passed:
  - Command: `bun run typecheck`
  - Result: `tsc --noEmit` completed successfully.

## What I could not validate

- I did not build, sign, notarize, or install packaged macOS/Windows/Linux artifacts.
- I did not launch a packaged GUI app or run the packaged Playwright regression suite because it requires a packaged launcher and heavier OS/UI coverage.
- I did not exercise real macOS TCC prompts, Windows privacy settings, Linux desktop permission behavior, tray/menu behavior, detached windows, deep links, or window persistence in a live desktop session.
- I did not test real Eliza Cloud auth/provisioning, OAuth/deep-link return, or multiple-cloud-agent selection.
- I did not download, verify, activate, or run generation through a real GGUF model or `node-llama-cpp` binding.
- I did not verify current availability of catalog model URLs or Hugging Face assets.
- I did not run upgrade, crash recovery, missing runtime bundle, or first-launch cold boot scenarios end to end.

## Bugs/risks P0-P3

### P0

- None found in this bounded review.

### P1

- Desktop local selection in `RuntimeGate` clears `elizaos:active-server` instead of persisting a local active server (`packages/app-core/src/components/shell/RuntimeGate.tsx:439-472`). The full onboarding callback path does persist local (`packages/app-core/src/state/useOnboardingCallbacks.ts:625-665`). Relaunch restore can still probe loopback, but this split increases risk of onboarding/session drift if the embedded runtime is slow or unavailable during restore.
- Windows embedded runtime disables local embeddings in the child environment (`packages/app-core/platforms/electrobun/src/native/agent.ts:1249-1253`). That may be correct for crash avoidance, but it means "all-local" needs explicit Windows QA and product copy must avoid overpromising local embeddings on Windows.

### P2

- Disabled/manual mode is implemented in runtime selection but appears under-covered by UX and tests. `resolveInitialApiBase` falls back to loopback for disabled mode (`packages/app-core/platforms/electrobun/src/api-base.ts:87-97`), while startup intentionally skips the embedded runtime unless mode is local (`packages/app-core/platforms/electrobun/src/index.ts:1618-1623`, `packages/app-core/platforms/electrobun/src/index.ts:2373-2386`). Manual QA should verify the error, recovery, and connect-server path when no server is running.
- Desktop permissions are platform-best-effort. macOS has the richest implementation, Windows returns mostly `not-determined` or `not-applicable`, and Linux returns several permissions as granted without real privacy prompts (`packages/app-core/platforms/electrobun/src/native/permissions-win32.ts:6-55`, `packages/app-core/platforms/electrobun/src/native/permissions-linux.ts:6-34`). Release QA needs platform-specific expectation checks.
- Packaged regression tests include a fallback when localStorage did not persist across relaunch (`packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts:814-858`). The fallback is useful, but the underlying persistence behavior should be watched in real packaged builds.
- Local inference is well covered structurally, but real model download/load/generate remains unvalidated here. GPU, memory pressure, native binding load, and large-file storage permissions remain release risks.
- Cloud runtime auto-connects to the first listed cloud agent or auto-creates one (`packages/app-core/src/components/shell/RuntimeGate.tsx:616-680`). Accounts with multiple agents need manual QA to confirm the chosen behavior is acceptable.

### P3

- Desktop docs say the child runtime receives `ELIZA_PORT` (`docs/apps/desktop.md:112-116`), but the runtime manager sets and then deletes `ELIZA_PORT`, leaving `ELIZA_API_PORT` in the child environment (`packages/app-core/platforms/electrobun/src/native/agent.ts:1237-1247`). This is likely docs drift or compatibility cleanup, but it should be aligned.
- The desktop release checklist is still very small (`docs/apps/desktop/release-regression-checklist.md:1-12`) compared with the number of platform/runtime/model combinations that need manual coverage.

## Codex-fixable work

- Persist a local active server when desktop local mode is chosen from `RuntimeGate`, or document why probing is intentional, then add a relaunch/restore unit test.
- Add targeted tests for disabled/manual desktop mode API-base behavior and renderer recovery messaging.
- Align `docs/apps/desktop.md` with the actual child runtime port environment (`ELIZA_API_PORT` vs `ELIZA_PORT`).
- Add explicit Windows copy/status for local embeddings being disabled in the embedded runtime.
- Add permission status tests or snapshot expectations for macOS, Windows, and Linux stubbed behavior.
- Add a single documented `desktop:smoke` script that builds or locates a packaged launcher, starts the app with test API settings, and runs the packaged regression suite.
- Expand `docs/apps/desktop/release-regression-checklist.md` into the matrix below or link to a fuller desktop launch QA checklist.

## Human desktop QA matrix

| Area | macOS | Windows | Linux | Expected |
| --- | --- | --- | --- | --- |
| Install/package | DMG/ZIP install, Gatekeeper, notarization, arm64/x64 if shipped | Installer/portable launch, SmartScreen/signature, x64/arm64 if shipped | AppImage/deb launch, sandbox/library dependencies | App opens without security blocks or missing native assets. |
| First launch all-local | No cloud session, choose local | No cloud session, choose local | No cloud session, choose local | Embedded runtime starts, health becomes ready, app reaches usable shell without onboarding loop. |
| First launch all-cloud | Cloud auth and deep-link return | Cloud auth and deep-link return | Cloud auth and deep-link return | Cloud agent connects or provisions, state persists after quit/relaunch. |
| External API mode | Set `ELIZA_DESKTOP_API_BASE` | Set `ELIZA_DESKTOP_API_BASE` | Set `ELIZA_DESKTOP_API_BASE` | Embedded runtime does not start; renderer uses external API and recovers on disconnect/reconnect. |
| Disabled/manual mode | Set `ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT=1` | Set same | Set same | Clear offline/manual-server behavior when no local server is running; recovery works after server starts. |
| Local models | Catalog, download, cancel, verify, activate, tiny GGUF generation | Same, plus Windows embedding limitation | Same, plus CPU/GPU fallback | Model lifecycle works and failures produce actionable UI/log messages. |
| Device bridge | Enable bridge and connect/disconnect | Enable bridge and connect/disconnect | Enable bridge and connect/disconnect | Device provider appears, routes correctly, and falls back cleanly. |
| App shell | Tray, dock/menu, close-to-tray, detached windows, external links | Tray/menu, close-to-tray, detached windows, external links | Tray/menu where supported, detached windows, external links | Shell controls behave consistently and external navigation is blocked or opened safely. |
| Permissions | Accessibility, screen recording, mic, camera, website blocking, location | Mic/camera/settings links, not-applicable states | Stubbed/granted/not-applicable states | UI status matches OS behavior; settings buttons open the right OS page where supported. |
| Persistence/upgrade | Relaunch, reset app data, upgrade older build | Relaunch, reset app data, upgrade older build | Relaunch, reset app data, upgrade older build | Active runtime, auth/session, window state, provider settings, and local models persist unless reset. |
| Crash/recovery | Kill child runtime, corrupt/missing runtime dist, port conflict | Same, plus process cleanup | Same | App reports failure, logs enough context, and reset/retry paths recover. |
| Power/GPU/windowing | WebGPU/CEF, battery, sleep/wake, resize/vibrancy | WebGPU/CEF, sleep/wake, resize | WebGPU/CEF flags, compositor differences | No blank canvas, runaway CPU/GPU, or broken layout after resume/resize. |

## Changed paths

- `launchdocs/09-desktop-qa.md`
