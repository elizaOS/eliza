# Launch Readiness 12: Computer Use QA

## Second-Pass Status (2026-05-05)

- Superseded: agent status now recognizes `@elizaos/plugin-computeruse` and has a regression test.
- Still open: default approval posture remains `full_control`, OS permission grants can auto-enable the plugin, settings still has two separate Computer Use controls, and approval-mode API/client lacks visible app UI.
- Launch gate: route/overlay tests cover deterministic behavior; real desktop click/type/screenshot, macOS TCC, permission revoke/regrant, and packaged app validation remain live/manual.

## Current state

Computer use is implemented as the optional core plugin `@elizaos/plugin-computeruse`. The plugin registers a `computeruse` service, desktop/browser/window/file/terminal actions, and a provider that exposes platform capabilities, recent actions, and approval queue state. The service defaults to `approvalMode: "full_control"` unless `COMPUTER_USE_APPROVAL_MODE` is configured or changed through the compat API.

The desktop settings permission model treats computer use as requiring macOS Accessibility and Screen Recording. The real runtime enable path is the Permissions settings capability toggle, which calls the plugin update API for `computeruse`. There is also a separate "Computer Use" switch in the Capabilities settings section, but that switch only stores a UI capability flag and does not enable or disable the runtime plugin.

The app has an approval overlay and `/api/computer-use/*` compat routes for approval queues and approval-mode changes. The overlay only appears when the approval manager queues commands; in the default `full_control` mode, commands auto-approve and no overlay appears.

Chat/agent integration exists through the plugin actions, a LifeOps wrapper action, owner-only plugin role gating, and runtime optional plugin loading. A status capability path appears to under-report computer-use availability when the loaded plugin name is the full package name.

## Evidence reviewed with file refs

- Plugin registration: `plugins/plugin-computeruse/src/index.ts:32` names the plugin `@elizaos/plugin-computeruse`; `plugins/plugin-computeruse/src/index.ts:40` registers the service; `plugins/plugin-computeruse/src/index.ts:42` registers the actions; `plugins/plugin-computeruse/src/index.ts:54` allows env auto-enable via `COMPUTER_USE_ENABLED`.
- Service defaults and capabilities: `plugins/plugin-computeruse/src/services/computer-use-service.ts:107` defines service type `computeruse`; `plugins/plugin-computeruse/src/services/computer-use-service.ts:117` sets defaults; `plugins/plugin-computeruse/src/services/computer-use-service.ts:121` defaults approval mode to `full_control`; `plugins/plugin-computeruse/src/services/computer-use-service.ts:1486` detects platform capabilities.
- Approval manager: `plugins/plugin-computeruse/src/approval-manager.ts:11` defines valid modes; `plugins/plugin-computeruse/src/approval-manager.ts:56` stores mode in `~/.eliza/computer-use-approval.json`; `plugins/plugin-computeruse/src/approval-manager.ts:83` auto-approval behavior; `plugins/plugin-computeruse/src/approval-manager.ts:99` creates pending approvals.
- Approval service/API bridge: `plugins/plugin-computeruse/src/services/computer-use-service.ts:910` exposes mode/snapshot/resolve methods; `plugins/plugin-computeruse/src/services/computer-use-service.ts:1259` blocks, queues, or auto-approves actions; `packages/app-core/src/api/computer-use-compat-routes.ts:146` handles SSE approval stream; `packages/app-core/src/api/computer-use-compat-routes.ts:206` handles approval snapshots; `packages/app-core/src/api/computer-use-compat-routes.ts:221` handles approval-mode updates; `packages/app-core/src/api/computer-use-compat-routes.ts:252` handles approval resolution; `packages/app-core/src/api/client-computeruse.ts:47` exposes the client methods.
- Approval UI: `packages/app-core/src/components/shell/ComputerUseApprovalOverlay.tsx:53` starts SSE/polling; `packages/app-core/src/components/shell/ComputerUseApprovalOverlay.tsx:122` approves or rejects pending commands; `packages/app-core/src/components/shell/ComputerUseApprovalOverlay.tsx:166` hides when no approvals are queued.
- Permission definitions/UI: `packages/app-core/src/components/settings/permission-types.ts:15` defines Accessibility and Screen Recording; `packages/app-core/src/components/settings/permission-types.ts:101` defines `computeruse` requiring both permissions; `packages/app-core/src/components/settings/PermissionsSection.tsx:237` loads desktop permission state; `packages/app-core/src/components/settings/PermissionsSection.tsx:315` implements Allow All; `packages/app-core/src/components/settings/PermissionsSection.tsx:391` renders capability toggles; `packages/app-core/src/components/settings/PermissionsSection.tsx:416` calls `handlePluginToggle(cap.id, enabled)`.
- Native permission bridge: `packages/app-core/platforms/electrobun/src/native/permissions-shared.ts:22` mirrors native permission definitions; `packages/app-core/platforms/electrobun/src/native/permissions.ts:72` checks permissions; `packages/app-core/platforms/electrobun/src/native/permissions.ts:130` requests permissions; `packages/app-core/platforms/electrobun/src/native/permissions-darwin.ts:216` checks macOS TCC permissions; `packages/app-core/platforms/electrobun/src/native/permissions-darwin.ts:266` requests/opens privacy settings.
- Capability toggles/config: `packages/app-core/src/components/settings/CapabilitiesSection.tsx:123` renders a separate Computer Use switch; `packages/app-core/src/components/settings/CapabilitiesSection.tsx:136` only calls `setState("computerUseEnabled", ...)`; `packages/app-core/src/state/useWalletState.ts:99` stores the UI flag and updates `ui.capabilities.computerUse`; `packages/app-core/src/state/persistence.ts:696` persists the UI flag in localStorage.
- Runtime plugin config: `packages/agent/src/api/plugin-routes.ts:746` writes `config.plugins.entries`; `packages/agent/src/api/plugin-routes.ts:792` mirrors capability toggle state into `config.features`; `packages/agent/src/api/permissions-routes.ts:249` accepts permission snapshots; `packages/agent/src/api/permissions-routes.ts:263` auto-enables capabilities when required permissions are granted; `packages/agent/src/runtime/plugin-collector.ts:149` maps `computeruse` to `@elizaos/plugin-computeruse`; `packages/agent/src/runtime/plugin-collector.ts:452` loads enabled optional plugin entries; `packages/agent/src/runtime/plugin-collector.ts:478` also loads from feature flags.
- Chat/agent integration and gating: `packages/agent/src/runtime/plugin-role-gating.ts:42` applies plugin-level role gates; `packages/agent/src/runtime/plugin-role-gating.ts:47` gates computer-use to owner; `packages/agent/src/api/agent-status-routes.ts:180` detects browser plugins; `packages/agent/src/api/agent-status-routes.ts:185` detects computer plugins only by short IDs; `packages/agent/src/api/agent-status-routes.ts:257` reports `canUseComputer`; `plugins/app-lifeops/src/actions/computer-use.ts` wraps the plugin actions with LifeOps policy and ownership checks.
- Tests reviewed: `plugins/plugin-computeruse/src/__tests__/actions.test.ts`, `plugins/plugin-computeruse/src/__tests__/approval-flow.test.ts`, `plugins/plugin-computeruse/src/__tests__/permissions.test.ts`, `plugins/plugin-computeruse/src/__tests__/security.test.ts`, `plugins/plugin-computeruse/src/__tests__/desktop.test.ts`, `plugins/plugin-computeruse/src/__tests__/terminal.test.ts`, `packages/app-core/src/components/shell/ComputerUseApprovalOverlay.test.tsx`, `packages/app-core/src/api/computer-use-compat-routes.test.ts`, `packages/app-core/src/components/settings/permission-types.test.ts`, `packages/app-core/src/components/settings/CapabilitiesSection.test.tsx`, and `plugins/app-lifeops/src/actions/computer-use.test.ts`.

## What I could validate

- Targeted plugin tests passed:
  - Command: `bun run test -- src/__tests__/actions.test.ts src/__tests__/approval-flow.test.ts src/__tests__/permissions.test.ts src/__tests__/security.test.ts src/__tests__/desktop.test.ts src/__tests__/terminal.test.ts src/__tests__/windows-list.test.ts src/__tests__/helpers.test.ts src/__tests__/smoke.test.ts`
  - Directory: `plugins/plugin-computeruse`
  - Result: 9 files passed, 88 tests passed.
- Targeted app-core approval/settings tests passed:
  - Command: `bun run test -- src/components/shell/ComputerUseApprovalOverlay.test.tsx src/api/computer-use-compat-routes.test.ts src/components/settings/permission-types.test.ts src/components/settings/CapabilitiesSection.test.tsx src/state/useOnboardingCallbacks.test.ts`
  - Directory: `packages/app-core`
  - Result: 5 files passed, 11 tests passed.
- Targeted LifeOps wrapper test passed:
  - Command: `bun run test -- src/actions/computer-use.test.ts`
  - Directory: `plugins/app-lifeops`
  - Result: 1 file passed, 7 tests passed.
- Static review validates that file and terminal operations have explicit path/command security checks, permission error classification, and truncation limits.
- Static review validates that approval SSE, polling fallback, approve/reject UI, and compat routes exist and have focused unit coverage.
- Static review validates that computer-use plugin loading is supported through optional plugin alias resolution and owner role gating.

## What I could not validate

- I did not validate real macOS TCC prompts, System Settings deep links, post-grant refresh behavior, packaged app identity, or whether Screen Recording requires restart/relaunch in the current build.
- I did not run live desktop automation against the current machine: no real screenshot capture, click, keypress, drag, scroll, browser CDP session, file write, or terminal command was executed outside the mocked/unit paths.
- I did not run the opt-in live E2E tests gated by `COMPUTER_USE_E2E_RUNTIME` or `COMPUTER_USE_LIVE_E2E`.
- I did not run full UI Playwright against the packaged desktop app, so I could not validate that the two Computer Use controls are discoverable, non-confusing, and wired to the expected backend state in a real session.
- I did not validate non-owner chat attempts or REST-auth failure modes end to end, only the static owner-gating path and wrapper tests.

## Bugs/risks P0-P3

- P0: None found in this bounded review.
- P1: Granting OS permissions can implicitly enable computer use, and the plugin defaults to full auto-approval. `packages/agent/src/api/permissions-routes.ts:263` auto-enables `computeruse` when Accessibility and Screen Recording are granted and the config entry is unset. The plugin then defaults to `full_control` at `plugins/plugin-computeruse/src/services/computer-use-service.ts:121`, and `plugins/plugin-computeruse/src/approval-manager.ts:83` auto-approves all commands in that mode. This makes "grant permissions" and "allow autonomous desktop/file/terminal control" too close together for launch safety.
- P2: There are two different Computer Use on/off controls with different effects. The Permissions capability toggle updates the runtime plugin via `handlePluginToggle` at `packages/app-core/src/components/settings/PermissionsSection.tsx:416`, but the Capabilities switch at `packages/app-core/src/components/settings/CapabilitiesSection.tsx:136` only writes `ui.capabilities.computerUse` through `packages/app-core/src/state/useWalletState.ts:99`. A user can enable the visible Capabilities switch without enabling the actual plugin.
- P2: Agent status likely reports `capabilities.canUseComputer: false` even when the real plugin is loaded. The plugin name is `@elizaos/plugin-computeruse` at `plugins/plugin-computeruse/src/index.ts:32`, but `packages/agent/src/api/agent-status-routes.ts:185` only matches `computeruse` and `computer-use` exactly after lowercasing. That misses the full package name and can mislead chat/UI capability checks.
- P3: There is no app UI found for `setComputerUseApprovalMode`, even though the client and route exist. Repo search found live approval-mode setters only in the client/API/tests/stubs/docs path, not in a settings control. Users need an env var or API call to escape the default `full_control` behavior.
- P3: Native OS-permission behavior is mostly untested in automation. The repo has good metadata and overlay tests, but the Electrobun native permission bridge and macOS TCC edge cases need human/device QA.

## Codex-fixable work

- Change computer-use launch posture so explicit user intent is required before the plugin can run: do not auto-enable `computeruse` from permission snapshots, or only auto-enable a disabled/paused mode that requires a separate explicit capability toggle.
- Add an approval-mode selector in Settings near the Computer Use capability with `off`, `approve_all`, `smart_approve`, and `full_control`; default new installs to `approve_all` or `smart_approve`, not `full_control`.
- Unify the two Computer Use switches. Either remove the UI-only Capabilities switch or wire it to the same plugin update path and permission gating used by `PermissionsSection`.
- Fix agent-status detection to treat `@elizaos/plugin-computeruse`, `computeruse`, and `computer-use` as the same capability. Add a route/unit test with `runtime.plugins = [{ name: "@elizaos/plugin-computeruse" }]`.
- Add focused tests for the permission-to-plugin state machine: permissions granted must not silently enable unsafe runtime behavior; toggling off must persist and survive permission refresh/startup.
- Add UI tests for approval mode and approval queue behavior: in `approve_all`, a command queues, the overlay appears, approve resolves, reject blocks, and `off` blocks without queueing.

## Human OS-permission QA needed

- macOS fresh install with no permissions: verify Accessibility and Screen Recording rows show the correct state, Grant/Open Settings opens the correct Privacy panes, and Refresh updates after granting.
- macOS denied/revoked permissions: verify computer-use capability remains unavailable or disabled, action attempts return actionable permission errors, and no commands execute.
- macOS post-grant lifecycle: verify whether the app must quit/relaunch for Screen Recording and whether the UI copy/state handles that correctly.
- Packaged app identity: verify the expected Eliza app binary appears in System Settings, permissions persist across updates, and old/dev bundle IDs do not cause stale TCC state.
- Approval overlay: set `COMPUTER_USE_APPROVAL_MODE=approve_all`, trigger a harmless screenshot/click/browser action from chat, and verify SSE/poll fallback, Approve, and Reject in the real desktop UI.
- Permission refresh/auto-enable: after granting OS permissions, inspect config/plugins/status to confirm whether computer use was enabled automatically; decide if this is acceptable for launch.
- Non-macOS sanity: verify Windows/Linux mark Accessibility and Screen Recording not-applicable while still showing coherent capability state and platform capability detection.
- Role gating: verify a non-owner chat/user cannot invoke computer-use actions even when the plugin is enabled.

## Recommended tests

- Add an agent-status unit test covering full package plugin names for `canUseComputer`.
- Add a `PermissionsSection` test where Accessibility and Screen Recording are granted, the Computer Use capability toggle is clicked, and `client.updatePlugin("computeruse", { enabled: true })` is called.
- Add a regression test that `CapabilitiesSection` cannot drift from plugin state, or remove that separate switch and test the replacement navigation/control.
- Add permission-route tests for `PUT /api/permissions/state` covering unset, explicitly disabled, and explicitly enabled `computeruse` entries.
- Add app-core tests for approval-mode UI once exposed: mode switch calls `/api/computer-use/approval-mode`, and queued approvals appear only in modes that require approval.
- Add an opt-in desktop smoke script for macOS that reports permission status, captures a screenshot, queues a harmless action in `approve_all`, then rejects it.
- Keep the existing plugin security tests in the launch gate; they are a useful bounded check for terminal/file risks.

## Changed paths

- `launchdocs/12-computer-use-qa.md`
