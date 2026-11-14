lemma clearStale_ensures(s: EmbeddingSpace, succeeded: bool)
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysPinnedUsesPreparedCandidate(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysPinnedColumnMatches(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysCurrentColumnHasMatchingDimensions(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysResizeWithoutFencePreservesConfirmedColumn(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysStoredDimensionsPositive(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysAdmittedVectorHasDimension(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysPreparedColumnMatchesCandidate(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysPreparedSpaceMatchesCandidate(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysPreparedCandidateMatchesPin(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> alwaysDisabledRefusesNewGeneration(clearStale(s, succeeded)))
  ensures (inv(s) ==> canClearStale(s, succeeded) ==> stepNamedPinDoesNotChange(s, clearStale(s, succeeded)))
{
  if inv(s) && canClearStale(s,succeeded) {
    var t := clearStale(s,succeeded);
    if succeeded {
      forall vector | vector in t.stored
        ensures vector in s.stored && (vector.dimension == s.column || vector.space != s.storeSpace)
      {
        ProofLib.FilterMember((v: Encoder) => v.dimension == s.column || v.space != s.storeSpace,s.stored,vector);
      }
    }
  }
}

lemma writeVector_ensures(s: EmbeddingSpace)
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysPinnedUsesPreparedCandidate(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysPinnedColumnMatches(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysCurrentColumnHasMatchingDimensions(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysResizeWithoutFencePreservesConfirmedColumn(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysStoredDimensionsPositive(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysAdmittedVectorHasDimension(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysPreparedColumnMatchesCandidate(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysPreparedSpaceMatchesCandidate(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysPreparedCandidateMatchesPin(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> alwaysDisabledRefusesNewGeneration(writeVector(s)))
  ensures (inv(s) ==> canWriteVector(s) ==> stepNamedPinDoesNotChange(s, writeVector(s)))
{
  if inv(s) && canWriteVector(s) {
    var t := writeVector(s);
    forall vector | vector in t.stored ensures vector.dimension > 0
    {
      if vector !in s.stored {
        assert t.stored == s.stored + [s.vector];
        assert vector == s.vector && vector.dimension == s.column;
      }
    }
  }
}
