lemma DrainIdsView(s: PreHandlers)
  ensures alwaysDrainIdsUnique(s) == !(exists d :: d in s.drains && !(|ProofLib.Filter((other: PreDrain) => (other.id == d.id), s.drains)| == 1))
{}

lemma DrainLookupView(s: PreHandlers, drainId: int)
  ensures preDrain(s, drainId) == (if |ProofLib.Filter((d: PreDrain) => (d.id == drainId), s.drains)| > 0 then ProofLib.Filter((d: PreDrain) => (d.id == drainId), s.drains)[0] else noDrain)
{}

lemma DrainLookupMember(s: PreHandlers, drainId: int)
  requires alwaysDrainIdsUnique(s)
  ensures (preDrain(s, drainId).phase.BeforeHandler? || preDrain(s, drainId).phase.WaitingHandler?) ==> preDrain(s, drainId) in s.drains && preDrain(s, drainId).id == drainId
  ensures forall d :: d in s.drains && d.id == drainId ==> d == preDrain(s, drainId)
{
  DrainLookupView(s, drainId);
  DrainIdsView(s);
  var key := (d: PreDrain) => (d.id == drainId);
  var selected := ProofLib.Filter(key, s.drains);
  if |selected| > 0 {
    var chosen := selected[0];
    ProofLib.FilterMember(key, s.drains, chosen);
    assert chosen in s.drains && chosen.id == drainId;
    var same := (other: PreDrain) => (other.id == chosen.id);
    assert |ProofLib.Filter(same, s.drains)| == 1;
    ProofLib.FilterSamePredicate(same, key, s.drains);
    assert |selected| == 1;
    forall d | d in s.drains && d.id == drainId ensures d == preDrain(s, drainId) {
      ProofLib.FilterMember(key, s.drains, d);
      assert d in selected && d == selected[0];
    }
  } else {
    ProofLib.FilterNone(key, s.drains);
  }
}

lemma DrainMapShape(before: PreHandlers, after: PreHandlers)
  requires alwaysDrainIdsUnique(before)
  requires |after.drains| == |before.drains|
  requires forall i :: 0 <= i < |before.drains| ==> after.drains[i].id == before.drains[i].id && after.drains[i].snapshot == before.drains[i].snapshot
  ensures alwaysDrainIdsUnique(after)
  ensures stepSnapshotsStable(before, after)
{
  DrainIdsView(before);
  DrainIdsView(after);
  forall d | d in before.drains
    ensures exists other :: other in after.drains && other.id == d.id && other.snapshot == d.snapshot
  {
    var i :| 0 <= i < |before.drains| && before.drains[i] == d;
    assert after.drains[i] in after.drains;
  }
  forall d | d in after.drains
    ensures |ProofLib.Filter((other: PreDrain) => (other.id == d.id), after.drains)| == 1
  {
    var i :| 0 <= i < |after.drains| && after.drains[i] == d;
    var priorDrain := before.drains[i];
    assert priorDrain in before.drains && priorDrain.id == d.id;
    var prior := (other: PreDrain) => (other.id == priorDrain.id);
    var following := (other: PreDrain) => (other.id == d.id);
    assert |ProofLib.Filter(prior, before.drains)| == 1;
    ProofLib.FilterLengthPointwise(prior, following, before.drains, after.drains);
  }
}

lemma PriorityPartitionLength(handlers: seq<PreHandler>, handler: PreHandler)
  ensures |ProofLib.Filter((h: PreHandler) => (h.priority >= handler.priority), handlers)| + |ProofLib.Filter((h: PreHandler) => (h.priority < handler.priority), handlers)| == |handlers|
  decreases |handlers|
{
  var higher := (h: PreHandler) => (h.priority >= handler.priority);
  var lower := (h: PreHandler) => (h.priority < handler.priority);
  if |handlers| == 0 {
    ProofLib.FilterNil(higher, handlers);
    ProofLib.FilterNil(lower, handlers);
  } else {
    ProofLib.FilterCons(higher, handlers);
    ProofLib.FilterCons(lower, handlers);
    PriorityPartitionLength(handlers[1..], handler);
  }
}

lemma InsertPriorityLength(handlers: seq<PreHandler>, handler: PreHandler)
  ensures |insertPriority(handlers, handler)| == |handlers| + 1
{
  PriorityPartitionLength(handlers, handler);
  assert insertPriority(handlers, handler) == ((ProofLib.Filter((h: PreHandler) => (h.priority >= handler.priority), handlers) + [handler]) + ProofLib.Filter((h: PreHandler) => (h.priority < handler.priority), handlers));
}

lemma DrainSnapshotLength(registry: seq<PreHandler>, acc: seq<PreHandler>)
  ensures |Std.Collections.Seq.FoldLeft((acc: seq<PreHandler>, handler: PreHandler) => insertPriority(acc, handler), acc, registry)| == |acc| + |registry|
  decreases |registry|
{
  if |registry| > 0 {
    InsertPriorityLength(acc, registry[0]);
    DrainSnapshotLength(registry[1..], insertPriority(acc, registry[0]));
  }
}

lemma beginDrain_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysDrainBounds(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysDrainIdsUnique(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysActiveCursorNamesHandler(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> stepSnapshotsStable(s, beginDrain(s, drainId)))
{
  if inv(s) && canBeginDrain(s, drainId) {
    DrainSnapshotLength(s.registry, emptyHandlers);
    var after := beginDrain(s, drainId);
    var added := after.drains[|s.drains|];
    assert after.drains == s.drains + [added];
    DrainIdsView(s);
    DrainIdsView(after);
    forall d | d in after.drains
      ensures |ProofLib.Filter((other: PreDrain) => (other.id == d.id), after.drains)| == 1
    {
      var key := (other: PreDrain) => (other.id == d.id);
      ProofLib.FilterAppend(key, s.drains, added);
      if d == added {
        ProofLib.FilterNone(key, s.drains);
      } else {
        assert d in s.drains && d.id != drainId;
      }
    }
  }
}

lemma abortDrain_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysDrainBounds(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysDrainIdsUnique(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysActiveCursorNamesHandler(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> stepSnapshotsStable(s, abortDrain(s, drainId)))
{
  if inv(s) && canAbortDrain(s, drainId) {
    DrainLookupMember(s, drainId);
    var after := abortDrain(s, drainId);
    DrainMapShape(s, after);
    forall d | d in after.drains
      ensures d.phase.DrainSucceeded? ==> !d.aborted
    {
      var i :| 0 <= i < |after.drains| && after.drains[i] == d;
      var priorDrain := s.drains[i];
      if priorDrain.id == drainId { assert priorDrain == preDrain(s, drainId); }
    }
  }
}

lemma startHandler_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysDrainBounds(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysDrainIdsUnique(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysActiveCursorNamesHandler(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> stepSnapshotsStable(s, startHandler(s, drainId)))
{
  if inv(s) && canStartHandler(s, drainId) {
    DrainLookupMember(s, drainId);
    var after := startHandler(s, drainId);
    DrainMapShape(s, after);
    forall d | d in after.drains
      ensures (d.phase.BeforeHandler? || d.phase.WaitingHandler?) ==> d.cursor < |d.snapshot|
    {
      var i :| 0 <= i < |after.drains| && after.drains[i] == d;
      var priorDrain := s.drains[i];
      if priorDrain.id == drainId { assert priorDrain == preDrain(s, drainId); }
    }
  }
}

lemma returnHandler_ensures(s: PreHandlers, drainId: int, hasResult: bool, text: string)
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysDrainBounds(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysSuccessSurvivesPostAwaitCheck(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysDrainIdsUnique(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysActiveCursorNamesHandler(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> stepSnapshotsStable(s, returnHandler(s, drainId, hasResult, text)))
{
  if inv(s) && canReturnHandler(s, drainId, hasResult, text) {
    DrainLookupMember(s, drainId);
    var after := returnHandler(s, drainId, hasResult, text);
    DrainMapShape(s, after);
    forall d | d in after.drains
      ensures 0 <= d.cursor <= |d.snapshot|
      ensures (d.phase.BeforeHandler? || d.phase.WaitingHandler?) ==> d.cursor < |d.snapshot|
    {
      var i :| 0 <= i < |after.drains| && after.drains[i] == d;
      var priorDrain := s.drains[i];
      assert priorDrain in s.drains;
      if priorDrain.id == drainId {
        assert priorDrain == preDrain(s, drainId) && priorDrain.phase.WaitingHandler?;
        assert priorDrain.cursor < |priorDrain.snapshot|;
      }
    }
  }
}

lemma rejectHandler_ensures(s: PreHandlers, drainId: int, errorId: string)
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysDrainBounds(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysSuccessSurvivesPostAwaitCheck(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysDrainIdsUnique(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysActiveCursorNamesHandler(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> stepSnapshotsStable(s, rejectHandler(s, drainId, errorId)))
{
  if inv(s) && canRejectHandler(s, drainId, errorId) {
    var after := rejectHandler(s, drainId, errorId);
    DrainMapShape(s, after);
  }
}

