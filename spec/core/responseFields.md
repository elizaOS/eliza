# Response-field registry and dispatch

Structured response fields of `runtime/response-handler-fields.ts`: which lines are outer fields, registration, schema caching, activation, parsing and ordered handlers. Ordinary parse, activation and handler failures are recorded and siblings continue; `TurnAbortedError` escapes at once. Field traces and `fieldErrors` expose the failures to the caller.

## Story: Parse outer fields only

> As a model-output consumer, I want fenced examples kept as content while
> genuine outer response fields stay readable, so that quoted instructions
> are never promoted to fields.

The shell recognizes each Markdown line, keeping fence character, opening length, closing-line syntax and info-string behavior.

### Only a matching fence of sufficient length closes quoted content

Backtick and tilde fences close only with their own delimiter and at least the opening length. Inline markers, shorter closers, other fence kinds and content lines preserve the active fence. Only fields encountered outside a fence belong to the response envelope.

```quint
type FenceKind = NoFence | Backtick | Tilde
type FenceLine = { marker: FenceKind, length: int, opens: bool, closes: bool, name: str, text: str }
type FenceParser = { loaded: bool, kind: FenceKind, width: int, lines: List[FenceLine], cursor: int, outerFields: List[FenceLine], quotedFields: List[FenceLine] }
pure val idleFences: FenceParser = { loaded: false, kind: NoFence, width: 0, lines: List(), cursor: 0, outerFields: List(), quotedFields: List() }
pure val noLine: FenceLine = { marker: NoFence, length: 0, opens: false, closes: false, name: "", text: "" }
pure def canLoadLines(f: FieldDispatch): bool = not(f.fences.loaded)
pure def loadLines(f: FieldDispatch, lines: List[FenceLine]): FieldDispatch = { ...f, fences: { ...idleFences, loaded: true, lines: lines } }
pure def afterLine(p: FenceParser): FenceParser = {
  val line = p.lines.nthOr(p.cursor, noLine)
  val opening = p.kind == NoFence and line.opens and line.marker != NoFence and line.length >= 3
  val closing = p.kind != NoFence and line.closes and line.marker == p.kind and line.length >= p.width
  { ...p, cursor: p.cursor + 1, kind: if (opening) line.marker else if (closing) NoFence else p.kind, width: if (opening) line.length else if (closing) 0 else p.width, outerFields: if (line.name != "" and p.kind == NoFence and not(opening)) p.outerFields.append(line) else p.outerFields, quotedFields: if (line.name != "" and p.kind != NoFence and not(closing)) p.quotedFields.append(line) else p.quotedFields }
}
pure def canConsumeLine(f: FieldDispatch): bool = f.fences.loaded and f.fences.cursor < f.fences.lines.length()
pure def consumeLine(f: FieldDispatch): FieldDispatch = { ...f, fences: afterLine(f.fences) }
pure def alwaysFenceWidthMatchesKind(f: FieldDispatch): bool = (f.fences.kind == NoFence and f.fences.width == 0) or (f.fences.kind != NoFence and f.fences.width >= 3)
pure def alwaysCursorBounded(f: FieldDispatch): bool = f.fences.cursor >= 0 and f.fences.cursor <= f.fences.lines.length()
pure def stepQuotedFieldNeverBecomesOuter(before: FieldDispatch, via: str, after: FieldDispatch): bool = via == "consumeLine" and before.fences.kind != NoFence implies after.fences.outerFields == before.fences.outerFields
pure def sometimesOuterField(f: FieldDispatch): bool = f.fences.outerFields.length() > 0
pure def sometimesQuotedField(f: FieldDispatch): bool = f.fences.quotedFields.length() > 0
pure val backFour: FenceLine = { ...noLine, marker: Backtick, length: 4, opens: true, closes: true }
pure val backThree: FenceLine = { ...backFour, length: 3 }
pure val tildeThree: FenceLine = { ...backThree, marker: Tilde }
pure val infoThree: FenceLine = { ...backThree, closes: false, text: "lang" }
pure val outerLine: FenceLine = { ...noLine, name: "reply", text: "outside" }
pure val quotedLine: FenceLine = { ...noLine, name: "reply", text: "quoted" }
pure val linesValues: Set[List[FenceLine]] = Set(List(noLine, outerLine), List(backFour, backThree, quotedLine, backFour, outerLine), List(backThree, infoThree, quotedLine, backThree, outerLine), List(backThree, tildeThree, quotedLine, backThree, outerLine), List(tildeThree, quotedLine, tildeThree, outerLine))
pure val fair_consumeLine = "weak"
pure def leadsToLoadedLinesConsumed(f: FieldDispatch, later: FieldDispatch): bool = f.fences.loaded implies later.fences.cursor == f.fences.lines.length()
```

## Story: Extend structured responses without hiding sibling failures

> As a plugin, I want one named field contribution, a stable required schema
> and handlers that see all parsed sibling values, so that one field's
> failure never hides another's.

### Valid registration is first-wins and invalidates full-schema caches only when changed

Registration validates name, description and truthy object schema before duplicate-name handling. All selected registered fields remain required regardless of per-turn activation. Default values derive from schema type, selecting the first non-null member for a union. Missing string, array, object, boolean and number fields receive empty string, empty array, empty object, false and zero respectively. The full schema disallows additional properties. Fields sort by ascending priority, default 100, then name locale order.

```quint
type ParseOutcome = ParsedOk | InactiveField | SoftParseFailure | HardParseFailure | CancelledField
type FieldDispatch = { registered: Set[str], definitions: str -> int, priorities: str -> int, cacheValid: bool, inFlight: bool, snapshot: Set[str], snapshotPriorities: str -> int, pending: Set[str], ready: Set[str], attempted: Set[str], handled: Set[str], errors: Set[str], preempted: bool, preemption: FieldPreemption, aborted: bool, fences: FenceParser }
pure val initial: FieldDispatch = { registered: Set(), definitions: Map(), priorities: Map(), cacheValid: false, inFlight: false, snapshot: Set(), snapshotPriorities: Map(), pending: Set(), ready: Set(), attempted: Set(), handled: Set(), errors: Set(), preempted: false, preemption: NoFieldPreemption, aborted: false, fences: idleFences }
pure def canRegisterField(f: FieldDispatch, name: str, descriptionPresent: bool, schemaObject: bool): bool = name != "" and descriptionPresent and schemaObject
pure def registerField(f: FieldDispatch, name: str, descriptionPresent: bool, schemaObject: bool, definition: int, priority: int): FieldDispatch = if (f.registered.contains(name)) f else { ...f, registered: f.registered.union(Set(name)), definitions: f.definitions.put(name, definition), priorities: f.priorities.put(name, priority), cacheValid: false }
pure def unregisterField(f: FieldDispatch, name: str): FieldDispatch = if (f.registered.contains(name)) { ...f, registered: f.registered.exclude(Set(name)), cacheValid: false } else f
pure def composeSchema(f: FieldDispatch): FieldDispatch = { ...f, cacheValid: true }
pure def requiredFields(f: FieldDispatch, selection: Set[str], selected: bool): Set[str] = if (selected) f.registered.intersect(selection) else f.registered
```

### All active fields parse before handlers begin and preemption stops subsequent handlers

Dispatch snapshots the sorted registry so concurrent registration affects the next dispatch, and only the snapshot's fields await parsing. The active set is recomputed for each dispatch. Inactive fields and null parse results skip handling. Ordinary parse and activation exceptions add field errors and permit siblings. Cancellation aborts the dispatch. Handler errors add errors and permit later siblings. Preemption retains its requested mode and ends handling. Callback mutation applies only after successful parsing of every sibling. Equal-priority lexical ordering is an adapter contract over the source comparator and its captured fixtures.

```quint
pure def canBeginDispatch(f: FieldDispatch): bool = not(f.inFlight)
pure def beginDispatch(f: FieldDispatch): FieldDispatch = { ...f, inFlight: true, snapshot: f.registered, snapshotPriorities: f.priorities, pending: f.registered, ready: Set(), attempted: Set(), handled: Set(), errors: Set(), preempted: false, preemption: NoFieldPreemption, aborted: false }
pure def canParseField(f: FieldDispatch, name: str): bool = f.inFlight and not(f.aborted) and f.pending.contains(name)
pure def parseField(f: FieldDispatch, name: str, parseResult: ParseOutcome, hasHandler: bool): FieldDispatch = { ...f, pending: f.pending.exclude(Set(name)), ready: if (parseResult == ParsedOk and hasHandler) f.ready.union(Set(name)) else f.ready, errors: if (parseResult == SoftParseFailure or parseResult == HardParseFailure) f.errors.union(Set(name)) else f.errors, aborted: parseResult == CancelledField }
pure def canHandleField(f: FieldDispatch, name: str): bool = f.inFlight and f.pending.size() == 0 and not(f.aborted) and not(f.preempted) and f.ready.contains(name) and f.ready.forall(other => f.snapshotPriorities.getOr(other, 100) >= f.snapshotPriorities.getOr(name, 100))
pure def handleField(f: FieldDispatch, name: str, failed: bool, preempt: bool, cancelled: bool): FieldDispatch = { ...f, ready: f.ready.exclude(Set(name)), attempted: f.attempted.union(Set(name)), handled: if (failed or cancelled) f.handled else f.handled.union(Set(name)), errors: if (failed and not(cancelled)) f.errors.union(Set(name)) else f.errors, preempted: not(failed) and not(cancelled) and preempt, aborted: cancelled }
pure def canFinishDispatch(f: FieldDispatch): bool = f.inFlight and ((f.pending.size() == 0 and f.ready.size() == 0) or f.preempted or f.aborted)
pure def finishDispatch(f: FieldDispatch): FieldDispatch = { ...f, inFlight: false }
pure def alwaysOnlySnapshotHandled(f: FieldDispatch): bool = f.ready.subseteq(f.snapshot) and f.attempted.subseteq(f.snapshot) and f.handled.subseteq(f.attempted)
pure def alwaysPendingFromSnapshot(f: FieldDispatch): bool = f.pending.subseteq(f.snapshot)
pure def alwaysHandlersAfterParse(f: FieldDispatch): bool = f.attempted.size() > 0 implies f.pending.size() == 0
pure def alwaysAttemptedOnce(f: FieldDispatch): bool = f.ready.intersect(f.attempted).size() == 0
pure def sometimesSiblingErrorRecorded(f: FieldDispatch): bool = f.errors.size() > 0
pure def sometimesHandlerPreempts(f: FieldDispatch): bool = f.preempted
pure def sometimesDispatchCancelled(f: FieldDispatch): bool = f.aborted
```

### A successful handler's preemption request is kept exactly and is the run's only accepted preemption

When a handler's whole effect applies without failure, its requested preemption mode and reason are kept exactly, an empty reason included, and handling ends. The three modes `ack-and-stop`, `ignore` and `direct-reply` are distinct terminal requests. When every effect is a plain data record whose reads do not throw, the run's preemption and the preempting field's trace carry the same mode and reason, and no other field's trace holds a complete preemption. A field whose preempt read threw may keep only the partial trace marks described under the rule about throwing preempt reads. The model derives a field's trace preemption from the accepted preemption, so it states only this plain-data case. An accepted preemption names a handled field of a dispatch that was not cancelled, and it stays until the next dispatch begins.

```quint
type PreemptMode = AcknowledgeAndStop | IgnoreReply | DirectReply
type PreemptEffect = NoPreemptEffect | RequestPreempt({ mode: PreemptMode, reason: str })
type HandlerOutcome = HandlerReturned({ effect: PreemptEffect }) | HandlerCallbackFailed | HandlerEffectFailed | HandlerCallbackCancelled | HandlerEffectCancelled | HandlerSkippedSignalAborted
type FieldPreemption = NoFieldPreemption | PreemptedField({ field: str, mode: PreemptMode, reason: str })
pure def preemptModeLabel(mode: PreemptMode): str = match mode { | AcknowledgeAndStop => "ack-and-stop" | IgnoreReply => "ignore" | DirectReply => "direct-reply" }
pure def hasFieldPreemption(preemption: FieldPreemption): bool = match preemption { | PreemptedField(preempt) => true | _ => false }
pure def isPreempted(f: FieldDispatch): bool = hasFieldPreemption(f.preemption)
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
pure def canHandleFieldOutcome(f: FieldDispatch, name: str): bool = canHandleField(f, name)
pure def handleFieldOutcome(f: FieldDispatch, name: str, handlerResult: HandlerOutcome): FieldDispatch = {
  val preemption = handlerPreemption(name, handlerResult)
  { ...f, ready: f.ready.exclude(Set(name)), attempted: f.attempted.union(Set(name)), handled: if (completedCallback(handlerResult)) f.handled.union(Set(name)) else f.handled, errors: if (failedHandler(handlerResult)) f.errors.union(Set(name)) else f.errors, preempted: hasFieldPreemption(preemption), preemption: preemption, aborted: cancelledHandler(handlerResult) }
}
pure def alwaysPreemptionNamesHandledField(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => f.handled.contains(preempt.field) and f.preempted and not(f.aborted) | _ => true } }
pure def stepPreemptionPersistsUntilNextDispatch(before: FieldDispatch, via: str, after: FieldDispatch): bool = via != "beginDispatch" and isPreempted(before) implies after.preemption == before.preemption
pure def lawRequestedPreemptionRetained(f: FieldDispatch, name: str, mode: PreemptMode, reason: str): bool = {
  val handledField = handleFieldOutcome(f, name, HandlerReturned({ effect: RequestPreempt({ mode: mode, reason: reason }) }))
  hasPreemptEffect(runPreemption(handledField), mode, reason) and hasPreemptEffect(tracePreemption(handledField, name), mode, reason) and handledField.preempted and handledField.handled.contains(name)
}
pure def lawPreemptModesAreDistinct(mode: PreemptMode, other: PreemptMode): bool = mode != other implies preemptModeLabel(mode) != preemptModeLabel(other)
pure def lawRunAndTracePreemptionAgree(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => runPreemption(f) == tracePreemption(f, preempt.field) | _ => true } }
pure def lawOtherFieldTraceHasNoPreemption(f: FieldDispatch, name: str): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => name != preempt.field implies tracePreemption(f, name) == NoPreemptEffect | _ => true } }
pure def sometimesAcknowledgementPreemption(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => preempt.mode == AcknowledgeAndStop and preempt.reason == "" | _ => false } }
pure def sometimesIgnorePreemption(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => preempt.mode == IgnoreReply | _ => false } }
pure def sometimesDirectReplyPreemption(f: FieldDispatch): bool = { val preemption = f.preemption
  match preemption { | PreemptedField(preempt) => preempt.mode == DirectReply | _ => false } }
pure val handlerResultValues = Set(HandlerReturned({ effect: NoPreemptEffect }), HandlerReturned({ effect: RequestPreempt({ mode: AcknowledgeAndStop, reason: "" }) }), HandlerReturned({ effect: RequestPreempt({ mode: IgnoreReply, reason: "ignore" }) }), HandlerReturned({ effect: RequestPreempt({ mode: DirectReply, reason: "direct" }) }), HandlerCallbackFailed, HandlerEffectFailed, HandlerCallbackCancelled, HandlerEffectCancelled, HandlerSkippedSignalAborted)
```

### A handler that fails, is cancelled or is skipped never installs its preemption

A callback that throws records an error and leaves no handled trace, because the trace is marked handled only after the callback returns. A failure while applying a returned effect, a result mutation included, keeps the handled trace and records an error without installing the requested preemption. Cancellation aborts the dispatch: cancellation while applying a returned effect keeps the handled trace, and cancellation before the callback returns does not. This handled mark is internal state only: on cancellation the dispatch rejects with the cancellation and returns no run result. A handler whose turn signal is already aborted is skipped with no handled trace, no error and no cancellation, and dispatch returns normally.

```quint
pure def lawFailedHandlerDoesNotPreempt(f: FieldDispatch, name: str): bool = {
  val after = handleFieldOutcome(f, name, HandlerCallbackFailed)
  not(isPreempted(after)) and not(after.preempted) and after.errors.contains(name) and after.handled.subseteq(f.handled) and f.handled.subseteq(after.handled)
}
pure def lawEffectFailureDoesNotPreempt(f: FieldDispatch, name: str): bool = {
  val after = handleFieldOutcome(f, name, HandlerEffectFailed)
  not(isPreempted(after)) and not(after.preempted) and after.handled.contains(name) and after.errors.contains(name)
}
pure def lawCancelledHandlerDoesNotPreempt(f: FieldDispatch, name: str): bool = {
  val after = handleFieldOutcome(f, name, HandlerCallbackCancelled)
  not(isPreempted(after)) and after.aborted and after.handled.subseteq(f.handled) and f.handled.subseteq(after.handled) and after.errors.subseteq(f.errors) and f.errors.subseteq(after.errors)
}
pure def lawEffectCancellationKeepsHandledTrace(f: FieldDispatch, name: str): bool = {
  val after = handleFieldOutcome(f, name, HandlerEffectCancelled)
  not(isPreempted(after)) and after.aborted and after.handled.contains(name) and after.errors.subseteq(f.errors) and f.errors.subseteq(after.errors)
}
pure def lawSkippedHandlerLeavesNoTrace(f: FieldDispatch, name: str): bool = {
  val after = handleFieldOutcome(f, name, HandlerSkippedSignalAborted)
  not(isPreempted(after)) and not(after.aborted) and after.handled.subseteq(f.handled) and f.handled.subseteq(after.handled) and after.errors.subseteq(f.errors) and f.errors.subseteq(after.errors)
}
```

### A throwing preempt read leaves only the trace marks set before it and installs no run preemption

Applying a returned effect reads its preempt to test it, marks the field trace preempted, reads preempt and its mode into the trace, reads preempt and its reason into the trace, then reads preempt again to set the run's preemption. A throwing first read is an effect failure that leaves no preempted mark. A throwing mode read leaves only the preempted mark. A throwing reason read also leaves the mode. A throwing last read leaves all three trace marks. In every such case the run's preemption stays absent, the field records an effect failure and later siblings continue.

```quint
type PreemptGetterThrow = NoGetterThrows | FirstPreemptReadThrows | ModeReadThrows | ReasonReadThrows | RunPreemptReadThrows
type PreemptApplication = { tracePreempted: bool, traceModeSet: bool, traceReasonSet: bool, runPreempt: PreemptEffect, readFailed: bool }
pure def preemptReadsCompleted(thrown: PreemptGetterThrow): int = match thrown { | FirstPreemptReadThrows => 0 | ModeReadThrows => 1 | ReasonReadThrows => 2 | RunPreemptReadThrows => 3 | NoGetterThrows => 4 }
pure def isPreemptRequest(effect: PreemptEffect): bool = match effect { | RequestPreempt(preempt) => true | _ => false }
pure def applyPreemptReads(effect: PreemptEffect, thrown: PreemptGetterThrow): PreemptApplication = {
  val reads = preemptReadsCompleted(thrown)
  val requested = isPreemptRequest(effect)
  { tracePreempted: requested and reads >= 1, traceModeSet: requested and reads >= 2, traceReasonSet: requested and reads >= 3, runPreempt: if (requested and reads >= 4) effect else NoPreemptEffect, readFailed: if (requested) reads < 4 else reads < 1 }
}
pure val effectValues = Set(NoPreemptEffect, RequestPreempt({ mode: AcknowledgeAndStop, reason: "" }), RequestPreempt({ mode: IgnoreReply, reason: "ignore" }), RequestPreempt({ mode: DirectReply, reason: "direct" }))
pure def preemptReadOutcome(application: PreemptApplication): HandlerOutcome = if (application.readFailed) HandlerEffectFailed else HandlerReturned({ effect: application.runPreempt })
pure def lawCompletePreemptReadsRetainEffect(effect: PreemptEffect): bool = {
  val application = applyPreemptReads(effect, NoGetterThrows)
  application.runPreempt == effect and not(application.readFailed) and application.tracePreempted == isPreemptRequest(effect) and application.traceModeSet == isPreemptRequest(effect) and application.traceReasonSet == isPreemptRequest(effect)
}
pure def lawFirstPreemptReadFailureLeavesNoMark(effect: PreemptEffect): bool = {
  val application = applyPreemptReads(effect, FirstPreemptReadThrows)
  application.readFailed and not(application.tracePreempted) and not(application.traceModeSet) and not(application.traceReasonSet) and application.runPreempt == NoPreemptEffect
}
pure def lawModeReadFailureLeavesOnlyMark(mode: PreemptMode, reason: str): bool = {
  val application = applyPreemptReads(RequestPreempt({ mode: mode, reason: reason }), ModeReadThrows)
  application.readFailed and application.tracePreempted and not(application.traceModeSet) and not(application.traceReasonSet) and application.runPreempt == NoPreemptEffect
}
pure def lawReasonReadFailureAlsoLeavesMode(mode: PreemptMode, reason: str): bool = {
  val application = applyPreemptReads(RequestPreempt({ mode: mode, reason: reason }), ReasonReadThrows)
  application.readFailed and application.tracePreempted and application.traceModeSet and not(application.traceReasonSet) and application.runPreempt == NoPreemptEffect
}
pure def lawRunPreemptReadFailureLeavesTraceOnly(mode: PreemptMode, reason: str): bool = {
  val application = applyPreemptReads(RequestPreempt({ mode: mode, reason: reason }), RunPreemptReadThrows)
  application.readFailed and application.tracePreempted and application.traceModeSet and application.traceReasonSet and application.runPreempt == NoPreemptEffect
}
pure def lawThrowingPreemptReadIsEffectFailure(f: FieldDispatch, name: str, mode: PreemptMode, reason: str, thrown: PreemptGetterThrow): bool = {
  val after = handleFieldOutcome(f, name, preemptReadOutcome(applyPreemptReads(RequestPreempt({ mode: mode, reason: reason }), thrown)))
  thrown != NoGetterThrows implies (not(isPreempted(after)) and not(after.aborted) and after.handled.contains(name) and after.errors.contains(name))
}
```
