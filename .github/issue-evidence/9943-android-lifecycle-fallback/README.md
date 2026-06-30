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

## Root cause — an intermittent Capacitor `PluginLoadException` kills the whole plugin set

The app's boot logcat (`boot-logcat-pluginload.txt`) explains *why* App and Network
are unavailable. On **5 of 6 cold boots**:

```
E Capacitor: Error loading plugins.
E Capacitor: PluginLoadException: Could not find class by class path:
             io.ionic.backgroundrunner.plugin.BackgroundRunnerPlugin
    at PluginManager.loadPluginClasses ... BridgeActivity.onCreate
```

Capacitor's `loadPluginClasses` aborts the **entire** plugin-load loop on the
first class it can't resolve (`@capacitor/background-runner`), so after that only
the 9 plugins registered before it survive — **App, Network, and every
`@elizaos/capacitor-*` native plugin never register that session**. (On the rare
clean boot all ~25 register, which is why the CDP probes above were
inconsistent.) Diagnosing why background-runner's class intermittently fails to
load (it's a Rust/QuickJS-backed plugin) and fixing it at the source needs a
working `build:android` — broken on this host — so it is flagged here for the
maintainers rather than guessed at.

**This is exactly why the fallbacks below are the right fix, not belt-and-
suspenders:** on most app starts the Capacitor `App`/`Network` plugins are simply
not present, and the app's pause/resume + connectivity lifecycle must not depend
on a plugin set that fails to load on 5 of 6 boots. The W3C `visibilitychange`
and `online`/`offline` signals are independent of Capacitor and always fire.

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

- **Unit** (`packages/app/test/mobile-lifecycle.test.ts`, **15/15 pass**): new
  cases assert `visibilitychange → hidden` ⇒ `APP_PAUSE_EVENT`, `→ visible` ⇒
  `APP_RESUME_EVENT`, `window offline/online` ⇒ `NETWORK_STATUS_CHANGE_EVENT`,
  and that each native+web signal pair reporting the same transition dispatches
  **once** (dedup).
- **On-device** (`cdp-lifecycle-probe.txt`, `cdp-lifecycle-probe.mjs`): proves
  `visibilitychange` fires on real Android backgrounding while `appStateChange`
  does not. `app-running-emulator.png` is the running app.
- **Biome**:
  `bunx @biomejs/biome check packages/app/src/mobile-lifecycle.ts packages/app/src/main.tsx packages/app/test/mobile-lifecycle.test.ts`
  passed.
- **Package builds**:
  `bun run --cwd packages/core prebuild`,
  `bun run --cwd packages/core build:node`, and
  `bun run --cwd packages/app-core build` passed.
- **Full Android build caveat (honest):**
  `bun run --cwd packages/app build:android` still fails before APK packaging on
  this host because the generated Gradle task requires a configured/pre-staged
  fused arm64 inference lib:
  `[copyForkLlamaLib] no fused inference lib for arm64-v8a ... set -Peliza.mtp.android.libdir / ELIZA_MTP_ANDROID_LIBDIR`.
  That is outside this lifecycle fix; it prevents claiming a full
  inference-capable Android APK here.
- **Smoke Android APK**:
  `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 bun run --cwd packages/app build:android`
  produced
  `packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
  The smoke APK was installed on the API-34 emulator and launched as
  `ai.elizaos.app/.MainActivity`.
- **Fixed on-emulator lifecycle probe**:
  `cdp-lifecycle-probe-fixed-smoke-2.txt` was captured from the smoke APK over
  the real app WebView:

  ```
  observer install: {"observersInstalled":true,"hasCapacitor":true,"capPlatform":"android","hasAppPlugin":true,"directListener":true,"href":"https://localhost/"}
  direct Capacitor appStateChange (isActive) events: [false,true]
  raw document.visibilitychange states: ["hidden","visible"]
  app eliza:app-pause/resume events recorded: ["pause","resume"]
  RESULT: pause=true resume=true
  ```

  `fixed-smoke-app-running-emulator.png` is the fixed smoke APK running on the
  emulator immediately after the successful probe.
