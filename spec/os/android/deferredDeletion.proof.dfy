lemma RowCounts(rows: seq<DeletionRow>)
  ensures (forall r :: r in rows ==> |ProofLib.Filter((x: DeletionRow) => (x.id == r.id), rows)| == 1) <==> ProofLib.DistinctBy(rows, (r: DeletionRow) => r.id)
{
  forall i | 0 <= i < |rows|
    ensures |ProofLib.Filter((x: DeletionRow) => (x.id == rows[i].id), rows)| == 1 <==> forall j :: 0 <= j < |rows| && j != i ==> rows[j].id != rows[i].id
  {
    ProofLib.FilterCountOneIffUnique((x: DeletionRow) => (x.id == rows[i].id), rows, (r: DeletionRow) => r.id, i);
  }
  if ProofLib.DistinctBy(rows, (r: DeletionRow) => r.id) {
    forall r | r in rows
      ensures |ProofLib.Filter((x: DeletionRow) => (x.id == r.id), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == r;
    }
  } else {
    var i, j :| 0 <= i < |rows| && 0 <= j < |rows| && i != j && rows[i].id == rows[j].id;
    assert rows[i] in rows;
  }
}

lemma EachIdBridge(s: DeletionJournal)
  ensures alwaysEachIdNamesOneRow(s) <==> ((forall r :: r in s.rows ==> r.id != "") && ProofLib.DistinctBy(s.rows, (r: DeletionRow) => r.id))
{
  RowCounts(s.rows);
}

lemma RowOfFacts(rows: seq<DeletionRow>, id: string)
  requires ProofLib.DistinctBy(rows, (r: DeletionRow) => r.id)
  ensures hasRow(rows, id) ==> rowOf(rows, id) in rows && rowOf(rows, id).id == id
  ensures forall r :: r in rows && r.id == id ==> r == rowOf(rows, id)
{
  var p := (r: DeletionRow) => (r.id == id);
  var f := ProofLib.Filter(p, rows);
  if hasRow(rows, id) {
    var r :| r in rows && r.id == id;
    ProofLib.FilterMember(p, rows, r);
    assert |f| > 0;
    assert f[0] in f;
    ProofLib.FilterMember(p, rows, f[0]);
    var i :| 0 <= i < |rows| && rows[i] == f[0];
    forall o | o in rows && o.id == id
      ensures o == f[0]
    {
      var j :| 0 <= j < |rows| && rows[j] == o;
      assert i == j;
    }
  }
}

lemma ReplaceRowFacts(rows: seq<DeletionRow>, row: DeletionRow)
  requires ProofLib.DistinctBy(rows, (r: DeletionRow) => r.id)
  requires hasRow(rows, row.id)
  ensures var next := replaceRow(rows, row);
    |next| == |rows|
    && row in next
    && (forall r :: r in next ==> r == row || (r in rows && r.id != row.id))
    && (forall r :: r in rows && r.id != row.id ==> r in next)
    && ProofLib.DistinctBy(next, (r: DeletionRow) => r.id)
    && hasRow(next, row.id)
    && rowOf(next, row.id) == row
{
  var next := replaceRow(rows, row);
  var orig :| orig in rows && orig.id == row.id;
  var idx :| 0 <= idx < |rows| && rows[idx] == orig;
  assert next[idx] == row;
  forall i | 0 <= i < |next|
    ensures next[i].id == rows[i].id
  {}
  forall r | r in next
    ensures r == row || (r in rows && r.id != row.id)
  {
    var i :| 0 <= i < |next| && next[i] == r;
    if rows[i].id != row.id {
      assert rows[i] in rows;
    }
  }
  forall r | r in rows && r.id != row.id
    ensures r in next
  {
    var i :| 0 <= i < |rows| && rows[i] == r;
    assert next[i] == r;
  }
  RowOfFacts(next, row.id);
}

lemma stage_ensures(s: DeletionJournal, by_: string, id: string, kind: DeletionKind, target: string, clock: os__android__deletionWindow_DeletionClock, fence: FenceRead, inspection: RecordInspection)
  ensures (inv(s) ==> canStage(s, by_, id, kind, target, clock, fence, inspection) ==> alwaysEachIdNamesOneRow(stage(s, by_, id, kind, target, clock, fence, inspection).state))
  ensures (inv(s) ==> canStage(s, by_, id, kind, target, clock, fence, inspection) ==> alwaysProviderCalledAtMostOnceAfterAClaim(stage(s, by_, id, kind, target, clock, fence, inspection).state))
  ensures (inv(s) ==> canStage(s, by_, id, kind, target, clock, fence, inspection) ==> alwaysKeptRowsHoldOnlyARefusedCall(stage(s, by_, id, kind, target, clock, fence, inspection).state))
  ensures (inv(s) ==> canStage(s, by_, id, kind, target, clock, fence, inspection) ==> alwaysOnlyACalledRowIsDismissed(stage(s, by_, id, kind, target, clock, fence, inspection).state))
  ensures (inv(s) ==> canStage(s, by_, id, kind, target, clock, fence, inspection) ==> stepStagingNeverChangesAStagedRow(s, "stage", stage(s, by_, id, kind, target, clock, fence, inspection).state))
  ensures (inv(s) ==> canStage(s, by_, id, kind, target, clock, fence, inspection) ==> stepOnlyAClaimAsksForTheProvider(s, "stage", stage(s, by_, id, kind, target, clock, fence, inspection).state, stage(s, by_, id, kind, target, clock, fence, inspection).out))
  ensures (inv(s) ==> canStage(s, by_, id, kind, target, clock, fence, inspection) ==> stepDismissalKeepsTheReceipt(s, "stage", stage(s, by_, id, kind, target, clock, fence, inspection).state))
  ensures (inv(s) ==> canStage(s, by_, id, kind, target, clock, fence, inspection) ==> stepRetentionKeepsUnresolvedRows(s, stage(s, by_, id, kind, target, clock, fence, inspection).state))
{
  if inv(s) && canStage(s, by_, id, kind, target, clock, fence, inspection) {
    var after := stage(s, by_, id, kind, target, clock, fence, inspection);
    EachIdBridge(s);
    if !hasRow(s.rows, id) {
      var local_1 := DeletionRow(id, kind, target, os__android__deletionWindow_PendingDeletion(by_, os__android__deletionWindow_deletionDeadline(clock), os__android__deletionWindow_DeletionPhase.Queued), DeletionHold.NotHeld, 0, false);
      assert after.state.rows == s.rows + [local_1];
      forall i | 0 <= i < |s.rows|
        ensures s.rows[i].id != id
      {
        assert s.rows[i] in s.rows;
      }
      EachIdBridge(after.state);
    }
  }
}

lemma lawAKnownIdStagesOnlyAsItsExactReplay_ensures(row: DeletionRow, by_: string, kind: DeletionKind, target: string, clock: os__android__deletionWindow_DeletionClock, inspection: RecordInspection)
  ensures (lawAKnownIdStagesOnlyAsItsExactReplay(row, by_, kind, target, clock, inspection) == true)
{
  var rows := [row];
  var p := (r: DeletionRow) => (r.id == row.id);
  assert row in rows;
  assert hasRow(rows, row.id);
  ProofLib.FilterCons(p, rows);
  ProofLib.FilterNil(p, rows[1..]);
  assert rowOf(rows, row.id) == row;
}

lemma expire_ensures(s: DeletionJournal, id: string, clock: os__android__deletionWindow_DeletionClock, authority: OwnerRead, admission: ProviderAdmission)
  ensures (inv(s) ==> canExpire(s, id, clock, authority, admission) ==> alwaysEachIdNamesOneRow(expire(s, id, clock, authority, admission).state))
  ensures (inv(s) ==> canExpire(s, id, clock, authority, admission) ==> alwaysProviderCalledAtMostOnceAfterAClaim(expire(s, id, clock, authority, admission).state))
  ensures (inv(s) ==> canExpire(s, id, clock, authority, admission) ==> alwaysKeptRowsHoldOnlyARefusedCall(expire(s, id, clock, authority, admission).state))
  ensures (inv(s) ==> canExpire(s, id, clock, authority, admission) ==> alwaysOnlyACalledRowIsDismissed(expire(s, id, clock, authority, admission).state))
  ensures (inv(s) ==> canExpire(s, id, clock, authority, admission) ==> stepStagingNeverChangesAStagedRow(s, "expire", expire(s, id, clock, authority, admission).state))
  ensures (inv(s) ==> canExpire(s, id, clock, authority, admission) ==> stepOnlyAClaimAsksForTheProvider(s, "expire", expire(s, id, clock, authority, admission).state, expire(s, id, clock, authority, admission).out))
  ensures (inv(s) ==> canExpire(s, id, clock, authority, admission) ==> stepDismissalKeepsTheReceipt(s, "expire", expire(s, id, clock, authority, admission).state))
  ensures (inv(s) ==> canExpire(s, id, clock, authority, admission) ==> stepRetentionKeepsUnresolvedRows(s, expire(s, id, clock, authority, admission).state))
{
  if inv(s) && canExpire(s, id, clock, authority, admission) {
    EachIdBridge(s);
    RowOfFacts(s.rows, id);
    var local_3 := rowOf(s.rows, id);
    var local_4 := os__android__deletionWindow_claimDeletion(local_3.entry, local_3.entry.owner, clock, os__android__deletionWindow_DeletionClaimAction.ClaimDispatch);
    var local_5 := expiryDecision(local_3, clock, authority, admission);
    if local_5.DispatchDeletion? {
      var updated := local_3.(entry := local_4.claimed, providerCalls := (local_3.providerCalls + 1));
      ReplaceRowFacts(s.rows, updated);
      EachIdBridge(expire(s, id, clock, authority, admission).state);
    } else if local_5.PauseDeletion? {
      var updated := local_3.(entry := local_3.entry.(deletionPhase := os__android__deletionWindow_DeletionPhase.Paused), hold := local_5.hold);
      ReplaceRowFacts(s.rows, updated);
      EachIdBridge(expire(s, id, clock, authority, admission).state);
    }
  }
}

lemma recordOutcome_ensures(s: DeletionJournal, id: string, readback: ProviderOutcome)
  ensures (inv(s) ==> canRecordOutcome(s, id) ==> alwaysEachIdNamesOneRow(recordOutcome(s, id, readback).state))
  ensures (inv(s) ==> canRecordOutcome(s, id) ==> alwaysProviderCalledAtMostOnceAfterAClaim(recordOutcome(s, id, readback).state))
  ensures (inv(s) ==> canRecordOutcome(s, id) ==> alwaysKeptRowsHoldOnlyARefusedCall(recordOutcome(s, id, readback).state))
  ensures (inv(s) ==> canRecordOutcome(s, id) ==> alwaysOnlyACalledRowIsDismissed(recordOutcome(s, id, readback).state))
  ensures (inv(s) ==> canRecordOutcome(s, id) ==> stepStagingNeverChangesAStagedRow(s, "recordOutcome", recordOutcome(s, id, readback).state))
  ensures (inv(s) ==> canRecordOutcome(s, id) ==> stepOnlyAClaimAsksForTheProvider(s, "recordOutcome", recordOutcome(s, id, readback).state, recordOutcome(s, id, readback).out))
  ensures (inv(s) ==> canRecordOutcome(s, id) ==> stepDismissalKeepsTheReceipt(s, "recordOutcome", recordOutcome(s, id, readback).state))
  ensures (inv(s) ==> canRecordOutcome(s, id) ==> stepRetentionKeepsUnresolvedRows(s, recordOutcome(s, id, readback).state))
{
  if inv(s) && canRecordOutcome(s, id) {
    EachIdBridge(s);
    RowOfFacts(s.rows, id);
    var local_6 := rowOf(s.rows, id);
    var local_7 := (if readback.OutcomeDeleted? then local_6.(entry := local_6.entry.(deletionPhase := os__android__deletionWindow_DeletionPhase.Deleted)) else (if readback.OutcomeConflict? then local_6.(entry := local_6.entry.(deletionPhase := os__android__deletionWindow_DeletionPhase.DeletionConflict)) else (if readback.OutcomePermissionRefused? then local_6.(entry := local_6.entry.(deletionPhase := os__android__deletionWindow_DeletionPhase.Paused), hold := DeletionHold.HeldPermissionRefused) else local_6.(entry := local_6.entry.(deletionPhase := os__android__deletionWindow_DeletionPhase.UnknownOutcome)))));
    ReplaceRowFacts(s.rows, local_7);
    EachIdBridge(recordOutcome(s, id, readback).state);
  }
}

lemma undo_ensures(s: DeletionJournal, by_: string, id: string, clock: os__android__deletionWindow_DeletionClock)
  ensures (inv(s) ==> canUndo(s, by_, id, clock) ==> alwaysEachIdNamesOneRow(undo(s, by_, id, clock).state))
  ensures (inv(s) ==> canUndo(s, by_, id, clock) ==> alwaysProviderCalledAtMostOnceAfterAClaim(undo(s, by_, id, clock).state))
  ensures (inv(s) ==> canUndo(s, by_, id, clock) ==> alwaysKeptRowsHoldOnlyARefusedCall(undo(s, by_, id, clock).state))
  ensures (inv(s) ==> canUndo(s, by_, id, clock) ==> alwaysOnlyACalledRowIsDismissed(undo(s, by_, id, clock).state))
  ensures (inv(s) ==> canUndo(s, by_, id, clock) ==> stepStagingNeverChangesAStagedRow(s, "undo", undo(s, by_, id, clock).state))
  ensures (inv(s) ==> canUndo(s, by_, id, clock) ==> stepOnlyAClaimAsksForTheProvider(s, "undo", undo(s, by_, id, clock).state, undo(s, by_, id, clock).out))
  ensures (inv(s) ==> canUndo(s, by_, id, clock) ==> stepDismissalKeepsTheReceipt(s, "undo", undo(s, by_, id, clock).state))
  ensures (inv(s) ==> canUndo(s, by_, id, clock) ==> stepRetentionKeepsUnresolvedRows(s, undo(s, by_, id, clock).state))
{
  if inv(s) && canUndo(s, by_, id, clock) {
    EachIdBridge(s);
    RowOfFacts(s.rows, id);
    var local_8 := rowOf(s.rows, id);
    var updated := local_8.(entry := os__android__deletionWindow_claimDeletion(local_8.entry, by_, clock, os__android__deletionWindow_DeletionClaimAction.ClaimUndo).claimed);
    ReplaceRowFacts(s.rows, updated);
    EachIdBridge(undo(s, by_, id, clock).state);
  }
}

lemma dismiss_ensures(s: DeletionJournal, by_: string, id: string)
  ensures (inv(s) ==> canDismiss(s, by_, id) ==> alwaysEachIdNamesOneRow(dismiss(s, by_, id).state))
  ensures (inv(s) ==> canDismiss(s, by_, id) ==> alwaysProviderCalledAtMostOnceAfterAClaim(dismiss(s, by_, id).state))
  ensures (inv(s) ==> canDismiss(s, by_, id) ==> alwaysKeptRowsHoldOnlyARefusedCall(dismiss(s, by_, id).state))
  ensures (inv(s) ==> canDismiss(s, by_, id) ==> alwaysOnlyACalledRowIsDismissed(dismiss(s, by_, id).state))
  ensures (inv(s) ==> canDismiss(s, by_, id) ==> stepStagingNeverChangesAStagedRow(s, "dismiss", dismiss(s, by_, id).state))
  ensures (inv(s) ==> canDismiss(s, by_, id) ==> stepOnlyAClaimAsksForTheProvider(s, "dismiss", dismiss(s, by_, id).state, dismiss(s, by_, id).out))
  ensures (inv(s) ==> canDismiss(s, by_, id) ==> stepDismissalKeepsTheReceipt(s, "dismiss", dismiss(s, by_, id).state))
  ensures (inv(s) ==> canDismiss(s, by_, id) ==> stepRetentionKeepsUnresolvedRows(s, dismiss(s, by_, id).state))
{
  if inv(s) && canDismiss(s, by_, id) {
    EachIdBridge(s);
    RowOfFacts(s.rows, id);
    var orig := rowOf(s.rows, id);
    var updated := orig.(dismissed := true);
    ReplaceRowFacts(s.rows, updated);
    EachIdBridge(dismiss(s, by_, id).state);
  }
}

lemma retire_ensures(s: DeletionJournal, id: string)
  ensures (inv(s) ==> canRetire(s, id) ==> alwaysEachIdNamesOneRow(retire(s, id).state))
  ensures (inv(s) ==> canRetire(s, id) ==> alwaysProviderCalledAtMostOnceAfterAClaim(retire(s, id).state))
  ensures (inv(s) ==> canRetire(s, id) ==> alwaysKeptRowsHoldOnlyARefusedCall(retire(s, id).state))
  ensures (inv(s) ==> canRetire(s, id) ==> alwaysOnlyACalledRowIsDismissed(retire(s, id).state))
  ensures (inv(s) ==> canRetire(s, id) ==> stepStagingNeverChangesAStagedRow(s, "retire", retire(s, id).state))
  ensures (inv(s) ==> canRetire(s, id) ==> stepOnlyAClaimAsksForTheProvider(s, "retire", retire(s, id).state, retire(s, id).out))
  ensures (inv(s) ==> canRetire(s, id) ==> stepDismissalKeepsTheReceipt(s, "retire", retire(s, id).state))
  ensures (inv(s) ==> canRetire(s, id) ==> stepRetentionKeepsUnresolvedRows(s, retire(s, id).state))
{
  if inv(s) && canRetire(s, id) {
    EachIdBridge(s);
    RowOfFacts(s.rows, id);
    var p := (r: DeletionRow) => (r.id != id);
    var after := retire(s, id).state;
    ProofLib.FilterKeepsDistinctBy(p, s.rows, (r: DeletionRow) => r.id);
    forall r | r in after.rows
      ensures r in s.rows && r.id != id
    {
      ProofLib.FilterMember(p, s.rows, r);
    }
    forall r | r in s.rows && r.id != id
      ensures r in after.rows
    {
      ProofLib.FilterMember(p, s.rows, r);
    }
    EachIdBridge(after);
  }
}
