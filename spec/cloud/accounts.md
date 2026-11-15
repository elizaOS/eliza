# Accounts and deletion

Every cloud user belongs to an organization, and the user and the
organization are deleted together. Deletion is a recoverable request first:
the account is fenced, a data export is offered and the owner may cancel
within the recovery window. After the window it becomes an irreversible
saga that removes each provider's data in a fixed order and erases the
database rows last. The identity half of deactivation and deletion is the
auth service's ([platform users](../auth/platformUsers.md)); this spec
orders it with everything else. Ported from the develop models
`AccountDeletionRecovery`, `AccountDeletionOrder` and
`AccountDeletionPhase`. Phases that removed cloud-hosted applications, their
repositories and custom domains, and the gate on on-chain sweeps, are not
part of Eliza.

## Story: Delete my account, with a window to change my mind

> As an account owner, I ask for my account and organization to be deleted,
> receive an export of my data, and can cancel within the recovery window;
> once the window passes, everything is removed and nothing reappears.

### Every user belongs to an organization before any billable call

The owner identity is the user and organization pair; a billable request
with no organization is refused rather than attributed later.

```quint
type Owner = { user: str, organization: str }
pure def billable(o: Owner): bool = o.user != "" and o.organization != ""
pure val oValues = Set({ user: "u1", organization: "o1" }, { user: "u1", organization: "" }, { user: "", organization: "o1" })
pure def lawBillableNeedsOrganization(o: Owner): bool = billable(o) implies o.organization != ""
```

### A deletion request fences the user and organization together and records the authority receipt

The request is reserved with a recovery credential and a deadline. Before
the deadline the holder of the current credential may activate it, which
deactivates the user and the organization in one step at the request's
revision. A replaced export package keeps the same request and issues a new
credential and deadline. Activation is refused while other provider work
for the account is still admitted, or once the account is no longer eligible.

```quint
import platformUsers as PU from "../auth/platformUsers"
type DeletionStatus = NoDeletion | DeletionRequested | DeletionReserved | DeletionRecovery | DeletionCanceling | DeletionCanceled | DeletionScheduled | DeletionProcessing | DeletionActionRequired | DeletionCompleted
type ExportStatus = NoExport | ExportPending | ExportBuilding | ExportReady | ExportExpired | ExportDeleted
type ProviderPhase = ExportRevokePhase | PaymentsPhase | StoredDataPhase | ComputePhase | CredentialsPhase | AuthDeletionPhase
type PhaseStatus = PhasePending | PhaseLeased | PhaseCalling | PhaseReconciling | PhaseRetry | PhaseActionNeeded | PhaseDone
type PhaseRow = { phase: ProviderPhase, status: PhaseStatus, generation: int, owner: int, issued: bool, effect: bool }
type WorkerStep = WorkerIdle | WorkerCall | WorkerConfirm
type Worker = { id: int, phase: ProviderPhase, generation: int, step: WorkerStep }
type Deletion = {
  status: DeletionStatus, now: int, deadline: int, token: int,
  requestRevision: int, userRevision: int, organizationRevision: int, userActive: bool, organizationActive: bool,
  recoveryToken: bool, authorityReceipt: bool, deactivationReceipt: bool, reactivationReceipt: bool,
  exportStatus: ExportStatus, exportCalling: bool, exportDelivered: bool, revokePending: bool, revokeReceipt: bool,
  restoredWithReceipts: bool, irreversible: bool, eligible: bool, providerWork: bool,
  phases: List[PhaseRow], workers: List[Worker], authority: bool, soleOwner: bool, identifiersPresent: bool, identity: PU::IdentityPhase
}
pure val recoveryWindow = 2
pure val providerOrder: List[ProviderPhase] = List(ExportRevokePhase, PaymentsPhase, StoredDataPhase, ComputePhase, CredentialsPhase, AuthDeletionPhase)
pure def freshRow(p: ProviderPhase): PhaseRow = { phase: p, status: PhasePending, generation: 0, owner: 0, issued: false, effect: false }
pure def idleWorker(w: int): Worker = { id: w, phase: ExportRevokePhase, generation: 0, step: WorkerIdle }
pure val initial: Deletion = {
  status: NoDeletion, now: 0, deadline: 0, token: 0,
  requestRevision: 0, userRevision: 0, organizationRevision: 0, userActive: true, organizationActive: true,
  recoveryToken: false, authorityReceipt: false, deactivationReceipt: false, reactivationReceipt: false,
  exportStatus: NoExport, exportCalling: false, exportDelivered: false, revokePending: false, revokeReceipt: false,
  restoredWithReceipts: false, irreversible: false, eligible: true, providerWork: false,
  phases: providerOrder.listMap(p => freshRow(p)), workers: List(idleWorker(1), idleWorker(2)),
  authority: true, soleOwner: true, identifiersPresent: true, identity: PU::Provisioned
}
pure def recoverable(d: Deletion): bool = d.status == DeletionReserved or d.status == DeletionRecovery
pure def canReserve(d: Deletion): bool = d.status == NoDeletion and d.eligible and d.userActive
pure def reserve(d: Deletion): Deletion = { ...d, status: DeletionRequested, token: 1, requestRevision: 1, recoveryToken: true, exportStatus: ExportPending, deadline: d.now + recoveryWindow }
pure def canReplacePackage(d: Deletion): bool = d.status == DeletionRequested
pure def replacePackage(d: Deletion): Deletion = { ...d, token: d.token + 1, deadline: d.now + recoveryWindow }
pure def canActivate(d: Deletion, credential: int): bool = d.status == DeletionRequested and d.recoveryToken and credential == d.token and d.now < d.deadline and d.eligible and not(d.providerWork)
pure def activate(d: Deletion, credential: int): Deletion =
  { ...d, status: DeletionReserved, userActive: false, organizationActive: false, userRevision: d.requestRevision, organizationRevision: d.requestRevision, authorityReceipt: true }
pure val credentialValues = Set(0, 1, 2)
pure def canTick(d: Deletion): bool = true
pure def tick(d: Deletion): Deletion = { ...d, now: d.now + 1 }
pure def canChangeEligibility(d: Deletion): bool = d.eligible
pure def changeEligibility(d: Deletion): Deletion = { ...d, eligible: false }
pure def canAdmitProviderWork(d: Deletion): bool = d.status == DeletionRequested and not(d.providerWork)
pure def admitProviderWork(d: Deletion): Deletion = { ...d, providerWork: true }
pure def canReleaseProviderWork(d: Deletion): bool = d.providerWork
pure def releaseProviderWork(d: Deletion): Deletion = { ...d, providerWork: false }
pure def fenced(d: Deletion): bool = recoverable(d) or d.status == DeletionCanceling or d.status == DeletionScheduled or d.status == DeletionProcessing or d.status == DeletionActionRequired or d.status == DeletionCompleted
pure def alwaysFencesPublishedTogether(d: Deletion): bool = fenced(d) implies not(d.userActive) and not(d.organizationActive) and d.authorityReceipt
pure def alwaysRevisionsAgree(d: Deletion): bool = (d.status != NoDeletion and d.status != DeletionRequested) implies d.requestRevision == d.userRevision and d.requestRevision == d.organizationRevision
```

### The export is offered only while the request can still be recovered

A ready export exists only during recovery. An export that finishes after
cancellation or after the window is recorded as expired and needs a fresh
revocation.

```quint
pure def canStartExport(d: Deletion): bool = recoverable(d) and d.exportStatus == ExportPending and not(d.exportCalling)
pure def startExport(d: Deletion): Deletion = { ...d, exportStatus: ExportBuilding, exportCalling: true }
pure def canCompleteExport(d: Deletion): bool = d.exportCalling and not(d.exportDelivered) and ((recoverable(d) and d.exportStatus == ExportBuilding) or d.exportStatus == ExportExpired or d.exportStatus == ExportDeleted)
pure def completeExport(d: Deletion): Deletion =
  if (recoverable(d) and d.exportStatus == ExportBuilding) { ...d, status: DeletionRecovery, exportStatus: ExportReady, exportDelivered: true }
  else { ...d, exportStatus: ExportExpired, exportDelivered: true, revokeReceipt: false, revokePending: true }
pure def canRevokeExport(d: Deletion): bool = d.revokePending
pure def revokeExport(d: Deletion): Deletion = { ...d, exportStatus: ExportDeleted, revokeReceipt: true, revokePending: false }
pure def alwaysExportOnlyDuringRecovery(d: Deletion): bool = d.exportStatus == ExportReady implies d.status == DeletionRecovery
pure def alwaysLateExportStaysFenced(d: Deletion): bool = (d.exportDelivered and not(recoverable(d))) implies (d.exportStatus == ExportExpired or d.exportStatus == ExportDeleted)
```

### Cancellation restores the account only after reactivation and export revocation are both recorded

During recovery the auth service deactivates the identity behind the user.
The holder of the current recovery credential may cancel before the
deadline. The account becomes active again, at a new revision, only once the
auth service has reactivated the identity and the export is revoked.

```quint
pure def canCompleteDeactivation(d: Deletion): bool = recoverable(d) and not(d.deactivationReceipt)
pure def completeDeactivation(d: Deletion): Deletion = { ...d, deactivationReceipt: true, identity: PU::Deactivated }
pure def canCancel(d: Deletion, credential: int): bool = recoverable(d) and d.recoveryToken and credential == d.token and d.now < d.deadline
pure def cancel(d: Deletion, credential: int): Deletion = { ...d, status: DeletionCanceling, exportStatus: ExportExpired, reactivationReceipt: false, revokeReceipt: false, revokePending: true }
pure def canCompleteReactivation(d: Deletion): bool = d.status == DeletionCanceling and not(d.reactivationReceipt)
pure def completeReactivation(d: Deletion): Deletion = { ...d, reactivationReceipt: true, deactivationReceipt: false, identity: PU::Provisioned }
pure def canFinishCancellation(d: Deletion): bool = d.status == DeletionCanceling and d.reactivationReceipt and d.revokeReceipt
pure def finishCancellation(d: Deletion): Deletion =
  { ...d, status: DeletionCanceled, requestRevision: d.requestRevision + 1, userRevision: d.requestRevision + 1, organizationRevision: d.requestRevision + 1,
    userActive: true, organizationActive: true, recoveryToken: false, deactivationReceipt: false, restoredWithReceipts: d.reactivationReceipt and d.revokeReceipt }
pure def alwaysRestoredOnlyAfterReceipts(d: Deletion): bool =
  d.status == DeletionCanceled implies d.restoredWithReceipts and d.reactivationReceipt and d.userActive and d.organizationActive and not(d.recoveryToken)
pure def sometimesCancellationRestored(d: Deletion): bool = d.status == DeletionCanceled
pure def sometimesLateExportNeedsRevocation(d: Deletion): bool = d.status == DeletionCanceled and d.exportDelivered and d.revokePending
```

### After the window the deletion becomes irreversible only with a delivered export and a deactivated account

```quint
pure def canExpireRecovery(d: Deletion): bool =
  recoverable(d) and d.now >= d.deadline and d.eligible and not(d.providerWork) and d.exportStatus == ExportReady and d.deactivationReceipt and d.userRevision == d.requestRevision and d.organizationRevision == d.requestRevision
pure def expireRecovery(d: Deletion): Deletion =
  { ...d, status: DeletionScheduled, irreversible: true, requestRevision: d.requestRevision + 1, userRevision: d.requestRevision + 1, organizationRevision: d.requestRevision + 1,
    recoveryToken: false, exportStatus: ExportExpired, revokePending: true, revokeReceipt: false }
pure def alwaysIrreversibleCannotRestore(d: Deletion): bool =
  d.irreversible implies (d.status == DeletionScheduled or d.status == DeletionProcessing or d.status == DeletionActionRequired or d.status == DeletionCompleted) and not(d.userActive) and not(d.organizationActive) and not(d.recoveryToken)
pure def alwaysSagaOnlyAfterTheWindow(d: Deletion): bool = d.phases.every(r => r.status != PhasePending implies d.irreversible)
```

### Provider phases run in a fixed order, each under one current lease

The phases are, in order: revoke the export; cancel payments; remove stored
data (spools, secondary backups, object storage and vault key bindings);
remove compute; revoke connector, voice and other credential grants; and
delete the identity in the auth service. A worker leases the first phase
that is not done; each lease raises the phase's generation, and only the
worker holding the current generation may record a call or a completion. A
lease may expire while its worker is still running. After three leases
without completion the deletion needs operator action instead of another
attempt.

```quint
type OrderCheck = { ok: bool, allDone: bool }
pure val maxLeases = 3
pure val noRow: PhaseRow = { phase: ExportRevokePhase, status: PhaseDone, generation: 0, owner: 0, issued: false, effect: false }
pure val noWorker: Worker = { id: 0, phase: ExportRevokePhase, generation: -1, step: WorkerIdle }
pure def rowOf(d: Deletion, p: ProviderPhase): PhaseRow = d.phases.select(r => r.phase == p).nthOr(0, noRow)
pure def workerOf(d: Deletion, w: int): Worker = d.workers.select(x => x.id == w).nthOr(0, noWorker)
pure def headRow(d: Deletion): PhaseRow = d.phases.select(r => r.status != PhaseDone).nthOr(0, noRow)
pure def hasHead(d: Deletion): bool = d.phases.some(r => r.status != PhaseDone)
pure def withRow(d: Deletion, p: ProviderPhase, row: PhaseRow): List[PhaseRow] = d.phases.listMap(r => if (r.phase == p) row else r)
pure def withWorker(d: Deletion, worker: Worker): List[Worker] = d.workers.listMap(x => if (x.id == worker.id) worker else x)
pure def holdsLease(d: Deletion, w: int): bool = {
  val worker = workerOf(d, w)
  val row = rowOf(d, worker.phase)
  worker.step != WorkerIdle and row.owner == w and row.generation == worker.generation
}
pure val wValues = Set(1, 2)
pure def sagaRunning(d: Deletion): bool = d.status == DeletionScheduled or d.status == DeletionProcessing
pure def canClaimPhase(d: Deletion, w: int): bool = {
  val first = headRow(d)
  sagaRunning(d) and d.authority and workerOf(d, w).id == w and workerOf(d, w).step == WorkerIdle and hasHead(d) and first.owner == 0 and first.status != PhaseActionNeeded
}
pure def claimPhase(d: Deletion, w: int): Deletion = {
  val first = headRow(d)
  if (first.generation >= maxLeases) { ...d, status: DeletionActionRequired, phases: withRow(d, first.phase, { ...first, status: PhaseActionNeeded }) }
  else {
    val generation = first.generation + 1
    val reconciling = first.status == PhaseCalling or first.status == PhaseReconciling
    val status = if (first.phase == ExportRevokePhase) d.status else DeletionProcessing
    if (reconciling and not(first.effect))
      { ...d, status: status, phases: withRow(d, first.phase, { ...first, generation: generation, owner: 0, status: PhaseRetry }) }
    else
      { ...d, status: status,
        phases: withRow(d, first.phase, { ...first, generation: generation, owner: w, status: if (reconciling) PhaseReconciling else PhaseLeased }),
        workers: withWorker(d, { id: w, phase: first.phase, generation: generation, step: if (first.effect) WorkerConfirm else WorkerCall }) }
  }
}
pure def canExpireLease(d: Deletion, p: ProviderPhase): bool = rowOf(d, p).owner != 0 and rowOf(d, p).status != PhaseDone
pure def expireLease(d: Deletion, p: ProviderPhase): Deletion = { ...d, phases: withRow(d, p, { ...rowOf(d, p), owner: 0 }) }
pure def alwaysReceiptsStayOrdered(d: Deletion): bool = d.phases.foldl({ ok: true, allDone: true }, (acc, r) => { ok: acc.ok and (r.status != PhaseDone or acc.allDone), allDone: acc.allDone and r.status == PhaseDone }).ok
pure def alwaysLeasesAreBounded(d: Deletion): bool = d.phases.every(r => r.generation >= 0 and r.generation <= maxLeases)
pure def stepGenerationsNeverGoBack(before: Deletion, after: Deletion): bool = providerOrder.every(p => rowOf(after, p).generation >= rowOf(before, p).generation)
```

### A provider call is issued only under a fresh lease, and a lost reply is reconciled rather than repeated blindly

A worker records that it is calling before the provider is called, so a
crash leaves the phase marked as possibly applied. The provider may apply
the effect and the reply may still be lost; the phase then waits for
reconciliation. The next lease first inspects the provider: an effect it
finds is confirmed, and a confirmed absence spends that lease and lets the
following one call again. A worker whose inspection fails releases its
lease.

```quint
pure def canCallProvider(d: Deletion, w: int): bool = workerOf(d, w).step == WorkerCall
pure def callProvider(d: Deletion, w: int, applied: bool, replyLost: bool): Deletion = {
  val worker = workerOf(d, w)
  val row = rowOf(d, worker.phase)
  if (holdsLease(d, w) and row.status == PhaseLeased)
    { ...d, phases: withRow(d, worker.phase, { ...row, status: if (replyLost or not(applied)) PhaseReconciling else PhaseCalling, issued: true, effect: row.effect or applied, owner: if (replyLost or not(applied)) 0 else w }),
      workers: withWorker(d, { ...worker, step: if (replyLost or not(applied)) WorkerIdle else WorkerConfirm }) }
  else { ...d, workers: withWorker(d, { ...worker, step: WorkerIdle }) }
}
pure def canInspectionFails(d: Deletion, w: int): bool = workerOf(d, w).step != WorkerIdle
pure def inspectionFails(d: Deletion, w: int): Deletion = {
  val worker = workerOf(d, w)
  val row = rowOf(d, worker.phase)
  if (holdsLease(d, w)) { ...d, phases: withRow(d, worker.phase, { ...row, owner: 0, status: if (row.issued) PhaseReconciling else PhaseRetry }), workers: withWorker(d, { ...worker, step: WorkerIdle }) }
  else { ...d, workers: withWorker(d, { ...worker, step: WorkerIdle }) }
}
pure def stepCallStartsFromFreshLease(before: Deletion, after: Deletion): bool =
  providerOrder.every(p => (rowOf(after, p).issued and not(rowOf(before, p).issued)) implies rowOf(before, p).status == PhaseLeased)
pure def sometimesLostReplyAwaitsReconciliation(d: Deletion): bool = d.phases.some(r => r.status == PhaseReconciling and r.issued and r.effect)
```

### A phase completes only when its current lease holder sees the provider's effect

```quint
pure def canConfirmPhase(d: Deletion, w: int): bool = workerOf(d, w).step == WorkerConfirm
pure def confirmPhase(d: Deletion, w: int): Deletion = {
  val worker = workerOf(d, w)
  val row = rowOf(d, worker.phase)
  val allowed = holdsLease(d, w) and row.effect and d.authority and (worker.phase == ExportRevokePhase or d.status == DeletionProcessing)
  { ...d, phases: if (allowed) withRow(d, worker.phase, { ...row, status: PhaseDone, owner: 0 }) else d.phases, workers: withWorker(d, { ...worker, step: WorkerIdle }),
    identity: if (allowed and worker.phase == AuthDeletionPhase) PU::IdentityDeleted else d.identity }
}
pure def alwaysCompletedPhaseHadItsEffect(d: Deletion): bool = d.phases.every(r => r.status == PhaseDone implies r.effect)
pure def stepOnlyTheLeaseHolderCompletesAPhase(before: Deletion, via: str, after: Deletion): bool =
  providerOrder.every(p => (rowOf(before, p).status != PhaseDone and rowOf(after, p).status == PhaseDone) implies via == "confirmPhase")
pure def canRequireAction(d: Deletion, w: int): bool = holdsLease(d, w)
pure def requireAction(d: Deletion, w: int): Deletion = {
  val worker = workerOf(d, w)
  { ...d, status: DeletionActionRequired, phases: withRow(d, worker.phase, { ...rowOf(d, worker.phase), status: PhaseActionNeeded, owner: 0 }), workers: withWorker(d, { ...worker, step: WorkerIdle }) }
}
pure def sometimesActionRequired(d: Deletion): bool = d.status == DeletionActionRequired
```

### The database rows are erased last, once, with every receipt and the sole owner's authority

The identity behind the user is deleted in the auth service only by the
deletion phase, after it was deactivated. Erasure removes the user's and organization's identifiers. It requires
every provider phase done, live authority and that the user is still the
organization's sole owner; losing either stops the saga where it is.

```quint
pure def canFinalizeErasure(d: Deletion): bool = d.status == DeletionProcessing and d.authority and d.soleOwner and d.identifiersPresent and d.phases.every(r => r.status == PhaseDone)
pure def finalizeErasure(d: Deletion): Deletion = { ...d, status: DeletionCompleted, identifiersPresent: false }
pure def canLoseAuthority(d: Deletion): bool = d.authority
pure def loseAuthority(d: Deletion): Deletion = { ...d, authority: false }
pure def canMembershipChanges(d: Deletion): bool = d.soleOwner
pure def membershipChanges(d: Deletion): Deletion = { ...d, soleOwner: false }
pure def alwaysCompletionHasEveryReceipt(d: Deletion): bool = d.status == DeletionCompleted implies (d.phases.every(r => r.status == PhaseDone) and not(d.identifiersPresent))
pure def alwaysIdentifiersErasedOnlyOnCompletion(d: Deletion): bool = not(d.identifiersPresent) implies d.status == DeletionCompleted
pure def alwaysIdentityDeletedOnlyAfterDeactivation(d: Deletion): bool =
  (d.identity == PU::IdentityDeleted implies (d.irreversible and rowOf(d, AuthDeletionPhase).status == PhaseDone)) and (d.irreversible implies (d.identity == PU::Deactivated or d.identity == PU::IdentityDeleted))
    and ((d.deactivationReceipt and not(d.irreversible)) implies d.identity == PU::Deactivated)
pure val weight_claimPhase = 10
pure val weight_callProvider = 10
pure val weight_confirmPhase = 10
pure val weight_finalizeErasure = 10
pure val weight_expireRecovery = 10
pure val weight_completeExport = 5
pure val weight_startExport = 5
pure val weight_completeDeactivation = 5
pure def sometimesErasureCompleted(d: Deletion): bool = d.status == DeletionCompleted
```
