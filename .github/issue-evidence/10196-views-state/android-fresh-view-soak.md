# Android Fresh View-Runtime Soak

Issue: #10196

Command:

```bash
ELIZA_MOBILE_REPO_ROOT=/home/shaw/milady/eliza \
ELIZA_WEBVIEW_DEBUG=1 \
ELIZA_BUN_RISCV64_OPTIONAL=1 \
bun run --cwd packages/app build:android

ANDROID_SERIAL=emulator-5556 \
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
ELIZA_ANDROID_VIEW_SOAK_ROUNDS=4 \
bun run --cwd packages/app test:e2e:android:view-runtime-soak
```

Device/runtime:

- Android emulator: `emulator-5556`
- Package: `ai.elizaos.app`
- Backend: deterministic host agent at `http://127.0.0.1:31337` via `adb reverse`
- Fresh WebView-debuggable APK built from the eliza checkout

Result:

- 15 registered views enumerated from `/api/views`
- 60 real WebView activations
- View-runtime telemetry: `0 -> 115` events, including 112 `show` events
- Module-cache telemetry: 52 events, 52 evictions
- Worst per-view render count: 1
- Heap stayed bounded: 42.1 MB warm -> 42.1 MB end, ratio 1.00
- Page errors: 0

Artifacts:

- `android-fresh-view-soak.json` - machine-readable run report
- `android-fresh-view-soak.mp4` - screen recording of the device run
- `android-fresh-view-01-tutorial.png` through `android-fresh-view-04-character.png` - first-pass view screenshots
- `android-fresh-view-soak-final.png` and `android-fresh-device-final.png` - final WebView/device screenshots
- `android-fresh-package.txt` - installed package metadata
- `android-fresh-logcat.txt` - logcat tail from the run
