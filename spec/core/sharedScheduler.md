# Shared scheduler ownership

`services/task-scheduler.ts` has one timer and one attached tick, with detached database awaits that can outlive adapter or service replacement. This product composes the [timer and process callbacks](./processScheduler.md) with [query and dispatch ownership](./queryDrain.md). It preserves both canonical owners and adds only a lineage link from each real tick to its captured query.

## Story: Replace scheduler storage while process tasks and safely owned queries continue

### Each timer tick queues process work and captures at most one query for its own generation

The timer first queues the current process tasks. When a database adapter is attached and no tick is active, it snapshots dirty registrations, retains busy registrations for a later tick and removes the other visited names. The tick then either owns the newly issued query ticket or completes as an empty tick. A process callback's own settlement and disposal proceed independently. Query completion releases storage ownership, while its tick can still own grouped dispatches, and only the same tick can release its active pointer. A replacement query can dispatch while an older database await is still unresolved; fairness for older work does not impose settlement order.

```quint
import processScheduler as P from "./processScheduler"
import queryDrain as Q from "./queryDrain"
type TickQueryLink = { tick: int, query: int }
type SharedScheduler = { process: P::ProcessScheduler, drain: Q::Drain, links: List[TickQueryLink] }
pure val initial: SharedScheduler = { process: P::initial, drain: Q::initial, links: List() }
pure val noLink: TickQueryLink = { tick: 0, query: 0 }
pure def linkAt(s: SharedScheduler, tickId: int): TickQueryLink = s.links.select(link => link.tick == tickId).nthOr(0, noLink)
pure def activeLink(s: SharedScheduler): TickQueryLink = linkAt(s, s.process.activeTick)
pure def attachedTickMayCapture(s: SharedScheduler): bool = s.process.adapter != "" and s.process.activeTick == 0
pure def canFire(s: SharedScheduler): bool = P::canTick(s.process)
pure def fire(s: SharedScheduler): SharedScheduler = {
  val captures = attachedTickMayCapture(s) and Q::canBeginQuery(s.drain)
  val process = P::tick(s.process)
  val fired = { ...s, process: process }
  if (captures) { ...fired, drain: Q::beginQuery(s.drain), links: s.links.append({ tick: process.activeTick, query: s.drain.nextQuery }) }
  else if (attachedTickMayCapture(s)) { ...fired, process: P::finishTick(process, process.activeTick), drain: if (Q::canClearUnregisteredDirty(s.drain)) Q::clearUnregisteredDirty(s.drain) else s.drain }
  else fired
}
pure def canAdvance(s: SharedScheduler): bool = Q::canAdvancePending(s.drain)
pure def settleLinkedTick(process: P::ProcessScheduler, link: TickQueryLink, drain: Q::Drain): P::ProcessScheduler =
  if (link.tick != 0 and Q::queryFor(drain, link.query).phase == Q::Done and P::canFinishTick(process, link.tick)) P::finishTick(process, link.tick) else process
pure def canAdvanceQuery(s: SharedScheduler, key: int): bool = Q::canAdvanceQuery(s.drain, key)
pure def advanceQuery(s: SharedScheduler, key: int, succeeded: bool, resultRows: List[Q::TaskResult]): SharedScheduler = {
  val drain = Q::advanceQuery(s.drain, key, succeeded, resultRows)
  val link = s.links.select(row => row.query == key).nthOr(0, noLink)
  { ...s, drain: drain, process: settleLinkedTick(s.process, link, drain) }
}
pure def advance(s: SharedScheduler, succeeded: bool, resultRows: List[Q::TaskResult]): SharedScheduler = advanceQuery(s, Q::nextPendingQuery(s.drain).key, succeeded, resultRows)
pure def canRegisterRuntime(s: SharedScheduler, agent: str, service: str): bool = Q::canRegister(s.drain, agent, service)
pure def registerRuntime(s: SharedScheduler, agent: str, service: str): SharedScheduler = { ...s, drain: Q::register(s.drain, agent, service) }
pure def unregisterRuntime(s: SharedScheduler, agent: str, service: str): SharedScheduler = { ...s, drain: Q::unregister(s.drain, agent, service) }
pure def markDirty(s: SharedScheduler, agent: str): SharedScheduler = { ...s, drain: Q::markDirty(s.drain, agent) }
pure def canRegisterProcess(s: SharedScheduler, name: str): bool = P::canRegister(s.process, name)
pure def registerProcess(s: SharedScheduler, name: str): SharedScheduler = { ...s, process: P::register(s.process, name) }
pure def canDisposeProcess(s: SharedScheduler, id: int): bool = P::canDispose(s.process, id)
pure def disposeProcess(s: SharedScheduler, id: int): SharedScheduler = { ...s, process: P::dispose(s.process, id) }
pure def canEnterCallback(s: SharedScheduler, id: int): bool = P::canEnterProcess(s.process, id)
pure def enterCallback(s: SharedScheduler, id: int): SharedScheduler = { ...s, process: P::enterProcess(s.process, id) }
pure def canReturnCallback(s: SharedScheduler, id: int): bool = P::canFinishProcess(s.process, id)
pure def returnCallback(s: SharedScheduler, id: int, succeeded: bool): SharedScheduler = { ...s, process: P::finishProcess(s.process, id, succeeded) }
pure def canAdvanceDisposal(s: SharedScheduler): bool = P::canAdvanceDisposal(s.process)
pure def advanceDisposal(s: SharedScheduler, succeeded: bool): SharedScheduler = { ...s, process: P::advanceDisposal(s.process, succeeded) }
pure val resultRowsValues = Q::resultRowsValues
pure val keyValues = Q::keyValues
pure val agentValues = Q::agentValues
pure val serviceValues = Q::serviceValues
pure val nameValues = P::nameValues
pure val idValues = P::idValues
```

### Adapter replacement and stop retain detached query and process ownership

Starting an adapter advances both generation views and preserves the retained timer state. If the timer already exists for process tasks, starting an adapter rearms all registered runtimes even when no adapter was attached. Handoff transfers pending query ownership to both adapter handles before releasing the old adapter. Full stop detaches the active generation and returns only after its captured storage awaits settle. It keeps the timer alive while process work remains. Detached queries can settle under their own lineage and cannot erase a current replacement tick.

```quint
pure def canAttach(s: SharedScheduler, adapter: str): bool = Q::canStartAdapter(s.drain, adapter)
pure def attach(s: SharedScheduler, adapter: str): SharedScheduler = { ...s, process: P::startAdapter(s.process, adapter), drain: Q::attachAfterTimerState(s.process.timer, s.drain, adapter) }
pure def canHandoff(s: SharedScheduler, oldAdapter: str, replacementAdapter: str): bool = Q::canHandoff(s.drain, oldAdapter, replacementAdapter)
pure def handoff(s: SharedScheduler, oldAdapter: str, replacementAdapter: str): SharedScheduler =
  { ...s, process: if (s.process.adapter == oldAdapter) P::startAdapter(s.process, replacementAdapter) else s.process, drain: Q::handoff(s.drain, oldAdapter, replacementAdapter) }
pure def canRetireAdapter(s: SharedScheduler, adapter: str): bool = adapter != "" and not(s.drain.retiredAdapters.contains(adapter))
pure def retireAdapter(s: SharedScheduler, adapter: str): SharedScheduler =
  { ...s, process: if (s.process.adapter == adapter) P::detachAdapter(s.process) else s.process, drain: Q::retireAdapter(s.drain, adapter) }
pure def canStop(s: SharedScheduler): bool = Q::canStopScheduler(s.drain)
pure def stop(s: SharedScheduler): SharedScheduler = { ...s, process: P::detachAdapter(s.process), drain: Q::stopScheduler(s.drain) }
pure def canReturnStop(s: SharedScheduler): bool = Q::canReturnStop(s.drain)
pure def returnStop(s: SharedScheduler): SharedScheduler = { ...s, drain: Q::returnStop(s.drain) }
pure def canCloseAdapters(s: SharedScheduler): bool = Q::canCloseRetiredAdapters(s.drain)
pure def closeAdapters(s: SharedScheduler): SharedScheduler = { ...s, drain: Q::closeRetiredAdapters(s.drain) }
pure def canCloseServices(s: SharedScheduler): bool = Q::canCloseRetiredServices(s.drain)
pure def closeServices(s: SharedScheduler): SharedScheduler = { ...s, drain: Q::closeRetiredServices(s.drain) }
pure def alwaysAdapterGenerationAgrees(s: SharedScheduler): bool = s.process.adapter == s.drain.activeAdapter and s.process.generation == s.drain.generation
pure def alwaysActiveTickOwnsSameGenerationQuery(s: SharedScheduler): bool = s.process.activeTick == 0 or (activeLink(s).tick == s.process.activeTick and Q::queryFor(s.drain, activeLink(s).query).generation == s.process.generation and Q::queryFor(s.drain, activeLink(s).query).phase != Q::Done and Q::queryFor(s.drain, activeLink(s).query).phase != Q::Missing)
pure def alwaysCapturedQueryOwnsTick(s: SharedScheduler): bool = s.drain.queries.every(query => s.links.some(link => link.query == query.key and s.process.ticks.some(tick => tick.id == link.tick and tick.generation == query.generation and tick.completed == (query.phase == Q::Done))))
pure def alwaysRetiredStorageDrains(s: SharedScheduler): bool = Q::alwaysClosedServicesHaveNoQueries(s.drain) and Q::alwaysClosedAdaptersHaveNoQueries(s.drain) and Q::alwaysStopReceiptDrainedItsSnapshot(s.drain)
pure def stepOldTickCannotDetachReplacement(before: SharedScheduler, via: str, after: SharedScheduler): bool = (via == "advance" or via == "advanceQuery") and before.process.activeTick != 0 and Q::queryFor(after.drain, activeLink(before).query).phase != Q::Done implies after.process.activeTick == before.process.activeTick
pure def sometimesReplacementHasIndependentTick(s: SharedScheduler): bool = s.process.activeTick != 0 and s.drain.queries.some(query => query.generation < s.drain.generation and query.phase == Q::Querying)
pure def sometimesReplacementDispatchesBeforeOldQueryReturns(s: SharedScheduler): bool = Q::sometimesReplacementRunsWhileOldQueryWaits(s.drain)
pure def sometimesProcessTimerSurvivesStop(s: SharedScheduler): bool = s.drain.stopReturned and s.process.adapter == "" and s.process.timer
pure val adapterValues = Q::adapterValues
pure val oldAdapterValues = Q::oldAdapterValues
pure val replacementAdapterValues = Q::replacementAdapterValues
pure val weight_advanceQuery = 5
pure val weight_fire = 4
pure val weight_attach = 3
pure val weight_registerRuntime = 3
```

### Fair timer service captures dirty registrations and releases their owned awaits

Host interval callbacks are assumed to run fairly while the timer is armed. Storage and worker awaits may succeed or fail but eventually settle. These assumptions do not require successful external I/O or successful task consumption.

```quint
pure val fair_fire = "weak"
pure val fair_advance = "weak"
pure val fair_advanceDisposal = "weak"
pure val fair_returnStop = "weak"
pure val fair_closeAdapters = "weak"
pure val fair_closeServices = "weak"
pure def leadsToDirtyRegistrationCaptured(s: SharedScheduler, later: SharedScheduler): bool = Q::leadsToDirtyRegistrationCaptured(s.drain, later.drain)
pure def leadsToQueriesFinish(s: SharedScheduler, later: SharedScheduler): bool = Q::leadsToQueriesFinish(s.drain, later.drain)
pure def leadsToStopReturns(s: SharedScheduler, later: SharedScheduler): bool = Q::leadsToStopReturns(s.drain, later.drain)
pure def leadsToDisposalReturns(s: SharedScheduler, later: SharedScheduler): bool = P::leadsToDisposerReturns(s.process, later.process)
```
