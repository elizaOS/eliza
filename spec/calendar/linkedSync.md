# Linked calendar sync control

The resident calendar can be linked to a calendar at a provider, such as
a managed account's calendar reached through the Cloud's [managed calendar
sync](../cloud/managedGoogle/calendarSync.md). This spec owns the sync
control and its receipts, and ends at the provider.
[Reconciliation](./linkedReconcile.md) owns the per-link decision and
[sync settlement](./syncSettlement.md) the watch channel.

## Story: Link my resident calendar to a verified provider destination

> As the owner, I want to link my resident calendar to a provider calendar
> I can write to and approved, and to be told it is synced only when it is.

### A link writes only to a verified owner destination, and a saved destination never switches

Linking needs a connected write grant and the owner's review of the
destination. Only the owner's own provider calendars with owner or writer
access are choices, and the writer rechecks the source identity and the
selection version it reviewed. A saved destination is resumed only while
it is still listed and its account matches the approved grant; without
one, exactly one eligible primary calendar is selected, otherwise the
owner chooses. Each control write carries the expected control revision
and a stable operation key derived from the owner, operation, revision,
account and calendar, which gives retry identity only. A failure after
the control call starts reports uncertainty.

```quint
type DestinationEvidence = { ownerSource: bool, writable: bool, sameSource: bool, sameSelectionVersion: bool, approvedEmail: bool }
type DestinationChoice = ResumeDestination | SelectPrimary | ChooseDestination | RefuseDestination
pure def mayWriteDestination(destinationEvidence: DestinationEvidence): bool =
  destinationEvidence.ownerSource and destinationEvidence.writable and destinationEvidence.sameSource and
  destinationEvidence.sameSelectionVersion and destinationEvidence.approvedEmail
pure def linkChoice(savedDestination: bool, savedListed: bool, approvedEmail: bool, approvedPrimaryCount: int): DestinationChoice =
  if (savedDestination) (if (savedListed and approvedEmail) ResumeDestination else RefuseDestination)
  else if (approvedPrimaryCount == 1) SelectPrimary else ChooseDestination
pure def lawUnknownSelectionVersionCannotWrite(destinationEvidence: DestinationEvidence): bool =
  not(destinationEvidence.sameSelectionVersion) implies not(mayWriteDestination(destinationEvidence))
pure def lawSavedDestinationDoesNotSwitch(savedListed: bool, approvedEmail: bool, approvedPrimaryCount: int): bool =
  linkChoice(true, savedListed, approvedEmail, approvedPrimaryCount) != SelectPrimary
pure val destinationEvidenceValues = Set(
  { ownerSource: true, writable: true, sameSource: true, sameSelectionVersion: true, approvedEmail: true },
  { ownerSource: true, writable: true, sameSource: true, sameSelectionVersion: false, approvedEmail: true })
```

### Report sync only after a current control and mapping readback

A changed control revision is reported as changed elsewhere. Paused or
destinationless control with a pending dispatch reports waiting. For an
active approved destination, a pending dispatch that moved on reports
syncing and one that did not reports unconfirmed. Synced is reported only
when the control is current and active with no pending dispatch, the event
mappings were read, and none for this destination is conflicted or
quarantined. A failure reading the mappings is unconfirmed.

```quint
type SyncReport = ReportWaiting | ReportSyncing | ReportSynced | ReportUnconfirmed | ReportChanged
pure def syncReport(revisionMatches: bool, activeApproved: bool, pendingDispatch: bool, dispatchMoved: bool, linksRead: bool, heldCount: int): SyncReport =
  if (not(revisionMatches)) ReportChanged
  else if (not(activeApproved)) (if (pendingDispatch) ReportWaiting else ReportUnconfirmed)
  else if (pendingDispatch) (if (dispatchMoved) ReportSyncing else ReportUnconfirmed)
  else if (linksRead and heldCount == 0) ReportSynced
  else ReportUnconfirmed
pure def lawSyncedNeedsMappingRead(revisionMatches: bool, activeApproved: bool, pendingDispatch: bool, dispatchMoved: bool, linksRead: bool, heldCount: int): bool =
  syncReport(revisionMatches, activeApproved, pendingDispatch, dispatchMoved, linksRead, heldCount) == ReportSynced implies
  revisionMatches and activeApproved and not(pendingDispatch) and linksRead and heldCount == 0
pure val heldCountValues = Set(0, 1, 2)
```

## Story: Pause, resume or recover without replacing a newer sync decision

> As the owner, I want pausing, resuming or recovering sync to act on the
> control I saw, so that a newer decision is never replaced by an older one.

### A control transition checks revision and writes its receipt atomically

Control publishes its revision, paused flag, destination, conflict count
and pending link, never the durable dispatch token. Saved control has a
complete destination and either both pending fields or neither; with no
destination it is paused and has no pending link. A control request is
pause, select, resume or recover, with an expected revision and an
operation key, and its fingerprint is that of the normalized request.
Receipt lookup is per agent and key.
An equal fingerprint replays the same committed receipt only
when its revision remains the current revision observed by the
service. A concurrent commit that the repository finds after a
failed CAS instead returns its matching receipt. Another payload
using that key is an operation conflict. A newer control revision
supersedes the previous receipt as a description of current
control. A commit bumps the revision by one and records its receipt in
the same atomic write; a failed write publishes nothing.

Pause keeps the destination and pending dispatch. Select requires
paused and no pending dispatch, accepts either explicit null or
an exact verified writable destination, and cannot change a
different agent's control. Resume verifies the stored destination,
requires no pending dispatch, and refuses any existing active
mapping to another destination. Paused and local-only links do
not veto that check. The resident then bootstraps eligible owner
Calendar events and kicks reconciliation. Exact resume replay
may bootstrap again using the already committed selection.
The dispatcher admits one active mapping at a time only for
the exact unpaused destination and expected revision.
An ordinary exact settlement clears that pending token without
incrementing the control revision. Pause may win a race after
claim, retaining the claim until exact settlement or recovery.

Recovery must be paused with a pending token and a verified
current destination. A token still active in this process blocks
recovery. The mapped link must belong to that destination. The
provider recovery read waits out a settle window after the dispatch and
checks exact provider evidence. An unresolved read leaves control paused and pending.
Recovery never retries the uncertain provider write. A resolved
read clears only the captured token with the exact paused
revision. The new revision invalidates prior resume reviews.

Provider mutation and recovery details remain with the reconciler.

```quint
type ControlOp = PauseControl | SelectControl | ResumeControl | RecoverControl
type ControlState = { revision: int, paused: bool, destination: int, pendingToken: int, pendingLink: int }
pure def controlShape(revision: int, paused: bool, destination: int, pendingToken: int, pendingLink: int): bool =
  revision >= 0 and destination >= 0 and
  (if (destination == 0) paused and pendingToken == 0 and pendingLink == 0
   else (pendingToken == 0 and pendingLink == 0) or (pendingToken > 0 and pendingLink > 0))
type ControlReceipt = { stored: bool, operationKey: int, fingerprint: int, committedRevision: int }
type ControlProof = { authority: bool, lexicalRequest: bool, expectedRevision: int, wantsDestination: int, destinationVerified: bool,
  mappingsCompatible: bool, dispatchActive: bool, linkExact: bool, recoverySettled: bool, capturedToken: int }
type ReplayDecision = NoReplay | ReplayReceipt | KeyConflict | SupersededReceipt
pure def replayControl(row: ControlReceipt, operationKey: int, fingerprint: int, revision: int): ReplayDecision =
  if (not(row.stored) or row.operationKey != operationKey) NoReplay
  else if (row.fingerprint != fingerprint) KeyConflict
  else if (row.committedRevision != revision) SupersededReceipt
  else ReplayReceipt
pure def admitsControl(control: ControlState, op: ControlOp, proof: ControlProof): bool =
  proof.authority and proof.lexicalRequest and control.revision == proof.expectedRevision and
  (if (op == PauseControl) true
  else if (op == SelectControl) control.paused and control.pendingToken == 0 and proof.wantsDestination >= 0 and
    (proof.wantsDestination == 0 or proof.destinationVerified)
  else if (op == ResumeControl) control.destination > 0 and control.pendingToken == 0 and proof.destinationVerified and proof.mappingsCompatible
  else control.paused and control.destination > 0 and control.pendingToken > 0 and not(proof.dispatchActive) and
    proof.destinationVerified and proof.linkExact and proof.recoverySettled and control.pendingToken == proof.capturedToken)
pure def nextControl(control: ControlState, op: ControlOp, proof: ControlProof): ControlState =
  if (op == PauseControl) { ...control, revision: control.revision + 1, paused: true }
  else if (op == SelectControl) { ...control, revision: control.revision + 1, destination: proof.wantsDestination }
  else if (op == ResumeControl) { ...control, revision: control.revision + 1, paused: false }
  else { ...control, revision: control.revision + 1, pendingToken: 0, pendingLink: 0 }
pure def mayClaimControl(control: ControlState, expectedRevision: int, dispatchDestination: int, linkId: int, token: int): bool =
  control.revision == expectedRevision and not(control.paused) and control.destination == dispatchDestination and
  dispatchDestination > 0 and linkId > 0 and token > 0 and control.pendingToken == 0
pure def maySettleControl(control: ControlState, token: int): bool =
  control.pendingToken > 0 and control.pendingToken == token
pure def lawPauseRetainsClaim(control: ControlState, proof: ControlProof): bool =
  val pausedControl = nextControl(control, PauseControl, proof)
  pausedControl.pendingToken == control.pendingToken and pausedControl.pendingLink == control.pendingLink and
  pausedControl.destination == control.destination and pausedControl.paused
pure def lawRecoverNeedsExactToken(control: ControlState, proof: ControlProof): bool =
  admitsControl(control, RecoverControl, proof) implies control.pendingToken == proof.capturedToken and
  proof.recoverySettled and proof.linkExact and not(proof.dispatchActive) and control.paused
pure def lawResumeDoesNotPreemptPending(control: ControlState, proof: ControlProof): bool =
  control.pendingToken > 0 implies not(admitsControl(control, ResumeControl, proof))
pure def lawRevisionSupersedesReplay(row: ControlReceipt, operationKey: int, fingerprint: int, revision: int): bool =
  row.committedRevision != revision implies replayControl(row, operationKey, fingerprint, revision) != ReplayReceipt
pure def lawDestinationlessControlPaused(revision: int, paused: bool, destination: int, pendingToken: int, pendingLink: int): bool =
  controlShape(revision, paused, destination, pendingToken, pendingLink) and destination == 0 implies
  paused and pendingToken == 0 and pendingLink == 0
pure def lawOneClaimPerControl(control: ControlState, expectedRevision: int, dispatchDestination: int, linkId: int, token: int): bool =
  control.pendingToken > 0 implies not(mayClaimControl(control, expectedRevision, dispatchDestination, linkId, token))
pure val controlValues = Set(
  { revision: 0, paused: true, destination: 0, pendingToken: 0, pendingLink: 0 },
  { revision: 1, paused: true, destination: 1, pendingToken: 1, pendingLink: 1 },
  { revision: 1, paused: false, destination: 1, pendingToken: 0, pendingLink: 0 })
pure val completeProof: ControlProof = { authority: true, lexicalRequest: true, expectedRevision: 1, wantsDestination: 2, destinationVerified: true,
  mappingsCompatible: true, dispatchActive: false, linkExact: true, recoverySettled: true, capturedToken: 1 }
pure val proofValues = Set(completeProof, { ...completeProof, expectedRevision: 0, wantsDestination: 1 },
  { ...completeProof, expectedRevision: 2 }, { ...completeProof, expectedRevision: 3 },
  { ...completeProof, expectedRevision: 4 }, { ...completeProof, mappingsCompatible: false }, { ...completeProof, recoverySettled: false },
  { ...completeProof, destinationVerified: false }, { ...completeProof, dispatchActive: true })
pure val rowValues = Set({ stored: false, operationKey: 0, fingerprint: 0, committedRevision: 0 },
  { stored: true, operationKey: 1, fingerprint: 1, committedRevision: 1 })
```

### Failed control writes preserve the previously committed row

An accepted revision-checked transition installs both the control and
its receipt; a failed write leaves the previously committed row. Dispatch
acquisition and ordinary exact settlement change neither revision
nor committed control receipt. Failed CAS and still-running
dispatch do not satisfy settlement or recovery.

```quint
type ControlLedger = { activeControl: ControlState, latestReceipt: ControlReceipt }
pure val initial: ControlLedger = {
  activeControl: { revision: 0, paused: true, destination: 0, pendingToken: 0, pendingLink: 0 },
  latestReceipt: { stored: false, operationKey: 0, fingerprint: 0, committedRevision: 0 } }
pure def canCommitReviewed(s: ControlLedger, op: ControlOp, proof: ControlProof, operationKey: int, fingerprint: int): bool =
  operationKey > 0 and fingerprint > 0 and replayControl(s.latestReceipt, operationKey, fingerprint, s.activeControl.revision) == NoReplay and
  admitsControl(s.activeControl, op, proof)
pure def commitReviewed(s: ControlLedger, op: ControlOp, proof: ControlProof, operationKey: int, fingerprint: int, casSaved: bool): ControlLedger =
  if (not(casSaved)) s
  else {
    activeControl: nextControl(s.activeControl, op, proof),
    latestReceipt: { stored: true, operationKey: operationKey, fingerprint: fingerprint, committedRevision: s.activeControl.revision + 1 }
  }
pure def canAcquirePending(s: ControlLedger, expectedRevision: int, dispatchDestination: int, linkId: int, token: int): bool =
  mayClaimControl(s.activeControl, expectedRevision, dispatchDestination, linkId, token)
pure def acquirePending(s: ControlLedger, expectedRevision: int, dispatchDestination: int, linkId: int, token: int): ControlLedger =
  val control = s.activeControl
  { ...s, activeControl: { ...control, pendingToken: token, pendingLink: linkId } }
pure def canSettleOwned(s: ControlLedger, token: int): bool =
  maySettleControl(s.activeControl, token)
pure def settleOwned(s: ControlLedger, token: int): ControlLedger =
  val control = s.activeControl
  { ...s, activeControl: { ...control, pendingToken: 0, pendingLink: 0 } }
pure def alwaysControlHasDestinationForDispatch(s: ControlLedger): bool =
  val control = s.activeControl
  controlShape(control.revision, control.paused, control.destination, control.pendingToken, control.pendingLink)
pure def alwaysCurrentReceiptRevision(s: ControlLedger): bool =
  if (s.latestReceipt.stored) s.latestReceipt.committedRevision == s.activeControl.revision and s.activeControl.revision > 0
  else s.activeControl.revision == 0
pure def stepRevisionChangeRequiresCommit(before: ControlLedger, via: str, after: ControlLedger): bool =
  after.activeControl.revision != before.activeControl.revision implies
  via == "commitReviewed" and after.activeControl.revision == before.activeControl.revision + 1
pure def sometimesSelectedControl(s: ControlLedger): bool = s.activeControl.destination > 0 and s.activeControl.paused
pure def sometimesActiveControl(s: ControlLedger): bool = not(s.activeControl.paused)
pure def sometimesPauseRetainsDispatch(s: ControlLedger): bool = s.activeControl.paused and s.activeControl.pendingToken > 0
pure val weight_commitReviewed = 8
pure val weight_acquirePending = 6
pure val operationKeyValues = Set(1, 2, 3)
pure val fingerprintValues = Set(1, 2)
pure val expectedRevisionValues = Set(0, 1, 2, 3, 4, 5)
pure val dispatchDestinationValues = Set(1, 2)
pure val linkIdValues = Set(1, 2)
pure val tokenValues = Set(1, 2)
```

## Story: Keep a link local or move it to the selected destination only while sync is drained

> As the owner, I want to keep one event local or move it to the selected
> destination without racing a sync that is still running.

### A mapping edit commits only while paused with no admitted dispatch, against the exact revision

A reviewed mapping edit either keeps one linked event local-only or
rebinds it to the currently selected destination. Both require paused
control with no pending dispatch, the exact expected control revision
and an exact review of that link. Keeping it local retains the
provider identity and marks the link local-only. Rebinding needs a
selected destination that differs from the link's current one, clears
the provider event identity and stages a fresh create with a new
handoff key. A committed edit advances the control revision by one.

```quint
type MappingEditOp = RetainLocal | Rebind
type LinkMapping = { destination: int, providerId: int, handoffKey: bool, localOnly: bool, staged: bool }
type MappingEdit = { op: MappingEditOp, expectedRevision: int, exactLinkReview: bool, requestDestination: int }
pure def mappingEditAllowed(control: ControlState, mapping: LinkMapping, edit: MappingEdit): bool =
  control.paused and control.pendingToken == 0 and edit.expectedRevision == control.revision and edit.exactLinkReview and
  (edit.op == RetainLocal or
    (control.destination > 0 and edit.requestDestination == control.destination and edit.requestDestination != mapping.destination))
pure def editedMapping(mapping: LinkMapping, edit: MappingEdit): LinkMapping =
  if (edit.op == RetainLocal) { ...mapping, localOnly: true }
  else { destination: edit.requestDestination, providerId: 0, handoffKey: true, localOnly: false, staged: true }
pure def lawMappingEditNeedsDrainedPause(control: ControlState, mapping: LinkMapping, edit: MappingEdit): bool =
  mappingEditAllowed(control, mapping, edit) implies control.paused and control.pendingToken == 0 and edit.expectedRevision == control.revision
pure def lawRetainLocalKeepsProviderIdentity(mapping: LinkMapping, edit: MappingEdit): bool =
  val after = editedMapping(mapping, edit)
  edit.op == RetainLocal implies after.destination == mapping.destination and after.providerId == mapping.providerId and after.localOnly
pure def lawRebindStagesFreshCreate(control: ControlState, mapping: LinkMapping, edit: MappingEdit): bool =
  val after = editedMapping(mapping, edit)
  edit.op == Rebind and mappingEditAllowed(control, mapping, edit) implies
  after.destination == control.destination and after.destination != mapping.destination and after.providerId == 0 and after.handoffKey and after.staged
pure val mappingValues = Set(
  { destination: 1, providerId: 1, handoffKey: false, localOnly: false, staged: false },
  { destination: 2, providerId: 3, handoffKey: false, localOnly: false, staged: false })
pure val editValues = Set(
  { op: RetainLocal, expectedRevision: 1, exactLinkReview: true, requestDestination: 0 },
  { op: Rebind, expectedRevision: 1, exactLinkReview: true, requestDestination: 1 },
  { op: Rebind, expectedRevision: 1, exactLinkReview: true, requestDestination: 2 },
  { op: Rebind, expectedRevision: 0, exactLinkReview: false, requestDestination: 2 })
```

### A mapping receipt replays only the same request at its committed revision

The mapping edit and its receipt commit together. A failed receipt
write rolls back and changes nothing. Once a receipt exists, the same
request (same operation, destination and expected revision, with an
exact link review) replays it while the control revision is still the
one it committed. Anything else, including the same request after a
newer control write, is refused and changes nothing.

```quint
type MappingReceipt = { revision: int, op: MappingEditOp, requestDestination: int }
type MappingReplay = MappingFresh | MappingReplayed | MappingRefused
pure def mappingReplay(receipt: MappingReceipt, control: ControlState, edit: MappingEdit): MappingReplay =
  if (receipt.revision == 0) MappingFresh
  else if (edit.expectedRevision + 1 == receipt.revision and edit.exactLinkReview and edit.op == receipt.op and
    edit.requestDestination == receipt.requestDestination and control.revision == receipt.revision) MappingReplayed
  else MappingRefused
pure def lawNewerControlRefusesMappingReplay(receipt: MappingReceipt, control: ControlState, edit: MappingEdit): bool =
  receipt.revision > 0 and control.revision != receipt.revision implies mappingReplay(receipt, control, edit) == MappingRefused
pure def lawDifferentRequestCannotReplay(receipt: MappingReceipt, control: ControlState, edit: MappingEdit): bool =
  receipt.revision > 0 and (edit.op != receipt.op or edit.requestDestination != receipt.requestDestination) implies
  mappingReplay(receipt, control, edit) != MappingReplayed
pure val receiptValues = Set(
  { revision: 0, op: RetainLocal, requestDestination: 0 },
  { revision: 2, op: Rebind, requestDestination: 2 },
  { revision: 2, op: RetainLocal, requestDestination: 0 })
```
