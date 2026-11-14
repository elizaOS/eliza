# Active prompt traces and run indexes

The source is `packages/core/src/runtime/active-prompt-traces.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. The new-core model retains the active ID map and per-run insertion-ordered ID sets, and rejects cross-run identity reuse before mutation. Same-run re-recording replaces trace content without moving its insertion slot. This corrects the source alias bug documented in the baseline: source re-recording can retain old run aliases and allow one run deletion to erase another run's trace.

## Story: Retain enrich and retire active trace records

As a runtime I record complete trace identities and score-signal references, enrich all selected active traces in a run index, and retire expired records without discarding unexpired peers. The five-minute TTL is fixed. Every admitted record attempt increments the purge counter, including a trace whose run ID is empty. Cross-run reuse returns the typed `TraceIdentityConflict` failure without changing stored records, indexes or the purge cadence. Every hundredth record purges before inserting the new trace.

### Recording preserves map replacement and independent run-index order

```quint
type Trace = {id: str, runId: str, createdAt: int, signals: List[str], enrichedAt: int}
type RunTraceIndex = {runId: str, ids: List[str]}
type TraceRecordResult = NoRecordResult | TraceRecorded | TraceIgnored | TraceIdentityConflict
pure val recordedResult: TraceRecordResult = TraceRecorded
pure val ignoredResult: TraceRecordResult = TraceIgnored
type TraceState = {now: int, purgeCounter: int, traces: List[Trace], runs: List[RunTraceIndex], lastResult: TraceRecordResult, rejectedId: str, registeredRun: str, requestedRun: str, lastEnrichedRun: str}
pure val initial: TraceState = {now: 0, purgeCounter: 0, traces: List(), runs: List(), lastResult: NoRecordResult, rejectedId: "", registeredRun: "", requestedRun: "", lastEnrichedRun: ""}
pure val traceValues = Set({id: "trace-a", runId: "run-a", createdAt: 0, signals: List(), enrichedAt: 0}, {id: "trace-a", runId: "run-b", createdAt: 0, signals: List(), enrichedAt: 0}, {id: "trace-b", runId: "run-a", createdAt: 1, signals: List("existing"), enrichedAt: 0}, {id: "ignored", runId: "", createdAt: 0, signals: List(), enrichedAt: 0})
pure val idValues = Set("trace-a", "trace-b", "missing", "")
pure val runIdValues = Set("run-a", "run-b", "")
pure val signalValues = Set("score-a", "score-b")
pure val nowValues = Set(0, 1, 300000, 300001, 300002)
pure val emptyTrace: Trace = {id: "", runId: "", createdAt: 0, signals: List(), enrichedAt: 0}
pure def indexedIds(s: TraceState, runId: str): List[str] = s.runs.select(r => r.runId == runId).nthOr(0, {runId: "", ids: List()}).ids
pure def runTraces(s: TraceState, runId: str): List[Trace] = indexedIds(s, runId).select(id => s.traces.some(t => t.id == id)).listMap(id => s.traces.select(t => t.id == id).nthOr(0, emptyTrace))
pure def latestTrace(s: TraceState, runId: str): str = {
  val traces = runTraces(s, runId)
  traces.nthOr(traces.length() - 1, emptyTrace).id
}
pure def withoutIds(ids: List[str], s: TraceState): TraceState = { ...s, traces: s.traces.select(t => not(ids.includes(t.id))), runs: s.runs.listMap(r => { ...r, ids: r.ids.select(id => not(ids.includes(id))) }).select(r => r.ids.length() > 0) }
pure def purged(s: TraceState): TraceState = withoutIds(s.traces.select(t => s.now - t.createdAt > 300000).listMap(t => t.id), s)
pure def recordConflict(s: TraceState, trace: Trace): bool = trace.runId != "" and (s.traces.some(t => t.id == trace.id and t.runId != trace.runId) or s.runs.some(r => r.runId != trace.runId and r.ids.includes(trace.id)))
pure def canRecordTrace(s: TraceState, trace: Trace): bool = not(recordConflict(s, trace))
pure def canRejectTrace(s: TraceState, trace: Trace): bool = recordConflict(s, trace)
pure def rejectTrace(s: TraceState, trace: Trace): TraceState = { ...s, lastResult: TraceIdentityConflict, rejectedId: trace.id, registeredRun: s.runs.select(r => r.ids.includes(trace.id) and r.runId != trace.runId).nthOr(0, {runId: "", ids: List()}).runId, requestedRun: trace.runId }
pure def recordTrace(s: TraceState, trace: Trace): TraceState = {
  val counted = { ...s, purgeCounter: s.purgeCounter + 1, lastResult: if (trace.runId == "") ignoredResult else recordedResult, rejectedId: "", registeredRun: "", requestedRun: "" }
  val clean = if (counted.purgeCounter % 100 == 0) purged(counted) else counted
  if (trace.runId == "") clean else { ...clean, traces: if (clean.traces.some(t => t.id == trace.id)) clean.traces.listMap(t => if (t.id == trace.id) trace else t) else clean.traces.append(trace), runs: if (clean.runs.some(r => r.runId == trace.runId)) clean.runs.listMap(r => if (r.runId == trace.runId and not(r.ids.includes(trace.id))) { ...r, ids: r.ids.append(trace.id) } else r) else clean.runs.append({runId: trace.runId, ids: List(trace.id)}) }
}
pure def enrichTraces(s: TraceState, runId: str, id: str, signal: str): TraceState = { ...s, lastEnrichedRun: runId, traces: s.traces.listMap(t => if (indexedIds(s, runId).includes(t.id) and (id == "" or t.id == id)) { ...t, signals: t.signals.append(signal), enrichedAt: s.now } else t) }
pure def deleteTrace(s: TraceState, id: str): TraceState = withoutIds(List(id), s)
pure def finalizeRun(s: TraceState, runId: str): TraceState = { ...s, traces: s.traces.select(t => not(indexedIds(s, runId).includes(t.id))), runs: s.runs.select(r => r.runId != runId) }
pure def purgeTraces(s: TraceState): TraceState = purged(s)
pure def setClock(s: TraceState, now: int): TraceState = { ...s, now: now }
pure def alwaysTraceIdentitiesUnique(s: TraceState): bool = s.traces.every(t => s.traces.select(other => other.id == t.id).length() == 1)
pure def alwaysRunIndexUnique(s: TraceState): bool = s.runs.every(r => r.ids.length() > 0 and s.runs.select(other => other.runId == r.runId).length() == 1 and r.ids.every(id => r.ids.select(other => other == id).length() == 1))
pure def alwaysPurgeCounterNonnegative(s: TraceState): bool = s.purgeCounter >= 0
pure def stepRecordCountsEveryAttempt(before: TraceState, via: str, after: TraceState): bool = via == "recordTrace" implies after.purgeCounter == before.purgeCounter + 1
pure def stepEnrichmentStaysInOneRun(before: TraceState, via: str, after: TraceState): bool = via == "enrichTraces" implies before.traces.length() == after.traces.length() and before.runs == after.runs and before.traces.every(t => after.traces.every(other => t.id != other.id or t.signals == other.signals or t.runId == after.lastEnrichedRun))
type TraceIndexOrder = {seenFirst: bool, found: bool}
pure val emptyTraceIndexOrder: TraceIndexOrder = {seenFirst: false, found: false}
pure def orderedBefore(ids: List[str], first: str, second: str): bool = ids.foldl(emptyTraceIndexOrder, (acc, id) => {seenFirst: acc.seenFirst or id == first, found: acc.found or (acc.seenFirst and id == second)}).found
pure def expiredBeforeCadence(s: TraceState, id: str): bool = (s.purgeCounter + 1) % 100 == 0 and s.traces.some(t => t.id == id and s.now - t.createdAt > 300000)
pure def stepIndexInsertionOrder(before: TraceState, via: str, after: TraceState): bool = before.runs.every(r => after.runs.every(later => r.runId != later.runId or r.ids.every(first => r.ids.every(second => (orderedBefore(r.ids, first, second) and later.ids.includes(first) and later.ids.includes(second)) implies orderedBefore(later.ids, first, second) or (via == "recordTrace" and (expiredBeforeCadence(before, first) or expiredBeforeCadence(before, second)))))))
pure def sometimesTwoTracesInOneRun(s: TraceState): bool = s.runs.some(r => runTraces(s, r.runId).length() > 1)
pure def sometimesTraceEnriched(s: TraceState): bool = s.traces.some(t => t.signals.length() > 0 and t.enrichedAt == s.now)
pure def sometimesTraceAtTtlRetained(s: TraceState): bool = s.traces.some(t => s.now - t.createdAt == 300000)
pure def sometimesAllTracesFinalized(s: TraceState): bool = s.purgeCounter > 0 and s.traces.length() == 0
pure def alwaysIndexAgreesWithOwners(s: TraceState): bool = s.runs.every(r => r.ids.every(id => s.traces.some(t => t.id == id and t.runId == r.runId))) and s.traces.every(t => s.runs.some(r => r.runId == t.runId and r.ids.includes(t.id)))
pure def stepConflictPreservesTraces(before: TraceState, via: str, after: TraceState): bool = via == "rejectTrace" implies after.traces == before.traces and after.runs == before.runs and after.purgeCounter == before.purgeCounter
pure def sometimesCrossRunReuseRejected(s: TraceState): bool = s.lastResult == TraceIdentityConflict and s.registeredRun != s.requestedRun and s.runs.some(r => r.runId == s.registeredRun and r.ids.includes(s.rejectedId))
```

### Expired trace progress follows the observed wall clock

Discovered by simulation: moving the wall clock backward can make a previously expired trace fresh again. Fair purge promises removal while the expiry condition persists. The progress obligation is discharged by retirement or by an observation that revokes expiry; unconditional retirement requires an additional monotonic elapsed-clock contract.

```quint
pure val fair_purgeTraces = "weak"
pure def leadsToStaleTraceReevaluated(s: TraceState, later: TraceState): bool = s.traces.every(t => s.now - t.createdAt > 300000 implies not(later.traces.some(other => other.id == t.id and other == t)) or later.now - t.createdAt <= 300000)
```
