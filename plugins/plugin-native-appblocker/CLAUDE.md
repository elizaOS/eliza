# @elizaos/capacitor-appblocker

Capacitor plugin that blocks selected apps on Android (Usage Access + system overlay) and iOS (Family Controls + ManagedSettings).

## Purpose / role

This is a Capacitor native plugin — not an elizaOS action/service plugin. It exposes a JavaScript API (`AppBlocker`) that a Capacitor-based Eliza agent app can call to check permissions, let the user select apps to block, apply a block, and remove it. It has no runtime on the web (all methods return `not-applicable`). It is opt-in: the consuming app must register `ElizaAppBlockerPlugin` with Capacitor and call into the JS API.

## Plugin surface

This is a Capacitor plugin, not an elizaOS plugin. It does not register elizaOS actions, providers, services, evaluators, routes, or events. The JS-side API exported from `src/index.ts` is:

| Method | Description |
|---|---|
| `AppBlocker.checkPermissions()` | Returns current permission status and engine capabilities |
| `AppBlocker.requestPermissions()` | Opens system settings to grant Usage Access + overlay (Android) or triggers Family Controls auth (iOS) |
| `AppBlocker.getInstalledApps()` | Returns list of installed launcher apps (Android only; iOS returns `[]`) |
| `AppBlocker.selectApps()` | Opens the system app-picker UI; returns selected `InstalledApp[]` with `tokenData` on iOS |
| `AppBlocker.blockApps(options)` | Activates blocking for given `packageNames` (Android) or `appTokens` (iOS); optional `durationMinutes` |
| `AppBlocker.unblockApps()` | Removes all active blocks |
| `AppBlocker.getStatus()` | Returns full `AppBlockerStatus` including active state, blocked count, engine, and permission details |

## Layout

```
plugins/plugin-native-appblocker/
  src/
    index.ts               JS entry — registerPlugin("ElizaAppBlocker") + lazy web fallback
    definitions.ts         All TypeScript types: AppBlockerPlugin, AppBlockerStatus,
                           BlockAppsOptions, InstalledApp, SelectAppsResult, etc.
    web.ts                 Web stub — all methods return not-applicable/unavailable
  android/src/main/
    AndroidManifest.xml    Declares permissions (PACKAGE_USAGE_STATS, SYSTEM_ALERT_WINDOW,
                           FOREGROUND_SERVICE, POST_NOTIFICATIONS) and ForegroundService
    java/ai/eliza/plugins/appblocker/
      AppBlockerPlugin.kt        Capacitor @PluginMethod handlers for Android
      AppBlockerForegroundService.kt  Polls UsageStatsManager every 500 ms; shows/hides overlay
      AppBlockerStateStore.kt    SharedPreferences persistence for blocked packages + expiry
  ios/Sources/AppBlockerPlugin/
    AppBlockerPlugin.swift       CAPPlugin with all method handlers for iOS
    AppBlockerShared.swift       ManagedSettingsStore shield apply/clear + UserDefaults state
    FamilyActivityPickerBridge.swift  SwiftUI FamilyActivityPicker presented as form sheet
  ElizaosCapacitorAppblocker.podspec  CocoaPods spec (links FamilyControls + ManagedSettings)
  rollup.config.mjs          Bundles dist/esm → dist/plugin.js (IIFE) + dist/plugin.cjs.js
  tsconfig.json              ES2022, strict, noImplicitAny, noUnusedLocals/Parameters
```

## Commands

Only scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-native-appblocker build         # tsc + rollup → dist/
bun run --cwd plugins/plugin-native-appblocker clean         # rm dist/
```

There are no test or lint scripts in this package.

## Config / env vars

This plugin reads no environment variables. It requires OS-level permissions granted at runtime by the user:

- **Android**: `PACKAGE_USAGE_STATS` (Usage Access) and `SYSTEM_ALERT_WINDOW` (Draw Over Other Apps) — must both be granted for `blockApps` to succeed.
- **iOS**: Family Controls authorization (`AuthorizationCenter.shared.requestAuthorization`) — requires a developer provisioning profile with `com.apple.developer.family-controls` entitlement. Timed blocks (`durationMinutes > 0`) are not implemented on iOS (requires a DeviceActivity extension; returns an error).

## How to extend

**Add a new method (JS → native):**

1. Add the method signature to `AppBlockerPlugin` interface in `src/definitions.ts`.
2. Add a no-op/error implementation in `src/web.ts` (`AppBlockerWeb`).
3. Add `@PluginMethod fun myMethod(call: PluginCall)` to `android/.../AppBlockerPlugin.kt`.
4. Add `@objc func myMethod(_ call: CAPPluginCall)` to `ios/.../AppBlockerPlugin.swift` and register it in `pluginMethods`.
5. Run `bun run --cwd plugins/plugin-native-appblocker build` to rebuild `dist/`.

## Conventions / gotchas

- **Capacitor plugin, not elizaOS plugin**: this has no `Plugin` object shaped for `AgentRuntime`. Do not wire it into elizaOS plugin loading. The consuming app imports and uses `AppBlocker` from JS.
- **Android blocking engine**: a foreground service (`AppBlockerForegroundService`) polls `UsageStatsManager.queryEvents` every 500 ms and shows a full-screen system overlay when a blocked app moves to foreground. The service is `START_STICKY`; it self-terminates if the block state is cleared or the timer expires.
- **iOS engine**: uses `ManagedSettingsStore` to set `store.shield.applications`. No polling; the OS enforces the shield. `getInstalledApps` always returns `[]` on iOS because Family Controls does not expose an app list — use `selectApps` to let the user pick via `FamilyActivityPicker`.
- **iOS timed blocks**: not implemented. `blockApps` with `durationMinutes > 0` returns `success: false` with an explanatory error. An indefinite block + manual `unblockApps` is the current iOS path.
- **Build output**: `tsc` writes to `dist/esm/`; rollup bundles that into `dist/plugin.js` (IIFE for CDN/`unpkg`) and `dist/plugin.cjs.js` (CJS for Node consumers). The `exports` field in `package.json` points directly to `src/index.ts` for Bun/development consumers.
- **Capacitor version**: peer dep `@capacitor/core ^8.3.1`. Keep in sync with the consuming app's Capacitor version or Capacitor's JS ↔ native bridge will misroute calls.
- **iOS deployment target**: iOS 15.0 (set in podspec). `FamilyControls` authorization API differs between iOS < 16 and >= 16; `AppBlockerPlugin.swift` handles both paths.
