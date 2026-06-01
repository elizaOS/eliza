# @elizaos/capacitor-location

A Capacitor plugin that provides geolocation services (current position, watch position, permissions) to Eliza agents running in browser, Electrobun desktop, iOS, and Android environments.

## Purpose / role

This is **not** an elizaOS `Plugin` object (no actions/providers/evaluators). It is a **Capacitor native plugin** that bridges device location hardware to TypeScript via the Capacitor plugin bridge. It is loaded by calling `registerPlugin("ElizaLocation", { web: loadWeb })` at import time and consumed directly in UI or agent service code that needs coordinates. It is opt-in — nothing auto-loads it; code that needs location imports and calls it explicitly.

Platform support (from `package.json#elizaos.platformDetails`):
- **browser / Electrobun desktop** — `LocationWeb` class wraps `navigator.geolocation`
- **iOS** — Swift `ElizaLocationPlugin` using `CoreLocation / CLLocationManager`
- **Android** — Kotlin `LocationPlugin` using Google Play Services `FusedLocationProviderClient`

## Plugin surface

This plugin exposes one JS singleton (`Location`) with the following methods (defined in `src/definitions.ts`):

| Method | Description |
|--------|-------------|
| `getCurrentPosition(options?)` | One-shot position fix. Respects `maxAge` cache, `timeout`, and `accuracy`. |
| `watchPosition(options?)` | Continuous updates. Returns `{ watchId }`. Fires `locationChange` events. |
| `clearWatch({ watchId })` | Stop a running watch by ID. |
| `checkPermissions()` | Returns current `LocationPermissionStatus` (no prompt). |
| `requestPermissions()` | Requests OS permission; on web triggers `getCurrentPosition` implicitly. |
| `addListener("locationChange", fn)` | Subscribe to position updates while watching. |
| `addListener("error", fn)` | Subscribe to location errors (`PERMISSION_DENIED`, `POSITION_UNAVAILABLE`, `TIMEOUT`, `UNKNOWN`). |
| `removeAllListeners()` | Remove all registered listeners. |

## Layout

```
plugins/plugin-native-location/
  src/
    definitions.ts     — All exported TS types: LocationPlugin interface, LocationCoordinates,
                         LocationResult, LocationPermissionStatus, LocationOptions,
                         WatchLocationOptions, LocationErrorEvent, LocationAccuracy
    web.ts             — LocationWeb: browser Geolocation API implementation (WebPlugin subclass)
    index.ts           — registerPlugin("ElizaLocation") entry point; re-exports definitions
  ios/Sources/LocationPlugin/
    LocationPlugin.swift — CLLocationManager bridge (getCurrentPosition, watchPosition,
                           clearWatch, checkPermissions, requestPermissions)
  android/src/main/java/ai/eliza/plugins/location/
    LocationPlugin.kt  — FusedLocationProviderClient bridge (same API surface as Swift)
  ElizaosCapacitorLocation.podspec — CocoaPods spec for iOS integration
  rollup.config.mjs    — Bundles ESM → IIFE (dist/plugin.js) + CJS (dist/plugin.cjs.js)
  tsconfig.json        — TS config (targets dist/esm/)
```

## Commands

Only scripts that exist in this package's `package.json`:

```bash
# Build TypeScript + rollup bundles
bun run --cwd plugins/plugin-native-location build

# Build with generated API docs (runs docgen → tsc → rollup)
bun run --cwd plugins/plugin-native-location build:docs

# Delete dist/
bun run --cwd plugins/plugin-native-location clean

# Generate README.md from JSDoc (requires @capacitor/docgen)
bun run --cwd plugins/plugin-native-location docgen
```

## Config / env vars

This plugin reads **no environment variables**. All configuration is passed per-call via `LocationOptions` / `WatchLocationOptions`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `accuracy` | `"best"\|"high"\|"medium"\|"low"\|"passive"` | `"high"` | Maps to platform-native accuracy tiers |
| `maxAge` | `number` (ms) | `0` | Serve cached location if younger than this. `0` = always fetch fresh. |
| `timeout` | `number` (ms) | `10000` | Abort if no fix within this window |
| `minDistance` | `number` (m) | `0` | Watch only — minimum movement before emitting (Android/iOS only) |
| `minInterval` | `number` (ms) | `0` | Watch only — minimum time between emitted events |

Native platform permissions are requested at runtime via `requestPermissions()` and must be declared in the host app:
- **iOS:** `NSLocationWhenInUseUsageDescription` (and `NSLocationAlwaysAndWhenInUseUsageDescription` for background) in `Info.plist`
- **Android:** `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, and optionally `ACCESS_BACKGROUND_LOCATION` in `AndroidManifest.xml`

## How to extend

### Add a new method to the plugin

1. Add the method signature to `LocationPlugin` interface in `src/definitions.ts`.
2. Implement it in `src/web.ts` (`LocationWeb` class) for web/Electrobun.
3. Add `@PluginMethod` + implementation in `android/.../LocationPlugin.kt`.
4. Add `@objc` method + `CAPPluginMethod` entry in `ios/.../LocationPlugin.swift`.
5. Re-run `bun run --cwd plugins/plugin-native-location build`.

### Add a new event

1. Define an event payload interface in `src/definitions.ts`.
2. Add the `addListener` overload to `LocationPlugin` interface.
3. Call `this.notifyListeners("eventName", payload)` in `web.ts`.
4. Call `notifyListeners("eventName", data: ...)` in Swift and `notifyListeners("eventName", obj)` in Kotlin.

## Conventions / gotchas

- **Capacitor bridge, not elizaOS Plugin object.** Do not look for `actions`, `providers`, or `services` — this package does not export any. It integrates with Capacitor, not the elizaOS agent runtime directly.
- **`@capacitor/core` is a peer dep.** The Capacitor version in the host app must be `^8.3.1`. Do not bundle it.
- **Web permission flow is implicit.** `requestPermissions()` on web calls `getCurrentPosition` internally to trigger the browser permission prompt — there is no direct Permissions API call for geolocation.
- **Android background location is Android 10+ only.** The `background` field in `LocationPermissionStatus` is only populated on API 29+; earlier versions mirror the foreground state.
- **iOS accuracy mapping.** `"high"` maps to `kCLLocationAccuracyNearestTenMeters` (not `kCLLocationAccuracyBest`). Only `"best"` gives `kCLLocationAccuracyBest`.
- **Watch IDs are not integers.** Android uses UUID strings; web uses a prefixed timestamp string. Always treat watchId as an opaque string.
- **Build requires native toolchains.** TypeScript builds with `bun run build`; native iOS/Android code is compiled by Xcode / Gradle during host app builds, not here.
- **`docgen` regenerates README.md.** If you run `bun run build:docs` or `bun run docgen`, README.md is overwritten from JSDoc in `definitions.ts`. Keep JSDoc accurate.
