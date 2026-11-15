# Hosted object storage

The cloud stores objects for an organization in a provider bucket and
documents in its database. An object upload holds quota and credit, sends
its bytes to the provider under a lease, and is either published to the
catalog once the provider has the object or refunded once recovery has seen
it absent twice; a provider may still apply a request already sent after
its lease is lost. A document and its fragments are published and deleted
in one transaction. One upload and one document are the state machine.
Reading an object-backed field is stated as laws.

Develop sources: the cloud `NativeStoragePutRecovery`,
`document_publication` and `object_field_hydration` models.

## Story: Upload an object once and recover a lost upload

> As a device owner saving a file to the cloud, I want the upload either
> published or refunded, never both, never charged twice, and never
> refunded while the object may still appear.

### An upload holds its quota until it is published or refunded

An upload first reserves its credit, or is refunded at once when there is
not enough. Its quota is held exactly while it is not refunded; a published
upload is in the catalog with its credit settled, and a refunded one holds
no credit. Each terminal upload has its receipt, issued under the lease that
finished it, and a terminal upload never changes again.

```quint
type PutPhase = PutPrepared | PutReserved | ProviderStarted | Reconciling | PutCommitted | PutRefunded
type WorkKind = WorkIdle | WorkWriter | WorkRecovery
type HeadObservation = HeadNone | HeadPending | HeadPresent | HeadAbsent
type CreditState = CreditNone | CreditHeld | CreditSettled | CreditReturned
type PutReceipt = NoReceipt | ReceiptCommitted | ReceiptInsufficient | ReceiptUnstarted | ReceiptSecondAbsence
type DocPhase = DocIdle | DocCreating | DocDeleting
type WorkSlot = { worker: int, token: int, kind: WorkKind, head: HeadObservation }
type StoredObjects = {
  phase: PutPhase, token: int, slots: List[WorkSlot], leaseLapsed: bool, absenceSeen: bool, sent: bool, inFlight: bool, providerPresent: bool,
  quotaHeld: bool, credit: CreditState, catalogPublished: bool, receipt: PutReceipt, terminalToken: int,
  docParent: bool, docFragments: int, docPhase: DocPhase, stagedParent: bool, stagedFragments: int, docDeleted: bool
}
pure def idleSlot(worker: int): WorkSlot = { worker: worker, token: 0, kind: WorkIdle, head: HeadNone }
pure val initial: StoredObjects = {
  phase: PutPrepared, token: 0, slots: List(idleSlot(1), idleSlot(2)), leaseLapsed: false, absenceSeen: false, sent: false, inFlight: false, providerPresent: false,
  quotaHeld: true, credit: CreditNone, catalogPublished: false, receipt: NoReceipt, terminalToken: 0,
  docParent: false, docFragments: 0, docPhase: DocIdle, stagedParent: false, stagedFragments: 0, docDeleted: false
}
pure def terminalPut(phase: PutPhase): bool = phase == PutCommitted or phase == PutRefunded
pure def leasedPut(phase: PutPhase): bool = phase == ProviderStarted or phase == Reconciling
pure def canReservePut(o: StoredObjects): bool = o.phase == PutPrepared
pure def reservePut(o: StoredObjects): StoredObjects = { ...o, phase: PutReserved, credit: CreditHeld }
pure def canRefuseInsufficient(o: StoredObjects): bool = o.phase == PutPrepared
pure def refuseInsufficient(o: StoredObjects): StoredObjects = { ...o, phase: PutRefunded, quotaHeld: false, receipt: ReceiptInsufficient, terminalToken: o.token }
pure def alwaysCatalogMeansCommitted(o: StoredObjects): bool = o.catalogPublished == (o.phase == PutCommitted)
pure def alwaysQuotaHeldUntilRefund(o: StoredObjects): bool = o.quotaHeld == (o.phase != PutRefunded)
pure def alwaysCommittedObjectIsSettled(o: StoredObjects): bool = o.phase == PutCommitted implies (o.providerPresent and o.credit == CreditSettled and o.receipt == ReceiptCommitted)
pure def alwaysRefundHoldsNoCredit(o: StoredObjects): bool = o.phase == PutRefunded implies o.credit != CreditHeld
pure def alwaysReceiptExactlyWhenTerminal(o: StoredObjects): bool = terminalPut(o.phase) == (o.receipt != NoReceipt) and (terminalPut(o.phase) implies o.terminalToken == o.token)
pure def stepTerminalUploadIsFinal(before: StoredObjects, after: StoredObjects): bool =
  terminalPut(before.phase) implies (after.phase == before.phase and after.receipt == before.receipt and after.catalogPublished == before.catalogPublished and after.credit == before.credit)
```

### Only the current lease publishes or refunds an upload

A worker claims an upload under a new lease token: a writer when it is
reserved or its writer's lease has lapsed, and a recovery worker whenever
its lease has lapsed. Only a writer sends the bytes. Each worker reads the
provider for the object and acts only while it still holds the current
token. A worker that fails or is cancelled loses only what it was doing,
not the lease or the hold.

```quint
pure def slotOf(o: StoredObjects, worker: int): WorkSlot = o.slots.select(slot => slot.worker == worker).nthOr(0, idleSlot(0))
pure def withSlot(o: StoredObjects, slot: WorkSlot): List[WorkSlot] = o.slots.listMap(other => if (other.worker == slot.worker) slot else other)
pure def owns(o: StoredObjects, worker: int): bool = leasedPut(o.phase) and slotOf(o, worker).token == o.token and slotOf(o, worker).kind != WorkIdle
pure def due(o: StoredObjects): bool = (o.phase == PutReserved or leasedPut(o.phase)) and o.leaseLapsed
pure def canLapsePutLease(o: StoredObjects): bool = (o.phase == PutReserved or leasedPut(o.phase)) and not(o.leaseLapsed)
pure def lapsePutLease(o: StoredObjects): StoredObjects = { ...o, leaseLapsed: true }
pure def canClaimPut(o: StoredObjects, worker: int, recovery: bool): bool =
  slotOf(o, worker).worker == worker and slotOf(o, worker).kind == WorkIdle and
  (if (recovery) due(o) else (o.phase == PutReserved or (o.phase == ProviderStarted and o.leaseLapsed)))
pure def claimPut(o: StoredObjects, worker: int, recovery: bool): StoredObjects = {
  val token = o.token + 1
  { ...o, token: token, leaseLapsed: false, phase: if (recovery and o.phase != ProviderStarted) Reconciling else ProviderStarted,
    slots: withSlot(o, { worker: worker, token: token, kind: if (recovery) WorkRecovery else WorkWriter, head: HeadPending }),
    sent: o.sent or not(recovery), inFlight: o.inFlight or not(recovery) }
}
pure def canProviderApply(o: StoredObjects): bool = o.inFlight
pure def providerApply(o: StoredObjects): StoredObjects = { ...o, inFlight: false, providerPresent: true }
pure def canProviderDrop(o: StoredObjects): bool = o.inFlight
pure def providerDrop(o: StoredObjects): StoredObjects = { ...o, inFlight: false }
pure def canObserveHead(o: StoredObjects, worker: int): bool = slotOf(o, worker).worker == worker and slotOf(o, worker).head == HeadPending
pure def observeHead(o: StoredObjects, worker: int): StoredObjects = { ...o, slots: withSlot(o, { ...slotOf(o, worker), head: if (o.providerPresent) HeadPresent else HeadAbsent }) }
pure def canAbandonWork(o: StoredObjects, worker: int): bool = slotOf(o, worker).worker == worker and slotOf(o, worker).kind != WorkIdle
pure def abandonWork(o: StoredObjects, worker: int): StoredObjects = { ...o, slots: withSlot(o, idleSlot(worker)) }
pure val workerValues = Set(1, 2)
pure def alwaysLeasedUploadHasAToken(o: StoredObjects): bool = leasedPut(o.phase) implies o.token > 0
pure def alwaysWorkersHoldNoFutureToken(o: StoredObjects): bool = o.slots.foldl(true, (ok, slot) => ok and slot.token <= o.token)
pure def alwaysAtMostOneWorkerOwnsTheLease(o: StoredObjects): bool = not(owns(o, 1) and owns(o, 2))
pure def sometimesSecondWorkerTakesOver(o: StoredObjects): bool = o.phase == ProviderStarted and o.token == 2
```

### An upload is refunded only after its object was seen absent twice

A worker that sees the object at the provider publishes it to the catalog
and settles its credit. A recovery worker that finds a started upload absent
does not refund it: it records the absence and waits out a quarantine under
a new lease, because a request already sent may still land. Only a second
absence, or an upload whose bytes were never sent, is refunded, returning
its credit.

```quint
pure def canDeferAbsence(o: StoredObjects, worker: int): bool =
  owns(o, worker) and slotOf(o, worker).kind == WorkRecovery and slotOf(o, worker).head == HeadAbsent and o.phase == ProviderStarted
pure def deferAbsence(o: StoredObjects, worker: int): StoredObjects = { ...o, phase: Reconciling, absenceSeen: true, leaseLapsed: false, slots: withSlot(o, idleSlot(worker)) }
pure def canCommitPut(o: StoredObjects, worker: int): bool = owns(o, worker) and slotOf(o, worker).head == HeadPresent
pure def commitPut(o: StoredObjects, worker: int): StoredObjects =
  { ...o, phase: PutCommitted, catalogPublished: true, credit: CreditSettled, receipt: ReceiptCommitted, terminalToken: o.token, slots: withSlot(o, idleSlot(worker)), absenceSeen: false }
pure def canRefundPut(o: StoredObjects, worker: int): bool =
  owns(o, worker) and slotOf(o, worker).kind == WorkRecovery and o.phase == Reconciling and (if (o.absenceSeen) slotOf(o, worker).head == HeadAbsent else not(o.sent))
pure def refundPut(o: StoredObjects, worker: int): StoredObjects =
  { ...o, phase: PutRefunded, quotaHeld: false, credit: if (o.credit == CreditHeld) CreditReturned else o.credit, receipt: if (o.absenceSeen) ReceiptSecondAbsence else ReceiptUnstarted, terminalToken: o.token, slots: withSlot(o, idleSlot(worker)), absenceSeen: false }
pure def alwaysAbsenceOnlyForASentUpload(o: StoredObjects): bool = o.absenceSeen implies (o.sent and o.phase == Reconciling)
pure def alwaysUnsentRecoveryIsReconciling(o: StoredObjects): bool = (o.phase == Reconciling and not(o.absenceSeen)) implies not(o.sent)
pure def alwaysSentRefundSawTwoAbsences(o: StoredObjects): bool = (o.phase == PutRefunded and o.sent) implies o.receipt == ReceiptSecondAbsence
pure def sometimesUploadPublished(o: StoredObjects): bool = o.phase == PutCommitted
pure def sometimesRefundAfterSecondAbsence(o: StoredObjects): bool = o.receipt == ReceiptSecondAbsence
pure def sometimesLateObjectAfterAbsence(o: StoredObjects): bool = o.phase == Reconciling and o.absenceSeen and o.providerPresent
pure val weight_claimPut = 3
pure val weight_observeHead = 3
```

## Story: Publish and delete a document whole

> As a user, I want a saved document visible with all of its fragments or
> not at all, and a deleted one gone with all of them.

### A document and its fragments commit together

A document is created by staging its record and both fragments and
committing them in one transaction; only committed rows are visible. A
deletion stages the removal of the fragments and then of the record, and
commits only once the record's removal is confirmed; anything else rolls
back. A deleted document stays deleted.

```quint
pure def canBeginCreate(o: StoredObjects): bool = o.docPhase == DocIdle and not(o.docParent) and not(o.docDeleted)
pure def beginCreate(o: StoredObjects): StoredObjects = { ...o, docPhase: DocCreating, stagedParent: false, stagedFragments: 0 }
pure def canStageParent(o: StoredObjects): bool = o.docPhase == DocCreating and not(o.stagedParent)
pure def stageParent(o: StoredObjects): StoredObjects = { ...o, stagedParent: true }
pure def canStageFragments(o: StoredObjects): bool = o.docPhase == DocCreating and o.stagedParent and o.stagedFragments == 0
pure def stageFragments(o: StoredObjects): StoredObjects = { ...o, stagedFragments: 2 }
pure def canCommitCreate(o: StoredObjects): bool = o.docPhase == DocCreating and o.stagedParent and o.stagedFragments == 2
pure def commitCreate(o: StoredObjects): StoredObjects = { ...o, docParent: true, docFragments: 2, docPhase: DocIdle, stagedParent: false, stagedFragments: 0 }
pure def canBeginDocDelete(o: StoredObjects): bool = o.docPhase == DocIdle and o.docParent
pure def beginDocDelete(o: StoredObjects): StoredObjects = { ...o, docPhase: DocDeleting, stagedParent: true, stagedFragments: o.docFragments }
pure def canStageFragmentDeletion(o: StoredObjects): bool = o.docPhase == DocDeleting and o.stagedFragments > 0
pure def stageFragmentDeletion(o: StoredObjects): StoredObjects = { ...o, stagedFragments: 0 }
pure def canStageParentDeletion(o: StoredObjects): bool = o.docPhase == DocDeleting and o.stagedFragments == 0 and o.stagedParent
pure def stageParentDeletion(o: StoredObjects): StoredObjects = { ...o, stagedParent: false }
pure def canCommitDocDelete(o: StoredObjects): bool = o.docPhase == DocDeleting and o.stagedFragments == 0 and not(o.stagedParent)
pure def commitDocDelete(o: StoredObjects): StoredObjects = { ...o, docParent: false, docFragments: 0, docPhase: DocIdle, docDeleted: true }
pure def canRollbackDoc(o: StoredObjects): bool = o.docPhase != DocIdle
pure def rollbackDoc(o: StoredObjects): StoredObjects = { ...o, docPhase: DocIdle, stagedParent: false, stagedFragments: 0 }
pure def alwaysDocumentIsWhole(o: StoredObjects): bool = o.docParent == (o.docFragments == 2) and (o.docFragments > 0 implies o.docParent)
pure def alwaysDeletedDocumentIsGone(o: StoredObjects): bool = o.docDeleted implies (not(o.docParent) and o.docFragments == 0)
pure def sometimesDocumentDeleted(o: StoredObjects): bool = o.docDeleted
pure def sometimesDocumentPublished(o: StoredObjects): bool = o.docParent and o.docPhase == DocIdle
```

## Story: Read a stored field completely

> As a client reading a record, I want a field that lives in object storage
> returned whole, or an error, never its preview presented as the full value.

### A full read returns the stored object or fails

A preview read returns the inline preview. A full read returns the inline
value, or the object the field points to when the pointer carries its key;
a pointer without a key or of an unknown kind fails. An object body is
returned only when it is complete, or empty for a text field; a malformed or
empty body of a JSON field, or an unavailable object, fails.

```quint
type FieldPointer = InlineValue | ObjectWithKey | ObjectWithoutKey | UnknownPointer
type ObjectBody = BodyComplete | BodyEmpty | BodyMalformed | BodyUnavailable
type FieldRead = FieldPreview | FieldComplete | FieldError
pure def readField(full: bool, pointer: FieldPointer, json: bool, body: ObjectBody): FieldRead =
  if (not(full)) FieldPreview
  else if (pointer == InlineValue) FieldComplete
  else if (pointer != ObjectWithKey) FieldError
  else if (body == BodyComplete or (body == BodyEmpty and not(json))) FieldComplete
  else FieldError
pure def lawFullReadNeverReturnsAPreview(pointer: FieldPointer, json: bool, body: ObjectBody): bool = readField(true, pointer, json, body) != FieldPreview
pure def lawInvalidPointerNeverSucceeds(json: bool, body: ObjectBody): bool =
  readField(true, ObjectWithoutKey, json, body) == FieldError and readField(true, UnknownPointer, json, body) == FieldError
pure def lawBrokenJsonBodyFails(body: ObjectBody): bool = (body == BodyMalformed or body == BodyEmpty or body == BodyUnavailable) implies readField(true, ObjectWithKey, true, body) == FieldError
```
