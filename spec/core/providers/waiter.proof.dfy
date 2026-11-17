lemma WaiterFilters(s: ProviderWaiters, waiter: int)
  ensures waiterAt(s, waiter) == (if ((0 <= 0) && (0 < |ProofLib.Filter((w: ProviderWaiter) => (w.id == waiter), s.waiters)|)) then ProofLib.Filter((w: ProviderWaiter) => (w.id == waiter), s.waiters)[0] else absentWaiter)
  ensures alwaysWaiterIdentitiesUnique(s) == !((exists w :: w in s.waiters && !(((w.id > 0) && (|ProofLib.Filter((other: ProviderWaiter) => (other.id == w.id), s.waiters)| == 1)))))
{
}

lemma WaiterAtFound(s: ProviderWaiters, waiter: int)
  requires waiterAt(s, waiter).id != 0
  ensures waiterAt(s, waiter) in s.waiters && waiterAt(s, waiter).id == waiter
{
  WaiterFilters(s, waiter);
  ProofLib.FilterMember((w: ProviderWaiter) => (w.id == waiter), s.waiters, waiterAt(s, waiter));
}

lemma WaiterAtMissing(s: ProviderWaiters, waiter: int)
  requires waiterAt(s, waiter).id == 0 && waiter != 0
  ensures forall w :: w in s.waiters ==> w.id != waiter
{
  WaiterFilters(s, waiter);
  ProofLib.FilterNone((w: ProviderWaiter) => (w.id == waiter), s.waiters);
  if |ProofLib.Filter((w: ProviderWaiter) => (w.id == waiter), s.waiters)| > 0 {
    ProofLib.FilterMember((w: ProviderWaiter) => (w.id == waiter), s.waiters, waiterAt(s, waiter));
  }
}

lemma WaiterAtUnique(s: ProviderWaiters, waiter: int, w: ProviderWaiter)
  requires !((exists w :: w in s.waiters && !(((w.id > 0) && (|ProofLib.Filter((other: ProviderWaiter) => (other.id == w.id), s.waiters)| == 1)))))
  requires w in s.waiters && w.id == waiter
  ensures waiterAt(s, waiter) == w
{
  WaiterFilters(s, waiter);
  ProofLib.FilterSamePredicate((other: ProviderWaiter) => (other.id == w.id), (w: ProviderWaiter) => (w.id == waiter), s.waiters);
  ProofLib.FilterMember((w: ProviderWaiter) => (w.id == waiter), s.waiters, w);
  assert ProofLib.Filter((w: ProviderWaiter) => (w.id == waiter), s.waiters)[0] in ProofLib.Filter((w: ProviderWaiter) => (w.id == waiter), s.waiters);
}

lemma SameWaiterIds(xs: seq<ProviderWaiter>, ys: seq<ProviderWaiter>)
  requires |xs| == |ys| && forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  requires !((exists w :: w in xs && !(((w.id > 0) && (|ProofLib.Filter((other: ProviderWaiter) => (other.id == w.id), xs)| == 1)))))
  ensures !((exists w :: w in ys && !(((w.id > 0) && (|ProofLib.Filter((other: ProviderWaiter) => (other.id == w.id), ys)| == 1)))))
{
  forall w | w in ys
    ensures w.id > 0 && |ProofLib.Filter((other: ProviderWaiter) => (other.id == w.id), ys)| == 1
  {
    var k :| 0 <= k < |ys| && ys[k] == w;
    var b := xs[k];
    assert b in xs;
    ProofLib.FilterLengthPointwise((other: ProviderWaiter) => (other.id == b.id), (other: ProviderWaiter) => (other.id == w.id), xs, ys);
  }
}

lemma ReplaceKeeps(s: ProviderWaiters, waiter: int, updated: ProviderWaiter)
  requires alwaysWaiterIdentitiesUnique(s)
  requires waiterAt(s, waiter).id != 0 && updated.id == waiter
  ensures waiterAt(s, waiter) in s.waiters && waiterAt(s, waiter).id == waiter
  ensures alwaysWaiterIdentitiesUnique(replaceWaiter(updated, s))
  ensures forall w :: w in replaceWaiter(updated, s).waiters ==> w == updated || (w in s.waiters && w.id != waiter)
  ensures forall w :: w in s.waiters ==> w.id == waiter ==> w == waiterAt(s, waiter)
  ensures forall w :: w in s.waiters ==> waiterAt(replaceWaiter(updated, s), w.id) == (if w.id == waiter then updated else w)
{
  WaiterAtFound(s, waiter);
  var after := replaceWaiter(updated, s);
  WaiterFilters(s, waiter);
  WaiterFilters(after, waiter);
  SameWaiterIds(s.waiters, after.waiters);
  forall w | w in after.waiters
    ensures w == updated || (w in s.waiters && w.id != waiter)
  {
    var k :| 0 <= k < |after.waiters| && after.waiters[k] == w;
    assert s.waiters[k] in s.waiters;
  }
  forall w | w in s.waiters && w.id == waiter
    ensures w == waiterAt(s, waiter)
  {
    WaiterAtUnique(s, waiter, w);
  }
  forall w | w in s.waiters
    ensures waiterAt(after, w.id) == (if w.id == waiter then updated else w)
  {
    var k :| 0 <= k < |s.waiters| && s.waiters[k] == w;
    assert after.waiters[k] in after.waiters;
    WaiterAtUnique(after, w.id, after.waiters[k]);
  }
}

lemma SameWaitersFixed(s: ProviderWaiters, after: ProviderWaiters)
  requires alwaysWaiterIdentitiesUnique(s) && after.waiters == s.waiters
  ensures stepReleasedAnswerStaysFixed(s, after) && stepSharedSelectionStaysFixed(s, after)
{
  WaiterFilters(s, 0);
  forall w | w in s.waiters
    ensures waiterAt(after, w.id) == w
  {
    WaiterAtUnique(s, w.id, w);
    assert waiterAt(after, w.id) == waiterAt(s, w.id);
  }
}

lemma attachWaiter_ensures(s: ProviderWaiters, waiter: int, signal: WaiterSignal, reason: string, fallback: string)
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> alwaysWaiterIdentitiesUnique(attachWaiter(s, waiter, signal, reason, fallback)))
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> alwaysWaitersFollowCreatedRace(attachWaiter(s, waiter, signal, reason, fallback)))
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> alwaysListenerBelongsToWaitingSignal(attachWaiter(s, waiter, signal, reason, fallback)))
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> alwaysRaceKeepsItsRules(attachWaiter(s, waiter, signal, reason, fallback)))
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> alwaysSharedAnswerMatchesSelection(attachWaiter(s, waiter, signal, reason, fallback)))
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> alwaysObservedSharedCallbackHasSelection(attachWaiter(s, waiter, signal, reason, fallback)))
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> alwaysSelectionIsThePublishedOutcome(attachWaiter(s, waiter, signal, reason, fallback)))
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> stepReleasedAnswerStaysFixed(s, attachWaiter(s, waiter, signal, reason, fallback)))
  ensures (inv(s) ==> canAttachWaiter(s, waiter, fallback) ==> stepSharedSelectionStaysFixed(s, attachWaiter(s, waiter, signal, reason, fallback)))
{
  if inv(s) && canAttachWaiter(s, waiter, fallback) {
    var after := attachWaiter(s, waiter, signal, reason, fallback);
    var added := after.waiters[|s.waiters|];
    WaiterAtMissing(s, waiter);
    WaiterFilters(s, waiter);
    WaiterFilters(after, waiter);
    assert after.waiters == s.waiters + [added];
    forall w | w in after.waiters
      ensures w.id > 0 && |ProofLib.Filter((other: ProviderWaiter) => (other.id == w.id), after.waiters)| == 1
    {
      ProofLib.FilterAppend((other: ProviderWaiter) => (other.id == w.id), s.waiters, added);
      if w == added {
        ProofLib.FilterNone((other: ProviderWaiter) => (other.id == w.id), s.waiters);
      }
    }
    forall w | w in s.waiters
      ensures waiterAt(after, w.id) == w
    {
      WaiterAtUnique(after, w.id, w);
    }
  }
}

lemma abortWaiter_ensures(s: ProviderWaiters, waiter: int, reason: string, fallback: string)
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> alwaysWaiterIdentitiesUnique(abortWaiter(s, waiter, reason, fallback)))
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> alwaysWaitersFollowCreatedRace(abortWaiter(s, waiter, reason, fallback)))
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> alwaysListenerBelongsToWaitingSignal(abortWaiter(s, waiter, reason, fallback)))
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> alwaysRaceKeepsItsRules(abortWaiter(s, waiter, reason, fallback)))
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> alwaysSharedAnswerMatchesSelection(abortWaiter(s, waiter, reason, fallback)))
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> alwaysObservedSharedCallbackHasSelection(abortWaiter(s, waiter, reason, fallback)))
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> alwaysSelectionIsThePublishedOutcome(abortWaiter(s, waiter, reason, fallback)))
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> stepReleasedAnswerStaysFixed(s, abortWaiter(s, waiter, reason, fallback)))
  ensures (inv(s) ==> canAbortWaiter(s, waiter, fallback) ==> stepSharedSelectionStaysFixed(s, abortWaiter(s, waiter, reason, fallback)))
{
  if inv(s) && canAbortWaiter(s, waiter, fallback) {
    ReplaceKeeps(s, waiter, waiterAt(s, waiter).(listening := false, answer := abortedValue(reason, fallback)));
  }
}

lemma abortExecution_ensures(s: ProviderWaiters, reason: string, fallbackRef: string)
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> alwaysWaiterIdentitiesUnique(abortExecution(s, reason, fallbackRef)))
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> alwaysWaitersFollowCreatedRace(abortExecution(s, reason, fallbackRef)))
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> alwaysListenerBelongsToWaitingSignal(abortExecution(s, reason, fallbackRef)))
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> alwaysRaceKeepsItsRules(abortExecution(s, reason, fallbackRef)))
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> alwaysSharedAnswerMatchesSelection(abortExecution(s, reason, fallbackRef)))
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> alwaysObservedSharedCallbackHasSelection(abortExecution(s, reason, fallbackRef)))
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> alwaysSelectionIsThePublishedOutcome(abortExecution(s, reason, fallbackRef)))
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> stepReleasedAnswerStaysFixed(s, abortExecution(s, reason, fallbackRef)))
  ensures (inv(s) ==> canAbortExecution(s, fallbackRef) ==> stepSharedSelectionStaysFixed(s, abortExecution(s, reason, fallbackRef)))
{
  if inv(s) && canAbortExecution(s, fallbackRef) {
    SameWaitersFixed(s, abortExecution(s, reason, fallbackRef));
  }
}

lemma enterInvocation_ensures(s: ProviderWaiters, fallbackRef: string)
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> alwaysWaiterIdentitiesUnique(enterInvocation(s, fallbackRef)))
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> alwaysWaitersFollowCreatedRace(enterInvocation(s, fallbackRef)))
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> alwaysListenerBelongsToWaitingSignal(enterInvocation(s, fallbackRef)))
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> alwaysRaceKeepsItsRules(enterInvocation(s, fallbackRef)))
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> alwaysSharedAnswerMatchesSelection(enterInvocation(s, fallbackRef)))
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> alwaysObservedSharedCallbackHasSelection(enterInvocation(s, fallbackRef)))
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> alwaysSelectionIsThePublishedOutcome(enterInvocation(s, fallbackRef)))
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> stepReleasedAnswerStaysFixed(s, enterInvocation(s, fallbackRef)))
  ensures (inv(s) ==> canEnterInvocation(s, fallbackRef) ==> stepSharedSelectionStaysFixed(s, enterInvocation(s, fallbackRef)))
{
  if inv(s) && canEnterInvocation(s, fallbackRef) {
    SameWaitersFixed(s, enterInvocation(s, fallbackRef));
  }
}

lemma settleNative_ensures(s: ProviderWaiters, result: core__providers__race_PromiseValue)
  ensures (inv(s) ==> canSettleNative(s) ==> alwaysWaiterIdentitiesUnique(settleNative(s, result)))
  ensures (inv(s) ==> canSettleNative(s) ==> alwaysWaitersFollowCreatedRace(settleNative(s, result)))
  ensures (inv(s) ==> canSettleNative(s) ==> alwaysListenerBelongsToWaitingSignal(settleNative(s, result)))
  ensures (inv(s) ==> canSettleNative(s) ==> alwaysRaceKeepsItsRules(settleNative(s, result)))
  ensures (inv(s) ==> canSettleNative(s) ==> alwaysSharedAnswerMatchesSelection(settleNative(s, result)))
  ensures (inv(s) ==> canSettleNative(s) ==> alwaysObservedSharedCallbackHasSelection(settleNative(s, result)))
  ensures (inv(s) ==> canSettleNative(s) ==> alwaysSelectionIsThePublishedOutcome(settleNative(s, result)))
  ensures (inv(s) ==> canSettleNative(s) ==> stepReleasedAnswerStaysFixed(s, settleNative(s, result)))
  ensures (inv(s) ==> canSettleNative(s) ==> stepSharedSelectionStaysFixed(s, settleNative(s, result)))
{
  if inv(s) && canSettleNative(s) {
    SameWaitersFixed(s, settleNative(s, result));
  }
}

lemma chooseNative_ensures(s: ProviderWaiters)
  ensures (inv(s) ==> canChooseNative(s) ==> alwaysWaiterIdentitiesUnique(chooseNative(s)))
  ensures (inv(s) ==> canChooseNative(s) ==> alwaysWaitersFollowCreatedRace(chooseNative(s)))
  ensures (inv(s) ==> canChooseNative(s) ==> alwaysListenerBelongsToWaitingSignal(chooseNative(s)))
  ensures (inv(s) ==> canChooseNative(s) ==> alwaysRaceKeepsItsRules(chooseNative(s)))
  ensures (inv(s) ==> canChooseNative(s) ==> alwaysSharedAnswerMatchesSelection(chooseNative(s)))
  ensures (inv(s) ==> canChooseNative(s) ==> alwaysObservedSharedCallbackHasSelection(chooseNative(s)))
  ensures (inv(s) ==> canChooseNative(s) ==> alwaysSelectionIsThePublishedOutcome(chooseNative(s)))
  ensures (inv(s) ==> canChooseNative(s) ==> stepReleasedAnswerStaysFixed(s, chooseNative(s)))
  ensures (inv(s) ==> canChooseNative(s) ==> stepSharedSelectionStaysFixed(s, chooseNative(s)))
{
  if inv(s) && canChooseNative(s) {
    SameWaitersFixed(s, chooseNative(s));
  }
}

lemma chooseAbort_ensures(s: ProviderWaiters)
  ensures (inv(s) ==> canChooseAbort(s) ==> alwaysWaiterIdentitiesUnique(chooseAbort(s)))
  ensures (inv(s) ==> canChooseAbort(s) ==> alwaysWaitersFollowCreatedRace(chooseAbort(s)))
  ensures (inv(s) ==> canChooseAbort(s) ==> alwaysListenerBelongsToWaitingSignal(chooseAbort(s)))
  ensures (inv(s) ==> canChooseAbort(s) ==> alwaysRaceKeepsItsRules(chooseAbort(s)))
  ensures (inv(s) ==> canChooseAbort(s) ==> alwaysSharedAnswerMatchesSelection(chooseAbort(s)))
  ensures (inv(s) ==> canChooseAbort(s) ==> alwaysObservedSharedCallbackHasSelection(chooseAbort(s)))
  ensures (inv(s) ==> canChooseAbort(s) ==> alwaysSelectionIsThePublishedOutcome(chooseAbort(s)))
  ensures (inv(s) ==> canChooseAbort(s) ==> stepReleasedAnswerStaysFixed(s, chooseAbort(s)))
  ensures (inv(s) ==> canChooseAbort(s) ==> stepSharedSelectionStaysFixed(s, chooseAbort(s)))
{
  if inv(s) && canChooseAbort(s) {
    SameWaitersFixed(s, chooseAbort(s));
  }
}

lemma publishShared_ensures(s: ProviderWaiters)
  ensures (inv(s) ==> canPublishShared(s) ==> alwaysWaiterIdentitiesUnique(publishShared(s)))
  ensures (inv(s) ==> canPublishShared(s) ==> alwaysWaitersFollowCreatedRace(publishShared(s)))
  ensures (inv(s) ==> canPublishShared(s) ==> alwaysListenerBelongsToWaitingSignal(publishShared(s)))
  ensures (inv(s) ==> canPublishShared(s) ==> alwaysRaceKeepsItsRules(publishShared(s)))
  ensures (inv(s) ==> canPublishShared(s) ==> alwaysSharedAnswerMatchesSelection(publishShared(s)))
  ensures (inv(s) ==> canPublishShared(s) ==> alwaysObservedSharedCallbackHasSelection(publishShared(s)))
  ensures (inv(s) ==> canPublishShared(s) ==> alwaysSelectionIsThePublishedOutcome(publishShared(s)))
  ensures (inv(s) ==> canPublishShared(s) ==> stepReleasedAnswerStaysFixed(s, publishShared(s)))
  ensures (inv(s) ==> canPublishShared(s) ==> stepSharedSelectionStaysFixed(s, publishShared(s)))
{
  if inv(s) && canPublishShared(s) {
    SameWaitersFixed(s, publishShared(s));
  }
}

lemma queueSharedCallback_ensures(s: ProviderWaiters, waiter: int)
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> alwaysWaiterIdentitiesUnique(queueSharedCallback(s, waiter)))
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> alwaysWaitersFollowCreatedRace(queueSharedCallback(s, waiter)))
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> alwaysListenerBelongsToWaitingSignal(queueSharedCallback(s, waiter)))
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> alwaysRaceKeepsItsRules(queueSharedCallback(s, waiter)))
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> alwaysSharedAnswerMatchesSelection(queueSharedCallback(s, waiter)))
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> alwaysObservedSharedCallbackHasSelection(queueSharedCallback(s, waiter)))
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> alwaysSelectionIsThePublishedOutcome(queueSharedCallback(s, waiter)))
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> stepReleasedAnswerStaysFixed(s, queueSharedCallback(s, waiter)))
  ensures (inv(s) ==> canQueueSharedCallback(s, waiter) ==> stepSharedSelectionStaysFixed(s, queueSharedCallback(s, waiter)))
{
  if inv(s) && canQueueSharedCallback(s, waiter) {
    ReplaceKeeps(s, waiter, waiterAt(s, waiter).(selected := publishedSelection(s)));
  }
}

lemma runSharedCallback_ensures(s: ProviderWaiters, waiter: int)
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> alwaysWaiterIdentitiesUnique(runSharedCallback(s, waiter)))
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> alwaysWaitersFollowCreatedRace(runSharedCallback(s, waiter)))
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> alwaysListenerBelongsToWaitingSignal(runSharedCallback(s, waiter)))
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> alwaysRaceKeepsItsRules(runSharedCallback(s, waiter)))
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> alwaysSharedAnswerMatchesSelection(runSharedCallback(s, waiter)))
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> alwaysObservedSharedCallbackHasSelection(runSharedCallback(s, waiter)))
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> alwaysSelectionIsThePublishedOutcome(runSharedCallback(s, waiter)))
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> stepReleasedAnswerStaysFixed(s, runSharedCallback(s, waiter)))
  ensures (inv(s) ==> canRunSharedCallback(s, waiter) ==> stepSharedSelectionStaysFixed(s, runSharedCallback(s, waiter)))
{
  if inv(s) && canRunSharedCallback(s, waiter) {
    var w := waiterAt(s, waiter);
    ReplaceKeeps(s, waiter, w.(callbackRan := true, listening := false, answer := (if awaitingAnswer(w.answer) then sharedAnswer(w.selected) else w.answer)));
  }
}
