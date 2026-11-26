lemma SetAddFacts(xs: seq<int>, x: int)
  ensures var res := xs + ProofLib.Filter((set_x: int) => !(set_x in xs), [x]);
    forall y :: y in res <==> y in xs || y == x
{
  var p := (set_x: int) => !(set_x in xs);
  ProofLib.FilterCons(p, [x]);
  ProofLib.FilterNil(p, [x][1..]);
}

lemma SetRemoveFacts(xs: seq<int>, x: int)
  ensures var res := ProofLib.Filter((set_x: int) => !(set_x in [x]), xs);
    forall y :: y in res <==> y in xs && y != x
{
  var p := (set_x: int) => !(set_x in [x]);
  forall y
    ensures y in ProofLib.Filter(p, xs) <==> y in xs && y != x
  {
    ProofLib.FilterMember(p, xs, y);
  }
}

lemma SetUnionFacts(xs: seq<int>, ys: seq<int>)
  ensures var res := xs + ProofLib.Filter((set_x: int) => !(set_x in xs), ys);
    forall y :: y in res <==> y in xs || y in ys
{
  var p := (set_x: int) => !(set_x in xs);
  forall y
    ensures y in ProofLib.Filter(p, ys) <==> y in ys && !(y in xs)
  {
    ProofLib.FilterMember(p, ys, y);
  }
}

lemma DisjointIff(xs: seq<int>, ys: seq<int>)
  ensures |ProofLib.Filter((set_x: int) => (set_x in ys), xs)| == 0 <==> forall x :: x in xs ==> !(x in ys)
{
  var p := (set_x: int) => (set_x in ys);
  ProofLib.FilterNone(p, xs);
  if |ProofLib.Filter(p, xs)| == 0 {
    forall x | x in xs
      ensures !(x in ys)
    {
      var i :| 0 <= i < |xs| && xs[i] == x;
      assert !p(xs[i]);
    }
  }
  if forall x :: x in xs ==> !(x in ys) {
    forall i | 0 <= i < |xs|
      ensures !p(xs[i])
    {
      assert xs[i] in xs;
    }
  }
}

lemma OneAttemptIff(d: DeepLinks)
  ensures alwaysOneAttemptPerLink(d) <==>
    ((forall x :: x in d.waiting ==> !(x in d.running))
      && (forall x :: x in d.waiting ==> !(x in d.done))
      && (forall x :: x in d.running ==> !(x in d.done)))
{
  DisjointIff(d.waiting, d.running);
  DisjointIff(d.waiting, d.done);
  DisjointIff(d.running, d.done);
}

lemma deliver_ensures(d: DeepLinks, id: int)
  ensures (inv(d) ==> canDeliver(d, id) ==> alwaysLinksWaitForTheRenderer(deliver(d, id)))
  ensures (inv(d) ==> canDeliver(d, id) ==> alwaysOneAttemptPerLink(deliver(d, id)))
  ensures (inv(d) ==> canDeliver(d, id) ==> alwaysOnlySettledLinksAreAcknowledged(deliver(d, id)))
  ensures (inv(d) ==> canDeliver(d, id) ==> alwaysReceiptsComeFromCaptures(deliver(d, id)))
  ensures (inv(d) ==> canDeliver(d, id) ==> stepStartsOnlyNewLinks(d, deliver(d, id)))
  ensures (inv(d) ==> canDeliver(d, id) ==> stepSlotClearsOnlySettledLinks(d, deliver(d, id)))
  ensures (inv(d) ==> canDeliver(d, id) ==> stepOnlyANewCaptureTakesTheSlot(d, deliver(d, id)))
{
  if inv(d) && canDeliver(d, id) {
    var after := deliver(d, id);
    OneAttemptIff(d);
    SetAddFacts(d.waiting, id);
    SetAddFacts(d.running, id);
    SetAddFacts(d.acks, id);
    OneAttemptIff(after);
  }
}

lemma rendererReady_ensures(d: DeepLinks)
  ensures (inv(d) ==> canRendererReady(d) ==> alwaysLinksWaitForTheRenderer(rendererReady(d)))
  ensures (inv(d) ==> canRendererReady(d) ==> alwaysOneAttemptPerLink(rendererReady(d)))
  ensures (inv(d) ==> canRendererReady(d) ==> alwaysOnlySettledLinksAreAcknowledged(rendererReady(d)))
  ensures (inv(d) ==> canRendererReady(d) ==> alwaysReceiptsComeFromCaptures(rendererReady(d)))
  ensures (inv(d) ==> canRendererReady(d) ==> stepStartsOnlyNewLinks(d, rendererReady(d)))
  ensures (inv(d) ==> canRendererReady(d) ==> stepSlotClearsOnlySettledLinks(d, rendererReady(d)))
  ensures (inv(d) ==> canRendererReady(d) ==> stepOnlyANewCaptureTakesTheSlot(d, rendererReady(d)))
{
  if inv(d) && canRendererReady(d) {
    var after := rendererReady(d);
    OneAttemptIff(d);
    SetUnionFacts(d.running, d.waiting);
    OneAttemptIff(after);
  }
}

lemma finish_ensures(d: DeepLinks, id: int, linkOutcome: LinkOutcome)
  ensures (inv(d) ==> canFinish(d, id, linkOutcome) ==> alwaysLinksWaitForTheRenderer(finish(d, id, linkOutcome)))
  ensures (inv(d) ==> canFinish(d, id, linkOutcome) ==> alwaysOneAttemptPerLink(finish(d, id, linkOutcome)))
  ensures (inv(d) ==> canFinish(d, id, linkOutcome) ==> alwaysOnlySettledLinksAreAcknowledged(finish(d, id, linkOutcome)))
  ensures (inv(d) ==> canFinish(d, id, linkOutcome) ==> alwaysReceiptsComeFromCaptures(finish(d, id, linkOutcome)))
  ensures (inv(d) ==> canFinish(d, id, linkOutcome) ==> stepStartsOnlyNewLinks(d, finish(d, id, linkOutcome)))
  ensures (inv(d) ==> canFinish(d, id, linkOutcome) ==> stepSlotClearsOnlySettledLinks(d, finish(d, id, linkOutcome)))
  ensures (inv(d) ==> canFinish(d, id, linkOutcome) ==> stepOnlyANewCaptureTakesTheSlot(d, finish(d, id, linkOutcome)))
{
  if inv(d) && canFinish(d, id, linkOutcome) {
    var after := finish(d, id, linkOutcome);
    OneAttemptIff(d);
    SetRemoveFacts(d.running, id);
    SetAddFacts(d.done, id);
    SetAddFacts(d.settled, id);
    SetAddFacts(d.acks, id);
    OneAttemptIff(after);
  }
}

lemma acknowledge_ensures(d: DeepLinks, id: int)
  ensures (inv(d) ==> canAcknowledge(d, id) ==> alwaysLinksWaitForTheRenderer(acknowledge(d, id)))
  ensures (inv(d) ==> canAcknowledge(d, id) ==> alwaysOneAttemptPerLink(acknowledge(d, id)))
  ensures (inv(d) ==> canAcknowledge(d, id) ==> alwaysOnlySettledLinksAreAcknowledged(acknowledge(d, id)))
  ensures (inv(d) ==> canAcknowledge(d, id) ==> alwaysReceiptsComeFromCaptures(acknowledge(d, id)))
  ensures (inv(d) ==> canAcknowledge(d, id) ==> stepStartsOnlyNewLinks(d, acknowledge(d, id)))
  ensures (inv(d) ==> canAcknowledge(d, id) ==> stepSlotClearsOnlySettledLinks(d, acknowledge(d, id)))
  ensures (inv(d) ==> canAcknowledge(d, id) ==> stepOnlyANewCaptureTakesTheSlot(d, acknowledge(d, id)))
{
  if inv(d) && canAcknowledge(d, id) {
    var after := acknowledge(d, id);
    OneAttemptIff(d);
    SetRemoveFacts(d.acks, id);
    OneAttemptIff(after);
  }
}
