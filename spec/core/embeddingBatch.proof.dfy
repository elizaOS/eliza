lemma EmbeddingBatchAppend(before: seq<string>, after: seq<string>, id: string)
  requires after == before + ProofLib.Filter((x: string) => !(x in before),[id])
  ensures forall x :: x in after <==> (x in before || x == id)
{
  ProofLib.FilterMember((x: string) => !(x in before),[id],id);
  ProofLib.FilterSubset((x: string) => !(x in before),[id]);
}

lemma EmbeddingBatchRemove(before: seq<string>, after: seq<string>, id: string)
  requires after == ProofLib.Filter((x: string) => !(x in [id]),before)
  ensures forall x :: x in after <==> (x in before && x != id)
{
  forall x ensures x in after <==> (x in before && x != id)
  {
    ProofLib.FilterMember((x: string) => !(x in [id]),before,x);
  }
}

lemma EmbeddingBatchFallbackPrimary(s: Batch,id: string)
  requires inv(s) && canFallback(s,id)
  ensures inv(fallback(s,id))
{
  var t := fallback(s,id);
  EmbeddingBatchAppend(s.retrying,t.retrying,id);
  forall x | x in t.retrying ensures x in t.retryable && x !in t.completed
  {
    assert x == id || x in s.retrying;
  }
}

lemma EmbeddingBatchPrimary(s: Batch,id: string,succeeded: bool)
  requires inv(s) && canPrimaryResult(s,id,succeeded)
  ensures inv(primaryResult(s,id,succeeded))
{
  var t := primaryResult(s,id,succeeded);
  EmbeddingBatchAppend(s.primaryDone,t.primaryDone,id);
  if succeeded {
    EmbeddingBatchAppend(s.completed,t.completed,id);
    assert id !in s.retrying;
  } else {
    EmbeddingBatchAppend(s.retryable,t.retryable,id);
  }
  forall x | x in t.primaryDone ensures x in t.members { assert x == id || x in s.primaryDone; }
  forall x | x in t.retryable ensures x in t.primaryDone { assert x == id || x in s.retryable; }
  forall x | x in t.retrying ensures x in t.retryable {
    assert x in s.retryable;
  }
  forall x | x in t.completed ensures x in t.primaryDone && x !in t.retrying
  {
    assert x == id || x in s.completed;
  }
}

lemma EmbeddingBatchResult(s: Batch,id: string)
  requires inv(s) && canFallbackResult(s,id)
  ensures inv(fallbackResult(s,id))
{
  var t := fallbackResult(s,id);
  EmbeddingBatchRemove(s.retrying,t.retrying,id);
  EmbeddingBatchRemove(s.retryable,t.retryable,id);
  EmbeddingBatchAppend(s.completed,t.completed,id);
  assert id in s.retryable && id in s.primaryDone;
  forall x | x in t.retryable ensures x in t.primaryDone { assert x in s.retryable; }
  forall x | x in t.retrying ensures x in t.retryable {
    assert x in s.retrying && x != id;
    assert x in s.retryable;
  }
  forall x | x in t.completed ensures x in t.primaryDone && x !in t.retrying
  {
    assert x == id || x in s.completed;
    if x != id { assert x !in s.retrying; }
  }
}

lemma primaryResult_ensures(s: Batch, id: string, succeeded: bool)
  ensures (inv(s) ==> canPrimaryResult(s, id, succeeded) ==> alwaysOutcomesBelongToMembers(primaryResult(s, id, succeeded)))
  ensures (inv(s) ==> canPrimaryResult(s, id, succeeded) ==> alwaysNoOutcomesBeforeAdmission(primaryResult(s, id, succeeded)))
  ensures (inv(s) ==> canPrimaryResult(s, id, succeeded) ==> alwaysFallbackWaitsForPrimary(primaryResult(s, id, succeeded)))
  ensures (inv(s) ==> canPrimaryResult(s, id, succeeded) ==> alwaysCompletedItemsHaveNoRetryOwner(primaryResult(s, id, succeeded)))
{
  if inv(s) && canPrimaryResult(s,id,succeeded) { EmbeddingBatchPrimary(s,id,succeeded); }
}

lemma fallback_ensures(s: Batch, id: string)
  ensures (inv(s) ==> canFallback(s, id) ==> alwaysOutcomesBelongToMembers(fallback(s, id)))
  ensures (inv(s) ==> canFallback(s, id) ==> alwaysNoOutcomesBeforeAdmission(fallback(s, id)))
  ensures (inv(s) ==> canFallback(s, id) ==> alwaysFallbackWaitsForPrimary(fallback(s, id)))
  ensures (inv(s) ==> canFallback(s, id) ==> alwaysCompletedItemsHaveNoRetryOwner(fallback(s, id)))
{
  if inv(s) && canFallback(s,id) { EmbeddingBatchFallbackPrimary(s,id); }
}

lemma fallbackResult_ensures(s: Batch, id: string)
  ensures (inv(s) ==> canFallbackResult(s, id) ==> alwaysOutcomesBelongToMembers(fallbackResult(s, id)))
  ensures (inv(s) ==> canFallbackResult(s, id) ==> alwaysNoOutcomesBeforeAdmission(fallbackResult(s, id)))
  ensures (inv(s) ==> canFallbackResult(s, id) ==> alwaysFallbackWaitsForPrimary(fallbackResult(s, id)))
  ensures (inv(s) ==> canFallbackResult(s, id) ==> alwaysCompletedItemsHaveNoRetryOwner(fallbackResult(s, id)))
{
  if inv(s) && canFallbackResult(s,id) { EmbeddingBatchResult(s,id); }
}
