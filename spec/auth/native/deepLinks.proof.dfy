lemma DeepLinkFacts(r: DeepLinks)
  ensures alwaysClearedOnlyAfterTerminal(r) <==> (forall x :: x in r.cleared ==> x in r.applied || x in r.rejected)
  ensures alwaysCompletedOnlyWhenTerminal(r) <==> (forall x :: x in r.completed ==> x in r.applied || x in r.rejected)
  ensures alwaysReceiptsStayDistinct(r) <==> ((forall x :: x in r.queued ==> x !in r.inFlight) && (forall x :: x in r.completed ==> x !in r.inFlight) && (forall x :: x in r.completed ==> x !in r.queued) && (forall x :: x in r.acknowledgements ==> x in r.applied || x in r.rejected) && 0 <= r.pendingNative <= r.captured)
{
  forall x
    ensures x in ProofLib.Filter((set_x: int) => !((set_x in r.applied)), r.rejected) <==> x in r.rejected && x !in r.applied
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in r.applied)), r.rejected, x);
  }
  ProofLib.FilterNone((set_x: int) => (set_x in r.inFlight), r.queued);
  ProofLib.FilterNone((set_x: int) => (set_x in r.inFlight), r.completed);
  ProofLib.FilterNone((set_x: int) => (set_x in r.queued), r.completed);
  NoneIn(r.queued, r.inFlight);
  NoneIn(r.completed, r.inFlight);
  NoneIn(r.completed, r.queued);
}

lemma NoneIn(a: seq<int>, b: seq<int>)
  ensures (forall i :: 0 <= i < |a| ==> !(a[i] in b)) <==> (forall x :: x in a ==> x !in b)
{
  if forall i :: 0 <= i < |a| ==> !(a[i] in b) {
    forall x | x in a
      ensures x !in b
    {
      var i :| 0 <= i < |a| && a[i] == x;
    }
  }
  if forall x :: x in a ==> x !in b {
    forall i | 0 <= i < |a|
      ensures !(a[i] in b)
    {
      assert a[i] in a;
    }
  }
}

lemma JoinedKeepsInv(id: int, r: DeepLinks)
  requires inv(r)
  ensures inv(joined(id, r))
{
  var after := joined(id, r);
  DeepLinkFacts(r);
  DeepLinkFacts(after);
  forall x
    ensures x in after.queued ==> x in r.queued || (x == id && !r.ready && id !in r.completed && id !in r.inFlight)
    ensures x in after.inFlight ==> x in r.inFlight || (x == id && r.ready && id !in r.completed)
    ensures x in after.acknowledgements ==> x in r.acknowledgements || (x == id && id in r.completed)
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in r.queued)), [id], x);
    ProofLib.FilterMember((set_x: int) => !((set_x in r.inFlight)), [id], x);
    ProofLib.FilterMember((set_x: int) => !((set_x in r.acknowledgements)), [id], x);
  }
}

lemma rendererReady_ensures(r: DeepLinks)
  ensures (inv(r) ==> canRendererReady(r) ==> alwaysLinksWaitForTheRenderer(rendererReady(r)))
  ensures (inv(r) ==> canRendererReady(r) ==> alwaysClearedOnlyAfterTerminal(rendererReady(r)))
  ensures (inv(r) ==> canRendererReady(r) ==> alwaysCompletedOnlyWhenTerminal(rendererReady(r)))
  ensures (inv(r) ==> canRendererReady(r) ==> alwaysReceiptsStayDistinct(rendererReady(r)))
{
  if inv(r) && canRendererReady(r) {
    var after := rendererReady(r);
    DeepLinkFacts(r);
    DeepLinkFacts(after);
    forall x
      ensures x in after.inFlight ==> x in r.inFlight || x in r.queued
    {
      ProofLib.FilterMember((set_x: int) => !((set_x in r.inFlight)), r.queued, x);
    }
  }
}

lemma deliverWarm_ensures(r: DeepLinks, id: int)
  ensures (inv(r) ==> canDeliverWarm(r, id) ==> alwaysLinksWaitForTheRenderer(deliverWarm(r, id)))
  ensures (inv(r) ==> canDeliverWarm(r, id) ==> alwaysClearedOnlyAfterTerminal(deliverWarm(r, id)))
  ensures (inv(r) ==> canDeliverWarm(r, id) ==> alwaysCompletedOnlyWhenTerminal(deliverWarm(r, id)))
  ensures (inv(r) ==> canDeliverWarm(r, id) ==> alwaysReceiptsStayDistinct(deliverWarm(r, id)))
{
  if inv(r) && canDeliverWarm(r, id) {
    var mid := r.(warmQueue := Std.Collections.Seq.Filter((set_x: int) => !((set_x in [id])), r.warmQueue));
    DeepLinkFacts(r);
    DeepLinkFacts(mid);
    JoinedKeepsInv(id, mid);
  }
}

lemma deliverPeek_ensures(r: DeepLinks)
  ensures (inv(r) ==> canDeliverPeek(r) ==> alwaysLinksWaitForTheRenderer(deliverPeek(r)))
  ensures (inv(r) ==> canDeliverPeek(r) ==> alwaysClearedOnlyAfterTerminal(deliverPeek(r)))
  ensures (inv(r) ==> canDeliverPeek(r) ==> alwaysCompletedOnlyWhenTerminal(deliverPeek(r)))
  ensures (inv(r) ==> canDeliverPeek(r) ==> alwaysReceiptsStayDistinct(deliverPeek(r)))
{
  if inv(r) && canDeliverPeek(r) {
    var head := (if ((0 <= 0) && (0 < |r.peekReplies|)) then r.peekReplies[0] else 0);
    var mid := r.(peekReplies := Std.Collections.Seq.Filter((id: int) => (id != (if ((0 <= 0) && (0 < |r.peekReplies|)) then r.peekReplies[0] else 0)), r.peekReplies));
    DeepLinkFacts(r);
    DeepLinkFacts(mid);
    JoinedKeepsInv(head, mid);
  }
}

lemma acknowledgeReceipt_ensures(r: DeepLinks, id: int)
  ensures (inv(r) ==> canAcknowledgeReceipt(r, id) ==> alwaysLinksWaitForTheRenderer(acknowledgeReceipt(r, id)))
  ensures (inv(r) ==> canAcknowledgeReceipt(r, id) ==> alwaysClearedOnlyAfterTerminal(acknowledgeReceipt(r, id)))
  ensures (inv(r) ==> canAcknowledgeReceipt(r, id) ==> alwaysCompletedOnlyWhenTerminal(acknowledgeReceipt(r, id)))
  ensures (inv(r) ==> canAcknowledgeReceipt(r, id) ==> alwaysReceiptsStayDistinct(acknowledgeReceipt(r, id)))
{
  if inv(r) && canAcknowledgeReceipt(r, id) {
    var after := acknowledgeReceipt(r, id);
    DeepLinkFacts(r);
    DeepLinkFacts(after);
    forall x
      ensures x in after.acknowledgements ==> x in r.acknowledgements
      ensures x in after.cleared ==> x in r.cleared || x == id
    {
      ProofLib.FilterMember((set_x: int) => !((set_x in [id])), r.acknowledgements, x);
      ProofLib.FilterMember((set_x: int) => !((set_x in r.cleared)), [id], x);
    }
  }
}

lemma applyReceipt_ensures(r: DeepLinks, id: int, linkOutcome: LinkOutcome)
  ensures (inv(r) ==> canApplyReceipt(r, id, linkOutcome) ==> alwaysLinksWaitForTheRenderer(applyReceipt(r, id, linkOutcome)))
  ensures (inv(r) ==> canApplyReceipt(r, id, linkOutcome) ==> alwaysClearedOnlyAfterTerminal(applyReceipt(r, id, linkOutcome)))
  ensures (inv(r) ==> canApplyReceipt(r, id, linkOutcome) ==> alwaysCompletedOnlyWhenTerminal(applyReceipt(r, id, linkOutcome)))
  ensures (inv(r) ==> canApplyReceipt(r, id, linkOutcome) ==> alwaysReceiptsStayDistinct(applyReceipt(r, id, linkOutcome)))
{
  if inv(r) && canApplyReceipt(r, id, linkOutcome) {
    var after := applyReceipt(r, id, linkOutcome);
    DeepLinkFacts(r);
    DeepLinkFacts(after);
    forall x
      ensures x in after.inFlight <==> x in r.inFlight && x != id
      ensures x in after.completed ==> x in r.completed || (x == id && !linkOutcome.LinkFailed?)
      ensures x in after.acknowledgements ==> x in r.acknowledgements || (x == id && !linkOutcome.LinkFailed?)
      ensures x in r.applied ==> x in after.applied
      ensures x in r.rejected ==> x in after.rejected
      ensures linkOutcome.LinkApplied? ==> id in after.applied
      ensures linkOutcome.LinkRejected? ==> id in after.rejected
    {
      ProofLib.FilterMember((set_x: int) => !((set_x in [id])), r.inFlight, x);
      ProofLib.FilterMember((set_x: int) => !((set_x in r.completed)), [id], x);
      ProofLib.FilterMember((set_x: int) => !((set_x in r.acknowledgements)), [id], x);
      ProofLib.FilterMember((set_x: int) => !((set_x in r.applied)), [id], id);
      ProofLib.FilterMember((set_x: int) => !((set_x in r.rejected)), [id], id);
    }
  }
}
