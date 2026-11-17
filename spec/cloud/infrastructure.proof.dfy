lemma staleRead_ensures(c: Cache)
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysReopenedOnlyAfterCooldown(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysConfirmedDeletionHasBackendAbsence(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysUnconfiguredDeletionHasNoBackend(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysNoCommandWithoutBackend(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysOneActiveLoader(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysTimersBelongToActiveLoaders(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysDeliveredOrTimedOutNotBoth(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysWritingLoaderOwnsKey(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysEachLoadHasOneDelivery(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> alwaysOutcomesAreFinal(staleRead(c)))
  ensures (inv(c) ==> canStaleRead(c) ==> stepWallClockDoesNotMoveTheBreaker(c, "staleRead", staleRead(c)))
{
  if inv(c) && canStaleRead(c) {
    var after := staleRead(c);
    var k := c.allocated_ + 1;
    assert c.active == [] by {
      if |c.active| > 0 {
        assert c.active[0] in c.active;
        assert c.active[0] == c.owner;
        assert c.active[0] > 0;
      }
    }
    assert after.active == c.active + [k];
    forall d | d in after.deliveries
      ensures d.load > 0 && d.load <= after.allocated_ && deliveryOf(after, d.load) == d.delivery
    {
      InfraDeliveryAppend(c, after, Delivery(k, DeliveryState.DeliveryPending), d.load);
      if d in c.deliveries {
        InfraAbsent(c, d.load);
      }
    }
    forall p | p in after.published
      ensures deliveryOf(after, p).DeliveryReady?
    {
      InfraDeliveryAppend(c, after, Delivery(k, DeliveryState.DeliveryPending), p);
      InfraAbsent(c, p);
    }
    forall p | p in after.timedOut
      ensures deliveryOf(after, p).DeliveryTimedOut?
    {
      InfraDeliveryAppend(c, after, Delivery(k, DeliveryState.DeliveryPending), p);
      InfraAbsent(c, p);
    }
  }
}

lemma deliveryExpires_ensures(c: Cache, n: int)
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysReopenedOnlyAfterCooldown(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysConfirmedDeletionHasBackendAbsence(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysUnconfiguredDeletionHasNoBackend(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysNoCommandWithoutBackend(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysOneActiveLoader(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysTimersBelongToActiveLoaders(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysDeliveredOrTimedOutNotBoth(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysWritingLoaderOwnsKey(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysEachLoadHasOneDelivery(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> alwaysOutcomesAreFinal(deliveryExpires(c, n)))
  ensures (inv(c) ==> canDeliveryExpires(c, n) ==> stepWallClockDoesNotMoveTheBreaker(c, "deliveryExpires", deliveryExpires(c, n)))
{
  if inv(c) && canDeliveryExpires(c, n) {
    var after := deliveryExpires(c, n);
    InfraAbsent(c, n);
    InfraDropMember(c.timers, n);
    InfraSetEachLoad(c, after, n, DeliveryState.DeliveryTimedOut);
    InfraSetOutcomes(c, after, n, DeliveryState.DeliveryTimedOut);
  }
}

lemma publishLoad_ensures(c: Cache, n: int)
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysReopenedOnlyAfterCooldown(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysConfirmedDeletionHasBackendAbsence(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysUnconfiguredDeletionHasNoBackend(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysNoCommandWithoutBackend(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysOneActiveLoader(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysTimersBelongToActiveLoaders(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysDeliveredOrTimedOutNotBoth(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysWritingLoaderOwnsKey(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysEachLoadHasOneDelivery(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> alwaysOutcomesAreFinal(publishLoad(c, n)))
  ensures (inv(c) ==> canPublishLoad(c, n) ==> stepWallClockDoesNotMoveTheBreaker(c, "publishLoad", publishLoad(c, n)))
{
  if inv(c) && canPublishLoad(c, n) {
    var after := publishLoad(c, n);
    InfraSetEachLoad(c, after, n, DeliveryState.DeliveryReady);
    InfraSetOutcomes(c, after, n, DeliveryState.DeliveryReady);
  }
}

lemma loaderSettles_ensures(c: Cache, n: int, resolved: bool)
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysReopenedOnlyAfterCooldown(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysConfirmedDeletionHasBackendAbsence(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysUnconfiguredDeletionHasNoBackend(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysNoCommandWithoutBackend(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysOneActiveLoader(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysTimersBelongToActiveLoaders(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysDeliveredOrTimedOutNotBoth(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysWritingLoaderOwnsKey(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysEachLoadHasOneDelivery(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> alwaysOutcomesAreFinal(loaderSettles(c, n, resolved)))
  ensures (inv(c) ==> canLoaderSettles(c, n, resolved) ==> stepWallClockDoesNotMoveTheBreaker(c, "loaderSettles", loaderSettles(c, n, resolved)))
{
  if inv(c) && canLoaderSettles(c, n, resolved) {
    var after := loaderSettles(c, n, resolved);
    InfraSettlesView(c, n, resolved);
    InfraDropMember(c.active, n);
    InfraDropMember(c.timers, n);
    InfraDropShorter(c.active, n);
    assert |after.active| <= 1;
    forall y | y in after.active ensures y in c.active && y == c.owner && y > 0 {
      assert y in ProofLib.Filter((x: int) => (x != n), c.active);
    }
    forall y | y in after.timers ensures y in after.active {
      assert y in ProofLib.Filter((x: int) => (x != n), c.timers);
      assert y in c.timers && y != n;
      assert y in c.active;
      assert y in ProofLib.Filter((x: int) => (x != n), c.active);
    }
    if deliveryOf(c, n).DeliveryPending? {
      var st := if resolved then DeliveryState.DeliveryWriting else DeliveryState.DeliveryFailed;
      InfraAbsent(c, n);
      InfraSetEachLoad(c, after, n, st);
      InfraSetOutcomes(c, after, n, st);
    }
  }
}

lemma InfraSettlesView(c: Cache, n: int, resolved: bool)
  ensures loaderSettles(c, n, resolved).active == ProofLib.Filter((x: int) => (x != n), c.active)
  ensures loaderSettles(c, n, resolved).timers == ProofLib.Filter((x: int) => (x != n), c.timers)
{
}

lemma InfraDropMember(xs: seq<int>, n: int)
  ensures forall x :: x in ProofLib.Filter((x: int) => (x != n), xs) <==> x in xs && x != n
{
  forall x ensures x in ProofLib.Filter((x: int) => (x != n), xs) <==> x in xs && x != n {
    ProofLib.FilterMember((x: int) => (x != n), xs, x);
  }
}

lemma InfraDropShorter(xs: seq<int>, n: int)
  ensures |ProofLib.Filter((x: int) => (x != n), xs)| <= |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((x: int) => (x != n), xs);
  } else {
    ProofLib.FilterCons((x: int) => (x != n), xs);
    InfraDropShorter(xs[1..], n);
  }
}

lemma InfraView(c: Cache, m: int)
  ensures deliveryOf(c, m) == (if 0 < |ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)| then ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)[0].delivery else DeliveryState.DeliveryFailed)
{
}

lemma InfraHasLoad(c: Cache, m: int)
  ensures (exists d :: d in c.deliveries && d.load == m) <==> 0 < |ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)|
  ensures 0 < |ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)| ==> ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)[0] in c.deliveries && ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)[0].load == m
{
  if 0 < |ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)| {
    ProofLib.FilterMember((d: Delivery) => (d.load == m), c.deliveries, ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)[0]);
  }
  if exists d :: d in c.deliveries && d.load == m {
    var d :| d in c.deliveries && d.load == m;
    ProofLib.FilterMember((d: Delivery) => (d.load == m), c.deliveries, d);
  }
}

lemma InfraAbsent(c: Cache, m: int)
  ensures !(exists d :: d in c.deliveries && d.load == m) ==> deliveryOf(c, m).DeliveryFailed?
{
  InfraView(c, m);
  InfraHasLoad(c, m);
}

lemma InfraDeliveryAppend(c: Cache, c2: Cache, x: Delivery, m: int)
  requires c2.deliveries == c.deliveries + [x]
  ensures (exists d :: d in c.deliveries && d.load == m) ==> deliveryOf(c2, m) == deliveryOf(c, m)
  ensures !(exists d :: d in c.deliveries && d.load == m) && x.load == m ==> deliveryOf(c2, m) == x.delivery
{
  InfraView(c, m);
  InfraView(c2, m);
  InfraHasLoad(c, m);
  ProofLib.FilterAppend((d: Delivery) => (d.load == m), c.deliveries, x);
}

lemma InfraSetOther(c: Cache, n: int, st: DeliveryState, m: int)
  requires m != n
  ensures ProofLib.Filter((d: Delivery) => (d.load == m), setDelivery(c, n, st)) == ProofLib.Filter((d: Delivery) => (d.load == m), c.deliveries)
  decreases |c.deliveries|
{
  if |c.deliveries| == 0 {
    ProofLib.FilterNil((d: Delivery) => (d.load == m), setDelivery(c, n, st));
    ProofLib.FilterNil((d: Delivery) => (d.load == m), c.deliveries);
  } else {
    var c1 := c.(deliveries := c.deliveries[1..]);
    assert setDelivery(c, n, st)[1..] == setDelivery(c1, n, st);
    InfraSetOther(c1, n, st, m);
    ProofLib.FilterCons((d: Delivery) => (d.load == m), setDelivery(c, n, st));
    ProofLib.FilterCons((d: Delivery) => (d.load == m), c.deliveries);
  }
}

lemma InfraDeliverySet(c: Cache, c2: Cache, n: int, st: DeliveryState, m: int)
  requires c2.deliveries == setDelivery(c, n, st)
  ensures deliveryOf(c2, m) == (if m == n && (exists d :: d in c.deliveries && d.load == n) then st else deliveryOf(c, m))
{
  InfraView(c, m);
  InfraView(c2, m);
  if m != n {
    InfraSetOther(c, n, st, m);
  } else {
    InfraHasLoad(c, n);
    InfraHasLoad(c2, n);
    if exists d :: d in c.deliveries && d.load == n {
      var d :| d in c.deliveries && d.load == n;
      var i :| 0 <= i < |c.deliveries| && c.deliveries[i] == d;
      assert c2.deliveries[i] in c2.deliveries;
    }
    if exists d :: d in c2.deliveries && d.load == n {
      var d :| d in c2.deliveries && d.load == n;
      var i :| 0 <= i < |c2.deliveries| && c2.deliveries[i] == d;
      assert c.deliveries[i] in c.deliveries;
    }
    if 0 < |ProofLib.Filter((d: Delivery) => (d.load == n), c2.deliveries)| {
      var e := ProofLib.Filter((d: Delivery) => (d.load == n), c2.deliveries)[0];
      var i :| 0 <= i < |c2.deliveries| && c2.deliveries[i] == e;
    }
  }
}

lemma InfraSetEachLoad(c: Cache, c2: Cache, n: int, st: DeliveryState)
  requires alwaysEachLoadHasOneDelivery(c)
  requires c2.deliveries == setDelivery(c, n, st)
  requires c2.allocated_ == c.allocated_
  requires forall x :: x in c2.active ==> x in c.active
  ensures alwaysEachLoadHasOneDelivery(c2)
{
  forall e | e in c2.deliveries
    ensures e.load > 0 && e.load <= c2.allocated_ && deliveryOf(c2, e.load) == e.delivery
  {
    var i :| 0 <= i < |c2.deliveries| && c2.deliveries[i] == e;
    assert c.deliveries[i] in c.deliveries;
    InfraDeliverySet(c, c2, n, st, e.load);
  }
}

lemma InfraSetOutcomes(c: Cache, c2: Cache, n: int, st: DeliveryState)
  requires alwaysOutcomesAreFinal(c)
  requires c2.deliveries == setDelivery(c, n, st)
  requires exists d :: d in c.deliveries && d.load == n
  requires !deliveryOf(c, n).DeliveryReady? && !deliveryOf(c, n).DeliveryTimedOut?
  requires c2.published == c.published || (st.DeliveryReady? && c2.published == c.published + [n])
  requires c2.timedOut == c.timedOut || (st.DeliveryTimedOut? && c2.timedOut == c.timedOut + [n])
  ensures alwaysOutcomesAreFinal(c2)
{
  forall p | p in c2.published ensures deliveryOf(c2, p).DeliveryReady? {
    InfraDeliverySet(c, c2, n, st, p);
  }
  forall p | p in c2.timedOut ensures deliveryOf(c2, p).DeliveryTimedOut? {
    InfraDeliverySet(c, c2, n, st, p);
  }
}
