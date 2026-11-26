lemma FilterLenLe<T>(p: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    FilterLenLe(p, xs[1..]);
  }
}

lemma IssueTokenElements(table: seq<os__android__media__rows_OneShotToken>, at: int, capacity: int, tokenId: int, ttl: int)
  requires |table| <= capacity && capacity >= 1
  ensures var issued := os__android__media__rows_issueToken(table, at, capacity, tokenId, ttl);
    var added := os__android__media__rows_OneShotToken(tokenId, at + ttl);
    |issued| <= capacity && added in issued && forall t :: t in issued ==> t == added || t in table
{
  var local_0 := ProofLib.Filter((t: os__android__media__rows_OneShotToken) => (at <= t.until), table);
  FilterLenLe((t: os__android__media__rows_OneShotToken) => (at <= t.until), table);
  var local_1 := if |local_0| >= capacity then (if 0 < |local_0| then local_0[0..0] + local_0[1..] else local_0) else local_0;
  var added := os__android__media__rows_OneShotToken(tokenId, at + ttl);
  assert os__android__media__rows_issueToken(table, at, capacity, tokenId, ttl) == local_1 + [added];
  forall t | t in local_0
    ensures t in table
  {
    ProofLib.FilterMember((x: os__android__media__rows_OneShotToken) => (at <= x.until), table, t);
  }
  assert forall t :: t in local_1 ==> t in local_0;
}

lemma prepareTrashDelete_ensures(s: OwnedTrash, apiLevel: int, request: TrashRequest, listed: seq<ListedTrashRow>)
  ensures (inv(s) ==> canPrepareTrashDelete(s, apiLevel, request, listed) ==> alwaysAtMostFourConfirmations(prepareTrashDelete(s, apiLevel, request, listed)))
  ensures (inv(s) ==> canPrepareTrashDelete(s, apiLevel, request, listed) ==> alwaysConfirmationsEndWithinTheirLifetime(prepareTrashDelete(s, apiLevel, request, listed)))
  ensures (inv(s) ==> canPrepareTrashDelete(s, apiLevel, request, listed) ==> alwaysConfirmationsAndSnapshotsPair(prepareTrashDelete(s, apiLevel, request, listed)))
  ensures (inv(s) ==> canPrepareTrashDelete(s, apiLevel, request, listed) ==> alwaysDeletionCursorInSnapshot(prepareTrashDelete(s, apiLevel, request, listed)))
  ensures (inv(s) ==> canPrepareTrashDelete(s, apiLevel, request, listed) ==> alwaysReceiptNamesOnlySnapshotTargets(prepareTrashDelete(s, apiLevel, request, listed)))
  ensures (inv(s) ==> canPrepareTrashDelete(s, apiLevel, request, listed) ==> alwaysDeletedMeansNothingSkippedOrFailed(prepareTrashDelete(s, apiLevel, request, listed)))
  ensures (inv(s) ==> canPrepareTrashDelete(s, apiLevel, request, listed) ==> alwaysClosedHostHoldsNoConfirmation(prepareTrashDelete(s, apiLevel, request, listed)))
  ensures (inv(s) ==> canPrepareTrashDelete(s, apiLevel, request, listed) ==> stepSnapshotFrozenWhileDeleting(s, prepareTrashDelete(s, apiLevel, request, listed)))
{
  if inv(s) && canPrepareTrashDelete(s, apiLevel, request, listed) {
    var after := prepareTrashDelete(s, apiLevel, request, listed);
    var local_4 := os__android__media__rows_issueToken(s.confirmations, s.clock, confirmationCapacity, s.nextConfirmation, os__android__media__rows_tokenLifetimeMs);
    var added := os__android__media__rows_OneShotToken(s.nextConfirmation, s.clock + os__android__media__rows_tokenLifetimeMs);
    var freshPrep := PreparedTrash(s.nextConfirmation, seq(|listed|, i_map requires 0 <= i_map < |listed| => var r := listed[i_map]; TrashTarget(r.key, r.generation)));
    var filteredPrep := ProofLib.Filter((p: PreparedTrash) => (exists t :: t in local_4 && (t.id == p.id)), s.prepared);
    assert after.confirmations == local_4;
    assert after.prepared == filteredPrep + [freshPrep];
    IssueTokenElements(s.confirmations, s.clock, confirmationCapacity, s.nextConfirmation, os__android__media__rows_tokenLifetimeMs);
    forall t | t in local_4
      ensures exists p :: p in after.prepared && p.id == t.id
    {
      if t == added {
        assert freshPrep in after.prepared && freshPrep.id == t.id;
      } else {
        assert t in s.confirmations;
        var p :| p in s.prepared && p.id == t.id;
        ProofLib.FilterMember((x: PreparedTrash) => (exists u :: u in local_4 && (u.id == x.id)), s.prepared, p);
        assert p in filteredPrep;
        assert p in after.prepared;
      }
    }
    forall p | p in after.prepared
      ensures exists t :: t in local_4 && t.id == p.id
    {
      if p == freshPrep {
        assert added in local_4 && added.id == p.id;
      } else {
        assert p in filteredPrep;
        ProofLib.FilterMember((x: PreparedTrash) => (exists u :: u in local_4 && (u.id == x.id)), s.prepared, p);
      }
    }
  }
}

lemma DropTokenAndPrepared(s: OwnedTrash, tokenId: int)
  requires inv(s)
  ensures var c := os__android__media__rows_dropToken(s.confirmations, tokenId);
    var pr := ProofLib.Filter((p: PreparedTrash) => (p.id != tokenId), s.prepared);
    |c| <= |s.confirmations| &&
    (forall t :: t in c ==> t.until <= s.clock + os__android__media__rows_tokenLifetimeMs) &&
    (forall t :: t in c ==> exists p :: p in pr && p.id == t.id) &&
    (forall p :: p in pr ==> exists t :: t in c && t.id == p.id)
{
  var c := ProofLib.Filter((t: os__android__media__rows_OneShotToken) => (t.id != tokenId), s.confirmations);
  var pr := ProofLib.Filter((p: PreparedTrash) => (p.id != tokenId), s.prepared);
  assert c == os__android__media__rows_dropToken(s.confirmations, tokenId);
  FilterLenLe((t: os__android__media__rows_OneShotToken) => (t.id != tokenId), s.confirmations);
  forall t | t in c
    ensures t.until <= s.clock + os__android__media__rows_tokenLifetimeMs
    ensures exists p :: p in pr && p.id == t.id
  {
    ProofLib.FilterMember((x: os__android__media__rows_OneShotToken) => (x.id != tokenId), s.confirmations, t);
    var p :| p in s.prepared && p.id == t.id;
    ProofLib.FilterMember((x: PreparedTrash) => (x.id != tokenId), s.prepared, p);
    assert p in pr;
  }
  forall p | p in pr
    ensures exists t :: t in c && t.id == p.id
  {
    ProofLib.FilterMember((x: PreparedTrash) => (x.id != tokenId), s.prepared, p);
    var t :| t in s.confirmations && t.id == p.id;
    ProofLib.FilterMember((x: os__android__media__rows_OneShotToken) => (x.id != tokenId), s.confirmations, t);
    assert t in c;
  }
}

lemma cancelTrashDelete_ensures(s: OwnedTrash, tokenId: int)
  ensures (inv(s) ==> canCancelTrashDelete(s) ==> alwaysAtMostFourConfirmations(cancelTrashDelete(s, tokenId)))
  ensures (inv(s) ==> canCancelTrashDelete(s) ==> alwaysConfirmationsEndWithinTheirLifetime(cancelTrashDelete(s, tokenId)))
  ensures (inv(s) ==> canCancelTrashDelete(s) ==> alwaysConfirmationsAndSnapshotsPair(cancelTrashDelete(s, tokenId)))
  ensures (inv(s) ==> canCancelTrashDelete(s) ==> alwaysDeletionCursorInSnapshot(cancelTrashDelete(s, tokenId)))
  ensures (inv(s) ==> canCancelTrashDelete(s) ==> alwaysReceiptNamesOnlySnapshotTargets(cancelTrashDelete(s, tokenId)))
  ensures (inv(s) ==> canCancelTrashDelete(s) ==> alwaysDeletedMeansNothingSkippedOrFailed(cancelTrashDelete(s, tokenId)))
  ensures (inv(s) ==> canCancelTrashDelete(s) ==> alwaysClosedHostHoldsNoConfirmation(cancelTrashDelete(s, tokenId)))
  ensures (inv(s) ==> canCancelTrashDelete(s) ==> stepSnapshotFrozenWhileDeleting(s, cancelTrashDelete(s, tokenId)))
{
  if inv(s) && canCancelTrashDelete(s) {
    DropTokenAndPrepared(s, tokenId);
  }
}

lemma beginTrashDelete_ensures(s: OwnedTrash, apiLevel: int, tokenId: int)
  ensures (inv(s) ==> canBeginTrashDelete(s, apiLevel) ==> alwaysAtMostFourConfirmations(beginTrashDelete(s, apiLevel, tokenId)))
  ensures (inv(s) ==> canBeginTrashDelete(s, apiLevel) ==> alwaysConfirmationsEndWithinTheirLifetime(beginTrashDelete(s, apiLevel, tokenId)))
  ensures (inv(s) ==> canBeginTrashDelete(s, apiLevel) ==> alwaysConfirmationsAndSnapshotsPair(beginTrashDelete(s, apiLevel, tokenId)))
  ensures (inv(s) ==> canBeginTrashDelete(s, apiLevel) ==> alwaysDeletionCursorInSnapshot(beginTrashDelete(s, apiLevel, tokenId)))
  ensures (inv(s) ==> canBeginTrashDelete(s, apiLevel) ==> alwaysReceiptNamesOnlySnapshotTargets(beginTrashDelete(s, apiLevel, tokenId)))
  ensures (inv(s) ==> canBeginTrashDelete(s, apiLevel) ==> alwaysDeletedMeansNothingSkippedOrFailed(beginTrashDelete(s, apiLevel, tokenId)))
  ensures (inv(s) ==> canBeginTrashDelete(s, apiLevel) ==> alwaysClosedHostHoldsNoConfirmation(beginTrashDelete(s, apiLevel, tokenId)))
  ensures (inv(s) ==> canBeginTrashDelete(s, apiLevel) ==> stepSnapshotFrozenWhileDeleting(s, beginTrashDelete(s, apiLevel, tokenId)))
{
  if inv(s) && canBeginTrashDelete(s, apiLevel) {
    DropTokenAndPrepared(s, tokenId);
  }
}

lemma deleteTrashRow_ensures(s: OwnedTrash, evidence: RowDeleteEvidence)
  ensures (inv(s) ==> canDeleteTrashRow(s) ==> alwaysAtMostFourConfirmations(deleteTrashRow(s, evidence)))
  ensures (inv(s) ==> canDeleteTrashRow(s) ==> alwaysConfirmationsEndWithinTheirLifetime(deleteTrashRow(s, evidence)))
  ensures (inv(s) ==> canDeleteTrashRow(s) ==> alwaysConfirmationsAndSnapshotsPair(deleteTrashRow(s, evidence)))
  ensures (inv(s) ==> canDeleteTrashRow(s) ==> alwaysDeletionCursorInSnapshot(deleteTrashRow(s, evidence)))
  ensures (inv(s) ==> canDeleteTrashRow(s) ==> alwaysReceiptNamesOnlySnapshotTargets(deleteTrashRow(s, evidence)))
  ensures (inv(s) ==> canDeleteTrashRow(s) ==> alwaysDeletedMeansNothingSkippedOrFailed(deleteTrashRow(s, evidence)))
  ensures (inv(s) ==> canDeleteTrashRow(s) ==> alwaysClosedHostHoldsNoConfirmation(deleteTrashRow(s, evidence)))
  ensures (inv(s) ==> canDeleteTrashRow(s) ==> stepSnapshotFrozenWhileDeleting(s, deleteTrashRow(s, evidence)))
{
  if inv(s) && canDeleteTrashRow(s) {
    var after := deleteTrashRow(s, evidence);
    var oldIds := (s.receipt.deletedIds + s.receipt.skippedIds) + s.receipt.failedIds;
    var newIds := (after.receipt.deletedIds + after.receipt.skippedIds) + after.receipt.failedIds;
    var target := s.targets[s.position];
    forall k | k in newIds
      ensures exists t :: t in s.targets && t.key == k
    {
      if k == target.key {
        assert target in s.targets;
      } else {
        assert k in oldIds;
      }
    }
  }
}
