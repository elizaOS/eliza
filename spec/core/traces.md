# Active prompt traces and run indexes

The source is `packages/core/src/runtime/active-prompt-traces.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. The model stores one insertion-ordered list and derives the active ID and per-run views from it. Cross-run identity reuse fails before mutation. Same-run re-recording replaces trace content without moving its insertion slot. This corrects the source alias bug documented in the baseline: source re-recording can retain old run aliases and allow one run deletion to erase another run's trace.

## Story: Retain enrich and retire active trace records

As a runtime I record complete trace identities and score-signal references, enrich all selected active traces in a run index, and retire expired records without discarding unexpired peers. The five-minute TTL is fixed. Every admitted record attempt increments the purge counter, including a trace whose run ID is empty. Cross-run reuse returns the typed `TraceIdentityConflict` failure without changing stored records, indexes or the purge cadence. Every hundredth record purges before inserting the new trace.

### Recording preserves the insertion position of a replacement in its run

An active ID identifies one trace across every run. Viewing one run filters
the same ordered collection. Updating an existing trace or its score
signals keeps its position. A new ID is appended and a purged ID can be
recorded again at the new end. The captured signal and composite-score inputs
stay attached to the selected trace. Composite score calculation follows
the [score card model](./scoreCard.md).

```quint
type Trace = {id: str, runId: str, createdAt: int, signals: List[str], enrichedAt: int}
type TraceRecordResult = NoRecordResult | TraceRecorded | TraceIgnored | TraceIdentityConflict
pure val recordedResult: TraceRecordResult = TraceRecorded
pure val ignoredResult: TraceRecordResult = TraceIgnored
type TraceState = {now: int, purgeCounter: int, traces: List[Trace], lastResult: TraceRecordResult, rejectedId: str, registeredRun: str, requestedRun: str, lastEnrichedRun: str}
pure val initial: TraceState = {now: 0, purgeCounter: 0, traces: List(), lastResult: NoRecordResult, rejectedId: "", registeredRun: "", requestedRun: "", lastEnrichedRun: ""}
pure val traceValues = Set({id: "trace-a", runId: "run-a", createdAt: 0, signals: List(), enrichedAt: 0}, {id: "trace-a", runId: "run-b", createdAt: 0, signals: List(), enrichedAt: 0}, {id: "trace-b", runId: "run-a", createdAt: 1, signals: List("existing"), enrichedAt: 0}, {id: "ignored", runId: "", createdAt: 0, signals: List(), enrichedAt: 0})
pure val idValues = Set("trace-a", "trace-b", "missing", "")
pure val runIdValues = Set("run-a", "run-b", "")
pure val signalValues = Set("score-a", "score-b")
pure val nowValues = Set(0, 1, 300000, 300001, 300002)
pure val emptyTrace: Trace = {id: "", runId: "", createdAt: 0, signals: List(), enrichedAt: 0}
pure def runTraces(s: TraceState, runId: str): List[Trace] = s.traces.select(trace => trace.runId == runId)
pure def indexedIds(s: TraceState, runId: str): List[str] = runTraces(s, runId).listMap(trace => trace.id)
pure def latestTrace(s: TraceState, runId: str): str = {
  val traces = runTraces(s, runId)
  traces.nthOr(traces.length() - 1, emptyTrace).id
}
pure def withoutIds(ids: List[str], s: TraceState): TraceState =
  { ...s, traces: s.traces.select(t => not(ids.includes(t.id))) }
pure def purgeAt(traces: List[Trace], now: int): List[Trace] =
  traces.select(trace => now - trace.createdAt <= 300000)
pure def recordConflict(s: TraceState, trace: Trace): bool =
  trace.runId != "" and s.traces.some(t => t.id == trace.id and t.runId != trace.runId)
pure def canRecordTrace(s: TraceState, trace: Trace): bool = not(recordConflict(s, trace))
pure def canRejectTrace(s: TraceState, trace: Trace): bool = recordConflict(s, trace)
pure def rejectTrace(s: TraceState, trace: Trace): TraceState =
  { ...s, lastResult: TraceIdentityConflict, rejectedId: trace.id,
    registeredRun: s.traces.select(t => t.id == trace.id and t.runId != trace.runId).nthOr(0, emptyTrace).runId,
    requestedRun: trace.runId }
pure def recordBase(s: TraceState): List[Trace] =
  if ((s.purgeCounter + 1) % 100 == 0) purgeAt(s.traces, s.now) else s.traces
pure def installTrace(base: List[Trace], trace: Trace): List[Trace] =
  if (trace.runId == "") base
  else if (base.some(t => t.id == trace.id)) base.listMap(t => if (t.id == trace.id) trace else t)
  else base.append(trace)
pure def recordTrace(s: TraceState, trace: Trace): TraceState =
  { ...s, traces: installTrace(recordBase(s), trace), purgeCounter: s.purgeCounter + 1,
    lastResult: if (trace.runId == "") ignoredResult else recordedResult,
    rejectedId: "", registeredRun: "", requestedRun: "" }
pure def enrichTraces(s: TraceState, runId: str, id: str, signal: str): TraceState =
  { ...s, lastEnrichedRun: runId, traces: s.traces.listMap(t =>
    if (t.runId == runId and (id == "" or t.id == id)) { ...t, signals: t.signals.append(signal), enrichedAt: s.now } else t) }
pure def deleteTrace(s: TraceState, id: str): TraceState = withoutIds(List(id), s)
pure def finalizeRun(s: TraceState, runId: str): TraceState =
  { ...s, traces: s.traces.select(t => t.runId != runId) }
pure def purgeTraces(s: TraceState): TraceState = { ...s, traces: purgeAt(s.traces, s.now) }
pure def setClock(s: TraceState, now: int): TraceState = { ...s, now: now }
pure def alwaysTraceIdentitiesUnique(s: TraceState): bool = s.traces.every(t => s.traces.select(other => other.id == t.id).length() == 1)
pure def alwaysPurgeCounterNonnegative(s: TraceState): bool = s.purgeCounter >= 0
pure def stepRecordCountsEveryAttempt(before: TraceState, via: str, after: TraceState): bool = via == "recordTrace" implies after.purgeCounter == before.purgeCounter + 1
pure def traceIds(traces: List[Trace]): List[str] = traces.listMap(trace => trace.id)
pure def stepEnrichmentStaysInOneRun(before: TraceState, via: str, after: TraceState): bool =
  via == "enrichTraces" implies traceIds(before.traces) == traceIds(after.traces) and
    before.traces.every(t => after.traces.every(other =>
      t.id != other.id or t.runId == after.lastEnrichedRun or t == other))
pure def stepIndexInsertionOrder(before: TraceState, via: str, after: TraceState): bool =
  via == "recordTrace" implies
    traceIds(after.traces) == traceIds(recordBase(before)) or
      (traceIds(after.traces).length() == traceIds(recordBase(before)).length() + 1 and
        traceIds(after.traces).removeAt(after.traces.length() - 1) == traceIds(recordBase(before)))
pure def sometimesTwoTracesInOneRun(s: TraceState): bool =
  s.traces.some(trace => runTraces(s, trace.runId).length() > 1)
pure def sometimesTraceEnriched(s: TraceState): bool = s.traces.some(t => t.signals.length() > 0 and t.enrichedAt == s.now)
pure def sometimesTraceAtTtlRetained(s: TraceState): bool = s.traces.some(t => s.now - t.createdAt == 300000)
pure def sometimesAllTracesFinalized(s: TraceState): bool = s.purgeCounter > 0 and s.traces.length() == 0
pure val tracesValues = Set(List(), List(emptyTrace))
pure val sValues = Set(initial, { ...initial, traces: List({ ...emptyTrace, id: "trace-a", runId: "run-a" }) })
pure def lawRunViewKeepsOwners(s: TraceState, runId: str): bool =
  runTraces(s, runId).every(trace => trace.runId == runId)
pure def stepConflictPreservesTraces(before: TraceState, via: str, after: TraceState): bool =
  via == "rejectTrace" implies after.traces == before.traces and after.purgeCounter == before.purgeCounter
pure def sometimesCrossRunReuseRejected(s: TraceState): bool =
  s.lastResult == TraceIdentityConflict and s.registeredRun != s.requestedRun and
    indexedIds(s, s.registeredRun).includes(s.rejectedId)
```

### Expired trace progress follows the observed wall clock

Discovered by simulation: moving the wall clock backward can make a previously expired trace fresh again. Fair purge promises removal while the expiry condition persists. The progress obligation is discharged by retirement or by an observation that revokes expiry; unconditional retirement requires an additional monotonic elapsed-clock contract.

```quint
pure val fair_purgeTraces = "weak"
pure def leadsToStaleTraceReevaluated(s: TraceState, later: TraceState): bool = s.traces.every(t => s.now - t.createdAt > 300000 implies not(later.traces.some(other => other.id == t.id and other == t)) or later.now - t.createdAt <= 300000)
```
