lemma HeldShift(a: int, rs: seq<Reservation>)
  ensures Std.Collections.Seq.FoldLeft((sum: int, r: Reservation) => (if r.status.ReservationHeld? then (sum + r.reserved) else sum), a, rs)
    == a + Std.Collections.Seq.FoldLeft((sum: int, r: Reservation) => (if r.status.ReservationHeld? then (sum + r.reserved) else sum), 0, rs)
  decreases |rs|
{
  if |rs| > 0 {
    var h := (sum: int, r: Reservation) => (if r.status.ReservationHeld? then (sum + r.reserved) else sum);
    HeldShift(h(a, rs[0]), rs[1..]);
    HeldShift(h(0, rs[0]), rs[1..]);
  }
}

lemma HeldSettle(rs: seq<Reservation>, m: seq<Reservation>, k: int)
  requires |m| == |rs| && 0 <= k < |rs| && m[k].status.ReservationSettled?
  requires forall i :: 0 <= i < |rs| && i != k ==> m[i] == rs[i]
  ensures Std.Collections.Seq.FoldLeft((sum: int, r: Reservation) => (if r.status.ReservationHeld? then (sum + r.reserved) else sum), 0, m)
    + (if rs[k].status.ReservationHeld? then rs[k].reserved else 0)
    == Std.Collections.Seq.FoldLeft((sum: int, r: Reservation) => (if r.status.ReservationHeld? then (sum + r.reserved) else sum), 0, rs)
  decreases |rs|
{
  var h := (sum: int, r: Reservation) => (if r.status.ReservationHeld? then (sum + r.reserved) else sum);
  HeldShift(h(0, m[0]), m[1..]);
  HeldShift(h(0, rs[0]), rs[1..]);
  if k == 0 {
    assert m[1..] == rs[1..];
  } else {
    HeldSettle(rs[1..], m[1..], k - 1);
  }
}

lemma Ids(rs: seq<Reservation>)
  ensures (forall r :: r in rs ==> |ProofLib.Filter((x: Reservation) => (x.id == r.id), rs)| == 1) == ProofLib.DistinctBy(rs, (x: Reservation) => x.id)
{
  if forall r :: r in rs ==> |ProofLib.Filter((x: Reservation) => (x.id == r.id), rs)| == 1 {
    forall i, j | 0 <= i < |rs| && 0 <= j < |rs| && i != j ensures rs[i].id != rs[j].id {
      if rs[i].id == rs[j].id {
        assert rs[i] in rs;
        ProofLib.FilterTwo((x: Reservation) => (x.id == rs[i].id), rs, i, j);
      }
    }
  }
  if ProofLib.DistinctBy(rs, (x: Reservation) => x.id) {
    forall r | r in rs ensures |ProofLib.Filter((x: Reservation) => (x.id == r.id), rs)| == 1 {
      var i :| 0 <= i < |rs| && rs[i] == r;
      ProofLib.FilterOne((x: Reservation) => (x.id == r.id), rs, i);
    }
  }
}

lemma IdsBody(c: Credits)
  ensures alwaysReservationIdsUnique(c) == ProofLib.DistinctBy(c.reservations, (x: Reservation) => x.id)
{
  assert alwaysReservationIdsUnique(c) == (forall r :: r in c.reservations ==> |ProofLib.Filter((x: Reservation) => (x.id == r.id), c.reservations)| == 1);
  Ids(c.reservations);
}

lemma SettleShape(c: Credits, id: int, cost: int, r: Reservation)
  requires ProofLib.Filter((x: Reservation) => (x.id == id), c.reservations) == [r]
  ensures (var after := settleReservation(c, id, cost);
    var refund := (if (cost < r.reserved) then (r.reserved - cost) else 0);
    var overage := (if ((cost > r.reserved) && (c.balance >= (cost - r.reserved))) then (cost - r.reserved) else 0);
    after.balance == c.balance + refund - overage && after.spent == c.spent + r.reserved - refund + overage &&
    after.(balance := c.balance, spent := c.spent, reservations := c.reservations) == c && |after.reservations| == |c.reservations| &&
    forall i :: 0 <= i < |c.reservations| ==> after.reservations[i] == (if c.reservations[i].id == id then c.reservations[i].(collected := r.reserved - refund + overage, cost := cost, status := ReservationStatus.ReservationSettled) else c.reservations[i]))
{
}

lemma SweepSorted(p: SweepPass, rows: seq<SweepRow>)
  requires forall i, j :: 0 <= i < j < |p.visited| ==> p.visited[i] < p.visited[j]
  requires forall i :: 0 <= i < |p.visited| ==> p.visited[i] <= p.cursor
  ensures (var q := Std.Collections.Seq.FoldLeft((p: SweepPass, r: SweepRow) => sweepVisit(p, r), p, rows);
    ProofLib.Distinct(q.visited))
  decreases |rows|
{
  if |rows| > 0 {
    SweepSorted(sweepVisit(p, rows[0]), rows[1..]);
  }
}

lemma SweepSame(p: SweepPass, q: SweepPass, xs: seq<SweepRow>, ys: seq<SweepRow>)
  requires |xs| == |ys| && p.cursor == q.cursor && p.visited == q.visited
  requires forall i :: 0 <= i < |xs| ==> xs[i].row == ys[i].row
  ensures Std.Collections.Seq.FoldLeft((p: SweepPass, r: SweepRow) => sweepVisit(p, r), p, xs).visited == Std.Collections.Seq.FoldLeft((p: SweepPass, r: SweepRow) => sweepVisit(p, r), q, ys).visited
  ensures Std.Collections.Seq.FoldLeft((p: SweepPass, r: SweepRow) => sweepVisit(p, r), p, xs).cursor == Std.Collections.Seq.FoldLeft((p: SweepPass, r: SweepRow) => sweepVisit(p, r), q, ys).cursor
  decreases |xs|
{
  if |xs| > 0 {
    SweepSame(sweepVisit(p, xs[0]), sweepVisit(q, ys[0]), xs[1..], ys[1..]);
  }
}

lemma reserve_ensures(c: Credits, id: int, amount: int)
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysDispatchHasPinnedCustomer(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysRetryInsideOriginalWindow(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysRetryFollowsCompletedLookup(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysUndispatchedQuoteHasNoStart(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysClockIsNeverNegative(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysCreditGrantedOnce(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysPaymentHasASession(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysGrantIsPaymentBacked(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysReservationIdsUnique(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysSettledChargeIsAtMostCost(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysBalancesNonNegative(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysReversalBounded(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> alwaysCreditsConserved(reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> stepQuoteIsImmutable(c, reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> stepPinnedCustomerNeverChanges(c, reserve(c, id, amount)))
  ensures (inv(c) ==> canReserve(c, id, amount) ==> stepFirstDispatchIsImmutable(c, reserve(c, id, amount)))
{
  if inv(c) && canReserve(c, id, amount) {
    var after := reserve(c, id, amount);
    var nr := Reservation(id, amount, amount, -1, ReservationStatus.ReservationHeld);
    assert after.reservations == c.reservations + [nr];
    ProofLib.FoldLeftAppend((sum: int, r: Reservation) => (if r.status.ReservationHeld? then (sum + r.reserved) else sum), 0, c.reservations, nr);
    IdsBody(c);
    IdsBody(after);
    forall i | 0 <= i < |c.reservations| ensures c.reservations[i].id != id {
      assert c.reservations[i] in c.reservations;
    }
  }
}

lemma settleReservation_ensures(c: Credits, id: int, cost: int)
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysDispatchHasPinnedCustomer(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysRetryInsideOriginalWindow(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysRetryFollowsCompletedLookup(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysUndispatchedQuoteHasNoStart(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysClockIsNeverNegative(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysCreditGrantedOnce(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysPaymentHasASession(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysGrantIsPaymentBacked(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysReservationIdsUnique(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysSettledChargeIsAtMostCost(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysBalancesNonNegative(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysReversalBounded(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> alwaysCreditsConserved(settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> stepQuoteIsImmutable(c, settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> stepPinnedCustomerNeverChanges(c, settleReservation(c, id, cost)))
  ensures (inv(c) ==> canSettleReservation(c, id, cost) ==> stepFirstDispatchIsImmutable(c, settleReservation(c, id, cost)))
{
  if inv(c) && canSettleReservation(c, id, cost) {
    var after := settleReservation(c, id, cost);
    var rs := c.reservations;
    var lam := (x: Reservation) => (x.id == id);
    IdsBody(c);
    IdsBody(after);
    var r :| r in rs && r.id == id && r.status.ReservationHeld?;
    var k :| 0 <= k < |rs| && rs[k] == r;
    ProofLib.FilterOne(lam, rs, k);
    var f := ProofLib.Filter(lam, rs);
    ProofLib.FilterMember(lam, rs, f[0]);
    assert f[0] in f;
    var j :| 0 <= j < |rs| && rs[j] == f[0];
    assert f == [r];
    SettleShape(c, id, cost, r);
    assert r.reserved > 0;
    HeldSettle(rs, after.reservations, k);
    assert forall i :: 0 <= i < |rs| ==> after.reservations[i].id == rs[i].id && after.reservations[i].reserved == rs[i].reserved;
    assert forall x :: x in after.reservations ==> x.reserved > 0 && (x.status.ReservationSettled? ==> x.collected >= 0 && x.collected <= x.cost);
  }
}

lemma lawSweepVisitsEachRowOnce_ensures(rows: seq<SweepRow>)
  ensures (lawSweepVisitsEachRowOnce(rows) == true)
{
  var v := sweep(rows).visited;
  SweepSorted(sweepStart, rows);
  forall r | r in rows ensures |ProofLib.Filter((x: int) => (x == r.row), v)| <= 1 {
    if r.row in v {
      ProofLib.FilterDistinctCountOne((x: int) => (x == r.row), v, r.row);
    } else {
      ProofLib.FilterNone((x: int) => (x == r.row), v);
    }
  }
  assert lawSweepVisitsEachRowOnce(rows) == !(exists r :: r in rows && !(|ProofLib.Filter((x: int) => (x == r.row), v)| <= 1));
}

lemma lawFailingRowDoesNotBlockLaterRows_ensures(rows: seq<SweepRow>)
  ensures (lawFailingRowDoesNotBlockLaterRows(rows) == true)
{
  var ys := seq(|rows|, i_map requires 0 <= i_map < |rows| => var r := rows[i_map]; r.(failing := false));
  SweepSame(sweepStart, sweepStart, rows, ys);
}
