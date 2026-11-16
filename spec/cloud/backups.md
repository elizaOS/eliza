# Hosted agent backups

The cloud backs up a hosted agent's state and restores it into a new
container. A capture is published only when every chunk it catalogued has
been uploaded under one writer; a spool on local disk is removed only under
a persisted intent and a lock; a restore takes one lease, and moves the
agent's route to the new container only after the candidate is committed,
booted and probed. One agent's capture, spool and restore are the state
machine. Cleanup of a failed restore and the rotation of cleanup work are
stated as laws. Local, on-device backup is not part of this package.

## Story: Publish a complete backup

> As an organization with a hosted agent, I want each backup to be either
> complete or not published at all, so that a restore never starts from half
> a capture.

### A capture is published only after its catalog and every chunk are recorded

A capture records its catalog first and receives a capture receipt. One
writer at a time owns the source: it claims it only with an exact claim on a
catalogued capture, and closing hands it back without changing the
publication. Publication starts only under the capture receipt and completes
only when both catalogued chunks are uploaded. Receipts and uploads are
never lost.

```quint
type CapturePhase = CaptureSealed | CapturePublishing | CapturePublished
type SpoolKind = ProtectedSpool | TerminalSpool
type SpoolProof = ProofUnavailable | ProofExact | ProofExpired
type SpoolContents = SpoolWhole | SpoolPartial | SpoolAbsent
type CleanupPhase = CleanupIdle | CleanupAuthorized | CleanupLocked | CleanupCancelling | CleanupConfirmed | ReleaseUnknown
type RestorePhase = RestoreReserved | VaultSeeded | ContainerCreated | Restoring | CandidateCommitted | RestartAttested | CandidateProbed | RoutePublished | RestoreFinalized | RetryableFailure | TerminalFailure
type AgentBackups = {
  capturePhase: CapturePhase, catalogCaptured: bool, captureReceipt: bool, uploaded: Set[int], writer: int,
  spoolKind: SpoolKind, proof: SpoolProof, spool: SpoolContents, intent: bool, cleanup: CleanupPhase, execution: int, lockHolder: int,
  restorePhase: RestorePhase, resumeAt: RestorePhase, previousStopped: bool, candidateCommitted: bool, attested: bool, probed: bool, routeNew: bool, previousRetired: bool, failedAfterPublication: bool,
  leaseHolder: int, leaseLive: bool, acquired: Set[int], released: Set[int], catalogEpoch: int, leaseEpoch: int, restorable: bool
}
pure val catalogChunks: Set[int] = Set(1, 2)
pure val initial: AgentBackups = {
  capturePhase: CaptureSealed, catalogCaptured: false, captureReceipt: false, uploaded: Set(), writer: 0,
  spoolKind: ProtectedSpool, proof: ProofUnavailable, spool: SpoolWhole, intent: false, cleanup: CleanupIdle, execution: 0, lockHolder: 0,
  restorePhase: RestoreReserved, resumeAt: RestoreReserved, previousStopped: false, candidateCommitted: false, attested: false, probed: false, routeNew: false, previousRetired: false, failedAfterPublication: false,
  leaseHolder: 0, leaseLive: false, acquired: Set(), released: Set(), catalogEpoch: 0, leaseEpoch: 0, restorable: true
}
pure def canRecordCatalog(b: AgentBackups): bool = not(b.catalogCaptured)
pure def recordCatalog(b: AgentBackups): AgentBackups = { ...b, catalogCaptured: true }
pure def canAcknowledgeCapture(b: AgentBackups): bool = b.catalogCaptured and not(b.captureReceipt) and b.writer == 0
pure def acknowledgeCapture(b: AgentBackups): AgentBackups = { ...b, captureReceipt: true }
pure def canClaimSource(b: AgentBackups, writer: int, exactClaim: bool): bool = exactClaim and b.catalogCaptured and b.writer == 0
pure def claimSource(b: AgentBackups, writer: int, exactClaim: bool): AgentBackups = { ...b, writer: writer, captureReceipt: true }
pure def canBeginPublication(b: AgentBackups, writer: int): bool = b.writer == writer and writer > 0 and b.capturePhase == CaptureSealed
pure def beginPublication(b: AgentBackups, writer: int): AgentBackups = { ...b, capturePhase: CapturePublishing }
pure def canRecordUpload(b: AgentBackups, writer: int, chunk: int): bool = b.writer == writer and writer > 0 and b.capturePhase != CaptureSealed and catalogChunks.contains(chunk)
pure def recordUpload(b: AgentBackups, writer: int, chunk: int): AgentBackups = { ...b, uploaded: b.uploaded.union(Set(chunk)) }
pure def canCompletePublication(b: AgentBackups, writer: int): bool = b.writer == writer and writer > 0 and b.capturePhase == CapturePublishing and b.captureReceipt and catalogChunks.subseteq(b.uploaded)
pure def completePublication(b: AgentBackups, writer: int): AgentBackups = { ...b, capturePhase: CapturePublished }
pure def canCloseSource(b: AgentBackups, writer: int): bool = b.writer == writer and writer > 0
pure def closeSource(b: AgentBackups, writer: int): AgentBackups = { ...b, writer: 0 }
pure val writerValues = Set(1, 2)
pure val chunkValues = Set(1, 2, 3)
pure def alwaysReceiptFollowsCatalog(b: AgentBackups): bool = b.captureReceipt implies b.catalogCaptured
pure def alwaysPublicationNeedsReceipt(b: AgentBackups): bool = (b.capturePhase != CaptureSealed or b.writer != 0) implies b.captureReceipt
pure def alwaysPublishedCaptureIsComplete(b: AgentBackups): bool = b.uploaded.subseteq(catalogChunks) and (b.capturePhase == CapturePublished implies catalogChunks.subseteq(b.uploaded))
pure def stepOneWriterAtATime(before: AgentBackups, after: AgentBackups): bool = (before.writer != 0 and after.writer != 0) implies after.writer == before.writer
pure def stepCaptureEvidenceIsDurable(before: AgentBackups, after: AgentBackups): bool =
  (before.captureReceipt implies after.captureReceipt) and before.uploaded.subseteq(after.uploaded)
pure def sometimesCapturePublished(b: AgentBackups): bool = b.capturePhase == CapturePublished and b.writer == 0
```

## Story: Remove a local spool only when it is safe

> As an operator, I want a backup's spool on disk removed only when the
> backup no longer needs it, and never half-removed without a record that the
> removal is under way.

### A spool changes only under a persisted intent and a held lock

Cleanup persists an intent while it holds an exact proof and the spool is
whole. An attempt is authorized only with a proof its kind accepts: an exact
proof for any spool, or an expired one for a protected spool. The spool is
changed only while the attempt holds the lock; the intent is retired only
once the spool is confirmed absent. A cancelled attempt changes neither the
spool nor the intent. A lock whose release is unknown stays held.

```quint
pure def acceptsProof(kind: SpoolKind, proof: SpoolProof): bool = proof == ProofExact or (kind == ProtectedSpool and proof == ProofExpired)
pure def lockedPhase(phase: CleanupPhase): bool = phase == CleanupLocked or phase == CleanupCancelling or phase == ReleaseUnknown
pure def canSettleSpoolKind(b: AgentBackups): bool = b.spoolKind == ProtectedSpool
pure def settleSpoolKind(b: AgentBackups): AgentBackups = { ...b, spoolKind: TerminalSpool }
pure def canSeeProof(b: AgentBackups, proof: SpoolProof): bool = b.proof != proof
pure def seeProof(b: AgentBackups, proof: SpoolProof): AgentBackups = { ...b, proof: proof }
pure def canPersistIntent(b: AgentBackups): bool = b.proof == ProofExact and b.spool == SpoolWhole and not(b.intent)
pure def persistIntent(b: AgentBackups): AgentBackups = { ...b, intent: true }
pure def canAuthorizeCleanup(b: AgentBackups, execution: int): bool = b.cleanup == CleanupIdle and b.intent and acceptsProof(b.spoolKind, b.proof) and execution > 0
pure def authorizeCleanup(b: AgentBackups, execution: int): AgentBackups = { ...b, cleanup: CleanupAuthorized, execution: execution }
pure def canLockSpool(b: AgentBackups, execution: int): bool = b.cleanup == CleanupAuthorized and b.execution == execution and b.spool != SpoolAbsent
pure def lockSpool(b: AgentBackups, execution: int): AgentBackups = { ...b, cleanup: CleanupLocked, lockHolder: execution }
pure def canLockFailed(b: AgentBackups, execution: int): bool = b.cleanup == CleanupAuthorized and b.execution == execution
pure def lockFailed(b: AgentBackups, execution: int): AgentBackups = { ...b, cleanup: CleanupIdle, execution: 0 }
pure def canObserveAbsent(b: AgentBackups, execution: int): bool = b.cleanup == CleanupAuthorized and b.execution == execution and b.spool == SpoolAbsent
pure def observeAbsent(b: AgentBackups, execution: int): AgentBackups = { ...b, cleanup: CleanupConfirmed }
pure def canUnlinkSome(b: AgentBackups, execution: int): bool = b.cleanup == CleanupLocked and b.lockHolder == execution and b.spool == SpoolWhole
pure def unlinkSome(b: AgentBackups, execution: int): AgentBackups = { ...b, spool: SpoolPartial }
pure def canReleaseForRetry(b: AgentBackups, execution: int): bool = b.cleanup == CleanupLocked and b.lockHolder == execution
pure def releaseForRetry(b: AgentBackups, execution: int): AgentBackups = { ...b, cleanup: CleanupIdle, execution: 0, lockHolder: 0 }
pure def canFinishCleanup(b: AgentBackups, execution: int): bool = b.cleanup == CleanupLocked and b.lockHolder == execution
pure def finishCleanup(b: AgentBackups, execution: int): AgentBackups = { ...b, spool: SpoolAbsent, cleanup: CleanupConfirmed, lockHolder: 0 }
pure def canCancelCleanup(b: AgentBackups, execution: int): bool = b.execution == execution and execution > 0 and (b.cleanup == CleanupLocked or b.cleanup == CleanupAuthorized or b.cleanup == CleanupConfirmed)
pure def cancelCleanup(b: AgentBackups, execution: int): AgentBackups = if (b.cleanup == CleanupLocked) { ...b, cleanup: CleanupCancelling } else { ...b, cleanup: CleanupIdle, execution: 0 }
pure def canReleaseCancelled(b: AgentBackups, execution: int): bool = b.cleanup == CleanupCancelling and b.lockHolder == execution
pure def releaseCancelled(b: AgentBackups, execution: int): AgentBackups = { ...b, cleanup: CleanupIdle, execution: 0, lockHolder: 0 }
pure def canReleaseFailed(b: AgentBackups, execution: int): bool = (b.cleanup == CleanupLocked or b.cleanup == CleanupCancelling) and b.lockHolder == execution
pure def releaseFailed(b: AgentBackups, execution: int): AgentBackups = { ...b, cleanup: ReleaseUnknown }
pure def canRetireIntent(b: AgentBackups, execution: int): bool = b.cleanup == CleanupConfirmed and b.execution == execution and b.spool == SpoolAbsent
pure def retireIntent(b: AgentBackups, execution: int): AgentBackups = { ...b, intent: false, cleanup: CleanupIdle, execution: 0 }
pure val executionValues = Set(1, 2)
pure def alwaysIntentOwnsTheAttempt(b: AgentBackups): bool = b.cleanup != CleanupIdle implies (b.intent and b.execution > 0)
pure def alwaysLockMatchesExecution(b: AgentBackups): bool = if (lockedPhase(b.cleanup)) (b.lockHolder != 0 and b.lockHolder == b.execution) else b.lockHolder == 0
pure def alwaysPartialSpoolHasIntent(b: AgentBackups): bool = b.spool == SpoolPartial implies b.intent
pure def alwaysConfirmedSpoolIsAbsent(b: AgentBackups): bool = b.cleanup == CleanupConfirmed implies b.spool == SpoolAbsent
pure def stepSpoolChangesOnlyUnderLock(before: AgentBackups, after: AgentBackups): bool = before.spool != after.spool implies (before.cleanup == CleanupLocked and before.intent)
pure def stepIntentRetiresOnlyWhenAbsent(before: AgentBackups, after: AgentBackups): bool = (before.intent and not(after.intent)) implies (before.cleanup == CleanupConfirmed and before.spool == SpoolAbsent)
pure def stepAuthorizedOnlyWithAcceptedProof(before: AgentBackups, after: AgentBackups): bool =
  (before.cleanup == CleanupIdle and after.cleanup == CleanupAuthorized) implies acceptsProof(before.spoolKind, before.proof)
pure def stepCancellingKeepsSpoolAndIntent(before: AgentBackups, after: AgentBackups): bool = before.cleanup == CleanupCancelling implies (after.spool == before.spool and after.intent == before.intent)
pure def sometimesSpoolRemoved(b: AgentBackups): bool = b.spool == SpoolAbsent and not(b.intent)
pure def sometimesCancelledAfterPartialRemoval(b: AgentBackups): bool = b.cleanup == CleanupCancelling and b.spool == SpoolPartial
```

## Story: Restore an agent into a new container

> As an organization, I want a restore to move my agent's traffic to the new
> container only once it is known to work, and one restore at a time.

### One restore lease is live at a time and a released lease never reopens

A restore acquires a lease only while the agent is restorable and no other
lease is live; acquiring retires every earlier attempt. A lease stops being
live when it lapses, when it is released, or when the catalog moves on to a
new epoch. Released attempts stay released.

```quint
pure def canAcquireLease(b: AgentBackups, attempt: int): bool = b.restorable and not(b.leaseLive) and not(b.acquired.contains(attempt)) and attempt > 0
pure def acquireLease(b: AgentBackups, attempt: int): AgentBackups =
  { ...b, leaseHolder: attempt, leaseLive: true, leaseEpoch: b.catalogEpoch, released: b.released.union(b.acquired), acquired: b.acquired.union(Set(attempt)) }
pure def canLapseLease(b: AgentBackups): bool = b.leaseLive
pure def lapseLease(b: AgentBackups): AgentBackups = { ...b, leaseLive: false }
pure def canReleaseLease(b: AgentBackups, attempt: int): bool = b.leaseHolder == attempt and attempt > 0 and not(b.released.contains(attempt))
pure def releaseLease(b: AgentBackups, attempt: int): AgentBackups = { ...b, released: b.released.union(Set(attempt)), leaseLive: false }
pure def advanceCatalog(b: AgentBackups): AgentBackups = { ...b, catalogEpoch: b.catalogEpoch + 1, leaseLive: false }
pure def canSetRestorable(b: AgentBackups, restorable: bool): bool = b.restorable != restorable
pure def setRestorable(b: AgentBackups, restorable: bool): AgentBackups = { ...b, restorable: restorable }
pure val attemptValues = Set(1, 2)
pure def alwaysOneUnreleasedLease(b: AgentBackups): bool = b.acquired.exclude(b.released).size() <= 1 and b.released.subseteq(b.acquired)
pure def alwaysLiveLeaseIsCurrent(b: AgentBackups): bool = b.leaseLive implies (b.acquired.contains(b.leaseHolder) and not(b.released.contains(b.leaseHolder)) and b.leaseEpoch == b.catalogEpoch)
pure def stepReleasedLeaseNeverReopens(before: AgentBackups, after: AgentBackups): bool = before.released.subseteq(after.released)
pure def sometimesSecondAttemptHoldsLease(b: AgentBackups): bool = b.leaseLive and b.released.size() == 1
```

### Traffic moves to a restored container only after it is committed, booted and probed

A restore seeds the vault, creates the container, materializes the backup
and commits the candidate. Booting the candidate stops the previous
container; the candidate is probed and only then, under a live lease, is the
route published to it, after which the previous container is retired. A
failure before anything is materialized can resume where it stopped; a
later failure before publication is terminal and brings the previous
container back. A failure after publication is recorded and keeps the route.

```quint
pure def restoreOpen(phase: RestorePhase): bool = phase != RestoreFinalized and phase != RetryableFailure and phase != TerminalFailure
pure def canSeedVault(b: AgentBackups): bool = b.restorePhase == RestoreReserved
pure def seedVault(b: AgentBackups): AgentBackups = { ...b, restorePhase: VaultSeeded }
pure def canCreateContainer(b: AgentBackups): bool = b.restorePhase == RestoreReserved or b.restorePhase == VaultSeeded
pure def createContainer(b: AgentBackups): AgentBackups = { ...b, restorePhase: ContainerCreated }
pure def canMaterialize(b: AgentBackups): bool = b.restorePhase == ContainerCreated
pure def materialize(b: AgentBackups): AgentBackups = { ...b, restorePhase: Restoring }
pure def canCommitCandidate(b: AgentBackups): bool = b.restorePhase == Restoring
pure def commitCandidate(b: AgentBackups): AgentBackups = { ...b, restorePhase: CandidateCommitted, candidateCommitted: true }
pure def canBootCandidate(b: AgentBackups): bool = b.restorePhase == CandidateCommitted
pure def bootCandidate(b: AgentBackups): AgentBackups = { ...b, restorePhase: RestartAttested, previousStopped: true, attested: true }
pure def canProbeCandidate(b: AgentBackups): bool = b.restorePhase == RestartAttested
pure def probeCandidate(b: AgentBackups): AgentBackups = { ...b, restorePhase: CandidateProbed, probed: true }
pure def canPublishRestore(b: AgentBackups): bool = b.restorePhase == CandidateProbed and b.leaseLive
pure def publishRestore(b: AgentBackups): AgentBackups = { ...b, restorePhase: RoutePublished, routeNew: true }
pure def canFinishRestore(b: AgentBackups): bool = b.restorePhase == RoutePublished
pure def finishRestore(b: AgentBackups): AgentBackups = { ...b, restorePhase: RestoreFinalized, previousRetired: true }
pure def canRestoreError(b: AgentBackups): bool = restoreOpen(b.restorePhase)
pure def restoreError(b: AgentBackups): AgentBackups =
  if (b.routeNew) { ...b, failedAfterPublication: true }
  else if (b.restorePhase == RestoreReserved or b.restorePhase == VaultSeeded or b.restorePhase == ContainerCreated) { ...b, resumeAt: b.restorePhase, restorePhase: RetryableFailure }
  else { ...b, restorePhase: TerminalFailure, previousStopped: false }
pure def canResumeRestore(b: AgentBackups): bool = b.restorePhase == RetryableFailure
pure def resumeRestore(b: AgentBackups): AgentBackups = { ...b, restorePhase: b.resumeAt }
pure def alwaysRouteMovesOnlyToAVerifiedCandidate(b: AgentBackups): bool = b.routeNew implies (b.candidateCommitted and b.attested and b.probed)
pure def alwaysPreviousRetiredOnlyAfterRouteMoved(b: AgentBackups): bool = b.previousRetired implies b.routeNew
pure def alwaysFinalizedRestoreMovedTheRoute(b: AgentBackups): bool = b.restorePhase == RestoreFinalized implies (b.routeNew and b.previousRetired)
pure def alwaysTerminalFailureKeepsTheOldRoute(b: AgentBackups): bool = b.restorePhase == TerminalFailure implies (not(b.routeNew) and not(b.previousStopped))
pure def alwaysLateFailureKeepsTheNewRoute(b: AgentBackups): bool = b.failedAfterPublication implies b.routeNew
pure def alwaysResumeBeforeMaterializing(b: AgentBackups): bool = b.resumeAt == RestoreReserved or b.resumeAt == VaultSeeded or b.resumeAt == ContainerCreated
pure def sometimesRestoreFinalized(b: AgentBackups): bool = b.restorePhase == RestoreFinalized
pure def sometimesRestoreResumedAfterFailure(b: AgentBackups): bool = b.restorePhase == Restoring and b.resumeAt == ContainerCreated
pure def sometimesLateRestoreFailureKeepsRoute(b: AgentBackups): bool = b.failedAfterPublication
pure val weight_seedVault = 3
pure val weight_createContainer = 3
pure val weight_materialize = 3
pure val weight_commitCandidate = 3
pure val weight_bootCandidate = 3
pure val weight_probeCandidate = 3
pure val weight_publishRestore = 3
pure val weight_finishRestore = 3
```

### A failed restore's resources are released only with proof they are gone

Cleanup of a failed restore holds its resources until a worker of the exact
restore scope, on the node that still holds the authority, proves the
cleanup: the container is tombstoned and no longer live, and its producer
is quiescent or its exact identity was observed and deleted. A lost
response, a reincarnated node or a live container yields no proof.

```quint
type RestoreCleanupFacts = { exactScope: bool, sameNode: bool, tombstoned: bool, containerLive: bool, producerQuiescent: bool, observedExactId: bool }
pure def cleanupProven(facts: RestoreCleanupFacts): bool =
  facts.exactScope and facts.sameNode and facts.tombstoned and not(facts.containerLive) and (facts.producerQuiescent or facts.observedExactId)
pure def lawLiveContainerIsNeverReleased(facts: RestoreCleanupFacts): bool = facts.containerLive implies not(cleanupProven(facts))
pure def lawReincarnatedNodeHasNoAuthority(facts: RestoreCleanupFacts): bool = not(facts.sameNode) implies not(cleanupProven(facts))
pure val factsValues = Set(
  { exactScope: true, sameNode: true, tombstoned: true, containerLive: false, producerQuiescent: true, observedExactId: false },
  { exactScope: true, sameNode: true, tombstoned: true, containerLive: false, producerQuiescent: false, observedExactId: true },
  { exactScope: true, sameNode: true, tombstoned: true, containerLive: true, producerQuiescent: true, observedExactId: true },
  { exactScope: true, sameNode: false, tombstoned: true, containerLive: false, producerQuiescent: true, observedExactId: false },
  { exactScope: false, sameNode: true, tombstoned: true, containerLive: false, producerQuiescent: true, observedExactId: false },
  { exactScope: true, sameNode: true, tombstoned: false, containerLive: false, producerQuiescent: false, observedExactId: false })
```

### Cleanup work rotates so a failing item cannot starve the rest

Each cleanup pass takes the two oldest unfinished items and stamps them as
the newest, whether their operation succeeds or fails. An item that keeps
failing therefore goes to the back, and every other item reaches the front
of a later pass.

```quint
pure def rotatedRank(rank: int, selected: bool, clock: int, offset: int): int = if (selected) clock + offset else rank
pure def lawSelectedItemsMoveBehindTheRest(otherRank: int, clock: int, offset: int): bool =
  (otherRank >= 0 and otherRank < clock and offset >= 0) implies rotatedRank(otherRank, true, clock, offset) > rotatedRank(otherRank, false, clock, offset)
```
