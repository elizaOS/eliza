// spec/assistant.md, "A payment is submitted exactly when the bill is charged, for its amount, on the biller's own page":
// what a transition outputs is empty or one effect, and the count of a list of one is whether it is a submission.

lemma SubmissionsOfOne(x: Effect)
  ensures submissions([x]) == (if x.Submitted? then 1 else 0)
{
  ProofLib.FoldLeftAppend((n: int, e: Effect) => (if e.Submitted? then (n + 1) else n), 0, [], x);
  assert [] + [x] == [x];
}

// spec/assistant.md, "Queued effects are actions the assistant may promise"
lemma SubmissionsConcat(xs: seq<Effect>, ys: seq<Effect>)
  ensures submissions(xs + ys) == submissions(xs) + submissions(ys)
  decreases |ys|
{
  if |ys| > 0 {
    var prefix := ys[..|ys| - 1];
    var last := ys[|ys| - 1];
    assert ys == prefix + [last];
    assert xs + ys == (xs + prefix) + [last];
    SubmissionsConcat(xs, prefix);
    ProofLib.FoldLeftAppend((n: int, e: Effect) => (if e.Submitted? then (n + 1) else n), 0, xs + prefix, last);
    ProofLib.FoldLeftAppend((n: int, e: Effect) => (if e.Submitted? then (n + 1) else n), 0, prefix, last);
    assert submissions(xs + ys) == (if last.Submitted? then submissions(xs + prefix) + 1 else submissions(xs + prefix));
    assert submissions(ys) == (if last.Submitted? then submissions(prefix) + 1 else submissions(prefix));
  } else {
    assert ys == [];
    assert submissions(ys) == 0;
    assert xs + ys == xs;
  }
}

lemma SubmissionsTail(xs: seq<Effect>)
  requires |xs| > 0
  ensures submissions(xs[1..]) <= submissions(xs)
{
  assert xs == [xs[0]] + xs[1..];
  SubmissionsConcat([xs[0]], xs[1..]);
  SubmissionsOfOne(xs[0]);
}

lemma choose_ensures(s: Assistant, choice: Choice, by_: Actor)
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysBudgetBounded(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysPaidOnlyReviewed(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysReviewedHasPositiveAmount(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysChargedOnce(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysDeliveryCountIsNotNegative(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysQueuedEffectsValid(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepChoicesSpendBudget(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepReplyAnswersWaiting(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepAmountOnlyFromReply(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepPaidOnlyOnGenuine(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepChargedOnlyOnConfirm(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepSubmittedWhenCharged(s, choose(s, choice, by_).state, choose(s, choice, by_).out))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepCardOnlySaved(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepFilledOnlyGenuine(s, "choose", choose(s, choice, by_).state, choose(s, choice, by_).out))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepRequestNeverGoesBack(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepEffectsStayQueued(s, "choose", choose(s, choice, by_).state, choose(s, choice, by_).out))
{
  SubmissionsOfOne(Filled(s.page, s.card));
  SubmissionsOfOne(Said("paid"));
  SubmissionsOfOne(Said("working"));
  SubmissionsConcat(s.pending, choose(s, choice, by_).out);
}

lemma confirm_ensures(s: Assistant, by_: Actor)
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysBudgetBounded(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysPaidOnlyReviewed(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysReviewedHasPositiveAmount(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysChargedOnce(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysDeliveryCountIsNotNegative(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysQueuedEffectsValid(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepChoicesSpendBudget(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepReplyAnswersWaiting(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepAmountOnlyFromReply(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepPaidOnlyOnGenuine(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepChargedOnlyOnConfirm(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepSubmittedWhenCharged(s, confirm(s, by_).state, confirm(s, by_).out))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepCardOnlySaved(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepFilledOnlyGenuine(s, "confirm", confirm(s, by_).state, confirm(s, by_).out))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepRequestNeverGoesBack(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepEffectsStayQueued(s, "confirm", confirm(s, by_).state, confirm(s, by_).out))
{
  SubmissionsOfOne(Submitted(s.page, s.bill.amount));
  SubmissionsConcat(s.pending, confirm(s, by_).out);
}

lemma acknowledge_ensures(s: Assistant, delivery: int, by_: Actor)
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> alwaysBudgetBounded(acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> alwaysPaidOnlyReviewed(acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> alwaysReviewedHasPositiveAmount(acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> alwaysChargedOnce(acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> alwaysDeliveryCountIsNotNegative(acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> alwaysQueuedEffectsValid(acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepChoicesSpendBudget(s, "acknowledge", acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepReplyAnswersWaiting(s, "acknowledge", acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepAmountOnlyFromReply(s, "acknowledge", acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepPaidOnlyOnGenuine(s, "acknowledge", acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepChargedOnlyOnConfirm(s, "acknowledge", acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepSubmittedWhenCharged(s, acknowledge(s, delivery, by_), []))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepCardOnlySaved(s, "acknowledge", acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepFilledOnlyGenuine(s, "acknowledge", acknowledge(s, delivery, by_), []))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepRequestNeverGoesBack(s, "acknowledge", acknowledge(s, delivery, by_)))
  ensures (inv(s) ==> canAcknowledge(s, delivery, by_) ==> stepEffectsStayQueued(s, "acknowledge", acknowledge(s, delivery, by_), []))
{
  if inv(s) && canAcknowledge(s, delivery, by_) {
    SubmissionsTail(s.pending);
    var after := acknowledge(s, delivery, by_);
    assert after.pending == s.pending[1..];
    assert forall e :: e in after.pending ==> e in s.pending;
    assert submissions(after.pending) <= after.charged;
    assert alwaysQueuedEffectsValid(after);
  }
}
