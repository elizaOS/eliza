# Task request and view codecs

What a task command, an event query and a task view must look like on the
wire. The [owner fence](./ownerFence.md) owns authentication, dispatch and
publication, [task lifecycle](../client/taskLifecycle.md) the client's
requests, and [task events](../../core/taskEventReader.md) the event records.

## Story: Admit only the renderer's documented task commands

> As a user, a task command reaches my task only when it is one the renderer
> documents, with exactly the fields it needs; anything malformed changes
> nothing.

### Task IDs and goal references follow one bounded grammar, and only references allow a slash

An ID or reference has 1 to 256 characters, begins with an ASCII letter or
digit, and continues with ASCII letters, digits, underscore, dot, colon, at
and hyphen; a goal reference may also contain a slash. A route segment is
matched without percent-decoding, so an encoded character is outside both.

```quint
import numbers as Num from "../../core/numbers"
type ReferenceShape = { length: int, startsAlnum: bool, tailAllowed: bool, hasSlash: bool }
pure def taskReference(ref: ReferenceShape, allowSlash: bool): bool =
  ref.length >= 1 and ref.length <= 256 and ref.startsAlnum and ref.tailAllowed and (allowSlash or not(ref.hasSlash))
pure val plainRef: ReferenceShape = { length: 8, startsAlnum: true, tailAllowed: true, hasSlash: false }
pure val refValues = Set(plainRef, { ...plainRef, hasSlash: true }, { ...plainRef, length: 257 }, { ...plainRef, length: 0 },
  { ...plainRef, startsAlnum: false }, { ...plainRef, tailAllowed: false })
pure def lawTaskIdsAreGoalReferences(ref: ReferenceShape): bool = taskReference(ref, false) implies taskReference(ref, true)
pure def lawOnlyGoalReferencesHoldSlash(ref: ReferenceShape): bool = ref.hasSlash implies not(taskReference(ref, false))
```

### A malformed, oversized or unexpected body changes nothing

A body is JSON (`application/json`, optionally with parameters), present,
at most 2,048 bytes, valid UTF-8 and an object, before its fields are read.
Each command then has an exact field set: start has only `goalRef`; pause
current has none, or only `reason: "close"`; pause by ID has
`expectedRevision`, a nonnegative safe integer, and optionally
`reason: "close"`; resume, cancel and acknowledging an unknown outcome have
only `expectedRevision`; acknowledging an unreadable record has none.
Anything else is refused before the store is touched.

```quint
type TaskCommand = StartTask | PauseCurrent | PauseById | ResumeById | CancelById | AcknowledgeUnknown | AcknowledgeUnreadable
type TaskBody = { jsonMedia: bool, present: bool, byteCount: int, validUtf8: bool, objectJson: bool, keyCount: int,
  hasReason: bool, closeReason: bool, hasGoal: bool, goal: ReferenceShape, hasRevisionInteger: bool, revision: int }
pure def taskNonnegativeSafe(number: int): bool = number >= 0 and number <= Num::maxSafeInteger
pure def bodyEnvelope(input: TaskBody): bool =
  input.jsonMedia and input.present and input.byteCount > 0 and input.byteCount <= 2048 and input.validUtf8 and input.objectJson
pure def bodyRevision(input: TaskBody): bool = input.hasRevisionInteger and taskNonnegativeSafe(input.revision)
pure def taskBodyAdmitted(command: TaskCommand, input: TaskBody): bool = bodyEnvelope(input) and (
  if (command == StartTask) input.keyCount == 1 and input.hasGoal and taskReference(input.goal, true)
  else if (command == PauseCurrent) input.keyCount == 0 or (input.keyCount == 1 and input.hasReason and input.closeReason)
  else if (command == AcknowledgeUnreadable) input.keyCount == 0
  else if (command == PauseById and input.hasReason) input.keyCount == 2 and input.closeReason and bodyRevision(input)
  else input.keyCount == 1 and bodyRevision(input))
pure def lawInvalidEnvelopeCannotMutate(command: TaskCommand, input: TaskBody): bool = not(bodyEnvelope(input)) implies not(taskBodyAdmitted(command, input))
pure def lawCloseRemainsAnExplicitPause(command: TaskCommand, input: TaskBody): bool =
  taskBodyAdmitted(command, input) and (command == PauseCurrent or command == PauseById) and input.hasReason implies input.closeReason
pure def lawRevisionRequiredOnMutationById(command: TaskCommand, input: TaskBody): bool =
  taskBodyAdmitted(command, input) and command != AcknowledgeUnreadable and command != PauseCurrent and command != StartTask implies bodyRevision(input)
pure val normalBody: TaskBody = { jsonMedia: true, present: true, byteCount: 22, validUtf8: true, objectJson: true, keyCount: 1,
  hasReason: false, closeReason: false, hasGoal: false, goal: plainRef, hasRevisionInteger: true, revision: 0 }
pure val inputValues = Set(normalBody, { ...normalBody, byteCount: 2048 }, { ...normalBody, byteCount: 2049 },
  { ...normalBody, keyCount: 0, hasRevisionInteger: false }, { ...normalBody, hasReason: true, closeReason: true, keyCount: 2 },
  { ...normalBody, hasReason: true }, { ...normalBody, validUtf8: false }, { ...normalBody, jsonMedia: false },
  { ...normalBody, hasGoal: true, goal: { ...plainRef, hasSlash: true }, hasRevisionInteger: false })
```

### An event cursor is absent, -1 or a safe nonnegative integer no greater than the revision

An event query has no entries, or exactly one `after`. A missing cursor and
`-1` both start before the first event; otherwise the cursor is `0` or a
decimal without a leading zero, a safe integer no greater than the task's
revision. Anything else is `TASK_INVALID` and admits no page. Other task
routes refuse any query.

```quint
type CursorQuery = { entries: int, namedAfter: bool, canonicalDecimal: bool, safeInteger: bool, after: int }
type Cursor = { valid: bool, after: int }
pure val badCursor: Cursor = { valid: false, after: -1 }
pure val firstCursor: Cursor = { valid: true, after: -1 }
pure def taskEventCursor(query: CursorQuery): Cursor =
  if (query.entries == 0) firstCursor
  else if (query.entries != 1 or not(query.namedAfter) or not(query.canonicalDecimal)) badCursor
  else if (query.after == -1 or (query.safeInteger and taskNonnegativeSafe(query.after))) { valid: true, after: query.after }
  else badCursor
pure def taskCursorAllowed(query: CursorQuery, revision: int): bool = {
  val cursor = taskEventCursor(query)
  cursor.valid and cursor.after <= revision
}
pure val firstQuery: CursorQuery = { entries: 1, namedAfter: true, canonicalDecimal: true, safeInteger: true, after: 1 }
pure val queryValues = Set(firstQuery, { ...firstQuery, entries: 0 }, { ...firstQuery, entries: 2 }, { ...firstQuery, namedAfter: false },
  { ...firstQuery, canonicalDecimal: false }, { ...firstQuery, after: -1 }, { ...firstQuery, safeInteger: false })
pure def lawAbsentCursorStartsAtFirst(query: CursorQuery): bool = query.entries == 0 implies taskEventCursor(query) == firstCursor
pure def lawRepeatedQueryCannotAdmitPage(query: CursorQuery, revision: int): bool = query.entries > 1 implies not(taskCursorAllowed(query, revision))
pure def lawUnsafeCursorIsRefused(query: CursorQuery, revision: int): bool = (query.entries == 1 and not(query.safeInteger)) implies not(taskCursorAllowed(query, revision))
```

## Story: Deliver only a detached view of the task the host returned

> As a user, my screen shows a copy of the task the host returned, with only
> its public fields, and nothing it shows can change the task behind it.

### A renderer receives six public fields or an explicit null

The host projects only the schema version, ID, revision, epoch, status and
whether any operation's outcome is unknown. A reply must have a `task`
member: null means no task, and a value needs version 1, a valid task ID,
two nonnegative safe integers, one of six statuses and a boolean flag. The
client copies those six fields and ignores the rest; anything else is
invalid, never absence.

```quint
type TaskStatus = TaskActive | TaskPaused | TaskBlocked | TaskWaiting | TaskCompleted | TaskCancelled
type TaskView = { schemaVersion: int, id: str, revision: int, epoch: int, status: TaskStatus, hasUnknownOutcome: bool }
type TaskViewWire = { hasTask: bool, nullTask: bool, objectTask: bool, idShape: ReferenceShape, statusKnown: bool, unknownBoolean: bool, value: TaskView }
type TaskViewResult = TaskViewInvalid | TaskViewAbsent | TaskViewPresent(TaskView)
pure def projectTask(version: int, id: str, revision: int, epoch: int, status: TaskStatus, operationStatuses: List[str]): TaskView =
  { schemaVersion: version, id: id, revision: revision, epoch: epoch, status: status, hasUnknownOutcome: operationStatuses.some(operation => operation == "unknown") }
pure def validTaskView(wire: TaskViewWire): bool =
  wire.objectTask and wire.value.schemaVersion == 1 and taskReference(wire.idShape, false) and
    taskNonnegativeSafe(wire.value.revision) and taskNonnegativeSafe(wire.value.epoch) and wire.statusKnown and wire.unknownBoolean
pure def admitTaskView(wire: TaskViewWire): TaskViewResult =
  if (not(wire.hasTask)) TaskViewInvalid
  else if (wire.nullTask) TaskViewAbsent
  else if (validTaskView(wire)) TaskViewPresent({ schemaVersion: 1, id: wire.value.id, revision: wire.value.revision, epoch: wire.value.epoch, status: wire.value.status, hasUnknownOutcome: wire.value.hasUnknownOutcome })
  else TaskViewInvalid
pure def lawMalformedTaskDoesNotBecomeAbsence(wire: TaskViewWire): bool =
  not(wire.hasTask) or (not(wire.nullTask) and not(validTaskView(wire))) implies admitTaskView(wire) == TaskViewInvalid
pure def lawExplicitNullIsAbsent(wire: TaskViewWire): bool = wire.hasTask and wire.nullTask implies admitTaskView(wire) == TaskViewAbsent
pure val sampleView: TaskView = { schemaVersion: 1, id: "A", revision: 0, epoch: 0, status: TaskActive, hasUnknownOutcome: false }
pure val sampleViewWire: TaskViewWire = { hasTask: true, nullTask: false, objectTask: true, idShape: plainRef, statusKnown: true, unknownBoolean: true, value: sampleView }
pure val wireValues = Set(sampleViewWire, { ...sampleViewWire, nullTask: true }, { ...sampleViewWire, hasTask: false },
  { ...sampleViewWire, idShape: { ...plainRef, hasSlash: true } }, { ...sampleViewWire, value: { ...sampleView, revision: -1 } },
  { ...sampleViewWire, statusKnown: false }, { ...sampleViewWire, unknownBoolean: false })
```
