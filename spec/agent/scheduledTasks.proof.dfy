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

lemma fire_ensures(t: ScheduledTask, seenRevision: int)
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysReceiptAndLogCommitTogether(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysEachOccurrenceFiresOnce(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysEachKeyAppliesOnce(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysCompletionSettlesOncePerOccurrence(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysSettledPendingOccurrenceNeverFires(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysOccurrencesTrailTheRow(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysPauseWindowWellFormed(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysRetiredWorkerHasNoWriteInFlight(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> alwaysCleanUnloadLeavesNoBootRow(fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> stepFireUsesTheCurrentOwner(t, "fire", fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> stepDismissedTaskNeverChanges(t, fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> stepPauseDecidesFiring(t, "fire", fire(t, seenRevision)))
  ensures (inv(t) ==> canFire(t, seenRevision) ==> stepOnlyAnActiveWorkerFires(t, "fire", fire(t, seenRevision)))
{
  if inv(t) && canFire(t, seenRevision) && !heldByPause(t) {
    RisingAppend(t.dispatched, t.occurrence);
  }
}

lemma applyVerb_ensures(t: ScheduledTask, seenRevision: int, key: string, verb: OwnerVerb)
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysReceiptAndLogCommitTogether(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysEachOccurrenceFiresOnce(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysEachKeyAppliesOnce(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysCompletionSettlesOncePerOccurrence(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysSettledPendingOccurrenceNeverFires(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysOccurrencesTrailTheRow(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysPauseWindowWellFormed(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysRetiredWorkerHasNoWriteInFlight(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> alwaysCleanUnloadLeavesNoBootRow(applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> stepFireUsesTheCurrentOwner(t, "applyVerb", applyVerb(t, seenRevision, key, verb)))
  ensures (inv(t) ==> canApplyVerb(t, seenRevision, key, verb) ==> stepDismissedTaskNeverChanges(t, applyVerb(t, seenRevision, key, verb)))
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
