# Issue #10197 Android Watchdog Policy Evidence

Change under test: Android `ElizaAgentService` watchdog/restart decisions were
extracted into `ElizaAgentWatchdogPolicy` and covered by instrumented tests that
run on stock Android without requiring a privileged local agent process.

Commands run:

```bash
bun install
ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 ./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=ai.elizaos.app.ElizaAgentWatchdogPolicyInstrumentedTest
adb -s 27051JEGR10034 shell am instrument -w -e class ai.elizaos.app.ElizaAgentWatchdogPolicyInstrumentedTest ai.elizaos.app.test/androidx.test.runner.AndroidJUnitRunner
adb -s emulator-5554 shell am instrument -w -e class ai.elizaos.app.ElizaAgentWatchdogPolicyInstrumentedTest ai.elizaos.app.test/androidx.test.runner.AndroidJUnitRunner
```

Artifacts:

- `gradle/androidTest-results-connected/debug/*.xml`: Gradle connected test XML,
  5/5 passing on Pixel 6a Android 16 and emulator Android 14.
- `gradle/androidTests-connected/debug/*.html`: Gradle HTML connected test
  report for the focused policy suite.
- `pixel-6a/am-instrument.txt` and `emulator/am-instrument.txt`: direct
  `am instrument` output, 5/5 passing on each device after APK install.
- `pixel-6a/instrument-pass.mp4` and `emulator/instrument-pass.mp4`: screen
  recordings captured while the direct instrumented test command ran.
- `pixel-6a/device.txt` and `emulator/device.txt`: device model, Android
  release/API, device codename, and build fingerprint.
- `pixel-6a/logcat-after-instrument.txt` and
  `emulator/logcat-after-instrument.txt`: tail logcat after direct test runs.
