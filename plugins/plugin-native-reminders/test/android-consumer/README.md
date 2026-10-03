# Independent Android consumer fixture

Build with a Gradle wrapper, Android SDK36 and JDK21:

```sh
./gradlew -p plugins/plugin-native-reminders/test/android-consumer -PcapacitorAndroidDir=/absolute/path/to/@capacitor/android/capacitor assembleDebug assembleDebugAndroidTest
```

Install the fixture and test APK into a dedicated emulator user, grant POST_NOTIFICATIONS, then run AndroidJUnitRunner with `-e reminderEngineFixture 1 -e class example.reminders.fixture.ReminderEngineFlowTest`. Without explicit opt-in the test does not execute its effects. Remove only that fixture user and its installed packages afterward.

This fixture uses synthetic local reminders and a test-only store. It exercises two configured engines, receipts, null alerts, receiver notification actions and opaque taps. It does not qualify a production encrypted adapter, Capacitor permission/lifecycle behavior, concurrent failures, reboot delivery, or an installed-app migration. Do not use its storage adapter in production.

The first source-consumer run failed because a shared 1.5-second fixture deadline expired before the second schedule. The fixture now chooses independent future deadlines; a fresh run is required. Build success is not runtime acceptance.
