# Installed runtime health observations

The installed app answers the updater's health requests through a health
service guarded by the consumer's own signature permission. It reports
evidence from the running app: the runtime and its agent and gateway, a
disposable storage diagnostic, and the [UI observer's](./uiHealth.md)
three fields. The [installation journal](./install.md) owns qualification
against a plan; no service response by itself qualifies an installation.

## Story: Ask the installed product for a bounded authenticated observation

> As the updater, I want to ask the installed app for one bounded
> observation over an authenticated channel, so that only the updater can
> request health evidence and no request runs unbounded.

### The actual sender and exact request shape gate a single worker

For each message the service reads Android's actual sending UID. It must
resolve to exactly one package, the configured supervisor package, signed
like the product; any other sender is refused as unauthorized before the
message is parsed. A request has the health message kind, exactly its
three entries (a nonce, the version code and a deadline) with their exact
types, a well-formed nonce, the installed version, and a deadline strictly
in the future and at most 20,000 ms ahead. The UI observation gets at most
1,500 ms, capped by that deadline. One worker runs with one waiting
request; a closed service, a malformed request or a full queue answers the
authorized sender invalid or busy.

```quint
type HealthEnvelope = { senderPackages: int, supervisorPackageMatches: bool, signatureMatches: bool, closed: bool, requestKind: int, exactBundleKeys: bool, exactValueTypes: bool, nonceSyntax: bool, versionMatches: bool, now: int, deadline: int, workerAdmitted: bool }
type HealthAdmission = HealthUnauthorized | HealthInvalidOrBusy | HealthQueued
pure val maxDeadlineMs = 20000
pure val uiBudgetMs = 1500
pure def senderAuthorized(req: HealthEnvelope): bool = req.senderPackages == 1 and req.supervisorPackageMatches and req.signatureMatches
pure def validHealthEnvelope(req: HealthEnvelope): bool =
  not(req.closed) and req.requestKind == 1 and req.exactBundleKeys and req.exactValueTypes and req.nonceSyntax and req.versionMatches and
  req.deadline > req.now and req.deadline - req.now <= maxDeadlineMs
pure def healthAdmission(req: HealthEnvelope): HealthAdmission =
  if (not(senderAuthorized(req))) HealthUnauthorized
  else if (not(validHealthEnvelope(req) and req.workerAdmitted)) HealthInvalidOrBusy
  else HealthQueued
pure def uiDeadline(now: int, deadline: int): int = if (now + uiBudgetMs < deadline) now + uiBudgetMs else deadline
pure def lawUnauthorizedPrecedesRequestValidation(req: HealthEnvelope): bool =
  not(senderAuthorized(req)) implies healthAdmission(req) == HealthUnauthorized
pure def lawUiBudgetStaysInsideObservation(now: int, deadline: int): bool =
  uiDeadline(now, deadline) <= deadline and uiDeadline(now, deadline) <= now + uiBudgetMs
pure val requestedHealth: HealthEnvelope = { senderPackages: 1, supervisorPackageMatches: true, signatureMatches: true, closed: false, requestKind: 1, exactBundleKeys: true, exactValueTypes: true, nonceSyntax: true, versionMatches: true, now: 10, deadline: 110, workerAdmitted: true }
pure val reqValues = Set({ ...requestedHealth, now: 0, deadline: 100 }, { ...requestedHealth, now: 10, deadline: 100 }, requestedHealth, { ...requestedHealth, senderPackages: 2 }, { ...requestedHealth, supervisorPackageMatches: false }, { ...requestedHealth, signatureMatches: false }, { ...requestedHealth, versionMatches: false }, { ...requestedHealth, exactBundleKeys: false }, { ...requestedHealth, exactValueTypes: false }, { ...requestedHealth, workerAdmitted: false }, { ...requestedHealth, closed: true }, { ...requestedHealth, deadline: 10 }, { ...requestedHealth, deadline: 20010 }, { ...requestedHealth, deadline: 20011 })
pure val nowValues = Set(0, 10, 2000)
pure val deadlineValues = Set(0, 10, 100, 2100, 20010)
```

## Story: Report runtime readiness with the evidence from the same running binding

> As the updater, I want runtime readiness reported only with evidence
> from the same running runtime, so that a restarted or stale runtime
> never vouches for the update.

### The agent and gateway probes are independent and task storage requires the qualified gateway

With no runtime the observation reports no instance, stopped, epoch zero,
no responsive child and unavailable task storage, without a probe.
Otherwise only a running, nonstopping runtime probes, and each probe
needs its child alive when it is sent. The agent answers its status
route; the gateway's [local health route](../../agent/nativeHost/gateway.md)
reports gateway responsiveness and loaded ownership. Only after a
qualified gateway reply is task storage read through the gateway, as one
of ok, unavailable or deferred; anything else is unavailable. Sampling
never starts or repairs a process.

```quint
type RuntimeState = RuntimeStopped | RuntimeStarting | RuntimeRunning
type TaskStorage = StorageOk | StorageUnavailable | StorageDeferred
type StorageWord = WordOk | WordUnavailable | WordDeferred | WordUnrecognized
type RuntimeObservation = { present: bool, serviceId: int, instanceId: int, epoch: int, runtimeState: RuntimeState, stopping: bool, agentRef: int, gatewayRef: int, agentAlive: bool, gatewayAlive: bool }
type RuntimeProbe = { agentHttpOk: bool, gatewayHttpOk: bool, gatewaySchemaOne: bool, gatewayResponsive: bool, ownershipLoaded: bool, storageHttpOk: bool, storageSchemaOne: bool, storageWord: StorageWord }
pure def probeRunning(observed: RuntimeObservation): bool = observed.present and observed.runtimeState == RuntimeRunning and not(observed.stopping)
pure def agentProbeRead(observed: RuntimeObservation): bool = probeRunning(observed) and observed.agentAlive
pure def gatewayProbeRead(observed: RuntimeObservation): bool = probeRunning(observed) and observed.gatewayAlive
pure def storageProbeRead(observed: RuntimeObservation, portFacts: RuntimeProbe): bool =
  gatewayProbeRead(observed) and portFacts.gatewayHttpOk and portFacts.gatewaySchemaOne and portFacts.gatewayResponsive and portFacts.ownershipLoaded
pure def storageReading(word: StorageWord): TaskStorage =
  if (word == WordOk) StorageOk else if (word == WordDeferred) StorageDeferred else StorageUnavailable
pure def sameSample(before: RuntimeObservation, after: RuntimeObservation): bool =
  before.present and after.present and before.serviceId == after.serviceId and before.instanceId == after.instanceId and
  before.epoch == after.epoch and before.runtimeState == after.runtimeState and before.stopping == after.stopping and before.agentRef == after.agentRef and before.gatewayRef == after.gatewayRef
type RuntimeEvidence = { failed: bool, processId: int, instanceId: int, epoch: int, runtimeState: RuntimeState, agentResponsive: bool, gatewayResponsive: bool, taskStorage: TaskStorage }
pure def absentEvidence(processId: int): RuntimeEvidence =
  { failed: false, processId: processId, instanceId: 0, epoch: 0, runtimeState: RuntimeStopped, agentResponsive: false, gatewayResponsive: false, taskStorage: StorageUnavailable }
pure def sampleEvidence(processId: int, before: RuntimeObservation, after: RuntimeObservation, portFacts: RuntimeProbe): RuntimeEvidence = {
  val gatewayReady = storageProbeRead(before, portFacts) and after.gatewayAlive
  if (not(before.present)) absentEvidence(processId)
  else if (not(sameSample(before, after))) { ...absentEvidence(processId), failed: true }
  else {
    failed: false, processId: processId, instanceId: before.instanceId, epoch: before.epoch, runtimeState: before.runtimeState,
    agentResponsive: agentProbeRead(before) and portFacts.agentHttpOk and after.agentAlive, gatewayResponsive: gatewayReady,
    taskStorage: if (gatewayReady and portFacts.storageHttpOk and portFacts.storageSchemaOne) storageReading(portFacts.storageWord) else StorageUnavailable
  }
}
pure def lawStorageEvidenceRequiresLiveGateway(processId: int, before: RuntimeObservation, after: RuntimeObservation, portFacts: RuntimeProbe): bool =
  sampleEvidence(processId, before, after, portFacts).taskStorage != StorageUnavailable implies
  sameSample(before, after) and storageProbeRead(before, portFacts) and after.gatewayAlive and portFacts.storageHttpOk and portFacts.storageSchemaOne
pure def lawMissingRuntimeUsesNoProbes(observed: RuntimeObservation, portFacts: RuntimeProbe): bool =
  not(observed.present) implies not(agentProbeRead(observed) or gatewayProbeRead(observed) or storageProbeRead(observed, portFacts))
pure val runningRuntime: RuntimeObservation = { present: true, serviceId: 1, instanceId: 1, epoch: 1, runtimeState: RuntimeRunning, stopping: false, agentRef: 1, gatewayRef: 2, agentAlive: true, gatewayAlive: true }
pure val absentRuntime: RuntimeObservation = { ...runningRuntime, present: false, instanceId: 0, epoch: 0, runtimeState: RuntimeStopped, agentAlive: false, gatewayAlive: false }
pure val readyProbe: RuntimeProbe = { agentHttpOk: true, gatewayHttpOk: true, gatewaySchemaOne: true, gatewayResponsive: true, ownershipLoaded: true, storageHttpOk: true, storageSchemaOne: true, storageWord: WordOk }
pure val beforeValues = Set(runningRuntime, absentRuntime, { ...runningRuntime, stopping: true }, { ...runningRuntime, gatewayAlive: false }, { ...runningRuntime, agentAlive: false })
pure val afterValues = Set(runningRuntime, absentRuntime, { ...runningRuntime, epoch: 2 }, { ...runningRuntime, gatewayRef: 3 }, { ...runningRuntime, gatewayAlive: false }, { ...runningRuntime, agentAlive: false })
pure val observedValues = Set(runningRuntime, absentRuntime, { ...runningRuntime, stopping: true }, { ...runningRuntime, gatewayAlive: false })
pure val portFactsValues = Set(readyProbe, { ...readyProbe, agentHttpOk: false }, { ...readyProbe, gatewaySchemaOne: false }, { ...readyProbe, ownershipLoaded: false }, { ...readyProbe, storageSchemaOne: false }, { ...readyProbe, storageWord: WordUnrecognized }, { ...readyProbe, storageWord: WordDeferred })
pure val processIdValues = Set(1, 2)
```

### A later check compares the exact observation fields and keeps liveness claims honest

After the probes the observer samples again and fails on any change of
service, runtime instance, epoch, state, stopping flag or process
identity. A gateway that has exited by then reports no response and drops
its storage reading. Before the reply the service revalidates the
published evidence: the product process must match, an absent runtime
matches only an absent instance, otherwise instance, epoch and state must
match, and every child reported responsive must still be alive and not
stopping. An initially unresponsive child is never promoted.

```quint
pure def runtimeUnchanged(evidence: RuntimeEvidence, processId: int, currentRuntime: RuntimeObservation): bool =
  not(evidence.failed) and evidence.processId == processId and (
    if (not(currentRuntime.present)) evidence.instanceId == 0
    else evidence.instanceId == currentRuntime.instanceId and evidence.epoch == currentRuntime.epoch and evidence.runtimeState == currentRuntime.runtimeState and
      (not(evidence.agentResponsive) or (not(currentRuntime.stopping) and currentRuntime.agentAlive)) and
      (not(evidence.gatewayResponsive) or (not(currentRuntime.stopping) and currentRuntime.gatewayAlive))
  )
pure def lawPublishedResponsiveChildStillLives(evidence: RuntimeEvidence, processId: int, currentRuntime: RuntimeObservation): bool =
  currentRuntime.present and runtimeUnchanged(evidence, processId, currentRuntime) implies
    (evidence.agentResponsive implies currentRuntime.agentAlive and not(currentRuntime.stopping)) and
    (evidence.gatewayResponsive implies currentRuntime.gatewayAlive and not(currentRuntime.stopping))
pure def lawRevalidationRefusesAChangedProcess(evidence: RuntimeEvidence, processId: int, currentRuntime: RuntimeObservation): bool =
  evidence.processId != processId implies not(runtimeUnchanged(evidence, processId, currentRuntime))
pure val healthySample: RuntimeEvidence = { failed: false, processId: 1, instanceId: 1, epoch: 1, runtimeState: RuntimeRunning, agentResponsive: true, gatewayResponsive: true, taskStorage: StorageOk }
pure val evidenceValues = Set(healthySample, absentEvidence(1), { ...healthySample, processId: 2 }, { ...healthySample, agentResponsive: false }, { ...healthySample, gatewayResponsive: false }, { ...healthySample, failed: true })
pure val currentRuntimeValues = Set(runningRuntime, absentRuntime, { ...runningRuntime, epoch: 2 }, { ...runningRuntime, stopping: true }, { ...runningRuntime, gatewayAlive: false }, { ...runningRuntime, agentAlive: false })
```

## Story: Publish only a completed observation inside its owning request

> As the updater, I want an observation published only when it completed
> inside the request that asked for it, so that a late or failed
> observation never reads as success.

### Diagnostic result, UI observation and runtime revalidation precede successful delivery

The worker drops a request that is closed or expired when it starts. It
then reads runtime evidence, runs the disposable storage diagnostic (a
private write, integrity check and readback, cleaned up afterwards and
separate from user data), takes the UI observation and revalidates the
runtime. A failure at any stage answers that the observation is
unavailable. A success is sent only if the service is still open and the
deadline has not passed; otherwise nothing is sent. This machine follows
one admitted request.

```quint
type HealthStage = HealthIdle | HealthQueuedStage | HealthRuntime | HealthDiagnostic | HealthUi | HealthRevalidate | HealthObserved | HealthUnavailable | HealthDropped
type HealthWork = { phase: HealthStage, closed: bool, deadline: int, clockNow: int, completedAt: int }
pure val initial: HealthWork = { phase: HealthIdle, closed: false, deadline: 0, clockNow: 0, completedAt: -1 }
pure def canQueueHealth(work: HealthWork, req: HealthEnvelope): bool =
  work.phase == HealthIdle and not(work.closed) and healthAdmission(req) == HealthQueued and req.now == work.clockNow
pure def queueHealth(work: HealthWork, req: HealthEnvelope): HealthWork = { ...work, phase: HealthQueuedStage, deadline: req.deadline }
pure def canBeginHealth(work: HealthWork): bool = work.phase == HealthQueuedStage
pure def beginHealth(work: HealthWork): HealthWork =
  { ...work, phase: if (work.closed or work.clockNow >= work.deadline) HealthDropped else HealthRuntime }
pure def canFinishHealthStage(work: HealthWork): bool =
  work.phase == HealthRuntime or work.phase == HealthDiagnostic or work.phase == HealthUi or work.phase == HealthRevalidate
pure def finishHealthStage(work: HealthWork, succeeded: bool): HealthWork =
  if (not(succeeded)) { ...work, phase: HealthUnavailable }
  else if (work.phase == HealthRuntime) { ...work, phase: HealthDiagnostic }
  else if (work.phase == HealthDiagnostic) { ...work, phase: HealthUi }
  else if (work.phase == HealthUi) { ...work, phase: HealthRevalidate }
  else if (work.closed or work.clockNow >= work.deadline) { ...work, phase: HealthDropped }
  else { ...work, phase: HealthObserved, completedAt: work.clockNow }
pure def canAdvanceHealthClock(work: HealthWork, later: int): bool = later >= work.clockNow
pure def advanceHealthClock(work: HealthWork, later: int): HealthWork = { ...work, clockNow: later }
pure def closeHealthService(work: HealthWork): HealthWork = { ...work, closed: true }
pure def alwaysSuccessfulObservationWasOnTime(work: HealthWork): bool =
  work.phase == HealthObserved implies work.completedAt >= 0 and work.completedAt < work.deadline and work.completedAt <= work.clockNow
pure def alwaysHealthClockValid(work: HealthWork): bool = work.clockNow >= 0
pure def stepNewHealthSuccessRequiresRevalidation(before: HealthWork, via: str, after: HealthWork): bool =
  via == "finishHealthStage" and after.phase == HealthObserved implies
  before.phase == HealthRevalidate and not(before.closed) and before.clockNow < before.deadline
pure def sometimesHealthObserved(work: HealthWork): bool = work.phase == HealthObserved
pure def sometimesLateHealthDropped(work: HealthWork): bool = work.phase == HealthDropped and work.clockNow >= work.deadline
pure val laterValues = Set(0, 10, 100, 1000, 20010)
pure val weight_queueHealth = 8
pure val weight_beginHealth = 8
pure val weight_finishHealthStage = 10
```
