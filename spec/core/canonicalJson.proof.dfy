// Proofs for spec/core/canonicalJson.md, "Every traversal reserves its work before inspecting a new container".

// Replacing the top breadth keeps every lower frame's breadth and adds only the new one.
lemma ReplaceTopBreadthMembers(breadth: JsonBreadth, j: JsonWalk)
  requires |j.breadths| > 0
  ensures |replaceTopBreadth(breadth, j)| == |j.breadths|
  ensures forall b :: b in replaceTopBreadth(breadth, j) ==> b == breadth || b in j.breadths
{
  var n := |j.breadths|;
  forall b | b in replaceTopBreadth(breadth, j)
    ensures b == breadth || b in j.breadths
  {
    if b in j.breadths[0..n - 1] {
      var i :| 0 <= i < n - 1 && j.breadths[0..n - 1][i] == b;
    }
  }
}

lemma reserveBreadth_ensures(j: JsonWalk)
  ensures (inv(j) ==> canReserveBreadth(j) ==> alwaysTraversalWithinBudgets(reserveBreadth(j)))
  ensures (inv(j) ==> canReserveBreadth(j) ==> alwaysChargesBelongToWalk(reserveBreadth(j)))
  ensures (inv(j) ==> canReserveBreadth(j) ==> stepRejectedWalkRemainsRejected(j, reserveBreadth(j)))
{
  if inv(j) && canReserveBreadth(j) {
    var width := breadthWidth(topBreadth(j));
    ReplaceTopBreadthMembers(ReservedBreadth(width, width), j);
  }
}

lemma inspectSlot_ensures(j: JsonWalk, descends: bool)
  ensures (inv(j) ==> canInspectSlot(j, descends) ==> alwaysTraversalWithinBudgets(inspectSlot(j, descends)))
  ensures (inv(j) ==> canInspectSlot(j, descends) ==> alwaysChargesBelongToWalk(inspectSlot(j, descends)))
  ensures (inv(j) ==> canInspectSlot(j, descends) ==> stepRejectedWalkRemainsRejected(j, inspectSlot(j, descends)))
{
  if inv(j) && canInspectSlot(j, descends) {
    var after := inspectSlot(j, descends);
    var top := topBreadth(j);
    assert top in j.breadths;
    var next := ReservedBreadth(breadthWidth(top), breadthRemaining(top) - 1);
    ReplaceTopBreadthMembers(next, j);
    forall b | b in after.breadths
      ensures validBreadth(b, after.visits)
    {
      if b != next {
        assert b in j.breadths;
      }
    }
  }
}
