# @elizaos/capacitor-mobile-signals

A Capacitor plugin that surfaces native mobile device state — wake/sleep, lock screen, battery, screen time, and health biometrics — to Eliza agents running in iOS and Android apps.

## What it does

On iOS and Android the plugin reads native signals that are unavailable to ordinary web APIs:

- **Device state** — whether the screen is active, idle, locked, or the app is backgrounded; battery charging status.
- **Health data** — current sleep stage, biometrics (heart rate, HRV, respiratory rate, blood oxygen) from HealthKit (iOS) or Health Connect (Android).
- **Screen time** — per-app usage summaries via Apple's DeviceActivity framework (iOS) or `UsageStatsManager` (Android).

In browser environments a web fallback is provided using `document.visibilityState`, `window.focus/blur`, and the Battery Status API. Health and screen-time capabilities return `false` on the web fallback.

## Capabilities

| Capability | iOS | Android | Web |
|---|---|---|---|
| Device state (active/idle/locked) | Yes | Yes | Partial (visibility/focus only) |
| Battery on/off charging | Yes | Yes | Yes (Battery Status API) |
| Sleep stage / biometrics | HealthKit | Health Connect | No |
| Screen time / usage | DeviceActivity + FamilyControls | `PACKAGE_USAGE_STATS` | No |
| Background refresh | `BGAppRefreshTask` | Not available | No |

## Installation

```bash
npm install @elizaos/capacitor-mobile-signals
npx cap sync
```

The plugin is registered automatically by Capacitor on iOS and Android. No manual `registerPlugin` call is needed in application code — import `MobileSignals` from the package and call its methods directly.

## Usage

```typescript
import { MobileSignals } from "@elizaos/capacitor-mobile-signals";

// Check permissions before monitoring
const status = await MobileSignals.checkPermissions();
console.log(status.engine); // "healthkit-screen-time" | "health-connect-usage-stats" | "web-fallback"

// Request permissions (triggers native dialogs)
if (status.status === "not-determined") {
  await MobileSignals.requestPermissions({ target: "all" });
}

// Start streaming signals
await MobileSignals.startMonitoring({ emitInitial: true });

await MobileSignals.addListener("signal", (signal) => {
  if (signal.source === "mobile_device") {
    console.log("Device state:", signal.state); // "active" | "idle" | "background" | "locked" | "sleeping"
    console.log("On battery:", signal.onBattery);
  }
  if (signal.source === "mobile_health") {
    console.log("Sleeping:", signal.sleep.isSleeping);
    console.log("Heart rate:", signal.biometrics.heartRateBpm);
  }
});

// One-shot read without streaming
const { snapshot, healthSnapshot } = await MobileSignals.getSnapshot();

// Stop when done
await MobileSignals.stopMonitoring();
```

## Permissions

### iOS

Add to `Info.plist`:

```xml
<key>NSHealthShareUsageDescription</key>
<string>Used to read sleep and biometric data for your agent.</string>
```

Screen Time features additionally require:

- The `com.apple.developer.family-controls` entitlement (provisioned by Apple — requires a special request).
- `DeviceActivityMonitorExtension` and `DeviceActivityReportExtension` app-extension targets in the Xcode project.
- The `FamilyControls` and `DeviceActivity` frameworks linked via the podspec.

Validate the iOS build wiring:

```bash
bun run --cwd plugins/plugin-native-mobile-signals validate:ios-screen-time
```

### Android

Add to `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.PACKAGE_USAGE_STATS"
    tools:ignore="ProtectedPermissions" />
```

Usage Access cannot be granted via a normal permission dialog. Direct the user to the system settings page:

```typescript
await MobileSignals.openSettings({ target: "usageAccess" });
```

## Environment variables (build-time only)

| Variable | Description |
|---|---|
| `MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE` | Path to a `.mobileprovision` to inspect for Screen Time entitlements during `validate:ios-screen-time`. |
| `MOBILE_SIGNALS_REQUIRE_IOS_PROVISIONING_PROFILE` | Set to `"1"` to fail validation when no provisioning profile is supplied. |

## Platform notes

- **Node (desktop):** No native integration. The web fallback applies.
- **iOS:** Full support. Requires Xcode target with correct entitlements for screen time features.
- **Android:** Full support for device state and Health Connect. Usage stats require manual user grant via settings.
- **Web:** Graceful fallback only. Health and screen-time capabilities are unavailable.

## License

MIT — elizaOS
