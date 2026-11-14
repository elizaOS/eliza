lemma TraceUniqueKeys(s: TraceState)
  ensures alwaysTraceIdentitiesUnique(s) ==
    (forall t :: t in s.traces ==> |ProofLib.Filter((other: Trace) => (other.id == t.id), s.traces)| == 1)
{}

lemma TraceSubsequenceUnique(base: seq<Trace>, keep: Trace -> bool)
  requires forall t :: t in base ==> |ProofLib.Filter((other: Trace) => (other.id == t.id), base)| == 1
  ensures forall t :: t in ProofLib.Filter(keep, base) ==>
    (|ProofLib.Filter((other: Trace) => (other.id == t.id), ProofLib.Filter(keep, base))| == 1)
{
  var retained := ProofLib.Filter(keep, base);
  forall t | t in retained
    ensures |ProofLib.Filter((other: Trace) => (other.id == t.id), retained)| == 1
  {
    var key := (other: Trace) => (other.id == t.id);
    ProofLib.FilterMember(keep, base, t);
    ProofLib.FilterOfFilterShorter(keep, key, base);
    ProofLib.FilterMember(key, retained, t);
  }
}

lemma TraceMapKeys(base: seq<Trace>, changed: seq<Trace>)
  requires forall t :: t in base ==> |ProofLib.Filter((other: Trace) => (other.id == t.id), base)| == 1
  requires |base| == |changed|
  requires forall i :: 0 <= i < |base| ==> base[i].id == changed[i].id
  ensures traceIds(base) == traceIds(changed)
  ensures forall t :: t in changed ==> |ProofLib.Filter((other: Trace) => (other.id == t.id), changed)| == 1
{
  assert forall i :: 0 <= i < |base| ==> traceIds(base)[i] == traceIds(changed)[i];
  forall t | t in changed
    ensures |ProofLib.Filter((other: Trace) => (other.id == t.id), changed)| == 1
  {
    var i :| 0 <= i < |changed| && changed[i] == t;
    assert base[i] in base;
    var key := (other: Trace) => (other.id == t.id);
    ProofLib.FilterLengthPointwise(key, key, base, changed);
  }
}

lemma TraceAppendKey(base: seq<Trace>, added: Trace)
  requires forall t :: t in base ==> |ProofLib.Filter((other: Trace) => (other.id == t.id), base)| == 1
  requires !(exists t :: t in base && t.id == added.id)
  ensures traceIds(base + [added]) == traceIds(base) + [added.id]
  ensures forall t :: t in base + [added] ==> |ProofLib.Filter((other: Trace) => (other.id == t.id), base + [added])| == 1
{
  assert forall i :: 0 <= i < |base + [added]| ==> traceIds(base + [added])[i] == (traceIds(base) + [added.id])[i];
  forall t | t in base + [added]
    ensures |ProofLib.Filter((other: Trace) => (other.id == t.id), base + [added])| == 1
  {
    var key := (other: Trace) => (other.id == t.id);
    ProofLib.FilterAppend(key, base, added);
    if t == added {
      ProofLib.FilterNone(key, base);
    } else {
      assert t in base;
    }
  }
}

lemma recordTrace_ensures(s: TraceState, trace: Trace)
  ensures (inv(s) ==> canRecordTrace(s, trace) ==> alwaysTraceIdentitiesUnique(recordTrace(s, trace)))
  ensures (inv(s) ==> canRecordTrace(s, trace) ==> alwaysPurgeCounterNonnegative(recordTrace(s, trace)))
  ensures (inv(s) ==> canRecordTrace(s, trace) ==> stepRecordCountsEveryAttempt(s, "recordTrace", recordTrace(s, trace)))
  ensures (inv(s) ==> canRecordTrace(s, trace) ==> stepEnrichmentStaysInOneRun(s, "recordTrace", recordTrace(s, trace)))
  ensures (inv(s) ==> canRecordTrace(s, trace) ==> stepConflictPreservesTraces(s, "recordTrace", recordTrace(s, trace)))
  ensures (inv(s) ==> canRecordTrace(s, trace) ==> stepIndexInsertionOrder(s, "recordTrace", recordTrace(s, trace)))
{
  if inv(s) && canRecordTrace(s, trace) {
    var before := recordBase(s);
    var after := recordTrace(s, trace);
    TraceUniqueKeys(s);
    TraceUniqueKeys(after);
    if remainder_core__traces(s.purgeCounter + 1, 100) == 0 {
      TraceSubsequenceUnique(s.traces, (row: Trace) => ((s.now - row.createdAt) <= 300000));
    }
    if trace.runId != "" {
      if exists t :: t in before && t.id == trace.id {
        forall i | 0 <= i < |before|
          ensures before[i].id == after.traces[i].id
        {}
        TraceMapKeys(before, after.traces);
      } else {
        TraceAppendKey(before, trace);
      }
    }
  }
}

lemma enrichTraces_ensures(s: TraceState, runId: string, id: string, signal: string)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(enrichTraces(s, runId, id, signal)))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(enrichTraces(s, runId, id, signal)))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "enrichTraces", enrichTraces(s, runId, id, signal)))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "enrichTraces", enrichTraces(s, runId, id, signal)))
  ensures (inv(s) ==> stepConflictPreservesTraces(s, "enrichTraces", enrichTraces(s, runId, id, signal)))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "enrichTraces", enrichTraces(s, runId, id, signal)))
{
  if inv(s) {
    var after := enrichTraces(s, runId, id, signal);
    TraceUniqueKeys(s);
    TraceUniqueKeys(after);
    forall i | 0 <= i < |s.traces|
      ensures s.traces[i].id == after.traces[i].id
    {}
    TraceMapKeys(s.traces, after.traces);
    forall prior, later | prior in s.traces && later in after.traces && prior.id == later.id && prior.runId != runId
      ensures prior == later
    {
      var i :| 0 <= i < |after.traces| && after.traces[i] == later;
      var j :| 0 <= j < |s.traces| && s.traces[j] == prior;
      var key := (other: Trace) => (other.id == prior.id);
      if i != j {
        ProofLib.FilterTwo(key, s.traces, i, j);
        assert false;
      }
    }
  }
}

lemma lawRunViewKeepsOwners_ensures(s: TraceState, runId: string)
  ensures (lawRunViewKeepsOwners(s, runId) == true)
{
  forall trace | trace in runTraces(s, runId)
    ensures trace.runId == runId
  {
    ProofLib.FilterMember((trace: Trace) => (trace.runId == runId), s.traces, trace);
  }
}

lemma deleteTrace_ensures(s: TraceState, id: string)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(deleteTrace(s, id)))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(deleteTrace(s, id)))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "deleteTrace", deleteTrace(s, id)))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "deleteTrace", deleteTrace(s, id)))
  ensures (inv(s) ==> stepConflictPreservesTraces(s, "deleteTrace", deleteTrace(s, id)))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "deleteTrace", deleteTrace(s, id)))
{
  if inv(s) {
    TraceUniqueKeys(s);
    TraceUniqueKeys(deleteTrace(s, id));
    TraceSubsequenceUnique(s.traces, (t: Trace) => !((t.id in [id])));
  }
}

lemma finalizeRun_ensures(s: TraceState, runId: string)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(finalizeRun(s, runId)))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(finalizeRun(s, runId)))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "finalizeRun", finalizeRun(s, runId)))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "finalizeRun", finalizeRun(s, runId)))
  ensures (inv(s) ==> stepConflictPreservesTraces(s, "finalizeRun", finalizeRun(s, runId)))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "finalizeRun", finalizeRun(s, runId)))
{
  if inv(s) {
    TraceUniqueKeys(s);
    TraceUniqueKeys(finalizeRun(s, runId));
    TraceSubsequenceUnique(s.traces, (t: Trace) => (t.runId != runId));
  }
}

lemma purgeTraces_ensures(s: TraceState)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(purgeTraces(s)))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(purgeTraces(s)))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "purgeTraces", purgeTraces(s)))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "purgeTraces", purgeTraces(s)))
  ensures (inv(s) ==> stepConflictPreservesTraces(s, "purgeTraces", purgeTraces(s)))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "purgeTraces", purgeTraces(s)))
{
  if inv(s) {
    TraceUniqueKeys(s);
    TraceUniqueKeys(purgeTraces(s));
    TraceSubsequenceUnique(s.traces, (trace: Trace) => ((s.now - trace.createdAt) <= 300000));
  }
}
