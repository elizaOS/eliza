# Alpha canonical Calendar sync control

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` reaches the resident
Calendar service from `apps/app/src/runtime/{google-connection-ui.tsx,google-accounts.ts,agent-calendar.ts}`.
Eliza gitlink `c518127a025ab173874af9c7d304f26b25213b0d` supplies
`plugins/plugin-calendar/src/api/calendar-api.ts`,
`routes/calendar-routes.ts`, and the resident
`service/{CalendarService,linked-calendar-control}.ts`.
The active paths are `/api/lifeops/calendar/sync-control` and
`/api/lifeops/calendar/links?view=events`. The older renderer-local
`calendar-sync-host.ts` has fixture entry points. Its local document
and sync wizard do not govern this route. The production resident's
managed Google broker can still use upstream Cloud `sync-v1` as a
provider port. This specification ends at that port and its receipt.

## Story: Link my resident Calendar to a verified Google destination

### Review the active owner and destination before changing control

Only verified account rows from the current Google panel and same
Cloud credential can begin the linking attempt. The panel has one
active attempt. A replaced panel or attempt cannot publish the old
result or clear the replacement's busy state. An authorization
return can request readback. It does not itself authorize linking.
The installed Calendar changes preference must pass the owner
review, including again if it was turned off while authorizing.
The browser Cloud host also consumes an explicit write-enable
receipt before the resident control call. A blocking Calendar draft, retired
resident, cancellation or absent current owner stops admission.

The helper only proceeds with a connected Google write grant. A
read-only grant reports that condition without a control read. The
controller waits for the current Calendar to settle and reads the
current control and owner sources together. Only Google owner-side
sources with owner or writer access are choices. This review names
the exact resident owner, agent, session and scope. The writer
rechecks the binding, view fence, draft, source and selection
version. Select and resume re-read the current owner sources and
verify the same source identity and selection version. Control
reads and writes use the resident canonical Calendar owner, independent
of which legacy local Calendar records may have been preserved.

With a saved destination, use its current writable source and
require its account email to match the approved Google grant
case-insensitively. If paused, keep its mappings by resuming it. Without a saved
destination, require exactly one eligible primary destination.
Each write sends the exact expected control revision and a stable
key with prefix `alpha-calendar-connect:` and a SHA-256 digest of
JSON array [owner key, operation, control revision, connector
account ID, calendar ID]. This key supplies retry identity only.
The captured review is dropped when the writer actually starts the
control call, after preflight. A failure before that point can
retain the last readback. A failure after it reports uncertainty.

```quint
type ConnectReview = { currentIntent: bool, exactCredential: bool, currentResident: bool, editable: bool, verifiedRows: bool, consent: bool }
type DestinationEvidence = { googleOwnerSource: bool, writable: bool, sameSource: bool, sameSelectionVersion: bool, approvedEmail: bool }
type DestinationChoice = ResumeDestination | SelectPrimary | ChooseDestination | RefuseDestination
pure def panelMayLink(review: ConnectReview): bool =
  review.currentIntent and review.exactCredential and review.currentResident and review.editable and review.verifiedRows and review.consent
pure def panelMayPublish(currentIntent: bool, exactCredential: bool, activeAttempt: bool): bool =
  currentIntent and exactCredential and activeAttempt
pure def mayWriteDestination(destinationEvidence: DestinationEvidence): bool =
  destinationEvidence.googleOwnerSource and destinationEvidence.writable and destinationEvidence.sameSource and
  destinationEvidence.sameSelectionVersion and destinationEvidence.approvedEmail
pure def linkChoice(savedDestination: bool, savedListed: bool, approvedEmail: bool, approvedPrimaryCount: int): DestinationChoice =
  if (savedDestination) (if (savedListed and approvedEmail) ResumeDestination else RefuseDestination)
  else if (approvedPrimaryCount == 1) SelectPrimary else ChooseDestination
pure def lawRetiredPanelDoesNotPublish(currentIntent: bool, exactCredential: bool, activeAttempt: bool): bool =
  not(currentIntent and exactCredential and activeAttempt) implies not(panelMayPublish(currentIntent, exactCredential, activeAttempt))
pure def lawUnknownSelectionVersionCannotWrite(destinationEvidence: DestinationEvidence): bool =
  not(destinationEvidence.sameSelectionVersion) implies not(mayWriteDestination(destinationEvidence))
pure def lawSavedDestinationDoesNotSwitch(savedListed: bool, approvedEmail: bool, approvedPrimaryCount: int): bool =
  linkChoice(true, savedListed, approvedEmail, approvedPrimaryCount) != SelectPrimary
pure val reviewValues = Set(
  { currentIntent: true, exactCredential: true, currentResident: true, editable: true, verifiedRows: true, consent: true },
  { currentIntent: true, exactCredential: true, currentResident: true, editable: false, verifiedRows: true, consent: true })
pure val destinationEvidenceValues = Set(
  { googleOwnerSource: true, writable: true, sameSource: true, sameSelectionVersion: true, approvedEmail: true },
  { googleOwnerSource: true, writable: true, sameSource: true, sameSelectionVersion: false, approvedEmail: true })
```

### Report sync only after a current control and mapping readback

The helper uses at most three reviews and two write dispatches.
The last review can finish or report a pending result but cannot
write. After a previously acknowledged write, the next control
revision must equal its receipt revision. A changed revision is
reported as changed elsewhere. Missing or different destination
approval cannot become a positive result. A step that finds
a bad destination or a stale revision reports Not linked,
including after an acknowledged write. A thrown failure
after dispatch reports Unconfirmed. Paused or no destination
with pending dispatch reports waiting without a new write. For
an active approved destination, the first nonempty pending dispatch
read triggers another review. If the next dispatch identity differs,
report Syncing. If it is unchanged, report Unconfirmed. Active
control with no dispatch must read event mappings, and only success
with no conflicted or quarantined mapping for this destination
reports Synced. Foreign destination holds do not count. A failure
reading links is Unconfirmed. The mapping projection names owner
event rows and provider identities. It cannot read a native ticket
or confirm provider settlement by itself.

This model distinguishes a checked response from a send. A same
attempt publication permit describes the outer panel fence.
The helper's actual result can retain the latest review unless a
write was launched after it.

```quint
type LinkStep = ReviewAgain | MayDispatchControl | LoadLinkStates | ReportWaiting | ReportSyncing | ReportSynced | ReportUnconfirmed | ReportChanged
pure def linkReadback(ordinal: int, revisionMatches: bool, activeApproved: bool, pendingId: int, priorPendingKnown: bool, priorPendingId: int): LinkStep =
  if (not(revisionMatches)) ReportChanged
  else if (activeApproved) (
    if (pendingId == 0) LoadLinkStates
    else if (not(priorPendingKnown)) ReviewAgain
    else if (priorPendingId != pendingId) ReportSyncing
    else ReportUnconfirmed)
  else if (pendingId != 0) ReportWaiting
  else if (ordinal >= 3) ReportUnconfirmed
  else MayDispatchControl
pure def linkCompletion(readback: LinkStep, linksRead: bool, heldCount: int): LinkStep =
  if (readback == LoadLinkStates)
    (if (linksRead and heldCount == 0) ReportSynced else ReportUnconfirmed)
  else readback
pure def retainLastReview(observedReview: bool, sentAfterReview: bool): bool =
  observedReview and not(sentAfterReview)
pure def lawNoThirdControlWrite(ordinal: int, revisionMatches: bool, activeApproved: bool, pendingId: int, priorPendingKnown: bool, priorPendingId: int): bool =
  ordinal >= 3 implies linkReadback(ordinal, revisionMatches, activeApproved, pendingId, priorPendingKnown, priorPendingId) != MayDispatchControl
pure def lawSyncedNeedsMappingRead(readback: LinkStep, linksRead: bool, heldCount: int): bool =
  readback != ReportSynced and linkCompletion(readback, linksRead, heldCount) == ReportSynced implies
  readback == LoadLinkStates and linksRead and heldCount == 0
pure def lawPendingUnchangedCannotBeSynced(ordinal: int, pendingId: int): bool =
  pendingId > 0 implies linkReadback(ordinal, true, true, pendingId, true, pendingId) == ReportUnconfirmed
pure def lawAWriteRemovesPriorReadback(observedReview: bool): bool =
  not(retainLastReview(observedReview, true))
pure val ordinalValues = Set(1, 2, 3)
pure val pendingIdValues = Set(0, 1, 2)
pure val priorPendingIdValues = pendingIdValues
pure val heldCountValues = Set(0, 1, 2)
```

## Story: Pause, resume or recover without replacing a newer sync decision

### A control transition checks revision and writes its receipt atomically

Public control publishes revision, paused, exact destination,
matching-destination conflict count and pending link ID. It
does not publish the durable dispatch token. The resident POST
uses the owner mutation gateway. Saved control requires a complete
destination pair and either both pending fields or neither. With
no destination it is paused and has no pending link. A migrated
dispatch may have no valid acquisition timestamp. The POST
accepts pause, select, resume and recover. It requires a
nonnegative safe integer revision and trimmed key of 1–512
units. Its fingerprint is SHA-256 of the stable string encoding
of the normalized request. Receipt lookup is per agent and key.
An equal fingerprint replays the same committed receipt only
when its revision remains the current revision observed by the
service. A concurrent commit that the repository finds after a
failed CAS instead returns its matching receipt. Another payload
using that key is an operation conflict. A newer control revision
supersedes the previous receipt as a description of current
control. A normal commit bumps revision by one and records its
receipt in the same SQL statement. Failure of that atomic write
cannot publish the candidate update.

Pause keeps the destination and pending dispatch. Select requires
paused and no pending dispatch, accepts either explicit null or
an exact verified writable destination, and cannot change a
different agent's control. Resume verifies the stored destination,
requires no pending dispatch, and refuses any existing active
mapping to another destination. Paused and local-only links do
not veto that check. The resident then bootstraps eligible owner
Calendar events and kicks reconciliation. Exact resume replay
may bootstrap again using the already committed selection.
The dispatch port admits one active mapping at a time only for
the exact unpaused destination and expected revision.
An ordinary exact settlement clears that pending token without
incrementing the control revision. Pause may win a race after
claim, retaining the claim until exact settlement or recovery.

Recovery must be paused with a pending token and a verified
current destination. A token still active in this process blocks
recovery. The mapped link must belong to that destination. The
provider recovery read uses a 60-second settle window anchored at the later
valid dispatch or checkpoint timestamp and checks exact provider
evidence. An unresolved read leaves control paused and pending.
Recovery never retries the uncertain provider write. A resolved
read clears only the captured token with the exact paused
revision. The new revision invalidates prior resume reviews.

Provider mutation and recovery details remain with the reconciler.
For production managed feeds the resident can pull updates of
already-mapped clean events in the selected active destination
before projection. Pending dispatch, held links and unrelated
provider events cannot cause that pull. This control model only
takes outcome evidence from that producer. It does not expand
CalendarProvider rows, merge Google event contents, or change
the separate disconnect authority.

```quint
type ControlOp = PauseControl | SelectControl | ResumeControl | RecoverControl
type ControlState = { revision: int, paused: bool, destination: int, pendingToken: int, pendingLink: int }
pure def controlShape(revision: int, paused: bool, destination: int, pendingToken: int, pendingLink: int): bool =
  revision >= 0 and destination >= 0 and
  (if (destination == 0) paused and pendingToken == 0 and pendingLink == 0
   else (pendingToken == 0 and pendingLink == 0) or (pendingToken > 0 and pendingLink > 0))
type ControlReceipt = { stored: bool, testKey: int, fingerprint: int, committedRevision: int }
type ControlProof = { authority: bool, lexicalRequest: bool, expectedRevision: int, wantsDestination: int, destinationVerified: bool,
  mappingsCompatible: bool, dispatchActive: bool, linkExact: bool, recoverySettled: bool, capturedToken: int }
type ReplayDecision = NoReplay | ReplayReceipt | KeyConflict | SupersededReceipt
pure def replayControl(row: ControlReceipt, testKey: int, fingerprint: int, revision: int): ReplayDecision =
  if (not(row.stored) or row.testKey != testKey) NoReplay
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
pure def lawRevisionSupersedesReplay(row: ControlReceipt, testKey: int, fingerprint: int, revision: int): bool =
  row.committedRevision != revision implies replayControl(row, testKey, fingerprint, revision) != ReplayReceipt
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
pure val rowValues = Set({ stored: false, testKey: 0, fingerprint: 0, committedRevision: 0 },
  { stored: true, testKey: 1, fingerprint: 1, committedRevision: 1 })
```

### Failed control writes preserve the previously committed row

The model records the active control and one most recent receipt.
The real repository looks up each agent's retained operation by key,
so the one-receipt model covers atomicity and does not replace
the production operation-key table. An accepted revision-checked
transition installs both the control and its receipt. Dispatch
acquisition and ordinary exact settlement change neither revision
nor committed control receipt. Failed CAS and still-running
dispatch do not satisfy settlement or recovery.

```quint
type ControlLedger = { activeControl: ControlState, latestReceipt: ControlReceipt }
pure val initial: ControlLedger = {
  activeControl: { revision: 0, paused: true, destination: 0, pendingToken: 0, pendingLink: 0 },
  latestReceipt: { stored: false, testKey: 0, fingerprint: 0, committedRevision: 0 } }
pure def canCommitReviewed(s: ControlLedger, op: ControlOp, proof: ControlProof, testKey: int, fingerprint: int): bool =
  testKey > 0 and fingerprint > 0 and replayControl(s.latestReceipt, testKey, fingerprint, s.activeControl.revision) == NoReplay and
  admitsControl(s.activeControl, op, proof)
pure def commitReviewed(s: ControlLedger, op: ControlOp, proof: ControlProof, testKey: int, fingerprint: int, casSaved: bool): ControlLedger =
  if (not(casSaved)) s
  else {
    activeControl: nextControl(s.activeControl, op, proof),
    latestReceipt: { stored: true, testKey: testKey, fingerprint: fingerprint, committedRevision: s.activeControl.revision + 1 }
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
pure val testKeyValues = Set(1, 2, 3)
pure val fingerprintValues = Set(1, 2)
pure val expectedRevisionValues = Set(0, 1, 2, 3, 4, 5)
pure val dispatchDestinationValues = Set(1, 2)
pure val linkIdValues = Set(1, 2)
pure val tokenValues = Set(1, 2)
```
