lemma ProcessorIds(s: Processor)
  ensures alwaysProcessorInvocationIds(s) <==>
    (forall j :: j in s.items ==> (j.id > 0 && j.batch > 0 &&
      |ProofLib.Filter((other: ProcessorItem) => other.id == j.id, s.items)| == 1))
{}

lemma ProcessorRunning(s: Processor)
  ensures alwaysProcessorConcurrency(s) <==>
    |ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?, s.items)| <= s.maxParallel
{}

lemma ProcessorStartGuard(s: Processor,itemId: int)
  ensures canStartItem(s,itemId) <==>
    |ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?,s.items)| < s.maxParallel &&
    (exists j :: j in s.items && j.id == itemId && j.phase.ItemWaiting? && j.attempts < j.maxAttempts)
{}

lemma ProcessorSelection(s: Processor, selected: ProcessorItem)
  requires alwaysProcessorInvocationIds(s) && selected in s.items
  ensures forall j :: j in s.items && j.id == selected.id ==> j == selected
{
  ProcessorIds(s);
  var i :| 0 <= i < |s.items| && s.items[i] == selected;
  ProofLib.FilterCountOneIffUnique((other: ProcessorItem) => other.id == selected.id, s.items, (other: ProcessorItem) => other.id, i);
  forall j | j in s.items && j.id == selected.id ensures j == selected {
    var k :| 0 <= k < |s.items| && s.items[k] == j;
    assert i == k;
  }
}

lemma ProcessorIdentityMap(s: Processor, t: Processor)
  requires inv(s)
  requires |s.items| <= |t.items| <= |s.items| + 1
  requires forall i :: 0 <= i < |s.items| ==> s.items[i].id == t.items[i].id && s.items[i].batch == t.items[i].batch
  requires |t.items| > |s.items| ==> (t.items[|s.items|].id > 0 && t.items[|s.items|].batch > 0 &&
    !(exists priorItem :: priorItem in s.items && priorItem.id == t.items[|s.items|].id))
  ensures alwaysProcessorInvocationIds(t)
{
  ProcessorIds(s); ProcessorIds(t);
  forall i,j | 0 <= i < |t.items| && 0 <= j < |t.items| && i != j
    ensures t.items[i].id != t.items[j].id
  {
    if i < |s.items| && j < |s.items| {
      var priorItem := s.items[i]; assert priorItem in s.items;
      ProofLib.FilterCountOneIffUnique((other: ProcessorItem) => other.id == priorItem.id, s.items, (other: ProcessorItem) => other.id, i);
    } else if i < |s.items| { assert s.items[i] in s.items; }
    else { assert s.items[j] in s.items; }
  }
  forall j | j in t.items
    ensures j.id > 0 && j.batch > 0 && |ProofLib.Filter((other: ProcessorItem) => other.id == j.id,t.items)| == 1
  {
    var i :| 0 <= i < |t.items| && t.items[i] == j;
    if i < |s.items| { assert s.items[i] in s.items; }
    ProofLib.FilterOne((other: ProcessorItem) => other.id == j.id,t.items,i);
  }
}

lemma ProcessorMapFacts(s: Processor,t: Processor)
  requires inv(s)
  requires |s.items| == |t.items|
  requires t.configured == s.configured && t.maxParallel == s.maxParallel && t.defaultAttempts == s.defaultAttempts && t.maxCap == s.maxCap && t.hasCap == s.hasCap
  requires forall i :: 0 <= i < |t.items| ==> (t.items[i].attempts >= 0 && t.items[i].attempts <= t.items[i].maxAttempts && t.items[i].maxAttempts > 0 && t.items[i].retryCount >= 0 && t.items[i].retryCount <= t.items[i].attempts &&
    (t.items[i].phase.ItemRunning? ==> t.items[i].retryCount < t.items[i].attempts) &&
    (t.items[i].phase.ItemSucceeded? ==> t.items[i].attempts > 0))
  ensures alwaysAttemptBudgets(t) && alwaysRunningAttemptOwnsRetryHistory(t) && alwaysSuccessHasAttempt(t) && alwaysProcessorConstruction(t)
{
  forall j | j in t.items
    ensures j.attempts >= 0 && j.attempts <= j.maxAttempts && j.maxAttempts > 0 && j.retryCount >= 0 && j.retryCount <= j.attempts &&
      (j.phase.ItemRunning? ==> j.retryCount < j.attempts) && (j.phase.ItemSucceeded? ==> j.attempts > 0)
  {
    var i :| 0 <= i < |t.items| && t.items[i] == j;
  }
}

lemma ProcessorCompletedMap(s: Processor,t: Processor)
  requires |s.items| <= |t.items|
  requires forall i :: 0 <= i < |s.items| && (s.items[i].phase.ItemSucceeded? || s.items[i].phase.ItemFailed?) ==> t.items[i] == s.items[i]
  ensures stepCompletedItemsAreStable(s,t)
{
  forall j | j in s.items && (j.phase.ItemSucceeded? || j.phase.ItemFailed?)
    ensures exists other :: other in t.items && other == j
  {
    var i :| 0 <= i < |s.items| && s.items[i] == j;
    assert t.items[i] == j && t.items[i] in t.items;
  }
}

lemma RunningNonincrease(xs: seq<ProcessorItem>,ys: seq<ProcessorItem>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| && ys[i].phase.ItemRunning? ==> xs[i].phase.ItemRunning?
  ensures |ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?,ys)| <= |ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?,xs)|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((j: ProcessorItem) => j.phase.ItemRunning?,xs);
    ProofLib.FilterNil((j: ProcessorItem) => j.phase.ItemRunning?,ys);
  } else {
    ProofLib.FilterCons((j: ProcessorItem) => j.phase.ItemRunning?,xs);
    ProofLib.FilterCons((j: ProcessorItem) => j.phase.ItemRunning?,ys);
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i+1] && ys[1..][i] == ys[i+1];
    RunningNonincrease(xs[1..],ys[1..]);
  }
}

lemma RunningAddsOne(xs: seq<ProcessorItem>,ys: seq<ProcessorItem>,at: int)
  requires |xs| == |ys| && 0 <= at < |xs|
  requires !xs[at].phase.ItemRunning? && ys[at].phase.ItemRunning?
  requires forall i :: 0 <= i < |xs| && i != at ==> xs[i].phase.ItemRunning? == ys[i].phase.ItemRunning?
  ensures |ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?,ys)| == |ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?,xs)| + 1
  decreases |xs|
{
  ProofLib.FilterCons((j: ProcessorItem) => j.phase.ItemRunning?,xs);
  ProofLib.FilterCons((j: ProcessorItem) => j.phase.ItemRunning?,ys);
  assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i+1] && ys[1..][i] == ys[i+1];
  if at == 0 {
    RunningNonincrease(xs[1..],ys[1..]);
    RunningNonincrease(ys[1..],xs[1..]);
  } else { RunningAddsOne(xs[1..],ys[1..],at-1); }
}

lemma configureProcessor_ensures(s: Processor, maxParallel: int, defaultAttempts: int, maxCap: int, hasCap: bool)
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysProcessorConcurrency(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysAttemptBudgets(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysProcessorConstruction(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysProcessorInvocationIds(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysRunningAttemptOwnsRetryHistory(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> alwaysSuccessHasAttempt(configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
  ensures (inv(s) ==> canConfigureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap) ==> stepCompletedItemsAreStable(s, configureProcessor(s, maxParallel, defaultAttempts, maxCap, hasCap)))
{
  if inv(s) && canConfigureProcessor(s,maxParallel,defaultAttempts,maxCap,hasCap) {
    var t := configureProcessor(s,maxParallel,defaultAttempts,maxCap,hasCap);
    assert s.items == [] && t.items == [];
    ProcessorRunning(t);
    ProofLib.FilterNil((j: ProcessorItem) => j.phase.ItemRunning?,t.items);
    ProcessorIds(t);
  }
}

lemma submitItem_ensures(s: Processor, itemId: int, batchId: int, payload: string, perItemAttempts: int)
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysProcessorConcurrency(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysAttemptBudgets(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysProcessorConstruction(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysProcessorInvocationIds(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysRunningAttemptOwnsRetryHistory(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> alwaysSuccessHasAttempt(submitItem(s, itemId, batchId, payload, perItemAttempts)))
  ensures (inv(s) ==> canSubmitItem(s, itemId, batchId, payload, perItemAttempts) ==> stepCompletedItemsAreStable(s, submitItem(s, itemId, batchId, payload, perItemAttempts)))
{
  if inv(s) && canSubmitItem(s,itemId,batchId,payload,perItemAttempts) {
    var t := submitItem(s,itemId,batchId,payload,perItemAttempts);
    assert attemptBudget(s,perItemAttempts) > 0;
    ProcessorIdentityMap(s,t); ProcessorCompletedMap(s,t);
    ProcessorRunning(s); ProcessorRunning(t);
    ProofLib.FilterAppend((j: ProcessorItem) => j.phase.ItemRunning?,s.items,t.items[|s.items|]);
    forall j | j in t.items ensures j.attempts >= 0 && j.attempts <= j.maxAttempts && j.maxAttempts > 0 && j.retryCount >= 0 && j.retryCount <= j.attempts &&
      (j.phase.ItemRunning? ==> j.retryCount < j.attempts) && (j.phase.ItemSucceeded? ==> j.attempts > 0) {
      if j in s.items { } else { assert j == t.items[|s.items|]; }
    }
  }
}

lemma startItem_ensures(s: Processor, itemId: int)
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysProcessorConcurrency(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysAttemptBudgets(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysProcessorConstruction(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysProcessorInvocationIds(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysRunningAttemptOwnsRetryHistory(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> alwaysSuccessHasAttempt(startItem(s, itemId)))
  ensures (inv(s) ==> canStartItem(s, itemId) ==> stepCompletedItemsAreStable(s, startItem(s, itemId)))
{
  if inv(s) && canStartItem(s,itemId) {
    ProcessorStartGuard(s,itemId);
    var t := startItem(s,itemId);
    var selected :| selected in s.items && selected.id == itemId && selected.phase.ItemWaiting? && selected.attempts < selected.maxAttempts;
    ProcessorSelection(s,selected);
    ProcessorIdentityMap(s,t);
    forall i | 0 <= i < |t.items|
      ensures t.items[i].attempts >= 0 && t.items[i].attempts <= t.items[i].maxAttempts && t.items[i].maxAttempts > 0 && t.items[i].retryCount >= 0 && t.items[i].retryCount <= t.items[i].attempts &&
        (t.items[i].phase.ItemRunning? ==> t.items[i].retryCount < t.items[i].attempts) &&
        (t.items[i].phase.ItemSucceeded? ==> t.items[i].attempts > 0)
    {
      assert s.items[i] in s.items;
      if s.items[i].id == itemId { assert s.items[i] == selected; }
    }
    ProcessorMapFacts(s,t);
    forall i | 0 <= i < |s.items| && (s.items[i].phase.ItemSucceeded? || s.items[i].phase.ItemFailed?)
      ensures t.items[i] == s.items[i]
    {
      assert s.items[i] in s.items;
      if s.items[i].id == itemId { assert s.items[i] == selected; }
    }
    ProcessorCompletedMap(s,t);
    ProcessorRunning(s); ProcessorRunning(t);
    var at :| 0 <= at < |s.items| && s.items[at] == selected;
    ProcessorIds(s);
    ProofLib.FilterCountOneIffUnique((other: ProcessorItem) => other.id == selected.id,s.items,(other: ProcessorItem) => other.id,at);
    forall i | 0 <= i < |s.items| && i != at ensures s.items[i].phase.ItemRunning? == t.items[i].phase.ItemRunning? {
      assert s.items[i].id != itemId;
    }
    RunningAddsOne(s.items,t.items,at);
    assert |ProofLib.Filter((j: ProcessorItem) => j.phase.ItemRunning?,s.items)| < s.maxParallel;
  }
}

lemma finishItemAttempt_ensures(s: Processor, itemId: int, ok: bool, retry: bool)
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysProcessorConcurrency(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysAttemptBudgets(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysProcessorConstruction(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysProcessorInvocationIds(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysRunningAttemptOwnsRetryHistory(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> alwaysSuccessHasAttempt(finishItemAttempt(s, itemId, ok, retry)))
  ensures (inv(s) ==> canFinishItemAttempt(s, itemId, ok, retry) ==> stepCompletedItemsAreStable(s, finishItemAttempt(s, itemId, ok, retry)))
{
  if inv(s) && canFinishItemAttempt(s,itemId,ok,retry) {
    var t := finishItemAttempt(s,itemId,ok,retry);
    var selected :| selected in s.items && selected.id == itemId && selected.phase.ItemRunning?;
    ProcessorSelection(s,selected);
    ProcessorIdentityMap(s,t);
    forall i | 0 <= i < |t.items|
      ensures t.items[i].attempts >= 0 && t.items[i].attempts <= t.items[i].maxAttempts && t.items[i].maxAttempts > 0 && t.items[i].retryCount >= 0 && t.items[i].retryCount <= t.items[i].attempts &&
        (t.items[i].phase.ItemRunning? ==> t.items[i].retryCount < t.items[i].attempts) &&
        (t.items[i].phase.ItemSucceeded? ==> t.items[i].attempts > 0)
    {
      assert s.items[i] in s.items;
      if s.items[i].id == itemId { assert s.items[i] == selected; }
    }
    ProcessorMapFacts(s,t);
    forall i | 0 <= i < |s.items| && (s.items[i].phase.ItemSucceeded? || s.items[i].phase.ItemFailed?)
      ensures t.items[i] == s.items[i]
    {
      assert s.items[i] in s.items;
      if s.items[i].id == itemId { assert s.items[i] == selected; }
    }
    ProcessorCompletedMap(s,t);
    ProcessorRunning(s); ProcessorRunning(t);
    forall i | 0 <= i < |s.items| && t.items[i].phase.ItemRunning? ensures s.items[i].phase.ItemRunning? { }
    RunningNonincrease(s.items,t.items);
  }
}

lemma finishBackoff_ensures(s: Processor, itemId: int)
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysProcessorConcurrency(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysAttemptBudgets(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysProcessorConstruction(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysProcessorInvocationIds(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysRunningAttemptOwnsRetryHistory(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> alwaysSuccessHasAttempt(finishBackoff(s, itemId)))
  ensures (inv(s) ==> canFinishBackoff(s, itemId) ==> stepCompletedItemsAreStable(s, finishBackoff(s, itemId)))
{
  if inv(s) && canFinishBackoff(s,itemId) {
    var t := finishBackoff(s,itemId);
    var selected :| selected in s.items && selected.id == itemId && selected.phase.ItemBackoff?;
    ProcessorSelection(s,selected);
    ProcessorIdentityMap(s,t);
    forall i | 0 <= i < |t.items|
      ensures t.items[i].attempts >= 0 && t.items[i].attempts <= t.items[i].maxAttempts && t.items[i].maxAttempts > 0 && t.items[i].retryCount >= 0 && t.items[i].retryCount <= t.items[i].attempts &&
        (t.items[i].phase.ItemRunning? ==> t.items[i].retryCount < t.items[i].attempts) &&
        (t.items[i].phase.ItemSucceeded? ==> t.items[i].attempts > 0)
    {
      assert s.items[i] in s.items;
      if s.items[i].id == itemId { assert s.items[i] == selected; }
    }
    ProcessorMapFacts(s,t);
    forall i | 0 <= i < |s.items| && (s.items[i].phase.ItemSucceeded? || s.items[i].phase.ItemFailed?)
      ensures t.items[i] == s.items[i]
    {
      assert s.items[i] in s.items;
      if s.items[i].id == itemId { assert s.items[i] == selected; }
    }
    ProcessorCompletedMap(s,t);
    ProcessorRunning(s); ProcessorRunning(t);
    forall i | 0 <= i < |s.items| && t.items[i].phase.ItemRunning? ensures s.items[i].phase.ItemRunning? { }
    RunningNonincrease(s.items,t.items);
  }
}

lemma finishExhaustion_ensures(s: Processor, itemId: int, callbackOk: bool)
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysProcessorConcurrency(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysAttemptBudgets(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysProcessorConstruction(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysProcessorInvocationIds(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysRunningAttemptOwnsRetryHistory(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> alwaysSuccessHasAttempt(finishExhaustion(s, itemId, callbackOk)))
  ensures (inv(s) ==> canFinishExhaustion(s, itemId, callbackOk) ==> stepCompletedItemsAreStable(s, finishExhaustion(s, itemId, callbackOk)))
{
  if inv(s) && canFinishExhaustion(s,itemId,callbackOk) {
    var t := finishExhaustion(s,itemId,callbackOk);
    var selected :| selected in s.items && selected.id == itemId && selected.phase.ItemExhausting?;
    ProcessorSelection(s,selected);
    ProcessorIdentityMap(s,t);
    forall i | 0 <= i < |t.items|
      ensures t.items[i].attempts >= 0 && t.items[i].attempts <= t.items[i].maxAttempts && t.items[i].maxAttempts > 0 && t.items[i].retryCount >= 0 && t.items[i].retryCount <= t.items[i].attempts &&
        (t.items[i].phase.ItemRunning? ==> t.items[i].retryCount < t.items[i].attempts) &&
        (t.items[i].phase.ItemSucceeded? ==> t.items[i].attempts > 0)
    {
      assert s.items[i] in s.items;
      if s.items[i].id == itemId { assert s.items[i] == selected; }
    }
    ProcessorMapFacts(s,t);
    forall i | 0 <= i < |s.items| && (s.items[i].phase.ItemSucceeded? || s.items[i].phase.ItemFailed?)
      ensures t.items[i] == s.items[i]
    {
      assert s.items[i] in s.items;
      if s.items[i].id == itemId { assert s.items[i] == selected; }
    }
    ProcessorCompletedMap(s,t);
    ProcessorRunning(s); ProcessorRunning(t);
    forall i | 0 <= i < |s.items| && t.items[i].phase.ItemRunning? ensures s.items[i].phase.ItemRunning? { }
    RunningNonincrease(s.items,t.items);
  }
}
