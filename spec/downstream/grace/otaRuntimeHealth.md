# Grace OTA runtime health observations

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` installs `OtaHealthService` with the product's `HEALTH_OBSERVATIONS` signature permission. At Eliza `7743504b7c936a764b3938a44cad918808b621df`, the product extends `plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/health/NativeHealthService.java` and uses `LocalRuntimeHealth.java`. This service reports evidence from the installed product. The UI observer owns its three fields, and the updater owns installed artifact verification and probation. Neither a service response nor a disposable SQLite probe can by itself qualify an installation.

## Story: Ask the installed product for a bounded authenticated observation

### The actual Messenger sender and exact request shape gate a single worker

The manifest admits a caller with the signature permission. For each message the service reads Android's actual sending UID. That UID must resolve to exactly one package, the configured supervisor package, which must match the product process's signer. A different package with the same signer gets `403 unauthorized` before message parsing. Bind permission and per-message identity are separate checks.

A request has message kind 1 and exactly three Bundle entries. `nonce` is a string of exactly 64 lowercase hex digits, `versionCode` and `deadlineElapsed` are boxed longs, and the version equals the installed product version. The deadline is strictly in the future on the Android elapsed clock and no more than 20,000 ms ahead. Grace's UI budget is 1,500 ms and the service caps that observation at the enclosing deadline. One worker can execute with one waiting request. Closed service, malformed request and a rejected enqueue give `400 invalid_or_busy` to the authorized sender. An absent reply port or failed Messenger delivery yields no delivered reply. Destroy closes admission and stops or removes queued work. Grace `AndroidManifest.xml:3,71`, `OtaHealthService.java:4–15`. Eliza `NativeHealthService.java:16–44`.

```quint
type HealthEnvelope = { senderPackages: int, supervisorPackageMatches: bool, signatureMatches: bool, closed: bool, requestKind: int, exactBundleKeys: bool, exactValueTypes: bool, nonceSyntax: bool, versionMatches: bool, now: int, deadline: int, workerAdmitted: bool }
pure def senderAuthorized(req: HealthEnvelope): bool = req.senderPackages == 1 and req.supervisorPackageMatches and req.signatureMatches
pure def validHealthEnvelope(req: HealthEnvelope): bool =
  not(req.closed) and req.requestKind == 1 and req.exactBundleKeys and req.exactValueTypes and req.nonceSyntax and req.versionMatches and
  req.deadline > req.now and req.deadline - req.now <= 20000
pure def healthAdmission(req: HealthEnvelope): str =
  if (not(senderAuthorized(req))) "403 unauthorized"
  else if (not(validHealthEnvelope(req) and req.workerAdmitted)) "400 invalid_or_busy"
  else "queued"
pure def uiDeadline(now: int, deadline: int): int = if (now + 1500 < deadline) now + 1500 else deadline
pure def lawAdmittedHealthRequestIsOwnerBound(req: HealthEnvelope): bool =
  healthAdmission(req) == "queued" implies senderAuthorized(req) and validHealthEnvelope(req)
pure def lawUnauthorizedPrecedesRequestValidation(req: HealthEnvelope): bool =
  not(senderAuthorized(req)) implies healthAdmission(req) == "403 unauthorized"
pure def lawUiBudgetStaysInsideObservation(now: int, deadline: int): bool =
  uiDeadline(now, deadline) <= deadline and uiDeadline(now, deadline) <= now + 1500
pure val requestedHealth: HealthEnvelope = { senderPackages: 1, supervisorPackageMatches: true, signatureMatches: true, closed: false, requestKind: 1, exactBundleKeys: true, exactValueTypes: true, nonceSyntax: true, versionMatches: true, now: 10, deadline: 110, workerAdmitted: true }
pure val reqValues = Set({ ...requestedHealth, now: 0, deadline: 100 }, { ...requestedHealth, now: 10, deadline: 100 }, requestedHealth, { ...requestedHealth, senderPackages: 2 }, { ...requestedHealth, supervisorPackageMatches: false }, { ...requestedHealth, signatureMatches: false }, { ...requestedHealth, versionMatches: false }, { ...requestedHealth, exactBundleKeys: false }, { ...requestedHealth, exactValueTypes: false }, { ...requestedHealth, workerAdmitted: false }, { ...requestedHealth, closed: true }, { ...requestedHealth, deadline: 10 }, { ...requestedHealth, deadline: 20010 }, { ...requestedHealth, deadline: 20011 })
pure val nowValues = Set(0, 10, 2000)
pure val deadlineValues = Set(0, 10, 100, 2100, 20010)
```

## Story: Report runtime readiness with the evidence from the same running binding

### The agent and gateway probes are independent and task storage requires the qualified gateway

When the service instance is absent, read returns `runtimeInstance: none`, state `stopped`, epoch zero, both responsiveness fields false and `taskStorage: unavailable` without a probe. Otherwise it samples the runtime owner object, launch instance, epoch, lifecycle state, stopping flag and the agent and gateway process objects. The product uses a 750 ms budget for each local HTTP exchange. Only a running, nonstopping runtime probes. Each probe requires its child's current liveness at the point of dispatch. The agent uses authenticated loopback GET `/api/status`; HTTP 200 is sufficient here. The gateway uses authenticated loopback GET `/local-health` and needs 200, schema version 1, `gatewayResponsive` and `ownershipLoaded`. That gateway route requires its native inbound bearer credential, no origin, GET and no query; it waits for hydrated ownership and does not query inference, Cloud or task storage.

Only after a qualified gateway reply does the observer read `/local-storage` through the gateway. That route uses the same local request restrictions and returns version 1 with `ok`, `unavailable` or `deferred`, defaulting to unavailable on failed or unrecognized storage inspection. These three words report task storage, independently of the disposable diagnostic. Ordinary `IOException` on a probe is absorbed as unavailable evidence. Other exceptions, including malformed JSON shape reached by a successful exchange, can fail the outer observation. The gateway's ordinary OPTIONS path and recognized browser preflights can return 204 without health evidence. The model's probe facts are decoded at that boundary. Runtime sampling does not start or repair a process. Grace `LocalRuntimeService.java:24,129–132`. Eliza `EmbeddedRuntimeService.java:79–88,117–120`, `LocalRuntimeHealth.java:37–56`, `packages/agent/native-host/gateway.mjs:637–702`.

```quint
type LocalHealthRequest = { expectsNativeToken: bool, bearerMatches: bool, callerAllowed: bool, hasOrigin: bool, methodGet: bool, methodOptions: bool, corsPreflight: bool, hasQuery: bool, ownershipLoaded: bool }
pure def localHealthRoute(localRequest: LocalHealthRequest): str =
  if (localRequest.corsPreflight) (if (localRequest.callerAllowed) "204" else "403")
  else if (localRequest.expectsNativeToken and not(localRequest.bearerMatches)) "401"
  else if (not(localRequest.callerAllowed)) "403"
  else if (localRequest.methodOptions) "204"
  else if (not(localRequest.ownershipLoaded)) "ownership-unavailable"
  else if (not(localRequest.expectsNativeToken) or localRequest.hasOrigin) "403"
  else if (not(localRequest.methodGet)) "405"
  else if (localRequest.hasQuery) "400"
  else "200"
pure def lawHealthSuccessNeedsNativeBearer(localRequest: LocalHealthRequest): bool =
  localHealthRoute(localRequest) == "200" implies localRequest.expectsNativeToken and localRequest.bearerMatches and localRequest.callerAllowed and not(localRequest.hasOrigin) and localRequest.methodGet and not(localRequest.hasQuery) and localRequest.ownershipLoaded
pure val nativeGet: LocalHealthRequest = { expectsNativeToken: true, bearerMatches: true, callerAllowed: true, hasOrigin: false, methodGet: true, methodOptions: false, corsPreflight: false, hasQuery: false, ownershipLoaded: true }
pure val localRequestValues = Set(nativeGet, { ...nativeGet, bearerMatches: false }, { ...nativeGet, hasOrigin: true }, { ...nativeGet, hasQuery: true }, { ...nativeGet, methodGet: false }, { ...nativeGet, ownershipLoaded: false }, { ...nativeGet, expectsNativeToken: false }, { ...nativeGet, methodGet: false, methodOptions: true, corsPreflight: true })
type RuntimeObservation = { present: bool, serviceId: int, instanceId: int, epoch: int, runtimeState: str, stopping: bool, agentRef: int, gatewayRef: int, agentAlive: bool, gatewayAlive: bool }
type RuntimeProbe = { agentHttpOk: bool, gatewayHttpOk: bool, gatewaySchemaOne: bool, gatewayResponsive: bool, ownershipLoaded: bool, storageHttpOk: bool, storageSchemaOne: bool, storageWord: str }
pure def probeRunning(observed: RuntimeObservation): bool = observed.present and observed.runtimeState == "running" and not(observed.stopping)
pure def agentProbeRead(observed: RuntimeObservation): bool = probeRunning(observed) and observed.agentAlive
pure def gatewayProbeRead(observed: RuntimeObservation): bool = probeRunning(observed) and observed.gatewayAlive
pure def storageProbeRead(observed: RuntimeObservation, portFacts: RuntimeProbe): bool =
  gatewayProbeRead(observed) and portFacts.gatewayHttpOk and portFacts.gatewaySchemaOne and portFacts.gatewayResponsive and portFacts.ownershipLoaded
pure def storageWordValid(word: str): bool = word == "ok" or word == "unavailable" or word == "deferred"
pure def sameSample(before: RuntimeObservation, after: RuntimeObservation): bool =
  before.present and after.present and before.serviceId == after.serviceId and before.instanceId == after.instanceId and
  before.epoch == after.epoch and before.runtimeState == after.runtimeState and before.stopping == after.stopping and before.agentRef == after.agentRef and before.gatewayRef == after.gatewayRef
type RuntimeEvidence = { failed: bool, processId: int, instanceId: int, epoch: int, runtimeState: str, agentResponsive: bool, gatewayResponsive: bool, taskStorage: str }
pure def absentEvidence(processId: int): RuntimeEvidence =
  { failed: false, processId: processId, instanceId: 0, epoch: 0, runtimeState: "stopped", agentResponsive: false, gatewayResponsive: false, taskStorage: "unavailable" }
pure def sampleEvidence(processId: int, before: RuntimeObservation, after: RuntimeObservation, portFacts: RuntimeProbe): RuntimeEvidence = {
  val gatewayReady = storageProbeRead(before, portFacts) and after.gatewayAlive
  if (not(before.present)) absentEvidence(processId)
  else if (not(sameSample(before, after))) { ...absentEvidence(processId), failed: true }
  else {
    failed: false, processId: processId, instanceId: before.instanceId, epoch: before.epoch, runtimeState: before.runtimeState,
    agentResponsive: agentProbeRead(before) and portFacts.agentHttpOk and after.agentAlive, gatewayResponsive: gatewayReady,
    taskStorage: if (gatewayReady and portFacts.storageHttpOk and portFacts.storageSchemaOne and storageWordValid(portFacts.storageWord)) portFacts.storageWord else "unavailable"
  }
}
pure def lawStorageEvidenceRequiresLiveGateway(processId: int, before: RuntimeObservation, after: RuntimeObservation, portFacts: RuntimeProbe): bool =
  sampleEvidence(processId, before, after, portFacts).taskStorage != "unavailable" implies
  sameSample(before, after) and storageProbeRead(before, portFacts) and after.gatewayAlive and portFacts.storageHttpOk and portFacts.storageSchemaOne
pure def lawMissingRuntimeUsesNoProbes(observed: RuntimeObservation, portFacts: RuntimeProbe): bool =
  not(observed.present) implies not(agentProbeRead(observed) or gatewayProbeRead(observed) or storageProbeRead(observed, portFacts))
pure val runningRuntime: RuntimeObservation = { present: true, serviceId: 1, instanceId: 1, epoch: 1, runtimeState: "running", stopping: false, agentRef: 1, gatewayRef: 2, agentAlive: true, gatewayAlive: true }
pure val absentRuntime: RuntimeObservation = { ...runningRuntime, present: false, instanceId: 0, epoch: 0, runtimeState: "stopped", agentAlive: false, gatewayAlive: false }
pure val readyProbe: RuntimeProbe = { agentHttpOk: true, gatewayHttpOk: true, gatewaySchemaOne: true, gatewayResponsive: true, ownershipLoaded: true, storageHttpOk: true, storageSchemaOne: true, storageWord: "ok" }
pure val beforeValues = Set(runningRuntime, absentRuntime, { ...runningRuntime, stopping: true }, { ...runningRuntime, gatewayAlive: false }, { ...runningRuntime, agentAlive: false })
pure val afterValues = Set(runningRuntime, absentRuntime, { ...runningRuntime, epoch: 2 }, { ...runningRuntime, gatewayRef: 3 }, { ...runningRuntime, gatewayAlive: false }, { ...runningRuntime, agentAlive: false })
pure val observedValues = Set(runningRuntime, absentRuntime, { ...runningRuntime, stopping: true }, { ...runningRuntime, gatewayAlive: false })
pure val portFactsValues = Set(readyProbe, { ...readyProbe, agentHttpOk: false }, { ...readyProbe, gatewaySchemaOne: false }, { ...readyProbe, ownershipLoaded: false }, { ...readyProbe, storageSchemaOne: false }, { ...readyProbe, storageWord: "invented" }, { ...readyProbe, storageWord: "deferred" })
pure val processIdValues = Set(1, 2)
pure val wordValues = Set("ok", "deferred", "unavailable", "invented")
```

### A later check compares the exact observation fields and keeps liveness claims honest

After the data probes the observer resamples and compares the service object, runtime instance, epoch, state, stopping flag and both process identities. It fails on a mismatch. It then checks liveness of those same captured children again. If the gateway has exited, the observation reports no gateway response and drops even previously qualified storage. The model represents those final liveness facts in the second observation.

After diagnostic storage and the UI port finish, the service runs a different, narrower revalidation against the returned evidence. The product process identity must match. A current absent runtime matches a previous `none` instance. Otherwise the runtime instance, epoch and state must match. Only previously responsive children must still be alive and not stopping. The second check uses the published identity and does not compare the earlier service or process object references, nor does it promote an initially unresponsive child. The model uses positive runtime/process identity symbols and instance zero for `none`. Eliza `LocalRuntimeHealth.java:52–67` and `NativeHealthService.java:33–38`.

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
pure val healthySample: RuntimeEvidence = { failed: false, processId: 1, instanceId: 1, epoch: 1, runtimeState: "running", agentResponsive: true, gatewayResponsive: true, taskStorage: "ok" }
pure val evidenceValues = Set(healthySample, absentEvidence(1), { ...healthySample, processId: 2 }, { ...healthySample, agentResponsive: false }, { ...healthySample, gatewayResponsive: false }, { ...healthySample, failed: true })
pure val currentRuntimeValues = Set(runningRuntime, absentRuntime, { ...runningRuntime, epoch: 2 }, { ...runningRuntime, stopping: true }, { ...runningRuntime, gatewayAlive: false }, { ...runningRuntime, agentAlive: false })
```

## Story: Publish only a completed observation inside its owning request

### Diagnostic result, UI observation and runtime revalidation precede successful delivery

The worker silently drops a request if closed or expired on entry. It reads runtime evidence, adds schema version 5, exact nonce, installed version and distribution, then checks isolated storage. Grace's disposable probe uses `ota-storage-diagnostic` under no-backup storage, at most 16 entries and a 1 MiB SQLite file. It locks the directory's private diagnostic lease, validates all entries before cleaning owned orphans, writes a random value in a synchronous transaction, reopens read-only for exact integrity and nonce readback, and cleans up. User databases and encrypted tasks are separate. The positive diagnostic bit appears after this call returns.

The service copies only `activityState`, `rendererResponsive` and `contentPresent` from the independently deadline-bounded UI port. It requires the runtime revalidation and checks current close and deadline before returning a successful body with its elapsed observation time. An exception at any reached worker stage sends `503 observation_unavailable`, even when the deadline passed or the service closed while that stage was pending. Normal completion after close or expiry sends no success or error. The caller can also time out independently. This machine follows one admitted request and does not simulate Android queue cancellation or reply transport. Grace `LocalPersistenceProbe.java:3–7`, `OtaHealthService.java:7–15`. Eliza `NativeStorageDiagnostic.java:15–55`, `NativeHealthService.java:30–44`.

```quint
type HealthWork = { phase: str, closed: bool, deadline: int, clockNow: int, completedAt: int }
pure val initial: HealthWork = { phase: "idle", closed: false, deadline: 0, clockNow: 0, completedAt: -1 }
pure def canQueueHealth(work: HealthWork, req: HealthEnvelope): bool =
  work.phase == "idle" and not(work.closed) and healthAdmission(req) == "queued" and req.now == work.clockNow
pure def queueHealth(work: HealthWork, req: HealthEnvelope): HealthWork = { ...work, phase: "queued", deadline: req.deadline }
pure def canBeginHealth(work: HealthWork): bool = work.phase == "queued"
pure def beginHealth(work: HealthWork): HealthWork =
  { ...work, phase: if (work.closed or work.clockNow >= work.deadline) "dropped" else "runtime" }
type HealthResult = { succeeded: bool }
pure def canFinishHealthStage(work: HealthWork): bool =
  work.phase == "runtime" or work.phase == "diagnostic" or work.phase == "ui" or work.phase == "revalidate"
pure def finishHealthStage(work: HealthWork, report: HealthResult): HealthWork =
  if (not(report.succeeded)) { ...work, phase: "unavailable" }
  else if (work.phase == "runtime") { ...work, phase: "diagnostic" }
  else if (work.phase == "diagnostic") { ...work, phase: "ui" }
  else if (work.phase == "ui") { ...work, phase: "revalidate" }
  else if (work.closed or work.clockNow >= work.deadline) { ...work, phase: "dropped" }
  else { ...work, phase: "observed", completedAt: work.clockNow }
pure def canAdvanceHealthClock(work: HealthWork, later: int): bool = later >= work.clockNow
pure def advanceHealthClock(work: HealthWork, later: int): HealthWork = { ...work, clockNow: later }
pure def closeHealthService(work: HealthWork): HealthWork = { ...work, closed: true }
pure def alwaysSuccessfulObservationWasOnTime(work: HealthWork): bool =
  work.phase == "observed" implies work.completedAt >= 0 and work.completedAt < work.deadline and work.completedAt <= work.clockNow
pure def alwaysHealthClockValid(work: HealthWork): bool = work.clockNow >= 0
pure def stepNewHealthSuccessRequiresRevalidation(before: HealthWork, via: str, after: HealthWork): bool =
  via == "finishHealthStage" and after.phase == "observed" implies
  before.phase == "revalidate" and not(before.closed) and before.clockNow < before.deadline
pure def sometimesHealthObserved(work: HealthWork): bool = work.phase == "observed"
pure def sometimesLateHealthDropped(work: HealthWork): bool = work.phase == "dropped" and work.clockNow >= work.deadline
pure val reportValues = Set({ succeeded: true }, { succeeded: false })
pure val laterValues = Set(0, 10, 100, 1000, 20010)
pure val weight_queueHealth = 8
pure val weight_beginHealth = 8
pure val weight_finishHealthStage = 10
```
