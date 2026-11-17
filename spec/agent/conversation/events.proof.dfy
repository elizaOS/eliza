lemma SettledWithMember(e: Events, g: int, x: int)
  ensures x in settledWith(e, g) <==> x in e.settled || (x == g && g != 0)
{
  ProofLib.FilterMember((set_x: int) => !((set_x in e.settled)), [g], x);
}

lemma waitRequest_ensures(e: Events, generation: int)
  ensures (inv(e) ==> canWaitRequest(e, generation) ==> alwaysWaiterIsUnsettled(waitRequest(e, generation)))
  ensures (inv(e) ==> canWaitRequest(e, generation) ==> alwaysFramesFlushInOrder(waitRequest(e, generation)))
  ensures (inv(e) ==> canWaitRequest(e, generation) ==> alwaysCursorWithinPublished(waitRequest(e, generation)))
  ensures (inv(e) ==> canWaitRequest(e, generation) ==> alwaysHeartbeatsCarryNoData(waitRequest(e, generation)))
  ensures (inv(e) ==> canWaitRequest(e, generation) ==> stepStaleTimeoutKeepsReplacement(e, "waitRequest", waitRequest(e, generation)))
{
  SettledWithMember(e, e.waiter, generation);
}
