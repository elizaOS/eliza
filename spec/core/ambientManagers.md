# Shared ambient manager selection

Bundled core copies read shared global symbol slots on every manager lookup. A default AsyncLocalStorage manager is created only when a slot is undefined. Sources include [ambient-context.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/ambient-context.ts), [trajectory-context.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/trajectory-context.ts), [streaming-context.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/streaming-context.ts), [action-routing-context.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/action-routing-context.ts) and [trajectory-utils.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/trajectory-utils.ts). Per-continuation value isolation is specified in the async context model.

## Story: Share injected managers across bundled core copies

As a host I replace a global manager and require subsequent lookups from every bundle to observe it.

### A symbol slot is the single source of manager identity

The first lookup stores its factory result. A replacement changes the slot for future lookups without changing the manager already captured by a running operation.

Discovered by the proof: the next generation stays positive, and every retained
slot's generation precedes it. Lookup can therefore capture an existing slot
without assigning a future or invalid generation.

```quint
type AmbientKey = TrajectoryManager | StreamingManager | ActionRoutingManager | ModelRecordingStorage | InputAttestationManager | ModelAttemptAuthority | StreamDepthStorage
type AmbientSlot = {key: AmbientKey, reference: int, generation: int}
type ManagerLookup = {id: int, bundle: int, key: AmbientKey, reference: int, generation: int}
type ManagerOperation = {id: int, lookup: int, key: AmbientKey, reference: int, active: bool}
type AmbientManagers = {slots: List[AmbientSlot], lookups: List[ManagerLookup], operations: List[ManagerOperation], factoryCalls: int, nextGeneration: int}
pure val initial: AmbientManagers = {slots: List(), lookups: List(), operations: List(), factoryCalls: 0, nextGeneration: 1}
pure val referenceValues = Set(1, 2, 3)
pure val bundleValues = Set(1, 2)
pure val lookupIdValues = Set(1, 2, 3)
pure val operationIdValues = Set(1, 2, 3)
pure val absentSlot: AmbientSlot = {key: TrajectoryManager, reference: 0, generation: 0}
pure def managerSlot(s: AmbientManagers, key: AmbientKey): AmbientSlot = s.slots.select(slot => slot.key == key).nthOr(0, absentSlot)
pure def canLookupManager(s: AmbientManagers, lookupId: int, bundle: int, key: AmbientKey, reference: int): bool = lookupId > 0 and bundle > 0 and reference > 0 and not(s.lookups.some(l => l.id == lookupId))
pure def lookupManager(s: AmbientManagers, lookupId: int, bundle: int, key: AmbientKey, reference: int): AmbientManagers = {
  val existing = managerSlot(s, key)
  val selected = if (existing.generation == 0) {key: key, reference: reference, generation: s.nextGeneration} else existing
  { ...s, slots: if (existing.generation == 0) s.slots.append(selected) else s.slots, factoryCalls: s.factoryCalls + (if (existing.generation == 0) 1 else 0), nextGeneration: if (existing.generation == 0) s.nextGeneration + 1 else s.nextGeneration, lookups: s.lookups.append({id: lookupId, bundle: bundle, key: key, reference: selected.reference, generation: selected.generation}) }
}
pure def canReplaceManager(s: AmbientManagers, key: AmbientKey, reference: int): bool = reference > 0
pure def replaceManager(s: AmbientManagers, key: AmbientKey, reference: int): AmbientManagers = { ...s, slots: if (s.slots.some(slot => slot.key == key)) s.slots.listMap(slot => if (slot.key == key) {key: key, reference: reference, generation: s.nextGeneration} else slot) else s.slots.append({key: key, reference: reference, generation: s.nextGeneration}), nextGeneration: s.nextGeneration + 1 }
pure def alwaysOneSlotPerSymbol(s: AmbientManagers): bool = s.nextGeneration > 0 and s.slots.every(slot => slot.reference > 0 and slot.generation > 0 and slot.generation < s.nextGeneration and s.slots.select(other => other.key == slot.key).length() == 1)
pure def alwaysLookupGenerationExists(s: AmbientManagers): bool = s.lookups.every(l => l.generation > 0 and l.generation < s.nextGeneration and l.reference > 0)
pure def sometimesBundlesShareManager(s: AmbientManagers): bool = s.lookups.some(a => s.lookups.some(b => a.bundle != b.bundle and a.key == b.key and a.reference == b.reference and a.generation == b.generation))
```

### An active operation retains the manager captured at entry

A manager replacement affects later get/run calls, while pending work on an earlier manager uses that captured instance until it returns.

```quint
pure def canBeginManagerOperation(s: AmbientManagers, operationId: int, lookupId: int): bool = operationId > 0 and not(s.operations.some(op => op.id == operationId)) and s.lookups.some(l => l.id == lookupId)
pure def beginManagerOperation(s: AmbientManagers, operationId: int, lookupId: int): AmbientManagers = {
  val selected = s.lookups.select(l => l.id == lookupId).nthOr(0, {id: 0, bundle: 0, key: TrajectoryManager, reference: 0, generation: 0})
  { ...s, operations: s.operations.append({id: operationId, lookup: lookupId, key: selected.key, reference: selected.reference, active: true}) }
}
pure def canFinishManagerOperation(s: AmbientManagers, operationId: int): bool = s.operations.some(op => op.id == operationId and op.active)
pure def finishManagerOperation(s: AmbientManagers, operationId: int): AmbientManagers = { ...s, operations: s.operations.listMap(op => if (op.id == operationId) { ...op, active: false } else op) }
pure def alwaysOperationUsesCapturedLookup(s: AmbientManagers): bool = s.operations.every(op => s.lookups.some(l => l.id == op.lookup and l.key == op.key and l.reference == op.reference))
pure def stepCapturedOperationManagerStable(before: AmbientManagers, after: AmbientManagers): bool = before.operations.every(op => after.operations.some(other => other.id == op.id and other.reference == op.reference and other.key == op.key))
pure def sometimesReplacementDuringOperation(s: AmbientManagers): bool = s.operations.some(op => op.active and op.reference != managerSlot(s, op.key).reference)
```
