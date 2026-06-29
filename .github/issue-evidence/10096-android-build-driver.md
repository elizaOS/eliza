# 10096 Android Build Driver

## Change

- Extracted the Android mobile build variants in `packages/app-core/scripts/run-mobile-build.mjs` into `ANDROID_BUILD_TARGETS` plus `runAndroidBuild(target, opts)`.
- Kept each target's real source-strip/source-audit/artifact-audit functions in place; only the duplicated orchestration spine and Gradle command construction moved behind the shared driver.
- Moved the pure Android Gradle argument builder to `packages/app-core/scripts/mobile/android-gradle.mjs`.
- Moved the Android build target table and target-name resolution to `packages/app-core/scripts/mobile/targets/android.mjs`, with data-only phase keys mapped back to the existing driver functions.
- Added `packages/app-core/scripts/run-mobile-build-android-targets.test.mjs` for the target table and Gradle command contracts.

## Verification

- `node --check packages/app-core/scripts/run-mobile-build.mjs && node --check packages/app-core/scripts/mobile/android-gradle.mjs && node --check packages/app-core/scripts/mobile/targets/android.mjs && node --check packages/app-core/scripts/run-mobile-build-android-targets.test.mjs`
- `bunx biome check packages/app-core/scripts/run-mobile-build.mjs packages/app-core/scripts/run-mobile-build-android-targets.test.mjs packages/app-core/scripts/mobile/android-gradle.mjs packages/app-core/scripts/mobile/targets/android.mjs .github/issue-evidence/10096-android-build-driver.md`
- `bun run --cwd packages/app-core test -- scripts/run-mobile-build-android-targets.test.mjs scripts/run-mobile-build-ios-engine-gate.test.mjs`
- `bun test packages/app-core/scripts/run-mobile-build-android-targets.test.mjs packages/app-core/scripts/run-mobile-build-android-app-actions.test.mjs packages/app-core/scripts/run-mobile-build-ios-engine-gate.test.mjs packages/app-core/scripts/run-mobile-build-brand-separation.test.mts`
- `node packages/app-core/scripts/run-mobile-build.mjs android-cloud-debug`

## Native Android Evidence

- Real build command: `node packages/app-core/scripts/run-mobile-build.mjs android-cloud-debug`
- Workspace dependency build completed: `113 successful, 113 total`.
- Final post-split renderer build completed and wrote `eliza-renderer-build.json buildId=6d944ac02d7b`.
- The new driver reached Gradle with `android-cloud pre-gradle audit passed`.
- Gradle metadata task completed: `:capacitor-cordova-android-plugins:writeDebugAarMetadata` with `BUILD SUCCESSFUL`.
- Gradle APK task completed: `:app:assembleDebug` with `BUILD SUCCESSFUL`.
- Post-build checks completed: `android-cloud post-gradle audit passed` and `android-cloud artifact audit passed`.
- APK produced at `packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk`, size `60M`, sha256 `081579685d3bc776ea62b0870b2ed6009144953bcfa63925b41d1f9750c33ba3`.

## Emulator Evidence

- AVD booted: `Pixel_API_35`.
- APK installed with `adb install -r packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk` (`Success`).
- Explicit launch command: `adb shell am start -W -n ai.elizaos.app/.MainActivity`.
- Activity proof: `.github/issue-evidence/10096-android-cloud-debug-emulator-activity-after-wait.txt` shows `topResumedActivity=ActivityRecord{753a214 u0 ai.elizaos.app/.MainActivity t34}`.
- Screenshot manually reviewed: `.github/issue-evidence/10096-android-cloud-debug-emulator-after-wait.png` shows the Eliza pairing screen on the emulator.
- Logcat tail captured: `.github/issue-evidence/10096-android-cloud-debug-emulator-after-wait.log`.

## Not Covered

- `android`, `android-cloud` release AAB, `android-sms-gateway`, and `android-system` full Gradle builds were not run in this slice; their Gradle argument contracts are covered by the new unit test and the shared `android-cloud-debug` build exercised the extracted driver through a real APK build and emulator launch.
