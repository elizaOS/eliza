lemma registerWriter_ensures(a: AtomicWriters, id: string, body: string, processKey: string)
  ensures (inv(a) ==> canRegisterWriter(a, id) ==> alwaysWriterReceipt(registerWriter(a, id, body, processKey)))
  ensures (inv(a) ==> canRegisterWriter(a, id) ==> alwaysEveryWriterPreRenameIsUnpublished(registerWriter(a, id, body, processKey)))
  ensures (inv(a) ==> canRegisterWriter(a, id) ==> alwaysWriterOrdinalAllocated(registerWriter(a, id, body, processKey)))
  ensures (inv(a) ==> canRegisterWriter(a, id) ==> alwaysWinnerPublishedWholeBody(registerWriter(a, id, body, processKey)))
  ensures (inv(a) ==> canRegisterWriter(a, id) ==> alwaysOrderedWritersOwnEarlierSettlements(registerWriter(a, id, body, processKey)))
  ensures (inv(a) ==> canRegisterWriter(a, id) ==> stepOtherWritersStayUnchanged(a, registerWriter(a, id, body, processKey)))
  ensures (inv(a) ==> canRegisterWriter(a, id) ==> stepSnapshotOnlyChangesByRename(a, registerWriter(a, id, body, processKey)))
{
  if inv(a) && canRegisterWriter(a, id) {
    var after := registerWriter(a, id, body, processKey);
    var added := Writer(core__atomicPublication_initial, body, processKey, |a.orderedIds|);
    AtomicWriterUpdate(a, after, id, added, true);
    AtomicWriterFrame(a, after, id);
    assert !settledWriter(added) && added.publication.phase.Queued?;
    forall own | own in a.ids && !writerAt(a, own).publication.phase.Queued? && writerAt(a, own).processKey != "" ensures earlierWritersSettled(after, own) {
      forall prior | prior in after.ids && writerAt(after, prior).processKey == writerAt(after, own).processKey && writerAt(after, prior).ordinal < writerAt(after, own).ordinal ensures settledWriter(writerAt(after, prior)) {
        if prior == id { assert writerAt(a, own).ordinal < added.ordinal; }
        else { assert prior in a.ids; }
      }
    }
  }
}

lemma createWriter_ensures(a: AtomicWriters, id: string, ok: bool)
  ensures (inv(a) ==> canCreateWriter(a, id) ==> alwaysWriterReceipt(createWriter(a, id, ok)))
  ensures (inv(a) ==> canCreateWriter(a, id) ==> alwaysEveryWriterPreRenameIsUnpublished(createWriter(a, id, ok)))
  ensures (inv(a) ==> canCreateWriter(a, id) ==> alwaysWriterOrdinalAllocated(createWriter(a, id, ok)))
  ensures (inv(a) ==> canCreateWriter(a, id) ==> alwaysWinnerPublishedWholeBody(createWriter(a, id, ok)))
  ensures (inv(a) ==> canCreateWriter(a, id) ==> alwaysOrderedWritersOwnEarlierSettlements(createWriter(a, id, ok)))
  ensures (inv(a) ==> canCreateWriter(a, id) ==> stepOtherWritersStayUnchanged(a, createWriter(a, id, ok)))
  ensures (inv(a) ==> canCreateWriter(a, id) ==> stepSnapshotOnlyChangesByRename(a, createWriter(a, id, ok)))
{
  if inv(a) && canCreateWriter(a, id) {
    var prior := writerAt(a, id);
    var next := prior.(publication := core__atomicPublication_create(prior.publication, ok));
    var after := createWriter(a, id, ok);
    AtomicWriterUpdate(a, after, id, next, false);
    AtomicWriterFrame(a, after, id);
    AtomicWriterKeepsOrder(a, after, id);
  }
}

lemma writeWriter_ensures(a: AtomicWriters, id: string, ok: bool)
  ensures (inv(a) ==> canWriteWriter(a, id) ==> alwaysWriterReceipt(writeWriter(a, id, ok)))
  ensures (inv(a) ==> canWriteWriter(a, id) ==> alwaysEveryWriterPreRenameIsUnpublished(writeWriter(a, id, ok)))
  ensures (inv(a) ==> canWriteWriter(a, id) ==> alwaysWriterOrdinalAllocated(writeWriter(a, id, ok)))
  ensures (inv(a) ==> canWriteWriter(a, id) ==> alwaysWinnerPublishedWholeBody(writeWriter(a, id, ok)))
  ensures (inv(a) ==> canWriteWriter(a, id) ==> alwaysOrderedWritersOwnEarlierSettlements(writeWriter(a, id, ok)))
  ensures (inv(a) ==> canWriteWriter(a, id) ==> stepOtherWritersStayUnchanged(a, writeWriter(a, id, ok)))
  ensures (inv(a) ==> canWriteWriter(a, id) ==> stepSnapshotOnlyChangesByRename(a, writeWriter(a, id, ok)))
{
  if inv(a) && canWriteWriter(a, id) {
    var prior := writerAt(a, id);
    var next := prior.(publication := core__atomicPublication_write(prior.publication, ok));
    var after := writeWriter(a, id, ok);
    AtomicWriterUpdate(a, after, id, next, false);
    AtomicWriterFrame(a, after, id);
    AtomicWriterKeepsOrder(a, after, id);
  }
}

lemma renameWriter_ensures(a: AtomicWriters, id: string, ok: bool)
  ensures (inv(a) ==> canRenameWriter(a, id) ==> alwaysWriterReceipt(renameWriter(a, id, ok)))
  ensures (inv(a) ==> canRenameWriter(a, id) ==> alwaysEveryWriterPreRenameIsUnpublished(renameWriter(a, id, ok)))
  ensures (inv(a) ==> canRenameWriter(a, id) ==> alwaysWriterOrdinalAllocated(renameWriter(a, id, ok)))
  ensures (inv(a) ==> canRenameWriter(a, id) ==> alwaysWinnerPublishedWholeBody(renameWriter(a, id, ok)))
  ensures (inv(a) ==> canRenameWriter(a, id) ==> alwaysOrderedWritersOwnEarlierSettlements(renameWriter(a, id, ok)))
  ensures (inv(a) ==> canRenameWriter(a, id) ==> stepOtherWritersStayUnchanged(a, renameWriter(a, id, ok)))
  ensures (inv(a) ==> canRenameWriter(a, id) ==> stepSnapshotOnlyChangesByRename(a, renameWriter(a, id, ok)))
{
  if inv(a) && canRenameWriter(a, id) {
    var prior := writerAt(a, id);
    var next := prior.(publication := core__atomicPublication_rename(prior.publication, ok));
    var after := renameWriter(a, id, ok);
    AtomicWriterUpdate(a, after, id, next, false);
    AtomicWriterFrame(a, after, id);
    AtomicWriterKeepsOrder(a, after, id);
  }
}

lemma cleanupWriter_ensures(a: AtomicWriters, id: string, removed: bool)
  ensures (inv(a) ==> canCleanupWriter(a, id) ==> alwaysWriterReceipt(cleanupWriter(a, id, removed)))
  ensures (inv(a) ==> canCleanupWriter(a, id) ==> alwaysEveryWriterPreRenameIsUnpublished(cleanupWriter(a, id, removed)))
  ensures (inv(a) ==> canCleanupWriter(a, id) ==> alwaysWriterOrdinalAllocated(cleanupWriter(a, id, removed)))
  ensures (inv(a) ==> canCleanupWriter(a, id) ==> alwaysWinnerPublishedWholeBody(cleanupWriter(a, id, removed)))
  ensures (inv(a) ==> canCleanupWriter(a, id) ==> alwaysOrderedWritersOwnEarlierSettlements(cleanupWriter(a, id, removed)))
  ensures (inv(a) ==> canCleanupWriter(a, id) ==> stepOtherWritersStayUnchanged(a, cleanupWriter(a, id, removed)))
  ensures (inv(a) ==> canCleanupWriter(a, id) ==> stepSnapshotOnlyChangesByRename(a, cleanupWriter(a, id, removed)))
{
  if inv(a) && canCleanupWriter(a, id) {
    var prior := writerAt(a, id);
    var next := prior.(publication := core__atomicPublication_cleanup(prior.publication, removed));
    var after := cleanupWriter(a, id, removed);
    AtomicWriterUpdate(a, after, id, next, false);
    AtomicWriterFrame(a, after, id);
    AtomicWriterKeepsOrder(a, after, id);
  }
}

lemma crashWriter_ensures(a: AtomicWriters, id: string)
  ensures (inv(a) ==> canCrashWriter(a, id) ==> alwaysWriterReceipt(crashWriter(a, id)))
  ensures (inv(a) ==> canCrashWriter(a, id) ==> alwaysEveryWriterPreRenameIsUnpublished(crashWriter(a, id)))
  ensures (inv(a) ==> canCrashWriter(a, id) ==> alwaysWriterOrdinalAllocated(crashWriter(a, id)))
  ensures (inv(a) ==> canCrashWriter(a, id) ==> alwaysWinnerPublishedWholeBody(crashWriter(a, id)))
  ensures (inv(a) ==> canCrashWriter(a, id) ==> alwaysOrderedWritersOwnEarlierSettlements(crashWriter(a, id)))
  ensures (inv(a) ==> canCrashWriter(a, id) ==> stepOtherWritersStayUnchanged(a, crashWriter(a, id)))
  ensures (inv(a) ==> canCrashWriter(a, id) ==> stepSnapshotOnlyChangesByRename(a, crashWriter(a, id)))
{
  if inv(a) && canCrashWriter(a, id) {
    var prior := writerAt(a, id);
    var next := prior.(publication := core__atomicPublication_crash(prior.publication));
    var after := crashWriter(a, id);
    AtomicWriterUpdate(a, after, id, next, false);
    AtomicWriterFrame(a, after, id);
    AtomicWriterKeepsOrder(a, after, id);
  }
}

lemma advanceWriter_ensures(a: AtomicWriters, ok: bool)
  ensures (inv(a) ==> canAdvanceWriter(a) ==> alwaysWriterReceipt(advanceWriter(a, ok)))
  ensures (inv(a) ==> canAdvanceWriter(a) ==> alwaysEveryWriterPreRenameIsUnpublished(advanceWriter(a, ok)))
  ensures (inv(a) ==> canAdvanceWriter(a) ==> alwaysWriterOrdinalAllocated(advanceWriter(a, ok)))
  ensures (inv(a) ==> canAdvanceWriter(a) ==> alwaysWinnerPublishedWholeBody(advanceWriter(a, ok)))
  ensures (inv(a) ==> canAdvanceWriter(a) ==> alwaysOrderedWritersOwnEarlierSettlements(advanceWriter(a, ok)))
  ensures (inv(a) ==> canAdvanceWriter(a) ==> stepOtherWritersStayUnchanged(a, advanceWriter(a, ok)))
  ensures (inv(a) ==> canAdvanceWriter(a) ==> stepSnapshotOnlyChangesByRename(a, advanceWriter(a, ok)))
{
  if inv(a) && canAdvanceWriter(a) {
    var id := nextWriterId(a);
    if canCreateWriter(a, id) { createWriter_ensures(a, id, ok); }
    else if canWriteWriter(a, id) { writeWriter_ensures(a, id, ok); }
    else if canRenameWriter(a, id) { renameWriter_ensures(a, id, ok); }
    else { cleanupWriter_ensures(a, id, ok); }
  }
}

lemma AtomicWriterUpdate(before: AtomicWriters, after: AtomicWriters, id: string, value: Writer, adding: bool)
  requires after.writers == before.writers[("$" + id) := value]
  requires adding ==> id !in before.ids
  requires !adding ==> id in before.ids
  requires after.ids == (if adding then before.ids + ProofLib.Filter((member: string) => !(member in before.ids), [id]) else before.ids)
  ensures id in after.ids && writerAt(after, id) == value
  ensures forall prior :: prior != id ==> (prior in after.ids <==> prior in before.ids)
  ensures forall prior :: prior != id ==> writerAt(after, prior) == writerAt(before, prior)
{
  if adding {
    ProofLib.FilterOne((member: string) => !(member in before.ids), [id], 0);
    ProofLib.FilterMember((member: string) => !(member in before.ids), [id], id);
    forall prior | prior in after.ids && prior != id ensures prior in before.ids {
      if prior !in before.ids {
        ProofLib.FilterMember((member: string) => !(member in before.ids), [id], prior);
      }
    }
  }
  assert "$" + id in after.writers;
  forall prior | prior != id ensures writerAt(after, prior) == writerAt(before, prior) {
    assert "$" + prior != "$" + id by {
      if "$" + prior == "$" + id {
        assert ("$" + prior)[1..] == prior;
        assert ("$" + id)[1..] == id;
      }
    }
  }
}

lemma AtomicWriterFrame(before: AtomicWriters, after: AtomicWriters, id: string)
  requires inv(before) && after.addressed == id
  requires forall prior :: prior != id ==> (prior in after.ids <==> prior in before.ids)
  requires forall prior :: prior != id ==> writerAt(after, prior) == writerAt(before, prior)
  requires id in after.ids
  requires core__atomicPublication_alwaysSuccessMeansPublished(writerAt(after, id).publication)
  requires core__atomicPublication_alwaysUnknownMeansCrashed(writerAt(after, id).publication)
  requires core__atomicPublication_alwaysPublicationMatchesWrite(writerAt(after, id).publication)
  requires core__atomicPublication_alwaysPreRenameOwnsPendingPublication(writerAt(after, id).publication)
  requires core__atomicPublication_alwaysRenameHasCompleteTemporary(writerAt(after, id).publication)
  requires id != "" && 0 <= writerAt(after, id).ordinal < |after.orderedIds|
  requires |after.orderedIds| >= |before.orderedIds|
  ensures alwaysWriterReceipt(after)
  ensures alwaysEveryWriterPreRenameIsUnpublished(after)
  ensures alwaysWriterOrdinalAllocated(after)
  ensures stepOtherWritersStayUnchanged(before, after)
{
  forall prior | prior in after.ids && prior != id ensures
    prior in before.ids && writerAt(after, prior) == writerAt(before, prior) {}
}

lemma AtomicWriterKeepsOrder(before: AtomicWriters, after: AtomicWriters, id: string)
  requires inv(before) && before.ids == after.ids
  requires forall prior :: prior != id ==> writerAt(after, prior) == writerAt(before, prior)
  requires writerAt(after, id).processKey == writerAt(before, id).processKey && writerAt(after, id).ordinal == writerAt(before, id).ordinal
  requires settledWriter(writerAt(before, id)) ==> settledWriter(writerAt(after, id))
  requires !writerAt(after, id).publication.phase.Queued? ==> earlierWritersSettled(before, id)
  ensures alwaysOrderedWritersOwnEarlierSettlements(after)
{
  forall own | own in after.ids && !writerAt(after, own).publication.phase.Queued? && writerAt(after, own).processKey != "" ensures earlierWritersSettled(after, own) {
    assert earlierWritersSettled(before, own);
    forall prior | prior in after.ids && writerAt(after, prior).processKey == writerAt(after, own).processKey && writerAt(after, prior).ordinal < writerAt(after, own).ordinal ensures settledWriter(writerAt(after, prior)) {
      assert settledWriter(writerAt(before, prior));
    }
  }
}
