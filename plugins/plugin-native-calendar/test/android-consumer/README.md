# Independent Android consumer

This fixture has its own package, Calendar account and journal, and imports the library as a Gradle dependency. It exercises actual CalendarProvider storage and Capacitor calls rather than product implementations.

Use JDK 21, Android SDK 36, Gradle 8.13 and the repository's Capacitor Android dependency. Build with `gradle -p plugins/plugin-native-calendar/test/android-consumer assembleDebug assembleDebugAndroidTest`. Set `-PcapacitorAndroidDir=/absolute/path/to/@capacitor/android/capacitor` if dependencies are installed elsewhere. Set `-PcalendarLibraryDir=/absolute/path/to/unpacked/package/android` to verify packed consumption.

Run only in a fresh disposable secondary Android user, never an existing user's calendar. Install both generated APKs in that user. `ConsumerCreationRecoveryTest` requires Calendar read/write permissions and instrumentation argument `calendarCreationRecovery=1`. `ConsumerBridgeFlowTest#permissionAndReviewedProviderLifecycle` requires initially ungranted Calendar permissions and `calendarBridge=1`. `ConsumerBridgeFlowTest#workflowPermissionCallback` requires a separate fresh user with `calendarWorkflowPermission=1`. All use `androidx.test.runner.AndroidJUnitRunner` in `example.calendar.consumer.test`.

Recovery covers provider markers, ambiguous and missing markers, concurrent same-ID creation, journal isolation and conflicting configuration. Bridge flows exercise actual permission dialogs, reviewed CRUD, stale/concurrent edits and cancellation on Activity pause. Remove only fixture-owned rows/users/packages and restore the original foreground user after testing. Builds do not establish device acceptance.
