# Pipeline hook snapshots

Hook selection captures a phase-specific snapshot before awaiting. Sources include [pipeline-hooks.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/pipeline-hooks.ts), [pipeline-hooks.ts contracts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/types/pipeline-hooks.ts) and [PipelineHookSnapshot.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/PipelineHookSnapshot.qnt).

## Story: Dispatch an immutable phase snapshot

As a plugin author I register or replace hooks while earlier dispatches retain their captured handlers.

### Each phase dispatch captures the current handler identities

Replacement preserves an existing registration slot. A newly registered hook receives a later insertion order.

```quint
type HookKind = Mutator | SerialReader | ConcurrentReader
type Hook = { id: int, phase: str, position: int, order: int, kind: HookKind }
type HookRun = { id: int, status: int }
type HookState = { registry: List[Hook], snapshot: List[Hook], results: List[HookRun], dispatching: bool, completed: bool, rejected: bool, parallel: bool, localAdmission: bool, nextOrder: int }
pure val initial: HookState = { registry: List(), snapshot: List(), results: List(), dispatching: false, completed: false, rejected: false, parallel: false, localAdmission: false, nextOrder: 1 }
pure val idValues = Set(1, 2, 3)
pure val positionValues = Set(0, 1, 2)
pure val phaseValues = Set("pre_model", "outgoing", "model_stream_chunk", "parallel_with_should_respond")
pure val missingHook: Hook = {id: 0, phase: "", position: 0, order: 0, kind: ConcurrentReader}
pure def hookById(hooks: List[Hook], id: int): Hook = hooks.select(h => h.id == id).nthOr(0, missingHook)
pure def canRegisterHook(s: HookState, id: int, phase: str, position: int, kind: HookKind): bool = id > 0 and phase != ""
pure def registerHook(s: HookState, id: int, phase: str, position: int, kind: HookKind): HookState = {
  val existing = hookById(s.registry, id)
  val replacement = {id: id, phase: phase, position: position, order: if (existing.id == 0) s.nextOrder else existing.order, kind: kind}
  { ...s, registry: if (existing.id == 0) s.registry.append(replacement) else s.registry.listMap(h => if (h.id == id) replacement else h), nextOrder: if (existing.id == 0) s.nextOrder + 1 else s.nextOrder }
}
pure def canUnregisterHook(s: HookState, id: int): bool = s.registry.some(h => h.id == id)
pure def unregisterHook(s: HookState, id: int): HookState = { ...s, registry: s.registry.select(h => h.id != id) }
pure def canBeginHooks(s: HookState, phase: str, localAdmission: bool): bool = not(s.dispatching) and (not(localAdmission) or phase == "pre_model")
pure def beginHooks(s: HookState, phase: str, localAdmission: bool): HookState = {
  val captured = s.registry.select(h => h.phase == phase)
  { ...s, snapshot: captured, results: captured.listMap(h => {id: h.id, status: 0}), dispatching: true, completed: false, rejected: false, localAdmission: localAdmission, parallel: phase == "model_stream_chunk" or phase == "parallel_with_should_respond" }
}
pure def alwaysSnapshotResultsAgree(s: HookState): bool = s.snapshot.length() == s.results.length() and s.snapshot.every(h => s.results.some(r => r.id == h.id))
pure def alwaysHookIdentifiersUnique(s: HookState): bool = s.registry.every(h => s.registry.select(x => x.id == h.id).length() == 1) and s.snapshot.every(h => s.snapshot.select(x => x.id == h.id).length() == 1)
pure def stepSnapshotStableDuringDispatch(before: HookState, via: str, after: HookState): bool = before.dispatching and via != "beginHooks" implies before.snapshot == after.snapshot
pure def sometimesRegistryChangesDuringDispatch(s: HookState): bool = s.dispatching and s.registry != s.snapshot
```

### Mutators and serial readers complete before concurrent readers

Mutators run in position and insertion order, followed by serial readers in that order, followed by the concurrent reader group. Parallel phases launch all selected hooks independently.

```quint
pure def hookRank(kind: HookKind): int = if (kind == Mutator) 0 else if (kind == SerialReader) 1 else 2
pure def precedes(first: Hook, second: Hook): bool = hookRank(first.kind) < hookRank(second.kind) or (first.kind == second.kind and first.kind != ConcurrentReader and (first.position < second.position or (first.position == second.position and first.order < second.order)))
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
