# Android Calendar provider adapter

This Android adapter has an explicit contract independent of the Apple EventKit API.
Subclass CalendarPlugin, supply one immutable CalendarConfiguration to super(), and annotate the subclass with your Capacitor plugin name and permission aliases `calendar` (READ_CALENDAR, WRITE_CALENDAR) and `workflowCalendarRead` (READ_CALENDAR). Register the subclass in the host BridgeActivity. The renderer must explicitly register that name; this module does not silently replace the Apple Calendar API.

The host owns product identity, account name, local calendar name, display label, color, journal namespace, and creation URI prefix. These are migration-sensitive values. Never change them during an upgrade without an explicit migration. The bridge supplies Android context, foreground Activity, permission results and lifecycle callbacks. The adapter owns CalendarProvider queries, native operation confirmation, source/event revision assertions, local creation recovery and cancellation. It never depends on a product renderer or agent runtime.

The existing method/result contract is retained: requestAccess, list, open, inspect, remove, save, pendingCreations, acknowledgeCreation, requestWorkflowReadAccess, workflowCalendars, readWorkflowRange, prepareAgentSource, executeAgent, cancelAgent. Inspect the annotated methods for exact argument validation. Creation IDs are UUIDv4 and identity-bound; uncertain effects are reconciled, never replayed. Selected-agent confirmation is mandatory and foreground-bound. External/recurring events are handed to the system editor rather than directly mutated.

Journal operations share a process-lifetime lock and persistence quarantine per canonical preference file, across adapter instances. Conflicting URI prefixes for the same journal fail closed. Different journals remain independent. Multi-process use of the same journal is unsupported (Android SharedPreferences is not a multi-process store); register and execute the bridge in one process.

Qualification status: extracted candidate. Building this library alone does not establish provider, permission, process-restart or upgrade acceptance. Require the external-consumer and product migration flows before release.

Read-only hosts may compile `ai.eliza.plugins.calendar.read.CalendarReadAccess`
without registering the writable bridge or requesting WRITE_CALENDAR. The host
checks READ_CALENDAR and its source-consent policy before reading. Calendar and
instance reads return the complete requested range; unavailable provider cursors
reject rather than masquerading as empty data. The legacy configuration keeps complete reads. A host can set
`CalendarConfiguration.maximumReadEvents` to a positive bound. Its bridge `list`
uses `CalendarReadAccess.window` and reports `truncated: true` after observing an
additional row; callers must preserve that incomplete state. `events` itself
still returns the complete range. With the host
package and creation URI prefix, the reader also returns `creationId` for
events the host created through `save`. CalendarProvider can reuse a row id
after a deletion, so hosts that link records to events use `creationId`. Other
apps with calendar write access can set the same fields, so treat it as a link,
not as proof of ownership.
`SelectedCalendarReader.readAvailability` reads free/busy rows of exactly the
selected calendars for a window of at most seven days. It queries only times,
the all-day flag, availability and status, never titles, descriptions,
locations or attendees. All-day events match the owner's civil dates. Cancelled
events and declined invitations are skipped. It returns at most 200 rows and
throws `TooMany` above that, and throws `SourceChanged` when a selected calendar
changed before or during the read. `availabilitySources` lists the calendars
readable at free/busy level or above, with the source revision a read asserts.
`reviewNewEvent` only constructs an ACTION_INSERT editor intent; it neither
dispatches the intent nor writes an event. The host handles launch failures and
reports dispatch separately from a saved-event outcome.

Hosts can use `write.CalendarEventOptions` for explicitly reviewed all-day,
time-zone and simple recurrence fields. Recurring provider values use RFC2445
`DURATION` (whole seconds for timed events, days for all-day events) instead of
`DTEND`. Invalid dates and unsupported rules fail before insertion.
`CalendarInsertHandoff` prepares an external editor intent for richer drafts;
the host reports launch separately from save, and requested alerts still need
the editor because Android has no standard insert extra for them.

`saveOptions`, `readOptions` and `insertHandoff` expose these helpers through the
shared bridge. Pending creation reads and acknowledgements cover both journals. A creation ID
cannot be reused across journals. An unreadable other journal refuses the write;
an old cross-journal collision refuses acknowledgement and retains both receipts.
The two existing journal guards are ordered by their canonical preference-file
identity, so Activity instances cannot race a UUID into opposite stores.
`saveOptions` does not edit existing events; the native editor handoff reports
`opened` separately from any save. Host review and deferred-deletion overrides
remain in force for the existing agent and removal paths.

`CalendarOptionCreationStore` retains the `-options` journal and `options/`
creation URI suffixes. It shares the existing journal implementation, including
cross-instance locking and failed-write quarantine, while preserving the ordered
field hash used by installed option receipts. `CalendarDestinations` is shared
by the original bridge and host extensions; it refuses unavailable provider
lookups instead of treating them as a missing local calendar. Hosts must check
permissions, chosen destinations and owner authority before invoking these helpers.

Run `node --test test/native-host/read-window.test.mjs` for the complete/default and
bounded-read contracts. After compiling the real shared bridge and host classes
against Android APIs, `test/native-host/bridge-check.mjs` accepts `--classes`,
`--classpath`, `--json` (the JVM JSON jar), `--host`, `--journal` and `--prefix`.
It invokes the real methods against a controlled provider and checks permission
refusal, receipt recovery, cross-journal identity fences and editor handoff. This
is a JVM test and does not replace the isolated Android consumer run.
