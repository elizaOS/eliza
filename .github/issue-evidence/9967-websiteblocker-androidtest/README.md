# Issue #9967: websiteblocker Android native test evidence

Date: 2026-06-30

Branch: `fix/9967-websiteblocker-androidtest`

## Validation commands

```bash
bun run install:light
bun run --cwd plugins/plugin-native-websiteblocker test
bun run --cwd plugins/plugin-native-websiteblocker build
packages/app-core/platforms/android/gradlew -p packages/app-core/platforms/android :elizaos-capacitor-websiteblocker:assembleDebugAndroidTest
packages/app-core/platforms/android/gradlew -p packages/app-core/platforms/android :elizaos-capacitor-websiteblocker:connectedDebugAndroidTest
```

The connected test run executed 4 instrumented tests on each device:

- Pixel 6a, Android 16/API 36, serial `27051JEGR10034`
- Android emulator, Android 14/API 34, serial `emulator-5554`

## Artifacts

- `android-test-results/`: Gradle connected test XML, per-test logcat, and UTP device logs copied from `plugins/plugin-native-websiteblocker/android/build/outputs/androidTest-results/connected/debug/`.
- `device-info.txt`: attached device list, model/API metadata, and screen size.
- `pixel-6a-showcase.png` / `pixel-6a-showcase.mp4`: physical Pixel 6a rendering the persisted website-blocking policy.
- `emulator-showcase.png` / `emulator-showcase.mp4`: Android emulator rendering the same state.

The showcase does not start the VPN service or intercept device traffic. It proves the native policy store and DNS blocking decision logic using the same persisted `WebsiteBlockerStateStore` policy that the VPN tunnel consumes.
