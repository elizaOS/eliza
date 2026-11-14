# Linked Calendar event reconciliation and dispatch recovery

The pinned resident caller `CalendarService.ts` instantiates
`LinkedCalendarReconciler` from Eliza `c518127a025ab173874af9c7d304f26b25213b0d`
`packages/contracts/src/calendar-linked-sync.ts`. It supplies local compare
and set, retained checkpoint and provider ports. [Calendar sync control](./canonicalCalendarSync.md)
owns dispatch barrier and manual commands. The [managed feed](./managedCalendarFeed.md)
owns admission to reconciliation from a feed. This contract owns the per-link
decision, including read-only recovery. The provider owns its exact durable
write and declared result semantics.

## Story: Bring the two versions together without overwriting an independent edit

### The current checkpoint distinguishes clean, changed, missing and conflicting readings

A paused or local-only link returns without loading either side. A quarantined
link also returns without loading either side. A conflict uses a read-only
convergence check. Both sides must exist, be live and agree semantically
before an automatic checkpoint can clear the conflict.

For other links, a missing local row either has a durable pending delete
or is quarantined as missing. A pending delete still reads the provider.
A present provider copy is removed under the retained version. An absent
copy settles the local deletion without a provider call. If both snapshots
exist and have diverged from their last common hash and from each other,
record a conflict instead of acting. If only the provider changed, pull its
exact event or deletion under the previously read local revision. Provider
absence for a previously linked event with unchanged local state also
removes the local copy under that revision and retains a paused link. A
local CAS failure quarantines the link. If the provider is absent in other
cases, or the local event changed with differing semantics, proceed to the
push decision. An otherwise clean row refreshes its checkpoint only when
its retained state, hash, local revision or provider etag differs.

The pin's semantic digest preserves relevant body, attendee and recurrence
data and accepts its documented legacy all-day hash where applicable. Hash,
timestamp and compare-and-set evidence are explicit inputs. Calendar
permission and side binding are the caller and provider port's responsibility.

```quint
type CalendarLinkPhase = LinkClean | LinkDirty | LinkPaused | LinkLocalOnly | LinkConflicted | LinkQuarantined
type CalendarLinkOperation = LinkNoOperation | LinkCreate | LinkUpdate | LinkDelete
type LinkedCalendarReading = { linkPhase: CalendarLinkPhase, pendingLink: CalendarLinkOperation,
  localExists: bool, providerExists: bool, providerDeleted: bool, linkedProviderId: bool, localChanged: bool,
  providerChanged: bool, semanticMatch: bool, checkpointNeedsRefresh: bool }
type LinkReconciliation = KeepPausedLink | KeepQuarantinedLink | CheckConvergedLink | QuarantineMissingLocal |
  ReplayRetainedDelete | RecordConcurrentLinkEdit | PullProviderEdit | PullProviderDelete |
  PushLocalCalendar | RefreshLinkedCheckpoint | KeepCleanLink
pure def reconcileLinkedCalendar(reading: LinkedCalendarReading): LinkReconciliation =
  if (reading.linkPhase == LinkPaused or reading.linkPhase == LinkLocalOnly) KeepPausedLink
  else if (reading.linkPhase == LinkConflicted) CheckConvergedLink
  else if (reading.linkPhase == LinkQuarantined) KeepQuarantinedLink
  else if (not(reading.localExists))
    (if (reading.pendingLink == LinkDelete) ReplayRetainedDelete else QuarantineMissingLocal)
  else if (reading.providerExists and reading.localChanged and reading.providerChanged and not(reading.semanticMatch)) RecordConcurrentLinkEdit
  else if (reading.providerExists and reading.providerChanged and not(reading.localChanged or reading.semanticMatch))
    (if (reading.providerDeleted) PullProviderDelete else PullProviderEdit)
  else if (not(reading.providerExists) and reading.linkedProviderId and not(reading.localChanged)) PullProviderDelete
  else if (not(reading.providerExists) or (reading.localChanged and not(reading.semanticMatch))) PushLocalCalendar
  else if (reading.checkpointNeedsRefresh) RefreshLinkedCheckpoint
  else KeepCleanLink
pure def convergedLink(localLive: bool, providerLive: bool, semanticMatch: bool): bool =
  localLive and providerLive and semanticMatch
pure def lawHeldLinkDoesNotOfferPush(reading: LinkedCalendarReading): bool =
  (reading.linkPhase == LinkPaused or reading.linkPhase == LinkLocalOnly or reading.linkPhase == LinkQuarantined) implies
    reconcileLinkedCalendar(reading) != PushLocalCalendar and reconcileLinkedCalendar(reading) != ReplayRetainedDelete
pure def lawDifferentConcurrentChangesConflict(reading: LinkedCalendarReading): bool =
  (reading.linkPhase == LinkClean or reading.linkPhase == LinkDirty) and reading.localExists and reading.providerExists and
    reading.localChanged and reading.providerChanged and not(reading.semanticMatch) implies
    reconcileLinkedCalendar(reading) == RecordConcurrentLinkEdit
pure val retainedPair: LinkedCalendarReading = { linkPhase: LinkClean, pendingLink: LinkNoOperation,
  localExists:true, providerExists:true, providerDeleted:false, linkedProviderId:true, localChanged:false,
  providerChanged:false, semanticMatch:true, checkpointNeedsRefresh:false }
pure val readingValues = Set(retainedPair,{ ...retainedPair,linkPhase:LinkPaused },
 { ...retainedPair,linkPhase:LinkConflicted },{ ...retainedPair,localExists:false,pendingLink:LinkDelete },
 { ...retainedPair,providerChanged:true,semanticMatch:false },{ ...retainedPair,providerExists:false,semanticMatch:false },
 { ...retainedPair,localChanged:true,providerChanged:true,semanticMatch:false })
```

### A push retains its operation and uses the exact provider preconditions

A local tombstone chooses delete. A live local event with a provider
snapshot chooses update, otherwise it chooses create. The engine saves its
dirty operation and local revision before dispatch unless that exact
operation was already retained in dirty state. Create carries the held
idempotency key. Conditional update and delete use the provider's held event
identity and etag. The managed provider port rechecks account capabilities.
It checks response version, exact calendar and declared delivery semantics.
A create also checks private visibility and disabled reminders. Create and
update read back the expected snapshot and match its semantic content.

Verified success clears the pending operation. A definite not-accepted
outcome keeps it dirty, and precondition failure records a conflict and
clears the pending operation. Other mutation errors or unconfirmed
results quarantine the link with the pending operation retained. Retained
delete with a missing local row settles to paused. On the local
tombstone push path, a successful delete settles to clean. Pending and
checkpoint writes must be observed by the caller before a receipt can be
presented. This rule classifies provider outcomes; it does not authorize
release of the resident dispatch barrier.

```quint
type LinkWriteEvidence = ExactLinkWrite | DefiniteLinkRefusal | LinkPreconditionChanged | UncertainLinkWrite
type LinkWriteCheckpoint = { linkPhase: CalendarLinkPhase, pendingLink: CalendarLinkOperation }
pure def chooseLinkPush(localDeleted: bool, providerExists: bool): CalendarLinkOperation =
  if (localDeleted) LinkDelete else if (providerExists) LinkUpdate else LinkCreate
pure def linkPushNeedsStage(linkPhase: CalendarLinkPhase, retainedOperation: CalendarLinkOperation, nextOperation: CalendarLinkOperation): bool =
  linkPhase != LinkDirty or retainedOperation != nextOperation
pure def pushLinkCheckpoint(nextOperation: CalendarLinkOperation, result: LinkWriteEvidence, localAlreadyMissing: bool): LinkWriteCheckpoint =
  match result {
    ExactLinkWrite => { linkPhase: if (localAlreadyMissing) LinkPaused else LinkClean,pendingLink:LinkNoOperation }
    | DefiniteLinkRefusal => { linkPhase:LinkDirty,pendingLink:nextOperation }
    | LinkPreconditionChanged => { linkPhase:LinkConflicted,pendingLink:LinkNoOperation }
    | UncertainLinkWrite => { linkPhase:LinkQuarantined,pendingLink:nextOperation }
  }
pure def lawUnknownLinkWriteKeepsPending(nextOperation: CalendarLinkOperation, localAlreadyMissing: bool): bool =
  pushLinkCheckpoint(nextOperation,UncertainLinkWrite,localAlreadyMissing).pendingLink == nextOperation
pure def lawConditionalFailureNeedsConflict(nextOperation: CalendarLinkOperation, localAlreadyMissing: bool): bool =
  pushLinkCheckpoint(nextOperation,LinkPreconditionChanged,localAlreadyMissing).linkPhase == LinkConflicted
```

## Story: Recover a held dispatch from evidence and resolve an explicit disagreement

### Recovery observes both stores before releasing a held dispatch

Recovery reads the current local and provider rows and never sends a
mutation. For deletion, it can report landed only with a retained
provider event ID, no provider snapshot, and no live local event.
For create or update, both live rows must now agree. Update also
needs a previously retained etag and a nonempty different current
etag. A failed read or ambiguous snapshot leaves recovery unresolved.

After the caller's settle window, the absence of a not-yet-linked
create can prove that attempt did not land. An update or delete can
yield not-landed only when the same live provider identity and etag
still exist. The resulting dirty row preserves the operation, key and
precondition for separately authorized resume. A later differing etag
or changed contents do not prove retry safe. Landed updates
checkpoint exact current revisions. The local store, the provider
and the caller supply identity, deadline and authoritative absence.

```quint
type LinkedRecoveryEvidence = { pendingLink: CalendarLinkOperation, localLive: bool, providerPresent: bool,
  providerLive: bool, retainedProviderId: bool, matchingProviderId: bool, oldEtag: bool, nextEtag: bool,
  sameEtag: bool, semanticMatch: bool, settleWindowElapsed: bool, readsVerified: bool }
type LinkedRecoveryDecision = LinkedLanded | LinkedNotLanded | LinkedUnresolved
pure def linkTargetUnchanged(recovery: LinkedRecoveryEvidence): bool =
  recovery.providerPresent and recovery.providerLive and recovery.retainedProviderId and recovery.matchingProviderId and
    recovery.oldEtag and recovery.sameEtag
pure def recoverLinkedDispatch(recovery: LinkedRecoveryEvidence): LinkedRecoveryDecision =
  if (not(recovery.readsVerified)) LinkedUnresolved
  else if (recovery.pendingLink == LinkDelete)
    (if (recovery.retainedProviderId and not(recovery.providerPresent or recovery.localLive)) LinkedLanded
     else if (recovery.settleWindowElapsed and linkTargetUnchanged(recovery)) LinkedNotLanded else LinkedUnresolved)
  else if (recovery.localLive and recovery.providerPresent and recovery.providerLive and recovery.semanticMatch and
    (recovery.pendingLink != LinkUpdate or (recovery.oldEtag and recovery.nextEtag and not(recovery.sameEtag)))) LinkedLanded
  else if (not(recovery.settleWindowElapsed)) LinkedUnresolved
  else if (recovery.pendingLink == LinkCreate and not(recovery.retainedProviderId or recovery.providerPresent)) LinkedNotLanded
  else if (recovery.pendingLink == LinkUpdate and linkTargetUnchanged(recovery)) LinkedNotLanded
  else LinkedUnresolved
pure def lawLinkedRetryWaitsForSettle(recovery: LinkedRecoveryEvidence): bool =
  recoverLinkedDispatch(recovery) == LinkedNotLanded implies recovery.readsVerified and recovery.settleWindowElapsed
pure def lawLandedLinkUpdateNeedsChangedEtag(recovery: LinkedRecoveryEvidence): bool =
  recovery.pendingLink == LinkUpdate and recoverLinkedDispatch(recovery) == LinkedLanded implies
    recovery.oldEtag and recovery.nextEtag and not(recovery.sameEtag) and recovery.semanticMatch
pure val recoverUpdate: LinkedRecoveryEvidence = { pendingLink:LinkUpdate,localLive:true,providerPresent:true,
 providerLive:true,retainedProviderId:true,matchingProviderId:true,oldEtag:true,nextEtag:true,sameEtag:false,
 semanticMatch:true,settleWindowElapsed:false,readsVerified:true }
pure val recoveryValues = Set(recoverUpdate,{ ...recoverUpdate,sameEtag:true },
 { ...recoverUpdate,sameEtag:true,settleWindowElapsed:true },{ ...recoverUpdate,semanticMatch:false,settleWindowElapsed:true },
 { ...recoverUpdate,pendingLink:LinkDelete,localLive:false,providerPresent:false,providerLive:false },
 { ...recoverUpdate,pendingLink:LinkCreate,retainedProviderId:false,providerPresent:false,providerLive:false,settleWindowElapsed:true })
```

### An explicit conflict choice rereads each side and uses the observed revision

Keeping Eliza or Google applies only to a conflicted link. If both rows are
missing, pause the link. If Eliza is missing and its deletion wins, retain
a delete at the provider's fresh revision. If Google wins, restore the local
row through its owned restoration port or quarantine if unavailable.
If only Google's row is missing, keeping Google deletes the local row
under its current revision. Keeping Eliza recreates the provider copy with
a new deterministic key derived from the previous key and checkpoint time.
With two live rows, keeping Google performs a local CAS. Keeping Eliza
stages a provider update using the provider's fresh etag, or quarantines
when that etag is missing. All local port rejections remain explicit.

```quint
type PreferredCalendarSide = PreferElizaCalendar | PreferGoogleCalendar
type LinkedResolution = UseOrdinaryReconcile | PauseEmptyLink | StageReviewedProviderDelete | RestoreLocalCalendar |
  QuarantineMissingRestore | DeleteLocalCalendar | StageReviewedProviderCreate | ReplaceLocalCalendar |
  StageReviewedProviderUpdate | QuarantineMissingLinkedRevision
pure def linkConflictResolution(conflicted: bool, localExists: bool, providerLive: bool,
  restoreSupported: bool, freshEtag: bool, preferred: PreferredCalendarSide): LinkedResolution =
  if (not(conflicted)) UseOrdinaryReconcile
  else if (not(localExists or providerLive)) PauseEmptyLink
  else if (not(localExists))
    (if (preferred == PreferElizaCalendar) StageReviewedProviderDelete else
      if (restoreSupported) RestoreLocalCalendar else QuarantineMissingRestore)
  else if (not(providerLive))
    (if (preferred == PreferGoogleCalendar) DeleteLocalCalendar else StageReviewedProviderCreate)
  else if (preferred == PreferGoogleCalendar) ReplaceLocalCalendar
  else if (freshEtag) StageReviewedProviderUpdate else QuarantineMissingLinkedRevision
pure def lawLinkResolutionUsesFreshUpdateRevision(conflicted: bool, localExists: bool, providerLive: bool,
  restoreSupported: bool, freshEtag: bool, preferred: PreferredCalendarSide): bool =
  linkConflictResolution(conflicted,localExists,providerLive,restoreSupported,freshEtag,preferred) == StageReviewedProviderUpdate implies
    conflicted and localExists and providerLive and freshEtag and preferred == PreferElizaCalendar
```
