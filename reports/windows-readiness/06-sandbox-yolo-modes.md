# Sandbox / Execution Safety Model — Research Report

## 1. The model that already exists

Eliza ships a two-axis safety model. Both axes are well-defined in `@elizaos/shared` and `@elizaos/core`, and a central capability broker mediates privileged tool access. The Windows Store build is partially wired but not finished.

**Axis A — RuntimeExecutionMode** — *where computation runs, how trusted the host is.*
Defined in `packages/shared/src/config/runtime-mode.ts:5-11`:
- `cloud` — agent code runs in elizaOS Cloud; no host exec/FS.
- `local-safe` — host execution goes through Docker / Apple Container sandbox (`SandboxManager`).
- `local-yolo` — direct host exec; current default of `resolveRuntimeExecutionMode` at `runtime-mode.ts:145`.
Resolved from env vars `ELIZA_RUNTIME_MODE`, `RUNTIME_MODE`, `LOCAL_RUNTIME_MODE`.

**Axis B — DistributionProfile** — *which storefront the binary targets.*
Defined in `packages/shared/src/config/distribution-profile.ts:13-15`:
- `store` — Mac App Store / Play Store / Microsoft Store; must respect OS sandbox.
- `unrestricted` — direct download / dev (default at `:34`).
Resolved from env `ELIZA_DISTRIBUTION_PROFILE`.

**Build-variant** — *separate, baked-in flag on the binary itself.*
`packages/core/src/build-variant.ts:30` reads `ELIZA_BUILD_VARIANT` (legacy `MILADY_BUILD_VARIANT`), defaults to `direct`. Mirrored into the renderer via Vite define at `packages/ui/src/build-variant.ts:11-23` as `__ELIZA_BUILD_VARIANT__`. `isStoreBuild()` (`build-variant.ts:49`) is the canonical "are we packaging for a store?" predicate.

**CapabilityBroker** — `packages/agent/src/services/capability-broker.ts:356-469` is the single allow/deny chokepoint. The policy table at `:202-328` is keyed by `(RuntimeExecutionMode, DistributionProfile)` and covers 11 capability kinds (`fs, shell, net, camera, mic, location, screen, contacts, messages, health, browser, wallet`). It writes a JSONL audit log to `<stateDir>/audit/capability.jsonl`.

**ShellExecutionRouter** — `packages/agent/src/services/shell-execution-router.ts:250-285` is the single chokepoint for `child_process.spawn`-style execution. Routes through `SandboxManager` in `local-safe`, throws in `cloud`, host-execs in `local-yolo`. Always calls `assertShellCapability` (`:223`) which queries the broker.

**Sandbox-policy convenience layer** — `packages/core/src/sandbox-policy.ts:12-22` gives `isLocalCodeExecutionAllowed()` (true only for `direct` variant) and `buildStoreVariantBlockedMessage(label)` for user-facing messages.

**Store-build plugin gating** — `packages/agent/src/runtime/plugin-collector.ts:35-40, 614-618` already deletes three plugins from the load set when `storeBuild` is true: `@elizaos/plugin-agent-orchestrator`, `@elizaos/plugin-shell`, `@elizaos/plugin-coding-tools`.

**Per-plugin self-gating** — Each of the three "dangerous" plugins also self-guards via `terminalSupportedByEnv`: `plugin-shell/index.ts:7-20`, `plugin-coding-tools/src/index.ts:11-34`, and `plugin-agent-orchestrator/src/index.ts:62-116` (which substitutes a `tasksSandboxStubAction` returning `STORE_BUILD_BLOCKED`).

**MSIX packaging** — `packages/app-core/packaging/msix/build-msix.ps1:30-55` already selects `AppxManifest.store.xml` (AppContainer, no `runFullTrust`, only `internetClient`/`internetClientServer`) when `ELIZA_BUILD_VARIANT=store`. The store manifest is at `packages/app-core/packaging/msix/AppxManifest.store.xml`.

**Static gate test** — `scripts/launch-qa/check-store-security.mjs` enforces no `--no-sandbox` Chromium flags and that store-review markers exist.

## 2. Dangerous plugins — classification

| Plugin | Risk class | Reason | Current gating |
|---|---|---|---|
| plugin-shell | CRITICAL | Forks any binary, full host exec | Self-gates on `ELIZA_BUILD_VARIANT=store`; stripped by collector |
| plugin-coding-tools | CRITICAL | Bash + ripgrep + glob/edit anywhere on FS | Self-gates; stripped by collector |
| plugin-agent-orchestrator | CRITICAL | Spawns claude/codex/opencode CLIs via PTY/ACP | Stub action installed; stripped by collector |
| plugin-codex-cli | HIGH | OpenAI Codex CLI shim | NOT gated yet |
| plugin-computeruse | CRITICAL | Mouse/keyboard/screen capture, CDP, window mgmt | NOT gated (`autoEnable: envKeys: ["COMPUTER_USE_ENABLED"]`) |
| plugin-browser | HIGH | Puppeteer/CDP, stagehand-server | NOT gated |
| plugin-device-filesystem | MEDIUM | FS access — but rooted under workspace on desktop/AOSP | Soft-scoped; needs broker check in store mode |
| plugin-mcp | HIGH | Loads arbitrary user MCP servers (spawn) | NOT gated; commented out in core list |
| plugin-background-runner | HIGH | Background processes | NOT gated |
| plugin-app-control | HIGH | App worker host loads arbitrary plugin sandboxes | NOT gated |
| plugin-discord-local / plugin-bluebubbles / plugin-imessage | MEDIUM | OS-native messaging | NOT gated |
| plugin-health | MEDIUM | HealthKit/Fit; allowed in store but needs entitlements | Manifest-level only |
| plugin-music-player / plugin-screenshare | LOW-MED | Media; system-resource | NOT gated |
| Cloud/model providers (anthropic, openai, ollama, etc.) | SAFE | HTTP only | n/a |

## 3. Current default behavior per entrypoint

- **CLI (`bun run agent`)** — `ELIZA_RUNTIME_MODE` unset → defaults to `local-yolo` (`runtime-mode.ts:145`); `ELIZA_BUILD_VARIANT` unset → `direct`; `ELIZA_DISTRIBUTION_PROFILE` unset → `unrestricted`. Full power.
- **Desktop dev (Electrobun direct)** — Vite injects `__ELIZA_BUILD_VARIANT__='direct'`; collector keeps all plugins; broker policy `local-yolo/unrestricted` allows everything.
- **Desktop store (MSIX, future)** — `build-msix.ps1` sets variant in manifest, but the *running app's env* must also carry `ELIZA_BUILD_VARIANT=store` and `ELIZA_DISTRIBUTION_PROFILE=store`. **Today this is fragile**: the launcher does not inject these envs into the agent subprocess, so the broker falls back to `unrestricted` even in the AppContainer MSIX. The plugin-collector self-check works only if the agent process actually sees the env var.
- **Mobile (iOS)** — Mostly cloud/cloud-hybrid/remote; shell stripped via `MOBILE_CORE_PLUGINS` allowlist (`plugin-collector.ts:633-`).
- **Mobile (Android sideload)** — Local agent on loopback with `ELIZA_REQUIRE_LOCAL_AUTH=1`.
- **Mobile (Android Play-Store cloud build)** — UI suppresses the local picker (`RuntimeSettingsSection.tsx:67-80`).

## 4. What "Windows Store mode" must look like

Allowed: cloud chat, model providers (HTTP), VFS-scoped file picker reads, internet networking, the elizaOS Cloud control plane. Hidden: every plugin in the CRITICAL/HIGH table above; the runtime-mode picker's "local" target; any TASKS/CODE/BASH/COMPUTER_USE/BROWSER action surface; the "open workspace folder" UI; sandbox approvals UI; YOLO toggle. Disabled at compile time (Vite define + tree-shake) for renderer; disabled at module-load time (collector strip) for agent. Disabled at runtime (broker policy) as defense-in-depth.

## 5. Gates that need adding — exhaustive map

1. **Launcher → agent env propagation.** `launcher.exe` (and the dev `dev-desktop.pid` script) must inject `ELIZA_BUILD_VARIANT=store` and `ELIZA_DISTRIBUTION_PROFILE=store` into the spawned Node/Bun agent process for store builds. Today this contract is implicit; codify it in `packages/app-core/platforms/electrobun/src/native/agent.ts`.
2. **Plugin manifest `requiresUnsandboxed`.** Add a typed field to `Plugin` (`packages/core/src/types/plugin.ts`) so plugins self-declare. The collector reads this rather than the hardcoded `STORE_BUILD_LOCAL_EXECUTION_PLUGINS` Set at `plugin-collector.ts:35-40`. Apply to: computeruse, browser, mcp, background-runner, app-control, codex-cli, device-filesystem (write side), discord-local, bluebubbles, imessage.
3. **Broker policy entries for missing kinds.** Add `pty`, `ipc`, `mcp-spawn`, `cdp` to `CapabilityKind` in `capability-broker.ts:37`. Plumb them through the `cloud/store`, `local-safe/store`, `local-yolo/store` columns at `:217-311` (all deny in `*/store`).
4. **UI filtering.** Every settings page that lists a feature must consult `isStoreBuild()` and hide. `RuntimeSettingsSection.tsx` already does this for runtime picker; do the same in `AppContext`, `useAppLifecycleEvents`, the action catalog provider (`packages/core/src/generated/action-docs.ts`), and the connectors list (`packages/shared/src/contracts/onboarding.ts`).
5. **Compile-time strip.** `packages/app/vite.config.ts` should set `process.env.ELIZA_BUILD_VARIANT='store'` for the store build and use Vite `define` + a `dangerousPluginAllowlist.ts` re-export that returns `[]` in store mode, so the dead branches tree-shake out of the renderer bundle.
6. **Test gate.** Extend `scripts/launch-qa/check-store-security.mjs` to also assert the agent-side env-propagation contract and that no store-build bundle references the symbol set `ShellService | PTYService | ComputerUseService | SandboxService`.

## 6. Recommended gating architecture (three-layer)

- **Layer 1 — compile-time strip (renderer + AOSP bundle)**: Vite define + a "danger barrel" module that returns `[]` in store builds. Removes dead code from the binary so reviewers cannot find it. Source: `packages/ui/src/build-variant.ts`, `packages/app/vite.config.ts`, plus a new `packages/agent/src/runtime/store-allowlist.ts`.
- **Layer 2 — runtime hide (plugin-collector)**: existing pattern at `plugin-collector.ts:614-618`, but driven by `plugin.manifest.requiresUnsandboxed` instead of a hardcoded set. Single source of truth, fail-closed.
- **Layer 3 — runtime warn-and-block (CapabilityBroker)**: defense-in-depth — even if a plugin slips through, `broker.check()` returns deny with `policyKey=store:*:shell:exec` and writes to `capability.jsonl`. Already implemented; just needs new kinds.

## 7. Prioritized implementation plan

1. (P0, 1 day) Add `requiresUnsandboxed: boolean` to `Plugin` type and tag the ten dangerous plugins; switch `plugin-collector.ts:35` to read it.
2. (P0, 1 day) Wire `ELIZA_BUILD_VARIANT=store` + `ELIZA_DISTRIBUTION_PROFILE=store` into the MSIX launcher → agent process env in `app-core/platforms/electrobun/src/native/agent.ts`. Add a startup assertion that fails loud if the agent process sees `direct` while the binary is signed for store.
3. (P1, 1 day) Add the missing `CapabilityKind`s (`pty`, `mcp-spawn`, `cdp`) and extend the broker policy table; default to `deny` for `store` profile across all three runtime modes.
4. (P1, 1 day) Vite-define-driven compile-time strip of the "danger barrel" so the renderer bundle physically lacks the action handlers.
5. (P2) Extend `check-store-security.mjs` with the new invariants (no danger-symbol references in store bundle, env-propagation contract).
6. (P2) UI sweep: every settings panel, every action catalog provider, every onboarding picker gets an `isStoreBuild()` filter — mirror the pattern at `RuntimeSettingsSection.tsx:67-80`.

Key files for the change set: `packages/core/src/types/plugin.ts`, `packages/core/src/build-variant.ts`, `packages/core/src/sandbox-policy.ts`, `packages/shared/src/config/distribution-profile.ts`, `packages/shared/src/config/runtime-mode.ts`, `packages/agent/src/runtime/plugin-collector.ts`, `packages/agent/src/services/capability-broker.ts`, `packages/agent/src/services/shell-execution-router.ts`, `packages/app-core/platforms/electrobun/src/native/agent.ts`, `packages/app-core/packaging/msix/build-msix.ps1`, `packages/ui/src/build-variant.ts`, `packages/ui/src/components/settings/RuntimeSettingsSection.tsx`, `scripts/launch-qa/check-store-security.mjs`.
