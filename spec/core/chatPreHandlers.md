# Chat pre-handler registry

The source is `packages/core/src/runtime/chat-pre-handler-registry.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. A runtime stores one handler per exact ID. Replacement keeps its insertion slot. Drain captures descending priority order, checks cancellation before and after each awaited handler, and returns the first result object, including an object containing an empty response string.

## Story: Resolve a turn before normal chat generation

As a plugin I can handle a matching turn deterministically. Nonmatching handlers pass through; throwing handlers and cancellation reject the drain without running later handlers.

### A drain owns its ordered snapshot and cancellation signal

```quint
type PreHandler = {id: str, priority: int, reference: int}
type DrainPhase = BeforeHandler | WaitingHandler | DrainSucceeded | DrainEmpty | DrainFailed | DrainAborted
type PreDrain = {id: int, snapshot: List[PreHandler], cursor: int, phase: DrainPhase, aborted: bool, text: str, errorId: str}
type PreHandlers = {registry: List[PreHandler], drains: List[PreDrain]}
pure val initial: PreHandlers = {registry: List(), drains: List()}
pure val handlerValues = Set({id: "first", priority: 0, reference: 1}, {id: "second", priority: 1, reference: 2}, {id: "first", priority: 2, reference: 3})
pure val idValues = Set("first", "second")
pure val drainIdValues = Set(1, 2)
pure val textValues = Set("", "final response")
pure val errorIdValues = Set("handler error")
pure val noDrain: PreDrain = {id: 0, snapshot: List(), cursor: 0, phase: DrainEmpty, aborted: false, text: "", errorId: ""}
pure val emptyHandlers: List[PreHandler] = List()
pure def preDrain(s: PreHandlers, drainId: int): PreDrain = s.drains.select(d => d.id == drainId).nthOr(0, noDrain)
pure def insertPriority(handlers: List[PreHandler], handler: PreHandler): List[PreHandler] = handlers.select(h => h.priority >= handler.priority).append(handler).concat(handlers.select(h => h.priority < handler.priority))
pure def canRegister(s: PreHandlers, handler: PreHandler): bool = handler.reference > 0
pure def register(s: PreHandlers, handler: PreHandler): PreHandlers = { ...s, registry: if (s.registry.some(h => h.id == handler.id)) s.registry.listMap(h => if (h.id == handler.id) handler else h) else s.registry.append(handler) }
pure def unregister(s: PreHandlers, id: str): PreHandlers = { ...s, registry: s.registry.select(h => h.id != id) }
pure def canBeginDrain(s: PreHandlers, drainId: int): bool = drainId > 0 and not(s.drains.some(d => d.id == drainId))
pure def beginDrain(s: PreHandlers, drainId: int): PreHandlers = { ...s, drains: s.drains.append({id: drainId, snapshot: s.registry.foldl(emptyHandlers, (acc, handler) => insertPriority(acc, handler)), cursor: 0, phase: if (s.registry.length() == 0) DrainEmpty else BeforeHandler, aborted: false, text: "", errorId: ""}) }
pure def canAbortDrain(s: PreHandlers, drainId: int): bool = preDrain(s, drainId).phase == BeforeHandler or preDrain(s, drainId).phase == WaitingHandler
pure def abortDrain(s: PreHandlers, drainId: int): PreHandlers = { ...s, drains: s.drains.listMap(d => if (d.id == drainId) { ...d, aborted: true } else d) }
pure def canStartHandler(s: PreHandlers, drainId: int): bool = preDrain(s, drainId).phase == BeforeHandler
pure def startHandler(s: PreHandlers, drainId: int): PreHandlers = { ...s, drains: s.drains.listMap(d => if (d.id == drainId) { ...d, phase: if (d.aborted) DrainAborted else WaitingHandler } else d) }
pure def canReturnHandler(s: PreHandlers, drainId: int, hasResult: bool, text: str): bool = preDrain(s, drainId).phase == WaitingHandler
pure def returnHandler(s: PreHandlers, drainId: int, hasResult: bool, text: str): PreHandlers = { ...s, drains: s.drains.listMap(d => if (d.id == drainId) { ...d, cursor: d.cursor + 1, text: if (hasResult and not(d.aborted)) text else "", phase: if (d.aborted) DrainAborted else if (hasResult) DrainSucceeded else if (d.cursor + 1 == d.snapshot.length()) DrainEmpty else BeforeHandler } else d) }
pure def canRejectHandler(s: PreHandlers, drainId: int, errorId: str): bool = preDrain(s, drainId).phase == WaitingHandler
pure def rejectHandler(s: PreHandlers, drainId: int, errorId: str): PreHandlers = { ...s, drains: s.drains.listMap(d => if (d.id == drainId) { ...d, phase: DrainFailed, errorId: errorId } else d) }
pure def alwaysDrainBounds(s: PreHandlers): bool = s.drains.every(d => d.cursor >= 0 and d.cursor <= d.snapshot.length())
pure def alwaysSuccessSurvivesPostAwaitCheck(s: PreHandlers): bool = s.drains.every(d => d.phase == DrainSucceeded implies not(d.aborted))
pure def stepSnapshotsStable(before: PreHandlers, after: PreHandlers): bool = before.drains.every(d => after.drains.some(other => other.id == d.id and other.snapshot == d.snapshot))
pure def sometimesEmptyTextResultWins(s: PreHandlers): bool = s.drains.some(d => d.phase == DrainSucceeded and d.text == "")
pure def sometimesCancellationAfterAwait(s: PreHandlers): bool = s.drains.some(d => d.phase == DrainAborted and d.cursor > 0)
```
