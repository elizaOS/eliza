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
reject rather than masquerading as empty data. The existing bridge list method
uses this same reader and no longer truncates at 2,000 instances.
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

`CalendarOptionCreationStore` retains the `-options` journal and `options/`
creation URI suffixes. It shares the existing journal implementation, including
cross-instance locking and failed-write quarantine, while preserving the ordered
field hash used by installed option receipts. `CalendarDestinations` is shared
by the original bridge and host extensions; it refuses unavailable provider
lookups instead of treating them as a missing local calendar. Hosts must check
permissions, chosen destinations and owner authority before invoking these helpers.
