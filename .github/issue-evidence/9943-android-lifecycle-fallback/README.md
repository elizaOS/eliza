# #9943 — Android app pause/resume lifecycle is silently broken; visibilitychange fallback

## On-device finding (API-34 emulator, `ai.elizaos.app` real WebView via CDP-over-adb)

`mobile-lifecycle.ts` derives the app's `eliza:app-pause` / `eliza:app-resume`
events **solely** from the Capacitor `@capacitor/app` `appStateChange` listener.
Those events drive real work — e.g. `retained-lazy.tsx` prunes backgrounded
views to reclaim memory on `APP_PAUSE_EVENT`.

Driving the **real running app** over CDP (install a `document` observer for the
app's lifecycle events + a direct Capacitor `App.addListener("appStateChange")` +
raw `visibilitychange`, then background via `KEYCODE_HOME` and foreground), with
the app confirmed foreground first (`topResumedActivity`):

```
direct Capacitor appStateChange (isActive) events: []          <- appStateChange SILENT
raw document.visibilitychange states: ["hidden","visible"]     <- visibilitychange RELIABLE
app eliza:app-pause/resume events recorded: []                 <- app lifecycle DEAD on background
```

(Under load / plugin-load contention the Capacitor `App` plugin even reports
`"App" plugin is not implemented on android`, in which case the listener never
registers at all — the app already *catches* this via
`logNativePluginUnavailable("App", …)` but does nothing to recover.)

**Conclusion:** real Android backgrounding reliably emits
`document.visibilitychange` (`hidden`/`visible`) while Capacitor `appStateChange`
is unreliable/silent on this surface — so the app's pause/resume lifecycle (and
the memory-reclaiming view-prune it drives) does **not run** on Android
backgrounding. `visibilitychange` is the W3C-standard signal that fires on every
surface (web, desktop, iOS/Android WebView).

## Second finding — `@capacitor/network` is absent on Android; `online`/`offline` is reliable

The **same fragility** lives in `initializeNetworkListener`, which drives
`NETWORK_STATUS_CHANGE_EVENT` (the WebSocket reconnect scheduler consumes it to
stop burning backoff in airplane mode) **solely** from `@capacitor/network`,
with no web fallback. Toggling connectivity (`svc wifi/data off`/`on`) on-device
(`cdp-network-probe.txt`):

```
init: { hasNetworkPlugin: false, capacitorGetStatus: "no-plugin" }   <- Network plugin ABSENT from the bridge
window online/offline events: ["offline","online"]                  <- window online/offline RELIABLE
Capacitor networkStatusChange (connected) events: []                <- Capacitor never fires
```

So on Android, `NETWORK_STATUS_CHANGE_EVENT` never fires on a connectivity change.

## Fix

`packages/app/src/mobile-lifecycle.ts` — two symmetric fallbacks:

1. Derive pause/resume from `document.visibilitychange` (App-plugin-independent),
   **deduped** with `appStateChange` via a single `setAppActive` transition gate.
2. Derive connectivity from `window` `online`/`offline` (Network-plugin-
   independent), **deduped** with `networkStatusChange` via a single
   `setConnected` transition gate.

Both fallback handlers are registered idempotently at module scope so re-init /
HMR can't leak a second listener. `visibilitychange` and `online`/`offline` are
W3C-standard signals that fire on every surface (web/desktop/iOS/Android WebView).

## Verification

- **Unit** (`packages/app/test/mobile-lifecycle.test.ts`, **14/14 pass**): new
  cases assert `visibilitychange → hidden` ⇒ `APP_PAUSE_EVENT`, `→ visible` ⇒
  `APP_RESUME_EVENT`, `window offline/online` ⇒ `NETWORK_STATUS_CHANGE_EVENT`,
  and that each native+web signal pair reporting the same transition dispatches
  **once** (dedup).
- **On-device** (`cdp-lifecycle-probe.txt`, `cdp-lifecycle-probe.mjs`): proves
  `visibilitychange` fires on real Android backgrounding while `appStateChange`
  does not. `app-running-emulator.png` is the running app.
- **Caveat (honest):** the end-to-end *fixed* behavior could not be captured
  on-device because `build:android` is currently broken on this host
  (`@tailwindcss/vite` missing + an eliza/Milady workspace path crossover), so a
  fresh APK carrying this change can't be produced here. The probe runs against
  the prebuilt APK (old lifecycle), which is why it shows the **broken** state;
  the unit test proves the new handler dispatches the events, and the probe
  proves the `visibilitychange` signal it relies on fires on-device.
