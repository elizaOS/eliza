# #9943 Android sleep/wake lifecycle evidence

Date: 2026-07-01 (captured 2026-06-30 21:25 PDT)

Device: `emulator-5556`

Attached physical device: Pixel 6a `27051JEGR10034` was connected, but Android reported `showing=true`, `inputRestricted=true`, and `mDreamingLockscreen=true`; it could not be used for an interactive WebView lifecycle capture without unlocking the secure keyguard.

APK: `/home/shaw/eliza/eliza-wt-pr-10641-pixel/packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk`

Host backend: `http://127.0.0.1:31337/api/health` returned `ready:true`.

Branch/base at capture: `fix/9943-android-sleep-wake` on `origin/develop` `ee6669565e`.

Build and install:

```bash
ELIZA_MOBILE_REPO_ROOT=/home/shaw/eliza/eliza-wt-pr-10641-pixel \
ELIZA_WEBVIEW_DEBUG=1 \
ELIZA_BUN_RISCV64_OPTIONAL=1 \
node packages/app-core/scripts/run-mobile-build.mjs android-cloud-debug

adb -s emulator-5556 install -r -d \
  packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk

adb -s emulator-5556 shell pm clear ai.elizaos.app
adb -s emulator-5556 reverse tcp:31337 tcp:31337
```

Command:

```bash
ANDROID_SERIAL=emulator-5556 \
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
bun run --cwd packages/app test:e2e:android:sleep-wake
```

Result: `1 passed (25.1s)`.

Artifacts:

- `sleep-wake-report.json` — lifecycle event report (`eliza:app-pause` then `eliza:app-resume`, final `document.visibilityState=visible`, no page errors).
- `sleep-wake-before.png` / `sleep-wake-after.png` — full-device screenshots before sleep and after wake.
- `sleep-wake.mp4` — Android screenrecord captured during the sleep/wake run.
- `sleep-wake-logcat.txt` — logcat snapshot from the passing run.
- `android-package.txt` — installed package metadata from the tested app.

Notes:

- The test was run from a fresh app state after `adb -s emulator-5556 shell pm clear ai.elizaos.app`; the harness drove first-run through the remote-runtime deep link before sleeping/waking the app.
- The Android smoke passed after building and installing the current tree; root verification status is tracked in the PR checklist/comment.
