lemma CountPointwise<T>(p: T -> bool, xs: seq<T>, ys: seq<T>, k: int)
  requires |xs| == |ys| && forall i :: 0 <= i < |xs| && i != k && p(xs[i]) ==> p(ys[i])
  ensures |ProofLib.Filter(p, xs)| <= |ProofLib.Filter(p, ys)| + (if 0 <= k < |xs| then 1 else 0)
  decreases |xs|
{
  if |xs| > 0 {
    ProofLib.FilterCons(p, xs); ProofLib.FilterCons(p, ys);
    CountPointwise(p, xs[1..], ys[1..], k - 1);
  }
}

lemma ProcessorFilters(s: Processor, itemId: int)
  ensures alwaysProcessorConcurrency(s) == (|ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?, s.items)| <= s.maxParallel)
  ensures canStartItem(s, itemId) == ((|ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?, s.items)| < s.maxParallel) && (exists j :: j in s.items && (((j.id == itemId) && j.phase.ItemWaiting?) && (j.attempts < j.maxAttempts))))
  ensures alwaysItemIdsUnique(s) == (forall j :: j in s.items ==> |ProofLib.Filter((other: ProcessorItem) => (other.id == j.id), s.items)| == 1)
{}

lemma IdPairs(s: Processor)
  ensures alwaysItemIdsUnique(s) == (forall a, b :: 0 <= a < |s.items| && 0 <= b < |s.items| && a != b ==> s.items[a].id != s.items[b].id)
{
  ProcessorFilters(s, 0);
  forall a | 0 <= a < |s.items|
    ensures |ProofLib.Filter((other: ProcessorItem) => (other.id == s.items[a].id), s.items)| == 1 <==> forall b :: 0 <= b < |s.items| && b != a ==> s.items[b].id != s.items[a].id
  {
    ProofLib.FilterCountOneIffUnique((other: ProcessorItem) => (other.id == s.items[a].id), s.items, (x: ProcessorItem) => x.id, a);
  }
}

lemma Changed(s: Processor, after: Processor, itemId: int) returns (k: int)
  requires alwaysItemIdsUnique(s) && |after.items| == |s.items|
  requires exists j :: j in s.items && j.id == itemId
  requires forall i :: 0 <= i < |s.items| && s.items[i].id != itemId ==> after.items[i] == s.items[i]
  requires forall i :: 0 <= i < |s.items| ==> after.items[i].id == s.items[i].id
  ensures 0 <= k < |s.items| && s.items[k].id == itemId
  ensures forall i :: 0 <= i < |s.items| && i != k ==> after.items[i] == s.items[i]
  ensures alwaysItemIdsUnique(after)
  ensures forall j :: j in after.items ==> j == after.items[k] || j in s.items
  ensures stepCompletedItemsAreStable(s, after) <== !(s.items[k].phase.ItemSucceeded? || s.items[k].phase.ItemFailed?)
{
  IdPairs(s); IdPairs(after);
  var j :| j in s.items && j.id == itemId;
  k :| 0 <= k < |s.items| && s.items[k] == j;
  forall i | 0 <= i < |s.items| && i != k ensures after.items[i] in s.items { assert after.items[i] == s.items[i]; }
  if !(s.items[k].phase.ItemSucceeded? || s.items[k].phase.ItemFailed?) {
    forall x | x in s.items && (x.phase.ItemSucceeded? || x.phase.ItemFailed?) ensures x in after.items {
      var i :| 0 <= i < |s.items| && s.items[i] == x;
      assert after.items[i] == x;
    }
  }
}

lemma configureProcessor_ensures(s: Processor, maxParallel: int, defaultAttempts: int, maxCap: int, hasCap: bool)
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysProcessorConcurrency(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysAttemptBudgets(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysConfigurationPrecedesItems(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysItemIdsUnique(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysRunningAttemptIsCounted(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysSuccessHasAttempt(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> stepCompletedItemsAreStable(s, configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
{
  if inv(s) && canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) {
    var after := configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap);
    ProcessorFilters(after, 0);
    ProofLib.FilterNil((j: ProcessorItem) => j.phase.ItemRunning?, after.items);
  }
}

lemma submitItem_ensures(s: Processor, itemId: int, batchId: int, payload: string, perItemAttempts: int)
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysProcessorConcurrency(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysAttemptBudgets(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysConfigurationPrecedesItems(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysItemIdsUnique(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysRunningAttemptIsCounted(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysSuccessHasAttempt(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> stepCompletedItemsAreStable(s, submitItem(s, itemId, batchId, payload, perItemAttempts)))
{
  if inv(s) && canSubmitItem(s, itemId, batchId, payload, perItemAttempts) {
    var after := submitItem(s, itemId, batchId, payload, perItemAttempts);
    var added := after.items[|s.items|];
    assert after.items == s.items + [added];
    ProcessorFilters(s, 0); ProcessorFilters(after, 0); IdPairs(s); IdPairs(after);
    ProofLib.FilterAppend((j: ProcessorItem) => j.phase.ItemRunning?, s.items, added);
    assert forall i :: 0 <= i < |s.items| ==> s.items[i] in s.items && after.items[i] == s.items[i];
  }
}

lemma startItem_ensures(s: Processor, itemId: int)
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysProcessorConcurrency(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysAttemptBudgets(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysConfigurationPrecedesItems(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysItemIdsUnique(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysRunningAttemptIsCounted(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysSuccessHasAttempt(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> stepCompletedItemsAreStable(s, startItem(s, itemId)))
{
  if inv(s) && canStartItem(s, itemId) {
    var after := startItem(s, itemId);
    ProcessorFilters(s, itemId); ProcessorFilters(after, itemId);
    var k := Changed(s, after, itemId);
    assert s.items[k].phase.ItemWaiting? && s.items[k].attempts < s.items[k].maxAttempts by { IdPairs(s); }
    CountPointwise((j: ProcessorItem) => j.phase.ItemRunning?, after.items, s.items, k);
  }
}

lemma finishItemAttempt_ensures(s: Processor, itemId: int, ok: bool, retry: bool)
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysProcessorConcurrency(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysAttemptBudgets(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysConfigurationPrecedesItems(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysItemIdsUnique(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysRunningAttemptIsCounted(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysSuccessHasAttempt(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> stepCompletedItemsAreStable(s, finishItemAttempt(s, itemId, ok, retry)))
{
  if inv(s) && canFinishItemAttempt(s, itemId, ok, retry) {
    var after := finishItemAttempt(s, itemId, ok, retry);
    ProcessorFilters(s, itemId); ProcessorFilters(after, itemId);
    var k := Changed(s, after, itemId);
    assert s.items[k].phase.ItemRunning? by { IdPairs(s); }
    assert s.items[k] in s.items;
    CountPointwise((j: ProcessorItem) => j.phase.ItemRunning?, after.items, s.items, -1);
  }
}

lemma finishBackoff_ensures(s: Processor, itemId: int)
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysProcessorConcurrency(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysAttemptBudgets(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysConfigurationPrecedesItems(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysItemIdsUnique(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysRunningAttemptIsCounted(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysSuccessHasAttempt(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> stepCompletedItemsAreStable(s, finishBackoff(s, itemId)))
{
  if inv(s) && canFinishBackoff(s, itemId) {
    var after := finishBackoff(s, itemId);
    ProcessorFilters(s, itemId); ProcessorFilters(after, itemId);
    var k := Changed(s, after, itemId);
    assert s.items[k].phase.ItemBackoff? by { IdPairs(s); }
    assert s.items[k] in s.items;
    CountPointwise((j: ProcessorItem) => j.phase.ItemRunning?, after.items, s.items, -1);
  }
}

lemma finishExhaustion_ensures(s: Processor, itemId: int, callbackOk: bool)
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysProcessorConcurrency(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysAttemptBudgets(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysConfigurationPrecedesItems(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysItemIdsUnique(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysRunningAttemptIsCounted(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysSuccessHasAttempt(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> stepCompletedItemsAreStable(s, finishExhaustion(s, itemId, callbackOk)))
{
  if inv(s) && canFinishExhaustion(s, itemId, callbackOk) {
    var after := finishExhaustion(s, itemId, callbackOk);
    ProcessorFilters(s, itemId); ProcessorFilters(after, itemId);
    var k := Changed(s, after, itemId);
    assert s.items[k].phase.ItemExhausting? by { IdPairs(s); }
    assert s.items[k] in s.items;
    CountPointwise((j: ProcessorItem) => j.phase.ItemRunning?, after.items, s.items, -1);
  }
}
