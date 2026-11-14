# Response-field registry and dispatch

Source `runtime/response-handler-fields.ts` defines registration, schema caching, prompt slices, activation, parsing and ordered field handlers. Its implementation records ordinary parse/activation/handler failures and continues siblings. `TurnAbortedError` escapes immediately. The preserved field traces and `fieldErrors` expose these failures to the caller.

## Story: Extend structured responses without hiding sibling failures

As a plugin, I want one named field contribution, a stable required schema and handlers that see all parsed sibling values.

### Valid registration is first-wins and invalidates full-schema caches only when changed

Registration validates name, description and truthy object schema before duplicate-name handling. All selected registered fields remain required regardless of per-turn activation. Default values derive from schema type, selecting the first non-null member for a union. Missing string, array, object, boolean and number fields receive empty string, empty array, empty object, false and zero respectively. The full schema disallows additional properties. Fields sort by ascending priority, default 100, then name locale order.

```quint
type ParseOutcome = ParsedOk | InactiveField | SoftParseFailure | HardParseFailure | CancelledField
type FieldDispatch = { registered: Set[str], definitions: str -> int, priorities: str -> int, cacheValid: bool, inFlight: bool, snapshot: Set[str], snapshotPriorities: str -> int, pending: Set[str], ready: Set[str], attempted: Set[str], handled: Set[str], errors: Set[str], preempted: bool, aborted: bool }
pure val initial: FieldDispatch = { registered: Set(), definitions: Map(), priorities: Map(), cacheValid: false, inFlight: false, snapshot: Set(), snapshotPriorities: Map(), pending: Set(), ready: Set(), attempted: Set(), handled: Set(), errors: Set(), preempted: false, aborted: false }
pure def canRegisterField(f: FieldDispatch, name: str, descriptionPresent: bool, schemaObject: bool): bool = name != "" and descriptionPresent and schemaObject
pure def registerField(f: FieldDispatch, name: str, descriptionPresent: bool, schemaObject: bool, definition: int, priority: int): FieldDispatch = if (f.registered.contains(name)) f else { ...f, registered: f.registered.union(Set(name)), definitions: f.definitions.put(name, definition), priorities: f.priorities.put(name, priority), cacheValid: false }
pure def unregisterField(f: FieldDispatch, name: str): FieldDispatch = if (f.registered.contains(name)) { ...f, registered: f.registered.exclude(Set(name)), cacheValid: false } else f
pure def composeSchema(f: FieldDispatch): FieldDispatch = { ...f, cacheValid: true }
pure def requiredFields(f: FieldDispatch, selection: Set[str], selected: bool): Set[str] = if (selected) f.registered.intersect(selection) else f.registered
```

### All active fields parse before handlers begin and preemption stops subsequent handlers

Dispatch snapshots the sorted registry so concurrent registration affects the next dispatch. The active set is recomputed for each dispatch. Inactive fields and null parse results skip handling. Ordinary parse and activation exceptions add field errors and permit siblings. Cancellation aborts the dispatch. Handler errors add errors and permit later siblings. Preemption retains its requested mode and ends handling. Callback mutation applies only after successful parsing of every sibling. Equal-priority lexical ordering is an adapter contract over the source comparator and its captured fixtures.

```quint
pure def canBeginDispatch(f: FieldDispatch): bool = not(f.inFlight)
pure def beginDispatch(f: FieldDispatch): FieldDispatch = { ...f, inFlight: true, snapshot: f.registered, snapshotPriorities: f.priorities, pending: f.registered, ready: Set(), attempted: Set(), handled: Set(), errors: Set(), preempted: false, aborted: false }
pure def canParseField(f: FieldDispatch, name: str): bool = f.inFlight and not(f.aborted) and f.pending.contains(name)
pure def parseField(f: FieldDispatch, name: str, parseResult: ParseOutcome, hasHandler: bool): FieldDispatch = { ...f, pending: f.pending.exclude(Set(name)), ready: if (parseResult == ParsedOk and hasHandler) f.ready.union(Set(name)) else f.ready, errors: if (parseResult == SoftParseFailure or parseResult == HardParseFailure) f.errors.union(Set(name)) else f.errors, aborted: parseResult == CancelledField }
pure def canHandleField(f: FieldDispatch, name: str): bool = f.inFlight and f.pending.size() == 0 and not(f.aborted) and not(f.preempted) and f.ready.contains(name) and f.ready.forall(other => f.snapshotPriorities.getOr(other, 100) >= f.snapshotPriorities.getOr(name, 100))
pure def handleField(f: FieldDispatch, name: str, failed: bool, preempt: bool, cancelled: bool): FieldDispatch = { ...f, ready: f.ready.exclude(Set(name)), attempted: f.attempted.union(Set(name)), handled: if (failed or cancelled) f.handled else f.handled.union(Set(name)), errors: if (failed and not(cancelled)) f.errors.union(Set(name)) else f.errors, preempted: not(failed) and not(cancelled) and preempt, aborted: cancelled }
pure def canFinishDispatch(f: FieldDispatch): bool = f.inFlight and ((f.pending.size() == 0 and f.ready.size() == 0) or f.preempted or f.aborted)
pure def finishDispatch(f: FieldDispatch): FieldDispatch = { ...f, inFlight: false }
pure def alwaysOnlySnapshotHandled(f: FieldDispatch): bool = f.ready.subseteq(f.snapshot) and f.attempted.subseteq(f.snapshot) and f.handled.subseteq(f.attempted)
pure def alwaysHandlersAfterParse(f: FieldDispatch): bool = f.attempted.size() > 0 implies f.pending.size() == 0
pure def alwaysAttemptedOnce(f: FieldDispatch): bool = f.ready.intersect(f.attempted).size() == 0
pure def sometimesSiblingErrorRecorded(f: FieldDispatch): bool = f.errors.size() > 0
pure def sometimesHandlerPreempts(f: FieldDispatch): bool = f.preempted
pure def sometimesDispatchCancelled(f: FieldDispatch): bool = f.aborted
```
