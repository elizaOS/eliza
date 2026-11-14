lemma lawObservedLengthsNonnegative_ensures(s: core__skeletonStreamState_SkeletonState)
  ensures (lawObservedLengthsNonnegative(s) == true)
{
  ProofLib.FoldLeftInflationary((total: int, chunk: core__skeletonStreamState_SkeletonChunk) => (total + |chunk.units|), 0, s.chunks);
}
