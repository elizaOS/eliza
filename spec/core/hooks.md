# Pipeline hook snapshots

Hook selection captures a phase-specific snapshot before awaiting. Sources include [pipeline-hooks.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/pipeline-hooks.ts), [pipeline-hooks.ts contracts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/types/pipeline-hooks.ts) and [PipelineHookSnapshot.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/PipelineHookSnapshot.qnt).

## Story: Dispatch an immutable phase snapshot

As a plugin author I register or replace hooks while earlier dispatches retain their captured handlers.

### Each phase dispatch captures the current handler identities

Replacement preserves the existing ID's registration slot, with the new handler and phase. A new ID receives a later insertion slot. The lookup for an ID is a projection of the single registry. Each upsert invalidates every phase memo; unregister invalidates them only when the ID exists. A memo miss caches the exact phase list, including an empty list. A hit returns that same phase-array reference. Old arrays can remain held by older dispatches after invalidation.

Discovered by the proof: a cached phase retains the complete ordered registration selection from its epoch. Cardinality and membership alone admit a duplicated entry in place of a different handler and would allow invalid captures on a hit.

The source comparator sorts by position ascending and then host `localeCompare` for public IDs. The adapter supplies the order-preserving position and collation values for comparisons among the registered hooks. When both compare equally, stable sort preserves insertion order. IDs and handler references are independent. The source's finite phase catalog is exact.

```quint
type HookKind = Mutator | SerialReader | ConcurrentReader
type Hook = { id: int, phase: str, position: int, collation: int, handler: int, order: int, kind: HookKind }
type PhaseMemo = { phase: str, epoch: int, arrayRef: int, selected: List[Hook] }
type HookRun = { id: int, status: int }
type HookState = { registry: List[Hook], snapshot: List[Hook], results: List[HookRun], dispatching: bool, completed: bool, rejected: bool, parallel: bool, localAdmission: bool, nextOrder: int, memo: List[PhaseMemo], epoch: int, nextArray: int, capturedArray: int }
pure val initial: HookState = { registry: List(), snapshot: List(), results: List(), dispatching: false, completed: false, rejected: false, parallel: false, localAdmission: false, nextOrder: 1, memo: List(), epoch: 0, nextArray: 1, capturedArray: 0 }
pure val idValues = Set(1, 2, 3)
pure val positionValues = Set(-1, 0, 1)
pure val collationValues = Set(0, 1, 2)
pure val handlerValues = Set(1, 2)
pure val phaseValues = Set("pre_model", "outgoing_before_deliver", "model_stream_chunk", "parallel_with_should_respond")
pure val pipelinePhases = Set("incoming_before_compose", "compose_state_providers", "pre_should_respond", "parallel_with_should_respond", "outgoing_before_deliver", "pre_model", "post_model", "after_memory_persisted", "model_stream_chunk", "model_stream_end")
pure val missingHook: Hook = {id: 0, phase: "", position: 0, collation: 0, handler: 0, order: 0, kind: ConcurrentReader}
pure def hookById(hooks: List[Hook], id: int): Hook = hooks.select(h => h.id == id).nthOr(0, missingHook)
pure def canRegisterHook(s: HookState, id: int, phase: str, position: int, collation: int, handler: int, kind: HookKind): bool = id > 0 and handler > 0 and pipelinePhases.contains(phase)
pure def registerHook(s: HookState, id: int, phase: str, position: int, collation: int, handler: int, kind: HookKind): HookState = {
  val existing = hookById(s.registry, id)
  val replacement = {id: id, phase: phase, position: position, collation: collation, handler: handler, order: if (existing.id == 0) s.nextOrder else existing.order, kind: kind}
  { ...s, registry: if (existing.id == 0) s.registry.append(replacement) else s.registry.listMap(h => if (h.id == id) replacement else h), nextOrder: if (existing.id == 0) s.nextOrder + 1 else s.nextOrder, memo: List(), epoch: s.epoch + 1 }
}
pure def unregisterHook(s: HookState, id: int): HookState = if (hookById(s.registry, id).id == 0) s else { ...s, registry: s.registry.select(h => h.id != id), memo: List(), epoch: s.epoch + 1 }
pure val noPhaseMemo: PhaseMemo = {phase: "", epoch: 0, arrayRef: 0, selected: List()}
pure val noPipelineHooks: List[Hook] = List()
pure val hooksValues = Set(noPipelineHooks,List(missingHook),List({ ...missingHook, id: 1, handler: 2, phase: "pre_model" }, { ...missingHook, id: 2, handler: 3, phase: "pre_model", position: 1 }))
pure def memoAt(s: HookState, phase: str): PhaseMemo = s.memo.select(row => row.phase == phase).nthOr(0, noPhaseMemo)
pure def pipelineComesBefore(first: Hook, second: Hook): bool = first.position < second.position or (first.position == second.position and (first.collation < second.collation or (first.collation == second.collation and first.order <= second.order)))
pure def insertPipelineHook(hooks: List[Hook], entry: Hook): List[Hook] = hooks.select(old => pipelineComesBefore(old, entry)).append(entry).concat(hooks.select(old => not(pipelineComesBefore(old, entry))))
pure def sortedPipelineHooks(hooks: List[Hook]): List[Hook] = hooks.foldl(noPipelineHooks, (acc, entry) => insertPipelineHook(acc, entry))
pure def phaseSelection(hooks: List[Hook], phase: str): List[Hook] = sortedPipelineHooks(hooks.select(entry => entry.phase == phase))
pure def cachedPhase(phase: str, s: HookState): HookState = if (memoAt(s, phase).arrayRef > 0) s else { ...s, memo: s.memo.append({phase: phase, epoch: s.epoch, arrayRef: s.nextArray, selected: phaseSelection(s.registry, phase)}), nextArray: s.nextArray + 1 }
pure def canLookupPhase(s: HookState, phase: str): bool = pipelinePhases.contains(phase)
pure def lookupPhase(s: HookState, phase: str): HookState = cachedPhase(phase, s)
pure def canBeginHooks(s: HookState, phase: str, localAdmission: bool): bool = not(s.dispatching) and pipelinePhases.contains(phase) and (not(localAdmission) or phase == "pre_model")
pure def attachSnapshot(phase: str, localAdmission: bool, captured: PhaseMemo, s: HookState): HookState = { ...s, snapshot: captured.selected, capturedArray: captured.arrayRef, results: captured.selected.listMap(h => {id: h.id, status: 0}), dispatching: true, completed: false, rejected: false, localAdmission: localAdmission, parallel: phase == "model_stream_chunk" or phase == "parallel_with_should_respond" }
pure def beginHooks(s: HookState, phase: str, localAdmission: bool): HookState = {
  val filled = cachedPhase(phase, s)
  attachSnapshot(phase, localAdmission, memoAt(filled, phase), filled)
}
pure def childCall(phase: str, localAdmission: bool, captured: PhaseMemo): HookState = attachSnapshot(phase, localAdmission, captured, initial)
pure def alwaysMemoGeneration(s: HookState): bool = s.nextArray > 0 and s.epoch >= 0 and s.memo.every(row => row.epoch == s.epoch and row.arrayRef > 0 and row.arrayRef < s.nextArray and s.memo.select(other => other.phase == row.phase).length() == 1 and s.memo.select(other => other.arrayRef == row.arrayRef).length() == 1)
type PipelineOrderCheck = {position: int, matches: bool}
pure val initialPipelineOrderCheck: PipelineOrderCheck = {position: 0, matches: true}
pure def samePipelineHook(first: Hook, second: Hook): bool = first.id == second.id and first.phase == second.phase and first.position == second.position and first.collation == second.collation and first.handler == second.handler and first.order == second.order and first.kind == second.kind
pure def samePipelineOrder(first: List[Hook], second: List[Hook]): bool = {
  val checked = first.foldl(initialPipelineOrderCheck, (point, entry) => {position: point.position + 1, matches: point.matches and samePipelineHook(entry, second.nthOr(point.position, missingHook))})
  first.length() == second.length() and checked.matches
}
pure def lawSelectionReflexive(hooks: List[Hook]): bool = samePipelineOrder(hooks, hooks)
pure def uniqueHookIds(hooks: List[Hook]): bool = hooks.every(h => h.id > 0 and hooks.select(x => x.id == h.id).length() == 1)
pure def alwaysMemoSelection(s: HookState): bool = s.memo.every(row => uniqueHookIds(row.selected) and samePipelineOrder(row.selected, phaseSelection(s.registry, row.phase)))
pure def stepMemoEpochNondecreasing(before: HookState, after: HookState): bool = after.epoch >= before.epoch and after.nextArray >= before.nextArray
pure def sometimesCachesEmptyPhase(s: HookState): bool = s.memo.some(row => row.selected.length() == 0)
pure def sometimesKeepsStaleArrayOnlyInDispatch(s: HookState): bool = s.dispatching and s.capturedArray > 0 and not(s.memo.some(row => row.arrayRef == s.capturedArray))
pure def alwaysSnapshotResultsAgree(s: HookState): bool = s.snapshot.length() == s.results.length() and s.snapshot.every(h => s.results.some(r => r.id == h.id))
pure def alwaysHookIdentifiersUnique(s: HookState): bool = uniqueHookIds(s.registry) and uniqueHookIds(s.snapshot)
pure def stepSnapshotStableDuringDispatch(before: HookState, via: str, after: HookState): bool = before.dispatching and via != "beginHooks" implies (before.capturedArray == after.capturedArray and samePipelineOrder(before.snapshot, after.snapshot))
pure def sometimesRegistryChangesDuringDispatch(s: HookState): bool = s.dispatching and not(samePipelineOrder(s.registry, s.snapshot))
```

### Mutators and serial readers complete before concurrent readers

Mutators run in position and ID collation order, followed by serial readers in that order, followed by the concurrent reader group. Parallel phases launch all selected hooks independently.

```quint
pure def hookRank(kind: HookKind): int = if (kind == Mutator) 0 else if (kind == SerialReader) 1 else 2
pure def precedes(first: Hook, second: Hook): bool = hookRank(first.kind) < hookRank(second.kind) or (first.kind == second.kind and first.kind != ConcurrentReader and pipelineComesBefore(first, second) and first.id != second.id)
pure def canStartHook(s: HookState, id: int): bool = s.dispatching and not(s.rejected) and s.results.some(r => r.id == id and r.status == 0) and (s.parallel or s.results.every(r => not(precedes(hookById(s.snapshot, r.id), hookById(s.snapshot, id))) or r.status >= 2))
pure def startHook(s: HookState, id: int): HookState = { ...s, results: s.results.listMap(r => if (r.id == id) { ...r, status: 1 } else r) }
pure def canFinishHook(s: HookState, id: int, ok: bool, admissionRefused: bool): bool = s.dispatching and s.results.some(r => r.id == id and r.status == 1) and (not(admissionRefused) or (s.localAdmission and not(s.parallel)))
pure def finishHook(s: HookState, id: int, ok: bool, admissionRefused: bool): HookState = { ...s, results: s.results.listMap(r => if (r.id == id) { ...r, status: if (ok and not(admissionRefused)) 2 else 3 } else r), rejected: s.rejected or admissionRefused }
pure def canFinishHooks(s: HookState): bool = s.dispatching and (s.rejected or s.results.every(r => r.status >= 2)) and s.results.every(r => r.status != 1)
pure def finishHooks(s: HookState): HookState = { ...s, dispatching: false, completed: true }
pure def alwaysHookStatuses(s: HookState): bool = s.results.every(r => r.status >= 0 and r.status <= 3)
pure def alwaysCompletedHooksSettled(s: HookState): bool = s.completed implies (s.results.every(r => r.status != 1) and (s.rejected or s.results.every(r => r.status >= 2)))
pure def alwaysRejectedIsLocalAdmission(s: HookState): bool = s.rejected implies s.localAdmission and not(s.parallel)
pure def sometimesFailedHookRetained(s: HookState): bool = s.completed and not(s.rejected) and s.results.some(r => r.status == 3)
pure def sometimesLocalAdmissionStopsLaterHooks(s: HookState): bool = s.completed and s.rejected and s.results.some(r => r.status == 0)
pure def sometimesConcurrentHooksRunning(s: HookState): bool = s.results.select(r => r.status == 1).length() > 1
```

### A captured hook dispatch eventually settles under fair handlers

Each started handler eventually returns or fails. The finite captured set then fulfills or reports the local admission refusal.

```quint
pure val fair_startHook = "weak"
pure val fair_finishHook = "weak"
pure val fair_finishHooks = "weak"
pure def leadsToHooksSettled(s: HookState, later: HookState): bool = s.dispatching implies later.completed
```
