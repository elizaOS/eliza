# #10197 — on-device JS-heap soak across background/foreground cycles

A small stability cell the in-flight PRs (#10397 restart recovery, #10480
watchdog) don't cover: does the app's JS heap stay bounded when it is repeatedly
backgrounded and foregrounded? Driven against the **real running app**
(`ai.elizaos.app`, API-34 emulator, WebView attached over CDP-via-adb). Each
cycle: `KEYCODE_HOME` (background) → `am start … -f REORDER_TO_FRONT`
(foreground, no WebView reload), then sample `performance.memory.usedJSHeapSize`.

## Result — heap stays bounded (no leak)

Two runs (the shared emulator was being actively churned by a concurrent session,
which repeatedly uninstalled/relaunched the app and cost the longer run its CDP
connection mid-soak — hence two partial captures rather than one long one):

```
run A (6 cycles):  baseline 35.57 MB → 35.57 … → 33.47 MB   net −2.1 MB (0.94×)
run B (6 cycles):  baseline 26.32 MB → 26.32 … → 35.57 MB   then connection lost
```

Across both, `usedJSHeapSize` stays in a ~26–36 MB band with no monotonic growth
— the background/foreground lifecycle path does **not** leak JS heap. Native
`dumpsys meminfo` at the start of run B: `TOTAL PSS 176 MB / TOTAL RSS 280 MB`.

## Harness

`cdp-bg-memory-soak.mjs` — reusable: forwards the app's `webview_devtools_remote`
socket, cycles background/foreground N times, samples the JS heap each cycle, and
flags >50% net growth as a possible retained-on-background leak. Runs against the
installed APK with no rebuild (`CYCLES=N ANDROID_SERIAL=<dev> bun cdp-bg-memory-soak.mjs`).

## Caveat

Measured on the prebuilt `app-debug.apk` (which predates the #10472
visibility-driven `APP_PAUSE` view-prune), so this is the **baseline** behavior:
the heap is already bounded without that prune in this scenario, which is honest
context for #10472 (the prune reclaims memory on background but its absence does
not cause a runaway leak here). Clean, longer soaks need an uncontended
device/emulator.
