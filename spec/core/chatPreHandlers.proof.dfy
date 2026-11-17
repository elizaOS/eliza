lemma PreUniqueFilters(s: PreHandlers)
  ensures alwaysDrainIdsUnique(s) == !((exists d :: d in s.drains && !((|ProofLib.Filter((e: PreDrain) => (e.id == d.id), s.drains)| == 1))))
{
}

lemma PreUnique(s: PreHandlers)
  ensures alwaysDrainIdsUnique(s) <==> ProofLib.DistinctBy(s.drains, (item: PreDrain) => item.id)
{
  PreUniqueFilters(s);
  var rows := s.drains;
  var key := (row: PreDrain) => row.id;
  if ProofLib.DistinctBy(rows, key) {
    forall row | row in rows ensures |ProofLib.Filter((e: PreDrain) => (e.id == row.id), rows)| == 1 {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterCountOneIffUnique((e: PreDrain) => (e.id == row.id), rows, key, i);
    }
  } else if forall row :: row in rows ==> |ProofLib.Filter((e: PreDrain) => (e.id == row.id), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j ensures rows[i].id != rows[j].id {
      assert rows[i] in rows;
      var p := (e: PreDrain) => (e.id == rows[i].id);
      assert |ProofLib.Filter(p, rows)| == 1;
      ProofLib.FilterCountOneIffUnique(p, rows, key, i);
    }
  }
}

lemma PreDrainFilter(s: PreHandlers, drainId: int)
  ensures preDrain(s, drainId) == (if ((0 <= 0) && (0 < |ProofLib.Filter((d: PreDrain) => (d.id == drainId), s.drains)|)) then ProofLib.Filter((d: PreDrain) => (d.id == drainId), s.drains)[0] else noDrain)
{
}

lemma PreOnly(s: PreHandlers, drainId: int)
  requires alwaysDrainIdsUnique(s)
  requires !preDrain(s, drainId).phase.DrainEmpty?
  ensures preDrain(s, drainId) in s.drains && preDrain(s, drainId).id == drainId
  ensures forall i :: 0 <= i < |s.drains| && s.drains[i].id == drainId ==> s.drains[i] == preDrain(s, drainId)
{
  PreDrainFilter(s, drainId);
  var found := ProofLib.Filter((d: PreDrain) => (d.id == drainId), s.drains);
  ProofLib.FilterMember((d: PreDrain) => (d.id == drainId), s.drains, found[0]);
  PreUnique(s);
  var k :| 0 <= k < |s.drains| && s.drains[k] == preDrain(s, drainId);
}

lemma PreStep(s: PreHandlers, after: PreHandlers, drainId: int)
  requires inv(s)
  requires |after.drains| == |s.drains|
  requires forall i :: 0 <= i < |s.drains| ==> after.drains[i].id == s.drains[i].id && after.drains[i].snapshot == s.drains[i].snapshot
  requires forall i :: 0 <= i < |s.drains| && s.drains[i].id != drainId ==> after.drains[i] == s.drains[i]
  requires forall i :: 0 <= i < |s.drains| && s.drains[i].id == drainId ==>
    0 <= after.drains[i].cursor <= |after.drains[i].snapshot| && (after.drains[i].phase.DrainSucceeded? ==> !after.drains[i].aborted) &&
    ((after.drains[i].phase.BeforeHandler? || after.drains[i].phase.WaitingHandler?) ==> after.drains[i].cursor < |after.drains[i].snapshot|)
  ensures alwaysDrainBounds(after) && alwaysSuccessSurvivesPostAwaitCheck(after) && alwaysDrainIdsUnique(after) && alwaysActiveDrainHasAHandlerLeft(after) && stepSnapshotsStable(s, after)
{
  PreUnique(s);
  PreUnique(after);
  forall d | d in after.drains
    ensures 0 <= d.cursor <= |d.snapshot| && (d.phase.DrainSucceeded? ==> !d.aborted) && ((d.phase.BeforeHandler? || d.phase.WaitingHandler?) ==> d.cursor < |d.snapshot|)
  {
    var i :| 0 <= i < |after.drains| && after.drains[i] == d;
    assert s.drains[i] in s.drains;
  }
  forall d | d in s.drains ensures exists other :: other in after.drains && other.id == d.id && other.snapshot == d.snapshot {
    var i :| 0 <= i < |s.drains| && s.drains[i] == d;
    assert after.drains[i] in after.drains;
  }
}

lemma PreSnapshot(xs: seq<PreHandler>)
  requires |xs| > 0
  ensures |Std.Collections.Seq.FoldLeft((acc: seq<PreHandler>, handler: PreHandler) => insertPriority(acc, handler), emptyHandlers, xs)| > 0
{
  ProofLib.FoldLeftAppend((acc: seq<PreHandler>, handler: PreHandler) => insertPriority(acc, handler), emptyHandlers, xs[..|xs| - 1], xs[|xs| - 1]);
  assert xs[..|xs| - 1] + [xs[|xs| - 1]] == xs;
}

lemma beginDrain_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysDrainBounds(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysDrainIdsUnique(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysActiveDrainHasAHandlerLeft(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> stepSnapshotsStable(s, beginDrain(s, drainId)))
{
  if inv(s) && canBeginDrain(s, drainId) {
    var after := beginDrain(s, drainId);
    var added := after.drains[|s.drains|];
    assert after.drains == s.drains + [added];
    if |s.registry| > 0 { PreSnapshot(s.registry); }
    PreUnique(s);
    PreUnique(after);
    ProofLib.DistinctByConcat(s.drains, [added], (item: PreDrain) => item.id);
    forall d | d in after.drains
      ensures 0 <= d.cursor <= |d.snapshot| && (d.phase.DrainSucceeded? ==> !d.aborted) && ((d.phase.BeforeHandler? || d.phase.WaitingHandler?) ==> d.cursor < |d.snapshot|)
    {
      if d != added { assert d in s.drains; }
    }
    forall d | d in s.drains ensures exists other :: other in after.drains && other.id == d.id && other.snapshot == d.snapshot {
      assert d in after.drains;
    }
  }
}

lemma abortDrain_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysDrainBounds(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysDrainIdsUnique(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysActiveDrainHasAHandlerLeft(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> stepSnapshotsStable(s, abortDrain(s, drainId)))
{
  if inv(s) && canAbortDrain(s, drainId) {
    PreOnly(s, drainId);
    PreStep(s, abortDrain(s, drainId), drainId);
  }
}

lemma startHandler_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysDrainBounds(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysDrainIdsUnique(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysActiveDrainHasAHandlerLeft(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> stepSnapshotsStable(s, startHandler(s, drainId)))
{
  if inv(s) && canStartHandler(s, drainId) {
    PreOnly(s, drainId);
    PreStep(s, startHandler(s, drainId), drainId);
  }
}

lemma returnHandler_ensures(s: PreHandlers, drainId: int, hasResult: bool, text: string)
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysDrainBounds(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysSuccessSurvivesPostAwaitCheck(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysDrainIdsUnique(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysActiveDrainHasAHandlerLeft(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> stepSnapshotsStable(s, returnHandler(s, drainId, hasResult, text)))
{
  if inv(s) && canReturnHandler(s, drainId, hasResult, text) {
    PreOnly(s, drainId);
    PreStep(s, returnHandler(s, drainId, hasResult, text), drainId);
  }
}

lemma rejectHandler_ensures(s: PreHandlers, drainId: int, errorId: string)
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysDrainBounds(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysSuccessSurvivesPostAwaitCheck(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysDrainIdsUnique(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysActiveDrainHasAHandlerLeft(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> stepSnapshotsStable(s, rejectHandler(s, drainId, errorId)))
{
  if inv(s) && canRejectHandler(s, drainId, errorId) {
    PreOnly(s, drainId);
    PreStep(s, rejectHandler(s, drainId, errorId), drainId);
  }
}
