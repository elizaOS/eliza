# #9967 Swabble Android Instrumented Test Evidence

## Scope

Adds on-device Android coverage for `@elizaos/capacitor-swabble` platform probes:

- microphone permission result
- Android `SpeechRecognizer` availability
- real `AudioManager.GET_DEVICES_INPUTS` enumeration

The final rebased connected run also includes the existing Swabble Android
config instrumented tests from `develop`, for 7 tests per attached device.

## Validation

Commands run from `/home/shaw/eliza/eliza-wt-9967-network-policy`:

- `bun run install:light`
- `bun run --cwd plugins/plugin-native-swabble test`
- `bun run --cwd plugins/plugin-native-swabble build`
- `./gradlew :elizaos-capacitor-swabble:connectedDebugAndroidTest`

Android command run from `packages/app-core/platforms/android`.

## Devices

- Pixel 6a physical device, Android 16/API 36, serial `27051JEGR10034`
- JejuWallet_Pixel6 AVD, Android 14/API 34, serial `emulator-5554`

## Artifacts

- `android-test-results/` - Gradle connected test XML, UTP logs, per-test logcat, device info.
- `android-test-report/` - Gradle connected test HTML report.
- `pixel-6a-showcase.png` / `pixel-6a-showcase.mp4` - physical device capture of the live test-only probe activity.
- `emulator-showcase.png` / `emulator-showcase.mp4` - emulator capture of the live test-only probe activity.
- `pixel-6a-device.txt` / `emulator-device.txt` - device model, Android version, and installed test package permission metadata.

Model trajectories are N/A: this change covers a native Android Capacitor bridge probe and does not call an LLM.
