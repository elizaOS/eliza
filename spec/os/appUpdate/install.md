# App update installation journal

The updater's private journal follows one admitted APK plan (baseline,
candidate and one recovery artifact) from staging through the platform
installer, probation and at most one recovery. The journal is
lock-serialized and atomically replaced by the shell; trust and freshness
decisions are the admission library's (`appUpdate/admission.md`), health
evidence comes from `appUpdate/health.md`, and when to activate is
`appUpdate/policy.md`'s. The agent service owns the hold on the agent: this
journal only asks for it (`Hold`) and gives it back (`Release`), and the
shell forwards both to the agent service.

Artifacts are named by an integer identity the shell assigns to each
verified (code, digest) pair; the plan's identities rise from baseline to
candidate to recovery, as the platform's version codes do.

## Story: Install an app update without running the agent mid-install

> As a device owner, I want an app update installed only after my agent has
> stopped for it, and its outcome decided from what the platform reports, so
> that an interrupted installation is resolved once and never guessed.

### A plan is staged only on its channel generation over the installed baseline with no quarantined artifact

A channel change while staging or verified drops the plan. So does a plan
the shell finds no longer admissible (revoked, stale or changed artifacts).
Before it sends `commitCandidate` the shell rechecks admission freshness
under the journal lock; a refused check leaves the plan `Verified`.

```quint
type ArtifactId = int
type InstallPhase = Idle | Staging | Verified | Committing | Probation | Healthy | RecoveryReady | Recovering | RecoveryProbation | Recovered | Quarantined | Support
type SupportReason = NoReason | InstallerBlocked | InstallStalled | OutcomeUnknown | UnexpectedIdentity | RecoveryFailed
type HoldState = Unheld | HoldRequested | HoldGranted
type InstallerReport = NoReport | Retryable | CandidateRejected
type Plan = { id: int, generation: int, baseline: ArtifactId, candidate: ArtifactId, recovery: ArtifactId }
type UpdateHold = Hold({ target: ArtifactId }) | Release({ installed: ArtifactId })
type Journal = { phase: InstallPhase, support: SupportReason, plan: Plan, session: int, recoveryAttempted: bool, hold: HoldState, generation: int, revision: int, quarantine: Set[ArtifactId], reported: InstallerReport, releasedCandidate: ArtifactId, releases: int }
type JournalStep = { state: Journal, out: List[UpdateHold] }
pure val noPlan: Plan = { id: 0, generation: 0, baseline: 0, candidate: 0, recovery: 0 }
pure val initial: Journal = { phase: Idle, support: NoReason, plan: noPlan, session: 0, recoveryAttempted: false, hold: Unheld, generation: 0, revision: 0, quarantine: Set(), reported: NoReport, releasedCandidate: 0, releases: 0 }
pure def validPlan(p: Plan): bool = p.id > 0 and 0 < p.baseline and p.baseline < p.candidate and p.candidate < p.recovery
pure def settledPhase(j: Journal): bool = j.phase == Idle or j.phase == Healthy or j.phase == Recovered or j.phase == Quarantined
pure def conclude(ends: bool, installed: ArtifactId, before: Journal, after: Journal): JournalStep =
  if (ends) { state: { ...after, hold: Unheld }, out: if (before.hold == Unheld) List() else List(Release({ installed: installed })) }
  else { state: after, out: List() }
pure def canStage(j: Journal, plan: Plan, installed: ArtifactId): bool =
  settledPhase(j) and validPlan(plan) and plan.generation == j.generation and plan.baseline == installed and
  not(j.quarantine.contains(plan.candidate)) and not(j.quarantine.contains(plan.recovery))
pure def stage(j: Journal, plan: Plan, installed: ArtifactId): Journal =
  { ...j, phase: Staging, support: NoReason, plan: plan, session: 0, recoveryAttempted: false, reported: NoReport, revision: j.revision + 1 }
pure def canVerify(j: Journal, planId: int): bool = j.phase == Staging and j.plan.id == planId
pure def verify(j: Journal, planId: int): Journal = { ...j, phase: Verified, revision: j.revision + 1 }
pure def canDropPlan(j: Journal, planId: int): bool = (j.phase == Staging or j.phase == Verified) and j.plan.id == planId
pure def dropPlan(j: Journal, planId: int): JournalStep =
  conclude(true, j.plan.baseline, j, { ...j, phase: Idle, support: NoReason, plan: noPlan, session: 0, reported: NoReport, revision: j.revision + 1 })
pure def changeChannel(j: Journal): JournalStep = {
  val shifted = { ...j, generation: j.generation + 1, revision: j.revision + 1 }
  if (j.phase == Staging or j.phase == Verified)
    conclude(true, j.plan.baseline, j, { ...shifted, phase: Idle, support: NoReason, plan: noPlan, session: 0, reported: NoReport })
  else conclude(false, j.plan.baseline, j, shifted)
}
pure val planValues = Set(
  { id: 1, generation: 0, baseline: 1, candidate: 2, recovery: 3 },
  { id: 2, generation: 0, baseline: 2, candidate: 4, recovery: 5 },
  { id: 1, generation: 1, baseline: 1, candidate: 2, recovery: 3 }
)
pure val installedValues = Set(1, 2)
pure val planIdValues = Set(1, 2)
pure val weight_changeChannel = 1
pure val weight_dropPlan = 1
pure def alwaysPlanOutsideIdle(j: Journal): bool = if (j.phase == Idle) j.plan == noPlan else validPlan(j.plan)
pure def sometimesPlanVerified(j: Journal): bool = j.phase == Verified
```

### The agent is held before the installer gets a session

The journal asks for the hold on the artifact it is about to install and
hands the platform a session only after the agent service acknowledged that
exact hold. While the installer may still act, the hold stays granted.

```quint
pure def awaitsReadback(j: Journal): bool =
  j.phase == Committing or j.phase == Recovering or (j.phase == Support and j.support != RecoveryFailed)
pure def holdTarget(j: Journal): ArtifactId = if (j.phase == RecoveryReady) j.plan.recovery else j.plan.candidate
pure def canRequestHold(j: Journal): bool = (j.phase == Verified or j.phase == RecoveryReady) and j.hold == Unheld
pure def requestHold(j: Journal): JournalStep =
  { state: { ...j, hold: HoldRequested, revision: j.revision + 1 }, out: List(Hold({ target: holdTarget(j) })) }
pure def canAcknowledgeHold(j: Journal, target: ArtifactId): bool = j.hold == HoldRequested and target == holdTarget(j)
pure def acknowledgeHold(j: Journal, target: ArtifactId): Journal = { ...j, hold: HoldGranted, revision: j.revision + 1 }
pure def canCommitCandidate(j: Journal, sessionId: int): bool = j.phase == Verified and j.hold == HoldGranted and sessionId > 0
pure def commitCandidate(j: Journal, sessionId: int): Journal = { ...j, phase: Committing, session: sessionId, revision: j.revision + 1 }
pure val targetValues = Set(2, 3, 4)
pure val sessionIdValues = Set(1, 2)
pure def alwaysAwaitingIsHeld(j: Journal): bool = awaitsReadback(j) implies (j.hold == HoldGranted and j.session > 0)
pure def alwaysHoldOnlyForAnOpenAttempt(j: Journal): bool =
  j.hold != Unheld implies (awaitsReadback(j) or j.phase == Verified or j.phase == RecoveryReady)
pure def sometimesHandedOff(j: Journal): bool = j.phase == Committing
```

### Platform readback decides the outcome of an install

A readback counts only for this plan and session. The expected identity
installed confirms it; an identity that is neither expected nor previous,
a blocked session or a stalled one waits in support; a session still listed
keeps waiting and remembers the strongest report; a gone session settles
by its report. A gone session with no report waits once as an unknown
outcome; the shell abandons it after its qualified wait (15 minutes).

```quint
type SessionStatus = SessionListed | SessionBlocked | SessionGone
type Readback = { planId: int, sessionId: int, installed: ArtifactId, status: SessionStatus, report: InstallerReport }
pure val installBudget = 3
pure def expectedInstall(j: Journal): ArtifactId = if (j.recoveryAttempted) j.plan.recovery else j.plan.candidate
pure def previousInstall(j: Journal): ArtifactId = if (j.recoveryAttempted) j.plan.candidate else j.plan.baseline
pure def stronger(a: InstallerReport, b: InstallerReport): InstallerReport =
  if (a == CandidateRejected or b == CandidateRejected) CandidateRejected else if (a == Retryable or b == Retryable) Retryable else NoReport
pure def releaseCount(j: Journal): int = if (j.releasedCandidate == j.plan.candidate) j.releases + 1 else 1
pure def afterRelease(count: int, j: Journal): Journal =
  if (count >= installBudget) { ...j, phase: Quarantined, support: NoReason, quarantine: j.quarantine.union(Set(j.plan.candidate)), releasedCandidate: j.plan.candidate, releases: count, reported: NoReport, revision: j.revision + 1 }
  else { ...j, phase: Idle, support: NoReason, plan: noPlan, session: 0, releasedCandidate: j.plan.candidate, releases: count, reported: NoReport, revision: j.revision + 1 }
pure def canObserveInstall(j: Journal, readback: Readback): bool = awaitsReadback(j) and readback.planId == j.plan.id and readback.sessionId == j.session
pure def observeInstall(j: Journal, readback: Readback): JournalStep = {
  val recovering = j.recoveryAttempted
  val expected = expectedInstall(j)
  val previous = previousInstall(j)
  val report = stronger(j.reported, readback.report)
  val r = j.revision + 1
  if (readback.installed == expected)
    conclude(true, expected, j, { ...j, phase: if (recovering) RecoveryProbation else Probation, support: NoReason, reported: NoReport,
      releasedCandidate: if (recovering) j.releasedCandidate else 0, releases: if (recovering) j.releases else 0, revision: r })
  else if (readback.installed != previous) conclude(false, previous, j, { ...j, phase: Support, support: UnexpectedIdentity, revision: r })
  else if (readback.status == SessionBlocked) conclude(false, previous, j, { ...j, phase: Support, support: InstallerBlocked, revision: r })
  else if (readback.status == SessionListed) conclude(false, previous, j, { ...j, reported: if (recovering) j.reported else report, revision: r })
  else if (recovering and j.phase == Support) conclude(false, previous, j, j)
  else if (recovering) conclude(true, previous, j, { ...j, phase: Support, support: RecoveryFailed, revision: r })
  else if (report == CandidateRejected)
    conclude(true, previous, j, { ...j, phase: Quarantined, support: NoReason, quarantine: j.quarantine.union(Set(j.plan.candidate)), reported: NoReport, revision: r })
  else if (report == Retryable) conclude(true, previous, j, afterRelease(releaseCount(j), j))
  else if (j.support == OutcomeUnknown) conclude(false, previous, j, j)
  else conclude(false, previous, j, { ...j, phase: Support, support: OutcomeUnknown, revision: r })
}
pure def canStallInstall(j: Journal, sessionId: int): bool = (j.phase == Committing or j.phase == Recovering) and sessionId == j.session
pure def stallInstall(j: Journal, sessionId: int): Journal = { ...j, phase: Support, support: InstallStalled, revision: j.revision + 1 }
pure def canAbandonUnknown(j: Journal): bool = j.phase == Support and j.support == OutcomeUnknown
pure def abandonUnknown(j: Journal): JournalStep = conclude(true, j.plan.baseline, j, afterRelease(releaseCount(j), j))
pure val readbackValues = Set(
  { planId: 1, sessionId: 1, installed: 2, status: SessionGone, report: NoReport },
  { planId: 1, sessionId: 1, installed: 1, status: SessionGone, report: NoReport },
  { planId: 1, sessionId: 1, installed: 1, status: SessionGone, report: Retryable },
  { planId: 1, sessionId: 1, installed: 1, status: SessionListed, report: CandidateRejected },
  { planId: 1, sessionId: 1, installed: 1, status: SessionBlocked, report: NoReport },
  { planId: 1, sessionId: 1, installed: 9, status: SessionGone, report: NoReport },
  { planId: 1, sessionId: 1, installed: 3, status: SessionGone, report: NoReport },
  { planId: 1, sessionId: 2, installed: 3, status: SessionGone, report: NoReport },
  { planId: 1, sessionId: 2, installed: 2, status: SessionGone, report: NoReport }
)
pure val weight_observeInstall = 4
pure def alwaysOpenCandidateIsNotQuarantined(j: Journal): bool =
  (j.phase == Staging or j.phase == Verified or (awaitsReadback(j) and not(j.recoveryAttempted))) implies not(j.quarantine.contains(j.plan.candidate))
pure def alwaysUnknownOutcomeIsNotRecovery(j: Journal): bool = j.support == OutcomeUnknown implies not(j.recoveryAttempted)
pure def sometimesCandidateInstalled(j: Journal): bool = j.phase == Probation
pure def sometimesOutcomeUnknown(j: Journal): bool = j.phase == Support and j.support == OutcomeUnknown
pure def sometimesRetryReleased(j: Journal): bool = j.phase == Idle and j.releases == 1
pure def sometimesBlocked(j: Journal): bool = j.phase == Support and j.support == InstallerBlocked
```

### The hold is released only after a confirmed install or a proven ended attempt

Every hold the journal asks for is announced once, and every hold it gives
back is announced once, naming what is installed. A release happens only
when the journal leaves the attempt: the expected artifact installed, the
session gone and settled, or the plan dropped before any handoff.

```quint
pure def isRelease(e: UpdateHold): bool = match e { | Release(r) => true | _ => false }
pure def isHold(e: UpdateHold): bool = match e { | Hold(h) => true | _ => false }
pure def stepHoldsAreAnnounced(before: Journal, via: str, after: Journal, out: List[UpdateHold]): bool =
  (out.some(e => isHold(e)) iff (before.hold == Unheld and after.hold == HoldRequested)) and
  (out.some(e => isRelease(e)) iff (before.hold != Unheld and after.hold == Unheld))
pure def sometimesHoldAwaitsAcknowledgement(j: Journal): bool = j.hold == HoldRequested
```

### A candidate released three times in a row is quarantined

```quint
pure def alwaysRetryBudget(j: Journal): bool =
  j.releases >= 0 and j.releases <= installBudget and (j.releases == 0 iff j.releasedCandidate == 0) and
  (j.releases >= installBudget implies j.quarantine.contains(j.releasedCandidate))
```

### A reported rejection is kept while the installation is unresolved

```quint
pure def stepRejectionIsDurable(before: Journal, after: Journal): bool =
  (before.reported == CandidateRejected and (after.phase == Committing or after.phase == Support)) implies after.reported == CandidateRejected
pure def sometimesRejectionKept(j: Journal): bool = j.phase == Committing and j.reported == CandidateRejected
pure def sometimesQuarantined(j: Journal): bool = j.phase == Quarantined
```

### A quarantined artifact stays quarantined

Quarantine is keyed by artifact, so another plan with clean artifacts can
still be staged.

```quint
pure def stepQuarantineIsPermanent(before: Journal, after: Journal): bool = before.quarantine.subseteq(after.quarantine)
pure def alwaysQuarantinedPlanNamesItsCandidate(j: Journal): bool = j.phase == Quarantined implies j.quarantine.contains(j.plan.candidate)
```

### The channel generation never goes back

A plan or health evidence from an earlier generation can never match again.

```quint
pure def stepGenerationNeverGoesBack(before: Journal, after: Journal): bool = after.generation >= before.generation
```

## Story: Recover from an unhealthy update once

> As a device owner, I want a new app version judged only by health evidence
> about that installation, and recovered at most once, so that an unhealthy
> update is undone without looping.

### Health evidence counts only for the current installation

Evidence names the plan, channel generation and journal revision it was
collected for, and the identity it saw installed. A failure quarantines the
candidate and, after a recovery, the recovery artifact too. A late failure
of a healthy candidate still counts.

```quint
type HealthVerdict = HealthPassed | HealthFailed
type HealthEvidence = { planId: int, generation: int, revision: int, installed: ArtifactId, verdict: HealthVerdict }
pure def inProbation(j: Journal): bool = j.phase == Probation or j.phase == RecoveryProbation
pure def matchesHealth(j: Journal, evidence: HealthEvidence): bool =
  evidence.planId == j.plan.id and evidence.generation == j.generation and evidence.revision == j.revision and evidence.installed == expectedInstall(j)
pure def canObserveHealth(j: Journal, evidence: HealthEvidence): bool =
  matchesHealth(j, evidence) and (inProbation(j) or (j.phase == Healthy and evidence.verdict == HealthFailed))
pure def observeHealth(j: Journal, evidence: HealthEvidence): Journal =
  if (evidence.verdict == HealthPassed) { ...j, phase: if (j.recoveryAttempted) Recovered else Healthy, revision: j.revision + 1 }
  else if (j.recoveryAttempted) { ...j, phase: Support, support: RecoveryFailed, quarantine: j.quarantine.union(Set(j.plan.candidate)).union(Set(j.plan.recovery)), revision: j.revision + 1 }
  else { ...j, phase: RecoveryReady, quarantine: j.quarantine.union(Set(j.plan.candidate)), revision: j.revision + 1 }
pure val evidenceValues = Set(
  { planId: 1, generation: 0, revision: 6, installed: 2, verdict: HealthPassed },
  { planId: 1, generation: 0, revision: 6, installed: 2, verdict: HealthFailed },
  { planId: 1, generation: 0, revision: 7, installed: 2, verdict: HealthFailed },
  { planId: 1, generation: 0, revision: 11, installed: 3, verdict: HealthPassed },
  { planId: 1, generation: 0, revision: 11, installed: 3, verdict: HealthFailed },
  { planId: 1, generation: 1, revision: 6, installed: 2, verdict: HealthPassed }
)
pure val weight_observeHealth = 4
pure def sometimesHealthy(j: Journal): bool = j.phase == Healthy
```

### Recovery is attempted at most once and only under a granted hold

Recovery needs a hold on the recovery artifact like any install. When the
shell finds the recovery artifact no longer admissible it denies recovery,
which quarantines both artifacts.

```quint
pure def canCommitRecovery(j: Journal, sessionId: int): bool =
  j.phase == RecoveryReady and not(j.recoveryAttempted) and j.hold == HoldGranted and sessionId > 0
pure def commitRecovery(j: Journal, sessionId: int): Journal =
  { ...j, phase: Recovering, session: sessionId, recoveryAttempted: true, revision: j.revision + 1 }
pure def canDenyRecovery(j: Journal): bool = j.phase == RecoveryReady
pure def denyRecovery(j: Journal): JournalStep =
  conclude(true, j.plan.candidate, j, { ...j, phase: Quarantined, quarantine: j.quarantine.union(Set(j.plan.recovery)), revision: j.revision + 1 })
pure def alwaysRecoveryFollowsQuarantinedCandidate(j: Journal): bool =
  (j.recoveryAttempted or j.phase == RecoveryReady) implies j.quarantine.contains(j.plan.candidate)
pure def alwaysRecoveryPhasesMatchTheAttempt(j: Journal): bool =
  ((j.phase == Recovering or j.phase == RecoveryProbation or j.phase == Recovered) implies j.recoveryAttempted) and
  ((j.phase == Staging or j.phase == Verified or j.phase == Committing or j.phase == Probation or j.phase == Healthy or j.phase == RecoveryReady) implies not(j.recoveryAttempted))
pure def sometimesRecovered(j: Journal): bool = j.phase == Recovered
```

### Support names why the update stopped

```quint
pure def alwaysSupportNamesItsReason(j: Journal): bool = (j.phase == Support) iff (j.support != NoReason)
pure def sometimesRecoveryFailed(j: Journal): bool = j.phase == Support and j.support == RecoveryFailed
```
