# Scheduler query ownership across replacement

The baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`, `packages/core/src/services/task-scheduler.ts`, and `TaskScheduler{,QueryDrain}.qnt`. Query ownership lasts until the actual adapter await settles. Registration identity controls dispatch separately. A handoff records both adapter handles against pending queries. The machine supplies fresh monotonic query tickets to represent distinct source promise identities and preserves multi-agent batch ordering across each worker await.

## Story: Replace services without dispatching stale results or closing active storage

As a host, I can replace a service or adapter while old queries drain. Old results cannot run a replacement registration. Closing an adapter or service waits for every query that actually owns it. A newer scheduler generation proceeds while old generations settle.

### Queries capture every selected registration and their adapter ownership

Each tick visits dirty agents in the order first marked. It preserves busy agents for the next tick and removes every other visited dirty name, including names with no registration. Replacing a map entry keeps its registration order but allocates a distinct registration identity.

```quint
type QueryPhase = Missing | Querying | Ready | Running | Done
type Registration = { agent: str, service: str, identity: int }
type TaskResult = { taskId: str, agent: str }
type TaskGroup = { registered: Registration, tasks: List[TaskResult] }
type Query = { key: int, generation: int, captured: List[Registration], adapters: Set[str], phase: QueryPhase, remaining: List[TaskGroup], running: TaskGroup }
type Drain = { generation: int, nextRegistration: int, nextQuery: int, activeAdapter: str, registry: List[Registration], queries: List[Query], dirtyAgents: List[str], busyServices: Set[str], retiredServices: Set[str], closedServices: Set[str], retiredAdapters: Set[str], closedAdapters: Set[str], stopWaiting: List[int], stopRequested: bool, stopReturned: bool, scopeError: bool, dispatches: int, lastDispatched: Registration, lastDispatchGeneration: int }
pure val initial: Drain = { generation: 0, nextRegistration: 1, nextQuery: 1, activeAdapter: "", registry: List(), queries: List(), dirtyAgents: List(), busyServices: Set(), retiredServices: Set(), closedServices: Set(), retiredAdapters: Set(), closedAdapters: Set(), stopWaiting: List(), stopRequested: false, stopReturned: false, scopeError: false, dispatches: 0, lastDispatched: { agent: "", service: "", identity: 0 }, lastDispatchGeneration: 0 }
pure val agentValues = Set("agent1", "agent2")
pure val serviceValues = Set("service1", "service2", "replacement")
pure val adapterValues = Set("adapter1", "adapter2")
pure val oldAdapterValues = adapterValues
pure val replacementAdapterValues = adapterValues
pure val keyValues = Set(1, 2, 3, 4)
pure val firstAgentTask: TaskResult = { taskId: "task1", agent: "agent1" }
pure val secondAgentTask: TaskResult = { taskId: "task2", agent: "agent2" }
pure val resultRowsValues: Set[List[TaskResult]] = Set(List(), List(firstAgentTask), List(secondAgentTask), List(firstAgentTask, secondAgentTask), List(secondAgentTask, firstAgentTask), List(firstAgentTask, secondAgentTask, { ...firstAgentTask, taskId: "task3" }), List({ taskId: "unowned", agent: "unknown" }))
pure val absentRegistration: Registration = { agent: "", service: "", identity: 0 }
pure val absentTaskGroup: TaskGroup = { registered: absentRegistration, tasks: List() }
pure val absentQuery: Query = { key: 0, generation: 0, captured: List(), adapters: Set(), phase: Missing, remaining: List(), running: absentTaskGroup }
pure def registrationFor(s: Drain, agent: str): Registration = s.registry.select(entry => entry.agent == agent).nthOr(0, absentRegistration)
pure def queryFor(s: Drain, key: int): Query = s.queries.nthOr(key - 1, absentQuery)
pure def addDirty(dirty: List[str], agent: str): List[str] = if (dirty.includes(agent)) dirty else dirty.append(agent)
pure def rearmRegistry(s: Drain): List[str] = s.registry.foldl(s.dirtyAgents, (dirty, entry) => addDirty(dirty, entry.agent))
pure def canStartAdapter(s: Drain, adapter: str): bool = adapter != "" and not(s.retiredAdapters.contains(adapter)) and not(s.closedAdapters.contains(adapter)) and s.activeAdapter != adapter
pure def attachAfterTimerState(hadTimer: bool, s: Drain, adapter: str): Drain = { ...s, activeAdapter: adapter, generation: s.generation + 1, dirtyAgents: if (hadTimer) rearmRegistry(s) else s.dirtyAgents }
pure def startAdapter(s: Drain, adapter: str): Drain = attachAfterTimerState(s.activeAdapter != "", s, adapter)
pure def canRegister(s: Drain, agent: str, service: str): bool = agent != "" and service != "" and not(s.retiredServices.contains(service)) and not(s.closedServices.contains(service))
pure def register(s: Drain, agent: str, service: str): Drain = {
  val registered = { agent: agent, service: service, identity: s.nextRegistration }
  { ...s, registry: if (registrationFor(s, agent).agent == "") s.registry.append(registered) else s.registry.listMap(entry => if (entry.agent == agent) registered else entry), nextRegistration: s.nextRegistration + 1, dirtyAgents: addDirty(s.dirtyAgents, agent) }
}
pure def eligibleAgent(s: Drain, agent: str): bool = {
  val registered = registrationFor(s, agent)
  registered.agent == agent and agent != "" and not(s.busyServices.contains(registered.service)) and not(s.retiredServices.contains(registered.service))
}
pure def queryRegistrations(s: Drain): List[Registration] = s.dirtyAgents.select(agent => eligibleAgent(s, agent)).listMap(agent => registrationFor(s, agent))
pure def dirtyToPreserve(s: Drain): List[str] = s.dirtyAgents.select(agent => registrationFor(s, agent).agent != "" and s.busyServices.contains(registrationFor(s, agent).service))
pure def canBeginQuery(s: Drain): bool = s.activeAdapter != "" and not(s.queries.some(query => query.generation == s.generation and query.phase != Done)) and queryRegistrations(s).length() > 0
pure def beginQuery(s: Drain): Drain = {
  val captured = queryRegistrations(s)
  { ...s, nextQuery: s.nextQuery + 1, queries: s.queries.append({ key: s.nextQuery, generation: s.generation, captured: captured, adapters: Set(s.activeAdapter), phase: Querying, remaining: List(), running: absentTaskGroup }), dirtyAgents: dirtyToPreserve(s) }
}
pure def canClearUnregisteredDirty(s: Drain): bool = s.activeAdapter != "" and s.dirtyAgents.length() > dirtyToPreserve(s).length() and queryRegistrations(s).length() == 0 and not(s.queries.some(query => query.generation == s.generation and query.phase != Done))
pure def clearUnregisteredDirty(s: Drain): Drain = { ...s, dirtyAgents: dirtyToPreserve(s) }
```

### Each result group rechecks registration identity after the prior worker settles

Unknown result agents are rejected and recorded as a scope error. In-scope rows group by first returned agent occurrence, preserving exact order within each group. Grouping and dispatch both recheck registration identity; rearm after the worker joins applies only to that dispatched registration if still current in the same generation. Query failure rearms current captured registrations. An unregister from an old service leaves its replacement in the registry.

```quint
pure def capturedRegistration(query: Query, agent: str): Registration = query.captured.select(entry => entry.agent == agent).nthOr(0, absentRegistration)
pure def currentRegistration(s: Drain, generation: int, captured: Registration): bool = captured.agent != "" and generation == s.generation and registrationFor(s, captured.agent) == captured and not(s.retiredServices.contains(captured.service)) and not(s.closedServices.contains(captured.service))
pure def appendGroup(groups: List[TaskGroup], registration: Registration, resultRow: TaskResult): List[TaskGroup] =
  if (groups.some(group => group.registered.agent == registration.agent)) groups.listMap(group => if (group.registered.agent == registration.agent) { ...group, tasks: group.tasks.append(resultRow) } else group)
  else groups.append({ registered: registration, tasks: List(resultRow) })
pure def groupResult(s: Drain, query: Query, groups: List[TaskGroup], resultRow: TaskResult): List[TaskGroup] = {
  val own = capturedRegistration(query, resultRow.agent)
  if (currentRegistration(s, query.generation, own)) appendGroup(groups, own, resultRow) else groups
}
pure def canFinishQuery(s: Drain, key: int): bool = queryFor(s, key).phase == Querying
pure def finishQuery(s: Drain, key: int, succeeded: bool, resultRows: List[TaskResult]): Drain = {
  val query = queryFor(s, key)
  val remaining = if (succeeded and query.generation == s.generation) resultRows.foldl(List(), (groups, resultRow) => groupResult(s, query, groups, resultRow)) else List()
  val rearmed = if (succeeded or query.generation != s.generation) s.dirtyAgents else query.captured.select(entry => currentRegistration(s, query.generation, entry)).foldl(s.dirtyAgents, (agents, entry) => addDirty(agents, entry.agent))
  { ...s, queries: s.queries.listMap(entry => if (entry.key == key) { ...entry, phase: if (remaining.length() > 0) Ready else Done, remaining: remaining } else entry), dirtyAgents: rearmed, scopeError: s.scopeError or (succeeded and query.generation == s.generation and resultRows.some(resultRow => resultRow.agent == "" or not(query.captured.some(entry => entry.agent == resultRow.agent)))) }
}
pure def canDispatchNext(s: Drain, key: int): bool = queryFor(s, key).phase == Ready and queryFor(s, key).remaining.length() > 0
pure def dispatchNext(s: Drain, key: int): Drain = {
  val query = queryFor(s, key)
  val group = query.remaining.nthOr(0, absentTaskGroup)
  val entry = group.registered
  val accepted = currentRegistration(s, query.generation, entry) and not(s.busyServices.contains(entry.service))
  val remaining = if (query.remaining.length() > 0) query.remaining.tail() else List()
  { ...s, dispatches: if (accepted) s.dispatches + 1 else s.dispatches, lastDispatched: if (accepted) entry else s.lastDispatched, lastDispatchGeneration: if (accepted) s.generation else s.lastDispatchGeneration, busyServices: if (accepted) s.busyServices.union(Set(entry.service)) else s.busyServices, queries: s.queries.listMap(queuedQuery => if (queuedQuery.key == key) { ...queuedQuery, remaining: remaining, phase: if (accepted) Running else if (remaining.length() > 0) Ready else Done, running: if (accepted) group else absentTaskGroup } else queuedQuery) }
}
pure def canFinishRun(s: Drain, key: int): bool = queryFor(s, key).phase == Running
pure def finishRun(s: Drain, key: int): Drain = {
  val query = queryFor(s, key)
  val own = query.running.registered
  val rearmed = if (currentRegistration(s, query.generation, own)) addDirty(s.dirtyAgents, own.agent) else s.dirtyAgents
  { ...s, busyServices: s.busyServices.exclude(Set(own.service)), dirtyAgents: rearmed, queries: s.queries.listMap(queuedQuery => if (queuedQuery.key == key) { ...queuedQuery, phase: if (queuedQuery.remaining.length() > 0) Ready else Done, running: absentTaskGroup } else queuedQuery) }
}
pure def unregister(s: Drain, agent: str, service: str): Drain = { ...s, registry: s.registry.select(entry => entry.agent != agent or entry.service != service), retiredServices: s.retiredServices.union(Set(service)), dirtyAgents: if (registrationFor(s, agent).service == service) s.dirtyAgents.select(dirty => dirty != agent) else s.dirtyAgents }
pure def markDirty(s: Drain, agent: str): Drain = { ...s, dirtyAgents: addDirty(s.dirtyAgents, agent) }
pure def pendingForService(s: Drain, service: str): bool = s.queries.some(query => query.phase == Querying and query.captured.some(entry => entry.service == service))
pure def pendingForAdapter(s: Drain, adapter: str): bool = s.queries.some(query => query.phase == Querying and query.adapters.contains(adapter))
pure def canCloseService(s: Drain, service: str): bool = s.retiredServices.contains(service) and not(pendingForService(s, service)) and not(s.busyServices.contains(service))
pure def closeService(s: Drain, service: str): Drain = { ...s, closedServices: s.closedServices.union(Set(service)) }
pure def alwaysClosedServicesHaveNoQueries(s: Drain): bool = s.closedServices.forall(service => not(pendingForService(s, service)) and not(s.busyServices.contains(service)))
```

### Adapter handoff keeps both handles owned until every captured query settles

Stopping captures all outstanding queries before detaching generation. The stop receipt waits for those queries while later generations retain independent ownership.

```quint
pure def canHandoff(s: Drain, oldAdapter: str, replacementAdapter: str): bool = oldAdapter != "" and oldAdapter != replacementAdapter and replacementAdapter != "" and not(s.retiredAdapters.contains(replacementAdapter)) and not(s.closedAdapters.contains(replacementAdapter))
pure def handoff(s: Drain, oldAdapter: str, replacementAdapter: str): Drain = { ...s, activeAdapter: if (s.activeAdapter == oldAdapter) replacementAdapter else s.activeAdapter, generation: if (s.activeAdapter == oldAdapter) s.generation + 1 else s.generation, dirtyAgents: if (s.activeAdapter == oldAdapter) rearmRegistry(s) else s.dirtyAgents, retiredAdapters: s.retiredAdapters.union(Set(oldAdapter)), queries: s.queries.listMap(query => if (query.phase == Querying and query.adapters.contains(oldAdapter)) { ...query, adapters: query.adapters.union(Set(replacementAdapter)) } else query) }
pure def retireAdapter(s: Drain, adapter: str): Drain = { ...s, retiredAdapters: s.retiredAdapters.union(Set(adapter)), activeAdapter: if (s.activeAdapter == adapter) "" else s.activeAdapter, registry: if (s.activeAdapter == adapter) List() else s.registry, dirtyAgents: if (s.activeAdapter == adapter) List() else s.dirtyAgents, generation: if (s.activeAdapter == adapter) s.generation + 1 else s.generation }
pure def canCloseAdapter(s: Drain, adapter: str): bool = s.retiredAdapters.contains(adapter) and not(pendingForAdapter(s, adapter))
pure def closeAdapter(s: Drain, adapter: str): Drain = { ...s, closedAdapters: s.closedAdapters.union(Set(adapter)) }
pure def canStopScheduler(s: Drain): bool = not(s.stopRequested) or s.stopReturned
pure def stopScheduler(s: Drain): Drain = { ...s, generation: s.generation + 1, activeAdapter: "", registry: List(), dirtyAgents: List(), stopRequested: true, stopReturned: false, stopWaiting: s.queries.select(query => query.phase == Querying).listMap(query => query.key) }
pure def canReturnStop(s: Drain): bool = s.stopRequested and not(s.stopReturned) and s.queries.every(query => not(s.stopWaiting.includes(query.key)) or query.phase != Querying)
pure def returnStop(s: Drain): Drain = { ...s, stopReturned: true }
pure def alwaysClosedAdaptersHaveNoQueries(s: Drain): bool = s.closedAdapters.forall(adapter => not(pendingForAdapter(s, adapter)))
pure def alwaysStopReceiptDrainedItsSnapshot(s: Drain): bool = s.stopReturned implies s.queries.every(query => not(s.stopWaiting.includes(query.key)) or query.phase != Querying)
pure def alwaysActiveAdapterIsOpen(s: Drain): bool = s.activeAdapter == "" or (not(s.closedAdapters.contains(s.activeAdapter)) and not(s.retiredAdapters.contains(s.activeAdapter)))
pure def stepDispatchUsesCurrentRegistration(before: Drain, after: Drain): bool = after.dispatches == before.dispatches or (after.dispatches == before.dispatches + 1 and registrationFor(before, after.lastDispatched.agent) == after.lastDispatched and before.generation == after.lastDispatchGeneration and not(before.retiredServices.contains(after.lastDispatched.service)))
pure def stepTakenClearsDirty(before: Drain, via: str, after: Drain): bool = via == "beginQuery" implies queryFor(after, before.nextQuery).captured.every(entry => not(after.dirtyAgents.includes(entry.agent)))
pure def alwaysRunningServiceOwnsBusySlot(s: Drain): bool = s.queries.every(query => query.phase != Running or s.busyServices.contains(query.running.registered.service))
pure def alwaysRunningServicesAreUnique(s: Drain): bool = s.queries.every(query => query.phase != Running or s.queries.every(other => other.phase != Running or other.running.registered.service != query.running.registered.service or other.key == query.key))
pure def alwaysQueryKeysUnique(s: Drain): bool = s.nextQuery == s.queries.length() + 1 and s.queries.every(query => query.key > 0 and query.key < s.nextQuery and s.queries.nthOr(query.key - 1, absentQuery).key == query.key and s.queries.select(other => other.key == query.key).length() == 1)
pure def alwaysDirtyKeysUnique(s: Drain): bool = s.dirtyAgents.every(agent => s.dirtyAgents.select(other => other == agent).length() == 1)
pure def alwaysCloseRequiresRetirement(s: Drain): bool = s.closedServices.subseteq(s.retiredServices) and s.closedAdapters.subseteq(s.retiredAdapters)
pure def alwaysStopSnapshotUsesIssuedKeys(s: Drain): bool = s.stopWaiting.every(key => key > 0 and key < s.nextQuery)
pure def alwaysReadyHasDispatch(s: Drain): bool = s.queries.every(query => query.phase == Ready implies query.remaining.length() > 0)
pure def sometimesReplacementRunsWhileOldQueryWaits(s: Drain): bool = s.queries.some(query => query.phase == Querying and query.generation < s.generation) and s.queries.some(query => query.phase == Running and query.generation == s.generation)
pure def sometimesClosedAfterHandoff(s: Drain): bool = s.closedAdapters.contains("adapter1") and s.activeAdapter == "adapter2"
```

### Fair settlement drains every captured query and closes retired owners

Pending external reads and worker passes are assumed to return, including
failures. An enabled close requires every actual query/worker owner to release
the handle. Fair progress selects captured queries by real insertion order,
and closes eligible retired handles without relying on sampled identities.
The host still owns poll timing and the liveness of any task returned repeatedly
by an external store. Fair ticks eventually capture each attached dirty
registration or observe its detachment. Capturing a dirty registration does
not guarantee a worker consumes its row.

```quint
pure def nextPendingQuery(s: Drain): Query = s.queries.select(query => query.phase == Querying or query.phase == Ready or query.phase == Running).nthOr(0, absentQuery)
pure def canAdvancePending(s: Drain): bool = nextPendingQuery(s).key != 0
pure def advancePending(s: Drain, succeeded: bool, resultRows: List[TaskResult]): Drain = {
  val query = nextPendingQuery(s)
  if (query.phase == Querying) finishQuery(s, query.key, succeeded, resultRows) else if (query.phase == Ready) dispatchNext(s, query.key) else finishRun(s, query.key)
}
pure def canCloseRetiredServices(s: Drain): bool = s.retiredServices.exists(service => not(s.closedServices.contains(service)) and canCloseService(s, service))
pure def closeRetiredServices(s: Drain): Drain = { ...s, closedServices: s.closedServices.union(s.retiredServices.filter(service => canCloseService(s, service))) }
pure def canCloseRetiredAdapters(s: Drain): bool = s.retiredAdapters.exists(adapter => not(s.closedAdapters.contains(adapter)) and canCloseAdapter(s, adapter))
pure def closeRetiredAdapters(s: Drain): Drain = { ...s, closedAdapters: s.closedAdapters.union(s.retiredAdapters.filter(adapter => canCloseAdapter(s, adapter))) }
pure val fair_advancePending = "weak"
pure val fair_beginQuery = "weak"
pure val fair_clearUnregisteredDirty = "weak"
pure val fair_closeRetiredServices = "weak"
pure val fair_closeRetiredAdapters = "weak"
pure val fair_returnStop = "weak"
pure def leadsToStopReturns(s: Drain, later: Drain): bool = s.stopRequested and not(s.stopReturned) implies later.stopReturned
pure def leadsToQueriesFinish(s: Drain, later: Drain): bool = s.queries.every(query => queryFor(later, query.key).phase == Done)
pure def leadsToDirtyRegistrationCaptured(s: Drain, later: Drain): bool = s.activeAdapter != "" implies s.registry.every(entry => not(s.dirtyAgents.includes(entry.agent)) or s.retiredServices.contains(entry.service) or later.activeAdapter == "" or later.retiredServices.contains(entry.service) or registrationFor(later, entry.agent) != entry or later.queries.some(query => query.key >= s.nextQuery and query.captured.includes(entry)))
pure def leadsToRetiredServicesClose(s: Drain, later: Drain): bool = s.retiredServices.subseteq(later.closedServices)
pure def leadsToRetiredAdaptersClose(s: Drain, later: Drain): bool = s.retiredAdapters.subseteq(later.closedAdapters)
pure val weight_beginQuery = 5
pure val weight_finishQuery = 5
pure val weight_dispatchNext = 5
pure val weight_startAdapter = 3
pure val weight_register = 3
```
