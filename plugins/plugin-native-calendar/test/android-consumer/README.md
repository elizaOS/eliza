# Independent Android consumer

This fixture has its own package, Calendar account and journal, and imports the library as a Gradle dependency. It exercises actual CalendarProvider storage and Capacitor calls rather than product implementations.

Use JDK 21, Android SDK 36, Gradle 8.13 and the repository's Capacitor Android dependency. Build with `gradle -p plugins/plugin-native-calendar/test/android-consumer assembleDebug assembleDebugAndroidTest`. Set `-PcapacitorAndroidDir=/absolute/path/to/@capacitor/android/capacitor` if dependencies are installed elsewhere. Set `-PcalendarLibraryDir=/absolute/path/to/unpacked/package/android` to verify packed consumption.

Run only in a fresh disposable secondary Android user, never an existing user's calendar. Install both generated APKs in that user. `ConsumerCreationRecoveryTest` requires Calendar read/write permissions and instrumentation argument `calendarCreationRecovery=1`. `ConsumerBridgeFlowTest#permissionAndReviewedProviderLifecycle` requires initially ungranted Calendar permissions and `calendarBridge=1`. `ConsumerBridgeFlowTest#workflowPermissionCallback` requires a separate fresh user with `calendarWorkflowPermission=1`. All use `androidx.test.runner.AndroidJUnitRunner` in `example.calendar.consumer.test`.

Recovery covers provider markers, ambiguous and missing markers, concurrent same-ID creation, journal isolation and conflicting configuration. Bridge flows exercise actual permission dialogs, reviewed CRUD, stale/concurrent edits and cancellation on Activity pause. Remove only fixture-owned rows/users/packages and restore the original foreground user after testing. Builds do not establish device acceptance.

`ConsumerReadAccessTest` requires the same fresh secondary-user fixture, Calendar
read/write grants for fixture setup, and `calendarReadAccess=1`. It inserts and
removes only its uniquely named local calendar, verifies all 2,101 provider events
are returned, and checks that constructing an editor intent makes no provider
change. Production read-only hosts need no write permission.


After building, run the shared harness qualification against an explicitly owned
x86_64 fixture AVD (it must be booted and unlocked with foreground user 0):

```sh
node plugins/plugin-native-calendar/test/android-consumer/run-consumer.mjs \
  --adb /absolute/android-sdk/platform-tools/adb \
  --aapt /absolute/android-sdk/build-tools/36.0.0/aapt \
  --serial emulator-5582 --abi x86_64 --avd your-disposable-fixture
```

This host creates a separate fresh user for cancellation and complete-read runs,
installs and instruments in that same user, grants only the fixture's calendar
permissions, removes its users and preserves foreground user 0. The complete
case reads all 2,101 owned events; the cancellation case exercises real command
abort and package cleanup. Provider data belongs only to those newly created
users. APK hashes, instrumentation and cleanup receipts are under repository-root
`test-results/isolated-calendar-consumer/`. The host selects 120-second command
and 300-second instrumentation deadlines; override them with
`--command-timeout-ms` and `--instrumentation-timeout-ms` as needed. The shared
harness imposes no automatic duration policy.

Select `--abi arm64-v8a` for an ARM64 fixture. The caller holds the device lease before creating its fresh secondary users and through their removal. It switches each fixture user to the foreground to finish unlocking, then restores the original foreground user.

Choose `--case recovery`, `--case bridge` or `--case workflow-permission` to run
one of the corresponding methods described above in its own fresh user. The
bridge and workflow-permission cases deliberately do not pregrant Calendar
permissions. The default `--case read` retains cancelled and complete read runs.
`--apk` and `--test-apk` accept absolute paths to independently built consumer
artifacts; the shared harness verifies their package and instrumentation identities.
Use `--output-root /absolute/reports` to retain reports outside an immutable source
checkout. Otherwise reports remain under the repository test-results directory.
A deferred process cleanup also retains its owned user for explicit recovery;
never remove that user based only on an interrupted ADB client.
