lemma ContributorPartition(entries: seq<Contributor>, position: int)
  ensures |ProofLib.Filter((entry: Contributor) => (entry.position <= position), entries)| + |ProofLib.Filter((entry: Contributor) => (entry.position > position), entries)| == |entries|
  decreases |entries|
{
  if |entries| == 0 {
    ProofLib.FilterNil((entry: Contributor) => (entry.position <= position), entries);
    ProofLib.FilterNil((entry: Contributor) => (entry.position > position), entries);
  } else {
    ProofLib.FilterCons((entry: Contributor) => (entry.position <= position), entries);
    ProofLib.FilterCons((entry: Contributor) => (entry.position > position), entries);
    ContributorPartition(entries[1..], position);
  }
}

lemma InsertionLength(entries: seq<Contributor>, candidate: Contributor)
  ensures |inserted(entries, candidate)| == |ProofLib.Filter((entry: Contributor) => (entry.position <= candidate.position), entries)| + 1 + |ProofLib.Filter((entry: Contributor) => (entry.position > candidate.position), entries)|
{
}

lemma lawInsertionKeepsExistingContributors_ensures(entries: seq<Contributor>, candidate: Contributor)
  ensures (lawInsertionKeepsExistingContributors(entries, candidate) == true)
{
  InsertionLength(entries, candidate);
  ContributorPartition(entries, candidate.position);
}

lemma SummaryFilters(s: SummaryCache)
  ensures alwaysUniqueRequestIdentity(s) == (forall call :: call in s.pending ==> |ProofLib.Filter((other: PendingSummary) => (other.requestId == call.requestId), s.pending)| == 1)
  ensures alwaysOneCachePerRuntime(s) == (forall row :: row in s.rows ==> |ProofLib.Filter((other: CacheRow) => (other.runtimeId == row.runtimeId), s.rows)| == 1)
{}

lemma PendingDistinct(calls: seq<PendingSummary>)
  ensures (forall call :: call in calls ==> |ProofLib.Filter((other: PendingSummary) => (other.requestId == call.requestId), calls)| == 1) <==> ProofLib.DistinctBy(calls, (call: PendingSummary) => call.requestId)
{
  if forall call :: call in calls ==> |ProofLib.Filter((other: PendingSummary) => (other.requestId == call.requestId), calls)| == 1 {
    forall i, j | 0 <= i < |calls| && 0 <= j < |calls| && i != j
      ensures calls[i].requestId != calls[j].requestId
    {
      ProofLib.FilterCountOneIffUnique((other: PendingSummary) => (other.requestId == calls[i].requestId), calls, (call: PendingSummary) => call.requestId, i);
    }
  } else if ProofLib.DistinctBy(calls, (call: PendingSummary) => call.requestId) {
    forall call | call in calls
      ensures |ProofLib.Filter((other: PendingSummary) => (other.requestId == call.requestId), calls)| == 1
    {
      var i :| 0 <= i < |calls| && calls[i] == call;
      ProofLib.FilterOne((other: PendingSummary) => (other.requestId == call.requestId), calls, i);
    }
  }
}

lemma CacheDistinct(rows: seq<CacheRow>)
  ensures (forall row :: row in rows ==> |ProofLib.Filter((other: CacheRow) => (other.runtimeId == row.runtimeId), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: CacheRow) => row.runtimeId)
{
  if forall row :: row in rows ==> |ProofLib.Filter((other: CacheRow) => (other.runtimeId == row.runtimeId), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].runtimeId != rows[j].runtimeId
    {
      ProofLib.FilterCountOneIffUnique((other: CacheRow) => (other.runtimeId == rows[i].runtimeId), rows, (row: CacheRow) => row.runtimeId, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: CacheRow) => row.runtimeId) {
    forall row | row in rows
      ensures |ProofLib.Filter((other: CacheRow) => (other.runtimeId == row.runtimeId), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterOne((other: CacheRow) => (other.runtimeId == row.runtimeId), rows, i);
    }
  }
}

lemma FailSummaryParts(s: SummaryCache, requestId: string)
  ensures failSummary(s, requestId).pending == ProofLib.Filter((call: PendingSummary) => (call.requestId != requestId), s.pending)
{}

lemma FinishSummaryParts(s: SummaryCache, requestId: string, text: string)
  ensures finishSummary(s, requestId, text) == (
    var matching := ProofLib.Filter((candidate: PendingSummary) => (candidate.requestId == requestId), s.pending);
    var call := if |matching| > 0 then matching[0] else PendingSummary(requestId, "", 0, -1, 0);
    if |matching| == 0 then s else SummaryCache(
      if call.generation == s.generation then ProofLib.Filter((row: CacheRow) => (row.runtimeId != call.runtimeId), s.rows) + [CacheRow(call.runtimeId, text, call.startedAt + call.ttl)] else s.rows,
      ProofLib.Filter((candidate: PendingSummary) => (candidate.requestId != requestId), s.pending), s.now, s.generation, s.failures))
{}

lemma startSummary_ensures(s: SummaryCache, requestId: string, runtimeId: string, ttl: int)
  ensures (inv(s) ==> canStartSummary(s, requestId, runtimeId, ttl) ==> alwaysOneCachePerRuntime(startSummary(s, requestId, runtimeId, ttl)))
  ensures (inv(s) ==> canStartSummary(s, requestId, runtimeId, ttl) ==> alwaysUniqueRequestIdentity(startSummary(s, requestId, runtimeId, ttl)))
  ensures (inv(s) ==> canStartSummary(s, requestId, runtimeId, ttl) ==> alwaysGenerationsAreValid(startSummary(s, requestId, runtimeId, ttl)))
  ensures (inv(s) ==> canStartSummary(s, requestId, runtimeId, ttl) ==> stepInvalidationDetachesOldRows(s, "startSummary", startSummary(s, requestId, runtimeId, ttl)))
  ensures (inv(s) ==> canStartSummary(s, requestId, runtimeId, ttl) ==> stepStaleCompletionCannotPopulate(s, "startSummary", startSummary(s, requestId, runtimeId, ttl)))
{
  if inv(s) && canStartSummary(s, requestId, runtimeId, ttl) {
    var after := startSummary(s, requestId, runtimeId, ttl);
    SummaryFilters(s); SummaryFilters(after);
    PendingDistinct(s.pending); PendingDistinct(after.pending);
    var next := PendingSummary(requestId, runtimeId, s.now, s.generation, ttl);
    ProofLib.DistinctByConcat(s.pending, [next], (call: PendingSummary) => call.requestId);
  }
}

lemma failSummary_ensures(s: SummaryCache, requestId: string)
  ensures (inv(s) ==> canFailSummary(s, requestId) ==> alwaysOneCachePerRuntime(failSummary(s, requestId)))
  ensures (inv(s) ==> canFailSummary(s, requestId) ==> alwaysUniqueRequestIdentity(failSummary(s, requestId)))
  ensures (inv(s) ==> canFailSummary(s, requestId) ==> alwaysGenerationsAreValid(failSummary(s, requestId)))
  ensures (inv(s) ==> canFailSummary(s, requestId) ==> stepInvalidationDetachesOldRows(s, "failSummary", failSummary(s, requestId)))
  ensures (inv(s) ==> canFailSummary(s, requestId) ==> stepStaleCompletionCannotPopulate(s, "failSummary", failSummary(s, requestId)))
{
  if inv(s) && canFailSummary(s, requestId) {
    var after := failSummary(s, requestId);
    SummaryFilters(s); SummaryFilters(after);
    PendingDistinct(s.pending); PendingDistinct(after.pending);
    FailSummaryParts(s, requestId);
    ProofLib.FilterKeepsDistinctBy((call: PendingSummary) => (call.requestId != requestId), s.pending, (call: PendingSummary) => call.requestId);
    ProofLib.FilterSubset((call: PendingSummary) => (call.requestId != requestId), s.pending);
  }
}

lemma finishSummary_ensures(s: SummaryCache, requestId: string, text: string)
  ensures (inv(s) ==> canFinishSummary(s, requestId, text) ==> alwaysOneCachePerRuntime(finishSummary(s, requestId, text)))
  ensures (inv(s) ==> canFinishSummary(s, requestId, text) ==> alwaysUniqueRequestIdentity(finishSummary(s, requestId, text)))
  ensures (inv(s) ==> canFinishSummary(s, requestId, text) ==> alwaysGenerationsAreValid(finishSummary(s, requestId, text)))
  ensures (inv(s) ==> canFinishSummary(s, requestId, text) ==> stepInvalidationDetachesOldRows(s, "finishSummary", finishSummary(s, requestId, text)))
  ensures (inv(s) ==> canFinishSummary(s, requestId, text) ==> stepStaleCompletionCannotPopulate(s, "finishSummary", finishSummary(s, requestId, text)))
{
  if inv(s) && canFinishSummary(s, requestId, text) {
    var after := finishSummary(s, requestId, text);
    SummaryFilters(s); SummaryFilters(after);
    PendingDistinct(s.pending); PendingDistinct(after.pending);
    CacheDistinct(s.rows); CacheDistinct(after.rows);
    FinishSummaryParts(s, requestId, text);
    var matching := ProofLib.Filter((candidate: PendingSummary) => (candidate.requestId == requestId), s.pending);
    var capturedInvocation :| capturedInvocation in s.pending && capturedInvocation.requestId == requestId;
    ProofLib.FilterMember((candidate: PendingSummary) => (candidate.requestId == requestId), s.pending, capturedInvocation);
    assert |matching| > 0;
    var call := matching[0];
    ProofLib.FilterMember((candidate: PendingSummary) => (candidate.requestId == requestId), s.pending, call);
    assert call in s.pending;
    ProofLib.FilterKeepsDistinctBy((candidate: PendingSummary) => (candidate.requestId != requestId), s.pending, (call: PendingSummary) => call.requestId);
    ProofLib.FilterSubset((candidate: PendingSummary) => (candidate.requestId != requestId), s.pending);
    if call.generation == s.generation {
      var kept := ProofLib.Filter((row: CacheRow) => (row.runtimeId != call.runtimeId), s.rows);
      ProofLib.FilterKeepsDistinctBy((row: CacheRow) => (row.runtimeId != call.runtimeId), s.rows, (row: CacheRow) => row.runtimeId);
      forall row | row in kept ensures row.runtimeId != call.runtimeId {
        ProofLib.FilterMember((row: CacheRow) => (row.runtimeId != call.runtimeId), s.rows, row);
      }
      ProofLib.DistinctByConcat(kept, [CacheRow(call.runtimeId, text, call.startedAt + call.ttl)], (row: CacheRow) => row.runtimeId);
    }
  }
}
