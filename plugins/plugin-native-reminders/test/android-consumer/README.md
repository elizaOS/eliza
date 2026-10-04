# Independent Android consumer fixture

Build with a Gradle wrapper, Android SDK36 and JDK21:

```sh
./gradlew -p plugins/plugin-native-reminders/test/android-consumer -PcapacitorAndroidDir=/absolute/path/to/@capacitor/android/capacitor assembleDebug assembleDebugAndroidTest
```

Install the fixture and test APK into a dedicated emulator user, grant POST_NOTIFICATIONS, then run AndroidJUnitRunner with `-e reminderEngineFixture 1 -e class example.reminders.fixture.ReminderEngineFlowTest`. Without explicit opt-in the test does not execute its effects. Remove only that fixture user and its installed packages afterward.

This fixture uses synthetic local reminders and a test-only store. It exercises two configured engines, receipts, null alerts, receiver notification actions and opaque taps. It does not qualify a production encrypted adapter, Capacitor permission/lifecycle behavior, concurrent failures, reboot delivery, or an installed-app migration. Do not use its storage adapter in production.

## Independent Capacitor bridge flow

`example.reminders.fixture.ReminderBridgeFlowTest` requires `-e reminderBridge 1`, a new dedicated secondary user on API33+, and POST_NOTIFICATIONS initially ungranted. Do not pregrant notifications for this case. It launches a real BridgeActivity with an annotated ReminderPlugin subclass and local WebView, denies then grants the Android permission dialog, checks inherited permission callback delivery, lists/reads/updates through nativePromise, rejects stale revisions, observes inherited appResumed, and cancels using the exact selected target/binding.

Run this case separately from the engine case in a fresh user. There is no pause-cancellation API in ReminderPlugin; the test does not invent one. No JavaScript mock, web fallback, external account or real reminder content is involved. Build-only qualification remains distinct from an actual instrumented pass.

`ReminderTapIoTest` requires `-e reminderTapIo 1` and an owned secondary user.
It invokes the real registered tap methods while a synthetic storage adapter
blocks reads, verifies that a main-thread heartbeat and WebView callbacks still
run, then releases storage and requires each promise to settle. It does not use
production data or qualify installed-app migration.
