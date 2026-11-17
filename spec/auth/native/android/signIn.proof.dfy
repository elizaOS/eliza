lemma verifyCode_ensures(c: SignIn, attempt: int, target: VerifyTarget)
  ensures (inv(c) ==> alwaysWaiterHasReadyAttempt(verifyCode(c, attempt, target)))
  ensures (inv(c) ==> alwaysWorkOwnsItsCall(verifyCode(c, attempt, target)))
  ensures (inv(c) ==> alwaysAtMostOneReply(verifyCode(c, attempt, target)))
  ensures (inv(c) ==> alwaysPendingHasOneOwner(verifyCode(c, attempt, target)))
  ensures (inv(c) ==> alwaysIdsCountFromOne(verifyCode(c, attempt, target)))
  ensures (inv(c) ==> alwaysAttemptBudget(verifyCode(c, attempt, target)))
  ensures (inv(c) ==> alwaysGrantOnlyForCurrentAttempt(verifyCode(c, attempt, target)))
{
  if inv(c) {
    NoReply(c, c.issued + 1);
  }
}

lemma cancelAttempt_ensures(c: SignIn, attempt: int)
  ensures (inv(c) ==> alwaysWaiterHasReadyAttempt(cancelAttempt(c, attempt)))
  ensures (inv(c) ==> alwaysWorkOwnsItsCall(cancelAttempt(c, attempt)))
  ensures (inv(c) ==> alwaysAtMostOneReply(cancelAttempt(c, attempt)))
  ensures (inv(c) ==> alwaysPendingHasOneOwner(cancelAttempt(c, attempt)))
  ensures (inv(c) ==> alwaysIdsCountFromOne(cancelAttempt(c, attempt)))
  ensures (inv(c) ==> alwaysAttemptBudget(cancelAttempt(c, attempt)))
  ensures (inv(c) ==> alwaysGrantOnlyForCurrentAttempt(cancelAttempt(c, attempt)))
{
  if inv(c) && !(c.channel.NoChannel? || ((attempt != 0) && (attempt != c.generation))) && c.waiter != 0 {
    Reply(c, cancelAttempt(c, attempt), c.waiter);
  }
}

lemma wrongCode_ensures(c: SignIn)
  ensures (inv(c) ==> canWrongCode(c) ==> alwaysWaiterHasReadyAttempt(wrongCode(c)))
  ensures (inv(c) ==> canWrongCode(c) ==> alwaysWorkOwnsItsCall(wrongCode(c)))
  ensures (inv(c) ==> canWrongCode(c) ==> alwaysAtMostOneReply(wrongCode(c)))
  ensures (inv(c) ==> canWrongCode(c) ==> alwaysPendingHasOneOwner(wrongCode(c)))
  ensures (inv(c) ==> canWrongCode(c) ==> alwaysIdsCountFromOne(wrongCode(c)))
  ensures (inv(c) ==> canWrongCode(c) ==> alwaysAttemptBudget(wrongCode(c)))
  ensures (inv(c) ==> canWrongCode(c) ==> alwaysGrantOnlyForCurrentAttempt(wrongCode(c)))
{
  if inv(c) && canWrongCode(c) && c.failed == 4 {
    Reply(c, wrongCode(c), c.waiter);
  }
}

lemma deliverRetryReply_ensures(c: SignIn)
  ensures (inv(c) ==> canDeliverRetryReply(c) ==> alwaysWaiterHasReadyAttempt(deliverRetryReply(c)))
  ensures (inv(c) ==> canDeliverRetryReply(c) ==> alwaysWorkOwnsItsCall(deliverRetryReply(c)))
  ensures (inv(c) ==> canDeliverRetryReply(c) ==> alwaysAtMostOneReply(deliverRetryReply(c)))
  ensures (inv(c) ==> canDeliverRetryReply(c) ==> alwaysPendingHasOneOwner(deliverRetryReply(c)))
  ensures (inv(c) ==> canDeliverRetryReply(c) ==> alwaysIdsCountFromOne(deliverRetryReply(c)))
  ensures (inv(c) ==> canDeliverRetryReply(c) ==> alwaysAttemptBudget(deliverRetryReply(c)))
  ensures (inv(c) ==> canDeliverRetryReply(c) ==> alwaysGrantOnlyForCurrentAttempt(deliverRetryReply(c)))
{
  if inv(c) && canDeliverRetryReply(c) {
    Reply(c, deliverRetryReply(c), c.work.rpc);
  }
}

lemma finishTerminal_ensures(c: SignIn)
  ensures (inv(c) ==> canFinishTerminal(c) ==> alwaysWaiterHasReadyAttempt(finishTerminal(c)))
  ensures (inv(c) ==> canFinishTerminal(c) ==> alwaysWorkOwnsItsCall(finishTerminal(c)))
  ensures (inv(c) ==> canFinishTerminal(c) ==> alwaysAtMostOneReply(finishTerminal(c)))
  ensures (inv(c) ==> canFinishTerminal(c) ==> alwaysPendingHasOneOwner(finishTerminal(c)))
  ensures (inv(c) ==> canFinishTerminal(c) ==> alwaysIdsCountFromOne(finishTerminal(c)))
  ensures (inv(c) ==> canFinishTerminal(c) ==> alwaysAttemptBudget(finishTerminal(c)))
  ensures (inv(c) ==> canFinishTerminal(c) ==> alwaysGrantOnlyForCurrentAttempt(finishTerminal(c)))
{
  if inv(c) && canFinishTerminal(c) && ownsWork(c) {
    Reply(c, finishTerminal(c), c.waiter);
  }
}

lemma requireFactor_ensures(c: SignIn, factor: Factor)
  ensures (inv(c) ==> canRequireFactor(c, factor) ==> alwaysWaiterHasReadyAttempt(requireFactor(c, factor)))
  ensures (inv(c) ==> canRequireFactor(c, factor) ==> alwaysWorkOwnsItsCall(requireFactor(c, factor)))
  ensures (inv(c) ==> canRequireFactor(c, factor) ==> alwaysAtMostOneReply(requireFactor(c, factor)))
  ensures (inv(c) ==> canRequireFactor(c, factor) ==> alwaysPendingHasOneOwner(requireFactor(c, factor)))
  ensures (inv(c) ==> canRequireFactor(c, factor) ==> alwaysIdsCountFromOne(requireFactor(c, factor)))
  ensures (inv(c) ==> canRequireFactor(c, factor) ==> alwaysAttemptBudget(requireFactor(c, factor)))
  ensures (inv(c) ==> canRequireFactor(c, factor) ==> alwaysGrantOnlyForCurrentAttempt(requireFactor(c, factor)))
{
  if inv(c) && canRequireFactor(c, factor) {
    Reply(c, requireFactor(c, factor), c.waiter);
  }
}

lemma RepliesBridge(c: SignIn, rpc: int)
  ensures repliesTo(c, rpc) == |ProofLib.Filter((r: int) => (r == rpc), c.replied)|
{
}

lemma NoReply(c: SignIn, x: int)
  requires alwaysAtMostOneReply(c) && x > c.issued
  ensures repliesTo(c, x) == 0
{
  RepliesBridge(c, x);
  forall i | 0 <= i < |c.replied| ensures c.replied[i] != x {
    assert c.replied[i] in c.replied;
  }
  ProofLib.FilterNone((r: int) => (r == x), c.replied);
}

lemma Reply(c: SignIn, d: SignIn, x: int)
  requires alwaysAtMostOneReply(c) && d.replied == c.replied + [x] && d.issued == c.issued
  requires 1 <= x <= c.issued && repliesTo(c, x) == 0
  ensures alwaysAtMostOneReply(d) && repliesTo(d, x) == 1
  ensures forall y :: y != x ==> repliesTo(d, y) == repliesTo(c, y)
{
  forall y ensures repliesTo(d, y) == repliesTo(c, y) + (if y == x then 1 else 0) {
    RepliesBridge(c, y);
    RepliesBridge(d, y);
    ProofLib.FilterAppend((r: int) => (r == y), c.replied, x);
  }
}
