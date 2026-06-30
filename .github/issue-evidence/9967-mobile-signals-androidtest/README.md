# Issue #9967: mobile-signals Android native reader evidence

Date: 2026-06-30

Branch: `fix/9967-mobile-signals-androidtest`

## Validation commands

```bash
bun run install:light
bun run --cwd plugins/plugin-native-mobile-signals test
bun run --cwd plugins/plugin-native-mobile-signals build
packages/app-core/platforms/android/gradlew -p packages/app-core/platforms/android :elizaos-capacitor-mobile-signals:assembleDebugAndroidTest
packages/app-core/platforms/android/gradlew -p packages/app-core/platforms/android :elizaos-capacitor-mobile-signals:connectedDebugAndroidTest
```

The final connected test run executed 4 instrumented tests on each device:

- Pixel 6a, Android 16/API 36, serial `27051JEGR10034`
- Android emulator, Android 14/API 34, serial `emulator-5554`

## Artifacts

- `android-test-results/`: Gradle connected test XML, per-test logcat, and UTP device logs copied from `plugins/plugin-native-mobile-signals/android/build/outputs/androidTest-results/connected/debug/`.
- `device-and-appops.txt`: attached device list, model/API metadata, screen size, and `GET_USAGE_STATS: allow` app-op state for the showcase package.
- `pixel-6a-showcase.png` / `pixel-6a-showcase.mp4`: physical Pixel 6a rendering the native reader output over the locked screen.
- `emulator-showcase.png` / `emulator-showcase.mp4`: Android emulator rendering the same native reader output.

The showcase intentionally displays only aggregate status/count fields. It does not expose raw foreground app package names from UsageStats in the captured artifacts.
