// spec/computerUse/approvals.md, "Story: Gate computer-use commands by approval mode and operator decisions"

lemma UniqueBridge(q: ApprovalQueue)
  ensures alwaysPendingIdsUnique(q) == !(exists id :: id in q.pendingIds && !(|ProofLib.Filter((x: int) => (x == id), q.pendingIds)| == 1))
{
}

lemma UniqueImpliesDistinct(xs: seq<int>)
  requires !(exists id :: id in xs && !(|ProofLib.Filter((x: int) => (x == id), xs)| == 1))
  ensures ProofLib.Distinct(xs)
{
  forall i, j | 0 <= i < j < |xs|
    ensures xs[i] != xs[j]
  {
    assert xs[i] in xs;
    assert |ProofLib.Filter((x: int) => (x == xs[i]), xs)| == 1;
    ProofLib.FilterCountOneIffUnique((x: int) => (x == xs[i]), xs, (x: int) => x, i);
  }
}

lemma DistinctImpliesUnique(xs: seq<int>)
  requires ProofLib.Distinct(xs)
  ensures !(exists id :: id in xs && !(|ProofLib.Filter((x: int) => (x == id), xs)| == 1))
{
  forall id | id in xs
    ensures |ProofLib.Filter((x: int) => (x == id), xs)| == 1
  {
    ProofLib.FilterDistinctCountOne((x: int) => (x == id), xs, id);
  }
}

lemma FilterNeqAllKept(p: int -> bool, xs: seq<int>, target: int)
  requires forall x :: p(x) == (x != target)
  requires !(target in xs)
  ensures ProofLib.Filter(p, xs) == xs
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    assert xs[0] != target;
    assert !(target in xs[1..]);
    FilterNeqAllKept(p, xs[1..], target);
  }
}

lemma FilterNeqUniqueLength(p: int -> bool, xs: seq<int>, target: int)
  requires forall x :: p(x) == (x != target)
  requires ProofLib.Distinct(xs)
  requires target in xs
  ensures |ProofLib.Filter(p, xs)| == |xs| - 1
  decreases |xs|
{
  ProofLib.FilterCons(p, xs);
  if xs[0] == target {
    assert !(target in xs[1..]) by {
      forall j | 0 <= j < |xs[1..]|
        ensures xs[1..][j] != target
      {
        assert xs[1..][j] == xs[j + 1];
      }
    }
    FilterNeqAllKept(p, xs[1..], target);
  } else {
    assert target in xs[1..];
    assert ProofLib.Distinct(xs[1..]) by {
      forall i, j | 0 <= i < j < |xs[1..]|
        ensures xs[1..][i] != xs[1..][j]
      {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
    }
    FilterNeqUniqueLength(p, xs[1..], target);
  }
}

lemma FilterKeepsDistinctInts(p: int -> bool, xs: seq<int>)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(ProofLib.Filter(p, xs))
{
  assert ProofLib.DistinctBy(xs, (x: int) => x);
  ProofLib.FilterKeepsDistinctBy(p, xs, (x: int) => x);
}

lemma RemoveApprovalHelper(q: ApprovalQueue, approvalId: int, after: ApprovalQueue, p: int -> bool)
  requires inv(q)
  requires approvalId in q.pendingIds
  requires forall x :: p(x) == (x != approvalId)
  requires after.nextId == q.nextId
  requires after.pendingIds == ProofLib.Filter(p, q.pendingIds)
  ensures alwaysPendingIdsIssued(after)
  ensures alwaysPendingIdsUnique(after)
  ensures |after.pendingIds| == |q.pendingIds| - 1
{
  UniqueBridge(q);
  UniqueImpliesDistinct(q.pendingIds);
  FilterNeqUniqueLength(p, q.pendingIds, approvalId);
  FilterKeepsDistinctInts(p, q.pendingIds);
  DistinctImpliesUnique(after.pendingIds);
  UniqueBridge(after);
  forall id | id in after.pendingIds
    ensures id >= 1 && id < after.nextId
  {
    ProofLib.FilterMember(p, q.pendingIds, id);
    assert id in q.pendingIds;
  }
}

lemma enqueueApproval_ensures(q: ApprovalQueue, risk: CommandRisk)
  ensures (inv(q) ==> canEnqueueApproval(q, risk) ==> alwaysApprovalCountsValid(enqueueApproval(q, risk)))
  ensures (inv(q) ==> canEnqueueApproval(q, risk) ==> alwaysPendingIdsIssued(enqueueApproval(q, risk)))
  ensures (inv(q) ==> canEnqueueApproval(q, risk) ==> alwaysPendingIdsUnique(enqueueApproval(q, risk)))
  ensures (inv(q) ==> canEnqueueApproval(q, risk) ==> alwaysOffModeHasNoPending(enqueueApproval(q, risk)))
  ensures (inv(q) ==> canEnqueueApproval(q, risk) ==> alwaysIssuedAccountingBalanced(enqueueApproval(q, risk)))
  ensures (inv(q) ==> canEnqueueApproval(q, risk) ==> stepNextIdMonotonic(q, enqueueApproval(q, risk)))
{
  if inv(q) && canEnqueueApproval(q, risk) {
    var after := enqueueApproval(q, risk);
    UniqueBridge(q);
    UniqueImpliesDistinct(q.pendingIds);
    assert ProofLib.Distinct(after.pendingIds) by {
      forall i, j | 0 <= i < j < |after.pendingIds|
        ensures after.pendingIds[i] != after.pendingIds[j]
      {
        if j < |q.pendingIds| {
          assert after.pendingIds[i] == q.pendingIds[i];
          assert after.pendingIds[j] == q.pendingIds[j];
        } else {
          assert after.pendingIds[j] == q.nextId;
          assert after.pendingIds[i] == q.pendingIds[i];
          assert q.pendingIds[i] in q.pendingIds;
          assert q.pendingIds[i] < q.nextId;
        }
      }
    }
    DistinctImpliesUnique(after.pendingIds);
    UniqueBridge(after);
  }
}

lemma resolveApproval_ensures(q: ApprovalQueue, approvalId: int, approved: bool)
  ensures (inv(q) ==> canResolveApproval(q, approvalId, approved) ==> alwaysApprovalCountsValid(resolveApproval(q, approvalId, approved)))
  ensures (inv(q) ==> canResolveApproval(q, approvalId, approved) ==> alwaysPendingIdsIssued(resolveApproval(q, approvalId, approved)))
  ensures (inv(q) ==> canResolveApproval(q, approvalId, approved) ==> alwaysPendingIdsUnique(resolveApproval(q, approvalId, approved)))
  ensures (inv(q) ==> canResolveApproval(q, approvalId, approved) ==> alwaysOffModeHasNoPending(resolveApproval(q, approvalId, approved)))
  ensures (inv(q) ==> canResolveApproval(q, approvalId, approved) ==> alwaysIssuedAccountingBalanced(resolveApproval(q, approvalId, approved)))
  ensures (inv(q) ==> canResolveApproval(q, approvalId, approved) ==> stepNextIdMonotonic(q, resolveApproval(q, approvalId, approved)))
{
  if inv(q) && canResolveApproval(q, approvalId, approved) {
    var after := resolveApproval(q, approvalId, approved);
    var p := (id: int) => (id != approvalId);
    assert after.pendingIds == ProofLib.Filter(p, q.pendingIds);
    RemoveApprovalHelper(q, approvalId, after, p);
  }
}

lemma cancelApproval_ensures(q: ApprovalQueue, approvalId: int)
  ensures (inv(q) ==> canCancelApproval(q, approvalId) ==> alwaysApprovalCountsValid(cancelApproval(q, approvalId)))
  ensures (inv(q) ==> canCancelApproval(q, approvalId) ==> alwaysPendingIdsIssued(cancelApproval(q, approvalId)))
  ensures (inv(q) ==> canCancelApproval(q, approvalId) ==> alwaysPendingIdsUnique(cancelApproval(q, approvalId)))
  ensures (inv(q) ==> canCancelApproval(q, approvalId) ==> alwaysOffModeHasNoPending(cancelApproval(q, approvalId)))
  ensures (inv(q) ==> canCancelApproval(q, approvalId) ==> alwaysIssuedAccountingBalanced(cancelApproval(q, approvalId)))
  ensures (inv(q) ==> canCancelApproval(q, approvalId) ==> stepNextIdMonotonic(q, cancelApproval(q, approvalId)))
{
  if inv(q) && canCancelApproval(q, approvalId) {
    var after := cancelApproval(q, approvalId);
    var p := (id: int) => (id != approvalId);
    assert after.pendingIds == ProofLib.Filter(p, q.pendingIds);
    RemoveApprovalHelper(q, approvalId, after, p);
  }
}
