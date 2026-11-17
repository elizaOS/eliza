# Runtime trace lifecycle

The active trace registry retains each original `ExecutionTrace` object. The generated owner captures the admitted key and run, global key insertion order, independent per-run admission order, and purge cadence. A raw reference map and native run sets are I/O projections of that owner. They are not copied trace metadata or another ownership policy. The pending conflict-rejection proposal is replaced by compatible cross-run transfer: `record` remains void and adds no rejection.

## Story: Retain enrich and retire active trace records

As a runtime I retain original active trace references, enrich the selected native run index, and retire expired keys without discarding retained peers. Every record call increments the purge counter before reading incoming fields. Every hundredth call purges before reading the incoming run ID. An empty run is ignored without reading its trace ID. Cross-run reuse transfers the key to the receiving run while keeping its global insertion slot.

### Recording preserves the insertion position of a replacement in its run

Global key order and per-run admission order are independent. Re-recording a key preserves its global slot. Existing destination membership keeps its run position; otherwise the receiving run appends it. Transfer removes other run memberships. Deleting an old run cannot erase a transferred trace. Empty trace IDs remain valid, so absence uses a tagged lookup.

Admission reads the run ID after cadence and any due purge. A falsy run returns without reading the trace ID; an admitted ID is captured once for both its global key and run membership. This intentionally replaces the pinned source's two ID reads for a volatile accessor, so arbitrary getter-count equivalence is not claimed. The original trace object remains stored under the captured key. Admission does not read `createdAt`, `scoreCard`, signals or enrichment timestamps. Enrichment history below counts successful per-key completion observations since its latest admission, and only when the key still has the captured run owner. It is not a snapshot or complete history of mutable foreign score-card writes. The host always performs the original captured native Set loop, including reentrant foreign effects; it does not reject or skip work because this receipt projection does not match. Original trace, score-card and signal references remain host obligations. Composite scoring follows the [score-card model](./scoreCard.md).

```quint
type Trace = {id: str, runId: str, enrichments: int}
type RunEntry = {runId: str, traceId: str}
type TraceLookup = NoActiveTrace | ActiveTrace({id: str})
type TraceRecordResult = NoRecordResult | TraceRecorded({id: str, previousRun: str, runId: str}) | TraceIgnored
type TraceRetention = KeepObserved | ExpireObserved
type PurgeObservation = {id: str, retention: TraceRetention}
type PurgeReceipt = NoPurgeReceipt | PurgeObserved(PurgeObservation)
type TraceState = {purgeCounter: int, traces: List[Trace], runEntries: List[RunEntry], lastResult: TraceRecordResult, lastEnrichedRun: str, lastPurge: PurgeReceipt}
type TraceEffect = RetireTrace({id: str}) | RemoveRunMember({runId: str, id: str}) | DropRunIndex({runId: str}) | EnsureRunMember({runId: str, id: str})
type TraceChange = {state: TraceState, out: List[TraceEffect]}
pure val initial: TraceState = {purgeCounter: 0, traces: List(), runEntries: List(), lastResult: NoRecordResult, lastEnrichedRun: "", lastPurge: NoPurgeReceipt}
pure val noTrace: Trace = {id: "", runId: "", enrichments: 0}
pure val traceTtlMs = 300000
pure def traceIds(traces: List[Trace]): List[str] = traces.listMap(trace => trace.id)
pure def traceFor(s: TraceState, id: str): Trace = s.traces.select(trace => trace.id == id).nthOr(0, noTrace)
pure def indexedIds(s: TraceState, runId: str): List[str] = s.runEntries.select(entry => entry.runId == runId).listMap(entry => entry.traceId)
pure def runTraces(s: TraceState, runId: str): List[Trace] = indexedIds(s, runId).listMap(id => traceFor(s, id))
pure def latestTrace(s: TraceState, runId: str): TraceLookup = {
  val ids = indexedIds(s, runId)
  if (ids.length() == 0) NoActiveTrace else ActiveTrace({id: ids.nthOr(ids.length() - 1, "")})
}
pure def withoutIds(ids: List[str], s: TraceState): TraceState =
  { ...s, traces: s.traces.select(trace => not(ids.includes(trace.id))), runEntries: s.runEntries.select(entry => not(ids.includes(entry.traceId))) }
pure def removalEffects(removed: List[RunEntry], remaining: List[RunEntry]): List[TraceEffect] =
  removed.foldl(List(), (effects, entry) => effects.concat(List(RemoveRunMember({runId: entry.runId, id: entry.traceId}))).concat(
    if (remaining.every(other => other.runId != entry.runId)) List(DropRunIndex({runId: entry.runId})) else List()))
pure def purgeDueAfterRecord(s: TraceState): bool = s.purgeCounter > 0 and s.purgeCounter % 100 == 0
pure def beginRecord(s: TraceState): TraceChange = {state: { ...s, purgeCounter: s.purgeCounter + 1 }, out: List()}
pure def ignoreRecord(s: TraceState): TraceChange = {state: { ...s, lastResult: TraceIgnored }, out: List()}
pure def recordTrace(s: TraceState, id: str, runId: str): TraceChange = {
  val remaining = s.runEntries.select(entry => entry.traceId != id or entry.runId == runId)
  val removed = s.runEntries.select(entry => entry.traceId == id and entry.runId != runId)
  val admitted = {id: id, runId: runId, enrichments: 0}
  if (runId == "") ignoreRecord(s)
  else {state: { ...s,
    traces: if (s.traces.some(trace => trace.id == id)) s.traces.listMap(trace => if (trace.id == id) admitted else trace) else s.traces.append(admitted),
    runEntries: if (remaining.some(entry => entry.runId == runId and entry.traceId == id)) remaining else remaining.append({runId: runId, traceId: id}),
    lastResult: TraceRecorded({id: id, previousRun: traceFor(s, id).runId, runId: runId}) },
    out: removalEffects(removed, remaining).append(EnsureRunMember({runId: runId, id: id})) }
}
pure def enrichObservedTrace(s: TraceState, runId: str, id: str): TraceChange =
  {state: { ...s, lastEnrichedRun: runId, traces: s.traces.listMap(trace =>
    if (trace.runId == runId and trace.id == id) { ...trace, enrichments: trace.enrichments + 1 } else trace) }, out: List()}
pure def deleteTrace(s: TraceState, id: str): TraceChange = {
  val kept = withoutIds(List(id), s)
  {state: kept, out: List(RetireTrace({id: id})).concat(removalEffects(s.runEntries.select(entry => entry.traceId == id), kept.runEntries))}
}
pure def finalizeRun(s: TraceState, runId: str): TraceChange = {
  val ids = indexedIds(s, runId)
  {state: withoutIds(ids, s), out: if (ids.length() == 0) List() else ids.listMap(id => RetireTrace({id: id})).append(DropRunIndex({runId: runId}))}
}
pure def purgeObservedTrace(s: TraceState, observation: PurgeObservation): TraceChange = {
  val retired = deleteTrace(s, observation.id)
  {state: { ...(if (observation.retention == ExpireObserved) retired.state else s), lastPurge: PurgeObserved({id: observation.id, retention: observation.retention}) },
   out: if (observation.retention == ExpireObserved) retired.out else List()}
}
pure def alwaysTraceIdentitiesUnique(s: TraceState): bool = s.traces.every(trace => s.traces.select(other => other.id == trace.id).length() == 1)
pure def alwaysPurgeCounterNonnegative(s: TraceState): bool = s.purgeCounter >= 0
pure def alwaysRunIndexesOwned(s: TraceState): bool =
  s.traces.every(trace => trace.runId != "" and s.runEntries.select(entry => entry.traceId == trace.id).length() == 1) and
  s.runEntries.every(entry => s.traces.some(trace => trace.id == entry.traceId and trace.runId == entry.runId))
pure def alwaysEnrichmentReceiptsNonnegative(s: TraceState): bool = s.traces.every(trace => trace.enrichments >= 0)
pure def stepRecordCountsEveryAttempt(before: TraceState, via: str, after: TraceState): bool =
  if (via == "beginRecord") after.purgeCounter == before.purgeCounter + 1 else after.purgeCounter == before.purgeCounter
pure def stepEnrichmentStaysInOneRun(before: TraceState, via: str, after: TraceState): bool =
  via == "enrichObservedTrace" implies traceIds(before.traces) == traceIds(after.traces) and before.runEntries == after.runEntries and
    before.traces.every(trace => after.traces.every(other => trace.id != other.id or trace.runId == after.lastEnrichedRun or trace == other))
pure def stepIndexInsertionOrder(before: TraceState, via: str, after: TraceState): bool =
  via == "recordTrace" implies traceIds(after.traces) == traceIds(before.traces) or
    (traceIds(after.traces).length() == traceIds(before.traces).length() + 1 and traceIds(after.traces).removeAt(after.traces.length() - 1) == traceIds(before.traces))
pure def stepTransferPreservesUnrelatedRuns(before: TraceState, via: str, after: TraceState): bool = {
  val result = after.lastResult
  via == "recordTrace" implies match result {
    | TraceRecorded(receipt) => before.runEntries.every(entry => entry.runId == receipt.previousRun or entry.runId == receipt.runId or indexedIds(before, entry.runId) == indexedIds(after, entry.runId))
    | _ => true }
}
pure def stepFinalizationPreservesCapturedSetMembers(before: TraceState, via: str, after: TraceState, out: List[TraceEffect]): bool =
  via == "finalizeRun" implies out.every(effect => match effect { | RetireTrace(_) => true | DropRunIndex(_) => true | _ => false })
pure def lawRunViewKeepsOwners(s: TraceState, runId: str): bool = alwaysTraceIdentitiesUnique(s) and alwaysRunIndexesOwned(s) implies runTraces(s, runId).every(trace => trace.runId == runId)
pure def lawDestinationRunKeepsAdmissionOrder(s: TraceState, id: str, runId: str): bool = runId != "" implies
  indexedIds(recordTrace(s, id, runId).state, runId) == (if (indexedIds(s, runId).includes(id)) indexedIds(s, runId) else indexedIds(s, runId).append(id))
pure def lawEmptyTraceIdIsPresent(s: TraceState, runId: str): bool = {
  val latest = latestTrace(recordTrace(s, "", runId).state, runId)
  runId != "" implies match latest { | NoActiveTrace => false | _ => true }
}
pure def sometimesTwoTracesInOneRun(s: TraceState): bool = s.traces.some(trace => runTraces(s, trace.runId).length() > 1)
pure def sometimesTraceEnriched(s: TraceState): bool = s.traces.some(trace => trace.enrichments > 0)
pure def sometimesAllTracesFinalized(s: TraceState): bool = s.purgeCounter > 0 and s.traces.length() == 0
pure def sometimesCrossRunTransfer(s: TraceState): bool = {
  val result = s.lastResult
  match result {
  | TraceRecorded(receipt) => receipt.previousRun != "" and receipt.previousRun != receipt.runId and s.traces.some(trace => trace.id == receipt.id and trace.runId == receipt.runId)
  | _ => false }
}
pure val idValues = Set("trace-a", "trace-b", "missing", "")
pure val runIdValues = Set("run-a", "run-b", "")
pure val observationValues = Set({id: "trace-a", retention: KeepObserved}, {id: "trace-a", retention: ExpireObserved}, {id: "trace-b", retention: KeepObserved}, {id: "trace-b", retention: ExpireObserved}, {id: "", retention: KeepObserved}, {id: "", retention: ExpireObserved})
pure val sValues = Set(initial)
```

### Native expiry observations retire the exact captured key

A purge samples the wall clock once, then reads each current original object's `createdAt` in live global Map order. The native comparison retains exactly when `now - createdAt <= 300000`; its negation retires, including NaN. Fractions and infinities remain accepted source values. No timestamp is parsed, clamped or converted into a generated integer event. Each observation is committed before reading the next object, so earlier deletions survive a later getter throw. Native comparison and reflection are explicit source-conformance boundaries.

The integer arithmetic below is a reference law, not a snapshot of a mutable foreign timestamp. It is not called with raw host numbers. It replaces the old captured-timestamp `leadsToStaleTraceReevaluated` model: persistent native expiry implies retirement only with eventual successfully completed purge sweeps; changed metadata or clock observations may revoke expiry. Arbitrarily repeated throwing getters do not promise retirement. Run getters and enrichment retain captured native Set objects, including after their run-map entry is dropped. Reentrant foreign score-card writes are not equated to the logical successful-current-owner enrichment receipts above.

```quint
pure def integerTraceTtlRetains(now: int, createdAt: int): bool = now - createdAt <= traceTtlMs
pure def lawTraceTtlArithmetic(now: int, createdAt: int): bool = integerTraceTtlRetains(now, createdAt) == (now <= createdAt + traceTtlMs)
pure def lawObservedExpiryRetiresOnlyItsKey(s: TraceState, id: str): bool = {
  val after = purgeObservedTrace(s, {id: id, retention: ExpireObserved}).state
  after.traces == s.traces.select(trace => trace.id != id) and after.runEntries == s.runEntries.select(entry => entry.traceId != id)
}
pure def lawObservedRetentionKeepsOwners(s: TraceState, id: str): bool = {
  val after = purgeObservedTrace(s, {id: id, retention: KeepObserved}).state
  after.traces == s.traces and after.runEntries == s.runEntries and after.purgeCounter == s.purgeCounter
}
pure def sometimesTraceRetainedByObservation(s: TraceState): bool = {
  val receipt = s.lastPurge
  match receipt {
  | PurgeObserved(observation) => observation.retention == KeepObserved and s.traces.some(trace => trace.id == observation.id)
  | _ => false }
}
pure val nowValues = Set(0, 1, 300000, 300001, 300002)
pure val createdAtValues = Set(0, 1, 300000)
```

### Emitted instructions reproduce owner changes and publish the captured record

Discovered by review: state-only rules allowed an admitted record with no emitted storage instructions. Emitted instructions must reproduce the resulting global keys and ordered run memberships from a coherent prior owner. Retirement removes a global key; member removal removes only its exact run/key pair; dropping an index removes its current run view without clearing a previously captured native Set; ensure preserves existing positions and adds missing global keys or target memberships.

Every admitted record emits an ensure for its captured key and receiving run, including same-key same-run replacement of the original reference. All record ensures name that pair, record emits no retirement, and its member removals or drops affect only other runs of that captured key. No other transition emits ensure: its generic shell interpreter has no incoming trace reference to publish. Except for finalization, an index drop follows removal of every exact prior member of that run. Finalization deliberately preserves the detached captured Set's members. The audit below is a pure derived relation over instructions, not stored history or another owner. Final snapshot agreement alone does not prove reference replacement or every live captured-Set behavior; original-object and native-iteration conformance remain host obligations.

```quint
type TraceProjection = {globalIds: List[str], runEntries: List[RunEntry]}
type TraceEffectAudit = {seenRemoves: List[RunEntry], valid: bool}
pure val emptyTraceEffectAudit: TraceEffectAudit = {seenRemoves: List(), valid: true}
pure def traceProjection(s: TraceState): TraceProjection = {globalIds: traceIds(s.traces), runEntries: s.runEntries}
pure def applyTraceProjectionEffect(projected: TraceProjection, instruction: TraceEffect): TraceProjection = match instruction {
  | RetireTrace(retired) => { ...projected, globalIds: projected.globalIds.select(id => id != retired.id) }
  | RemoveRunMember(removed) => { ...projected, runEntries: projected.runEntries.select(entry => entry.runId != removed.runId or entry.traceId != removed.id) }
  | DropRunIndex(dropped) => { ...projected, runEntries: projected.runEntries.select(entry => entry.runId != dropped.runId) }
  | EnsureRunMember(ensured) => {
      globalIds: if (projected.globalIds.includes(ensured.id)) projected.globalIds else projected.globalIds.append(ensured.id),
      runEntries: if (projected.runEntries.some(entry => entry.runId == ensured.runId and entry.traceId == ensured.id)) projected.runEntries else projected.runEntries.append({runId: ensured.runId, traceId: ensured.id}) }
}
pure def replayTraceEffects(projected: TraceProjection, effects: List[TraceEffect]): TraceProjection = effects.foldl(projected, (value, instruction) => applyTraceProjectionEffect(value, instruction))
pure def auditTraceProjectionEffect(audit: TraceEffectAudit, instruction: TraceEffect, beforeEntries: List[RunEntry], via: str): TraceEffectAudit = match instruction {
  | RemoveRunMember(removed) => { ...audit, seenRemoves: audit.seenRemoves.append({runId: removed.runId, traceId: removed.id}) }
  | DropRunIndex(dropped) => { ...audit, valid: audit.valid and (via == "finalizeRun" or beforeEntries.every(entry => entry.runId != dropped.runId or audit.seenRemoves.some(prior => prior.runId == entry.runId and prior.traceId == entry.traceId))) }
  | EnsureRunMember(_) => { ...audit, valid: audit.valid and via == "recordTrace" }
  | _ => audit
}
pure def replayTraceEffectAudit(beforeEntries: List[RunEntry], via: str, effects: List[TraceEffect]): TraceEffectAudit = effects.foldl(emptyTraceEffectAudit, (audit, instruction) => auditTraceProjectionEffect(audit, instruction, beforeEntries, via))
pure def recordEffectAllowed(instruction: TraceEffect, id: str, targetRun: str): bool = match instruction {
  | RetireTrace(_) => false
  | EnsureRunMember(ensured) => ensured.id == id and ensured.runId == targetRun
  | RemoveRunMember(removed) => removed.id == id and removed.runId != targetRun
  | DropRunIndex(dropped) => dropped.runId != targetRun
}
pure def recordEffectsMatchCapture(effects: List[TraceEffect], id: str, targetRun: str): bool = effects.every(instruction => recordEffectAllowed(instruction, id, targetRun)) and effects.some(instruction => match instruction { | EnsureRunMember(ensured) => ensured.id == id and ensured.runId == targetRun | _ => false })
pure def stepEffectsMatchOwner(before: TraceState, via: str, after: TraceState, out: List[TraceEffect]): bool =
  alwaysTraceIdentitiesUnique(before) and alwaysRunIndexesOwned(before) implies replayTraceEffects(traceProjection(before), out) == traceProjection(after) and replayTraceEffectAudit(before.runEntries, via, out).valid
pure def stepRecordEffectsUseCapturedIdentity(before: TraceState, via: str, after: TraceState, out: List[TraceEffect]): bool = {
  val result = after.lastResult
  via == "recordTrace" implies match result {
    | TraceRecorded(receipt) => recordEffectsMatchCapture(out, receipt.id, receipt.runId)
    | TraceIgnored => out.length() == 0
    | _ => false }
}
```
