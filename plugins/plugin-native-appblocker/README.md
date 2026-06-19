# @elizaos/capacitor-appblocker

A Capacitor plugin that blocks selected apps on **Android** (Usage Access + system overlay) and **iOS** (Family Controls + ManagedSettings). Not available in browsers.

## What it does

The plugin lets a Capacitor-based Eliza agent app:

- Check and request the OS permissions required for blocking.
- Present the user with a system-level app picker to choose which apps to block.
- Apply or lift an app block, optionally with a time limit (Android) or indefinitely (iOS).
- Query the current blocking status and engine details.

### Platform engines

| Platform | Engine | Notes |
|---|---|---|
| Android | Usage Access + system overlay | A foreground service polls foreground events every 500 ms and shows a full-screen shield when a blocked app is detected. |
| iOS | Family Controls + ManagedSettings | `ManagedSettingsStore` shields selected apps. Timed blocks require a DeviceActivity extension; this package currently supports indefinite iOS blocks only. |
| Browser | None | Permission checks return `status: "not-applicable"`, `getStatus` returns `status: "unavailable"`, mutations return `success: false`, list methods return empty arrays. |

## API

```ts
import { AppBlocker } from "@elizaos/capacitor-appblocker";

// Check whether OS permissions are already granted
const perm = await AppBlocker.checkPermissions();

// Request missing permissions (opens system settings or triggers Family Controls auth)
await AppBlocker.requestPermissions();

// Android: get a list of installed launcher apps
const { apps } = await AppBlocker.getInstalledApps();

// iOS: opens FamilyActivityPicker and returns selected apps with tokenData.
// Android: returns immediately with { apps: [], cancelled: true } — use getInstalledApps() instead.
const { apps: selected, cancelled } = await AppBlocker.selectApps();

// Block apps — pass packageNames (Android) or appTokens (iOS)
const result = await AppBlocker.blockApps({
  packageNames: ["com.instagram.android"],
  durationMinutes: 60, // omit for indefinite; not supported on iOS
});

// Remove all active blocks
await AppBlocker.unblockApps();

// Get current blocking state
const status = await AppBlocker.getStatus();
```

Full TypeScript types are exported from the package root: `AppBlockerPlugin`, `AppBlockerStatus`, `AppBlockerPermissionResult`, `BlockAppsOptions`, `InstalledApp`, `SelectAppsResult`, `UnblockAppsResult`, `AppBlockerCapabilities`.

## Required permissions

### Android

The consuming app's `AndroidManifest.xml` inherits these declarations from the plugin:

- `PACKAGE_USAGE_STATS` — Usage Access (user must grant via Settings).
- `SYSTEM_ALERT_WINDOW` — Draw Over Other Apps (user must grant via Settings).
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` — required for the monitoring service.
- `POST_NOTIFICATIONS` — for the persistent "App Blocker Active" notification.

Use `checkPermissions()` / `requestPermissions()` to guide the user through granting both.

### iOS

The app must have the `com.apple.developer.family-controls` entitlement in its provisioning profile. Call `requestPermissions()` to trigger the system authorization sheet. Requires iOS 15.0+.

## Installation

```bash
npm install @elizaos/capacitor-appblocker
npx cap sync
```

For iOS, add the pod to your `Podfile` (Capacitor's sync does this automatically) and ensure your Xcode target has the Family Controls entitlement enabled.

## Building from source

```bash
bun run --cwd plugins/plugin-native-appblocker build
```

Produces `dist/esm/` (ESM), `dist/plugin.js` (IIFE/CDN), and `dist/plugin.cjs.js` (CJS).
