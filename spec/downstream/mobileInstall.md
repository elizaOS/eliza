# Android prepared installation and readback

Grace's updater uses the pinned `UpdateJournal`, `InstallReadback`,
`PackageInstallCoordinator` and `PreparedRecovery` sources from
`plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/updater`.
Its `PackageInstallCoordinator.java` extends the producer coordinator.
The Alpha producer baseline has `plugins/plugin-native-agent/quint/UpdateJournal.qnt`.
The journal is private, lock-serialized and atomically replaced. The
[trust owner](./mobileOta.md) decides whether authenticated artifacts
remain admissible. This projection models one admitted candidate and
its recovery, with installer session and health receipts bound to that
plan. Separate journals belong to the product that installs them.

## Story: Resolve a candidate installation from platform readback

### A fresh verified plan durably owns its install session before handoff

A prepared pair names the baseline, candidate and adjacent recovery
identities and the exact channel generation. Switching channel while
staging or verified drops the plan. A verified plan is committed under
the same lock as its freshness check. If the handoff throws after the
lock has published the intent, the journal remains committing. Later
readback resolves the actual result. A foreign plan or session cannot
advance this journal. Seeing the expected installed identity wins over
a blocked callback.

```quint
type InstallPhase = InstallIdle | DownloadQueued | VerifiedPair | CommittingCandidate | CandidateProbation | CandidateHealthy | RecoveryReady | CommittingRecovery | RecoveryProbation | Recovered | Quarantined | Support
type InstalledIdentity = BaselineCode | CandidateCode | RecoveryCode | ForeignCode
type InstallerEvidence = NoFailure | RetryableFailure | CandidateRejected
type SupportReason = NoBlock | InstallerBlocked | OutcomeUnknown | UnexpectedIdentity | RecoveryFailed
type PlanBinding = { planId: int, generation: int }
type HealthBinding = { planId: int, generation: int, revision: int }
type InstallObservation = { planId: int, sessionId: int, installed: InstalledIdentity, stillListed: bool, blocked: bool, evidence: InstallerEvidence }
type Journal = { phase: InstallPhase, generation: int, revision: int, planId: int, sessionId: int, recoveryAttempted: bool, candidateQuarantined: bool, recoveryQuarantined: bool, consecutiveReleases: int, reported: InstallerEvidence, support: SupportReason }
pure val initial: Journal = {
  phase: InstallIdle, generation: 1, revision: 0, planId: 0, sessionId: 0, recoveryAttempted: false,
  candidateQuarantined: false, recoveryQuarantined: false, consecutiveReleases: 0, reported: NoFailure, support: NoBlock
}
pure val planValues = Set({planId: 1, generation: 1}, {planId: 1, generation: 2}, {planId: 2, generation: 1})
pure val sessionIdValues = Set(1, 2)
pure def canStagePair(j: Journal, plan: PlanBinding, baselineVerified: bool): bool =
  (j.phase == InstallIdle or j.phase == CandidateHealthy or j.phase == Recovered or j.phase == Quarantined) and plan.planId > 0 and plan.generation == j.generation and
  not(j.candidateQuarantined) and not(j.recoveryQuarantined) and baselineVerified
pure def stagePair(j: Journal, plan: PlanBinding, baselineVerified: bool): Journal =
  { ...j, phase: DownloadQueued, planId: plan.planId, sessionId: 0, recoveryAttempted: false, reported: NoFailure, support: NoBlock, revision: j.revision + 1 }
pure def canVerifyPair(j: Journal, plan: PlanBinding, artifactsVerified: bool): bool =
  j.phase == DownloadQueued and j.planId == plan.planId and j.generation == plan.generation and artifactsVerified
pure def verifyPair(j: Journal, plan: PlanBinding, artifactsVerified: bool): Journal = { ...j, phase: VerifiedPair, revision: j.revision + 1 }
pure def canChangeChannel(j: Journal, channelChanged: bool): bool = channelChanged
pure def changeChannel(j: Journal, channelChanged: bool): Journal = {
  val uncommitted = j.phase == DownloadQueued or j.phase == VerifiedPair
  { ...j, generation: j.generation + 1, revision: j.revision + 1,
    phase: if (uncommitted) InstallIdle else j.phase, planId: if (uncommitted) 0 else j.planId }
}
pure def canCommitCandidate(j: Journal, plan: PlanBinding, sessionId: int, freshAuthority: bool): bool =
  j.phase == VerifiedPair and plan.planId == j.planId and plan.generation == j.generation and sessionId > 0 and freshAuthority
pure def commitCandidate(j: Journal, plan: PlanBinding, sessionId: int, freshAuthority: bool): Journal =
  { ...j, phase: CommittingCandidate, sessionId: sessionId, revision: j.revision + 1 }
pure def awaitsReadback(j: Journal): bool =
  j.phase == CommittingCandidate or j.phase == CommittingRecovery or
  (j.phase == Support and (j.support == InstallerBlocked or j.support == OutcomeUnknown))
pure def strongerFailure(remembered: InstallerEvidence, reported: InstallerEvidence): InstallerEvidence =
  if (remembered == CandidateRejected or reported == CandidateRejected) CandidateRejected
  else if (remembered == RetryableFailure or reported == RetryableFailure) RetryableFailure else NoFailure
pure def releasedCandidate(releases: int, j: Journal): Journal = {
  if (releases >= 3) {
    ...j, phase: Quarantined, candidateQuarantined: true, consecutiveReleases: releases, reported: NoFailure,
    support: NoBlock, revision: j.revision + 1
  } else {
    ...j, phase: InstallIdle, planId: 0, sessionId: 0, consecutiveReleases: releases, reported: NoFailure,
    support: NoBlock, revision: j.revision + 1
  }
}
pure def canObserveInstall(j: Journal, observation: InstallObservation): bool =
  awaitsReadback(j) and observation.planId == j.planId and observation.sessionId == j.sessionId
pure def reconcileInstall(observation: InstallObservation, j: Journal): Journal = {
  val recovery = j.recoveryAttempted
  val expected = if (recovery) RecoveryCode else CandidateCode
  val previous = if (recovery) CandidateCode else BaselineCode
  val failure = strongerFailure(j.reported, observation.evidence)
  if (observation.installed == expected) {
    ...j, phase: if (recovery) RecoveryProbation else CandidateProbation, reported: NoFailure, support: NoBlock,
    consecutiveReleases: if (recovery) j.consecutiveReleases else 0, revision: j.revision + 1
  } else if (observation.installed != previous) { ...j, phase: Support, support: UnexpectedIdentity, revision: j.revision + 1 }
  else if (observation.blocked) { ...j, phase: Support, support: InstallerBlocked, revision: j.revision + 1 }
  else if (observation.stillListed) { ...j, reported: if (recovery) j.reported else failure, revision: j.revision + 1 }
  else if (recovery) {
    if (j.phase == Support) j else { ...j, phase: Support, candidateQuarantined: true, support: RecoveryFailed, revision: j.revision + 1 }
  }
  else if (failure == CandidateRejected) { ...j, phase: Quarantined, candidateQuarantined: true, reported: NoFailure, support: NoBlock, revision: j.revision + 1 }
  else if (failure == RetryableFailure) releasedCandidate(j.consecutiveReleases + 1, j)
  else if (j.phase == Support and j.support == OutcomeUnknown) j
  else { ...j, phase: Support, support: OutcomeUnknown, revision: j.revision + 1 }
}
pure def observeInstall(j: Journal, observation: InstallObservation): Journal =
  reconcileInstall(observation, j)
pure def canObserveExpectedInstall(j: Journal): bool = awaitsReadback(j)
pure def observeExpectedInstall(j: Journal): Journal = reconcileInstall({
  planId: j.planId, sessionId: j.sessionId, installed: if (j.recoveryAttempted) RecoveryCode else CandidateCode,
  stillListed: false, blocked: false, evidence: NoFailure
}, j)
pure val weight_stagePair = 4
pure val weight_verifyPair = 4
pure val weight_commitCandidate = 4
pure val weight_observeExpectedInstall = 4
pure val weight_observeCurrentHealth = 4
pure val weight_commitRecovery = 4
pure val observationValues = Set(
  {planId: 1, sessionId: 1, installed: CandidateCode, stillListed: false, blocked: true, evidence: NoFailure},
  {planId: 1, sessionId: 1, installed: BaselineCode, stillListed: true, blocked: false, evidence: RetryableFailure},
  {planId: 1, sessionId: 1, installed: BaselineCode, stillListed: false, blocked: false, evidence: NoFailure},
  {planId: 1, sessionId: 1, installed: BaselineCode, stillListed: false, blocked: false, evidence: CandidateRejected},
  {planId: 1, sessionId: 2, installed: RecoveryCode, stillListed: false, blocked: false, evidence: NoFailure},
  {planId: 2, sessionId: 2, installed: ForeignCode, stillListed: false, blocked: false, evidence: NoFailure}
)
pure def canReleaseUnknown(j: Journal, qualifiedWaitElapsed: bool): bool =
  j.phase == Support and j.support == OutcomeUnknown and not(j.recoveryAttempted) and qualifiedWaitElapsed
pure def releaseUnknown(j: Journal, qualifiedWaitElapsed: bool): Journal = releasedCandidate(j.consecutiveReleases + 1, j)
pure def alwaysInstallerHasSession(j: Journal): bool =
  awaitsReadback(j) implies j.planId > 0 and j.sessionId > 0
pure def alwaysOwnedNonIdlePlan(j: Journal): bool = j.phase == InstallIdle or j.planId > 0
pure def alwaysReleaseBudget(j: Journal): bool = j.consecutiveReleases >= 0 and (j.consecutiveReleases >= 3 implies j.candidateQuarantined)
pure def stepForeignInstallerCannotDecide(before: Journal, via: str, after: Journal): bool =
  via == "observeInstall" implies awaitsReadback(before)
pure def sometimesCandidateInstalled(j: Journal): bool = j.phase == CandidateProbation
pure def sometimesCommitOutcomeUnknown(j: Journal): bool = j.phase == Support and j.support == OutcomeUnknown
```

## Story: Apply health only to its installation and recover once

### Health evidence carries the revision, generation, plan and installed identity

The source takes the snapshot before collecting health. Each health
decision requires that exact snapshot and installed identity.
The same-lock expected-install event supplies the current journal
identity with an observed matching installed package. The current-health
receipt event represents the callback delivering the intact
snapshot and verified installed identity without interleaving. The port
supplies qualified health and probation timing. [WebView health evidence](./mobileOtaUiHealth.md)
governs the renderer portion of that input. Local failure of the
candidate quarantines it and permits one authorized recovery attempt.
A failed recovery health outcome quarantines both artifacts and stops
automatic recovery. Current recovery authority is required before
handoff, even after candidate failure. A quarantined candidate cannot
be restaged in this owner.

```quint
pure def matchesHealth(j: Journal, health: HealthBinding): bool =
  health.planId == j.planId and health.generation == j.generation and health.revision == j.revision
pure def healthPhase(j: Journal): bool =
  j.phase == CandidateProbation or j.phase == CandidateHealthy or j.phase == RecoveryProbation
pure def canObserveHealth(j: Journal, health: HealthBinding, installed: InstalledIdentity, healthy: bool): bool =
  matchesHealth(j, health) and healthPhase(j) and (not(healthy) or j.phase != CandidateHealthy) and
  installed == (if (j.phase == RecoveryProbation) RecoveryCode else CandidateCode)
pure def applyHealth(healthy: bool, j: Journal): Journal =
  if (healthy) { ...j, phase: if (j.phase == RecoveryProbation) Recovered else CandidateHealthy, revision: j.revision + 1 }
  else { ...j, candidateQuarantined: true, recoveryQuarantined: j.recoveryQuarantined or j.phase == RecoveryProbation,
    phase: if (j.recoveryAttempted) Support else RecoveryReady,
    support: if (j.recoveryAttempted) RecoveryFailed else NoBlock, revision: j.revision + 1 }
pure def observeHealth(j: Journal, health: HealthBinding, installed: InstalledIdentity, healthy: bool): Journal =
  applyHealth(healthy, j)
pure def canObserveCurrentHealth(j: Journal, healthy: bool): bool =
  healthPhase(j) and (not(healthy) or j.phase != CandidateHealthy)
pure def observeCurrentHealth(j: Journal, healthy: bool): Journal = applyHealth(healthy, j)
pure def canCommitRecovery(j: Journal, sessionId: int, currentAuthority: bool): bool =
  j.phase == RecoveryReady and not(j.recoveryAttempted) and sessionId > 0 and currentAuthority
pure def commitRecovery(j: Journal, sessionId: int, currentAuthority: bool): Journal =
  { ...j, phase: CommittingRecovery, sessionId: sessionId, recoveryAttempted: true, revision: j.revision + 1 }
pure def canDenyRecovery(j: Journal): bool = j.phase == RecoveryReady and not(j.recoveryAttempted)
pure def denyRecovery(j: Journal): Journal =
  { ...j, phase: Quarantined, candidateQuarantined: true, recoveryQuarantined: true, revision: j.revision + 1 }
pure val healthValues = Set(
  {planId: 1, generation: 1, revision: 4}, {planId: 1, generation: 1, revision: 5},
  {planId: 1, generation: 1, revision: 7}, {planId: 1, generation: 2, revision: 5}
)
pure def alwaysRecoveryKeepsCandidateQuarantined(j: Journal): bool =
  j.recoveryAttempted or j.phase == RecoveryReady implies j.candidateQuarantined
pure def alwaysRecoveryPhaseHasAttempt(j: Journal): bool =
  j.phase == CommittingRecovery or j.phase == RecoveryProbation or j.phase == Recovered implies j.recoveryAttempted
pure def alwaysUncommittedHasNoRecovery(j: Journal): bool =
  j.phase == InstallIdle or j.phase == DownloadQueued or j.phase == VerifiedPair or j.phase == CommittingCandidate or
  j.phase == CandidateProbation or j.phase == CandidateHealthy or j.phase == RecoveryReady implies not(j.recoveryAttempted)
pure def alwaysJournalCoordinates(j: Journal): bool = j.revision >= 0 and j.generation > 0
pure def sometimesRecovered(j: Journal): bool = j.phase == Recovered
pure def sometimesQuarantined(j: Journal): bool = j.phase == Quarantined
```
