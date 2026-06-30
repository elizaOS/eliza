# #10196 — on-device Android verification (Pixel 6a + emulator)

On-device companion to the desktop `audit:views` soak. The view-lifecycle /
heap-accounting work in this issue ships in the Android app
(`ai.elizaos.app`, Capacitor WebView), so this records what was verified on a
real Android runtime and — honestly — what was blocked and why.

## Devices

| device | result |
|---|---|
| Pixel 6a (physical, Android 16) | **locked (biometric)** — screen can't be unlocked without the owner, so no visual capture. Its WebView CDP socket is suspended while locked. |
| `emulator-5554` (2 GB RAM) | app **OOM-crashes ~8 s after launch** (`ActivityManager: Process ai.elizaos.app … has died: fg TOP`) — too little RAM for the WebView + native libs. |
| `emulator-5556` | **stable** — used for the capture below. |

## What was verified on-device (via WebView CDP — Chrome/113, `ai.elizaos.app`)

- **The app boots and renders on Android** — onboarding (`android-02-onboarding.png`) and the dashboard home (`android-01-dashboard.png`, `https://localhost/chat`, "Good night · 74°F Clear · Brooklyn · ask me anything").
- **`/api/views` enumerates the full catalog on-device** — 15 views (7 `system`, 5 `preview`, 3 `developer`); see `android-cdp-drain.json`.
- **Real view navigation works on-device** — dispatching the app's own `eliza:navigate:view` CustomEvent drove the WebView route `/ → /apps/plugins → /apps/files → /settings` (`android-03-view-nav.png`, `android-views-screenrecord.mp4`).
- **Live heap accounting works on the Android WebView** — `performance.memory.usedJSHeapSize` reads real bytes (33–40 MB used / 1130 MB limit). This is the exact signal the #10196 eviction layer (`bounded-view-lru.ts` `resolveHeapUsage` / `HEAP_PRESSURE_RATIO`) consumes — confirmed functional on Android, not just Chromium-desktop.

## What was blocked (honestly)

The full instrumented telemetry soak (non-zero `__ELIZA_VIEW_RUNTIME_TELEMETRY__` /
`__ELIZA_MODULE_CACHE_TELEMETRY__` ring drains) did **not** reproduce on-device,
for two environmental reasons — neither a defect in the #10196 code:

1. **The installed APK predates this instrumentation.** The emulator's
   `ai.elizaos.app` was installed before `KeepAliveViewHost` /
   `ViewTelemetryProfiler` / the seeded module-cache ring merged. Navigation
   changes the route but the older `ViewRouter` doesn't emit the new per-view
   telemetry. A Capacitor app bakes the web bundle into the APK at build time, so
   only a **fresh `build:android` from current `develop`** carries the
   instrumentation.
2. **No dedicated agent on the device.** Deeper views fall back to "Connect your
   own agent" (`http://127.0.0.1:31337`, no agent on the emulator). The host has a
   live agent, but pointing the emulator at it (`adb reverse`) was deliberately
   **not** done — it would risk sending actions to a real running instance.

## To complete on-device (CI / ops)

`build:android` from `develop` → install on `emulator-5556` (or an unlocked
device) → start a dedicated local agent → re-run the CDP soak above. The harness,
the navigation channel, the catalog enumeration, and the heap signal are all
verified working on Android; the remaining gap is shipping the instrumented
bundle + a connected agent onto the device.
