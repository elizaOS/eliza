lemma scan_ensures(s: TaskStore, taskId: string, decodes: bool)
  ensures (inv(s) ==> canScan(s, taskId) ==> alwaysOpenedStoreBelongsToAnAccount(scan(s, taskId, decodes)))
  ensures (inv(s) ==> canScan(s, taskId) ==> alwaysRecordsNameAnAccount(scan(s, taskId, decodes)))
  ensures (inv(s) ==> canScan(s, taskId) ==> alwaysOnlyAuthenticRecordsAreHeld(scan(s, taskId, decodes)))
  ensures (inv(s) ==> canScan(s, taskId) ==> alwaysReleasedRecordIsFinished(scan(s, taskId, decodes)))
  ensures (inv(s) ==> canScan(s, taskId) ==> stepAccountIsFixed(s, scan(s, taskId, decodes)))
  ensures (inv(s) ==> canScan(s, taskId) ==> stepFencedWriterWritesNothing(s, "scan", scan(s, taskId, decodes)))
  ensures (inv(s) ==> canScan(s, taskId) ==> stepReturnedOnlyUnderOwnership(s, "scan", scan(s, taskId, decodes), []))
  ensures (inv(s) ==> canScan(s, taskId) ==> stepRecordsAreNeverDropped(s, scan(s, taskId, decodes)))
  ensures (inv(s) ==> canScan(s, taskId) ==> stepReleasedStaysAside(s, scan(s, taskId, decodes)))
  ensures (inv(s) ==> canScan(s, taskId) ==> stepOnlyTheOwnerFinishesAHeldRecord(s, "scan", scan(s, taskId, decodes)))
{
  if inv(s) && canScan(s, taskId) {
    var after := scan(s, taskId, decodes);
    forall r | r in s.records
      ensures exists q :: q in after.records && q.taskId == r.taskId && (r.hold.Released? ==> q.hold.Released?) && (r.unfinished ==> q.unfinished)
    {
      var i :| 0 <= i < |s.records| && s.records[i] == r;
      var q := after.records[i];
      assert q in after.records;
      assert q.taskId == r.taskId;
      assert q.unfinished == r.unfinished;
      if r.hold.Released? {
        assert q.hold.Released?;
      }
    }
  }
}

lemma endRecord_ensures(s: TaskStore, taskId: string)
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> alwaysOpenedStoreBelongsToAnAccount(endRecord(s, taskId)))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> alwaysRecordsNameAnAccount(endRecord(s, taskId)))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> alwaysOnlyAuthenticRecordsAreHeld(endRecord(s, taskId)))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> alwaysReleasedRecordIsFinished(endRecord(s, taskId)))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> stepAccountIsFixed(s, endRecord(s, taskId)))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> stepFencedWriterWritesNothing(s, "endRecord", endRecord(s, taskId)))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> stepReturnedOnlyUnderOwnership(s, "endRecord", endRecord(s, taskId), []))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> stepRecordsAreNeverDropped(s, endRecord(s, taskId)))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> stepReleasedStaysAside(s, endRecord(s, taskId)))
  ensures (inv(s) ==> canEndRecord(s, taskId) ==> stepOnlyTheOwnerFinishesAHeldRecord(s, "endRecord", endRecord(s, taskId)))
{
  if inv(s) && canEndRecord(s, taskId) {
    var after := endRecord(s, taskId);
    forall r | r in s.records
      ensures exists q :: q in after.records && q.taskId == r.taskId && (r.hold.Released? ==> q.hold.Released?) && ((r.hold.Held? && r.unfinished) ==> q.unfinished)
    {
      var i :| 0 <= i < |s.records| && s.records[i] == r;
      var q := after.records[i];
      assert q in after.records;
      assert q.taskId == r.taskId;
      assert q.hold == r.hold;
      if r.hold.Held? && r.unfinished {
        assert q.unfinished;
      }
    }
  }
}

lemma acknowledgeUnreadable_ensures(s: TaskStore, by_: string, taskId: string)
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> alwaysOpenedStoreBelongsToAnAccount(acknowledgeUnreadable(s, by_, taskId)))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> alwaysRecordsNameAnAccount(acknowledgeUnreadable(s, by_, taskId)))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> alwaysOnlyAuthenticRecordsAreHeld(acknowledgeUnreadable(s, by_, taskId)))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> alwaysReleasedRecordIsFinished(acknowledgeUnreadable(s, by_, taskId)))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> stepAccountIsFixed(s, acknowledgeUnreadable(s, by_, taskId)))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> stepFencedWriterWritesNothing(s, "acknowledgeUnreadable", acknowledgeUnreadable(s, by_, taskId)))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> stepReturnedOnlyUnderOwnership(s, "acknowledgeUnreadable", acknowledgeUnreadable(s, by_, taskId), []))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> stepRecordsAreNeverDropped(s, acknowledgeUnreadable(s, by_, taskId)))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> stepReleasedStaysAside(s, acknowledgeUnreadable(s, by_, taskId)))
  ensures (inv(s) ==> canAcknowledgeUnreadable(s, by_, taskId) ==> stepOnlyTheOwnerFinishesAHeldRecord(s, "acknowledgeUnreadable", acknowledgeUnreadable(s, by_, taskId)))
{
  if inv(s) && canAcknowledgeUnreadable(s, by_, taskId) {
    var after := acknowledgeUnreadable(s, by_, taskId);
    forall r | r in s.records
      ensures exists q :: q in after.records && q.taskId == r.taskId && (r.hold.Released? ==> q.hold.Released?)
    {
      var i :| 0 <= i < |s.records| && s.records[i] == r;
      var q := after.records[i];
      assert q in after.records;
      assert q.taskId == r.taskId;
      if r.hold.Released? {
        assert q.hold.Released?;
      }
    }
  }
}
