# Model diagnostic promise ownership

`packages/core/src/runtime/model-dispatch.ts:251-267` at `72fed7e4069ecd35d61d886ab6eec5c02c137517` keeps a Set of exact write promises. Fulfillment and rejection both remove the same identity. Drain loops over new snapshots until the Set is empty, including writes added while an earlier snapshot was awaiting.

## Story: Finish every diagnostic write before storage closes

As the model runtime I retain each pending diagnostic promise. Duplicate tracking shares its Set entry, and tracking an already-settled promise adds it until its completion microtask removes it again.

### Promise identity governs membership independently of the final outcome

```quint
type DiagnosticPromise = {id: int, active: bool, settled: bool, errorId: str}
type DiagnosticDrain = {id: int, batch: List[int], waiting: bool, returned: bool}
type ModelDiagnostics = {promises: List[DiagnosticPromise], drains: List[DiagnosticDrain]}
pure val initial: ModelDiagnostics = {promises: List(), drains: List()}
pure val promiseIdValues = Set(1, 2, 3)
pure val drainIdValues = Set(1, 2)
pure val errorIdValues = Set("", "write-error")
pure def canTrackWrite(s: ModelDiagnostics, promiseId: int): bool = promiseId > 0
pure def trackWrite(s: ModelDiagnostics, promiseId: int): ModelDiagnostics = { ...s, promises: if (s.promises.some(p => p.id == promiseId)) s.promises.listMap(p => if (p.id == promiseId) { ...p, active: true } else p) else s.promises.append({id: promiseId, active: true, settled: false, errorId: ""}) }
pure def canSettleWrite(s: ModelDiagnostics, promiseId: int, errorId: str): bool = s.promises.some(p => p.id == promiseId and not(p.settled))
pure def settleWrite(s: ModelDiagnostics, promiseId: int, errorId: str): ModelDiagnostics = { ...s, promises: s.promises.listMap(p => if (p.id == promiseId) { ...p, settled: true, errorId: errorId } else p) }
pure def canRemoveWrite(s: ModelDiagnostics, promiseId: int): bool = s.promises.some(p => p.id == promiseId and p.active and p.settled)
pure def removeWrite(s: ModelDiagnostics, promiseId: int): ModelDiagnostics = { ...s, promises: s.promises.listMap(p => if (p.id == promiseId) { ...p, active: false } else p) }
pure def canBeginDrain(s: ModelDiagnostics, drainId: int): bool = drainId > 0 and not(s.drains.some(d => d.id == drainId))
pure def beginDrain(s: ModelDiagnostics, drainId: int): ModelDiagnostics = { ...s, drains: s.drains.append({id: drainId, batch: List(), waiting: false, returned: false}) }
pure def canSnapshotDrain(s: ModelDiagnostics, drainId: int): bool = s.drains.some(d => d.id == drainId and not(d.waiting) and not(d.returned))
pure def snapshotDrain(s: ModelDiagnostics, drainId: int): ModelDiagnostics = { ...s, drains: s.drains.listMap(d => if (d.id == drainId) { ...d, batch: s.promises.select(p => p.active).listMap(p => p.id), waiting: s.promises.some(p => p.active), returned: not(s.promises.some(p => p.active)) } else d) }
pure def canFinishBatch(s: ModelDiagnostics, drainId: int): bool = s.drains.some(d => d.id == drainId and d.waiting and d.batch.every(id => s.promises.some(p => p.id == id and p.settled and not(p.active))))
pure def finishBatch(s: ModelDiagnostics, drainId: int): ModelDiagnostics = { ...s, drains: s.drains.listMap(d => if (d.id == drainId) { ...d, batch: List(), waiting: false } else d) }
pure def alwaysPromiseIdentity(s: ModelDiagnostics): bool = s.promises.every(p => p.id > 0 and s.promises.select(other => other.id == p.id).length() == 1)
pure def alwaysDrainBatchExists(s: ModelDiagnostics): bool = s.drains.every(d => d.batch.every(id => s.promises.some(p => p.id == id)))
pure def sometimesWriteJoinsDuringDrain(s: ModelDiagnostics): bool = s.drains.some(d => d.waiting and s.promises.some(p => p.active and not(d.batch.includes(p.id))))
pure def sometimesRejectedWriteRemoved(s: ModelDiagnostics): bool = s.promises.some(p => p.errorId != "" and not(p.active))
```
