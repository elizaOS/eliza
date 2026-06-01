# @elizaos/capacitor-mobile-signals

Capacitor plugin that bridges mobile wake, lock, battery, and protected-data state into Eliza agents via the `MobileSignals` Capacitor plugin interface.

## Purpose / role

This is a **Capacitor plugin** (not an elizaOS runtime plugin with actions/providers). It exposes a cross-platform `MobileSignals` API surface that an Eliza mobile app (iOS or Android) installs and calls. On iOS it uses HealthKit, FamilyControls, and DeviceActivity; on Android it uses Health Connect and `PACKAGE_USAGE_STATS`. A web fallback uses `document.visibilityState`, `window.focus/blur`, and the Battery Status API. The plugin is opt-in — it must be explicitly registered with the Capacitor app and its native permissions must be granted by the user.

## Plugin surface

This package registers one Capacitor plugin: **`MobileSignals`**.

| Method | Description |
|---|---|
| `checkPermissions()` | Returns current permission status, capabilities, screen-time status, and required setup actions. |
| `requestPermissions(options?)` | Triggers native permission request flows (health, screen time, notifications). |
| `openSettings(options?)` | Opens a specific native settings page (app, health, battery optimization, etc.). |
| `startMonitoring(options?)` | Starts event streaming; returns initial device + health snapshots. |
| `stopMonitoring()` | Stops event streaming and removes all native listeners. |
| `getSnapshot()` | One-shot async read of current device + health state without streaming. |
| `scheduleBackgroundRefresh()` | Schedules a native background-refresh task (iOS BGAppRefreshTask). |
| `cancelBackgroundRefresh()` | Cancels any scheduled background-refresh task. |
| `addListener("signal", fn)` | Subscribes to `MobileSignalsSignal` events (device snapshot or health snapshot). |
| `removeAllListeners()` | Removes all registered event listeners. |

Two snapshot types are emitted on `"signal"`:
- **`MobileSignalsSnapshot`** (`source: "mobile_device"`) — state, idle/locked status, battery.
- **`MobileSignalsHealthSnapshot`** (`source: "mobile_health"`) — sleep, biometrics, screen-time status.

## Layout

```
src/
  definitions.ts   All exported TypeScript types and the MobileSignalsPlugin interface
  index.ts         Capacitor registerPlugin call — entry point for the JS/TS consumer
  web.ts           MobileSignalsWeb: browser fallback using visibility, focus, Battery API

android/
  src/main/java/ai/eliza/plugins/mobilesignals/
    MobileSignalsPlugin.kt   Android Capacitor plugin implementation

ios/Sources/MobileSignalsPlugin/
  MobileSignalsPlugin.swift  iOS Capacitor plugin implementation (HealthKit, FamilyControls)
  ScreenTimeSupport.swift    iOS Screen Time / DeviceActivity helpers

scripts/
  validate-ios-screen-time.mjs        Build-time wiring validator (exports validateIosScreenTimeBuildWiring, assertIosScreenTimeBuildWiring)
  validate-ios-screen-time.test.mjs   Tests for the validator

ElizaosCapacitorMobileSignals.podspec  CocoaPods spec (links FamilyControls + DeviceActivity frameworks)
rollup.config.mjs                      Rollup config for CJS bundle
tsconfig.json                          TypeScript config (emits to dist/esm/)
```

## Commands

Scripts that exist in this package's `package.json`:

```bash
# Build: tsc + rollup (outputs dist/esm/, dist/plugin.cjs.js, dist/plugin.js)
bun run --cwd plugins/plugin-native-mobile-signals build

# Clean dist/
bun run --cwd plugins/plugin-native-mobile-signals clean

# Run vitest tests
bun run --cwd plugins/plugin-native-mobile-signals test

# Validate iOS Screen Time build wiring against the host app's Xcode project
bun run --cwd plugins/plugin-native-mobile-signals validate:ios-screen-time

# Watch mode TypeScript compilation
bun run --cwd plugins/plugin-native-mobile-signals watch
```

## Config / env vars

| Variable | Required | Description |
|---|---|---|
| `MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE` | No | Path to the `.mobileprovision` file used by `validate:ios-screen-time` to verify Screen Time entitlements in the provisioning profile. |
| `MOBILE_SIGNALS_REQUIRE_IOS_PROVISIONING_PROFILE` | No | Set to `"1"` to make `validate:ios-screen-time` fail if no provisioning profile is supplied. |

No runtime environment variables are read by the plugin itself. Permission state and capabilities are determined at runtime by querying native APIs.

## iOS requirements

Screen Time / DeviceActivity features require additional entitlements and Xcode targets. The `validate:ios-screen-time` script checks:

1. `App.entitlements` contains `com.apple.developer.family-controls`.
2. Xcode project sets `CODE_SIGN_ENTITLEMENTS = App/App.entitlements`.
3. `DeviceActivityMonitorExtension` and `DeviceActivityReportExtension` app-extension targets exist and are embedded.
4. `ElizaosCapacitorMobileSignals.podspec` links `FamilyControls` and `DeviceActivity` frameworks.

Without these, `screenTime.supported` will be `false` and `screenTime.authorization.status` will be `"unavailable"`.

## Android requirements

The Android implementation uses `PACKAGE_USAGE_STATS` permission (requires the user to grant Usage Access in system settings — cannot be requested via a normal permission dialog). On Android the screen-time equivalent is `Health Connect` and `UsageStatsManager`. The plugin exposes `openSettings({ target: "usageAccess" })` to direct the user to the correct settings page.

## How to extend

**Add a new method to the plugin:**

1. Add the method signature to `MobileSignalsPlugin` interface in `src/definitions.ts`.
2. Add any new input/output types to `src/definitions.ts`.
3. Implement the method in `src/web.ts` (`MobileSignalsWeb` class) — return a graceful fallback for web.
4. Implement in `ios/Sources/MobileSignalsPlugin/MobileSignalsPlugin.swift`.
5. Implement in `android/src/main/java/ai/eliza/plugins/mobilesignals/MobileSignalsPlugin.kt`.
6. Rebuild: `bun run --cwd plugins/plugin-native-mobile-signals build`.

**Add a new signal field:**

Extend `MobileSignalsSnapshot` or `MobileSignalsHealthSnapshot` in `src/definitions.ts`, then propagate through the native implementations and the web fallback's `buildSnapshot` / `buildHealthSnapshot` helpers in `src/web.ts`.

## Conventions / gotchas

- This is a **Capacitor plugin**, not an elizaOS action/provider/service plugin. There is no `Plugin` object registered with `AgentRuntime`. It is consumed by a Capacitor-enabled mobile/web app.
- The web fallback (`src/web.ts`) always returns `status: "not-applicable"` for `checkPermissions` and `false` for health capabilities. Do not add health data to the web path.
- `rawUsageExportAvailable` is permanently `false` in `MobileSignalsScreenTimeStatus` — this is intentional (Apple does not expose raw usage export).
- On iOS, Screen Time features require Apple's restricted `com.apple.developer.family-controls` entitlement, which must be provisioned by Apple. The `validate:ios-screen-time` script is the canonical check.
- `dist/` is committed for publishing but should be regenerated via `build` before any release.
- The package uses three outputs: ESM (`dist/esm/`) for tree-shaking consumers, CJS (`dist/plugin.cjs.js`) for CommonJS hosts, and IIFE (`dist/plugin.js`) for unpkg/browser script-tag use. The `bun`/`development` export condition resolves directly to `src/index.ts` for local dev.
- See root `AGENTS.md` for repo-wide conventions (logging, ESM, naming, architecture rules).
