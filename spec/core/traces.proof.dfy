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

lemma TraceOwnerView(s: TraceState)
  ensures alwaysRunIndexesOwned(s) == ((forall trace :: trace in s.traces ==> trace.runId != "" && |ProofLib.Filter((entry: RunEntry) => (entry.traceId == trace.id), s.runEntries)| == 1) && (forall entry :: entry in s.runEntries ==> exists trace :: trace in s.traces && trace.id == entry.traceId && trace.runId == entry.runId))
{}

lemma TraceLookupView(s: TraceState, id: string)
  ensures traceFor(s, id) == (if |ProofLib.Filter((trace: Trace) => (trace.id == id), s.traces)| > 0 then ProofLib.Filter((trace: Trace) => (trace.id == id), s.traces)[0] else noTrace)
{}

lemma TraceLookupUnique(s: TraceState, trace: Trace)
  requires alwaysTraceIdentitiesUnique(s) && trace in s.traces
  ensures traceFor(s, trace.id) == trace
{
  TraceUniqueKeys(s); TraceLookupView(s, trace.id);
  ProofLib.FilterMember((other: Trace) => (other.id == trace.id), s.traces, trace);
}

lemma TraceIndexOwner(s: TraceState, entry: RunEntry)
  requires alwaysTraceIdentitiesUnique(s) && alwaysRunIndexesOwned(s) && entry in s.runEntries
  ensures traceFor(s, entry.traceId).id == entry.traceId && traceFor(s, entry.traceId).runId == entry.runId
{
  TraceOwnerView(s);
  var trace :| trace in s.traces && trace.id == entry.traceId && trace.runId == entry.runId;
  TraceLookupUnique(s, trace);
}

lemma TraceIndexView(s: TraceState, runId: string)
  ensures indexedIds(s, runId) == (var entries := ProofLib.Filter((entry: RunEntry) => (entry.runId == runId), s.runEntries); seq(|entries|, i requires 0 <= i < |entries| => entries[i].traceId))
{}

lemma TraceIndexMembership(s: TraceState, runId: string, id: string)
  ensures id in indexedIds(s, runId) <==> exists entry :: entry in s.runEntries && entry.runId == runId && entry.traceId == id
{
  TraceIndexView(s, runId);
  var entries := ProofLib.Filter((entry: RunEntry) => (entry.runId == runId), s.runEntries);
  if id in indexedIds(s, runId) {
    var i :| 0 <= i < |indexedIds(s, runId)| && indexedIds(s, runId)[i] == id;
    ProofLib.FilterMember((entry: RunEntry) => (entry.runId == runId), s.runEntries, entries[i]);
  }
  if exists entry :: entry in s.runEntries && entry.runId == runId && entry.traceId == id {
    var entry :| entry in s.runEntries && entry.runId == runId && entry.traceId == id;
    ProofLib.FilterMember((entry: RunEntry) => (entry.runId == runId), s.runEntries, entry);
    var i :| 0 <= i < |entries| && entries[i] == entry;
    assert indexedIds(s, runId)[i] == id;
  }
}

lemma TraceRemovedView(ids: seq<string>, s: TraceState)
  ensures withoutIds(ids, s).traces == ProofLib.Filter((trace: Trace) => !((trace.id in ids)), s.traces)
  ensures withoutIds(ids, s).runEntries == ProofLib.Filter((entry: RunEntry) => !((entry.traceId in ids)), s.runEntries)
{}

lemma TraceRemoveIds(s: TraceState, ids: seq<string>)
  requires inv(s)
  ensures inv(withoutIds(ids, s))
{
  var after := withoutIds(ids, s);
  TraceUniqueKeys(s); TraceUniqueKeys(after); TraceOwnerView(s); TraceOwnerView(after); TraceRemovedView(ids, s);
  TraceSubsequenceUnique(s.traces, (trace: Trace) => !((trace.id in ids)));
  forall trace | trace in after.traces
    ensures trace.runId != "" && |ProofLib.Filter((entry: RunEntry) => (entry.traceId == trace.id), after.runEntries)| == 1
    ensures trace.enrichments >= 0
  {
    ProofLib.FilterMember((trace: Trace) => !((trace.id in ids)), s.traces, trace);
    var key := (entry: RunEntry) => (entry.traceId == trace.id);
    var oldMatches := ProofLib.Filter(key, s.runEntries);
    assert |oldMatches| == 1;
    var entry := oldMatches[0];
    ProofLib.FilterMember(key, s.runEntries, entry);
    ProofLib.FilterMember((entry: RunEntry) => !((entry.traceId in ids)), s.runEntries, entry);
    ProofLib.FilterMember(key, after.runEntries, entry);
    ProofLib.FilterOfFilterShorter((entry: RunEntry) => !((entry.traceId in ids)), key, s.runEntries);
  }
  forall entry | entry in after.runEntries
    ensures exists trace :: trace in after.traces && trace.id == entry.traceId && trace.runId == entry.runId
  {
    ProofLib.FilterMember((entry: RunEntry) => !((entry.traceId in ids)), s.runEntries, entry);
    var trace :| trace in s.traces && trace.id == entry.traceId && trace.runId == entry.runId;
    ProofLib.FilterMember((trace: Trace) => !((trace.id in ids)), s.traces, trace);
  }
}

lemma TraceMapOwnerFrame(before: TraceState, after: TraceState)
  requires alwaysTraceIdentitiesUnique(before) && alwaysRunIndexesOwned(before)
  requires after.runEntries == before.runEntries && |after.traces| == |before.traces|
  requires forall i :: 0 <= i < |before.traces| ==> after.traces[i].id == before.traces[i].id && after.traces[i].runId == before.traces[i].runId
  ensures alwaysTraceIdentitiesUnique(after) && alwaysRunIndexesOwned(after)
{
  TraceUniqueKeys(before); TraceUniqueKeys(after); TraceOwnerView(before); TraceOwnerView(after);
  TraceMapKeys(before.traces, after.traces);
  forall trace | trace in after.traces
    ensures trace.runId != "" && |ProofLib.Filter((entry: RunEntry) => (entry.traceId == trace.id), after.runEntries)| == 1
  {
    var i :| 0 <= i < |after.traces| && after.traces[i] == trace;
    assert before.traces[i] in before.traces;
  }
  forall entry | entry in after.runEntries
    ensures exists trace :: trace in after.traces && trace.id == entry.traceId && trace.runId == entry.runId
  {
    var trace :| trace in before.traces && trace.id == entry.traceId && trace.runId == entry.runId;
    var i :| 0 <= i < |before.traces| && before.traces[i] == trace;
    assert after.traces[i] in after.traces;
  }
}

lemma TraceAdmitView(s: TraceState, id: string, runId: string)
  requires runId != ""
  ensures recordTrace(s, id, runId).state.runEntries == (var remaining := ProofLib.Filter((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), s.runEntries); if exists entry :: entry in remaining && entry.runId == runId && entry.traceId == id then remaining else remaining + [RunEntry(runId, id)])
{}

lemma TraceAdmittedPresent(s: TraceState, id: string, runId: string)
  requires runId != ""
  ensures Trace(id, runId, 0) in recordTrace(s, id, runId).state.traces
{
  if exists trace :: trace in s.traces && trace.id == id {
    var trace :| trace in s.traces && trace.id == id;
    var i :| 0 <= i < |s.traces| && s.traces[i] == trace;
    assert recordTrace(s, id, runId).state.traces[i] == Trace(id, runId, 0);
  }
}

lemma TraceSelectPreserved(entries: seq<RunEntry>, id: string, runId: string, selected: RunEntry -> bool)
  requires forall entry :: entry in entries && selected(entry) ==> entry.traceId != id || entry.runId == runId
  ensures ProofLib.Filter(selected, ProofLib.Filter((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), entries)) == ProofLib.Filter(selected, entries)
  decreases |entries|
{
  var keep := (entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId));
  ProofLib.FilterSamePredicate(keep, (entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), entries);
  if |entries| == 0 {
    ProofLib.FilterNil(keep, entries); ProofLib.FilterNil(selected, entries); ProofLib.FilterNil(selected, []);
  } else {
    TraceSelectPreserved(entries[1..], id, runId, selected);
    ProofLib.FilterSamePredicate(keep, (entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), entries[1..]);
    var rest := ProofLib.Filter(keep, entries[1..]);
    ProofLib.FilterCons(keep, entries); ProofLib.FilterCons(selected, entries);
    if keep(entries[0]) {
      ProofLib.FilterCons(selected, [entries[0]] + rest);
      assert ([entries[0]] + rest)[1..] == rest;
      assert ProofLib.Filter(selected, rest) == ProofLib.Filter(selected, entries[1..]);
      calc {
        ProofLib.Filter(selected, ProofLib.Filter(keep, entries));
        == ProofLib.Filter(selected, [entries[0]] + rest);
        == (if selected(entries[0]) then [entries[0]] else []) + ProofLib.Filter(selected, rest);
        == (if selected(entries[0]) then [entries[0]] else []) + ProofLib.Filter(selected, entries[1..]);
        == ProofLib.Filter(selected, entries);
      }
    } else {
      assert !selected(entries[0]);
      assert ProofLib.Filter(keep, entries) == rest;
      assert ProofLib.Filter(selected, entries) == ProofLib.Filter(selected, entries[1..]);
      assert ProofLib.Filter(selected, rest) == ProofLib.Filter(selected, entries[1..]);
    }
  }
}

lemma TraceAdmitOwner(s: TraceState, id: string, runId: string)
  requires inv(s) && runId != ""
  ensures inv(recordTrace(s, id, runId).state)
{
  var after := recordTrace(s, id, runId).state;
  var keep := (entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId));
  var remaining := ProofLib.Filter(keep, s.runEntries);
  var destination := RunEntry(runId, id);
  var hasDestination := exists entry :: entry in remaining && entry.runId == runId && entry.traceId == id;
  TraceUniqueKeys(s); TraceUniqueKeys(after); TraceOwnerView(s); TraceOwnerView(after); TraceAdmitView(s, id, runId); TraceAdmittedPresent(s, id, runId);
  if exists trace :: trace in s.traces && trace.id == id {
    forall i | 0 <= i < |s.traces| ensures after.traces[i].id == s.traces[i].id {}
    TraceMapKeys(s.traces, after.traces);
  } else { TraceAppendKey(s.traces, Trace(id, runId, 0)); }
  forall trace | trace in after.traces
    ensures trace.runId != "" && trace.enrichments >= 0
    ensures |ProofLib.Filter((entry: RunEntry) => (entry.traceId == trace.id), after.runEntries)| == 1
  {
    var key := (entry: RunEntry) => (entry.traceId == trace.id);
    var i :| 0 <= i < |after.traces| && after.traces[i] == trace;
    if exists prior :: prior in s.traces && prior.id == id {
      assert i < |s.traces|;
      assert trace == (if s.traces[i].id == id then Trace(id, runId, 0) else s.traces[i]);
    } else {
      if i < |s.traces| { assert trace == s.traces[i]; }
      else { assert i == |s.traces| && trace == Trace(id, runId, 0); }
    }
    if trace.id == id {
      assert trace == Trace(id, runId, 0);
      if hasDestination {
        var entry :| entry in remaining && entry.runId == runId && entry.traceId == id;
        ProofLib.FilterMember(keep, s.runEntries, entry);
        var prior :| prior in s.traces && prior.id == entry.traceId && prior.runId == entry.runId;
        assert |ProofLib.Filter(key, s.runEntries)| == 1;
        ProofLib.FilterOfFilterShorter(keep, key, s.runEntries);
        ProofLib.FilterMember(key, remaining, entry);
      } else {
        forall i | 0 <= i < |remaining| ensures !key(remaining[i]) {
          ProofLib.FilterMember(keep, s.runEntries, remaining[i]);
        }
        ProofLib.FilterNone(key, remaining);
        ProofLib.FilterAppend(key, remaining, destination);
      }
    } else {
      assert trace in s.traces;
      TraceSelectPreserved(s.runEntries, id, runId, key);
      if !hasDestination { ProofLib.FilterAppend(key, remaining, destination); }
    }
  }
  forall entry | entry in after.runEntries
    ensures exists trace :: trace in after.traces && trace.id == entry.traceId && trace.runId == entry.runId
  {
    assert entry in remaining || entry == destination;
    if entry in remaining { ProofLib.FilterMember(keep, s.runEntries, entry); }
    if entry.traceId == id {
      assert entry.runId == runId;
      assert Trace(id, runId, 0) in after.traces;
    } else {
      assert entry in s.runEntries;
      var trace :| trace in s.traces && trace.id == entry.traceId && trace.runId == entry.runId;
      var i :| 0 <= i < |s.traces| && s.traces[i] == trace;
      assert after.traces[i] == trace && trace in after.traces;
    }
  }
}

lemma TraceIndexAppend(before: TraceState, after: TraceState, entry: RunEntry, runId: string)
  requires after.runEntries == before.runEntries + [entry]
  ensures indexedIds(after, runId) == (if entry.runId == runId then indexedIds(before, runId) + [entry.traceId] else indexedIds(before, runId))
{
  TraceIndexView(before, runId); TraceIndexView(after, runId);
  ProofLib.FilterAppend((entry: RunEntry) => (entry.runId == runId), before.runEntries, entry);
  var oldIds := indexedIds(before, runId);
  var newIds := indexedIds(after, runId);
  if entry.runId == runId {
    assert |newIds| == |oldIds| + 1;
    forall i | 0 <= i < |newIds|
      ensures newIds[i] == (oldIds + [entry.traceId])[i]
    {
      if i == |oldIds| { } else { assert 0 <= i < |oldIds|; }
    }
  }
}

lemma TraceAdmitRunView(s: TraceState, id: string, runId: string, viewRun: string)
  requires runId != ""
  requires forall entry :: entry in s.runEntries && entry.runId == viewRun ==> entry.traceId != id || entry.runId == runId
  ensures indexedIds(recordTrace(s, id, runId).state, viewRun) == (if viewRun == runId && !(id in indexedIds(s, runId)) then indexedIds(s, viewRun) + [id] else indexedIds(s, viewRun))
{
  var remaining := ProofLib.Filter((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), s.runEntries);
  var middle := s.(runEntries := remaining);
  var after := recordTrace(s, id, runId).state;
  TraceAdmitView(s, id, runId);
  TraceSelectPreserved(s.runEntries, id, runId, (entry: RunEntry) => (entry.runId == viewRun));
  TraceIndexView(s, viewRun); TraceIndexView(middle, viewRun); TraceIndexView(after, viewRun);
  assert indexedIds(middle, viewRun) == indexedIds(s, viewRun);
  TraceIndexMembership(s, runId, id);
  if exists entry :: entry in remaining && entry.runId == runId && entry.traceId == id {
    var entry :| entry in remaining && entry.runId == runId && entry.traceId == id;
    ProofLib.FilterMember((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), s.runEntries, entry);
    assert id in indexedIds(s, runId);
  } else {
    if id in indexedIds(s, runId) {
      var entry :| entry in s.runEntries && entry.runId == runId && entry.traceId == id;
      ProofLib.FilterMember((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), s.runEntries, entry);
      assert false;
    }
    assert after.runEntries == remaining + [RunEntry(runId, id)];
    TraceIndexAppend(middle, after, RunEntry(runId, id), viewRun);
  }
}

lemma TraceAdmitUnrelatedRun(s: TraceState, id: string, runId: string, viewRun: string)
  requires inv(s) && runId != "" && viewRun != runId && viewRun != traceFor(s, id).runId
  ensures indexedIds(recordTrace(s, id, runId).state, viewRun) == indexedIds(s, viewRun)
{
  forall entry | entry in s.runEntries && entry.runId == viewRun
    ensures entry.traceId != id || entry.runId == runId
  {
    TraceIndexOwner(s, entry);
    assert entry.traceId != id;
  }
  TraceAdmitRunView(s, id, runId, viewRun);
}

lemma TraceRunView(s: TraceState, runId: string)
  requires alwaysTraceIdentitiesUnique(s) && alwaysRunIndexesOwned(s)
  ensures forall trace :: trace in runTraces(s, runId) ==> trace.runId == runId
{
  TraceIndexView(s, runId);
  var entries := ProofLib.Filter((entry: RunEntry) => (entry.runId == runId), s.runEntries);
  forall trace | trace in runTraces(s, runId) ensures trace.runId == runId {
    var i :| 0 <= i < |runTraces(s, runId)| && runTraces(s, runId)[i] == trace;
    var entry := entries[i];
    ProofLib.FilterMember((row: RunEntry) => (row.runId == runId), s.runEntries, entry);
    TraceIndexOwner(s, entry);
    assert indexedIds(s, runId)[i] == entry.traceId;
    assert trace == traceFor(s, entry.traceId);
  }
}

lemma enrichObservedTrace_ensures(s: TraceState, runId: string, id: string)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(enrichObservedTrace(s, runId, id).state))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(enrichObservedTrace(s, runId, id).state))
  ensures (inv(s) ==> alwaysRunIndexesOwned(enrichObservedTrace(s, runId, id).state))
  ensures (inv(s) ==> alwaysEnrichmentReceiptsNonnegative(enrichObservedTrace(s, runId, id).state))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "enrichObservedTrace", enrichObservedTrace(s, runId, id).state))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "enrichObservedTrace", enrichObservedTrace(s, runId, id).state))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "enrichObservedTrace", enrichObservedTrace(s, runId, id).state))
  ensures (inv(s) ==> stepTransferPreservesUnrelatedRuns(s, "enrichObservedTrace", enrichObservedTrace(s, runId, id).state))
  ensures (inv(s) ==> stepFinalizationPreservesCapturedSetMembers(s, "enrichObservedTrace", enrichObservedTrace(s, runId, id).state, enrichObservedTrace(s, runId, id).out))
  ensures (inv(s) ==> stepEffectsMatchOwner(s, "enrichObservedTrace", enrichObservedTrace(s, runId, id).state, enrichObservedTrace(s, runId, id).out))
  ensures (inv(s) ==> stepRecordEffectsUseCapturedIdentity(s, "enrichObservedTrace", enrichObservedTrace(s, runId, id).state, enrichObservedTrace(s, runId, id).out))
{
  if inv(s) {
    var after := enrichObservedTrace(s, runId, id).state;
    forall i | 0 <= i < |s.traces|
      ensures after.traces[i].id == s.traces[i].id && after.traces[i].runId == s.traces[i].runId
    {}
    TraceMapOwnerFrame(s, after);
    forall prior, later | prior in s.traces && later in after.traces && prior.id == later.id && prior.runId != runId
      ensures prior == later
    {
      var i :| 0 <= i < |after.traces| && after.traces[i] == later;
      var j :| 0 <= j < |s.traces| && s.traces[j] == prior;
      TraceUniqueKeys(s);
      if i != j { ProofLib.FilterTwo((other: Trace) => (other.id == prior.id), s.traces, i, j); assert false; }
    }
  }
}

lemma lawRunViewKeepsOwners_ensures(s: TraceState, runId: string)
  ensures (lawRunViewKeepsOwners(s, runId) == true)
{
  if alwaysTraceIdentitiesUnique(s) && alwaysRunIndexesOwned(s) { TraceRunView(s, runId); }
}

lemma recordTrace_ensures(s: TraceState, id: string, runId: string)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(recordTrace(s, id, runId).state))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(recordTrace(s, id, runId).state))
  ensures (inv(s) ==> alwaysRunIndexesOwned(recordTrace(s, id, runId).state))
  ensures (inv(s) ==> alwaysEnrichmentReceiptsNonnegative(recordTrace(s, id, runId).state))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "recordTrace", recordTrace(s, id, runId).state))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "recordTrace", recordTrace(s, id, runId).state))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "recordTrace", recordTrace(s, id, runId).state))
  ensures (inv(s) ==> stepTransferPreservesUnrelatedRuns(s, "recordTrace", recordTrace(s, id, runId).state))
  ensures (inv(s) ==> stepFinalizationPreservesCapturedSetMembers(s, "recordTrace", recordTrace(s, id, runId).state, recordTrace(s, id, runId).out))
  ensures (inv(s) ==> stepEffectsMatchOwner(s, "recordTrace", recordTrace(s, id, runId).state, recordTrace(s, id, runId).out))
  ensures (inv(s) ==> stepRecordEffectsUseCapturedIdentity(s, "recordTrace", recordTrace(s, id, runId).state, recordTrace(s, id, runId).out))
{
  if inv(s) && runId != "" {
    TraceAdmitOwner(s, id, runId);
    TraceRecordOutput(s, id, runId);
    forall entry | entry in s.runEntries && entry.runId != runId && entry.runId != traceFor(s, id).runId
      ensures indexedIds(recordTrace(s, id, runId).state, entry.runId) == indexedIds(s, entry.runId)
    {
      TraceAdmitUnrelatedRun(s, id, runId, entry.runId);
    }
  }
}

lemma deleteTrace_ensures(s: TraceState, id: string)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(deleteTrace(s, id).state))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(deleteTrace(s, id).state))
  ensures (inv(s) ==> alwaysRunIndexesOwned(deleteTrace(s, id).state))
  ensures (inv(s) ==> alwaysEnrichmentReceiptsNonnegative(deleteTrace(s, id).state))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "deleteTrace", deleteTrace(s, id).state))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "deleteTrace", deleteTrace(s, id).state))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "deleteTrace", deleteTrace(s, id).state))
  ensures (inv(s) ==> stepTransferPreservesUnrelatedRuns(s, "deleteTrace", deleteTrace(s, id).state))
  ensures (inv(s) ==> stepFinalizationPreservesCapturedSetMembers(s, "deleteTrace", deleteTrace(s, id).state, deleteTrace(s, id).out))
  ensures (inv(s) ==> stepEffectsMatchOwner(s, "deleteTrace", deleteTrace(s, id).state, deleteTrace(s, id).out))
  ensures (inv(s) ==> stepRecordEffectsUseCapturedIdentity(s, "deleteTrace", deleteTrace(s, id).state, deleteTrace(s, id).out))
{
  if inv(s) { TraceRemoveIds(s, [id]); TraceDeleteOutput(s, id, "deleteTrace"); }
}

lemma finalizeRun_ensures(s: TraceState, runId: string)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(finalizeRun(s, runId).state))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(finalizeRun(s, runId).state))
  ensures (inv(s) ==> alwaysRunIndexesOwned(finalizeRun(s, runId).state))
  ensures (inv(s) ==> alwaysEnrichmentReceiptsNonnegative(finalizeRun(s, runId).state))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "finalizeRun", finalizeRun(s, runId).state))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "finalizeRun", finalizeRun(s, runId).state))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "finalizeRun", finalizeRun(s, runId).state))
  ensures (inv(s) ==> stepTransferPreservesUnrelatedRuns(s, "finalizeRun", finalizeRun(s, runId).state))
  ensures (inv(s) ==> stepFinalizationPreservesCapturedSetMembers(s, "finalizeRun", finalizeRun(s, runId).state, finalizeRun(s, runId).out))
  ensures (inv(s) ==> stepEffectsMatchOwner(s, "finalizeRun", finalizeRun(s, runId).state, finalizeRun(s, runId).out))
  ensures (inv(s) ==> stepRecordEffectsUseCapturedIdentity(s, "finalizeRun", finalizeRun(s, runId).state, finalizeRun(s, runId).out))
{
  if inv(s) { TraceRemoveIds(s, indexedIds(s, runId)); TraceFinalizeOutput(s, runId); }
}

lemma lawDestinationRunKeepsAdmissionOrder_ensures(s: TraceState, id: string, runId: string)
  ensures (lawDestinationRunKeepsAdmissionOrder(s, id, runId) == true)
{
  if runId != "" { TraceAdmitRunView(s, id, runId, runId); }
}

lemma lawEmptyTraceIdIsPresent_ensures(s: TraceState, runId: string)
  ensures (lawEmptyTraceIdIsPresent(s, runId) == true)
{
  if runId != "" {
    lawDestinationRunKeepsAdmissionOrder_ensures(s, "", runId);
    assert "" in indexedIds(recordTrace(s, "", runId).state, runId);
    assert |indexedIds(recordTrace(s, "", runId).state, runId)| > 0;
  }
}

lemma purgeObservedTrace_ensures(s: TraceState, observation: PurgeObservation)
  ensures (inv(s) ==> alwaysTraceIdentitiesUnique(purgeObservedTrace(s, observation).state))
  ensures (inv(s) ==> alwaysPurgeCounterNonnegative(purgeObservedTrace(s, observation).state))
  ensures (inv(s) ==> alwaysRunIndexesOwned(purgeObservedTrace(s, observation).state))
  ensures (inv(s) ==> alwaysEnrichmentReceiptsNonnegative(purgeObservedTrace(s, observation).state))
  ensures (inv(s) ==> stepRecordCountsEveryAttempt(s, "purgeObservedTrace", purgeObservedTrace(s, observation).state))
  ensures (inv(s) ==> stepEnrichmentStaysInOneRun(s, "purgeObservedTrace", purgeObservedTrace(s, observation).state))
  ensures (inv(s) ==> stepIndexInsertionOrder(s, "purgeObservedTrace", purgeObservedTrace(s, observation).state))
  ensures (inv(s) ==> stepTransferPreservesUnrelatedRuns(s, "purgeObservedTrace", purgeObservedTrace(s, observation).state))
  ensures (inv(s) ==> stepFinalizationPreservesCapturedSetMembers(s, "purgeObservedTrace", purgeObservedTrace(s, observation).state, purgeObservedTrace(s, observation).out))
  ensures (inv(s) ==> stepEffectsMatchOwner(s, "purgeObservedTrace", purgeObservedTrace(s, observation).state, purgeObservedTrace(s, observation).out))
  ensures (inv(s) ==> stepRecordEffectsUseCapturedIdentity(s, "purgeObservedTrace", purgeObservedTrace(s, observation).state, purgeObservedTrace(s, observation).out))
{
  if inv(s) && observation.retention == TraceRetention.ExpireObserved {
    deleteTrace_ensures(s, observation.id);
    TraceDeleteOutput(s, observation.id, "purgeObservedTrace");
  }
}

lemma lawObservedExpiryRetiresOnlyItsKey_ensures(s: TraceState, id: string)
  ensures (lawObservedExpiryRetiresOnlyItsKey(s, id) == true)
{
  TraceRemovedView([id], s);
  ProofLib.FilterSamePredicate((trace: Trace) => !((trace.id in [id])), (trace: Trace) => (trace.id != id), s.traces);
  ProofLib.FilterSamePredicate((entry: RunEntry) => !((entry.traceId in [id])), (entry: RunEntry) => (entry.traceId != id), s.runEntries);
}

lemma TraceReplayAppend(projected: TraceProjection, effects: seq<TraceEffect>, instruction: TraceEffect)
  ensures replayTraceEffects(projected, effects + [instruction]) == applyTraceProjectionEffect(replayTraceEffects(projected, effects), instruction)
{
  ProofLib.FoldLeftAppend((value: TraceProjection, instruction: TraceEffect) => applyTraceProjectionEffect(value, instruction), projected, effects, instruction);
}

lemma TraceAuditAppend(beforeEntries: seq<RunEntry>, via: string, effects: seq<TraceEffect>, instruction: TraceEffect)
  ensures replayTraceEffectAudit(beforeEntries, via, effects + [instruction]) == auditTraceProjectionEffect(replayTraceEffectAudit(beforeEntries, via, effects), instruction, beforeEntries, via)
{
  ProofLib.FoldLeftAppend((audit: TraceEffectAudit, instruction: TraceEffect) => auditTraceProjectionEffect(audit, instruction, beforeEntries, via), emptyTraceEffectAudit, effects, instruction);
}

lemma TraceProjectionPrimitive(projected: TraceProjection, instruction: TraceEffect)
  ensures instruction.RetireTrace? ==> applyTraceProjectionEffect(projected, instruction) == TraceProjection(ProofLib.Filter((id: string) => (id != instruction.id), projected.globalIds), projected.runEntries)
  ensures instruction.RemoveRunMember? ==> applyTraceProjectionEffect(projected, instruction) == TraceProjection(projected.globalIds, ProofLib.Filter((entry: RunEntry) => ((entry.runId != instruction.runId) || (entry.traceId != instruction.id)), projected.runEntries))
  ensures instruction.DropRunIndex? ==> applyTraceProjectionEffect(projected, instruction) == TraceProjection(projected.globalIds, ProofLib.Filter((entry: RunEntry) => (entry.runId != instruction.runId), projected.runEntries))
{}

lemma TraceEntryKeepAll(entries: seq<RunEntry>, keep: RunEntry -> bool)
  requires forall entry :: entry in entries ==> keep(entry)
  ensures ProofLib.Filter(keep, entries) == entries
  decreases |entries|
{
  if |entries| == 0 { ProofLib.FilterNil(keep, entries); }
  else {
    TraceEntryKeepAll(entries[1..], keep);
    ProofLib.FilterCons(keep, entries);
    assert keep(entries[0]);
    assert entries == [entries[0]] + entries[1..];
  }
}

lemma TraceDropVacantIndex(projected: TraceProjection, runId: string)
  requires forall entry :: entry in projected.runEntries ==> entry.runId != runId
  ensures applyTraceProjectionEffect(projected, DropRunIndex(runId)) == projected
{
  TraceProjectionPrimitive(projected, DropRunIndex(runId));
  ProofLib.FilterSamePredicate((entry: RunEntry) => (entry.runId != DropRunIndex(runId).runId), (entry: RunEntry) => (entry.runId != runId), projected.runEntries);
  TraceEntryKeepAll(projected.runEntries, (entry: RunEntry) => (entry.runId != runId));
}

lemma TraceIdsFiltered(traces: seq<Trace>, ids: seq<string>)
  ensures traceIds(ProofLib.Filter((trace: Trace) => !((trace.id in ids)), traces)) == ProofLib.Filter((id: string) => !((id in ids)), traceIds(traces))
{
  ProofLib.FilterPointwise((trace: Trace) => !((trace.id in ids)), (id: string) => !((id in ids)), (trace: Trace, id: string) => trace.id == id, traces, traceIds(traces));
  var keptTraces := ProofLib.Filter((trace: Trace) => !((trace.id in ids)), traces);
  var keptIds := ProofLib.Filter((id: string) => !((id in ids)), traceIds(traces));
  assert forall i :: 0 <= i < |keptTraces| ==> traceIds(keptTraces)[i] == keptIds[i];
}

lemma TraceIdMembership(traces: seq<Trace>, id: string)
  ensures id in traceIds(traces) <==> exists trace :: trace in traces && trace.id == id
{
  if id in traceIds(traces) {
    var i :| 0 <= i < |traceIds(traces)| && traceIds(traces)[i] == id;
    assert traces[i] in traces;
  }
  if exists trace :: trace in traces && trace.id == id {
    var trace :| trace in traces && trace.id == id;
    var i :| 0 <= i < |traces| && traces[i] == trace;
    assert traceIds(traces)[i] == id;
  }
}

lemma TraceRetireTwoFilters(keys: seq<string>, first: string, rest: seq<string>)
  ensures ProofLib.Filter((id: string) => !((id in rest)), ProofLib.Filter((id: string) => (id != first), keys)) == ProofLib.Filter((id: string) => !((id in [first] + rest)), keys)
  decreases |keys|
{
  var keepFirst := (id: string) => (id != first);
  var keepRest := (id: string) => !((id in rest));
  var keepBoth := (id: string) => !((id in [first] + rest));
  if |keys| == 0 {
    ProofLib.FilterNil(keepFirst, keys); ProofLib.FilterNil(keepBoth, keys); ProofLib.FilterNil(keepRest, []);
  } else {
    TraceRetireTwoFilters(keys[1..], first, rest);
    ProofLib.FilterCons(keepFirst, keys); ProofLib.FilterCons(keepBoth, keys);
    var tail := ProofLib.Filter(keepFirst, keys[1..]);
    if keys[0] != first {
      ProofLib.FilterCons(keepRest, [keys[0]] + tail);
      assert ([keys[0]] + tail)[1..] == tail;
      assert keepRest(keys[0]) == keepBoth(keys[0]);
      assert ProofLib.Filter(keepRest, tail) == ProofLib.Filter(keepBoth, keys[1..]);
    } else {
      assert !keepBoth(keys[0]);
      assert ProofLib.Filter(keepFirst, keys) == tail;
      assert ProofLib.Filter(keepBoth, keys) == ProofLib.Filter(keepBoth, keys[1..]);
      assert ProofLib.Filter(keepRest, tail) == ProofLib.Filter(keepBoth, keys[1..]);
    }
  }
}

lemma TraceRetireEffectsTail(ids: seq<string>)
  requires |ids| > 0
  ensures (seq(|ids|, i requires 0 <= i < |ids| => RetireTrace(ids[i])))[0] == RetireTrace(ids[0])
  ensures (seq(|ids|, i requires 0 <= i < |ids| => RetireTrace(ids[i])))[1..] == (seq(|ids[1..]|, i requires 0 <= i < |ids[1..]| => RetireTrace(ids[1..][i])))
{
  assert forall i :: 0 <= i < |ids[1..]| ==> ids[1..][i] == ids[i + 1];
}

lemma TraceReplayRetires(projected: TraceProjection, ids: seq<string>)
  ensures replayTraceEffects(projected, seq(|ids|, i requires 0 <= i < |ids| => RetireTrace(ids[i]))) == TraceProjection(ProofLib.Filter((id: string) => !((id in ids)), projected.globalIds), projected.runEntries)
  decreases |ids|
{
  if |ids| == 0 {
    ProofLib.FilterSamePredicate((id: string) => !((id in ids)), (id: string) => true, projected.globalIds);
    forall id | id in projected.globalIds ensures !((id in ids)) {}
    TraceKeepAllIds(projected.globalIds);
  } else {
    TraceRetireEffectsTail(ids);
    var next := applyTraceProjectionEffect(projected, RetireTrace(ids[0]));
    TraceProjectionPrimitive(projected, RetireTrace(ids[0]));
    TraceReplayRetires(next, ids[1..]);
    TraceRetireTwoFilters(projected.globalIds, ids[0], ids[1..]);
    assert ids == [ids[0]] + ids[1..];
    ProofLib.FilterSamePredicate((id: string) => !((id in [ids[0]] + ids[1..])), (id: string) => !((id in ids)), projected.globalIds);
  }
}

lemma TraceKeepAllIds(ids: seq<string>)
  ensures ProofLib.Filter((id: string) => true, ids) == ids
  decreases |ids|
{
  if |ids| == 0 { ProofLib.FilterNil((id: string) => true, ids); }
  else {
    TraceKeepAllIds(ids[1..]);
    ProofLib.FilterCons((id: string) => true, ids);
    assert ids == [ids[0]] + ids[1..];
  }
}

lemma TraceAuditRetires(beforeEntries: seq<RunEntry>, via: string, ids: seq<string>)
  ensures replayTraceEffectAudit(beforeEntries, via, seq(|ids|, i requires 0 <= i < |ids| => RetireTrace(ids[i]))) == emptyTraceEffectAudit
  decreases |ids|
{
  if |ids| > 0 {
    TraceRetireEffectsTail(ids);
    TraceAuditRetires(beforeEntries, via, ids[1..]);
    assert auditTraceProjectionEffect(emptyTraceEffectAudit, RetireTrace(ids[0]), beforeEntries, via) == emptyTraceEffectAudit;
  }
}

lemma TraceSelectedIndexUnique(s: TraceState, id: string)
  requires alwaysRunIndexesOwned(s)
  ensures |ProofLib.Filter((entry: RunEntry) => (entry.traceId == id), s.runEntries)| <= 1
{
  TraceOwnerView(s);
  var selected := ProofLib.Filter((entry: RunEntry) => (entry.traceId == id), s.runEntries);
  if |selected| > 0 {
    var entry := selected[0];
    ProofLib.FilterMember((entry: RunEntry) => (entry.traceId == id), s.runEntries, entry);
    var trace :| trace in s.traces && trace.id == entry.traceId && trace.runId == entry.runId;
    ProofLib.FilterSamePredicate((entry: RunEntry) => (entry.traceId == id), (entry: RunEntry) => (entry.traceId == trace.id), s.runEntries);
  }
}

lemma TraceRecordRemovalPlan(s: TraceState, id: string, runId: string)
  requires alwaysRunIndexesOwned(s)
  ensures |ProofLib.Filter((entry: RunEntry) => ((entry.traceId == id) && (entry.runId != runId)), s.runEntries)| <= 1
  ensures |ProofLib.Filter((entry: RunEntry) => ((entry.traceId == id) && (entry.runId != runId)), s.runEntries)| == 0 ==> ProofLib.Filter((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), s.runEntries) == s.runEntries
  ensures |ProofLib.Filter((entry: RunEntry) => ((entry.traceId == id) && (entry.runId != runId)), s.runEntries)| == 1 ==> (var entry := ProofLib.Filter((entry: RunEntry) => ((entry.traceId == id) && (entry.runId != runId)), s.runEntries)[0]; entry in s.runEntries && entry.traceId == id && entry.runId != runId && ProofLib.Filter((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), s.runEntries) == ProofLib.Filter((row: RunEntry) => ((row.runId != entry.runId) || (row.traceId != entry.traceId)), s.runEntries))
{
  var key := (entry: RunEntry) => (entry.traceId == id);
  var keep := (entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId));
  var remove := (entry: RunEntry) => ((entry.traceId == id) && (entry.runId != runId));
  var selected := ProofLib.Filter(key, s.runEntries);
  TraceSelectedIndexUnique(s, id);
  if |selected| == 0 {
    forall entry | entry in s.runEntries ensures !key(entry) && keep(entry) && !remove(entry) {
      ProofLib.FilterMember(key, s.runEntries, entry);
    }
    ProofLib.FilterNone(remove, s.runEntries); TraceEntryKeepAll(s.runEntries, keep);
  } else {
    var entry := selected[0];
    ProofLib.FilterMember(key, s.runEntries, entry);
    forall row | row in s.runEntries && row.traceId == id ensures row == entry {
      ProofLib.FilterMember(key, s.runEntries, row);
    }
    if entry.runId == runId {
      ProofLib.FilterNone(remove, s.runEntries); TraceEntryKeepAll(s.runEntries, keep);
    } else {
      ProofLib.FilterSamePredicate(remove, key, s.runEntries);
      ProofLib.FilterSamePredicate(keep, (row: RunEntry) => ((row.runId != entry.runId) || (row.traceId != entry.traceId)), s.runEntries);
    }
  }
}

lemma TraceDeleteRemovalPlan(s: TraceState, id: string)
  requires alwaysRunIndexesOwned(s)
  ensures |ProofLib.Filter((entry: RunEntry) => (entry.traceId == id), s.runEntries)| <= 1
  ensures |ProofLib.Filter((entry: RunEntry) => (entry.traceId == id), s.runEntries)| == 0 ==> ProofLib.Filter((entry: RunEntry) => (entry.traceId != id), s.runEntries) == s.runEntries
  ensures |ProofLib.Filter((entry: RunEntry) => (entry.traceId == id), s.runEntries)| == 1 ==> (var entry := ProofLib.Filter((entry: RunEntry) => (entry.traceId == id), s.runEntries)[0]; entry in s.runEntries && entry.traceId == id && ProofLib.Filter((entry: RunEntry) => (entry.traceId != id), s.runEntries) == ProofLib.Filter((row: RunEntry) => ((row.runId != entry.runId) || (row.traceId != entry.traceId)), s.runEntries))
{
  var key := (entry: RunEntry) => (entry.traceId == id);
  var keep := (entry: RunEntry) => (entry.traceId != id);
  var selected := ProofLib.Filter(key, s.runEntries);
  TraceSelectedIndexUnique(s, id);
  if |selected| == 0 {
    forall entry | entry in s.runEntries ensures keep(entry) { ProofLib.FilterMember(key, s.runEntries, entry); }
    TraceEntryKeepAll(s.runEntries, keep);
  } else {
    var entry := selected[0];
    ProofLib.FilterMember(key, s.runEntries, entry);
    forall row | row in s.runEntries && row.traceId == id ensures row == entry { ProofLib.FilterMember(key, s.runEntries, row); }
    ProofLib.FilterSamePredicate(keep, (row: RunEntry) => ((row.runId != entry.runId) || (row.traceId != entry.traceId)), s.runEntries);
  }
}

lemma TraceRemovalValue(removed: seq<RunEntry>, remaining: seq<RunEntry>)
  requires |removed| <= 1
  ensures |removed| == 0 ==> removalEffects(removed, remaining) == []
  ensures |removed| == 1 ==> removalEffects(removed, remaining) == [RemoveRunMember(removed[0].runId, removed[0].traceId)] + (if forall other :: other in remaining ==> other.runId != removed[0].runId then [DropRunIndex(removed[0].runId)] else [])
{
 TraceRemovalEmpty(remaining);
 if |removed| == 1 {
  var entry := removed[0];
  assert removed == [entry];
  TraceRemovalOne(entry, remaining);
 }
}

lemma TraceRemovalPrefix(projected: TraceProjection, removed: seq<RunEntry>, remaining: seq<RunEntry>, via: string)
  requires |removed| <= 1
  requires |removed| == 0 ==> remaining == projected.runEntries
  requires |removed| == 1 ==> removed[0] in projected.runEntries && remaining == ProofLib.Filter((row: RunEntry) => ((row.runId != removed[0].runId) || (row.traceId != removed[0].traceId)), projected.runEntries)
  ensures replayTraceEffects(projected, removalEffects(removed, remaining)) == TraceProjection(projected.globalIds, remaining)
  ensures replayTraceEffectAudit(projected.runEntries, via, removalEffects(removed, remaining)).valid
{
  TraceRemovalValue(removed, remaining);
  TraceReplayEmpty(projected); TraceAuditEmpty(projected.runEntries, via);
  if |removed| == 1 {
    var entry := removed[0];
    var remove := RemoveRunMember(entry.runId, entry.traceId);
    var middle := TraceProjection(projected.globalIds, remaining);
    ProofLib.FilterSamePredicate((row: RunEntry) => ((row.runId != removed[0].runId) || (row.traceId != removed[0].traceId)), (row: RunEntry) => ((row.runId != entry.runId) || (row.traceId != entry.traceId)), projected.runEntries);
    assert remaining == ProofLib.Filter((row: RunEntry) => ((row.runId != entry.runId) || (row.traceId != entry.traceId)), projected.runEntries);
    TraceReplayOne(projected, remove);
    TraceProjectionPrimitive(projected, remove);
    ProofLib.FilterSamePredicate((row: RunEntry) => ((row.runId != entry.runId) || (row.traceId != entry.traceId)), (entry: RunEntry) => ((entry.runId != remove.runId) || (entry.traceId != remove.id)), projected.runEntries);
    TraceAuditOne(projected.runEntries, via, remove);
    assert replayTraceEffects(projected, [remove]) == applyTraceProjectionEffect(projected, remove);
    assert emptyTraceEffectAudit == TraceEffectAudit([], true);
    assert replayTraceEffectAudit(projected.runEntries, via, [remove]) == auditTraceProjectionEffect(emptyTraceEffectAudit, remove, projected.runEntries, via);
    reveal auditTraceProjectionEffect();
    assert auditTraceProjectionEffect(emptyTraceEffectAudit, remove, projected.runEntries, via) == TraceEffectAudit([RunEntry(entry.runId, entry.traceId)], true);
    assert replayTraceEffects(projected, [remove]) == middle;
    assert replayTraceEffectAudit(projected.runEntries, via, [remove]) == TraceEffectAudit([RunEntry(entry.runId, entry.traceId)], true);
    if forall other :: other in remaining ==> other.runId != entry.runId {
      TraceDropVacantIndex(middle, entry.runId);
      forall prior | prior in projected.runEntries && prior.runId == entry.runId
        ensures prior.runId == entry.runId && prior.traceId == entry.traceId
      {
        ProofLib.FilterMember((row: RunEntry) => ((row.runId != entry.runId) || (row.traceId != entry.traceId)), projected.runEntries, prior);
      }
      assert removalEffects(removed, remaining) == [remove] + [DropRunIndex(entry.runId)];
      TraceReplayAppend(projected, [remove], DropRunIndex(entry.runId));
      TraceAuditAppend(projected.runEntries, via, [remove], DropRunIndex(entry.runId));
      assert applyTraceProjectionEffect(middle, DropRunIndex(entry.runId)) == middle;
      assert auditTraceProjectionEffect(TraceEffectAudit([RunEntry(entry.runId, entry.traceId)], true), DropRunIndex(entry.runId), projected.runEntries, via).valid;
      assert replayTraceEffects(projected, removalEffects(removed, remaining)) == middle;
      assert replayTraceEffectAudit(projected.runEntries, via, removalEffects(removed, remaining)).valid;
    } else {
      assert [remove] + [] == [remove];
      assert removalEffects(removed, remaining) == [remove];
    }
  }
}

lemma TraceRecordOutView(s: TraceState, id: string, runId: string)
  requires runId != ""
  ensures recordTrace(s, id, runId).out == removalEffects(ProofLib.Filter((entry: RunEntry) => ((entry.traceId == id) && (entry.runId != runId)), s.runEntries), ProofLib.Filter((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), s.runEntries)) + [EnsureRunMember(runId, id)]
{}

lemma TraceDeleteOutView(s: TraceState, id: string)
  ensures deleteTrace(s, id).out == [RetireTrace(id)] + removalEffects(ProofLib.Filter((entry: RunEntry) => (entry.traceId == id), s.runEntries), withoutIds([id], s).runEntries)
{}

lemma TraceRecordGlobalIds(s: TraceState, id: string, runId: string)
  requires alwaysTraceIdentitiesUnique(s) && runId != ""
  ensures traceIds(recordTrace(s, id, runId).state.traces) == (if id in traceIds(s.traces) then traceIds(s.traces) else traceIds(s.traces) + [id])
{
  TraceIdMembership(s.traces, id); TraceUniqueKeys(s);
  var after := recordTrace(s, id, runId).state;
  if exists trace :: trace in s.traces && trace.id == id {
    forall i | 0 <= i < |s.traces| ensures after.traces[i].id == s.traces[i].id {}
    TraceMapKeys(s.traces, after.traces);
  } else { TraceAppendKey(s.traces, Trace(id, runId, 0)); }
}

lemma TraceRecordOutput(s: TraceState, id: string, runId: string)
  requires alwaysTraceIdentitiesUnique(s) && alwaysRunIndexesOwned(s) && runId != ""
  ensures stepEffectsMatchOwner(s, "recordTrace", recordTrace(s, id, runId).state, recordTrace(s, id, runId).out)
  ensures stepRecordEffectsUseCapturedIdentity(s, "recordTrace", recordTrace(s, id, runId).state, recordTrace(s, id, runId).out)
{
  var projected := traceProjection(s);
  var removed := ProofLib.Filter((entry: RunEntry) => ((entry.traceId == id) && (entry.runId != runId)), s.runEntries);
  var remaining := ProofLib.Filter((entry: RunEntry) => ((entry.traceId != id) || (entry.runId == runId)), s.runEntries);
  var prefix := removalEffects(removed, remaining);
  var ensured := EnsureRunMember(runId, id);
  var after := recordTrace(s, id, runId).state;
  TraceRecordRemovalPlan(s, id, runId);
  TraceRemovalPrefix(projected, removed, remaining, "recordTrace");
  TraceRecordOutView(s, id, runId); TraceAdmitView(s, id, runId); TraceRecordGlobalIds(s, id, runId);
  TraceReplayAppend(projected, prefix, ensured);
  TraceAuditAppend(s.runEntries, "recordTrace", prefix, ensured);
  assert applyTraceProjectionEffect(TraceProjection(projected.globalIds, remaining), ensured) == traceProjection(after);
  TraceRemovalValue(removed, remaining);
  if |removed| > 0 {
    var entry := removed[0];
    assert entry.traceId == id && entry.runId != runId;
    if forall other :: other in remaining ==> other.runId != entry.runId { }
  }
  assert recordEffectsMatchCapture(prefix + [ensured], id, runId);
}

lemma TraceReplayCons(projected: TraceProjection, instruction: TraceEffect, effects: seq<TraceEffect>)
  ensures replayTraceEffects(projected, [instruction] + effects) == replayTraceEffects(applyTraceProjectionEffect(projected, instruction), effects)
{
  assert ([instruction] + effects)[0] == instruction && ([instruction] + effects)[1..] == effects;
}

lemma TraceAuditRetireHead(beforeEntries: seq<RunEntry>, via: string, id: string, effects: seq<TraceEffect>)
  ensures replayTraceEffectAudit(beforeEntries, via, [RetireTrace(id)] + effects) == replayTraceEffectAudit(beforeEntries, via, effects)
{
  assert ([RetireTrace(id)] + effects)[0] == RetireTrace(id) && ([RetireTrace(id)] + effects)[1..] == effects;
}

lemma TraceDeleteOutput(s: TraceState, id: string, via: string)
  requires alwaysRunIndexesOwned(s)
  ensures replayTraceEffects(traceProjection(s), deleteTrace(s, id).out) == traceProjection(deleteTrace(s, id).state)
  ensures replayTraceEffectAudit(s.runEntries, via, deleteTrace(s, id).out).valid
{
  var projected := traceProjection(s);
  var retired := applyTraceProjectionEffect(projected, RetireTrace(id));
  var removed := ProofLib.Filter((entry: RunEntry) => (entry.traceId == id), s.runEntries);
  var remaining := ProofLib.Filter((entry: RunEntry) => (entry.traceId != id), s.runEntries);
  var prefix := removalEffects(removed, remaining);
  TraceProjectionPrimitive(projected, RetireTrace(id));
  TraceDeleteRemovalPlan(s, id); TraceRemovedView([id], s); TraceDeleteOutView(s, id);
  ProofLib.FilterSamePredicate((entry: RunEntry) => !((entry.traceId in [id])), (entry: RunEntry) => (entry.traceId != id), s.runEntries);
  TraceIdsFiltered(s.traces, [id]);
  ProofLib.FilterSamePredicate((key: string) => !((key in [id])), (key: string) => (key != id), traceIds(s.traces));
  assert deleteTrace(s, id).out == [RetireTrace(id)] + prefix;
  TraceRemovalPrefix(retired, removed, remaining, via);
  TraceReplayCons(projected, RetireTrace(id), prefix);
  TraceAuditRetireHead(s.runEntries, via, id, prefix);
}

lemma TraceRunIndexMembership(s: TraceState, runId: string)
  requires alwaysTraceIdentitiesUnique(s) && alwaysRunIndexesOwned(s)
  ensures forall entry :: entry in s.runEntries ==> ((entry.traceId in indexedIds(s, runId)) == (entry.runId == runId))
{
  forall entry | entry in s.runEntries
    ensures (entry.traceId in indexedIds(s, runId)) == (entry.runId == runId)
  {
    TraceIndexMembership(s, runId, entry.traceId);
    if entry.traceId in indexedIds(s, runId) {
      var other :| other in s.runEntries && other.runId == runId && other.traceId == entry.traceId;
      TraceIndexOwner(s, entry); TraceIndexOwner(s, other);
    }
  }
}

lemma TraceFinalizeOutput(s: TraceState, runId: string)
  requires alwaysTraceIdentitiesUnique(s) && alwaysRunIndexesOwned(s)
  ensures stepEffectsMatchOwner(s, "finalizeRun", finalizeRun(s, runId).state, finalizeRun(s, runId).out)
{
  var projected := traceProjection(s);
  var ids := indexedIds(s, runId);
  var effects := seq(|ids|, i requires 0 <= i < |ids| => RetireTrace(ids[i]));
  var after := finalizeRun(s, runId).state;
  TraceRemovedView(ids, s); TraceIdsFiltered(s.traces, ids);
  TraceReplayRetires(projected, ids);
  TraceAuditRetires(s.runEntries, "finalizeRun", ids);
  if |ids| == 0 {
    assert effects == [];
    TraceEntryKeepAll(s.runEntries, (entry: RunEntry) => !((entry.traceId in ids)));
  } else {
    assert finalizeRun(s, runId).out == effects + [DropRunIndex(runId)];
    TraceReplayAppend(projected, effects, DropRunIndex(runId));
    TraceAuditAppend(s.runEntries, "finalizeRun", effects, DropRunIndex(runId));
    TraceRunIndexMembership(s, runId);
    ProofLib.FilterSamePredicate((entry: RunEntry) => !((entry.traceId in ids)), (entry: RunEntry) => (entry.runId != runId), s.runEntries);
    TraceProjectionPrimitive(TraceProjection(ProofLib.Filter((id: string) => !((id in ids)), projected.globalIds), projected.runEntries), DropRunIndex(runId));
  }
}

lemma TraceReplayEmpty(projected: TraceProjection)
  ensures replayTraceEffects(projected, []) == projected
{}

lemma TraceAuditEmpty(beforeEntries: seq<RunEntry>, via: string)
  ensures replayTraceEffectAudit(beforeEntries, via, []) == emptyTraceEffectAudit
{}

lemma TraceRemovalEmpty(remaining: seq<RunEntry>)
  ensures removalEffects([], remaining) == []
{}


lemma TraceReplayOne(projected: TraceProjection, instruction: TraceEffect)
 ensures replayTraceEffects(projected, [instruction]) == applyTraceProjectionEffect(projected, instruction)
{
 assert [] + [instruction] == [instruction];
 calc {
  replayTraceEffects(projected, [instruction]);
  replayTraceEffects(projected, [] + [instruction]);
  { TraceReplayAppend(projected, [], instruction); }
  applyTraceProjectionEffect(replayTraceEffects(projected, []), instruction);
  { TraceReplayEmpty(projected); }
  applyTraceProjectionEffect(projected, instruction);
 }
}
lemma TraceAuditOne(beforeEntries: seq<RunEntry>, via: string, instruction: TraceEffect)
 ensures replayTraceEffectAudit(beforeEntries, via, [instruction]) == auditTraceProjectionEffect(emptyTraceEffectAudit, instruction, beforeEntries, via)
{
 assert [] + [instruction] == [instruction];
 calc {
  replayTraceEffectAudit(beforeEntries, via, [instruction]);
  replayTraceEffectAudit(beforeEntries, via, [] + [instruction]);
  { TraceAuditAppend(beforeEntries, via, [], instruction); }
  auditTraceProjectionEffect(replayTraceEffectAudit(beforeEntries, via, []), instruction, beforeEntries, via);
  { TraceAuditEmpty(beforeEntries, via); }
  auditTraceProjectionEffect(emptyTraceEffectAudit, instruction, beforeEntries, via);
 }
}
lemma TraceRemovalOne(entry: RunEntry, remaining: seq<RunEntry>)
 ensures removalEffects([entry], remaining) == [RemoveRunMember(entry.runId, entry.traceId)] + (if forall other :: other in remaining ==> other.runId != entry.runId then [DropRunIndex(entry.runId)] else [])
{
 var f := (effects: seq<TraceEffect>, entry: RunEntry) => ((effects + [RemoveRunMember(entry.runId, entry.traceId)]) + (if !((exists other :: other in remaining && !((other.runId != entry.runId)))) then [DropRunIndex(entry.runId)] else []));
 assert [] + [entry] == [entry];
 assert Std.Collections.Seq.FoldLeft(f, [], []) == [];
 assert f([], entry) == [RemoveRunMember(entry.runId, entry.traceId)] + (if forall other :: other in remaining ==> other.runId != entry.runId then [DropRunIndex(entry.runId)] else []);
 calc {
  removalEffects([entry], remaining);
  Std.Collections.Seq.FoldLeft(f, [], [] + [entry]);
  { ProofLib.FoldLeftAppend(f, [], [], entry); }
  f(Std.Collections.Seq.FoldLeft(f, [], []), entry);
  f([], entry);
  [RemoveRunMember(entry.runId, entry.traceId)] + (if forall other :: other in remaining ==> other.runId != entry.runId then [DropRunIndex(entry.runId)] else []);
 }
}
