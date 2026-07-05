# Device failure forensics evidence for #14338

Host: `BEAST`
Device: Pixel 6a `27051JEGR10034`
Date: July 5, 2026

## Focused validation

```text
$ bun run --cwd packages/app test -- scripts/device-e2e-bundle.test.mjs scripts/ios-e2e-lib.test.mjs
Test Files  2 passed (2)
Tests       48 passed (48)
```

```text
$ bunx @biomejs/biome check packages/app/scripts/lib/device-e2e-bundle.mjs packages/app/scripts/device-e2e-bundle.test.mjs packages/app/scripts/android-e2e.mjs packages/app/scripts/ios-e2e.mjs
Checked 4 files in 39ms. No fixes applied.
```

```text
$ node --check packages/app/scripts/lib/device-e2e-bundle.mjs
$ node --check packages/app/scripts/android-e2e.mjs
$ node --check packages/app/scripts/ios-e2e.mjs
```

## Real Android failure run

Command:

```text
$ node scripts/android-e2e.mjs --no-emulator-boot --skip-local-chat --output /tmp/eliza-14338-android-forensics
```

The run failed during the APK build on this host's known missing fused inference
library, then captured the attached device's screen and logcat before exiting.

```text
[android-e2e] wrote Android screenshot: /tmp/eliza-14338-android-forensics/failure/build-android-apk/screen.png
[android-e2e] wrote Android logcat: /tmp/eliza-14338-android-forensics/failure/build-android-apk/logcat.txt
[android-e2e] wrote Android screenshot: /tmp/eliza-14338-android-forensics/raw/android-final.png
[android-e2e] wrote Android logcat: /tmp/eliza-14338-android-forensics/logs/android-logcat.txt
[android-e2e] device lease released: android:27051JEGR10034
[android-e2e] bundle: /tmp/eliza-14338-android-forensics
EXIT_STATUS=1
```

Bundle files:

```text
/tmp/eliza-14338-android-forensics/failure/build-android-apk/failure-cause.txt
/tmp/eliza-14338-android-forensics/failure/build-android-apk/logcat.txt
/tmp/eliza-14338-android-forensics/failure/build-android-apk/screen.png
/tmp/eliza-14338-android-forensics/inline/android-final.jpg
/tmp/eliza-14338-android-forensics/inline/screen.jpg
/tmp/eliza-14338-android-forensics/junit.xml
/tmp/eliza-14338-android-forensics/logs/android-logcat.txt
/tmp/eliza-14338-android-forensics/logs/runner.log
/tmp/eliza-14338-android-forensics/raw/android-final.png
/tmp/eliza-14338-android-forensics/summary.json
```

Committed artifacts:

- `.github/issue-evidence/14338-device-failure-forensics.jpg`
- `.github/issue-evidence/14338-device-failure-forensics-summary.json`

## Compact stderr block

The full build log is too large for a readable PR transcript, so this fast
SDK-resolution failure verifies the final compact stderr block shape:

```text
$ HOME=/tmp/eliza-empty-home PATH=/tmp/eliza-empty-path ANDROID_HOME=/tmp/nope ANDROID_SDK_ROOT=/tmp/nope ADB=/tmp/nope/adb node scripts/android-e2e.mjs --no-emulator-boot --skip-build --skip-local-chat --output /tmp/eliza-14338-fast-forensics

DEVICE E2E FAILURE FORENSICS
step: resolve Android SDK
cause: adb not found. Install Android SDK platform-tools or set ANDROID_HOME / ANDROID_SDK_ROOT / ADB so adb is resolvable.
failureDir: /tmp/eliza-14338-fast-forensics/failure/resolve-android-sdk
artifacts:
  - /tmp/eliza-14338-fast-forensics/failure/resolve-android-sdk/failure-cause.txt
[android-e2e] bundle: /tmp/eliza-14338-fast-forensics
[android-e2e] FAILED: adb not found. Install Android SDK platform-tools or set ANDROID_HOME / ANDROID_SDK_ROOT / ADB so adb is resolvable.
EXIT_STATUS=1
```
