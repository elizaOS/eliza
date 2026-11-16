# Task journal records across builds

Task documents and their recovery records, across builds that may not read
them. The task kernel owns the transition for a readable record; this spec
owns the decisions before it, the durable release of an unreadable record,
and whether a native update may proceed.

## Story: Preserve task records when a build cannot read them

> As a user, when a new build cannot read a task record it keeps the record
> aside instead of deleting it, until it can be recovered or I acknowledge
> it.

### A structural task failure can be recorded separately from corrupt storage

A missing row is absence. A stored document must be text containing valid JSON. A torn or nontext row is corruption. A parsed value the task validator rejects with `TASK_INVALID` is eligible for quarantine, with the validator's diagnostic as its reason. A valid task whose embedded owner or whose explicitly requested ID differs from the indexed row is corruption when that identity is checked. Quarantined rows fail by-ID reads as `TASK_UNREADABLE`, while current-task lookup skips them. By-ID lookup excludes another owner's row before interpreting the document. On startup the scan inspects the owner's nonquarantined history in ascending ID pages of 64. Torn historical rows do not gain quarantine entries and can still fail a direct read. A torn current row fails recovery. SQL and validation failures retain their typed outcomes.

```quint
import numbers as Num from "../../core/numbers"
type DocumentResult = TaskDecoded | TaskShapeInvalid | TaskBytesCorrupt
type Quarantine = RecordVisible | RecordHeld | RecordAcknowledged
pure def eligibleForQuarantine(document: DocumentResult): bool = document == TaskShapeInvalid
pure def readsAsTask(sameOwner: bool, quarantine: Quarantine, document: DocumentResult, matchingIdentity: bool): str =
  if (not(sameOwner)) "absent"
  else if (quarantine != RecordVisible) "TASK_UNREADABLE"
  else if (document == TaskBytesCorrupt) "TASK_STORAGE_CORRUPT"
  else if (document == TaskShapeInvalid) "TASK_INVALID"
  else if (not(matchingIdentity)) "TASK_STORAGE_CORRUPT"
  else "task"
pure def lawTornBytesAreNeverVersionQuarantine(document: DocumentResult): bool =
  document == TaskBytesCorrupt implies not(eligibleForQuarantine(document))
pure def lawOtherOwnersDoNotReadQuarantinedRows(sameOwner: bool, quarantine: Quarantine, document: DocumentResult, matchingIdentity: bool): bool =
  not(sameOwner) implies readsAsTask(sameOwner, quarantine, document, matchingIdentity) == "absent"
pure def lawRequestedIdentityDoesNotBorrowEmbeddedTask(document: DocumentResult, matchingIdentity: bool): bool =
  document == TaskDecoded and not(matchingIdentity) implies readsAsTask(true, RecordVisible, document, matchingIdentity) == "TASK_STORAGE_CORRUPT"
pure def lawVisibleCorruptionIsTyped(document: DocumentResult, matchingIdentity: bool): bool =
  document == TaskBytesCorrupt implies readsAsTask(true, RecordVisible, document, matchingIdentity) == "TASK_STORAGE_CORRUPT"
```

### Recovery and acknowledgement have distinct authority over the slot

A task's original unreadable document stays in the journal. A build that can decode a held record removes the quarantine entry only while acknowledgement is absent. An acknowledged record stays set aside after a build can read it. Acknowledgement requires the exact owner and task with no prior `acknowledgedAt`. It writes the acknowledgement timestamp and releases `unfinished` in one transaction. The original document and recovery reason remain. An unfinished quarantine entry blocks a different task for its owner with `TASK_UNREADABLE`. An occupied readable slot or an existing task ID yields `TASK_CONFLICT`, even after the original record's slot was released. A historical record without the unfinished flag does not block a new task, even if it has an unacknowledged entry.

A recovery of a readable unfinished row may rewrite its bytes and append an
event through the kernel, and never dispatches an effect. A transaction that
fails before commit leaves its durable input unchanged; a failed rollback is
`TASK_STORAGE_UNCERTAIN` and the connection is discarded.

```quint
type JournalRow = { installed: bool, ownerKey: str, taskId: str, documentId: str, document: DocumentResult, reason: str, unfinished: bool, quarantine: Quarantine, quarantinedAt: int, acknowledgedAt: int, kernelWrites: int }
pure val initial: JournalRow = { installed: false, ownerKey: "", taskId: "", documentId: "", document: TaskDecoded, reason: "", unfinished: false, quarantine: RecordVisible, quarantinedAt: 0, acknowledgedAt: 0, kernelWrites: 0 }
pure def canEncounterRow(row: JournalRow, ownerKey: str, taskId: str, documentId: str, document: DocumentResult, reason: str, unfinished: bool): bool =
  not(row.installed) and ownerKey != "" and taskId != "" and documentId != "" and (reason != "" iff document == TaskShapeInvalid)
pure def encounterRow(row: JournalRow, ownerKey: str, taskId: str, documentId: str, document: DocumentResult, reason: str, unfinished: bool): JournalRow =
  { ...row, installed: true, ownerKey: ownerKey, taskId: taskId, documentId: documentId, document: document, reason: reason, unfinished: unfinished }
pure def canSelectBuild(row: JournalRow, decodes: bool, reason: str): bool =
  row.installed and row.document != TaskBytesCorrupt and (decodes iff reason == "")
pure def selectBuild(row: JournalRow, decodes: bool, reason: str): JournalRow =
  { ...row, document: if (decodes) TaskDecoded else TaskShapeInvalid, reason: if (row.quarantine == RecordVisible) reason else row.reason }
pure def canRecoverRow(row: JournalRow, at: int, committed: bool): bool = row.installed and row.kernelWrites < Num::maxSafeInteger
pure def recoverRow(row: JournalRow, at: int, committed: bool): JournalRow =
  if (not(committed) or row.quarantine == RecordAcknowledged) row
  else if (row.quarantine == RecordVisible and eligibleForQuarantine(row.document))
    { ...row, quarantine: RecordHeld, quarantinedAt: at }
  else if (row.document == TaskDecoded)
    { ...row, quarantine: RecordVisible, quarantinedAt: 0, reason: "", kernelWrites: row.kernelWrites + (if (row.unfinished) 1 else 0) }
  else row
pure def canAcknowledgeRow(row: JournalRow, byOwner: str, claimedId: str): bool =
  row.installed and row.ownerKey == byOwner and row.taskId == claimedId and row.quarantine == RecordHeld
pure def acknowledgeRow(row: JournalRow, byOwner: str, claimedId: str, at: int, committed: bool): JournalRow =
  if (committed and canAcknowledgeRow(row, byOwner, claimedId)) { ...row, unfinished: false, quarantine: RecordAcknowledged, acknowledgedAt: at } else row
pure def acknowledgeRefusal(row: JournalRow, byOwner: str, claimedId: str): str =
  if (canAcknowledgeRow(row, byOwner, claimedId)) "" else "TASK_NOT_FOUND"
pure def admissionFromRows(existingId: bool, ownerSlot: bool, ownerSlotQuarantined: bool): str =
  if ((existingId or ownerSlot) and ownerSlot and ownerSlotQuarantined) "TASK_UNREADABLE"
  else if (existingId or ownerSlot) "TASK_CONFLICT"
  else ""
pure def createRefusal(row: JournalRow, byOwner: str, claimedId: str): str =
  admissionFromRows(row.installed and row.taskId == claimedId, row.installed and row.ownerKey == byOwner and row.unfinished, row.quarantine != RecordVisible)
pure def currentLookup(row: JournalRow, byOwner: str, matchingIdentity: bool): str =
  if (row.installed and row.unfinished and row.quarantine == RecordVisible)
    readsAsTask(row.ownerKey == byOwner, row.quarantine, row.document, matchingIdentity)
  else "absent"
pure def recoveryRefusal(row: JournalRow, matchingOwner: bool): str =
  if (row.installed and row.unfinished and row.quarantine != RecordAcknowledged and ((row.quarantine == RecordVisible and row.document == TaskBytesCorrupt) or (row.document == TaskDecoded and not(matchingOwner)))) "TASK_STORAGE_CORRUPT" else ""
pure def alwaysAcknowledgedRowNeverOccupiesSlot(row: JournalRow): bool =
  row.quarantine == RecordAcknowledged implies row.installed and not(row.unfinished)
pure def alwaysOnlyQuarantineHasTime(row: JournalRow): bool =
  (row.quarantine == RecordVisible implies row.quarantinedAt == 0) and (row.quarantine != RecordAcknowledged implies row.acknowledgedAt == 0)
pure def stepAcknowledgementIsFinal(before: JournalRow, after: JournalRow): bool =
  before.quarantine == RecordAcknowledged implies after.quarantine == RecordAcknowledged and before.acknowledgedAt == after.acknowledgedAt
pure def stepEvidenceIdentityNeverChanges(before: JournalRow, after: JournalRow): bool =
  before.installed implies after.installed and before.ownerKey == after.ownerKey and before.taskId == after.taskId and before.documentId == after.documentId
pure def lawCommittedReadableRecoveryReopensOnlyHeldRow(row: JournalRow, at: int): bool =
  canRecoverRow(row, at, true) and row.document == TaskDecoded and row.quarantine == RecordHeld implies
    recoverRow(row, at, true).quarantine == RecordVisible and recoverRow(row, at, true).unfinished == row.unfinished
pure def lawTornCurrentFailsRecovery(row: JournalRow, matchingOwner: bool): bool =
  row.installed and row.unfinished and row.quarantine == RecordVisible and row.document == TaskBytesCorrupt implies recoveryRefusal(row, matchingOwner) == "TASK_STORAGE_CORRUPT"
pure def lawRolledBackRecoveryPreservesDurableRow(row: JournalRow, at: int): bool = recoverRow(row, at, false) == row
pure def lawUnreadableSlotBlocksOnlyItsOwner(row: JournalRow, byOwner: str, claimedId: str): bool =
  row.installed and row.ownerKey == byOwner and row.unfinished and row.quarantine != RecordVisible implies
    createRefusal(row, byOwner, claimedId) == "TASK_UNREADABLE"
pure def lawReleasedRecordKeepsItsIdentity(row: JournalRow, byOwner: str): bool =
  row.installed and row.quarantine == RecordAcknowledged and not(row.unfinished) implies createRefusal(row, byOwner, row.taskId) == "TASK_CONFLICT"
pure def lawOtherOwnerCannotAcknowledge(row: JournalRow, byOwner: str, claimedId: str): bool =
  row.ownerKey != byOwner implies acknowledgeRefusal(row, byOwner, claimedId) == "TASK_NOT_FOUND"
pure def sometimesUnreadableBlocksWithoutCurrentTask(row: JournalRow): bool =
  row.installed and row.unfinished and row.quarantine == RecordHeld and currentLookup(row, row.ownerKey, true) == "absent"
pure def sometimesRecoveredRecordContinuesToOwnSlot(row: JournalRow): bool =
  row.installed and row.unfinished and row.quarantine == RecordVisible and row.kernelWrites > 0
pure def sometimesAcknowledgementReleasesSlot(row: JournalRow): bool = row.quarantine == RecordAcknowledged and not(row.unfinished)
pure val ownerKeyValues = Set("owner1", "owner2")
pure val taskIdValues = Set("task1", "task2")
pure val documentIdValues = Set("original1", "original2")
pure val documentValues = Set(TaskDecoded, TaskShapeInvalid, TaskBytesCorrupt)
pure val reasonValues = Set("", "Unsupported task schema", "Unexpected task record fields")
pure val byOwnerValues = Set("owner1", "owner2")
pure val claimedIdValues = Set("task1", "task2")
pure val atValues = Set(0, 1, 2, 3)
```

## Story: Defer a native update while the runtime may still hold a task

> As a user, an update of the app waits while the runtime may still hold my
> task, and goes ahead only when every record has been checked.

### An empty current answer needs a successful check of every quarantine record

The update provider answers with a status word. A read that fails or is
already in flight is `unknown`. A successful current response names one of
the six task statuses, or an explicit `task: null`; anything else is
`unknown`. A current task keeps its status without the second read. After an
explicit null, the records response must be an array in which every record
has a numeric `acknowledgedAt`; an empty array is fine, and nothing else is
read or inferred.

```quint
type CurrentTaskReply = { ok: bool, hasTask: bool, textStatus: str, explicitNull: bool, objectTask: bool }
type AcknowledgementValue = AcknowledgedNumber | AcknowledgementMissing | AcknowledgementNull | AcknowledgementOther | MalformedRecord
type QuarantineReply = { ok: bool, arrayPresent: bool, records: List[AcknowledgementValue] }
pure def knownActivity(textStatus: str): bool =
  textStatus == "active" or textStatus == "paused" or textStatus == "blocked" or textStatus == "waiting" or textStatus == "completed" or textStatus == "cancelled"
pure def currentActivity(taskReply: CurrentTaskReply): str =
  if (not(taskReply.ok and taskReply.hasTask)) "unknown"
  else if (taskReply.explicitNull) "none"
  else if (taskReply.objectTask and knownActivity(taskReply.textStatus)) taskReply.textStatus
  else "unknown"
pure def noQuarantineHeld(unreadable: QuarantineReply): bool =
  unreadable.ok and unreadable.arrayPresent and unreadable.records.every(record => record == AcknowledgedNumber)
pure def updateActivity(taskReply: CurrentTaskReply, unreadable: QuarantineReply, readSettled: bool): str = {
  val currentStatus = currentActivity(taskReply)
  if (not(readSettled)) "unknown"
  else if (currentStatus != "none") currentStatus
  else if (noQuarantineHeld(unreadable)) "none"
  else "unknown"
}
pure def lawNoneRequiresBothSuccessfulReads(taskReply: CurrentTaskReply, unreadable: QuarantineReply, readSettled: bool): bool =
  updateActivity(taskReply, unreadable, readSettled) == "none" implies readSettled and taskReply.ok and taskReply.hasTask and taskReply.explicitNull and noQuarantineHeld(unreadable)
pure def lawTaskStatusDoesNotRequireRecords(taskReply: CurrentTaskReply, unreadable: QuarantineReply): bool =
  knownActivity(currentActivity(taskReply)) implies updateActivity(taskReply, unreadable, true) == currentActivity(taskReply)
pure def lawFailedRecordsKeepNullCurrentUnknown(taskReply: CurrentTaskReply, unreadable: QuarantineReply): bool =
  currentActivity(taskReply) == "none" and not(noQuarantineHeld(unreadable)) implies updateActivity(taskReply, unreadable, true) == "unknown"
pure val explicitlyEmpty: CurrentTaskReply = { ok: true, hasTask: true, textStatus: "", explicitNull: true, objectTask: false }
pure val taskReplyValues = Set(explicitlyEmpty, { ...explicitlyEmpty, ok: false }, { ...explicitlyEmpty, hasTask: false }, { ...explicitlyEmpty, explicitNull: false, objectTask: true, textStatus: "paused" }, { ...explicitlyEmpty, explicitNull: false, objectTask: true, textStatus: "unknown" })
pure val noRecords: QuarantineReply = { ok: true, arrayPresent: true, records: List() }
pure val unreadableValues = Set(noRecords, { ...noRecords, ok: false }, { ...noRecords, arrayPresent: false }, { ...noRecords, records: List(AcknowledgedNumber) }, { ...noRecords, records: List(AcknowledgedNumber, AcknowledgementNull) }, { ...noRecords, records: List(AcknowledgementMissing) }, { ...noRecords, records: List(AcknowledgementOther) }, { ...noRecords, records: List(MalformedRecord) })
```
