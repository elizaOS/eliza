# Android Calendar provider adapter

This Android adapter has an explicit contract independent of the Apple EventKit API.
Subclass CalendarPlugin, supply one immutable CalendarConfiguration to super(), and annotate the subclass with your Capacitor plugin name and permission aliases `calendar` (READ_CALENDAR, WRITE_CALENDAR) and `workflowCalendarRead` (READ_CALENDAR). Register the subclass in the host BridgeActivity. The renderer must explicitly register that name; this module does not silently replace the Apple Calendar API.

The host owns product identity, account name, local calendar name, display label, color, journal namespace, and creation URI prefix. These are migration-sensitive values. Never change them during an upgrade without an explicit migration. The bridge supplies Android context, foreground Activity, permission results and lifecycle callbacks. The adapter owns CalendarProvider queries, native operation confirmation, source/event revision assertions, local creation recovery and cancellation. It never depends on a product renderer or agent runtime.

The existing method/result contract is retained: requestAccess, list, open, inspect, remove, save, pendingCreations, acknowledgeCreation, requestWorkflowReadAccess, workflowCalendars, readWorkflowRange, prepareAgentSource, executeAgent, cancelAgent. Inspect the annotated methods for exact argument validation. Creation IDs are UUIDv4 and identity-bound; uncertain effects are reconciled, never replayed. Selected-agent confirmation is mandatory and foreground-bound. External/recurring events are handed to the system editor rather than directly mutated.

Journal operations share a process-lifetime lock and persistence quarantine per canonical preference file, across adapter instances. Conflicting URI prefixes for the same journal fail closed. Different journals remain independent. Multi-process use of the same journal is unsupported (Android SharedPreferences is not a multi-process store); register and execute the bridge in one process.

Qualification status: extracted candidate. Building this library alone does not establish provider, permission, process-restart or upgrade acceptance. Require the external-consumer and product migration flows before release.
