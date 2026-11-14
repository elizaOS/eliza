# Interactive task authority and operation journal

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/messaging/interactive-task.ts`, `task-events.ts`, and `quint/InteractiveTask.qnt`. Hosts persist every transition atomically before dispatch, and actuators independently recheck the committed proposal against the current page. The generated machine owns the task epoch, revision, scope, observation and operation journal. It performs no browser or device effect.

## Story: Act only against the current authorized observation

As a user, I control which agent, actor, connector, origins and capabilities own a task. A proposal refers to one current observation and epoch. A stale revision, wrong owner, expired proposal, revoked authority or unresolved prior operation prevents dispatch. A proposal ID cannot execute twice.

### An empty task takes an explicit owner and authorized scope

```quint
type Owner = { agentId: str, actorId: str, connector: str }
type TaskStatus = Absent | Active | Paused | Waiting | Blocked | Completed | Cancelled
type OperationStatus = Empty | Prepared | Dispatched | Succeeded | Failed | Unknown | OperationCancelled
type Operation = { id: str, status: OperationStatus, epoch: int, observationId: str, observationVersion: int, inputRevision: int, taskId: str, authorizationId: str, expiresAt: int, capability: str, evidenceRef: str }
type OriginStep = { origin: str, epoch: int, at: int }
type Interactive = { taskId: str, authorizationId: str, owner: Owner, status: TaskStatus, authorized: bool, revision: int, epoch: int, now: int, origins: Set[str], grantedOrigins: Set[str], capabilities: Set[str], observed: bool, observationId: str, observationOrigin: str, observationVersion: int, inputRevision: int, observedAt: int, grantCount: int, originChain: List[OriginStep], originJournal: List[OriginStep], operation: Operation, journal: List[Operation] }
pure val initial: Interactive = { taskId: "", authorizationId: "", owner: { agentId: "", actorId: "", connector: "" }, status: Absent, authorized: false, revision: 0, epoch: 0, now: 0, origins: Set(), grantedOrigins: Set(), capabilities: Set(), observed: false, observationId: "", observationOrigin: "", observationVersion: 0, inputRevision: 0, observedAt: 0, grantCount: 0, originChain: List(), originJournal: List(), operation: { id: "", status: Empty, epoch: 0, observationId: "", observationVersion: 0, inputRevision: 0, taskId: "", authorizationId: "", expiresAt: 0, capability: "", evidenceRef: "" }, journal: List() }
pure val byValues = Set({ agentId: "agent1", actorId: "actor1", connector: "browser" }, { agentId: "agent2", actorId: "actor2", connector: "browser" })
pure val originsValues = Set(Set("https://originA"), Set("https://originA", "https://originB"))
pure val capabilitiesValues = Set(Set("read"), Set("read", "write"))
pure def canCreate(s: Interactive, by: Owner, origins: Set[str], capabilities: Set[str], taskId: str, authorizationId: str): bool = s.status == Absent and by.agentId != "" and by.actorId != "" and by.connector != "" and origins.size() > 0 and taskId != "" and authorizationId != ""
pure def create(s: Interactive, by: Owner, origins: Set[str], capabilities: Set[str], taskId: str, authorizationId: str): Interactive = { ...s, taskId: taskId, authorizationId: authorizationId, owner: by, origins: origins, capabilities: capabilities, authorized: true, status: Active }
pure def ownedRevision(s: Interactive, by: Owner, expectedRevision: int): bool = s.owner == by and expectedRevision == s.revision and s.status != Absent
pure val taskIdValues = Set("task1")
pure val authorizationIdValues = Set("auth1")
pure val expectedRevisionValues = Set(0, 1, 2, 3, 4, 5, 6, 7, 8)
pure def ended(s: Interactive): bool = s.status == Completed or s.status == Cancelled
pure def unresolved(operation: Operation): bool = operation.status == Prepared or operation.status == Dispatched or operation.status == Unknown
pure def cancelledPrepared(operation: Operation): Operation = if (operation.status == Prepared) { ...operation, status: OperationCancelled } else operation
pure def journalAfterCancellation(journal: List[Operation], operation: Operation): List[Operation] = if (operation.status == Prepared) journal.append(cancelledPrepared(operation)) else journal
pure val operationValues = Set({ id: "op1", status: Prepared, epoch: 1, observationId: "obs1", observationVersion: 1, inputRevision: 0, taskId: "task1", authorizationId: "auth1", expiresAt: 10, capability: "read", evidenceRef: "" }, { id: "op2", status: Succeeded, epoch: 1, observationId: "obs1", observationVersion: 1, inputRevision: 0, taskId: "task1", authorizationId: "auth1", expiresAt: 10, capability: "read", evidenceRef: "receipt" })
pure val journalValues: Set[List[Operation]] = Set(List(), List({ id: "op1", status: Succeeded, epoch: 0, observationId: "obs1", observationVersion: 1, inputRevision: 0, taskId: "task1", authorizationId: "auth1", expiresAt: 10, capability: "read", evidenceRef: "receipt1" }))
```

### Observations and proposals bind to the same revision and epoch

Changing the observation cancels a prepared operation. An unresolved dispatched or unknown operation must first settle. Observations retain their original IDs and origins, and action capabilities come from the trusted adapter classification. Observation payload fields travel as one typed input, as they do at the source boundary; simulation supplies coherent payloads and explicit malformed/stale variants rather than constructing an unrelated Cartesian product of fields.

```quint
pure val pointValues = Set({ origin: "https://originA", epoch: 0, at: 0 }, { origin: "https://originB", epoch: 1, at: 1 })
pure val chainValues: Set[List[OriginStep]] = Set(List(), List({ origin: "https://originA", epoch: 0, at: 0 }))
pure def appendOrigin(chain: List[OriginStep], point: OriginStep): List[OriginStep] = if (chain.length() >= 64) chain.removeAt(0).append(point) else chain.append(point)
pure def originPoint(s: Interactive, origin: str, at: int): OriginStep = { origin: origin, epoch: s.epoch, at: if (at > s.originChain.nthOr(s.originChain.length() - 1, { origin: "", epoch: 0, at: 0 }).at) at else s.originChain.nthOr(s.originChain.length() - 1, { origin: "", epoch: 0, at: 0 }).at }
pure def nextOriginChain(s: Interactive, origin: str, at: int): List[OriginStep] = if (s.grantCount == 0 or s.originChain.nthOr(s.originChain.length() - 1, { origin: "", epoch: 0, at: 0 }).origin == origin) s.originChain else appendOrigin(s.originChain, originPoint(s, origin, at))
pure def nextOriginJournal(s: Interactive, origin: str, at: int): List[OriginStep] = if (s.grantCount == 0 or s.originChain.nthOr(s.originChain.length() - 1, { origin: "", epoch: 0, at: 0 }).origin == origin) s.originJournal else s.originJournal.append(originPoint(s, origin, at))
pure def seedOriginChain(s: Interactive): List[OriginStep] = if (s.grantCount == 0 and s.observed) List({ origin: s.observationOrigin, epoch: s.epoch, at: s.observedAt }) else s.originChain
pure def seedOriginJournal(s: Interactive): List[OriginStep] = if (s.grantCount == 0 and s.observed) List({ origin: s.observationOrigin, epoch: s.epoch, at: s.observedAt }) else s.originJournal
pure val observationVersionValues = Set(0, 1, 2, 3)
pure val inputRevisionValues = Set(0, 1, 2)
pure val observedAtValues = Set(0, 1, 3)
pure def observationAdmissible(s: Interactive, by: Owner, expectedRevision: int, observationId: str, origin: str, resume: bool, observationVersion: int, inputRevision: int, observedAt: int): bool = ownedRevision(s, by, expectedRevision) and not(ended(s)) and s.authorized and observationId != "" and s.origins.contains(origin) and s.operation.status != Dispatched and s.operation.status != Unknown and (not(resume) or s.status == Paused) and observationVersion >= 0 and inputRevision >= 0 and observedAt >= 0 and observedAt <= s.now and (not(s.observed) or observationVersion > s.observationVersion)
type ObservationInput = { observationId: str, origin: str, resume: bool, observationVersion: int, inputRevision: int, observedAt: int }
pure val ordinaryObservation: ObservationInput = { observationId: "obs1", origin: "https://originA", resume: false, observationVersion: 1, inputRevision: 0, observedAt: 0 }
pure val observationValues: Set[ObservationInput] = Set(ordinaryObservation, { ...ordinaryObservation, observationId: "obs2", observationVersion: 2, inputRevision: 1, observedAt: 1 }, { ...ordinaryObservation, observationId: "obs2", origin: "https://originB", resume: true, observationVersion: 2, inputRevision: 1, observedAt: 1 }, { ...ordinaryObservation, observationId: "" }, { ...ordinaryObservation, origin: "https://originC" }, { ...ordinaryObservation, observationVersion: -1 }, { ...ordinaryObservation, inputRevision: -1 }, { ...ordinaryObservation, observedAt: -1 }, { ...ordinaryObservation, observedAt: 20 }, { ...ordinaryObservation, observationId: "obs2", resume: true })
pure def canObserve(s: Interactive, by: Owner, expectedRevision: int, observation: ObservationInput): bool = observationAdmissible(s, by, expectedRevision, observation.observationId, observation.origin, observation.resume, observation.observationVersion, observation.inputRevision, observation.observedAt)
pure def observe(s: Interactive, by: Owner, expectedRevision: int, observation: ObservationInput): Interactive = { ...s, observed: true, observationId: observation.observationId, observationOrigin: observation.origin, observationVersion: observation.observationVersion, inputRevision: observation.inputRevision, observedAt: observation.observedAt, originChain: nextOriginChain(s, observation.origin, observation.observedAt), originJournal: nextOriginJournal(s, observation.origin, observation.observedAt), status: if (observation.resume) Active else s.status, operation: cancelledPrepared(s.operation), journal: journalAfterCancellation(s.journal, s.operation), revision: s.revision + 1 }
pure val observationIdValues = Set("obs1", "obs2")
pure val originValues = Set("https://originA", "https://originB", "https://originC")
pure val proposalValues = Set({ id: "op1", status: Prepared, epoch: 0, observationId: "obs1", observationVersion: 1, inputRevision: 0, taskId: "task1", authorizationId: "auth1", expiresAt: 10, capability: "read", evidenceRef: "" }, { id: "op2", status: Prepared, epoch: 1, observationId: "obs2", observationVersion: 2, inputRevision: 1, taskId: "task1", authorizationId: "auth1", expiresAt: 20, capability: "write", evidenceRef: "" })
pure def proposalMatches(s: Interactive, proposal: Operation): bool = proposal.taskId == s.taskId and proposal.authorizationId == s.authorizationId and proposal.epoch == s.epoch and proposal.observationId == s.observationId and proposal.observationVersion == s.observationVersion and proposal.inputRevision == s.inputRevision
pure def canPrepare(s: Interactive, by: Owner, expectedRevision: int, proposal: Operation): bool = ownedRevision(s, by, expectedRevision) and s.status == Active and s.authorized and s.observed and not(unresolved(s.operation)) and proposal.id != "" and not(s.journal.some(entry => entry.id == proposal.id)) and s.capabilities.contains(proposal.capability) and proposal.expiresAt > s.now and proposalMatches(s, proposal)
pure def prepare(s: Interactive, by: Owner, expectedRevision: int, proposal: Operation): Interactive = { ...s, operation: { ...proposal, status: Prepared, evidenceRef: "" }, revision: s.revision + 1 }
pure def canDispatch(s: Interactive, by: Owner, expectedRevision: int): bool = ownedRevision(s, by, expectedRevision) and s.status == Active and s.authorized and s.observed and s.operation.status == Prepared and proposalMatches(s, s.operation) and s.origins.contains(s.observationOrigin) and s.capabilities.contains(s.operation.capability) and s.now < s.operation.expiresAt
pure def dispatch(s: Interactive, by: Owner, expectedRevision: int): Interactive = { ...s, operation: { ...s.operation, status: Dispatched }, status: Waiting, revision: s.revision + 1 }
pure def alwaysPreparedHasCurrentAuthority(s: Interactive): bool = s.operation.status != Prepared or (s.status == Active and s.authorized and s.observed and proposalMatches(s, s.operation))
pure def alwaysWaitingHasDispatchedOperation(s: Interactive): bool = (s.status == Waiting) == (s.operation.status == Dispatched)
```

### Interruption preserves uncertainty and final operation evidence

Pausing, cancellation, recovery and revocation advance the epoch. A dispatched operation becomes unknown because its effect may have run. A prepared operation is cancelled without effect evidence. Revocation remains final. Reconciliation may settle an unknown operation after task cancellation, and it retains the reported evidence.

```quint
type Interruption = Pause | Cancel | Recover | Revoke
pure def canInterrupt(s: Interactive, by: Owner, expectedRevision: int, kind: Interruption): bool = ownedRevision(s, by, expectedRevision) and (not(ended(s)) or kind == Recover or kind == Revoke)
pure def interrupt(s: Interactive, by: Owner, expectedRevision: int, kind: Interruption): Interactive = { ...s, epoch: s.epoch + 1, revision: s.revision + 1, authorized: s.authorized and kind != Revoke, status: if (ended(s)) s.status else if (kind == Cancel) Cancelled else Paused, operation: if (s.operation.status == Dispatched) { ...s.operation, status: Unknown } else cancelledPrepared(s.operation), journal: journalAfterCancellation(s.journal, s.operation) }
pure val operationResultValues = Set(Succeeded, Failed, Unknown)
pure val evidenceRefValues = Set("receipt1", "receipt2", "")
pure def canResolve(s: Interactive, by: Owner, expectedRevision: int, operationResult: OperationStatus, evidenceRef: str, reconcile: bool): bool = ownedRevision(s, by, expectedRevision) and (if (reconcile) s.operation.status == Unknown else s.operation.status == Dispatched and not(ended(s))) and (operationResult == Unknown or ((operationResult == Succeeded or operationResult == Failed) and evidenceRef != ""))
pure def resolve(s: Interactive, by: Owner, expectedRevision: int, operationResult: OperationStatus, evidenceRef: str, reconcile: bool): Interactive = {
  val resolved = { ...s.operation, status: operationResult, evidenceRef: evidenceRef }
  { ...s, operation: resolved, journal: if (operationResult == Unknown) s.journal else s.journal.append(resolved), observed: if (reconcile and operationResult != Unknown) false else s.observed, status: if (s.status == Waiting) { if (operationResult == Unknown) Blocked else Active } else if (s.status == Blocked and operationResult != Unknown) Paused else s.status, revision: s.revision + 1 }
}
pure def canComplete(s: Interactive, by: Owner, expectedRevision: int): bool = ownedRevision(s, by, expectedRevision) and not(ended(s)) and not(unresolved(s.operation))
pure def complete(s: Interactive, by: Owner, expectedRevision: int): Interactive = { ...s, status: Completed, revision: s.revision + 1 }
pure def alwaysRevokedTaskDoesNotRun(s: Interactive): bool = not(s.authorized) implies (s.status != Active and s.status != Waiting)
pure def alwaysEndedHasNoPreparedOrDispatched(s: Interactive): bool = not(ended(s)) or (s.operation.status != Prepared and s.operation.status != Dispatched)
pure def alwaysJournalContainsTerminalEvidence(s: Interactive): bool = s.journal.every(entry => entry.status == OperationCancelled or ((entry.status == Succeeded or entry.status == Failed) and entry.evidenceRef != ""))
pure def stepRevocationIsFinal(before: Interactive, after: Interactive): bool = before.status == Absent or before.authorized or not(after.authorized)
pure def sometimesSuccessfulTask(s: Interactive): bool = s.status == Completed and s.journal.some(entry => entry.status == Succeeded)
pure def sometimesCancelledUnknownOutcome(s: Interactive): bool = s.status == Cancelled and s.operation.status == Unknown
```

### Scope extension and rebinding require fresh observations

Only a trusted host safety decision grants an additional origin. The existing contract permits sixteen lifetime origin grants and retains the most recent sixty-four origin steps in the task view, while the event journal remains complete. Retraction remains available after completion and advances the epoch. Rebinding an active task advances the epoch without changing the user's active status. Wall-clock corrections never move the task's stored time backwards.

```quint
pure def canExtendOrigin(s: Interactive, by: Owner, expectedRevision: int, origin: str, hostChecked: bool): bool = ownedRevision(s, by, expectedRevision) and not(ended(s)) and s.authorized and hostChecked and origin != "" and not(s.origins.contains(origin)) and s.operation.status != Dispatched and s.operation.status != Unknown and s.grantCount < 16
pure def extendOrigin(s: Interactive, by: Owner, expectedRevision: int, origin: str, hostChecked: bool): Interactive = { ...s, grantCount: s.grantCount + 1, originChain: seedOriginChain(s), originJournal: seedOriginJournal(s), origins: s.origins.union(Set(origin)), grantedOrigins: s.grantedOrigins.union(Set(origin)), observed: false, epoch: s.epoch + 1, revision: s.revision + 1, operation: cancelledPrepared(s.operation), journal: journalAfterCancellation(s.journal, s.operation) }
pure def canRetractOrigin(s: Interactive, by: Owner, expectedRevision: int, origin: str): bool = ownedRevision(s, by, expectedRevision) and s.grantedOrigins.contains(origin) and s.origins.contains(origin)
pure def retractOrigin(s: Interactive, by: Owner, expectedRevision: int, origin: str): Interactive = { ...s, origins: s.origins.exclude(Set(origin)), observed: false, epoch: s.epoch + 1, revision: s.revision + 1, status: if (s.operation.status == Dispatched) Paused else s.status, operation: if (s.operation.status == Dispatched) { ...s.operation, status: Unknown } else cancelledPrepared(s.operation), journal: journalAfterCancellation(s.journal, s.operation) }
pure def canRebind(s: Interactive, by: Owner, expectedRevision: int): bool = ownedRevision(s, by, expectedRevision) and s.status == Active and s.authorized and s.operation.status != Dispatched and s.operation.status != Unknown
pure def rebind(s: Interactive, by: Owner, expectedRevision: int): Interactive = { ...s, observed: false, epoch: s.epoch + 1, revision: s.revision + 1, operation: cancelledPrepared(s.operation), journal: journalAfterCancellation(s.journal, s.operation) }
pure def updateClock(s: Interactive, wallNow: int): Interactive = { ...s, now: if (wallNow > s.now) wallNow else s.now }
pure def alwaysTaskCountersAreValid(s: Interactive): bool = s.revision >= 0 and s.epoch >= 0 and s.now >= 0 and s.grantCount >= 0 and s.grantCount <= 16 and s.originChain.length() <= 64
pure def stepClockNeverRegresses(before: Interactive, after: Interactive): bool = after.now >= before.now
```
