# @elizaos/plugin-device-settings

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
| `DEVICE_SETTINGS_APP_NAME` | `src/components/device-settings-app.ts` | Constant `"@elizaos/plugin-device-settings"` |

Auto-registration entry point: `src/register.ts` calls `registerDeviceSettingsApp()` if `isElizaOS()` is true.

## Layout

```
src/
  index.ts                         Public barrel — re-exports everything below
  plugin.ts                        Plugin object (appDeviceSettingsPlugin / default)
  register.ts                      Side-effect: registers the overlay app on elizaOS boot
  ui.ts                            Alternate UI barrel (same exports as index, .tsx extensions)
  components/
    device-settings-app.ts         OverlayApp descriptor + registerDeviceSettingsApp()
    DeviceSettingsAppView.tsx      React overlay component (brightness, volume, roles, shortcuts)
```

## Commands

Scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-device-settings build       # tsup JS + tsc types
bun run --cwd plugins/plugin-device-settings typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-device-settings lint        # biome check src
bun run --cwd plugins/plugin-device-settings test        # vitest run
bun run --cwd plugins/plugin-device-settings clean       # rm -rf dist
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
