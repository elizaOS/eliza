# Terminal run ownership

Sources are `packages/core/src/runtime/run-terminal-owner.ts`, `types/effects.ts` and `services/post-delivery-task-tracker.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. One owner retains every pending child promise, the merged normalized receipt records, the first complete terminal request and its task identity. Each delivery-dependent child captures its own room-settlement promise identity, so later room-boundary replacement cannot retarget it. New child tracking after request reports `RUN_TASK_AFTER_TERMINAL` and returns a fulfilled no-op without invoking the child.

## Story: Finalize one run after all admitted child work

As a host I preserve the first terminal request's complete outcome and error, wait for every captured child and terminal subscriber, and emit one RUN_ENDED event. A schedule failure clears the request so a caller may retry. Work failure is diagnosed and the child promise then fulfills; it does not overwrite the terminal outcome.

### Every child and effect retains identity until the terminal snapshot is captured

Discovered by the proof: work and delivery promise identities must stay unique,
and a delivery-dependent child can run or finish only after its captured promise
succeeds. These facts prevent an unrelated duplicate identity or an impossible
pending-delivery state from invalidating a settled child.

```quint
import receipts as R from "./receipts"
type Delivery = DeliveryHeld | DeliverySaved | DeliveryFailed
type OwnedWorkPhase = WorkScheduled | WorkWaitingDelivery | WorkRunning | WorkDone | WorkSkipped
type DeliveryPromise = {id: int, state: Delivery}
type OwnedWork = {id: int, label: str, afterDelivery: bool, deliveryId: int, phase: OwnedWorkPhase, active: bool, errorId: str}
type TerminalOutcome = NoTerminal | CompletedTerminal | FailedTerminal
type EffectEntry = {id: str, receipt: R::Receipt, payload: str}
type TerminalPayload = {resultKind: TerminalOutcome, completeOutcome: str, errorId: str, effects: List[EffectEntry]}
type TerminalTaskPhase = NoTask | SchedulingTask | WaitingTask | DrainingTask | EmittingTask | ReturnedTask
type Subscriber = {id: int, result: int}
type TerminalState = {deliveries: List[DeliveryPromise], works: List[OwnedWork], effects: List[EffectEntry], request: TerminalPayload, phase: TerminalTaskPhase, taskId: int, capturedWork: List[int], subscribers: List[Subscriber], firstFailure: int, joins: List[int], refusedTracks: int, scheduleError: str}
pure val emptyPayload: TerminalPayload = {resultKind: NoTerminal, completeOutcome: "", errorId: "", effects: List()}
pure val initial: TerminalState = {deliveries: List(), works: List(), effects: List(), request: emptyPayload, phase: NoTask, taskId: 0, capturedWork: List(), subscribers: List(), firstFailure: 0, joins: List(), refusedTracks: 0, scheduleError: ""}
pure val workIdValues = Set(1, 2, 3)
pure val deliveryIdValues = Set(0, 1, 2)
pure val subscriberValues = Set(1, 2, 3)
pure val taskIdValues = Set(0, 1, 2)
pure val labelValues = Set("trajectory", "evaluation")
pure val completeOutcomeValues = Set("complete outcome", "different outcome")
pure val errorIdValues = Set("", "original-error", "schedule-error")
pure val effectsValues = Set(List(), List({id: "receipt-a", receipt: {receiptKind: R::Applied, durable: true, providerAccepted: false, hasKey: true, replayed: false, reverted: false}, payload: "complete receipt"}))
pure def compatibleEffects(old: List[EffectEntry], incoming: List[EffectEntry]): bool = incoming.every(receipt => incoming.select(other => other.id == receipt.id).length() == 1 and old.every(other => other.id != receipt.id or other == receipt))
pure def mergedEffects(old: List[EffectEntry], incoming: List[EffectEntry]): List[EffectEntry] = old.concat(incoming.select(receipt => not(old.some(other => other.id == receipt.id))))
pure def canObserveReceipt(s: TerminalState, effects: List[EffectEntry]): bool = compatibleEffects(s.effects, effects)
pure def observeReceipt(s: TerminalState, effects: List[EffectEntry]): TerminalState = { ...s, effects: mergedEffects(s.effects, effects) }
pure val absentDelivery: DeliveryPromise = {id: 0, state: DeliveryHeld}
pure def deliveryState(s: TerminalState, deliveryId: int): Delivery = s.deliveries.select(d => d.id == deliveryId).nthOr(0, absentDelivery).state
pure def canCaptureDelivery(s: TerminalState, deliveryId: int, deliveryPhase: Delivery): bool = deliveryId > 0 and not(s.deliveries.some(d => d.id == deliveryId))
pure def captureDelivery(s: TerminalState, deliveryId: int, deliveryPhase: Delivery): TerminalState = { ...s, deliveries: s.deliveries.append({id: deliveryId, state: deliveryPhase}) }
pure def canAdmitTerminalWork(s: TerminalState, workId: int, label: str, afterDelivery: bool, deliveryId: int): bool = s.phase == NoTask and workId > 0 and not(s.works.some(w => w.id == workId)) and (not(afterDelivery) or s.deliveries.some(d => d.id == deliveryId))
pure def admitTerminalWork(s: TerminalState, workId: int, label: str, afterDelivery: bool, deliveryId: int): TerminalState = { ...s, works: s.works.append({id: workId, label: label, afterDelivery: afterDelivery, deliveryId: if (afterDelivery) deliveryId else 0, phase: WorkScheduled, active: true, errorId: ""}) }
pure def canRefuseLateWork(s: TerminalState, label: str): bool = s.phase != NoTask
pure def refuseLateWork(s: TerminalState, label: str): TerminalState = { ...s, refusedTracks: s.refusedTracks + 1 }
pure def canStartOwnedWork(s: TerminalState, workId: int): bool = s.works.some(w => w.id == workId and w.phase == WorkScheduled)
pure def startOwnedWork(s: TerminalState, workId: int): TerminalState = { ...s, works: s.works.listMap(w => if (w.id != workId) w else { ...w, phase: if (not(w.afterDelivery) or deliveryState(s, w.deliveryId) == DeliverySaved) WorkRunning else if (deliveryState(s, w.deliveryId) == DeliveryHeld) WorkWaitingDelivery else WorkSkipped, errorId: if (w.afterDelivery and deliveryState(s, w.deliveryId) == DeliveryFailed) "POST_DELIVERY_NOT_SETTLED" else "" }) }
pure def canFinishDelivery(s: TerminalState, deliveryId: int, saved: bool): bool = s.deliveries.some(d => d.id == deliveryId and d.state == DeliveryHeld)
pure def finishDelivery(s: TerminalState, deliveryId: int, saved: bool): TerminalState = { ...s, deliveries: s.deliveries.listMap(d => if (d.id == deliveryId) { ...d, state: if (saved) DeliverySaved else DeliveryFailed } else d), works: s.works.listMap(w => if (w.phase == WorkWaitingDelivery and w.deliveryId == deliveryId) { ...w, phase: if (saved) WorkRunning else WorkSkipped, errorId: if (saved) "" else "POST_DELIVERY_NOT_SETTLED" } else w) }
pure def canFinishOwnedWork(s: TerminalState, workId: int, errorId: str): bool = s.works.some(w => w.id == workId and w.phase == WorkRunning)
pure def finishOwnedWork(s: TerminalState, workId: int, errorId: str): TerminalState = { ...s, works: s.works.listMap(w => if (w.id == workId) { ...w, phase: WorkDone, errorId: errorId } else w) }
pure def canRemoveOwnedWork(s: TerminalState, workId: int): bool = s.works.some(w => w.id == workId and w.active and (w.phase == WorkDone or w.phase == WorkSkipped))
pure def removeOwnedWork(s: TerminalState, workId: int): TerminalState = { ...s, works: s.works.listMap(w => if (w.id == workId) { ...w, active: false } else w) }
pure def alwaysFailedDeliverySkipsWork(s: TerminalState): bool = s.works.every(w => w.afterDelivery and deliveryState(s, w.deliveryId) == DeliveryFailed implies w.phase != WorkRunning and w.phase != WorkDone)
pure def alwaysWorkDeliveryCaptured(s: TerminalState): bool = s.works.every(w => not(w.afterDelivery) or s.deliveries.some(d => d.id == w.deliveryId))
pure def alwaysWorkIdentitiesUnique(s: TerminalState): bool = s.works.every(w => s.works.select(other => other.id == w.id).length() == 1)
pure def alwaysDeliveryIdentitiesUnique(s: TerminalState): bool = s.deliveries.every(d => s.deliveries.select(other => other.id == d.id).length() == 1)
pure def alwaysDeliveryGatesWork(s: TerminalState): bool = s.works.every(w => w.afterDelivery and (w.phase == WorkRunning or w.phase == WorkDone) implies deliveryState(s, w.deliveryId) == DeliverySaved)
pure def alwaysEffectIdsUnique(s: TerminalState): bool = s.effects.every(receipt => s.effects.select(other => other.id == receipt.id).length() == 1)
```

### The first request freezes complete outcome evidence and owns one scheduled task

A reentrant request while the task is being scheduled returns a fulfilled placeholder because the source has not yet assigned terminalTask. Later requests share the published task. Schedule failure permits a new first request; a successful schedule fixes the snapshot through terminal completion. Recording a later action result changes the live effect set but never that captured snapshot.

```quint
pure def canRequestTerminal(s: TerminalState, resultKind: TerminalOutcome, completeOutcome: str, errorId: str, effects: List[EffectEntry]): bool = s.phase == NoTask and resultKind != NoTerminal and compatibleEffects(s.effects, effects)
pure def requestTerminal(s: TerminalState, resultKind: TerminalOutcome, completeOutcome: str, errorId: str, effects: List[EffectEntry]): TerminalState = { ...s, phase: SchedulingTask, request: {resultKind: resultKind, completeOutcome: completeOutcome, errorId: errorId, effects: mergedEffects(s.effects, effects)}, scheduleError: "" }
pure def canJoinTerminal(s: TerminalState): bool = s.phase != NoTask
pure def joinTerminal(s: TerminalState): TerminalState = { ...s, joins: s.joins.append(s.taskId) }
pure def canScheduleTerminal(s: TerminalState, taskId: int, ok: bool, errorId: str): bool = s.phase == SchedulingTask and (not(ok) or taskId > 0)
pure def scheduleTerminal(s: TerminalState, taskId: int, ok: bool, errorId: str): TerminalState = { ...s, phase: if (ok) WaitingTask else NoTask, taskId: if (ok) taskId else 0, request: if (ok) s.request else emptyPayload, scheduleError: if (ok) "" else errorId }
pure def canBeginTerminalDrain(s: TerminalState): bool = s.phase == WaitingTask
pure def beginTerminalDrain(s: TerminalState): TerminalState = { ...s, phase: DrainingTask, capturedWork: s.works.select(w => w.active).listMap(w => w.id) }
pure def stepFirstTerminalRequestStays(before: TerminalState, via: str, after: TerminalState): bool = before.phase != NoTask and via != "scheduleTerminal" implies after.request == before.request
pure def sometimesFailureRetainsReceipt(s: TerminalState): bool = s.request.resultKind == FailedTerminal and s.request.effects.length() > 0 and s.works.some(w => w.phase == WorkSkipped)
```

### Terminal emission waits for captured children and every subscriber

Discovered by the proof: once draining begins, every active child belongs to the
captured work list. Subscriber identities remain unique, and every failed
subscriber records the first failure before terminal return. These are the
relations maintained by snapshotting and the synchronous settlement callback.
Discovered by the proof: subscriber identities must also be positive, as their
registration guard requires; identity zero is the distinct no-failure sentinel.

```quint
pure def canRegisterSubscriber(s: TerminalState, subscriber: int): bool = subscriber > 0 and s.phase != EmittingTask and s.phase != ReturnedTask and not(s.subscribers.some(h => h.id == subscriber))
pure def registerSubscriber(s: TerminalState, subscriber: int): TerminalState = { ...s, subscribers: s.subscribers.append({id: subscriber, result: 0}) }
pure def canEmitTerminal(s: TerminalState): bool = s.phase == DrainingTask and s.capturedWork.every(id => s.works.some(w => w.id == id and not(w.active)))
pure def emitTerminal(s: TerminalState): TerminalState = { ...s, phase: EmittingTask }
pure def canSettleSubscriber(s: TerminalState, subscriber: int, ok: bool): bool = s.phase == EmittingTask and s.subscribers.some(h => h.id == subscriber and h.result == 0)
pure def settleSubscriber(s: TerminalState, subscriber: int, ok: bool): TerminalState = { ...s, subscribers: s.subscribers.listMap(h => if (h.id == subscriber) { ...h, result: if (ok) 1 else 2 } else h), firstFailure: if (not(ok) and s.firstFailure == 0) subscriber else s.firstFailure }
pure def canReturnTerminal(s: TerminalState): bool = s.phase == EmittingTask and s.subscribers.every(h => h.result != 0)
pure def returnTerminal(s: TerminalState): TerminalState = { ...s, phase: ReturnedTask }
pure def alwaysEmitsAfterOwnedWork(s: TerminalState): bool = s.phase == EmittingTask or s.phase == ReturnedTask implies s.works.every(w => not(w.active))
pure def alwaysCapturedWorkComplete(s: TerminalState): bool = s.phase == DrainingTask or s.phase == EmittingTask or s.phase == ReturnedTask implies s.works.every(w => w.active implies s.capturedWork.includes(w.id))
pure def alwaysSubscriberIdentitiesUnique(s: TerminalState): bool = s.subscribers.every(h => s.subscribers.select(other => other.id == h.id).length() == 1)
pure def alwaysSubscriberIdentitiesPositive(s: TerminalState): bool = s.subscribers.every(h => h.id > 0)
pure def alwaysSubscriberFailuresRecorded(s: TerminalState): bool = s.subscribers.some(h => h.result == 2) implies s.firstFailure != 0
pure def alwaysJoinsAllSubscribers(s: TerminalState): bool = s.phase == ReturnedTask implies s.subscribers.every(h => h.result != 0)
pure def alwaysFirstFailureIsReal(s: TerminalState): bool = s.firstFailure != 0 implies s.subscribers.some(h => h.id == s.firstFailure and h.result == 2)
pure def alwaysReportsEmissionFailure(s: TerminalState): bool = s.phase == ReturnedTask implies (s.firstFailure != 0 iff s.subscribers.some(h => h.result == 2))
pure def stepFirstFailureStays(before: TerminalState, after: TerminalState): bool = before.firstFailure != 0 implies after.firstFailure == before.firstFailure
pure def sometimesRejectingSiblingWaits(s: TerminalState): bool = s.phase == EmittingTask and s.firstFailure != 0 and s.subscribers.some(h => h.result == 0)
pure def sometimesTerminalReturned(s: TerminalState): bool = s.phase == ReturnedTask
pure def sometimesIndependentChildren(s: TerminalState): bool = s.works.some(a => s.works.some(b => a.id != b.id and a.phase != b.phase))
pure val fair_startOwnedWork = "strong"
pure val fair_finishDelivery = "weak"
pure val fair_finishOwnedWork = "strong"
pure val fair_removeOwnedWork = "strong"
pure val fair_scheduleTerminal = "weak"
pure val fair_beginTerminalDrain = "weak"
pure val fair_emitTerminal = "weak"
pure val fair_settleSubscriber = "strong"
pure val fair_returnTerminal = "weak"
pure def leadsToTerminalReturned(s: TerminalState, later: TerminalState): bool = s.phase != NoTask and s.phase != SchedulingTask implies later.phase == ReturnedTask
```
