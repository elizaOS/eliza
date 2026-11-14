# Native deferred deletion and Undo custody

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` uses the
Eliza `c518127a025ab173874af9c7d304f26b25213b0d`
`plugins/plugin-native-action-journal` Android deletion coordinator and
`@elizaos/contracts/deletion-window`. The pinned owner model is
`quint/DeletionOwnerAdmission.qnt`. Calendar provider review supplies
the selected target and dispatch outcome. The reminder store owns its
rows and the suspension and delivery effects for occurrences. This
specification owns the Calendar journal's durable dispatch claim and
common coordinator decisions where both kinds participate.

## Story: Keep the item when I undo a reviewed deletion before dispatch

### An owned exact intent retains the original ten-second Undo window

A just-reviewed Calendar deletion stages one version-1 row containing the
operation ID, authenticated owner, selected target and deadline. Operation
IDs consist of 1–128 ASCII letters, digits, underscores and hyphens.
The owner is the current installation or an agent identity with the
current review fence. The same stored ID, owner and structurally equal
target returns the existing row, including its deadline and outcome.
A different owner or target for that ID is refused. An exact replay can
return a dispatching row as recorded; the notice gives it the conservative
unknown projection. Two equal JSON objects may use different key orders.

The ten-second deadline uses elapsed time on one continuity. A different
continuity or elapsed time earlier than creation is a clock change.
Wall time is used for display and ordering receipt retention. The
native constructor checks nonnegative signed-64-bit clock inputs with
room for the window. The browser wire uses a nonnegative finite elapsed
time and safe integer wall time. The model uses validated clock facts
and integer millisecond points for the shared ordering.

```quint
type DeletionWindow = OpenUndoWindow | ExpiredUndoWindow | ChangedDeletionClock
type StageDecision = StageNewDeletion | ReplayDeletionRow | RefuseDeletionOwner | RefuseDeletionId | RefuseDeletionIdentity
pure val undoWindowMs = 10000
pure def nativeDeadlineAdmitted(continuityUnits: int, nativeElapsedFits: bool, nativeWallFits: bool): bool =
  continuityUnits >= 1 and continuityUnits <= 200 and nativeElapsedFits and nativeWallFits
pure def journalWindow(sameContinuity: bool, createdMs: int, nowMs: int): DeletionWindow =
  if (not(sameContinuity) or nowMs < createdMs) ChangedDeletionClock
  else if (nowMs < createdMs + undoWindowMs) OpenUndoWindow
  else ExpiredUndoWindow
pure def deletionStageDecision(ownerCurrent: bool, idValid: bool, rowExists: bool, exactOwner: bool, exactTarget: bool): StageDecision =
  if (not(ownerCurrent)) RefuseDeletionOwner
  else if (not(idValid)) RefuseDeletionId
  else if (not(rowExists)) StageNewDeletion
  else if (exactOwner and exactTarget) ReplayDeletionRow
  else RefuseDeletionIdentity
pure def lawChangedClockDoesNotExpire(sameContinuity: bool, createdMs: int, nowMs: int): bool =
  (not(sameContinuity) or nowMs < createdMs) implies journalWindow(sameContinuity,createdMs,nowMs) == ChangedDeletionClock
pure def lawDeadlineBoundary(createdMs: int): bool =
  journalWindow(true,createdMs,createdMs + undoWindowMs - 1) == OpenUndoWindow and
  journalWindow(true,createdMs,createdMs + undoWindowMs) == ExpiredUndoWindow
pure def lawReplayRequiresExactRetainedIdentity(ownerCurrent: bool, idValid: bool, exactOwner: bool, exactTarget: bool): bool =
  deletionStageDecision(ownerCurrent,idValid,true,exactOwner,exactTarget) == ReplayDeletionRow implies
    ownerCurrent and idValid and exactOwner and exactTarget
pure val continuityUnitsValues = Set(0, 1, 200, 201)
pure val createdMsValues = Set(0, 100)
pure val nowMsValues = Set(-1, 0, 100, 9999, 10000, 10100)
```

### A durable claim gives Undo and provider dispatch one winner

Undo observes the clock on arrival and still has to win the journal
transaction. It requires the same enrolled owner, or the exact manual
installation. An equivalent enrolled agent may have rotated its session
or review fence since staging. An unapplied paused row may be undone
after the original deadline. A queued row may be undone while open or on
a changed clock. An expired same-clock queued row is too late. The first
Undo requires successful persistence; an already undone receipt repeats
success without writing. A dispatching row, a conflict or an unknown
outcome cannot acknowledge Undo. If a native provider explicitly refuses
permission without mutation, its paused row may still be undone.

At same-clock expiry, the coordinator first confirms the staged owner
and review fence. It checks provider admission before saving the
dispatching phase. The native provider can be invoked only after that
save succeeds. A subsequent definitive readback confirms deletion,
conflict, or permission refusal. A null, unexpected or failed readback
is uncertain. If the outcome save fails, the journal retains dispatching
and subsequent observations report unknown. The same row never starts
another provider call. Discovered by the proof: a paused or undone row can retain a provider call
only when that call returned explicit permission refusal without mutation.
The model applies to a retained row and represents
the provider invocation separately from durable phase. The storage
adapter confirms writes or surfaces failure. Exact physical durability
is an adapter property.

```quint
type NativeDeletionPhase = JournalQueued | JournalPaused | JournalDispatching | JournalUndone | JournalDeleted | JournalConflict | JournalUnknown
type ProviderDeletion = ProviderDeleted | ProviderConflict | ProviderPermission | ProviderUncertain
type DeletionJournal = { phase: NativeDeletionPhase, calls: int, claimed: bool, liveClaim: bool, permissionRefused: bool, dismissed: bool }
pure val initial: DeletionJournal = { phase: JournalQueued, calls: 0, claimed: false, liveClaim: false, permissionRefused: false, dismissed: false }
pure def canUndoJournal(s: DeletionJournal, enrolledOwner: bool, window: DeletionWindow, durable: bool): bool =
  enrolledOwner and (s.phase == JournalUndone or
  (durable and (s.phase == JournalPaused or (s.phase == JournalQueued and window != ExpiredUndoWindow))))
pure def undoJournal(s: DeletionJournal, enrolledOwner: bool, window: DeletionWindow, durable: bool): DeletionJournal =
  if (s.phase == JournalUndone) s else { ...s, phase: JournalUndone }
pure def canPauseBeforeDispatch(s: DeletionJournal, window: DeletionWindow, refused: bool, durable: bool): bool =
  s.phase == JournalQueued and window == ExpiredUndoWindow and refused and durable
pure def pauseBeforeDispatch(s: DeletionJournal, window: DeletionWindow, refused: bool, durable: bool): DeletionJournal =
  { ...s, phase: JournalPaused }
pure def canClaimDeletion(s: DeletionJournal, window: DeletionWindow, exactOwner: bool, currentFence: bool, providerAdmitted: bool, durable: bool): bool =
  s.phase == JournalQueued and window == ExpiredUndoWindow and exactOwner and currentFence and providerAdmitted and durable
pure def claimDeletion(s: DeletionJournal, window: DeletionWindow, exactOwner: bool, currentFence: bool, providerAdmitted: bool, durable: bool): DeletionJournal =
  { ...s, phase: JournalDispatching, claimed: true, liveClaim: true }
pure def canInvokeDeletion(s: DeletionJournal): bool =
  s.phase == JournalDispatching and s.claimed and s.liveClaim and s.calls == 0
pure def invokeDeletion(s: DeletionJournal): DeletionJournal = { ...s, calls: 1 }
pure def canRecordDeletion(s: DeletionJournal, durable: bool): bool =
  s.phase == JournalDispatching and s.liveClaim and s.calls == 1 and durable
pure def recordDeletion(s: DeletionJournal, durable: bool, observation: ProviderDeletion): DeletionJournal =
  match observation {
    ProviderDeleted => { ...s, phase: JournalDeleted, liveClaim: false }
    | ProviderConflict => { ...s, phase: JournalConflict, liveClaim: false }
    | ProviderPermission => { ...s, phase: JournalPaused, liveClaim: false, permissionRefused: true }
    | ProviderUncertain => { ...s, phase: JournalUnknown, liveClaim: false }
  }
pure def canLoseLiveDeletionClaim(s: DeletionJournal): bool =
  s.phase == JournalDispatching and s.liveClaim
pure def loseLiveDeletionClaim(s: DeletionJournal): DeletionJournal = { ...s, liveClaim: false }
pure def projectedDeletionPhase(phase: NativeDeletionPhase): NativeDeletionPhase =
  if (phase == JournalDispatching) JournalUnknown else phase
pure def canDismissDeletion(s: DeletionJournal, enrolledOwner: bool, durable: bool): bool =
  enrolledOwner and durable and not(s.liveClaim) and projectedDeletionPhase(s.phase) == JournalUnknown
pure def dismissDeletion(s: DeletionJournal, enrolledOwner: bool, durable: bool): DeletionJournal =
  { ...s, dismissed: true }
pure def alwaysProviderCallRequiresDurableClaim(s: DeletionJournal): bool =
  s.calls >= 0 and s.calls <= 1 and (s.calls == 1 implies s.claimed) and
  ((s.phase == JournalQueued or s.phase == JournalPaused or s.phase == JournalUndone) implies
    (s.calls == 0 or s.permissionRefused)) and
  (s.phase == JournalQueued implies not(s.claimed or s.permissionRefused)) and
  (s.liveClaim implies s.phase == JournalDispatching) and
  (s.phase == JournalDispatching implies s.claimed and not(s.permissionRefused)) and
  ((s.phase == JournalDeleted or s.phase == JournalConflict or s.phase == JournalUnknown) implies s.calls == 1) and
  (s.permissionRefused implies s.calls == 1 and (s.phase == JournalPaused or s.phase == JournalUndone))
pure def stepUndoRetainsNoNewCall(before: DeletionJournal, via: str, after: DeletionJournal): bool =
  via == "undoJournal" implies after.phase == JournalUndone and after.calls == before.calls and
    (after.calls == 0 or after.permissionRefused)
pure def stepAcknowledgingDoesNotSettle(before: DeletionJournal, via: str, after: DeletionJournal): bool =
  via == "dismissDeletion" implies after.phase == before.phase and after.calls == before.calls and after.claimed == before.claimed
pure def stepTerminalDoesNotRestart(before: DeletionJournal, after: DeletionJournal): bool =
  (before.phase == JournalDeleted or before.phase == JournalUndone or before.phase == JournalConflict or before.phase == JournalUnknown)
  implies after.phase == before.phase and after.calls == before.calls
pure def stepLostProcessCannotResumeClaim(before: DeletionJournal, after: DeletionJournal): bool =
  before.phase == JournalDispatching and not(before.liveClaim) implies
    after.phase == JournalDispatching and not(after.liveClaim) and after.calls == before.calls
pure def sometimesInterruptedDispatchStaysUncertain(s: DeletionJournal): bool =
  s.phase == JournalDispatching and not(s.liveClaim) and s.calls == 1
pure def lawUnknownCannotBeUndone(s: DeletionJournal, enrolledOwner: bool, window: DeletionWindow, durable: bool): bool =
  projectedDeletionPhase(s.phase) == JournalUnknown implies not(canUndoJournal(s,enrolledOwner,window,durable))
pure def sometimesUndoKeepsUncalledItem(s: DeletionJournal): bool = s.phase == JournalUndone and s.calls == 0
pure def sometimesProviderReceiptVerified(s: DeletionJournal): bool = s.phase == JournalDeleted
pure def sometimesUnknownReceiptDismissed(s: DeletionJournal): bool = s.phase == JournalUnknown and s.dismissed
pure def sometimesPermissionRefusalAllowsUndo(s: DeletionJournal): bool = s.phase == JournalUndone and s.permissionRefused
pure val weight_claimDeletion = 10
pure val weight_invokeDeletion = 10
pure val weight_recordDeletion = 10
```

## Story: Preserve uncertain receipts and respect the owner across session changes

### Authentication precedes mutation and unreadable authority never permits dispatch

Agent authentication happens outside the coordinator lock. The exact
owner includes the prior review fence. A changed owner pauses without
checking the old fence. An equal encoded owner must still pass the
fresh fence check. A thrown Calendar fence check records an unavailable
pause. A thrown reminder fence check leaves the row queued with a
retry signal. An unavailable agent route retries while elapsed time is
less than 24 hours past expiry, then pauses. A changed clock never
dispatches. A queued row on that clock remains readable with the
changed-clock state and may be undone by its enrolled owner.

Notice visibility and Undo use stable identity. The agent identity
keeps the same subject user, agent, installation, enrollment, account
reference and environment. The manual installation matches structurally.
The notice may use a previously authenticated owner for five seconds
only while the cached review fence remains current. Read failures hide
agent notices for five seconds. Dismiss needs the same enrolled owner,
takes only uncertain receipts, and keeps the durable phase. Reminder
recovery effects that already settled may retry as idempotent local
effects for the same enrolled owner and retain their occurrence binding.

```quint
type DeletionRecordKind = CalendarDeletion | ReminderDeletion
type DeletionOwnerRead = SameDeletionOwner | ChangedDeletionOwner | UnavailableDeletionOwner
type DeletionFence = FreshDeletionFence | StaleDeletionFence | UnreadableDeletionFence
type DeletionExpiry = WaitForDeletionWindow | RetryDeletionOwner | PauseDeletionOwnerChanged | PauseDeletionOwnerUnavailable | AdmitDeletionProvider
pure val ownerRetryMs = 86400000
pure def checksDeletionFence(window: DeletionWindow, ownerRead: DeletionOwnerRead): bool =
  window == ExpiredUndoWindow and ownerRead == SameDeletionOwner
pure def expireDeletionOwner(kind: DeletionRecordKind, window: DeletionWindow, ownerRead: DeletionOwnerRead,
  fence: DeletionFence, elapsedSinceExpiry: int): DeletionExpiry =
  if (window != ExpiredUndoWindow) WaitForDeletionWindow
  else if (ownerRead == ChangedDeletionOwner) PauseDeletionOwnerChanged
  else if (ownerRead == UnavailableDeletionOwner)
    (if (elapsedSinceExpiry < ownerRetryMs) RetryDeletionOwner else PauseDeletionOwnerUnavailable)
  else if (fence == FreshDeletionFence) AdmitDeletionProvider
  else if (fence == StaleDeletionFence) PauseDeletionOwnerChanged
  else if (kind == CalendarDeletion) PauseDeletionOwnerUnavailable
  else RetryDeletionOwner
pure def lawAdmittedDeletionHasExactCurrentOwner(kind: DeletionRecordKind, window: DeletionWindow, ownerRead: DeletionOwnerRead,
  fence: DeletionFence, elapsedSinceExpiry: int): bool =
  expireDeletionOwner(kind,window,ownerRead,fence,elapsedSinceExpiry) == AdmitDeletionProvider implies
    checksDeletionFence(window,ownerRead) and fence == FreshDeletionFence
pure def lawChangedOwnerSkipsFence(kind: DeletionRecordKind, fence: DeletionFence, elapsedSinceExpiry: int): bool =
  not(checksDeletionFence(ExpiredUndoWindow,ChangedDeletionOwner)) and
  expireDeletionOwner(kind,ExpiredUndoWindow,ChangedDeletionOwner,fence,elapsedSinceExpiry) == PauseDeletionOwnerChanged
pure val elapsedSinceExpiryValues = Set(0, 86399999, 86400000, 86400001)
```

### Retention leaves unresolved identities intact

After a new reviewed stage, the journal first retires older definitive
deleted, undone or conflict rows past 127 and then retires more
definitive rows as needed for the row or UTF-8 byte limit. It sorts by
wall-clock expiry with elapsed creation as the tie breaker. It refuses
when occupancy would exceed 500 or encoded stage data would exceed
3 MiB and no eligible receipt remains. Queued, paused, dispatching
and unknown rows are never eligible. Dismissal marks are kind-scoped
and limited to 1,000 distinct keys. An existing mark can be saved again.
The storage adapter owns exact byte counting and persistence.

```quint
pure def terminalDeletionRetirable(phase: NativeDeletionPhase): bool =
  phase == JournalDeleted or phase == JournalUndone or phase == JournalConflict
pure def withinDeletionStageLimits(retainedRows: int, stagedBytes: int): bool =
  retainedRows >= 0 and retainedRows < 500 and stagedBytes >= 0 and stagedBytes <= 3145728
pure def acknowledgementAdmitted(markCount: int, existingMark: bool): bool =
  markCount >= 0 and (existingMark or markCount < 1000)
pure def lawPendingAndUncertainCannotRetire(phase: NativeDeletionPhase): bool =
  (phase == JournalQueued or phase == JournalPaused or projectedDeletionPhase(phase) == JournalUnknown) implies
    not(terminalDeletionRetirable(phase))
pure def lawFullAcknowledgementsPreserveExactReplay(markCount: int): bool =
  markCount >= 1000 implies acknowledgementAdmitted(markCount,true) and not(acknowledgementAdmitted(markCount,false))
pure val retainedRowsValues = Set(0, 127, 499, 500)
pure val stagedBytesValues = Set(0, 3145728, 3145729)
pure val markCountValues = Set(0, 999, 1000)
```

### An approved agent deletion settles through its own exact native receipt

The bridge accepts the agent identity for an unexpired applying action,
with its exact operation, current authenticated account, agent,
installation and enrollment. Sensitive context is refused. A prior
native dispatch claim refuses another claim. The claim is permanent in
the existing action journal entry, even if staging never confirms.

Recovery reads the receipt and its exact retained owner, operation ID,
scope, proposal, operation hash and approved target fields. Reminder
recovery also compares the complete approved operation in the binding.
A deleted Calendar receipt needs a deleted provider outcome. A deleted
reminder needs complete or superseded local effects and a matching
cancelled result for the selected source, reminder and occurrence.
An exact undone or conflict receipt settles as a failed action with
the original outcome. Pending or uncertain receipts produce no terminal
settlement. A previously definitive action is left intact. Recovery
returns an action journal projection and never dispatches another
provider call.

```quint
type ActionDeletionClaim = { agentOwner: bool, applying: bool, operationIdExact: bool, reviewStillValid: bool,
  nonSensitive: bool, operationExact: bool, agentIdentityExact: bool, alreadyClaimed: bool }
type DeletionRecovery = { eligibleAction: bool, nativeClaim: bool, operationIdExact: bool, ownerExact: bool,
  bindingExact: bool, targetExact: bool, operationExact: bool, calendarProof: bool, reminderProof: bool }
type DeletionSettlement = LeaveActionAlone | RecoverDeletionSuccess | RecoverDeletionKept | RecoverDeletionConflict
pure def actionDeletionAdmitted(approved: ActionDeletionClaim): bool =
  approved.agentOwner and approved.applying and approved.operationIdExact and approved.reviewStillValid and
  approved.nonSensitive and approved.operationExact and approved.agentIdentityExact and not(approved.alreadyClaimed)
pure def recoverDeletion(kind: DeletionRecordKind, phase: NativeDeletionPhase, evidence: DeletionRecovery): DeletionSettlement =
  if (not(evidence.eligibleAction and evidence.nativeClaim and evidence.operationIdExact and evidence.ownerExact and
    evidence.bindingExact and evidence.targetExact and (kind == CalendarDeletion or evidence.operationExact))) LeaveActionAlone
  else if (phase == JournalUndone) RecoverDeletionKept
  else if (phase == JournalConflict) RecoverDeletionConflict
  else if (phase == JournalDeleted and (if (kind == CalendarDeletion) evidence.calendarProof else evidence.reminderProof))
    RecoverDeletionSuccess else LeaveActionAlone
pure def lawNativeActionClaimCannotBeReused(approved: ActionDeletionClaim): bool =
  approved.alreadyClaimed implies not(actionDeletionAdmitted(approved))
pure def lawUncertainReceiptDoesNotSettle(kind: DeletionRecordKind, phase: NativeDeletionPhase, evidence: DeletionRecovery): bool =
  projectedDeletionPhase(phase) == JournalUnknown implies recoverDeletion(kind,phase,evidence) == LeaveActionAlone
pure def lawDeletionRecoveryNeverCrossesOwner(kind: DeletionRecordKind, phase: NativeDeletionPhase, evidence: DeletionRecovery): bool =
  recoverDeletion(kind,phase,evidence) != LeaveActionAlone implies
  evidence.nativeClaim and evidence.ownerExact and evidence.bindingExact and evidence.targetExact
pure val matchingAction: ActionDeletionClaim = { agentOwner: true, applying: true, operationIdExact: true, reviewStillValid: true,
  nonSensitive: true, operationExact: true, agentIdentityExact: true, alreadyClaimed: false }
pure val approvedValues = Set(matchingAction, { ...matchingAction, alreadyClaimed: true }, { ...matchingAction, nonSensitive: false },
  { ...matchingAction, agentIdentityExact: false }, { ...matchingAction, reviewStillValid: false })
pure val matchingReceipt: DeletionRecovery = { eligibleAction: true, nativeClaim: true, operationIdExact: true, ownerExact: true,
  bindingExact: true, targetExact: true, operationExact: true, calendarProof: true, reminderProof: true }
pure val evidenceValues = Set(matchingReceipt, { ...matchingReceipt, nativeClaim: false }, { ...matchingReceipt, ownerExact: false },
  { ...matchingReceipt, bindingExact: false }, { ...matchingReceipt, targetExact: false }, { ...matchingReceipt, operationExact: false },
  { ...matchingReceipt, calendarProof: false }, { ...matchingReceipt, reminderProof: false })
```
