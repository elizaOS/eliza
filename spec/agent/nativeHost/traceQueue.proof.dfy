lemma FilterShorter(p: int -> bool, xs: seq<int>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  ensures forall x :: x in ProofLib.Filter(p, xs) ==> x in xs
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    FilterShorter(p, xs[1..]);
  }
}

lemma enqueueTrace_ensures(q: TraceQueue, trace: int, sameDocument: bool)
  ensures (inv(q) ==> canEnqueueTrace(q, trace, sameDocument) ==> alwaysQueueWithinCapacity(enqueueTrace(q, trace, sameDocument)))
  ensures (inv(q) ==> canEnqueueTrace(q, trace, sameDocument) ==> alwaysBatchIsQueued(enqueueTrace(q, trace, sameDocument)))
  ensures (inv(q) ==> canEnqueueTrace(q, trace, sameDocument) ==> alwaysWithdrawalClearsCapture(enqueueTrace(q, trace, sameDocument)))
  ensures (inv(q) ==> canEnqueueTrace(q, trace, sameDocument) ==> alwaysClosedHasNoUpload(enqueueTrace(q, trace, sameDocument)))
  ensures (inv(q) ==> canEnqueueTrace(q, trace, sameDocument) ==> stepOnlyAQueuedAnswerAddsARow(q, "enqueueTrace", enqueueTrace(q, trace, sameDocument)))
  ensures (inv(q) ==> canEnqueueTrace(q, trace, sameDocument) ==> stepReceiptRetiresOnlyItsBatch(q, "enqueueTrace", enqueueTrace(q, trace, sameDocument)))
  ensures (inv(q) ==> canEnqueueTrace(q, trace, sameDocument) ==> stepWithdrawalPersists(q, enqueueTrace(q, trace, sameDocument)))
  ensures (inv(q) ==> canEnqueueTrace(q, trace, sameDocument) ==> stepReopenKeepsQueue(q, "enqueueTrace", enqueueTrace(q, trace, sameDocument)))
{
  var p := (set_x: int) => !((set_x in q.rows));
  ProofLib.FilterCons(p, [trace]);
  ProofLib.FilterNil(p, [trace][1..]);
}

lemma settleUpload_ensures(q: TraceQueue, durable: bool, accepted: seq<int>, count: int)
  ensures (inv(q) ==> canSettleUpload(q) ==> alwaysQueueWithinCapacity(settleUpload(q, durable, accepted, count)))
  ensures (inv(q) ==> canSettleUpload(q) ==> alwaysBatchIsQueued(settleUpload(q, durable, accepted, count)))
  ensures (inv(q) ==> canSettleUpload(q) ==> alwaysWithdrawalClearsCapture(settleUpload(q, durable, accepted, count)))
  ensures (inv(q) ==> canSettleUpload(q) ==> alwaysClosedHasNoUpload(settleUpload(q, durable, accepted, count)))
  ensures (inv(q) ==> canSettleUpload(q) ==> stepOnlyAQueuedAnswerAddsARow(q, "settleUpload", settleUpload(q, durable, accepted, count)))
  ensures (inv(q) ==> canSettleUpload(q) ==> stepReceiptRetiresOnlyItsBatch(q, "settleUpload", settleUpload(q, durable, accepted, count)))
  ensures (inv(q) ==> canSettleUpload(q) ==> stepWithdrawalPersists(q, settleUpload(q, durable, accepted, count)))
  ensures (inv(q) ==> canSettleUpload(q) ==> stepReopenKeepsQueue(q, "settleUpload", settleUpload(q, durable, accepted, count)))
{
  FilterShorter((set_x: int) => !((set_x in q.batch)), q.rows);
}
