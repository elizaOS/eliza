# @elizaos/macosreminders

macOS Apple Reminders native bridge policy helpers for elizaOS host runtimes.


Install workspace dependencies with `bun install` at the repository root.

Build from the repository root:

```bash
bun run --cwd plugins/plugin-native-reminders build
```

## Android candidate

An additive [Android reminder engine](android/README.md) provides host-configured storage, scheduling, notification actions and a Capacitor base bridge. Its source ships in the package; generated Gradle outputs and the consumer fixture do not. The existing macOS entrypoint remains unchanged. See the [independent consumer](test/android-consumer/README.md) for build and qualification instructions. This candidate is not release-qualified.

Import `registerAndroidReminders` from `@elizaos/macosreminders/android` and pass the exact Capacitor name declared by the host subclass. Install `@capacitor/core` 8.3.1 or compatible 8.x for this entrypoint; it is an optional peer so existing macOS consumers do not need it. Importing the entrypoint does not register a plugin, map the Apple API, or supply a simulated web fallback. Resolved `unknown` outcomes require reconciliation; rejected promises and resolved failure statuses must be handled separately.

After building, `bun run --cwd plugins/plugin-native-reminders test:android-package` packs the real package and checks an external NodeNext consumer, explicit alert/null typing, reviewed-target bindings and unsupported-web rejection. This verifies packaging and TypeScript contracts, not native execution.

The Android entry also supports undated to-dos, exact-target completion/reopen,
stable storage-capacity refusals, and posted-reminder recovery after reboot.
Narrow `AndroidReminderRecord.undated` before reading timestamps: to-dos have no
due time, alarm or dated completion history.

## Shared occurrence decisions

`@elizaos/macosreminders/occurrence` is the browser-safe twin of the Android engine's
civil schedule and Done/Snooze decisions: `initialReminderDue`, `nextReminderOccurrence`,
`completeReminderOccurrence` and `snoozeReminderOccurrence`. A one-off Done completes the
reminder; a repeat records the finished occurrence (with the dates skipped while it was
overdue) and advances to its next future civil occurrence in the saved zone. Overlaps
use the earlier instant, a new repeat at a nonexistent wall time is refused, and a later
gap advances to the first valid wall time after it. History keeps the newest 32 entries.

Hosts that keep reminders outside Android, such as a browser build, use these functions
instead of a second schedule implementation. They pass the instant, the observed alert
delivery status and their own occurrence identity scheme; persistence, notification
delivery, revisions and receipts stay with the host. `bun run --cwd plugins/plugin-native-reminders test`
runs the decision tests.
