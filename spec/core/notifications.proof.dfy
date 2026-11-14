lemma NotificationRowCounts(s: Inbox)
  ensures alwaysNoticeIdsAreUnique(s) == ((forall row :: row in s.memory ==> |ProofLib.Filter((other: Notice) => other.id == row.id, s.memory)| == 1) && (forall row :: row in s.disk ==> |ProofLib.Filter((other: Notice) => other.id == row.id, s.disk)| == 1))
{}

lemma NotificationPendingCounts(s: Inbox)
  requires alwaysFreshNotificationIdentity(s)
  ensures forall mutation :: mutation in s.pending && mutation.kind.AddNotice? ==> |ProofLib.Filter((other: NoticeMutation) => other.kind.AddNotice? && other.id == mutation.id, s.pending)| == 1
{}

lemma NotificationFilterRows(rows: seq<Notice>, p: Notice -> bool)
  requires forall row :: row in rows ==> |ProofLib.Filter((other: Notice) => other.id == row.id, rows)| == 1
  ensures forall row :: row in ProofLib.Filter(p, rows) ==> |ProofLib.Filter((other: Notice) => other.id == row.id, ProofLib.Filter(p, rows))| == 1
{
  forall row | row in ProofLib.Filter(p, rows)
    ensures |ProofLib.Filter((other: Notice) => other.id == row.id, ProofLib.Filter(p, rows))| == 1
  {
    ProofLib.FilterMember(p, rows, row);
    ProofLib.FilterOfFilterShorter(p, (other: Notice) => other.id == row.id, rows);
    ProofLib.FilterMember((other: Notice) => other.id == row.id, ProofLib.Filter(p, rows), row);
  }
}

lemma NotificationAppendFresh(rows: seq<Notice>, added: Notice)
  requires forall row :: row in rows ==> |ProofLib.Filter((other: Notice) => other.id == row.id, rows)| == 1
  requires forall row :: row in rows ==> row.id != added.id
  ensures forall row :: row in rows + [added] ==> |ProofLib.Filter((other: Notice) => other.id == row.id, rows + [added])| == 1
{
  forall row | row in rows + [added]
    ensures |ProofLib.Filter((other: Notice) => other.id == row.id, rows + [added])| == 1
  {
    ProofLib.FilterAppend((other: Notice) => other.id == row.id, rows, added);
    if row == added { ProofLib.FilterNone((other: Notice) => other.id == row.id, rows); }
    else { assert row in rows; }
  }
}

lemma NotificationTailFresh(s: Inbox)
  requires inv(s) && |s.pending| > 0 && s.pending[0].kind.AddNotice?
  ensures forall mutation :: mutation in s.pending[1..] && mutation.kind.AddNotice? ==> mutation.id != s.pending[0].id
{
  NotificationPendingCounts(s);
  forall mutation | mutation in s.pending[1..] && mutation.kind.AddNotice?
    ensures mutation.id != s.pending[0].id
  {
    if mutation.id == s.pending[0].id {
      var index :| 0 <= index < |s.pending[1..]| && s.pending[1..][index] == mutation;
      assert s.pending[index + 1] == mutation;
      var queued :=  s.pending[0];
      ProofLib.FilterTwo((other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, s.pending, 0, index + 1);
    }
  }
}

lemma NotificationMarkedRows(rows: seq<Notice>, mutation: NoticeMutation)
  requires forall row :: row in rows ==> |ProofLib.Filter((other: Notice) => other.id == row.id, rows)| == 1
  ensures |markedNotifications(rows, mutation)| == |rows|
  ensures forall row :: row in markedNotifications(rows, mutation) ==> |ProofLib.Filter((other: Notice) => other.id == row.id, markedNotifications(rows, mutation))| == 1
  ensures forall row :: row in markedNotifications(rows, mutation) ==> exists prior :: prior in rows && prior.id == row.id && prior.sequence == row.sequence
  ensures forall prior :: prior in rows ==> exists row :: row in markedNotifications(rows, mutation) && prior.id == row.id && prior.sequence == row.sequence
{
  var marked := markedNotifications(rows, mutation);
  forall i | 0 <= i < |marked|
    ensures rows[i].id == marked[i].id && rows[i].sequence == marked[i].sequence
  {}
  forall row | row in marked
    ensures |ProofLib.Filter((other: Notice) => other.id == row.id, marked)| == 1
    ensures exists prior :: prior in rows && prior.id == row.id && prior.sequence == row.sequence
  {
    var i :| 0 <= i < |marked| && marked[i] == row;
    assert rows[i] in rows;
    ProofLib.FilterLengthPointwise((other: Notice) => other.id == row.id, (other: Notice) => other.id == row.id, rows, marked);
  }
  forall prior | prior in rows
    ensures exists row :: row in marked && prior.id == row.id && prior.sequence == row.sequence
  {
    var i :| 0 <= i < |rows| && rows[i] == prior;
    assert marked[i] in marked;
  }
}

lemma NotificationFreshFacts(s: Inbox)
  ensures alwaysFreshNotificationIdentity(s) ==
    ((forall row :: row in s.memory ==> row.id in s.issuedIds) &&
     (forall row :: row in s.disk ==> row.id in s.issuedIds) &&
     (forall queued :: queued in s.pending ==> freshPendingAgainstRows(s, queued)) &&
     (forall queued :: queued in s.pending && queued.kind.AddNotice? ==>
       |ProofLib.Filter((other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, s.pending)| == 1))
{}

lemma NotificationFreshAppend(s: Inbox, queued: NoticeMutation, issued: seq<string>)
  requires alwaysFreshNotificationIdentity(s)
  requires forall id :: id in s.issuedIds ==> id in issued
  requires queued.kind.AddNotice? ==> queued.id in issued && !(queued.id in s.issuedIds) && queued.id != "" && queued.id == queued.input.id
  ensures alwaysFreshNotificationIdentity(s.(pending := s.pending + [queued], issuedIds := issued))
{
  var after := s.(pending := s.pending + [queued], issuedIds := issued);
  NotificationFreshFacts(s);
  NotificationFreshFacts(after);
  forall current | current in after.pending
    ensures freshPendingAgainstRows(after, current)
    ensures current.kind.AddNotice? ==> |ProofLib.Filter((other: NoticeMutation) => other.kind.AddNotice? && other.id == current.id, after.pending)| == 1
  {
    if current != queued {
      assert current in s.pending;
      assert freshPendingAgainstRows(s, current);
    }
    if current.kind.AddNotice? {
      ProofLib.FilterAppend((other: NoticeMutation) => other.kind.AddNotice? && other.id == current.id, s.pending, queued);
      if current == queued {
        forall prior | prior in s.pending ensures !prior.kind.AddNotice? || prior.id != current.id {
          assert freshPendingAgainstRows(s, prior);
        }
        ProofLib.FilterNone((other: NoticeMutation) => other.kind.AddNotice? && other.id == current.id, s.pending);
      } else {
        assert current.id in s.issuedIds;
      }
    }
  }
}

lemma NotificationFreshIssue(s: Inbox, id: string, issued: seq<string>)
  requires !(id in s.issuedIds)
  requires issued == s.issuedIds + ProofLib.Filter((set_x: string) => !(set_x in s.issuedIds), [id])
  ensures id in issued && (forall prior :: prior in s.issuedIds ==> prior in issued)
{
  ProofLib.FilterMember((set_x: string) => !(set_x in s.issuedIds), [id], id);
}

lemma NotificationTailCounts(s: Inbox)
  requires alwaysFreshNotificationIdentity(s) && |s.pending| > 0
  ensures forall queued :: queued in s.pending[1..] && queued.kind.AddNotice? ==>
    |ProofLib.Filter((other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, s.pending[1..])| == 1
{
  NotificationFreshFacts(s);
  assert s.pending == [s.pending[0]] + s.pending[1..];
  forall queued | queued in s.pending[1..] && queued.kind.AddNotice?
    ensures |ProofLib.Filter((other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, s.pending[1..])| == 1
  {
    assert queued in s.pending;
    ProofLib.FilterMember((other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, s.pending[1..], queued);
    ProofLib.FilterCons((other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, s.pending);
  }
}

lemma NotificationProjectionFresh(s: Inbox, after: Inbox)
  requires alwaysFreshNotificationIdentity(s)
  requires after.memory == s.memory && after.disk == s.disk && after.issuedIds == s.issuedIds
  requires |after.pending| == |s.pending|
  requires forall i :: 0 <= i < |s.pending| ==> after.pending[i].kind == s.pending[i].kind && after.pending[i].id == s.pending[i].id && after.pending[i].input == s.pending[i].input
  ensures alwaysFreshNotificationIdentity(after)
{
  NotificationFreshFacts(s);
  NotificationFreshFacts(after);
  forall queued | queued in after.pending
    ensures freshPendingAgainstRows(after, queued)
    ensures queued.kind.AddNotice? ==> |ProofLib.Filter((other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, after.pending)| == 1
  {
    var i :| 0 <= i < |after.pending| && after.pending[i] == queued;
    var prior := s.pending[i];
    assert prior in s.pending;
    assert freshPendingAgainstRows(s, prior);
    if queued.kind.AddNotice? {
      ProofLib.FilterLengthPointwise((other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, (other: NoticeMutation) => other.kind.AddNotice? && other.id == queued.id, s.pending, after.pending);
    }
  }
}

lemma NotificationRetainedRows(rows: seq<Notice>, groupKey: string, now: int)
  requires forall row :: row in rows ==> |ProofLib.Filter((other: Notice) => other.id == row.id, rows)| == 1
  ensures forall row :: row in retainedBeforeAdd(rows, groupKey, now) ==> row in rows && notificationVisible(row.expiry, now) && (groupKey == "" || row.groupKey != groupKey)
  ensures forall row :: row in retainedBeforeAdd(rows, groupKey, now) ==> |ProofLib.Filter((other: Notice) => other.id == row.id, retainedBeforeAdd(rows, groupKey, now))| == 1
{
  var keep := (row: Notice) => notificationVisible(row.expiry, now) && (groupKey == "" || row.groupKey != groupKey);
  var retained := retainedBeforeAdd(rows, groupKey, now);
  assert retained == ProofLib.Filter(keep, rows);
  NotificationFilterRows(rows, keep);
  forall row | row in retained ensures row in rows && keep(row) {
    ProofLib.FilterMember(keep, rows, row);
  }
}

lemma NotificationRowsDoNotShareId(rows: seq<Notice>, left: Notice, right: Notice)
  requires left in rows && right in rows && left.id == right.id
  requires |ProofLib.Filter((other: Notice) => other.id == left.id, rows)| == 1
  ensures left == right
{
  ProofLib.FilterMember((other: Notice) => other.id == left.id, rows, left);
  ProofLib.FilterMember((other: Notice) => other.id == left.id, rows, right);
}

lemma NotificationAddExcludesExpired(s: Inbox, queued: NoticeMutation, retained: seq<Notice>, added: Notice)
  requires inv(s) && queued in s.pending && queued.kind.AddNotice?
  requires retained == retainedBeforeAdd(s.memory, queued.input.groupKey, s.now)
  requires added == addedNotification(s, queued)
  ensures forall row :: row in s.memory && !notificationVisible(row.expiry, s.now) ==>
    !(exists remaining :: remaining in retained + [added] && remaining.id == row.id)
{
  NotificationRowCounts(s);
  NotificationFreshFacts(s);
  NotificationRetainedRows(s.memory, queued.input.groupKey, s.now);
  forall row | row in s.memory && !notificationVisible(row.expiry, s.now)
    ensures !(exists remaining :: remaining in retained + [added] && remaining.id == row.id)
  {
    forall remaining | remaining in retained + [added] ensures remaining.id != row.id {
      if remaining != added && remaining.id == row.id {
        assert remaining in retained;
        NotificationRowsDoNotShareId(s.memory, row, remaining);
      }
    }
  }
}

lemma NotificationAddHasOneGroup(kept: seq<Notice>, added: Notice)
  requires forall row :: row in kept ==> row.groupKey != added.groupKey
  ensures |ProofLib.Filter((row: Notice) => row.groupKey == added.groupKey, kept + [added])| == 1
{
  ProofLib.FilterNone((row: Notice) => row.groupKey == added.groupKey, kept);
  ProofLib.FilterAppend((row: Notice) => row.groupKey == added.groupKey, kept, added);
}

lemma NotificationAddPreservation(s: Inbox, queued: NoticeMutation)
  requires inv(s) && queued in s.pending && queued.kind.AddNotice?
  ensures forall row :: row in retainedBeforeAdd(s.memory, queued.input.groupKey, s.now) + [addedNotification(s, queued)] ==>
    row.id in s.issuedIds && 0 < row.sequence <= s.sequence + 1
  ensures forall row :: row in retainedBeforeAdd(s.memory, queued.input.groupKey, s.now) + [addedNotification(s, queued)] ==>
    (row.id == queued.id || (exists prior :: prior in s.memory && prior.id == row.id && prior.sequence == row.sequence))
  ensures forall row :: row in retainedBeforeAdd(s.memory, queued.input.groupKey, s.now) + [addedNotification(s, queued)] ==>
    |ProofLib.Filter((other: Notice) => other.id == row.id, retainedBeforeAdd(s.memory, queued.input.groupKey, s.now) + [addedNotification(s, queued)])| == 1
{
  NotificationRowCounts(s);
  NotificationFreshFacts(s);
  var kept := retainedBeforeAdd(s.memory, queued.input.groupKey, s.now);
  var added := addedNotification(s, queued);
  NotificationRetainedRows(s.memory, queued.input.groupKey, s.now);
  NotificationAppendFresh(kept, added);
  forall row | row in kept + [added]
    ensures row.id in s.issuedIds && 0 < row.sequence <= s.sequence + 1
    ensures row.id == queued.id || (exists prior :: prior in s.memory && prior.id == row.id && prior.sequence == row.sequence)
  {
    if row != added { assert row in kept && row in s.memory; }
  }
}

lemma NotificationRowsAfterStart(s: Inbox)
  requires inv(s) && canStartNext(s)
  ensures alwaysNoticeIdsAreUnique(startNext(s))
  ensures alwaysCoordinatesRemainValid(startNext(s))
  ensures stepAddPrunesExpiredPriorRows(s, "startNext", startNext(s))
  ensures stepGroupedAddReplacesEveryPriorGroupRow(s, "startNext", startNext(s))
  ensures stepReadMarksPreserveCoordinates(s, "startNext", startNext(s))
  ensures forall row :: row in startNext(s).memory ==> row.id in s.issuedIds
  ensures forall row :: row in startNext(s).memory ==> ((s.pending[0].kind.AddNotice? && row.id == s.pending[0].id) || (exists prior :: prior in s.memory && prior.id == row.id && prior.sequence == row.sequence))
{
  var after := startNext(s);
  var queued := s.pending[0];
  NotificationRowCounts(s);
  NotificationRowCounts(after);
  NotificationFreshFacts(s);
  assert queued in s.pending;
  if after.phase.Writing? {
    if queued.kind.AddNotice? {
      var kept := retainedBeforeAdd(s.memory, queued.input.groupKey, s.now);
      var added := addedNotification(s, queued);
      assert after.memory == kept + [added] && after.sequence == s.sequence + 1;
      NotificationAddPreservation(s, queued);
      NotificationAddExcludesExpired(s, queued, kept, added);
      if queued.input.groupKey != "" {
        NotificationRetainedRows(s.memory, queued.input.groupKey, s.now);
        NotificationAddHasOneGroup(kept, added);
        assert added in after.memory;
      }
    } else if queued.kind.RemoveNotice? {
      assert after.memory == ProofLib.Filter((row: Notice) => row.id != queued.id, s.memory);
      NotificationFilterRows(s.memory, (row: Notice) => row.id != queued.id);
      forall row | row in after.memory ensures row in s.memory {
        ProofLib.FilterMember((row: Notice) => row.id != queued.id, s.memory, row);
      }
    } else if readMark(queued) {
      NotificationMarkedRows(s.memory, queued);
    } else {
      assert after.memory == [];
    }
  } else {
    assert after.memory == s.memory;
  }
}
lemma NotificationAfterShift(s: Inbox, after: Inbox, added: bool)
  requires inv(s) && |s.pending| > 0
  requires after.pending == s.pending[1..] && after.issuedIds == s.issuedIds && after.disk == s.disk
  requires added ==> s.pending[0].kind.AddNotice?
  requires forall row :: row in after.memory ==> row.id in s.issuedIds
  requires forall row :: row in after.memory ==> ((added && row.id == s.pending[0].id) ||
    (exists prior :: prior in s.memory && prior.id == row.id))
  ensures alwaysFreshNotificationIdentity(after)
{
  NotificationFreshFacts(s);
  NotificationFreshFacts(after);
  NotificationTailCounts(s);
  if added { NotificationTailFresh(s); }
  forall queued | queued in after.pending && queued.kind.AddNotice?
    ensures freshPendingAgainstRows(after, queued)
  {
    assert queued in s.pending;
    assert freshPendingAgainstRows(s, queued);
    forall row | row in after.memory ensures row.id != queued.id {
      if row.id == queued.id {
        assert !(exists prior :: prior in s.memory && prior.id == queued.id);
        assert added && row.id == s.pending[0].id;
      }
    }
  }
}

lemma enqueueNotice_ensures(s: Inbox, id: string)
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysNoticeIdsAreUnique(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysQueueAccountsForEveryAdmission(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysActiveWriteOwnsTail(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysCoordinatesRemainValid(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysReadyMatchesDisk(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysPublishedWasAcknowledged(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysClosedTailIsDrained(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysReadFenceMatchesDurableState(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysAffectedRowsNonnegative(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> alwaysFreshNotificationIdentity(enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> stepAddPrunesExpiredPriorRows(s, "enqueueNotice", enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "enqueueNotice", enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> stepProjectionEvaluationKeepsRows(s, "enqueueNotice", enqueueNotice(s, id)))
  ensures (inv(s) ==> canEnqueueNotice(s, id) ==> stepReadMarksPreserveCoordinates(s, "enqueueNotice", enqueueNotice(s, id)))
{
  if inv(s) && canEnqueueNotice(s, id) {
    var after := enqueueNotice(s, id);
    assert |after.pending| > 0;
    NotificationFreshIssue(s, id, after.issuedIds);
    var queued := after.pending[|s.pending|];
    assert after.pending == s.pending + [queued];
    NotificationFreshAppend(s, queued, after.issuedIds);
  }
}

lemma enqueueGrouped_ensures(s: Inbox, input: NoticeInput)
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysNoticeIdsAreUnique(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysQueueAccountsForEveryAdmission(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysActiveWriteOwnsTail(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysCoordinatesRemainValid(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysReadyMatchesDisk(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysPublishedWasAcknowledged(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysClosedTailIsDrained(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysReadFenceMatchesDurableState(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysAffectedRowsNonnegative(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> alwaysFreshNotificationIdentity(enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> stepAddPrunesExpiredPriorRows(s, "enqueueGrouped", enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "enqueueGrouped", enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> stepProjectionEvaluationKeepsRows(s, "enqueueGrouped", enqueueGrouped(s, input)))
  ensures (inv(s) ==> canEnqueueGrouped(s, input) ==> stepReadMarksPreserveCoordinates(s, "enqueueGrouped", enqueueGrouped(s, input)))
{
  if inv(s) && canEnqueueGrouped(s, input) {
    var after := enqueueGrouped(s, input);
    assert |after.pending| > 0;
    NotificationFreshIssue(s, input.id, after.issuedIds);
    var queued := after.pending[|s.pending|];
    assert after.pending == s.pending + [queued];
    NotificationFreshAppend(s, queued, after.issuedIds);
  }
}

lemma ensureGroupedProjection_ensures(s: Inbox, input: NoticeInput)
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysNoticeIdsAreUnique(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysQueueAccountsForEveryAdmission(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysActiveWriteOwnsTail(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysCoordinatesRemainValid(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysReadyMatchesDisk(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysPublishedWasAcknowledged(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysClosedTailIsDrained(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysReadFenceMatchesDurableState(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysAffectedRowsNonnegative(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> alwaysFreshNotificationIdentity(ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> stepAddPrunesExpiredPriorRows(s, "ensureGroupedProjection", ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "ensureGroupedProjection", ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> stepProjectionEvaluationKeepsRows(s, "ensureGroupedProjection", ensureGroupedProjection(s, input)))
  ensures (inv(s) ==> canEnsureGroupedProjection(s, input) ==> stepReadMarksPreserveCoordinates(s, "ensureGroupedProjection", ensureGroupedProjection(s, input)))
{
  if inv(s) && canEnsureGroupedProjection(s, input) {
    var after := ensureGroupedProjection(s, input);
    assert |after.pending| > 0;
    NotificationFreshIssue(s, input.id, after.issuedIds);
    var queued := after.pending[|s.pending|];
    assert after.pending == s.pending + [queued];
    NotificationFreshAppend(s, queued, after.issuedIds);
  }
}

lemma remove_ensures(s: Inbox, id: string)
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysNoticeIdsAreUnique(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysQueueAccountsForEveryAdmission(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysActiveWriteOwnsTail(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysCoordinatesRemainValid(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysReadyMatchesDisk(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysPublishedWasAcknowledged(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysClosedTailIsDrained(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysReadFenceMatchesDurableState(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysAffectedRowsNonnegative(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> alwaysFreshNotificationIdentity(remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> stepAddPrunesExpiredPriorRows(s, "remove", remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "remove", remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> stepProjectionEvaluationKeepsRows(s, "remove", remove(s, id)))
  ensures (inv(s) ==> canRemove(s, id) ==> stepReadMarksPreserveCoordinates(s, "remove", remove(s, id)))
{
  if inv(s) && canRemove(s, id) {
    var after := remove(s, id);
    assert |after.pending| > 0;
    var queued := after.pending[|s.pending|];
    assert after.pending == s.pending + [queued];
    NotificationFreshAppend(s, queued, after.issuedIds);
  }
}

lemma markRead_ensures(s: Inbox, id: string)
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysNoticeIdsAreUnique(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysQueueAccountsForEveryAdmission(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysActiveWriteOwnsTail(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysCoordinatesRemainValid(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysReadyMatchesDisk(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysPublishedWasAcknowledged(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysClosedTailIsDrained(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysReadFenceMatchesDurableState(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysAffectedRowsNonnegative(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> alwaysFreshNotificationIdentity(markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> stepAddPrunesExpiredPriorRows(s, "markRead", markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "markRead", markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> stepProjectionEvaluationKeepsRows(s, "markRead", markRead(s, id)))
  ensures (inv(s) ==> canMarkRead(s, id) ==> stepReadMarksPreserveCoordinates(s, "markRead", markRead(s, id)))
{
  if inv(s) && canMarkRead(s, id) {
    var after := markRead(s, id);
    assert |after.pending| > 0;
    var queued := after.pending[|s.pending|];
    assert after.pending == s.pending + [queued];
    NotificationFreshAppend(s, queued, after.issuedIds);
  }
}

lemma markGroupRead_ensures(s: Inbox, groupKey: string)
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysNoticeIdsAreUnique(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysQueueAccountsForEveryAdmission(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysActiveWriteOwnsTail(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysCoordinatesRemainValid(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysReadyMatchesDisk(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysPublishedWasAcknowledged(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysClosedTailIsDrained(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysReadFenceMatchesDurableState(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysAffectedRowsNonnegative(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> alwaysFreshNotificationIdentity(markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> stepAddPrunesExpiredPriorRows(s, "markGroupRead", markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "markGroupRead", markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> stepProjectionEvaluationKeepsRows(s, "markGroupRead", markGroupRead(s, groupKey)))
  ensures (inv(s) ==> canMarkGroupRead(s, groupKey) ==> stepReadMarksPreserveCoordinates(s, "markGroupRead", markGroupRead(s, groupKey)))
{
  if inv(s) && canMarkGroupRead(s, groupKey) {
    var after := markGroupRead(s, groupKey);
    assert |after.pending| > 0;
    var queued := after.pending[|s.pending|];
    assert after.pending == s.pending + [queued];
    NotificationFreshAppend(s, queued, after.issuedIds);
  }
}

lemma markAllRead_ensures(s: Inbox)
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysNoticeIdsAreUnique(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysQueueAccountsForEveryAdmission(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysActiveWriteOwnsTail(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysCoordinatesRemainValid(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysReadyMatchesDisk(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysPublishedWasAcknowledged(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysClosedTailIsDrained(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysReadFenceMatchesDurableState(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysAffectedRowsNonnegative(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> alwaysFreshNotificationIdentity(markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> stepAddPrunesExpiredPriorRows(s, "markAllRead", markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "markAllRead", markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> stepProjectionEvaluationKeepsRows(s, "markAllRead", markAllRead(s)))
  ensures (inv(s) ==> canMarkAllRead(s) ==> stepReadMarksPreserveCoordinates(s, "markAllRead", markAllRead(s)))
{
  if inv(s) && canMarkAllRead(s) {
    var after := markAllRead(s);
    assert |after.pending| > 0;
    var queued := after.pending[|s.pending|];
    assert after.pending == s.pending + [queued];
    NotificationFreshAppend(s, queued, after.issuedIds);
  }
}

lemma clear_ensures(s: Inbox)
  ensures (inv(s) ==> canClear(s) ==> alwaysNoticeIdsAreUnique(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysQueueAccountsForEveryAdmission(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysActiveWriteOwnsTail(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysCoordinatesRemainValid(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysReadyMatchesDisk(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysPublishedWasAcknowledged(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysClosedTailIsDrained(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysReadFenceMatchesDurableState(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysAffectedRowsNonnegative(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> alwaysFreshNotificationIdentity(clear(s)))
  ensures (inv(s) ==> canClear(s) ==> stepAddPrunesExpiredPriorRows(s, "clear", clear(s)))
  ensures (inv(s) ==> canClear(s) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "clear", clear(s)))
  ensures (inv(s) ==> canClear(s) ==> stepProjectionEvaluationKeepsRows(s, "clear", clear(s)))
  ensures (inv(s) ==> canClear(s) ==> stepReadMarksPreserveCoordinates(s, "clear", clear(s)))
{
  if inv(s) && canClear(s) {
    var after := clear(s);
    assert |after.pending| > 0;
    var queued := after.pending[|s.pending|];
    assert after.pending == s.pending + [queued];
    NotificationFreshAppend(s, queued, after.issuedIds);
  }
}

lemma startNext_ensures(s: Inbox)
  ensures (inv(s) ==> canStartNext(s) ==> alwaysNoticeIdsAreUnique(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysQueueAccountsForEveryAdmission(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysActiveWriteOwnsTail(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysCoordinatesRemainValid(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysReadyMatchesDisk(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysPublishedWasAcknowledged(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysClosedTailIsDrained(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysReadFenceMatchesDurableState(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysAffectedRowsNonnegative(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> alwaysFreshNotificationIdentity(startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> stepAddPrunesExpiredPriorRows(s, "startNext", startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "startNext", startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> stepProjectionEvaluationKeepsRows(s, "startNext", startNext(s)))
  ensures (inv(s) ==> canStartNext(s) ==> stepReadMarksPreserveCoordinates(s, "startNext", startNext(s)))
{
  if inv(s) && canStartNext(s) {
    NotificationRowsAfterStart(s);
    var after := startNext(s);
    NotificationAfterShift(s, after, s.pending[0].kind.AddNotice?);
  }
}

lemma checkGroupedProjection_ensures(s: Inbox, decision: ProjectionDecision)
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysNoticeIdsAreUnique(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysQueueAccountsForEveryAdmission(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysActiveWriteOwnsTail(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysCoordinatesRemainValid(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysReadyMatchesDisk(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysPublishedWasAcknowledged(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysClosedTailIsDrained(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysReadFenceMatchesDurableState(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysAffectedRowsNonnegative(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> alwaysFreshNotificationIdentity(checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> stepAddPrunesExpiredPriorRows(s, "checkGroupedProjection", checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "checkGroupedProjection", checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> stepProjectionEvaluationKeepsRows(s, "checkGroupedProjection", checkGroupedProjection(s, decision)))
  ensures (inv(s) ==> canCheckGroupedProjection(s, decision) ==> stepReadMarksPreserveCoordinates(s, "checkGroupedProjection", checkGroupedProjection(s, decision)))
{
  if inv(s) && canCheckGroupedProjection(s, decision) {
    var after := checkGroupedProjection(s, decision);
    if decision.ProjectionDiffers? {
      NotificationProjectionFresh(s, after);
    } else {
      NotificationAfterShift(s, after, false);
    }
  }
}

lemma rejectQueuedUnreadable_ensures(s: Inbox)
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysNoticeIdsAreUnique(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysQueueAccountsForEveryAdmission(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysActiveWriteOwnsTail(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysCoordinatesRemainValid(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysReadyMatchesDisk(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysPublishedWasAcknowledged(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysClosedTailIsDrained(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysReadFenceMatchesDurableState(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysAffectedRowsNonnegative(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> alwaysFreshNotificationIdentity(rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> stepAddPrunesExpiredPriorRows(s, "rejectQueuedUnreadable", rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> stepGroupedAddReplacesEveryPriorGroupRow(s, "rejectQueuedUnreadable", rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> stepProjectionEvaluationKeepsRows(s, "rejectQueuedUnreadable", rejectQueuedUnreadable(s)))
  ensures (inv(s) ==> canRejectQueuedUnreadable(s) ==> stepReadMarksPreserveCoordinates(s, "rejectQueuedUnreadable", rejectQueuedUnreadable(s)))
{
  if inv(s) && canRejectQueuedUnreadable(s) {
    NotificationFreshFacts(s);
    NotificationAfterShift(s, rejectQueuedUnreadable(s), false);
  }
}
