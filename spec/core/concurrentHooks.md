# Concurrent pipeline hook dispatches

This composes [hook dispatch](./hooks.md) with one shared runtime registry. The source is `packages/core/src/runtime/pipeline-hooks.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. Each invocation owns its snapshot and handler progress while all invocations use the same phase memo owner. A miss selects and sorts from the current registry. A hit reuses the published phase-array identity, including an empty result. The registry component leaves its standalone dispatch idle. Each call owns an independent continuation initialized with the captured immutable array and no live memo.

## Story: Replace hooks while independent phase calls are in flight

As a plugin I change a runtime registry without changing callbacks captured by older calls. Several calls may execute or fail independently.

### A call captures exactly the memo visible at its own start

```quint
import hooks as H from "./hooks"
type HookCall = {id: int, unit: H::HookState}
type ConcurrentHooks = {registry: H::HookState, calls: List[HookCall]}
pure val initial: ConcurrentHooks = {registry: H::initial, calls: List()}
pure val callIdValues = Set(1, 2, 3)
pure val idValues = H::idValues
pure val phaseValues = H::phaseValues
pure val positionValues = H::positionValues
pure val collationValues = H::collationValues
pure val handlerValues = H::handlerValues
pure def hookCall(s: ConcurrentHooks, callId: int): H::HookState = s.calls.select(c => c.id == callId).nthOr(0, {id: 0, unit: H::initial}).unit
pure def canRegister(s: ConcurrentHooks, id: int, phase: str, position: int, collation: int, handler: int, kind: H::HookKind): bool = H::canRegisterHook(s.registry, id, phase, position, collation, handler, kind)
pure def register(s: ConcurrentHooks, id: int, phase: str, position: int, collation: int, handler: int, kind: H::HookKind): ConcurrentHooks = { ...s, registry: H::registerHook(s.registry, id, phase, position, collation, handler, kind) }
pure def unregister(s: ConcurrentHooks, id: int): ConcurrentHooks = { ...s, registry: H::unregisterHook(s.registry, id) }
pure def canBeginCall(s: ConcurrentHooks, callId: int, phase: str, localAdmission: bool): bool = callId > 0 and not(s.calls.some(c => c.id == callId)) and H::canBeginHooks(s.registry, phase, localAdmission)
pure def canLookupPhase(s: ConcurrentHooks, phase: str): bool = H::canLookupPhase(s.registry, phase)
pure def lookupPhase(s: ConcurrentHooks, phase: str): ConcurrentHooks = { ...s, registry: H::lookupPhase(s.registry, phase) }
pure def beginCall(s: ConcurrentHooks, callId: int, phase: str, localAdmission: bool): ConcurrentHooks = {
  val filled = H::lookupPhase(s.registry, phase)
  { ...s, registry: filled, calls: s.calls.append({id: callId, unit: H::childCall(phase, localAdmission, H::memoAt(filled, phase))}) }
}
pure def canStartCallHook(s: ConcurrentHooks, callId: int, id: int): bool = H::canStartHook(hookCall(s, callId), id)
pure def startCallHook(s: ConcurrentHooks, callId: int, id: int): ConcurrentHooks = { ...s, calls: s.calls.listMap(c => if (c.id == callId) { ...c, unit: H::startHook(c.unit, id) } else c) }
pure def canFinishCallHook(s: ConcurrentHooks, callId: int, id: int, ok: bool, admissionRefused: bool): bool = H::canFinishHook(hookCall(s, callId), id, ok, admissionRefused)
pure def finishCallHook(s: ConcurrentHooks, callId: int, id: int, ok: bool, admissionRefused: bool): ConcurrentHooks = { ...s, calls: s.calls.listMap(c => if (c.id == callId) { ...c, unit: H::finishHook(c.unit, id, ok, admissionRefused) } else c) }
pure def canFinishCall(s: ConcurrentHooks, callId: int): bool = H::canFinishHooks(hookCall(s, callId))
pure def finishCall(s: ConcurrentHooks, callId: int): ConcurrentHooks = { ...s, calls: s.calls.listMap(c => if (c.id == callId) { ...c, unit: H::finishHooks(c.unit) } else c) }
pure def validHookCall(unit: H::HookState): bool = H::alwaysSnapshotResultsAgree(unit) and H::alwaysHookIdentifiersUnique(unit) and H::alwaysHookStatuses(unit) and H::alwaysCompletedHooksSettled(unit) and H::alwaysRejectedIsLocalAdmission(unit) and unit.memo.length() == 0 and unit.epoch == 0 and unit.nextArray == 1
pure def alwaysRegistryMemoValid(s: ConcurrentHooks): bool = H::alwaysMemoGeneration(s.registry) and H::alwaysMemoSelection(s.registry) and H::alwaysHookIdentifiersUnique(s.registry) and s.registry.snapshot.length() == 0 and s.registry.results.length() == 0 and not(s.registry.completed) and not(s.registry.rejected)
pure def alwaysCallIdentity(s: ConcurrentHooks): bool = s.calls.every(c => c.id > 0 and s.calls.select(other => other.id == c.id).length() == 1)
pure def alwaysEveryHookCallValid(s: ConcurrentHooks): bool = s.calls.every(c => validHookCall(c.unit))
pure def lawRegistrySnapshotEquality(s: ConcurrentHooks): bool = s.calls.every(c => H::lawSelectionReflexive(c.unit.snapshot))
pure def stepEverySnapshotStable(before: ConcurrentHooks, after: ConcurrentHooks): bool = before.calls.every(c => after.calls.some(other => other.id == c.id and other.unit.capturedArray == c.unit.capturedArray and H::samePipelineOrder(other.unit.snapshot, c.unit.snapshot)))
pure def stepRegistryMutationKeepsDispatchEpoch(before: ConcurrentHooks, via: str, after: ConcurrentHooks): bool = (via == "register" or via == "unregister") implies after.calls.length() == before.calls.length()
pure def sometimesTwoDifferentSnapshots(s: ConcurrentHooks): bool = s.calls.some(a => s.calls.some(b => a.id != b.id and not(H::samePipelineOrder(a.unit.snapshot, b.unit.snapshot)) and a.unit.dispatching and b.unit.dispatching))
pure def sometimesOneCallFailsWhilePeerCompletes(s: ConcurrentHooks): bool = s.calls.some(a => a.unit.rejected and s.calls.some(b => b.id != a.id and b.unit.completed and not(b.unit.rejected)))
pure def sometimesInvalidatedArrayStillHeld(s: ConcurrentHooks): bool = s.calls.some(c => c.unit.dispatching and not(s.registry.memo.some(row => row.arrayRef == c.unit.capturedArray)))
pure val fair_startCallHook = "strong"
pure val fair_finishCallHook = "strong"
pure val fair_finishCall = "strong"
pure def leadsToCapturedCallsSettle(s: ConcurrentHooks, later: ConcurrentHooks): bool = s.calls.every(c => later.calls.some(done => done.id == c.id and done.unit.completed))
```
