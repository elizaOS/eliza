# Issue 9967: Android native plugin x WebView smoke

Date: 2026-06-30 UTC / 2026-06-29 Pacific

Device:

- Pixel 6a, `ANDROID_SERIAL=27051JEGR10034`
- Installed package: `ai.elizaos.app`
- Debug APK built from this branch with `ELIZA_WEBVIEW_DEBUG=1` and installed
  with `adb install -r -d`.

Commands run:

```bash
ELIZA_MOBILE_REPO_ROOT=/home/shaw/milady/eliza-local-integration \
ELIZA_WEBVIEW_DEBUG=1 \
ELIZA_BUN_RISCV64_OPTIONAL=1 \
ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 \
  bun run --cwd packages/app build:android

adb -s 27051JEGR10034 install -r -d \
  packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk

ELIZA_API_PORT=31337 ELIZA_PAIRING_DISABLED=1 \
  node packages/app-core/scripts/run-node-tsx.mjs \
  packages/app-core/scripts/serve-real-local-agent.ts

ANDROID_SERIAL=27051JEGR10034 \
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:native-plugin-view
```

Result:

- Playwright Android WebView spec passed: `1 passed`.
- `native-plugin-result.json` shows `platform: "android"`,
  `pluginAvailable: true`, `status.packageName: "ai.elizaos.app"`, Android role
  rows from `RoleManager`, and the native-only `voiceCall` volume stream.
- `webview-console.log` shows the JavaScript side calling
  `ElizaSystem.getStatus` and `ElizaSystem.getDeviceSettings`, plus native
  results.
- `logcat.txt` shows Capacitor dispatching both calls to native Android:
  `pluginId: ElizaSystem, methodName: getStatus` and
  `pluginId: ElizaSystem, methodName: getDeviceSettings`.

Artifacts:

- `device-and-build.txt` - device list, installed package timestamp, debug flag,
  APK path, and APK SHA-256.
- `native-plugin-result.json` - structured result asserted by the test.
- `webview-console.log` - WebView console/native bridge transcript.
- `logcat.txt` - Android logcat around the run.
- `native-plugin-device.png` - physical device screenshot captured during the
  run. The screen was secure/black on this Pixel, but the screenshot proves the
  device capture path executed.
- `native-plugin-view-smoke.mp4` - physical device screenrecord captured during
  the run.

Manual review:

- Read `native-plugin-result.json`: the result is impossible for the web shim
  (`packageName` would be `web`, roles would be empty, and `voiceCall` is absent
  from the shim).
- Read `webview-console.log` and `logcat.txt`: both show the exact native plugin
  method names and returned Android values.
- Opened `native-plugin-device.png`: the physical display was black/secure
  during capture, so visual proof is secondary to the native JSON/log evidence.
