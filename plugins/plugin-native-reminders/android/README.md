# Android reminders

A host-configured Android reminder engine, Capacitor bridge, and broadcast dispatcher. Android owns inexact scheduling and notifications; the engine persists reminder rows, exact revisions, operation receipts and opaque notification routes. This module does not run an agent or grant approval for agent actions.

## Host integration

Include this Android library and its `:capacitor-android` dependency. Extend `ReminderPlugin` with a public no-argument constructor supplying immutable `ReminderConfiguration` and a `SecureStringStore.Factory`. Annotate the host subclass with its chosen Capacitor name and a `notifications` permission alias for POST_NOTIFICATIONS. Register it with the host bridge. A host subclass retaining other lifecycle behavior must call the superclass methods.

Extend `ReminderReceiver` and return the same configured `ReminderEngine` from `engine(Context)`. Keep the receiver non-exported and declare the required boot, package-replaced, time and timezone filters and RECEIVE_BOOT_COMPLETED permission in the host manifest. The configured Activity and receiver belong to the host application. Both resolve the engine through `ReminderEngine.get`, which reuses one instance per canonical envelope path.

The secure adapter must use an existing durable encrypted store in production. Its identity identifies the backing store and storage domain, not a Java object. A failed write must throw, and subsequent reads must never expose speculative values from that write. Factories receive an application context. This library does not supply a plaintext production fallback.

## Identity and concurrency

Every configuration field describing storage, actions, extras, URI prefixes, components, channels or tags is migration-sensitive. Preserve existing receiver/Activity class names and all PendingIntent request codes, flags and routes when adopting the module. An empty notification tag prefix preserves bare reminder-ID tags. Additional engines use distinct `namespace:` prefixes and distinct storage/channel/action resources. Conflicting ownership fails closed.

Within one process, all transaction, cache, deferred-effect, tap and failed-write quarantine state shares the same engine-owned store monitor. Only a new process clears persistence quarantine. Multiple processes accessing one envelope are unsupported; the host must keep the receiver and bridge in the same process. Configuration cannot vary between requests.

## Semantics

Explicit null alert values persist tasks without scheduling an alarm. Inexact reminder delivery is not an alarm-clock guarantee. Operation IDs and approval bindings are durable: replay returns the original receipt and changed arguments are rejected. Unknown effects are not blindly replayed. Tapping a notification captures navigation only; it never completes a reminder or approves an agent action. Keep owner/agent authorization in the host before invoking operations.

The existing macOS package entrypoint is independent of this Android implementation. Real bridge/permission flows, failed-write and concurrent-instance tests, and lossless installed-app migration must be qualified before release. A Java or APK build is not device acceptance.

This is a host-subclass Android API only. The Apple Reminders JavaScript API does not automatically map to these Android methods. The explicit typed `@elizaos/macosreminders/android` entrypoint registers only the chosen host name. Independent Capacitor permission/lifecycle verification and production encrypted-store/PendingIntent upgrade qualification remain required before release.

Opaque tap capture, inspection, consumption and dismissal use a bounded serial
background queue. Queue saturation rejects bridge calls and retains uncaptured
intents for retry; it never falls back to storage on the UI thread. Foreground
and unlocked-state admission happens on the UI thread before queued tap actions.
Destroyed hosts reject queued actions. Notification delivery and engine operations
retain their existing store lock and durable receipt semantics.

## Refusals, recovery, due channel and to-dos

`scheduleReminder` resolves stable refusal statuses: `past`, `permission-denied`,
`storage-full` and `failed`. A full store reports `storage-full`; it is never replaced
by `failed`. Hosts confirm absence by readback before retiring a pending attempt.

Android removes posted notifications on reboot. `restore` re-posts each `posted` record
once per boot (`Settings.Global.BOOT_COUNT`) with the same occurrence, exact target and
unconsumed tap route, and the same Done/Snooze actions. It never advances recurrence.

Due reminders post on a separate high-importance channel, `<channelId>-due`. The
configured channel is still created for compatibility. On first creation the due channel
keeps blocked or quiet channels, explicit importance choices on API29+, lock-screen
visibility, sound and vibration. The derived boot-marker preference file is also
reserved by the engine ownership check.

`saveTodo` stores an undated to-do: status `todo`, mode `none`, `undated: true`, no `at`
and no AlarmManager entry or notification. A retried save with the same ID and text is
idempotent. `todoDecision` takes the exact reviewed target and `done`, `reopen` or
`cancel`. Reviewed `operateReminder` operations and `reminderDecision` refuse undated
to-dos.
