# @elizaos/plugin-native-settings

Android device-settings overlay app for elizaOS: controls brightness, audio volume streams, Android default roles, and system settings shortcuts.

## Purpose / role

Registers an overlay app (`OverlayApp`) in the elizaOS UI shell that gives users direct control over Android system settings — brightness, per-stream volume, Android role assignment (Home, Phone, SMS, Assistant), and deep-links into system settings panels — all via the `@elizaos/capacitor-system` native bridge.

The plugin surface is **Android-only** (`androidOnly: true` in the `elizaos.app` manifest). The overlay app is registered automatically when the module is imported inside an elizaOS context (`isElizaOS()` guard in `src/register.ts`). There are no agent-side actions, providers, evaluators, or services; the entire plugin surface is a UI overlay.

## Plugin surface

The plugin object (`appDeviceSettingsPlugin`) in `src/plugin.ts` carries only `name` and `description` — no actions, providers, evaluators, services, routes, or events. All runtime behaviour is delivered through the overlay app registered via `@elizaos/ui`.

| Export | Source | What it does |
|---|---|---|
| `appDeviceSettingsPlugin` | `src/plugin.ts` | Bare `Plugin` object (name + description only) |
| `deviceSettingsApp` | `src/components/device-settings-app.ts` | `OverlayApp` descriptor — display name, category `system`, `androidOnly: true`, lazy loader |
| `registerDeviceSettingsApp()` | `src/components/device-settings-app.ts` | Calls `registerOverlayApp(deviceSettingsApp)` from `@elizaos/ui` |
| `DeviceSettingsAppView` | `src/components/DeviceSettingsAppView.tsx` | React component — the full overlay UI |
| `DEVICE_SETTINGS_APP_NAME` | `src/components/device-settings-app.ts` | Constant `"@elizaos/plugin-native-settings"` |

Auto-registration entry point: `src/register.ts` calls `registerDeviceSettingsApp()` if `isElizaOS()` is true.

## Layout

```
src/
  index.ts                         Public barrel — re-exports everything below
  plugin.ts                        Plugin object (appDeviceSettingsPlugin / default)
  register.ts                      Side-effect: registers the overlay app on elizaOS boot
  ui.ts                            UI-only barrel (DeviceSettingsAppView + device-settings-app exports, explicit .tsx/.ts extensions)
  components/
    device-settings-app.ts         OverlayApp descriptor + registerDeviceSettingsApp()
    DeviceSettingsAppView.tsx      React overlay component (brightness, volume, roles, shortcuts)
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-settings clean         # remove build output
bun run --cwd plugins/plugin-native-settings build         # build package artifacts
bun run --cwd plugins/plugin-native-settings typecheck     # TypeScript typecheck
bun run --cwd plugins/plugin-native-settings lint          # mutating Biome check
bun run --cwd plugins/plugin-native-settings lint:check    # read-only Biome check
bun run --cwd plugins/plugin-native-settings format        # write formatting
bun run --cwd plugins/plugin-native-settings format:check  # read-only formatting check
bun run --cwd plugins/plugin-native-settings test          # run package tests
bun run --cwd plugins/plugin-native-settings build:js      # tsup --config ../tsup.plugin-packages.shared.ts
bun run --cwd plugins/plugin-native-settings build:types   # tsc --noCheck -p tsconfig.build.json
```

## Config / env vars

No environment variables. No runtime configuration is read by this plugin.

Native capabilities are provided by `@elizaos/capacitor-system` (`System.*` API). The plugin is only functional when:
- Running inside the elizaOS mobile shell (Android).
- The `@elizaos/capacitor-system` Capacitor plugin is registered in the native layer.
- Android write-settings permission is granted for brightness control.

## How to extend

### Add a new settings control

1. Add the native call to `@elizaos/capacitor-system` if not already present.
2. Add state + handler logic in `DeviceSettingsAppView.tsx` following the existing `applyBrightness` / `applyVolume` pattern.
3. Add the UI section in the JSX grid.

### Add a new overlay section unrelated to device settings

Create a new plugin following the same shape: define an `OverlayApp` object, call `registerOverlayApp()`, and export a `Plugin` descriptor. See `src/components/device-settings-app.ts` for the minimal template.

## Conventions / gotchas

- **Android-only.** The overlay descriptor carries `androidOnly: true`. Do not render native Android APIs in non-Android runtimes — the component guards with empty-state fallbacks when volume streams or roles are absent.
- **No agent actions.** This plugin adds no `Action`, `Provider`, `Evaluator`, or `Service` to the elizaOS agent runtime. If you need the agent to programmatically change device settings, add actions here and wire them through the `@elizaos/capacitor-system` bridge.
- **Write-settings permission.** `System.setScreenBrightness` requires the Android `WRITE_SETTINGS` permission. The UI conditionally renders a permission button (`openSetting("write", ...)`) when `canWriteSettings` is false.
- **`isElizaOS()` guard.** `src/register.ts` uses `isElizaOS()` from `@elizaos/ui` to skip registration in non-elizaOS contexts (e.g., plain web dev builds).
- **Lazy loading.** The `DeviceSettingsAppView` component is loaded via dynamic import inside `deviceSettingsApp.loader` — keep the component self-contained (no side-effect imports at the module level).
- For repo-wide conventions (logger, ESM, naming, architecture layers), see the root `AGENTS.md`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
