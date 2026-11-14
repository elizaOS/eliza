lemma beginRewrite_ensures(s: VoiceRewrite, key: VoiceCacheKey, originalText: string)
  ensures (inv(s) ==> alwaysCacheCapacityAndKeys(beginRewrite(s, key, originalText)))
  ensures (inv(s) ==> alwaysPendingOrFailureRetainsOriginal(beginRewrite(s, key, originalText)))
  ensures (inv(s) ==> alwaysCallIdentityAtSlot(beginRewrite(s, key, originalText)))
  ensures (inv(s) ==> stepFailurePreservesSharedCache(s, beginRewrite(s, key, originalText)))
  ensures (inv(s) ==> stepCompletedCallIsImmutable(s, beginRewrite(s, key, originalText)))
{
  if inv(s) {
    var after := beginRewrite(s, key, originalText);
    if cacheContains(s.cache, key) { VoiceTouchPreservesKeys(s, key); }
    forall call | call in after.calls ensures call.ticket > 0 && call.ticket < after.nextTicket && callAt(after, call.ticket) == call && |ProofLib.Filter((other: RewriteCall) => other.ticket == call.ticket, after.calls)| == 1 {
      var p := (other: RewriteCall) => other.ticket == call.ticket;
      var newCall := after.calls[|s.calls|];
      ProofLib.FilterAppend(p, s.calls, newCall);
      if call == newCall {
        ProofLib.FilterNone(p, s.calls);
      } else {
        assert call in s.calls;
        assert after.calls[..|s.calls|] == s.calls;
      }
    }
  }
}

lemma settleRewrite_ensures(s: VoiceRewrite, ticket: int, normalizedText: string)
  ensures (inv(s) ==> canSettleRewrite(s, ticket) ==> alwaysCacheCapacityAndKeys(settleRewrite(s, ticket, normalizedText)))
  ensures (inv(s) ==> canSettleRewrite(s, ticket) ==> alwaysPendingOrFailureRetainsOriginal(settleRewrite(s, ticket, normalizedText)))
  ensures (inv(s) ==> canSettleRewrite(s, ticket) ==> alwaysCallIdentityAtSlot(settleRewrite(s, ticket, normalizedText)))
  ensures (inv(s) ==> canSettleRewrite(s, ticket) ==> stepFailurePreservesSharedCache(s, settleRewrite(s, ticket, normalizedText)))
  ensures (inv(s) ==> canSettleRewrite(s, ticket) ==> stepCompletedCallIsImmutable(s, settleRewrite(s, ticket, normalizedText)))
{
  if inv(s) && canSettleRewrite(s, ticket) {
    var after := settleRewrite(s, ticket, normalizedText);
    if normalizedText != "" { VoiceStorePreservesKeys(s, callAt(s, ticket).key, normalizedText); }
    VoiceCallFrame(s, after, ticket);
    forall call | call in after.calls && (call.phase.RewritePending? || call.failed) ensures call.output == call.originalText && !call.voiced {
      var i :| 0 <= i < |after.calls| && after.calls[i] == call;
      assert s.calls[i] in s.calls;
    }
  }
}

lemma settleNext_ensures(s: VoiceRewrite, normalizedText: string)
  ensures (inv(s) ==> canSettleNext(s) ==> alwaysCacheCapacityAndKeys(settleNext(s, normalizedText)))
  ensures (inv(s) ==> canSettleNext(s) ==> alwaysPendingOrFailureRetainsOriginal(settleNext(s, normalizedText)))
  ensures (inv(s) ==> canSettleNext(s) ==> alwaysCallIdentityAtSlot(settleNext(s, normalizedText)))
  ensures (inv(s) ==> canSettleNext(s) ==> stepFailurePreservesSharedCache(s, settleNext(s, normalizedText)))
  ensures (inv(s) ==> canSettleNext(s) ==> stepCompletedCallIsImmutable(s, settleNext(s, normalizedText)))
{
  if inv(s) && canSettleNext(s) {
    settleRewrite_ensures(s, oldestPending(s), normalizedText);
  }
}

lemma VoiceCallFrame(before: VoiceRewrite, after: VoiceRewrite, ticket: int)
  requires inv(before) && pendingTicket(before, ticket)
  requires after.nextTicket == before.nextTicket && |after.calls| == |before.calls|
  requires forall i :: 0 <= i < |after.calls| ==> after.calls[i].ticket == before.calls[i].ticket && (after.calls[i].ticket != ticket ==> after.calls[i] == before.calls[i])
  ensures alwaysCallIdentityAtSlot(after)
  ensures stepCompletedCallIsImmutable(before, after)
{
  forall call | call in after.calls ensures call.ticket > 0 && call.ticket < after.nextTicket && callAt(after, call.ticket) == call && |ProofLib.Filter((other: RewriteCall) => other.ticket == call.ticket, after.calls)| == 1 {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := before.calls[i];
    assert prior in before.calls;
    var p := (other: RewriteCall) => other.ticket == call.ticket;
    ProofLib.FilterLengthPointwise(p, p, before.calls, after.calls);
    assert i == call.ticket - 1 by {
      if i != call.ticket - 1 {
        assert before.calls[call.ticket - 1] == prior;
        ProofLib.FilterTwo(p, before.calls, i, call.ticket - 1);
      }
    }
  }
  forall call | call in before.calls && call.phase.RewriteDone? ensures callAt(after, call.ticket) == call {
    assert callAt(before, call.ticket) == call && call.ticket != ticket;
    assert after.calls[call.ticket - 1] == before.calls[call.ticket - 1];
  }
}

lemma VoiceCacheUnique(cache: seq<VoiceCacheEntry>)
  ensures ProofLib.DistinctBy(cache, (row: VoiceCacheEntry) => row.key) <==> (forall row :: row in cache ==> |ProofLib.Filter((other: VoiceCacheEntry) => other.key == row.key, cache)| == 1)
{
  var key := (row: VoiceCacheEntry) => row.key;
  if ProofLib.DistinctBy(cache, key) {
    forall row | row in cache ensures |ProofLib.Filter((other: VoiceCacheEntry) => other.key == row.key, cache)| == 1 {
      var i :| 0 <= i < |cache| && cache[i] == row;
      ProofLib.FilterCountOneIffUnique((other: VoiceCacheEntry) => other.key == row.key, cache, key, i);
    }
  } else if forall row :: row in cache ==> |ProofLib.Filter((other: VoiceCacheEntry) => other.key == row.key, cache)| == 1 {
    forall i, j | 0 <= i < |cache| && 0 <= j < |cache| && i != j ensures cache[i].key != cache[j].key {
      assert cache[i] in cache;
      var p := (other: VoiceCacheEntry) => other.key == cache[i].key;
      assert |ProofLib.Filter(p, cache)| == 1;
      ProofLib.FilterCountOneIffUnique(p, cache, key, i);
    }
  }
}

lemma VoiceTouchPreservesKeys(s: VoiceRewrite, key: VoiceCacheKey)
  requires alwaysCacheCapacityAndKeys(s) && cacheContains(s.cache, key)
  ensures |touchCache(s.cache, key)| <= 500
  ensures forall row :: row in touchCache(s.cache, key) ==> |ProofLib.Filter((other: VoiceCacheEntry) => other.key == row.key, touchCache(s.cache, key))| == 1
{
  var entries := s.cache;
  var keys := (row: VoiceCacheEntry) => row.key;
  var keep := (row: VoiceCacheEntry) => row.key != key;
  var hasKey := (row: VoiceCacheEntry) => row.key == key;
  var rest := ProofLib.Filter(keep, entries);
  var matched := ProofLib.Filter(hasKey, entries);
  var known :| known in entries && known.key == key;
  ProofLib.FilterMember(hasKey, entries, known);
  assert |matched| == 1 && matched[0] == known;
  assert cachedEntry(entries, key) == known;
  VoiceCacheUnique(entries);
  ProofLib.FilterImpLength(keep, (row: VoiceCacheEntry) => true, entries);
  VoiceIdentityFilter(entries);
  var i :| 0 <= i < |entries| && entries[i] == known;
  assert !keep(entries[i]);
  assert |rest| < |entries|;
  ProofLib.FilterKeepsDistinctBy(keep, entries, keys);
  forall j | 0 <= j < |rest| ensures rest[j].key != key {
    ProofLib.FilterMember(keep, entries, rest[j]);
  }
  ProofLib.DistinctByConcat(rest, [known], keys);
  VoiceCacheUnique(touchCache(entries, key));
}

lemma VoiceStorePreservesKeys(s: VoiceRewrite, key: VoiceCacheKey, text: string)
  requires alwaysCacheCapacityAndKeys(s)
  ensures |storeRewrite(s.cache, key, text)| <= 500
  ensures forall row :: row in storeRewrite(s.cache, key, text) ==> |ProofLib.Filter((other: VoiceCacheEntry) => other.key == row.key, storeRewrite(s.cache, key, text))| == 1
{
  var entries := s.cache;
  var getKey := (row: VoiceCacheEntry) => row.key;
  var stored := storeRewrite(entries, key, text);
  VoiceCacheUnique(entries);
  if cacheContains(entries, key) {
    forall i, j | 0 <= i < |stored| && 0 <= j < |stored| && i != j ensures stored[i].key != stored[j].key {
      assert stored[i].key == entries[i].key && stored[j].key == entries[j].key;
    }
  } else {
    var raised := entries + [VoiceCacheEntry(key, text)];
    ProofLib.DistinctByConcat(entries, [VoiceCacheEntry(key, text)], getKey);
    if |raised| > 500 {
      assert stored == raised[1..];
      forall i, j | 0 <= i < |stored| && 0 <= j < |stored| && i != j ensures stored[i].key != stored[j].key {
        assert stored[i] == raised[i+1] && stored[j] == raised[j+1];
      }
    }
  }
  VoiceCacheUnique(stored);
}

lemma VoiceIdentityFilter(entries: seq<VoiceCacheEntry>)
  ensures ProofLib.Filter((row: VoiceCacheEntry) => true, entries) == entries
  decreases |entries|
{
  if |entries| == 0 {
    ProofLib.FilterNil((row: VoiceCacheEntry) => true, entries);
  } else {
    ProofLib.FilterCons((row: VoiceCacheEntry) => true, entries);
    VoiceIdentityFilter(entries[1..]);
    assert entries == [entries[0]] + entries[1..];
  }
}
