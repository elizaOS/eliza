lemma commit_ensures(s: FactWrites)
  ensures (inv(s) ==> canCommit(s) ==> alwaysWriteSnapshotMatchesStored(commit(s)))
  ensures (inv(s) ==> canCommit(s) ==> alwaysOneCanonicalRow(commit(s)))
  ensures (inv(s) ==> canCommit(s) ==> alwaysCommittedEvidenceRemains(commit(s)))
  ensures (inv(s) ==> canCommit(s) ==> alwaysOwnerCoversWrite(commit(s)))
  ensures (inv(s) ==> canCommit(s) ==> stepCommittedEvidenceNeverDisappears(s,commit(s)))
{
  if inv(s) && canCommit(s) {
    var t := commit(s);
    ProofLib.FilterMember((key: string) => !(key in s.snapshot),[s.owner],s.owner);
    ProofLib.FilterMember((key: string) => !(key in s.receipts),[s.owner],s.owner);
    ProofLib.FilterSubset((key: string) => !(key in s.receipts),[s.owner]);
    assert s.owner in t.stored;
    forall entry | entry in t.receipts
      ensures entry in t.stored
    {
      if entry != s.owner {
        assert entry in s.receipts;
        assert entry in s.stored;
        assert entry in s.snapshot;
      }
    }
    forall entry | entry in s.stored
      ensures entry in t.stored
    {
      assert entry in s.snapshot;
    }
  }
}
