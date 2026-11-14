# Task request and view codecs

Grace builds and calls Eliza `7743504b7c936a764b3938a44cad918808b621df` through `packages/agent/src/services/interactive-task-http.ts` and `packages/host/native-host/task-runtime-gateway.mjs`. Grace's `apps/app/src/task-lifecycle.ts` consumes `packages/ui/src/api/task-lifecycle.ts` at the same pin. The [owner fence](./taskOwner.md) owns authentication, dispatch and response publication. [Task lifecycle](./taskLifecycleClient.md) owns stale client replies. [Task events](../../core/taskEventReader.md) owns the event records and merge. This codec supplies typed routes and detached task views to those models.

## Story: Admit only the renderer's documented task commands

### Task IDs and goal references retain their exact grammar

Match JavaScript UTF-16 units without Unicode case folding. An ID or reference begins with an ASCII letter or digit and has at most 256 units. The tail permits ASCII letters, digits, underscore, dot, colon, at and hyphen. Only goal references also permit slash. Route matching uses `URL.pathname` without percent-decoding segments, so a percent-encoded character is outside both grammars.

```quint
pure def taskAsciiDigit(unit: int): bool = unit >= 48 and unit <= 57
pure def taskAsciiAlnum(unit: int): bool = taskAsciiDigit(unit) or (unit >= 65 and unit <= 90) or (unit >= 97 and unit <= 122)
pure def taskRefTail(unit: int, allowSlash: bool): bool = taskAsciiAlnum(unit) or unit == 95 or unit == 46 or unit == 58 or unit == 64 or unit == 45 or (allowSlash and unit == 47)
pure def taskReference(units: List[int], allowSlash: bool): bool = units.length() >= 1 and units.length() <= 256 and taskAsciiAlnum(units.nthOr(0, -1)) and units.every(unit => taskRefTail(unit, allowSlash))
pure def lawTaskIdsAreGoalReferences(units: List[int]): bool = taskReference(units, false) implies taskReference(units, true)
pure def lawTaskReferenceStartsWithAsciiAlnum(units: List[int], allowSlash: bool): bool = taskReference(units, allowSlash) implies taskAsciiAlnum(units.nthOr(0, -1))
pure def lawTaskReferenceLengthIsBounded(units: List[int], allowSlash: bool): bool = taskReference(units, allowSlash) implies units.length() > 0 and units.length() <= 256
pure val unitsValues = Set(List(), List(65), List(65, 47), List(65, 37, 51, 70), List(65, 10), List(47, 65), List(65, 95, 46, 58, 64, 45), List(233))
```

### JSON and field admission precede mutation

The framework supplies wire bytes, stream failure, fatal UTF-8 decode and JSON value shape. Match `application/json` case insensitively, either alone or followed by ECMAScript whitespace and a semicolon. This media-type test does not interpret the parameter text. A body is present and has at most 2,048 actual bytes. These checks precede an exact object field count. Start has only `goalRef`. Pause current has no fields or only `reason: "close"`. Pause by ID has the nonnegative safe integer `expectedRevision` and optionally `reason: "close"`. Resume, cancel and acknowledge unknown have only `expectedRevision`. Acknowledge unreadable has an empty object. The two acknowledgement routes belong to the native gateway and a malformed input never invokes their store methods.

```quint
type TaskCommand = StartTask | PauseCurrent | PauseById | ResumeById | CancelById | AcknowledgeUnknown | AcknowledgeUnreadable
type TaskBody = { contentType: List[int], present: bool, byteCount: int, validUtf8: bool, objectJson: bool, keyCount: int, hasReason: bool, closeReason: bool, hasGoalString: bool, goalUnits: List[int], hasRevisionInteger: bool, revision: int }
pure val jsonMedia: List[int] = List(97, 112, 112, 108, 105, 99, 97, 116, 105, 111, 110, 47, 106, 115, 111, 110)
pure def lowerMedia(unit: int): int = if (unit >= 65 and unit <= 90) unit + 32 else unit
pure def mediaWhitespace(unit: int): bool = (unit >= 9 and unit <= 13) or unit == 32 or unit == 160 or unit == 5760 or (unit >= 8192 and unit <= 8202) or unit == 8232 or unit == 8233 or unit == 8239 or unit == 8287 or unit == 12288 or unit == 65279
type MediaWalk = { offset: int, prefix: bool, stillWhitespace: bool, semicolon: bool }
pure def jsonContentType(media: List[int]): bool = {
  val seen = media.foldl({ offset: 0, prefix: true, stillWhitespace: true, semicolon: false }, (walk, unit) =>
    if (walk.offset < 16) { ...walk, offset: walk.offset + 1, prefix: walk.prefix and lowerMedia(unit) == jsonMedia.nthOr(walk.offset, -1) }
    else { ...walk, offset: walk.offset + 1, stillWhitespace: walk.stillWhitespace and mediaWhitespace(unit), semicolon: walk.semicolon or (walk.stillWhitespace and unit == 59) })
  seen.prefix and (seen.offset == 16 or seen.semicolon)
}
pure def taskNonnegativeSafe(number: int): bool = number >= 0 and number <= 9007199254740991
pure def bodyEnvelope(input: TaskBody): bool = jsonContentType(input.contentType) and input.present and input.byteCount > 0 and input.byteCount <= 2048 and input.validUtf8 and input.objectJson
pure def bodyRevision(input: TaskBody): bool = input.hasRevisionInteger and taskNonnegativeSafe(input.revision)
pure def taskBodyAdmitted(command: TaskCommand, input: TaskBody): bool = bodyEnvelope(input) and (
  if (command == StartTask) input.keyCount == 1 and input.hasGoalString and taskReference(input.goalUnits, true)
  else if (command == PauseCurrent) input.keyCount == 0 or (input.keyCount == 1 and input.hasReason and input.closeReason)
  else if (command == AcknowledgeUnreadable) input.keyCount == 0
  else if (command == PauseById and input.hasReason) input.keyCount == 2 and input.closeReason and bodyRevision(input)
  else input.keyCount == 1 and bodyRevision(input))
pure def lawInvalidEnvelopeCannotMutate(command: TaskCommand, input: TaskBody): bool = not(bodyEnvelope(input)) implies not(taskBodyAdmitted(command, input))
pure def lawCloseRemainsAnExplicitPause(command: TaskCommand, input: TaskBody): bool = taskBodyAdmitted(command, input) and (command == PauseCurrent or command == PauseById) and input.hasReason and input.keyCount > 0 implies input.closeReason
pure def lawRevisionRequiredOnMutationById(command: TaskCommand, input: TaskBody): bool = taskBodyAdmitted(command, input) and command != AcknowledgeUnreadable and command != PauseCurrent and command != StartTask implies bodyRevision(input)
pure val normalBody: TaskBody = { contentType: jsonMedia, present: true, byteCount: 22, validUtf8: true, objectJson: true, keyCount: 1, hasReason: false, closeReason: false, hasGoalString: false, goalUnits: List(), hasRevisionInteger: true, revision: 0 }
pure val inputValues = Set(normalBody, { ...normalBody, byteCount: 2048 }, { ...normalBody, byteCount: 2049 }, { ...normalBody, keyCount: 0, hasRevisionInteger: false }, { ...normalBody, hasReason: true, closeReason: true, keyCount: 2 }, { ...normalBody, hasReason: true }, { ...normalBody, validUtf8: false }, { ...normalBody, contentType: List(97) }, { ...normalBody, hasGoalString: true, goalUnits: List(103, 47, 48), hasRevisionInteger: false })
```

### An event cursor preserves the default and refuses rounding

An event query has zero entries, or exactly one decoded `after` entry. Missing `after` and the literal `-1` both start before sequence zero. The remaining accepted spellings are `0` or an unsigned decimal starting with 1–9. Accumulate digits only while the result is a safe integer. Malformed or unsafe cursors produce `TASK_INVALID` before an event page is admitted. The pinned HTTP layer parses decimal syntax first and its event store separately rejects unsafe values and cursors beyond the current revision. Other core task routes reject a nonempty query. The gateway's owner record routes match on pathname before the product extension and do not impose the core query rule.

```quint
type TaskQueryEntry = { name: str, value: List[int] }
type Cursor = { valid: bool, after: int }
pure val badCursor: Cursor = { valid: false, after: -1 }
pure val firstCursor: Cursor = { valid: true, after: -1 }
pure def cursorDigit(cursor: Cursor, unit: int): Cursor =
  if (not(cursor.valid) or not(taskAsciiDigit(unit)) or cursor.after > 900719925474099 or (cursor.after == 900719925474099 and unit > 49)) badCursor
  else { valid: true, after: cursor.after * 10 + (unit - 48) }
pure def decodeCursor(value: List[int]): Cursor =
  if (value == List(45, 49)) firstCursor
  else if (value == List(48)) { valid: true, after: 0 }
  else if (value.nthOr(0, -1) < 49 or value.nthOr(0, -1) > 57) badCursor
  else value.foldl({ valid: true, after: 0 }, cursorDigit)
pure def taskEventCursor(query: List[TaskQueryEntry]): Cursor = {
  val first = query.nthOr(0, { name: "", value: List() })
  if (query.length() == 0) firstCursor
  else if (query.length() != 1 or first.name != "after") badCursor
  else decodeCursor(first.value)
}
pure def taskCursorAllowed(query: List[TaskQueryEntry], revision: int): bool = {
  val cursor = taskEventCursor(query)
  cursor.valid and cursor.after <= revision
}
pure def lawAbsentCursorStartsAtFirst(query: List[TaskQueryEntry]): bool = query.length() == 0 implies taskEventCursor(query) == firstCursor
pure def lawRepeatedQueryCannotAdmitPage(query: List[TaskQueryEntry], revision: int): bool = query.length() > 1 implies not(taskCursorAllowed(query, revision))
pure def lawCursorNeverSkipsPastHead(query: List[TaskQueryEntry], revision: int): bool = taskCursorAllowed(query, revision) implies taskEventCursor(query).after <= revision
pure val queryValues = Set(List(), List({ name: "after", value: List(45, 49) }), List({ name: "after", value: List(48, 49) }), List({ name: "after", value: List(49) }, { name: "after", value: List(48) }), List({ name: "other", value: List(49) }), List({ name: "after", value: List(49, 50, 56) }))
```

## Story: Deliver only a detached view of the task the host returned

### A renderer receives six public fields or an explicit null

The pinned host projects `schemaVersion`, `id`, `revision`, `epoch`, `status`, and `hasUnknownOutcome` only. `hasUnknownOutcome` is derived from the existence of an operation whose status is `unknown`. The shared UI checks that a reply has a `task` member. A null task means no task. A value requires version 1, a valid ID, two nonnegative safe integers, one of six status strings and a boolean unknown-outcome flag. The UI copies those six fields and ignores extras in the incoming object. The original string is supplied with its exact UTF-16 encoding. Type observations at this seam come from native JSON for real requests.

```quint
type TaskView = { schemaVersion: int, id: str, revision: int, epoch: int, status: str, hasUnknownOutcome: bool }
type TaskViewWire = { hasTask: bool, nullTask: bool, objectTask: bool, idString: bool, idUnits: List[int], revisionInteger: bool, epochInteger: bool, unknownBoolean: bool, value: TaskView }
type TaskViewResult = TaskViewInvalid | TaskViewAbsent | TaskViewPresent(TaskView)
pure val invalidTaskViewResult: TaskViewResult = TaskViewInvalid
pure val absentTaskViewResult: TaskViewResult = TaskViewAbsent
pure def taskStatus(status: str): bool = status == "active" or status == "paused" or status == "blocked" or status == "waiting" or status == "completed" or status == "cancelled"
pure def projectTask(version: int, id: str, revision: int, epoch: int, status: str, operationStatuses: List[str]): TaskView = { schemaVersion: version, id: id, revision: revision, epoch: epoch, status: status, hasUnknownOutcome: operationStatuses.some(operation => operation == "unknown") }
pure def validTaskView(wire: TaskViewWire): bool = wire.objectTask and wire.value.schemaVersion == 1 and wire.idString and taskReference(wire.idUnits, false) and wire.revisionInteger and taskNonnegativeSafe(wire.value.revision) and wire.epochInteger and taskNonnegativeSafe(wire.value.epoch) and taskStatus(wire.value.status) and wire.unknownBoolean
pure def admitTaskView(wire: TaskViewWire): TaskViewResult =
  if (not(wire.hasTask)) TaskViewInvalid
  else if (wire.nullTask) TaskViewAbsent
  else if (validTaskView(wire)) TaskViewPresent({ schemaVersion: 1, id: wire.value.id, revision: wire.value.revision, epoch: wire.value.epoch, status: wire.value.status, hasUnknownOutcome: wire.value.hasUnknownOutcome })
  else TaskViewInvalid
pure def lawUnknownOutcomeComesFromEvidence(version: int, id: str, revision: int, epoch: int, status: str, operationStatuses: List[str]): bool = projectTask(version, id, revision, epoch, status, operationStatuses).hasUnknownOutcome == operationStatuses.some(operation => operation == "unknown")
pure def lawMalformedTaskDoesNotBecomeAbsence(wire: TaskViewWire): bool = not(wire.hasTask) or (not(wire.nullTask) and not(validTaskView(wire))) implies admitTaskView(wire) == invalidTaskViewResult
pure def lawExplicitNullIsAbsent(wire: TaskViewWire): bool = wire.hasTask and wire.nullTask implies admitTaskView(wire) == absentTaskViewResult
pure val sampleView: TaskView = { schemaVersion: 1, id: "A", revision: 0, epoch: 0, status: "active", hasUnknownOutcome: false }
pure val sampleViewWire: TaskViewWire = { hasTask: true, nullTask: false, objectTask: true, idString: true, idUnits: List(65), revisionInteger: true, epochInteger: true, unknownBoolean: true, value: sampleView }
pure val wireValues = Set(sampleViewWire, { ...sampleViewWire, nullTask: true }, { ...sampleViewWire, hasTask: false }, { ...sampleViewWire, idUnits: List(65, 47) }, { ...sampleViewWire, epochInteger: false }, { ...sampleViewWire, value: { ...sampleView, revision: -1 } }, { ...sampleViewWire, value: { ...sampleView, status: "unknown" } }, { ...sampleViewWire, unknownBoolean: false })
pure val operationStatusesValues = Set(List(), List("succeeded"), List("unknown"), List("cancelled", "unknown"))
```
