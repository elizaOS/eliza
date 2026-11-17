// Proofs for spec/core/chatPreHandlers.md.
// Every drain transition but beginDrain rewrites one drain, found by its ID.
// DrainMapFacts gives every rule for such a rewrite from the facts about the
// one rewritten drain; DrainAt finds that drain from the guard.

lemma IdsDistinct(s: PreHandlers)
  requires alwaysDrainIdsUnique(s)
  ensures forall i, j :: 0 <= i < |s.drains| && 0 <= j < |s.drains| && i != j ==> s.drains[i].id != s.drains[j].id
{
  forall i, j | 0 <= i < |s.drains| && 0 <= j < |s.drains| && i != j
    ensures s.drains[i].id != s.drains[j].id
  {
    var d := s.drains[i];
    ProofLib.FilterCountOneIffUnique((other: PreDrain) => (other.id == d.id), s.drains, (other: PreDrain) => other.id, i);
  }
}

lemma IdsFromDistinct(t: PreHandlers)
  requires forall i, j :: 0 <= i < |t.drains| && 0 <= j < |t.drains| && i != j ==> t.drains[i].id != t.drains[j].id
  ensures alwaysDrainIdsUnique(t)
{
  forall d | d in t.drains
    ensures |ProofLib.Filter((other: PreDrain) => (other.id == d.id), t.drains)| == 1
  {
    var i :| 0 <= i < |t.drains| && t.drains[i] == d;
    ProofLib.FilterOne((other: PreDrain) => (other.id == d.id), t.drains, i);
  }
}

lemma DrainAt(s: PreHandlers, drainId: int)
  requires !preDrain(s, drainId).phase.DrainEmpty?
  ensures exists k :: 0 <= k < |s.drains| && s.drains[k] == preDrain(s, drainId) && s.drains[k].id == drainId
{
  var f := ProofLib.Filter((d: PreDrain) => (d.id == drainId), s.drains);
  ProofLib.FilterMember((d: PreDrain) => (d.id == drainId), s.drains, f[0]);
}

lemma DrainMapFacts(s: PreHandlers, t: PreHandlers, k: int)
  requires inv(s)
  requires |t.drains| == |s.drains| && 0 <= k < |s.drains|
  requires forall i :: 0 <= i < |s.drains| ==> t.drains[i].id == s.drains[i].id && t.drains[i].snapshot == s.drains[i].snapshot
  requires forall i :: 0 <= i < |s.drains| && i != k ==> t.drains[i] == s.drains[i]
  requires 0 <= t.drains[k].cursor <= |t.drains[k].snapshot|
  requires t.drains[k].phase.DrainSucceeded? ==> !t.drains[k].aborted
  requires (t.drains[k].phase.BeforeHandler? || t.drains[k].phase.WaitingHandler?) ==> t.drains[k].cursor < |t.drains[k].snapshot|
  ensures alwaysDrainBounds(t) && alwaysSuccessSurvivesPostAwaitCheck(t) && alwaysDrainIdsUnique(t) && alwaysActiveDrainHasHandler(t)
  ensures stepSnapshotsStable(s, t)
{
  IdsDistinct(s);
  IdsFromDistinct(t);
}

lemma SnapshotNonEmpty(start: seq<PreHandler>, xs: seq<PreHandler>)
  requires 0 < |start| || 0 < |xs|
  ensures 0 < |Std.Collections.Seq.FoldLeft((acc: seq<PreHandler>, handler: PreHandler) => insertPriority(acc, handler), start, xs)|
  decreases |xs|
{
  if 0 < |xs| {
    var next := insertPriority(start, xs[0]);
    SnapshotNonEmpty(next, xs[1..]);
  }
}

lemma beginDrain_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysDrainBounds(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysDrainIdsUnique(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> alwaysActiveDrainHasHandler(beginDrain(s, drainId)))
  ensures (inv(s) ==> canBeginDrain(s, drainId) ==> stepSnapshotsStable(s, beginDrain(s, drainId)))
{
  if inv(s) && canBeginDrain(s, drainId) {
    var after := beginDrain(s, drainId);
    if 0 < |s.registry| {
      SnapshotNonEmpty(emptyHandlers, s.registry);
    }
    IdsDistinct(s);
    IdsFromDistinct(after);
  }
}

lemma abortDrain_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysDrainBounds(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysDrainIdsUnique(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> alwaysActiveDrainHasHandler(abortDrain(s, drainId)))
  ensures (inv(s) ==> canAbortDrain(s, drainId) ==> stepSnapshotsStable(s, abortDrain(s, drainId)))
{
  if inv(s) && canAbortDrain(s, drainId) {
    var after := abortDrain(s, drainId);
    DrainAt(s, drainId);
    var k :| 0 <= k < |s.drains| && s.drains[k] == preDrain(s, drainId) && s.drains[k].id == drainId;
    IdsDistinct(s);
    DrainMapFacts(s, after, k);
  }
}

lemma startHandler_ensures(s: PreHandlers, drainId: int)
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysDrainBounds(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysSuccessSurvivesPostAwaitCheck(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysDrainIdsUnique(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> alwaysActiveDrainHasHandler(startHandler(s, drainId)))
  ensures (inv(s) ==> canStartHandler(s, drainId) ==> stepSnapshotsStable(s, startHandler(s, drainId)))
{
  if inv(s) && canStartHandler(s, drainId) {
    var after := startHandler(s, drainId);
    DrainAt(s, drainId);
    var k :| 0 <= k < |s.drains| && s.drains[k] == preDrain(s, drainId) && s.drains[k].id == drainId;
    IdsDistinct(s);
    DrainMapFacts(s, after, k);
  }
}

lemma returnHandler_ensures(s: PreHandlers, drainId: int, hasResult: bool, text: string)
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysDrainBounds(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysSuccessSurvivesPostAwaitCheck(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysDrainIdsUnique(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> alwaysActiveDrainHasHandler(returnHandler(s, drainId, hasResult, text)))
  ensures (inv(s) ==> canReturnHandler(s, drainId, hasResult, text) ==> stepSnapshotsStable(s, returnHandler(s, drainId, hasResult, text)))
{
  if inv(s) && canReturnHandler(s, drainId, hasResult, text) {
    var after := returnHandler(s, drainId, hasResult, text);
    DrainAt(s, drainId);
    var k :| 0 <= k < |s.drains| && s.drains[k] == preDrain(s, drainId) && s.drains[k].id == drainId;
    IdsDistinct(s);
    DrainMapFacts(s, after, k);
  }
}

lemma rejectHandler_ensures(s: PreHandlers, drainId: int, errorId: string)
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysDrainBounds(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysSuccessSurvivesPostAwaitCheck(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysDrainIdsUnique(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> alwaysActiveDrainHasHandler(rejectHandler(s, drainId, errorId)))
  ensures (inv(s) ==> canRejectHandler(s, drainId, errorId) ==> stepSnapshotsStable(s, rejectHandler(s, drainId, errorId)))
{
  if inv(s) && canRejectHandler(s, drainId, errorId) {
    var after := rejectHandler(s, drainId, errorId);
    DrainAt(s, drainId);
    var k :| 0 <= k < |s.drains| && s.drains[k] == preDrain(s, drainId) && s.drains[k].id == drainId;
    IdsDistinct(s);
    DrainMapFacts(s, after, k);
  }
}
