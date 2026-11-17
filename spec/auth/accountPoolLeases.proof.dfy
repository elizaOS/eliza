lemma PoolIds(s: PoolLeases)
  ensures alwaysReportIdsAreUnique(s) == ((s.nextReport > 0) && !((exists r :: r in s.reports && !((((r.id > 0) && (r.id < s.nextReport)) && (|ProofLib.Filter((o: Report) => (o.id == r.id), s.reports)| == 1))))) && !((exists q :: q in s.queue && !((((q > 0) && (q < s.nextReport)) && (|ProofLib.Filter((o: int) => (o == q), s.queue)| == 1))))))
{
}

lemma PoolReportOf(s: PoolLeases, id: int)
  ensures reportOf(s, id) == (if 0 < |ProofLib.Filter((r: Report) => (r.id == id), s.reports)| then ProofLib.Filter((r: Report) => (r.id == id), s.reports)[0] else Report(0, ReportKind.ReportTransient, 0, 0, ReportPhase.ReportDone, false, false))
{
}

lemma PoolFound(s: PoolLeases, id: int)
  requires !reportOf(s, id).phase.ReportDone?
  ensures reportOf(s, id) in s.reports && reportOf(s, id).id == id
{
  PoolReportOf(s, id);
  var f := ProofLib.Filter((r: Report) => (r.id == id), s.reports);
  assert f[0] in f;
  ProofLib.FilterMember((r: Report) => (r.id == id), s.reports, f[0]);
}

lemma PoolUnique(s: PoolLeases, x: Report)
  requires x in s.reports && |ProofLib.Filter((o: Report) => (o.id == x.id), s.reports)| == 1
  ensures reportOf(s, x.id) == x
{
  PoolReportOf(s, x.id);
  ProofLib.FilterSamePredicate((o: Report) => (o.id == x.id), (r: Report) => (r.id == x.id), s.reports);
  ProofLib.FilterMember((r: Report) => (r.id == x.id), s.reports, x);
}

lemma PoolHeadUnique(s: PoolLeases)
  requires |s.queue| > 0 && |ProofLib.Filter((o: int) => (o == s.queue[0]), s.queue)| == 1
  requires forall q :: q in s.queue ==> |ProofLib.Filter((o: int) => (o == q), s.queue)| == 1
  ensures s.queue[0] !in s.queue[1..]
  ensures forall q :: q in s.queue[1..] ==> |ProofLib.Filter((o: int) => (o == q), s.queue[1..])| == 1
{
  ProofLib.FilterCons((o: int) => (o == s.queue[0]), s.queue);
  ProofLib.FilterNone((o: int) => (o == s.queue[0]), s.queue[1..]);
  forall q | q in s.queue[1..]
    ensures |ProofLib.Filter((o: int) => (o == q), s.queue[1..])| == 1
  {
    var j :| 0 <= j < |s.queue[1..]| && s.queue[1..][j] == q;
    assert q in s.queue && q != s.queue[0];
    ProofLib.FilterCons((o: int) => (o == q), s.queue);
  }
}

lemma PoolMapped(s: PoolLeases, id: int, change: Report)
  requires inv(s) && alwaysReportIdsAreUnique(s) && change.id == id && !reportOf(s, id).phase.ReportDone?
  ensures forall r :: r in withReport(id, change, s) ==> r == change || (r in s.reports && r.id != id && reportOf(s, r.id) == r)
  ensures forall r :: r in withReport(id, change, s) ==> r.id > 0 && r.id < s.nextReport && |ProofLib.Filter((o: Report) => (o.id == r.id), withReport(id, change, s))| == 1
{
  PoolIds(s);
  PoolFound(s, id);
  var t := withReport(id, change, s);
  forall r | r in t
    ensures r == change || (r in s.reports && r.id != id && reportOf(s, r.id) == r)
    ensures r.id > 0 && r.id < s.nextReport && |ProofLib.Filter((o: Report) => (o.id == r.id), t)| == 1
  {
    var i :| 0 <= i < |t| && t[i] == r;
    var x := s.reports[i];
    assert x in s.reports;
    if x.id != id {
      PoolUnique(s, x);
    }
    ProofLib.FilterLengthPointwise((o: Report) => (o.id == r.id), (o: Report) => (o.id == x.id), t, s.reports);
  }
}

lemma submitReport_ensures(s: PoolLeases, kind: ReportKind)
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> alwaysPublishedReceiptOwnsItsDecision(submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> alwaysReceiptNamesACredential(submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> alwaysRefusedLeaseHasNoPublication(submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> alwaysOnlyTheHeadIsWorking(submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> alwaysReportIdsAreUnique(submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> alwaysReportEffectsOwnTheirGeneration(submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> alwaysPendingReportsWroteNothing(submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> alwaysGenerationsAreFresh(submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> stepOldGenerationWritesNothing(s, "submitReport", submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> stepSuccessKeepsNewerHealth(s, "submitReport", submitReport(s, kind)))
  ensures (inv(s) ==> canSubmitReport(s, kind) ==> stepRemovedAccountStaysRemoved(s, "submitReport", submitReport(s, kind)))
{
  if inv(s) && canSubmitReport(s, kind) {
    var after := submitReport(s, kind);
    var n := after.reports[|s.reports|];
    assert after.reports == s.reports + [n];
    PoolIds(s);
    PoolIds(after);
    assert forall i :: 0 <= i < |s.reports| ==> s.reports[i] in s.reports;
    assert forall i :: 0 <= i < |s.queue| ==> s.queue[i] in s.queue;
    forall r | r in after.reports
      ensures r.id > 0 && r.id < after.nextReport && |ProofLib.Filter((o: Report) => (o.id == r.id), after.reports)| == 1
    {
      ProofLib.FilterAppend((o: Report) => (o.id == r.id), s.reports, n);
      if r != n {
        assert r in s.reports;
      } else {
        assert forall i :: 0 <= i < |s.reports| ==> s.reports[i].id < s.nextReport;
        ProofLib.FilterNone((o: Report) => (o.id == r.id), s.reports);
      }
    }
    forall q | q in after.queue
      ensures q > 0 && q < after.nextReport && |ProofLib.Filter((o: int) => (o == q), after.queue)| == 1
    {
      if after.queue != s.queue {
        assert after.queue == s.queue + [s.nextReport];
        ProofLib.FilterAppend((o: int) => (o == q), s.queue, s.nextReport);
        if q != s.nextReport {
          assert q in s.queue;
        } else {
          ProofLib.FilterNone((o: int) => (o == q), s.queue);
        }
      }
    }
  }
}

lemma recordUsage_ensures(s: PoolLeases, id: int)
  ensures (inv(s) ==> canRecordUsage(s, id) ==> alwaysPublishedReceiptOwnsItsDecision(recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> alwaysReceiptNamesACredential(recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> alwaysRefusedLeaseHasNoPublication(recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> alwaysOnlyTheHeadIsWorking(recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> alwaysReportIdsAreUnique(recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> alwaysReportEffectsOwnTheirGeneration(recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> alwaysPendingReportsWroteNothing(recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> alwaysGenerationsAreFresh(recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> stepOldGenerationWritesNothing(s, "recordUsage", recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> stepSuccessKeepsNewerHealth(s, "recordUsage", recordUsage(s, id)))
  ensures (inv(s) ==> canRecordUsage(s, id) ==> stepRemovedAccountStaysRemoved(s, "recordUsage", recordUsage(s, id)))
{
  if inv(s) && canRecordUsage(s, id) {
    var after := recordUsage(s, id);
    var rep := reportOf(s, id);
    PoolFound(s, id);
    assert rep in s.reports;
    PoolMapped(s, id, rep.(phase := ReportPhase.ReportRecorded, usageWritten := (rep.generation == s.generation)));
    PoolIds(after);
  }
}

lemma commitHealth_ensures(s: PoolLeases, id: int)
  ensures (inv(s) ==> canCommitHealth(s, id) ==> alwaysPublishedReceiptOwnsItsDecision(commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> alwaysReceiptNamesACredential(commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> alwaysRefusedLeaseHasNoPublication(commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> alwaysOnlyTheHeadIsWorking(commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> alwaysReportIdsAreUnique(commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> alwaysReportEffectsOwnTheirGeneration(commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> alwaysPendingReportsWroteNothing(commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> alwaysGenerationsAreFresh(commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> stepOldGenerationWritesNothing(s, "commitHealth", commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> stepSuccessKeepsNewerHealth(s, "commitHealth", commitHealth(s, id)))
  ensures (inv(s) ==> canCommitHealth(s, id) ==> stepRemovedAccountStaysRemoved(s, "commitHealth", commitHealth(s, id)))
{
  if inv(s) && canCommitHealth(s, id) {
    var after := commitHealth(s, id);
    var rep := reportOf(s, id);
    PoolFound(s, id);
    assert rep in s.reports;
    var write := (rep.generation == s.generation) && ((rep.kind.ReportAuth? || rep.kind.ReportRate?) || (rep.kind.ReportSuccess? && (s.healthDetail == rep.observedDetail)));
    PoolMapped(s, id, rep.(phase := ReportPhase.ReportDone, healthWritten := write));
    assert after.reports == withReport(id, rep.(phase := ReportPhase.ReportDone, healthWritten := write), s);
    PoolIds(s);
    PoolIds(after);
    assert id in s.queue;
    PoolHeadUnique(s);
    assert after.queue == s.queue[1..];
    assert forall q :: q in s.queue[1..] ==> q in s.queue;
  }
}
