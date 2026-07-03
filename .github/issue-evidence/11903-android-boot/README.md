# Issue 11903 Android boot evidence

Captured on 2026-07-03 from device `27051JEGR10034` using the debug APK at
`packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk`.

## Build

- `bun run --cwd packages/agent build:mobile`
  - `agent-bundle.js`: 28.82 MB
  - `agent-deferred.js`: 15.80 MB
  - Mobile load smoke passed.
- `ANDROID_SERIAL=27051JEGR10034 ELIZA_MOBILE_REPO_ROOT=/tmp/eliza-11903-android-boot ELIZA_WEBVIEW_DEBUG=1 ELIZA_BUN_RISCV64_OPTIONAL=1 ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 bun run --cwd packages/app build:android`
  - APK build and artifact audit passed.
- `ANDROID_SERIAL=27051JEGR10034 bun run --cwd packages/app install:android:adb -- --apk /tmp/eliza-11903-android-boot/packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk`
  - On-device APK SHA matched the local APK (`d36dc0b8650c...`).

## Device boot capture

- `boot-timing.txt`: forwarded `/api/health` returned ready after 20,166 ms.
- `health-ready.json`: backend reported `ready: true`, `runtime: ok`, `database: ok`, `plugins.loaded: 9`, `plugins.failed: 0`, `agentState: running`.
- `logcat.txt` / `logcat-late.txt`: Android service and renderer logs, with local bearer tokens redacted.
- `device-final.png` / `device-final-late.png`: screenshots captured from the same run.

## Caveat

This APK was built with `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1` because the local
workspace did not have an Android arm64 fused inference library staged for
`:app:copyForkLlamaLib`. The capture proves the Android staged JS bundle
extracts, evaluates, binds the API, and reaches backend ready. It does not prove
full local model inference or final UI readiness: `/api/status` reports
`state: "running"` and `canRespond: false`, while the WebView eventually renders
the startup-error screen after native-bridge requests report local-agent
unavailable.
