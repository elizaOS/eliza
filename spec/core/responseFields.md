# Response-field registry and dispatch

Source `runtime/response-handler-fields.ts` defines registration, schema caching, prompt slices, activation, parsing and ordered field handlers. Its implementation records ordinary parse/activation/handler failures and continues siblings. `TurnAbortedError` escapes immediately. The preserved field traces and `fieldErrors` expose these failures to the caller.

## Story: Extend structured responses without hiding sibling failures

As a plugin, I want one named field contribution, a stable required schema and handlers that see all parsed sibling values.

### Valid registration is first-wins and invalidates full-schema caches only when changed

Registration validates name, description and truthy object schema before duplicate-name handling. All selected registered fields remain required regardless of per-turn activation. Default values derive from schema type, selecting the first non-null member for a union. Missing string, array, object, boolean and number fields receive empty string, empty array, empty object, false and zero respectively. The full schema disallows additional properties. Fields sort by ascending priority, default 100, then name locale order.

```quint
type ParseOutcome = ParsedOk | InactiveField | SoftParseFailure | HardParseFailure | CancelledField
type PreemptMode = AcknowledgeAndStop | IgnoreReply | DirectReply
type PreemptEffect = NoPreemptEffect | RequestPreempt({ mode: PreemptMode, reason: str })
type HandlerOutcome = HandlerReturned({ effect: PreemptEffect }) | HandlerCallbackFailed | HandlerEffectFailed | HandlerCallbackCancelled | HandlerEffectCancelled
type FieldPreemption = NoFieldPreemption | PreemptedField({ field: str, mode: PreemptMode, reason: str })
type FieldDispatch = { registered: Set[str], definitions: str -> int, priorities: str -> int, cacheValid: bool, inFlight: bool, snapshot: Set[str], snapshotPriorities: str -> int, pending: Set[str], ready: Set[str], attempted: Set[str], handled: Set[str], errors: Set[str], preemption: FieldPreemption, aborted: bool }
pure val initial: FieldDispatch = { registered: Set(), definitions: Map(), priorities: Map(), cacheValid: false, inFlight: false, snapshot: Set(), snapshotPriorities: Map(), pending: Set(), ready: Set(), attempted: Set(), handled: Set(), errors: Set(), preemption: NoFieldPreemption, aborted: false }
pure def canRegisterField(f: FieldDispatch, name: str, descriptionPresent: bool, schemaObject: bool): bool = name != "" and descriptionPresent and schemaObject
pure def registerField(f: FieldDispatch, name: str, descriptionPresent: bool, schemaObject: bool, definition: int, priority: int): FieldDispatch = if (f.registered.contains(name)) f else { ...f, registered: f.registered.union(Set(name)), definitions: f.definitions.put(name, definition), priorities: f.priorities.put(name, priority), cacheValid: false }
pure def unregisterField(f: FieldDispatch, name: str): FieldDispatch = if (f.registered.contains(name)) { ...f, registered: f.registered.exclude(Set(name)), cacheValid: false } else f
pure def composeSchema(f: FieldDispatch): FieldDispatch = { ...f, cacheValid: true }
pure def requiredFields(f: FieldDispatch, selection: Set[str], selected: bool): Set[str] = if (selected) f.registered.intersect(selection) else f.registered
```

### All active fields parse before handlers begin and preemption stops subsequent handlers

Dispatch snapshots the sorted registry so concurrent registration affects the next dispatch. The active set is recomputed for each dispatch. Inactive fields and null parse results skip handling. Ordinary parse and activation exceptions add field errors and permit siblings. Cancellation aborts the dispatch. Handler errors add errors and permit later siblings. A successful handler effect retains its requested preemption field, mode and required reason string exactly, including an empty reason, and ends handling. The three source modes are `ack-and-stop`, `ignore` and `direct-reply`; they are distinct terminal routing requests. Every activation/parsing attempt settles before handlers begin, including failed siblings; successful siblings may still run. A returned handler handlerResult means the whole effect application, including any callback mutation, succeeded. A callback failure records an error before the handled trace is set. A failure while applying a returned effect, including a mutation failure, keeps that handled trace and records an error without installing its proposed preemption. Cancellation aborts instead; cancellation while applying a returned effect likewise keeps the handled trace, while cancellation before callback return does not. The partial cancellation state is a control-flow observation; the source rejects its dispatch promise instead of returning a completed run result. The run result and preempting field trace project the same authoritative accepted-preemption record for fully observed, stable, nonthrowing data-effect records. The source first marks the host trace preempted, then reads mode, then reason, then assigns the run preemption. A throwing mode getter can leave only the host preempted flag; a throwing reason getter can additionally leave its mode, while run preemption remains absent and later siblings continue. These accessor-bearing effects remain a host reflection/adapter-conformance boundary, not a universal run/trace equality theorem. The runtime adapter must preserve those original partial diagnostics and source property-read order, rather than recomputing them from the pure accepted-preemption record. Arbitrary callbacks, result payload mutation, diagnostics and abort exceptions remain host conformance boundaries. Equal-priority lexical ordering is an adapter contract over the source comparator and its captured fixtures.

```quint
pure def isPreempted(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => true | _ => false } }
pure def runPreemption(f: FieldDispatch): PreemptEffect = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => RequestPreempt({ mode: preempt.mode, reason: preempt.reason }) | _ => NoPreemptEffect } }
pure def tracePreemption(f: FieldDispatch, name: str): PreemptEffect = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => if (preempt.field == name) RequestPreempt({ mode: preempt.mode, reason: preempt.reason }) else NoPreemptEffect | _ => NoPreemptEffect } }
pure def hasPreemptEffect(effect: PreemptEffect, mode: PreemptMode, reason: str): bool = match effect { | RequestPreempt(preempt) => preempt.mode == mode and preempt.reason == reason | _ => false }
pure def completedCallback(handlerResult: HandlerOutcome): bool = match handlerResult { | HandlerReturned(returned) => true | HandlerEffectFailed => true | HandlerEffectCancelled => true | _ => false }
pure def failedHandler(handlerResult: HandlerOutcome): bool = match handlerResult { | HandlerCallbackFailed => true | HandlerEffectFailed => true | _ => false }
pure def cancelledHandler(handlerResult: HandlerOutcome): bool = match handlerResult { | HandlerCallbackCancelled => true | HandlerEffectCancelled => true | _ => false }
pure def effectPreemption(name: str, effect: PreemptEffect): FieldPreemption = match effect { | RequestPreempt(preempt) => PreemptedField({ field: name, mode: preempt.mode, reason: preempt.reason }) | _ => NoFieldPreemption }
pure def handlerPreemption(name: str, handlerResult: HandlerOutcome): FieldPreemption = match handlerResult { | HandlerReturned(returned) => effectPreemption(name, returned.effect) | _ => NoFieldPreemption }
pure def canBeginDispatch(f: FieldDispatch): bool = not(f.inFlight)
pure def beginDispatch(f: FieldDispatch): FieldDispatch = { ...f, inFlight: true, snapshot: f.registered, snapshotPriorities: f.priorities, pending: f.registered, ready: Set(), attempted: Set(), handled: Set(), errors: Set(), preemption: NoFieldPreemption, aborted: false }
pure def canParseField(f: FieldDispatch, name: str): bool = f.inFlight and not(f.aborted) and f.pending.contains(name)
pure def parseField(f: FieldDispatch, name: str, parseResult: ParseOutcome, hasHandler: bool): FieldDispatch = { ...f, pending: f.pending.exclude(Set(name)), ready: if (parseResult == ParsedOk and hasHandler) f.ready.union(Set(name)) else f.ready, errors: if (parseResult == SoftParseFailure or parseResult == HardParseFailure) f.errors.union(Set(name)) else f.errors, aborted: parseResult == CancelledField }
pure def canHandleField(f: FieldDispatch, name: str): bool = f.inFlight and f.pending.size() == 0 and not(f.aborted) and not(isPreempted(f)) and f.ready.contains(name) and f.ready.forall(other => f.snapshotPriorities.getOr(other, 100) >= f.snapshotPriorities.getOr(name, 100))
pure def handleField(f: FieldDispatch, name: str, handlerResult: HandlerOutcome): FieldDispatch = { ...f, ready: f.ready.exclude(Set(name)), attempted: f.attempted.union(Set(name)), handled: if (completedCallback(handlerResult)) f.handled.union(Set(name)) else f.handled, errors: if (failedHandler(handlerResult)) f.errors.union(Set(name)) else f.errors, preemption: handlerPreemption(name, handlerResult), aborted: cancelledHandler(handlerResult) }
pure def canFinishDispatch(f: FieldDispatch): bool = f.inFlight and ((f.pending.size() == 0 and f.ready.size() == 0) or isPreempted(f) or f.aborted)
pure def finishDispatch(f: FieldDispatch): FieldDispatch = { ...f, inFlight: false }
pure def alwaysOnlySnapshotHandled(f: FieldDispatch): bool = f.ready.subseteq(f.snapshot) and f.attempted.subseteq(f.snapshot) and f.handled.subseteq(f.attempted)
pure def alwaysHandlersAfterParse(f: FieldDispatch): bool = f.attempted.size() > 0 implies f.pending.size() == 0
pure def alwaysAttemptedOnce(f: FieldDispatch): bool = f.ready.intersect(f.attempted).size() == 0
pure def alwaysPreemptionNamesHandledField(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => f.handled.contains(preempt.field) and not(f.aborted) | _ => true } }
pure def stepPreemptionPersistsUntilNextDispatch(before: FieldDispatch, via: str, after: FieldDispatch): bool = via != "beginDispatch" and isPreempted(before) implies after.preemption == before.preemption
pure def lawRequestedPreemptionRetained(f: FieldDispatch, name: str, mode: PreemptMode, reason: str): bool = {
  val handledField = handleField(f, name, HandlerReturned({ effect: RequestPreempt({ mode: mode, reason: reason }) }))
  hasPreemptEffect(runPreemption(handledField), mode, reason) and hasPreemptEffect(tracePreemption(handledField, name), mode, reason)
}
pure def lawRunAndTracePreemptionAgree(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => runPreemption(f) == tracePreemption(f, preempt.field) | _ => true } }
pure def lawOtherFieldTraceHasNoPreemption(f: FieldDispatch, name: str): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => name != preempt.field implies not(hasPreemptEffect(tracePreemption(f, name), preempt.mode, preempt.reason)) | _ => true } }
pure def lawFailedHandlerDoesNotPreempt(f: FieldDispatch, name: str): bool = not(isPreempted(handleField(f, name, HandlerCallbackFailed))) and handleField(f, name, HandlerCallbackFailed).errors.contains(name)
pure def lawEffectFailureDoesNotPreempt(f: FieldDispatch, name: str): bool = not(isPreempted(handleField(f, name, HandlerEffectFailed))) and handleField(f, name, HandlerEffectFailed).handled.contains(name) and handleField(f, name, HandlerEffectFailed).errors.contains(name)
pure def lawCancelledHandlerDoesNotPreempt(f: FieldDispatch, name: str): bool = not(isPreempted(handleField(f, name, HandlerCallbackCancelled))) and handleField(f, name, HandlerCallbackCancelled).aborted
pure def lawEffectCancellationKeepsHandledTrace(f: FieldDispatch, name: str): bool = not(isPreempted(handleField(f, name, HandlerEffectCancelled))) and handleField(f, name, HandlerEffectCancelled).aborted and handleField(f, name, HandlerEffectCancelled).handled.contains(name)
pure def lawPreemptionStopsLaterHandlers(f: FieldDispatch, name: str): bool = isPreempted(f) implies not(canHandleField(f, name))
pure def sometimesSiblingErrorRecorded(f: FieldDispatch): bool = f.errors.size() > 0
pure def sometimesHandlerPreempts(f: FieldDispatch): bool = isPreempted(f)
pure def sometimesDispatchCancelled(f: FieldDispatch): bool = f.aborted
pure def sometimesFailedSiblingStillHandles(f: FieldDispatch): bool = f.errors.exists(failed => f.handled.exists(sibling => sibling != failed))
pure def sometimesAcknowledgementPreemption(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => preempt.mode == AcknowledgeAndStop | _ => false } }
pure def sometimesIgnorePreemption(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => preempt.mode == IgnoreReply | _ => false } }
pure def sometimesDirectReplyPreemption(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => preempt.mode == DirectReply | _ => false } }
pure val nameValues = Set("alpha", "beta")
pure val handlerResultValues = Set(HandlerReturned({ effect: NoPreemptEffect }), HandlerReturned({ effect: RequestPreempt({ mode: AcknowledgeAndStop, reason: "" }) }), HandlerReturned({ effect: RequestPreempt({ mode: IgnoreReply, reason: "ignore" }) }), HandlerReturned({ effect: RequestPreempt({ mode: DirectReply, reason: "direct" }) }), HandlerCallbackFailed, HandlerEffectFailed, HandlerCallbackCancelled, HandlerEffectCancelled)
```

### Pending parsing belongs to the captured registry

Discovered by the proof: without this fact, a state could parse a field that was never in the captured registry and then place its handler outside the snapshot. The source creates its parsing work from the captured evaluators and only removes names as their activation/parsing attempts settle.

```quint
pure def alwaysPendingBelongsToSnapshot(f: FieldDispatch): bool = f.pending.subseteq(f.snapshot)
```
