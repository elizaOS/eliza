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
    web.test.ts        — Vitest unit tests for the LocationWeb browser implementation
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

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-location clean           # remove build output
bun run --cwd plugins/plugin-native-location build           # build package artifacts
bun run --cwd plugins/plugin-native-location build:docs      # generate docs and build artifacts
bun run --cwd plugins/plugin-native-location typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-location lint            # mutating Biome check
bun run --cwd plugins/plugin-native-location lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-location format          # write formatting
bun run --cwd plugins/plugin-native-location format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-location test            # run package tests
bun run --cwd plugins/plugin-native-location prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-location build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
bun run --cwd plugins/plugin-native-location docgen          # docgen --api LocationPlugin --output-readme README.md --output-json dist/docs.json
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

- **Instrumented test (issue #9967).** The fused current-location fetch (accuracy→Priority map, `CurrentLocationRequest` build, `getCurrentLocation`/`requestLocationUpdates`) lives in `LocationFixReader`; `LocationPlugin` delegates to it (JS shape unchanged) so an on-device `androidTest` can drive the real Play Services provider without a `Bridge`/`Activity`. The fix test `Assume`-skips when no GPS/network fix is obtainable (e.g. a headless emulator whose GNSS HAL emits nothing for `geo fix`).
- **Capacitor bridge, not elizaOS Plugin object.** Do not look for `actions`, `providers`, or `services` — this package does not export any. It integrates with Capacitor, not the elizaOS agent runtime directly.
- **`@capacitor/core` is a peer dep.** The Capacitor version in the host app must be `^8.3.1`. Do not bundle it.
- **Web permission flow is implicit.** `requestPermissions()` on web calls `getCurrentPosition` internally to trigger the browser permission prompt — there is no direct Permissions API call for geolocation.
- **Android background location is a separate permission on Android 10+.** On API 29+ the `background` field in `LocationPermissionStatus` reflects the distinct `ACCESS_BACKGROUND_LOCATION` grant; earlier versions mirror the foreground state.
- **iOS accuracy mapping.** `"high"` maps to `kCLLocationAccuracyNearestTenMeters` (not `kCLLocationAccuracyBest`). Only `"best"` gives `kCLLocationAccuracyBest`.
- **Watch IDs are not integers.** Android and iOS both use UUID strings; web uses a prefixed timestamp string. Always treat watchId as an opaque string.
- **Instrumented test (issue #9967).** Android fused-fix, permission/provider reads, and result shaping live in `LocationFixReader`, so they can be exercised on a real device/emulator via `./gradlew :elizaos-capacitor-location:connectedDebugAndroidTest` without a Capacitor `Bridge`/WebView. `LocationPlugin` delegates to the reader where it preserves the unchanged JS shape; the foreground permission field still comes from Capacitor `getPermissionState("location")` so the `"prompt"` state survives.
- `LocationFixReader.readForegroundPermissionStatus(activity)` is an Activity-aware tri-state (`granted | denied | prompt`) read used only by the instrumented test + showcase Activity (which have an `Activity`); a never-asked permission reports `"prompt"` (via `shouldShowRequestPermissionRationale`, mirroring iOS `.notDetermined`), never `"denied"`. Production still sources the JS `location` field from Capacitor's `getPermissionState`.
- **Build requires native toolchains.** TypeScript builds with `bun run build`; native iOS/Android code is compiled by Xcode / Gradle during host app builds, not here.
- **`docgen` regenerates README.md.** If you run `bun run build:docs` or `bun run docgen`, README.md is overwritten from JSDoc in `definitions.ts`. Keep JSDoc accurate.

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
