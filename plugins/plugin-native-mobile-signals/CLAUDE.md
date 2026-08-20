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
| `presentScreenTimeReport()` | Presents the authorized iOS DeviceActivity report; other platforms return an explicit unavailable result. |
| `startMonitoring(options?)` | Starts event streaming; returns initial device + health snapshots. |
| `stopMonitoring()` | Stops event streaming and removes all native listeners. |
| `getSnapshot()` | One-shot async read of current device + health state without streaming. |
| `scheduleBackgroundRefresh()` | Background refresh is unavailable on the current native implementations (iOS uses foreground monitoring and routes background work elsewhere; web cannot schedule). Always resolves `scheduled: false` with a reason. |
| `cancelBackgroundRefresh()` | No native background-refresh task is registered to cancel. Always resolves `cancelled: false` with a reason. |
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

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-mobile-signals clean                     # remove build output
bun run --cwd plugins/plugin-native-mobile-signals build                     # build package artifacts
bun run --cwd plugins/plugin-native-mobile-signals typecheck                 # TypeScript typecheck
bun run --cwd plugins/plugin-native-mobile-signals lint                      # mutating Biome check
bun run --cwd plugins/plugin-native-mobile-signals lint:check                # read-only Biome check
bun run --cwd plugins/plugin-native-mobile-signals format                    # write formatting
bun run --cwd plugins/plugin-native-mobile-signals format:check              # read-only formatting check
bun run --cwd plugins/plugin-native-mobile-signals test                      # run package tests
bun run --cwd plugins/plugin-native-mobile-signals prepublishOnly            # publish-time build hook
bun run --cwd plugins/plugin-native-mobile-signals watch                     # watch TypeScript sources
bun run --cwd plugins/plugin-native-mobile-signals build:unlocked            # bun run clean && bunx tsc -p tsconfig.json && bunx rollup -c rollup.config.mjs
bun run --cwd plugins/plugin-native-mobile-signals validate:ios-screen-time  # node scripts/validate-ios-screen-time.mjs
```

## Config / env vars

| Variable | Required | Description |
|---|---|---|
| `ELIZA_IOS_HEALTHKIT_ENABLED` | No | Exact `"1"` asks the canonical iOS build to publish `ELIZA_HEALTHKIT_ENABLED=1`. Missing, empty, or `"0"` disables HealthKit; every other value fails the build. Enabling also requires a verified provisioning profile. |
| `MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE` | When HealthKit is enabled | Path to the app's `.mobileprovision`. The canonical build verifies bundle binding plus HealthKit and background-delivery entitlements before publishing an enabled marker; `validate:ios-screen-time` also checks Screen Time authority. |
| `MOBILE_SIGNALS_REQUIRE_IOS_PROVISIONING_PROFILE` | No | Set to `"1"` to make `validate:ios-screen-time` fail if no provisioning profile is supplied. |

No runtime environment variables are read by the plugin itself. The native
HealthKit boundary reads the canonical build marker from the final app plist
before calling protected APIs; permission state is queried only when that
marker explicitly enables the capability.

## iOS requirements

HealthKit calls are default-off. The canonical app build accepts only
`ELIZA_IOS_HEALTHKIT_ENABLED=1`, requires
`MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE`, verifies that profile is bound to
the app id and grants both required HealthKit entitlements, then mirrors the
decision into the final native plist. Disabled or malformed markers expose a
truthful unavailable state and must not call HealthKit authorization, status,
query, or background-delivery APIs. An enabled unsigned or unprovisioned build
fails before the marker is emitted.

Screen Time / DeviceActivity features require additional entitlements and Xcode targets. The `validate:ios-screen-time` script checks:

1. `App.entitlements` contains `com.apple.developer.family-controls`.
2. Xcode project sets `CODE_SIGN_ENTITLEMENTS = App/App.entitlements`.
3. Both DeviceActivity extensions have the Family Controls entitlement and their targets select the matching entitlement files.
4. `DeviceActivityMonitorExtension` and `DeviceActivityReportExtension` app-extension targets exist and are embedded.
5. `ElizaosCapacitorMobileSignals.podspec` links `FamilyControls` and `DeviceActivity` frameworks.

Without these, `screenTime.supported` will be `false` and `screenTime.authorization.status` will be `"unavailable"`.

Apple provides DeviceActivity results only inside a sandboxed report extension.
The host exposes `presentScreenTimeReport()` after Family Controls authorization;
the extension aggregates and renders category totals without exporting them.
`reportAvailable` requires that authorized physical-device path. `coarseSummaryAvailable`,
`thresholdEventsAvailable`, and `rawUsageExportAvailable` must remain `false`
until a lawful host surface or a concrete scheduled threshold-event signal
exists. Never move report data through app groups or the network.

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

- **Instrumented test (issue #9967).** The `PACKAGE_USAGE_STATS` reads (AppOps `GET_USAGE_STATS` check + `UsageStatsManager.queryUsageStats`) live in `UsageStatsReader`; the plugin delegates to it (single source) so an on-device `androidTest` can drive the real provider. The permission is special-access, so the harness grants it host-side (`appops set <pkg> android:get_usage_stats allow`) and the usage tests `Assume`-skip when absent — verified positive on an API-34 emulator (real foreground-usage history).
- This is a **Capacitor plugin**, not an elizaOS action/provider/service plugin. There is no `Plugin` object registered with `AgentRuntime`. It is consumed by a Capacitor-enabled mobile/web app.
- The web fallback (`src/web.ts`) always returns `status: "not-applicable"` for `checkPermissions` and `false` for health capabilities. Do not add health data to the web path.
- `reportAvailable` requires a bundled authorized extension and the real host presenter. Host-readable summary and threshold-event flags remain false on iOS.
- `rawUsageExportAvailable` is permanently `false` in `MobileSignalsScreenTimeStatus` — this is intentional (Apple does not expose raw usage export).
- On iOS, Screen Time features require Apple's restricted `com.apple.developer.family-controls` entitlement, which must be provisioned by Apple. The `validate:ios-screen-time` script is the canonical check.
- `dist/` is committed for publishing but should be regenerated via `build` before any release.
- The package uses three outputs: ESM (`dist/esm/`) for tree-shaking consumers, CJS (`dist/plugin.cjs.js`) for CommonJS hosts, and IIFE (`dist/plugin.js`) for unpkg/browser script-tag use. The `bun`/`development` export condition resolves directly to `src/index.ts` for local dev.
- See root `CLAUDE.md` for repo-wide conventions (logging, ESM, naming, architecture rules).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
