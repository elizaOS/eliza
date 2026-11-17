lemma RisingLast(xs: seq<int>)
  ensures Std.Collections.Seq.FoldLeft((acc: Rising, x: int) => Rising(x, (acc.rising && (x > acc.last))), Rising(0, true), xs).last == (if |xs| == 0 then 0 else xs[|xs| - 1])
{
  if |xs| > 0 {
    assert xs == xs[..|xs| - 1] + [xs[|xs| - 1]];
    ProofLib.FoldLeftAppend((acc: Rising, x: int) => Rising(x, (acc.rising && (x > acc.last))), Rising(0, true), xs[..|xs| - 1], xs[|xs| - 1]);
  }
}

lemma RisingAppend(xs: seq<int>, x: int)
  requires strictlyRising(xs)
  requires x > 0 && forall o :: o in xs ==> o < x
  ensures strictlyRising(xs + [x])
{
  RisingLast(xs);
  ProofLib.FoldLeftAppend((acc: Rising, x: int) => Rising(x, (acc.rising && (x > acc.last))), Rising(0, true), xs, x);
  if |xs| > 0 {
    assert xs[|xs| - 1] in xs;
  }
}

lemma KeysFilter(t: ScheduledTask)
  ensures alwaysEachKeyAppliesOnce(t) == !((exists k :: k in t.receipts && !((|ProofLib.Filter((x: string) => (x == k), t.receipts)| == 1))))
{
}

lemma KeyAppend(receipts: seq<string>, key: string)
  requires key !in receipts
  requires forall k :: k in receipts ==> |ProofLib.Filter((x: string) => (x == k), receipts)| == 1
  ensures forall k :: k in receipts + [key] ==> |ProofLib.Filter((x: string) => (x == k), receipts + [key])| == 1
{
  forall k | k in receipts + [key]
    ensures |ProofLib.Filter((x: string) => (x == k), receipts + [key])| == 1
  {
    ProofLib.FilterAppend((x: string) => (x == k), receipts, key);
    if k == key {
      ProofLib.FilterNone((x: string) => (x == k), receipts);
    }
  }
}

lemma fire_ensures(t: ScheduledTask, seenRevision: int, manual: bool)
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysReceiptAndLogCommitTogether(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysEachOccurrenceFiresOnce(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysEachKeyAppliesOnce(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysCompletionSettlesOncePerOccurrence(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysSettledPendingOccurrenceNeverFires(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysOccurrencesTrailTheRow(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysAcknowledgedRowHasFired(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysPauseWindowWellFormed(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysRetiredWorkerHasNoWriteInFlight(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> alwaysCleanUnloadLeavesNoBootRow(fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> stepFireUsesTheCurrentOwner(t, "fire", fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> stepDismissedTaskNeverChanges(t, fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> stepOwnerAnswersDoWhatTheySay(t, "fire", fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> stepPauseDecidesFiring(t, "fire", fire(t, seenRevision, manual)))
  ensures (inv(t) ==> canFire(t, seenRevision, manual) ==> stepOnlyAnActiveWorkerFires(t, "fire", fire(t, seenRevision, manual)))
{
  if inv(t) && canFire(t, seenRevision, manual) {
    if !heldByPause(t) {
      RisingAppend(t.dispatched, t.occurrence);
    }
  }
}

lemma applyVerb_ensures(t: ScheduledTask, seenRevision: int, key: string, verb: OwnerVerb)
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysReceiptAndLogCommitTogether(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysEachOccurrenceFiresOnce(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysEachKeyAppliesOnce(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysCompletionSettlesOncePerOccurrence(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysSettledPendingOccurrenceNeverFires(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysOccurrencesTrailTheRow(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysAcknowledgedRowHasFired(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysPauseWindowWellFormed(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysRetiredWorkerHasNoWriteInFlight(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysCleanUnloadLeavesNoBootRow(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> stepFireUsesTheCurrentOwner(t, "applyVerb", applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> stepDismissedTaskNeverChanges(t, applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> stepOwnerAnswersDoWhatTheySay(t, "applyVerb", applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> stepPauseDecidesFiring(t, "applyVerb", applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> stepOnlyAnActiveWorkerFires(t, "applyVerb", applyVerb(t, seenRevision, key, verb)))
{
  if inv(t) && canApplyVerb(t, seenRevision, key, verb) {
    KeysFilter(t);
    KeysFilter(applyVerb(t, seenRevision, key, verb));
    KeyAppend(t.receipts, key);
    if verb.CompleteVerb? {
      RisingAppend(t.completions, t.occurrence);
    }
  }
}

lemma answerTask_ensures(t: ScheduledTask, seenRevision: int, key: string, answer: TaskAnswer, until: int)
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysReceiptAndLogCommitTogether(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysEachOccurrenceFiresOnce(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysEachKeyAppliesOnce(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysCompletionSettlesOncePerOccurrence(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysSettledPendingOccurrenceNeverFires(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysOccurrencesTrailTheRow(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysAcknowledgedRowHasFired(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysPauseWindowWellFormed(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysRetiredWorkerHasNoWriteInFlight(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> alwaysCleanUnloadLeavesNoBootRow(answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> stepFireUsesTheCurrentOwner(t, "answerTask", answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> stepDismissedTaskNeverChanges(t, answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> stepOwnerAnswersDoWhatTheySay(t, "answerTask", answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> stepPauseDecidesFiring(t, "answerTask", answerTask(t, seenRevision, key, answer, until)))
  ensures (inv(t) ==> canAnswerTask(t, seenRevision, key, answer, until) ==> stepOnlyAnActiveWorkerFires(t, "answerTask", answerTask(t, seenRevision, key, answer, until)))
{
  if inv(t) && canAnswerTask(t, seenRevision, key, answer, until) {
    KeysFilter(t);
    KeysFilter(answerTask(t, seenRevision, key, answer, until));
    KeyAppend(t.receipts, key);
  }
}
