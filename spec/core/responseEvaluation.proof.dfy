lemma ResponseReceiptPrefix(prefix: seq<string>, full: seq<string>)
  requires |prefix| <= |full| && prefix == full[..|prefix|]
  ensures var compare := (at: ReceiptOrderCheck, value: string) => ReceiptOrderCheck(at.index + 1, at.matched && value == (if 0 <= at.index && at.index < |full| then full[at.index] else ""));
    Std.Collections.Seq.FoldLeft(compare, initialReceiptOrderCheck, prefix) == ReceiptOrderCheck(|prefix|, true)
  decreases |prefix|
{
  if |prefix| > 0 {
    var prior := prefix[..|prefix| - 1];
    var last := prefix[|prefix| - 1];
    var compare := (at: ReceiptOrderCheck, value: string) => ReceiptOrderCheck(at.index + 1, at.matched && value == (if 0 <= at.index && at.index < |full| then full[at.index] else ""));
    assert prior == full[..|prior|] && prefix == prior + [last];
    ResponseReceiptPrefix(prior, full);
    ProofLib.FoldLeftAppend(compare, initialReceiptOrderCheck, prior, last);
    assert full[|prior|] == last;
  }
}

lemma ResponseSameEvidence(s: ResponseEvaluation, after: ResponseEvaluation, via: string)
  requires s.plan.sourceContext == after.plan.sourceContext
  requires s.plan.priorReceipts == after.plan.priorReceipts
  ensures stepOriginalSourceContextSurvives(s, via, after)
{
  ResponseReceiptPrefix(s.plan.priorReceipts, s.plan.priorReceipts);
}

lemma settleEligibility_ensures(s: ResponseEvaluation, decision: Decision)
  ensures (inv(s) ==> canSettleEligibility(s) ==> alwaysAwaitOwnsCandidate(settleEligibility(s, decision)))
  ensures (inv(s) ==> canSettleEligibility(s) ==> stepCancellationIsTerminal(s, settleEligibility(s, decision)))
  ensures (inv(s) ==> canSettleEligibility(s) ==> stepOriginalSourceContextSurvives(s, "settleEligibility", settleEligibility(s, decision)))
{
  if inv(s) && canSettleEligibility(s) {
    var after := settleEligibility(s, decision);
    ResponseSameEvidence(s, after, "settleEligibility");
  }
}

lemma settleEvaluation_ensures(s: ResponseEvaluation, receipt: PatchReceipt)
  ensures (inv(s) ==> canSettleEvaluation(s) ==> alwaysAwaitOwnsCandidate(settleEvaluation(s, receipt)))
  ensures (inv(s) ==> canSettleEvaluation(s) ==> stepCancellationIsTerminal(s, settleEvaluation(s, receipt)))
  ensures (inv(s) ==> canSettleEvaluation(s) ==> stepOriginalSourceContextSurvives(s, "settleEvaluation", settleEvaluation(s, receipt)))
{
  if inv(s) && canSettleEvaluation(s) {
    var after := settleEvaluation(s, receipt);
    ResponseSameEvidence(s, after, "settleEvaluation");
  }
}
