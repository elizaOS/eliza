lemma ImportedMemoLookup(m: core__memo_Memo, key: string)
  ensures core__memo_entryAt(m, key) == (if |ProofLib.Filter((entry: core__memo_MemoEntry) => (entry.key == key), m.entries)| > 0 then ProofLib.Filter((entry: core__memo_MemoEntry) => (entry.key == key), m.entries)[0] else core__memo_absentEntry)
{}

lemma ImportedMemoKnownEntry(m: core__memo_Memo, candidate: core__memo_MemoEntry)
  requires core__memo_alwaysUniqueEntryKeys(m)
  requires candidate in m.entries
  ensures core__memo_entryAt(m, candidate.key) == candidate
{
  ImportedMemoUniqueKeys(m);
  assert |ProofLib.Filter((other: core__memo_MemoEntry) => (other.key == candidate.key), m.entries)| == 1;
  ImportedMemoLookup(m, candidate.key);
  ProofLib.FilterMember((entry: core__memo_MemoEntry) => (entry.key == candidate.key), m.entries, candidate);
}

lemma ImportedMemoUniqueKeys(m: core__memo_Memo)
  ensures core__memo_alwaysUniqueEntryKeys(m) == (forall entry :: entry in m.entries ==> |ProofLib.Filter((other: core__memo_MemoEntry) => (other.key == entry.key), m.entries)| == 1)
{}

lemma ImportedMemoInvalidated(m: core__memo_Memo, key: string)
  ensures core__memo_invalidateKey(m, key).entries == ProofLib.Filter((entry: core__memo_MemoEntry) => (entry.key != key), m.entries)
{}

lemma ImportedMemoInvalidationClears(m: core__memo_Memo, key: string)
  ensures core__memo_entryAt(core__memo_invalidateKey(m, key), key) == core__memo_absentEntry
{
  var after := core__memo_invalidateKey(m, key);
  ImportedMemoInvalidated(m, key);
  ImportedMemoLookup(after, key);
  forall entry | entry in after.entries ensures entry.key != key {
    ProofLib.FilterMember((entry: core__memo_MemoEntry) => (entry.key != key), m.entries, entry);
  }
  ProofLib.FilterNone((entry: core__memo_MemoEntry) => (entry.key == key), after.entries);
}

lemma ImportedMemoRejectionSubset(m: core__memo_Memo, observerId: int)
  ensures core__memo_observeRejection(m, observerId).entries == ProofLib.Filter((entry: core__memo_MemoEntry) => ((entry.key != core__memo_observerAt(m, observerId).key) || (entry.promiseId != core__memo_observerAt(m, observerId).promiseId)), m.entries)
{}

lemma ImportedMemoSubsetLookup(before: core__memo_Memo, after: core__memo_Memo, key: string)
  requires core__memo_inv(before) && core__memo_inv(after)
  requires forall entry :: entry in after.entries ==> entry in before.entries
  ensures core__memo_entryAt(after, key) == core__memo_absentEntry || core__memo_entryAt(after, key) == core__memo_entryAt(before, key)
{
  ImportedMemoUniqueKeys(before); ImportedMemoUniqueKeys(after);
  if core__memo_hasEntry(after, key) {
    var candidate :| candidate in after.entries && candidate.key == key;
    ImportedMemoKnownEntry(after, candidate);
    ImportedMemoKnownEntry(before, candidate);
  } else {
    ImportedMemoLookup(after, key);
    ProofLib.FilterNone((entry: core__memo_MemoEntry) => (entry.key == key), after.entries);
  }
}

lemma MemoStringKeyInjective(left: string, right: string)
  ensures ("$" + left == "$" + right) == (left == right)
{
  assert ("$" + left)[1..] == left;
  assert ("$" + right)[1..] == right;
}

lemma FreshReadShape(m: MemoReads, readerId: string)
  ensures readFresh(m, readerId).fetchIds == m.fetchIds + [m.serial + 1]
  ensures readFresh(m, readerId).readerIds == m.readerIds + [readerId]
{}

lemma FreshReadPreservesRows(m: MemoReads, readerId: string)
  requires inv(m) && canReadFresh(m, readerId)
  ensures forall id :: id in m.fetchIds ==> fetchAt(readFresh(m, readerId), id) == fetchAt(m, id)
  ensures forall id :: id in m.readerIds ==> readerAt(readFresh(m, readerId), id) == readerAt(m, id)
{
  FreshReadShape(m, readerId);
  forall id | id in m.fetchIds ensures fetchAt(readFresh(m, readerId), id) == fetchAt(m, id) {
    assert id <= m.serial;
    assert id != m.serial + 1;
  }
  forall id | id in m.readerIds ensures readerAt(readFresh(m, readerId), id) == readerAt(m, id) {
    assert id != readerId;
    MemoStringKeyInjective(id, readerId);
  }
}

lemma readFresh_ensures(m: MemoReads, readerId: string)
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysMemoOwnsCache(readFresh(m, readerId)))
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysVersionOrder(readFresh(m, readerId)))
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysMemoPolicy(readFresh(m, readerId)))
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysFetchCaptureAfterFloor(readFresh(m, readerId)))
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysResidentUsesCurrentFloor(readFresh(m, readerId)))
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysReaderBoundToItsFetch(readFresh(m, readerId)))
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysServedReadMeetsFloor(readFresh(m, readerId)))
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysFailedReadHasRejectedFetch(readFresh(m, readerId)))
  ensures (inv(m) ==> canReadFresh(m, readerId) ==> alwaysWriterVersion(readFresh(m, readerId)))
{
  if inv(m) && canReadFresh(m, readerId) {
    core__memo_storeEntry_ensures(m.memo, "query", m.serial + 1, "query-shape");
    core__memo_lawPutRetainsExactPromiseAndMetadata_ensures(m.memo, "query", m.serial + 1, "query-shape");
    FreshReadPreservesRows(m, readerId);
    FreshReadShape(m, readerId);
    var after := readFresh(m, readerId);
    forall id | id in after.fetchIds
      ensures id > 0 && id <= after.serial && fetchAt(after, id).phase != fetchAbsentValue
      ensures 0 <= fetchAt(after, id).floor <= after.completed
      ensures fetchAt(after, id).captured ==> fetchAt(after, id).floor <= fetchAt(after, id).version <= after.durable
      ensures fetchAt(after, id).phase == fetchResolvedValue ==> fetchAt(after, id).captured
    {
      if id != m.serial + 1 { assert id in m.fetchIds; }
    }
    forall id | id in m.readerIds
      ensures fetchAt(after, readerAt(after, id).fetchId) == fetchAt(m, readerAt(m, id).fetchId)
    {
      assert readerAt(m, id).fetchId in m.fetchIds;
    }
  }
}

lemma readShared_ensures(m: MemoReads, readerId: string)
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysMemoOwnsCache(readShared(m, readerId)))
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysVersionOrder(readShared(m, readerId)))
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysMemoPolicy(readShared(m, readerId)))
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysFetchCaptureAfterFloor(readShared(m, readerId)))
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysResidentUsesCurrentFloor(readShared(m, readerId)))
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysReaderBoundToItsFetch(readShared(m, readerId)))
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysServedReadMeetsFloor(readShared(m, readerId)))
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysFailedReadHasRejectedFetch(readShared(m, readerId)))
  ensures (inv(m) ==> canReadShared(m, readerId) ==> alwaysWriterVersion(readShared(m, readerId)))
{
  if inv(m) && canReadShared(m, readerId) {
    assert readShared(m, readerId).readerIds == m.readerIds + [readerId];
    forall id | id in m.readerIds ensures readerAt(readShared(m, readerId), id) == readerAt(m, id) {
      assert id != readerId;
      MemoStringKeyInjective(id, readerId);
    }
  }
}

lemma commitWrite_ensures(m: MemoReads, writerId: string)
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysMemoOwnsCache(commitWrite(m, writerId)))
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysVersionOrder(commitWrite(m, writerId)))
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysMemoPolicy(commitWrite(m, writerId)))
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysFetchCaptureAfterFloor(commitWrite(m, writerId)))
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysResidentUsesCurrentFloor(commitWrite(m, writerId)))
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysReaderBoundToItsFetch(commitWrite(m, writerId)))
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysServedReadMeetsFloor(commitWrite(m, writerId)))
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysFailedReadHasRejectedFetch(commitWrite(m, writerId)))
  ensures (inv(m) ==> canCommitWrite(m, writerId) ==> alwaysWriterVersion(commitWrite(m, writerId)))
{
  if inv(m) && canCommitWrite(m, writerId) {
    assert commitWrite(m, writerId).writerIds == m.writerIds + [writerId];
    forall id | id in m.writerIds ensures writerAt(commitWrite(m, writerId), id) == writerAt(m, id) {
      assert id != writerId;
      MemoStringKeyInjective(id, writerId);
    }
  }
}

lemma invalidateResident_ensures(m: MemoReads)
  ensures (inv(m) ==> alwaysMemoOwnsCache(invalidateResident(m)))
  ensures (inv(m) ==> alwaysVersionOrder(invalidateResident(m)))
  ensures (inv(m) ==> alwaysMemoPolicy(invalidateResident(m)))
  ensures (inv(m) ==> alwaysFetchCaptureAfterFloor(invalidateResident(m)))
  ensures (inv(m) ==> alwaysResidentUsesCurrentFloor(invalidateResident(m)))
  ensures (inv(m) ==> alwaysReaderBoundToItsFetch(invalidateResident(m)))
  ensures (inv(m) ==> alwaysServedReadMeetsFloor(invalidateResident(m)))
  ensures (inv(m) ==> alwaysFailedReadHasRejectedFetch(invalidateResident(m)))
  ensures (inv(m) ==> alwaysWriterVersion(invalidateResident(m)))
{
  if inv(m) {
    core__memo_invalidateKey_ensures(m.memo, "query");
    ImportedMemoInvalidationClears(m.memo, "query");
  }
}

lemma deliverRejection_ensures(m: MemoReads, observerId: int)
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysMemoOwnsCache(deliverRejection(m, observerId)))
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysVersionOrder(deliverRejection(m, observerId)))
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysMemoPolicy(deliverRejection(m, observerId)))
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysFetchCaptureAfterFloor(deliverRejection(m, observerId)))
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysResidentUsesCurrentFloor(deliverRejection(m, observerId)))
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysReaderBoundToItsFetch(deliverRejection(m, observerId)))
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysServedReadMeetsFloor(deliverRejection(m, observerId)))
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysFailedReadHasRejectedFetch(deliverRejection(m, observerId)))
  ensures (inv(m) ==> canDeliverRejection(m, observerId) ==> alwaysWriterVersion(deliverRejection(m, observerId)))
{
  if inv(m) && canDeliverRejection(m, observerId) {
    core__memo_observeRejection_ensures(m.memo, observerId);
    var after := core__memo_observeRejection(m.memo, observerId);
    ImportedMemoRejectionSubset(m.memo, observerId);
    ProofLib.FilterSubset((entry: core__memo_MemoEntry) => ((entry.key != core__memo_observerAt(m.memo, observerId).key) || (entry.promiseId != core__memo_observerAt(m.memo, observerId).promiseId)), m.memo.entries);
    ImportedMemoSubsetLookup(m.memo, after, "query");
  }
}

lemma invalidateWrite_ensures(m: MemoReads, writerId: string)
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysMemoOwnsCache(invalidateWrite(m, writerId)))
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysVersionOrder(invalidateWrite(m, writerId)))
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysMemoPolicy(invalidateWrite(m, writerId)))
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysFetchCaptureAfterFloor(invalidateWrite(m, writerId)))
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysResidentUsesCurrentFloor(invalidateWrite(m, writerId)))
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysReaderBoundToItsFetch(invalidateWrite(m, writerId)))
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysServedReadMeetsFloor(invalidateWrite(m, writerId)))
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysFailedReadHasRejectedFetch(invalidateWrite(m, writerId)))
  ensures (inv(m) ==> canInvalidateWrite(m, writerId) ==> alwaysWriterVersion(invalidateWrite(m, writerId)))
{
  if inv(m) && canInvalidateWrite(m, writerId) {
    core__memo_invalidateKey_ensures(m.memo, "query");
    ImportedMemoInvalidationClears(m.memo, "query");
    forall id | id in m.writerIds && id != writerId ensures writerAt(invalidateWrite(m, writerId), id) == writerAt(m, id) {
      MemoStringKeyInjective(id, writerId);
    }
  }
}

lemma captureNextFetch_ensures(m: MemoReads)
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysMemoOwnsCache(captureNextFetch(m)))
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysVersionOrder(captureNextFetch(m)))
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysMemoPolicy(captureNextFetch(m)))
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysFetchCaptureAfterFloor(captureNextFetch(m)))
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysResidentUsesCurrentFloor(captureNextFetch(m)))
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysReaderBoundToItsFetch(captureNextFetch(m)))
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysServedReadMeetsFloor(captureNextFetch(m)))
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysFailedReadHasRejectedFetch(captureNextFetch(m)))
  ensures (inv(m) ==> canCaptureNextFetch(m) ==> alwaysWriterVersion(captureNextFetch(m)))
{
  captureFetch_ensures(m, nextCaptureId(m));
}

lemma resolveNextFetch_ensures(m: MemoReads)
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysMemoOwnsCache(resolveNextFetch(m)))
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysVersionOrder(resolveNextFetch(m)))
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysMemoPolicy(resolveNextFetch(m)))
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysFetchCaptureAfterFloor(resolveNextFetch(m)))
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysResidentUsesCurrentFloor(resolveNextFetch(m)))
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysReaderBoundToItsFetch(resolveNextFetch(m)))
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysServedReadMeetsFloor(resolveNextFetch(m)))
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysFailedReadHasRejectedFetch(resolveNextFetch(m)))
  ensures (inv(m) ==> canResolveNextFetch(m) ==> alwaysWriterVersion(resolveNextFetch(m)))
{
  resolveFetch_ensures(m, nextResolutionId(m));
}

lemma completeNextRead_ensures(m: MemoReads)
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysMemoOwnsCache(completeNextRead(m)))
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysVersionOrder(completeNextRead(m)))
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysMemoPolicy(completeNextRead(m)))
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysFetchCaptureAfterFloor(completeNextRead(m)))
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysResidentUsesCurrentFloor(completeNextRead(m)))
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysReaderBoundToItsFetch(completeNextRead(m)))
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysServedReadMeetsFloor(completeNextRead(m)))
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysFailedReadHasRejectedFetch(completeNextRead(m)))
  ensures (inv(m) ==> canCompleteNextRead(m) ==> alwaysWriterVersion(completeNextRead(m)))
{
  completeRead_ensures(m, nextReaderId(m));
}

lemma invalidateNextWrite_ensures(m: MemoReads)
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysMemoOwnsCache(invalidateNextWrite(m)))
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysVersionOrder(invalidateNextWrite(m)))
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysMemoPolicy(invalidateNextWrite(m)))
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysFetchCaptureAfterFloor(invalidateNextWrite(m)))
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysResidentUsesCurrentFloor(invalidateNextWrite(m)))
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysReaderBoundToItsFetch(invalidateNextWrite(m)))
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysServedReadMeetsFloor(invalidateNextWrite(m)))
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysFailedReadHasRejectedFetch(invalidateNextWrite(m)))
  ensures (inv(m) ==> canInvalidateNextWrite(m) ==> alwaysWriterVersion(invalidateNextWrite(m)))
{
  invalidateWrite_ensures(m, nextWriterId(m));
}
