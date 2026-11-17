lemma commitEvidence_ensures(e: EvidenceStore)
  ensures (inv(e) ==> canCommitEvidence(e) ==> alwaysLogCountsDistinctRecords(commitEvidence(e)))
  ensures (inv(e) ==> canCommitEvidence(e) ==> alwaysDiscardedConnectionHoldsNoTransaction(commitEvidence(e)))
  ensures (inv(e) ==> canCommitEvidence(e) ==> stepEvidenceOnlyGrows(e, commitEvidence(e)))
  ensures (inv(e) ==> canCommitEvidence(e) ==> stepRepeatAndRollbackAddNothing(e, "commitEvidence", commitEvidence(e)))
{
  if inv(e) && canCommitEvidence(e) {
    ProofLib.FilterCons((set_x: int) => !((set_x in e.recorded)), [e.staged]);
    ProofLib.FilterNil((set_x: int) => !((set_x in e.recorded)), [e.staged][1..]);
    assert commitEvidence(e).recorded == e.recorded + [e.staged];
  }
}

