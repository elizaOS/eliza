lemma RoomBatchQueueState(s: MultiRoomLeases)
  requires inv(s)
  ensures core__concurrency_inv(s.queue)
{}

lemma RoomBatchGrantInvariant(s: MultiRoomLeases, room: int)
  requires alwaysQueueInvariant(s)
  ensures alwaysQueueInvariant(grantAvailable(room, s))
{
  if core__concurrency_canGrantRoom(s.queue, room) {
    assert core__concurrency_inv(s.queue);
    core__concurrency_grantRoom_ensures(s.queue, room);
  }
}

lemma RoomBatchLargestWaiter(waiters: seq<core__concurrency_RoomWaiter>)
  requires |waiters| > 0
  ensures (exists largest :: largest in waiters && (forall w :: w in waiters ==> w.room <= largest.room))
  decreases |waiters|
{
  var head := waiters[0];
  if |waiters| > 1 {
    RoomBatchLargestWaiter(waiters[1..]);
    var suffix :| suffix in waiters[1..] && (forall w :: w in waiters[1..] ==> w.room <= suffix.room);
    var largest := if head.room >= suffix.room then head else suffix;
    assert largest in waiters;
    forall w | w in waiters ensures w.room <= largest.room
    {
      if w != head {
        var i :| 0 <= i < |waiters| && waiters[i] == w;
        assert 0 < i;
        assert waiters[1..][i - 1] == w && w in waiters[1..];
      }
    }
  } else {
    assert waiters == [head];
    assert head in waiters && (forall w :: w in waiters ==> w.room <= head.room);
  }
}

lemma RoomBatchIncludesHeldRoom(s: MultiRoomLeases, lease: core__concurrency_Lease)
  requires lease in s.queue.leases
  ensures lease.room in heldRooms(s, lease.caller)
{
  RoomBatchHeldProjection(s, lease.caller);
  var candidates := ProofLib.Filter((l: core__concurrency_Lease) => (l.caller == lease.caller), s.queue.leases);
  ProofLib.FilterMember((l: core__concurrency_Lease) => (l.caller == lease.caller), s.queue.leases, lease);
  var i :| 0 <= i < |candidates| && candidates[i] == lease;
  assert heldRooms(s, lease.caller)[i] == lease.room;
}

lemma RoomBatchHeldProjection(s: MultiRoomLeases, caller: int)
  ensures heldRooms(s, caller) ==
    (var matching := ProofLib.Filter((l: core__concurrency_Lease) => (l.caller == caller), s.queue.leases);
      seq(|matching|, i requires 0 <= i < |matching| => matching[i].room))
{}

lemma RoomBatchWaitChainHasRunnableOwner(s: MultiRoomLeases)
  requires alwaysWaiterHasOwner(s) && alwaysLeasesBelongToBatch(s)
  requires alwaysWaiterMatchesNextRoom(s) && alwaysWaitsAboveHeldRooms(s)
  requires |s.queue.waiting| > 0
  ensures (exists c :: c in s.calls && !c.phase.BatchDone? && !c.phase.BatchWaiting?)
{
  RoomBatchLargestWaiter(s.queue.waiting);
  var largest :| largest in s.queue.waiting && (forall w :: w in s.queue.waiting ==> w.room <= largest.room);
  var lease :| lease in s.queue.leases && lease.room == largest.room;
  var owner :| owner in s.calls && owner.id == lease.caller && !owner.phase.BatchDone? && lease.room in owner.wanted;
  if owner.phase.BatchWaiting? {
    RoomBatchIncludesHeldRoom(s, lease);
    var later :| later in s.queue.waiting && later.caller == owner.id && later.room == wantedRoom(owner);
    assert lease.room < wantedRoom(owner) && later.room <= largest.room;
    assert false;
  }
}

lemma RoomBatchIdentityLookup(s: MultiRoomLeases, expected: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && expected in s.calls
  ensures batchAt(s, expected.id) == expected
{
  RoomBatchIdentityProjection(s);
  var byId := (c: BatchLeaseCall) => c.id == expected.id;
  var matches := ProofLib.Filter(byId, s.calls);
  ProofLib.FilterMember(byId, s.calls, expected);
  assert |matches| == 1 && matches[0] == expected;
}

lemma RoomBatchIdentityProjection(s: MultiRoomLeases)
  ensures alwaysBatchIdentitiesUnique(s) == (forall c :: c in s.calls ==>
    c.id > 0 && |ProofLib.Filter((other: BatchLeaseCall) => other.id == c.id, s.calls)| == 1)
{}

lemma RoomBatchNoWaitOutsideWaiting(s: MultiRoomLeases, expected: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && alwaysWaiterMatchesNextRoom(s)
  requires expected in s.calls && !expected.phase.BatchWaiting?
  ensures forall w :: w in s.queue.waiting ==> w.caller != expected.id
{
  RoomBatchIdentityLookup(s, expected);
}

lemma RoomBatchDedupRetains<T>(xs: seq<T>, acc: seq<T>, item: T)
  ensures (item in acc || item in xs) ==>
    item in Std.Collections.Seq.FoldLeft((a: seq<T>, x: T) => if x in a then a else a + [x], acc, xs)
  decreases |xs|
{
  if |xs| > 0 {
    var appendNew := (a: seq<T>, x: T) => if x in a then a else a + [x];
    var prefix := xs[..|xs|-1];
    var last := xs[|xs|-1];
    assert xs == prefix + [last];
    RoomBatchDedupRetains(prefix, acc, item);
    ProofLib.FoldLeftAppend(appendNew, acc, prefix, last);
  }
}

lemma RoomBatchActiveRoomProjection(s: core__concurrency_RoomState)
  ensures forall l :: l in s.leases ==> l.room in core__concurrency_activeRooms(s)
  ensures forall w :: w in s.waiting ==> w.room in core__concurrency_activeRooms(s)
{
  forall l | l in s.leases ensures l.room in core__concurrency_activeRooms(s) {
    var i :| 0 <= i < |s.leases| && s.leases[i] == l;
    var ids := core__concurrency_activeRoomIds(s);
    assert ids[i] == l.room && l.room in ids;
    RoomBatchDedupRetains(ids, [], l.room);
  }
  forall w | w in s.waiting ensures w.room in core__concurrency_activeRooms(s) {
    var i :| 0 <= i < |s.waiting| && s.waiting[i] == w;
    var ids := core__concurrency_activeRoomIds(s);
    assert ids[|s.leases| + i] == w.room && w.room in ids;
    RoomBatchDedupRetains(ids, [], w.room);
  }
}

lemma RoomBatchAcquisitionCanAdvance(s: MultiRoomLeases, c: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && alwaysWaiterMatchesNextRoom(s)
  requires alwaysQueueConfiguredForCalls(s) && alwaysAcquiringQueueAuthority(s) && alwaysWaitsAboveHeldRooms(s)
  requires c in s.calls && c.phase.BatchAcquiring?
  ensures canAdvanceAcquisition(s, c.id)
{
  RoomBatchIdentityLookup(s, c);
  RoomBatchNoWaitOutsideWaiting(s, c);
  RoomBatchActiveRoomProjection(s.queue);
  var room := wantedRoom(c);
  assert c.id > 0 && room > 0;
  if acquisitionFailure(s, c).BatchPending? {
    assert s.queue.configured && !s.queue.closed;
    assert c.id !in s.queue.cancelled && c.id !in s.queue.sealedCallers && c.id !in s.queue.finishedCallers;
    assert |s.queue.waiting| + |s.queue.leases| < s.queue.capacity;
    assert room in core__concurrency_activeRooms(s.queue) || |core__concurrency_activeRooms(s.queue)| < s.queue.maxRooms;
    assert roomDepth(s, room) < s.queue.maxPerRoom;
    assert core__concurrency_roomOccupancy(s.queue, room) < s.queue.maxPerRoom;
    forall l | l in s.queue.leases && l.caller == c.id ensures l.room < room {
      RoomBatchIncludesHeldRoom(s, l);
    }
    assert core__concurrency_canQueueRoom(s.queue, c.id, room);
  }
}

lemma RoomBatchAscendingFold(rooms: seq<int>, start: HeldRoomOrder)
  ensures Std.Collections.Seq.FoldLeft((a: HeldRoomOrder, r: int) => HeldRoomOrder(r, a.ascending && a.previous < r), start, rooms).previous ==
    (if |rooms| == 0 then start.previous else rooms[|rooms|-1])
  ensures Std.Collections.Seq.FoldLeft((a: HeldRoomOrder, r: int) => HeldRoomOrder(r, a.ascending && a.previous < r), start, rooms).ascending ==>
    (start.ascending &&
      (forall i :: 0 <= i < |rooms| ==> start.previous < rooms[i]) &&
      (forall i, j :: 0 <= i < j < |rooms| ==> rooms[i] < rooms[j]))
  decreases |rooms|
{
  if |rooms| > 0 {
    var localStep := (a: HeldRoomOrder, r: int) => HeldRoomOrder(r, a.ascending && a.previous < r);
    var prefix := rooms[..|rooms|-1];
    var last := rooms[|rooms|-1];
    assert rooms == prefix + [last];
    RoomBatchAscendingFold(prefix, start);
    ProofLib.FoldLeftAppend(localStep, start, prefix, last);
    var partial := Std.Collections.Seq.FoldLeft(localStep, start, prefix);
    if partial.ascending && partial.previous < last {
      forall i | 0 <= i < |rooms| ensures start.previous < rooms[i] {
        if i == |prefix| {
          if |prefix| > 0 { assert start.previous < prefix[|prefix|-1] == partial.previous; }
        } else {
          assert prefix[i] == rooms[i];
        }
      }
      forall i, j | 0 <= i < j < |rooms| ensures rooms[i] < rooms[j] {
        if j == |prefix| {
          assert partial.previous == prefix[|prefix|-1];
          if i < |prefix|-1 { assert prefix[i] < partial.previous; }
        } else {
          assert rooms[i] == prefix[i] && rooms[j] == prefix[j];
        }
      }
    }
  }
}

lemma RoomBatchReleaseAuthority(s: MultiRoomLeases, c: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && alwaysWaiterMatchesNextRoom(s)
  requires alwaysReverseReleaseRank(s) && alwaysQueueInvariant(s)
  requires c in s.calls && c.phase.BatchReleasing?
  ensures canFinishBatch(s, c.id) || canCloseBatchWrites(s, c.id) || canReleaseBatchRoom(s, c.id) ||
    (exists item :: item in s.queue.leases && !item.acceptingWrites && item.writes > 0)
{
  RoomBatchIdentityLookup(s, c);
  RoomBatchNoWaitOutsideWaiting(s, c);
  var rooms := heldRooms(s, c.id);
  if |rooms| > 0 {
    var room := releaseRoomId(s, c.id);
    assert room == rooms[|rooms|-1];
    RoomBatchHeldProjection(s, c.id);
    RoomBatchAscendingFold(rooms, emptyHeldRoomOrder);
    var selected := ProofLib.Filter((l: core__concurrency_Lease) => l.caller == c.id, s.queue.leases);
    assert |selected| == |rooms|;
    var lease := selected[|selected|-1];
    ProofLib.FilterMember((l: core__concurrency_Lease) => l.caller == c.id, s.queue.leases, lease);
    assert lease in s.queue.leases && lease.caller == c.id && lease.room == room;
    if lease.acceptingWrites {
      assert core__concurrency_canCloseWrites(s.queue, c.id, room);
    } else if lease.writes == 0 {
      forall l | l in s.queue.leases && l.caller == c.id ensures l.room <= room {
        RoomBatchIncludesHeldRoom(s, l);
        var i :| 0 <= i < |rooms| && rooms[i] == l.room;
        assert rooms[i] <= rooms[|rooms|-1];
      }
      assert core__concurrency_canReleaseRoom(s.queue, c.id, room);
    } else {
      assert lease.writes > 0;
    }
  }
}

lemma RoomBatchEnableScheduler(s: MultiRoomLeases, c: BatchLeaseCall)
  requires c in s.calls
  requires canAdvanceAcquisition(s, c.id) || canReturnBody(s, c.id, 0) || canFinishBatch(s, c.id) || canCloseBatchWrites(s, c.id) || canReleaseBatchRoom(s, c.id)
  ensures batchProgressEnabled(s)
{
  if canAdvanceAcquisition(s, c.id) {
    var canRun := (x: BatchLeaseCall) => canAdvanceAcquisition(s, x.id);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextAcquisition(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  } else if canReturnBody(s, c.id, 0) {
    var canRun := (x: BatchLeaseCall) => canReturnBody(s, x.id, 0);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextBody(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  } else if canFinishBatch(s, c.id) {
    var canRun := (x: BatchLeaseCall) => canFinishBatch(s, x.id);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextFinishedBatch(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  } else if canCloseBatchWrites(s, c.id) {
    var canRun := (x: BatchLeaseCall) => canCloseBatchWrites(s, x.id);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextWriteClosure(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  } else {
    var canRun := (x: BatchLeaseCall) => canReleaseBatchRoom(s, x.id);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextRelease(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  }
}

lemma RoomBatchProgress(s: MultiRoomLeases)
  requires alwaysBatchIdentitiesUnique(s) && alwaysWaiterMatchesNextRoom(s) && alwaysQueueInvariant(s)
  requires alwaysQueueConfiguredForCalls(s) && alwaysAcquiringQueueAuthority(s) && alwaysWaitsAboveHeldRooms(s)
  requires alwaysReverseReleaseRank(s) && alwaysLeasesBelongToBatch(s) && alwaysWaiterHasOwner(s)
  ensures alwaysBatchProgressOrTerminal(s)
{
  if !batchTerminal(s) {
    if |s.queue.waiting| > 0 {
      RoomBatchWaitChainHasRunnableOwner(s);
    } else if |s.queue.leases| > 0 {
      var lease := s.queue.leases[0];
      assert lease in s.queue.leases;
      var owner :| owner in s.calls && owner.id == lease.caller && !owner.phase.BatchDone? && lease.room in owner.wanted;
      assert !owner.phase.BatchWaiting?;
    }
    var c :| c in s.calls && !c.phase.BatchDone? && !c.phase.BatchWaiting?;
    if c.phase.BatchAcquiring? {
      RoomBatchAcquisitionCanAdvance(s, c);
    } else if c.phase.BatchInvoking? {
      RoomBatchIdentityLookup(s, c);
      assert canReturnBody(s, c.id, 0);
    } else {
      RoomBatchReleaseAuthority(s, c);
    }
    if exists item :: item in s.queue.leases && !item.acceptingWrites && item.writes > 0 {
      var item :| item in s.queue.leases && !item.acceptingWrites && item.writes > 0;
      var canRun := (l: core__concurrency_Lease) => !l.acceptingWrites && l.writes > 0;
      var ready := ProofLib.Filter(canRun, s.queue.leases);
      ProofLib.FilterMember(canRun, s.queue.leases, item);
      assert |ready| > 0 && closingWriter(s) == ready[0];
      ProofLib.FilterMember(canRun, s.queue.leases, ready[0]);
      assert core__concurrency_canFinishWrite(s.queue, ready[0].caller, ready[0].room);
    } else {
      RoomBatchEnableScheduler(s, c);
    }
  }
}

lemma RoomBatchFilterFilter<T>(p: T -> bool, q: T -> bool, r: T -> bool, xs: seq<T>)
  requires forall x :: r(x) == (p(x) && q(x))
  ensures ProofLib.Filter(p, ProofLib.Filter(q, xs)) == ProofLib.Filter(r, xs)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(q, xs);
    ProofLib.FilterNil(r, xs);
    ProofLib.FilterNil(p, ProofLib.Filter(q, xs));
  } else {
    var init := xs[..|xs|-1];
    var last := xs[|xs|-1];
    assert xs == init + [last];
    RoomBatchFilterFilter(p, q, r, init);
    ProofLib.FilterAppend(q, init, last);
    ProofLib.FilterAppend(r, init, last);
    if q(last) {
      ProofLib.FilterAppend(p, ProofLib.Filter(q, init), last);
    } else {
      assert ProofLib.Filter(q, xs) == ProofLib.Filter(q, init);
      assert !r(last);
    }
  }
}

lemma RoomBatchFilterSorted<T>(p: T -> bool, xs: seq<T>, key: T -> int)
  requires forall i, j :: 0 <= i < j < |xs| ==> key(xs[i]) < key(xs[j])
  ensures forall i, j :: 0 <= i < j < |ProofLib.Filter(p, xs)| ==> key(ProofLib.Filter(p, xs)[i]) < key(ProofLib.Filter(p, xs)[j])
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    RoomBatchFilterSorted(p, xs[1..], key);
    var rest := ProofLib.Filter(p, xs[1..]);
    forall y | y in rest ensures key(xs[0]) < key(y) {
      ProofLib.FilterMember(p, xs[1..], y);
      var j :| 0 <= j < |xs[1..]| && xs[1..][j] == y;
      assert xs[j + 1] == y;
    }
    var all := ProofLib.Filter(p, xs);
    forall i, j | 0 <= i < j < |all| ensures key(all[i]) < key(all[j]) {
      if p(xs[0]) {
        if i == 0 {
          assert all[j] == rest[j - 1] && rest[j - 1] in rest;
        } else {
          assert all[i] == rest[i - 1] && all[j] == rest[j - 1];
        }
      } else {
        assert all == rest;
      }
    }
  }
}

lemma RoomBatchSortedBelow(a: seq<int>, b: seq<int>, k: int)
  requires |a| == |b| && 0 <= k <= |a|
  requires forall i, j :: 0 <= i < j < |a| ==> a[i] < a[j]
  requires forall i, j :: 0 <= i < j < |b| ==> b[i] < b[j]
  requires forall x :: x in a ==> x in b
  ensures forall i :: 0 <= i < k ==> a[i] >= b[i]
  decreases k
{
  if k > 0 {
    RoomBatchSortedBelow(a, b, k - 1);
    var i := k - 1;
    assert a[i] in a;
    var j :| 0 <= j < |b| && b[j] == a[i];
    if i > 0 {
      assert a[i - 1] < a[i] && a[i - 1] >= b[i - 1];
      if j < i - 1 { assert b[j] < b[i - 1]; }
    }
    if j > i { assert b[i] < b[j]; }
  }
}

lemma RoomBatchSortedAbove(a: seq<int>, b: seq<int>, k: int)
  requires |a| == |b| && 0 <= k <= |a|
  requires forall i, j :: 0 <= i < j < |a| ==> a[i] < a[j]
  requires forall i, j :: 0 <= i < j < |b| ==> b[i] < b[j]
  requires forall x :: x in a ==> x in b
  ensures forall i :: k <= i < |a| ==> a[i] <= b[i]
  decreases |a| - k
{
  if k < |a| {
    RoomBatchSortedAbove(a, b, k + 1);
    assert a[k] in a;
    var j :| 0 <= j < |b| && b[j] == a[k];
    if k + 1 < |a| {
      assert a[k] < a[k + 1] && a[k + 1] <= b[k + 1];
      if j > k + 1 { assert b[k + 1] < b[j]; }
    }
    if j < k { assert b[j] < b[k]; }
  }
}

lemma RoomBatchSortedEqual(a: seq<int>, b: seq<int>)
  requires |a| == |b|
  requires forall i, j :: 0 <= i < j < |a| ==> a[i] < a[j]
  requires forall i, j :: 0 <= i < j < |b| ==> b[i] < b[j]
  requires forall x :: x in a ==> x in b
  ensures a == b
{
  RoomBatchSortedBelow(a, b, |a|);
  RoomBatchSortedAbove(a, b, 0);
}

lemma RoomBatchRanks(rooms: seq<int>)
  ensures roomRanksAscending(rooms) <==>
    ((forall i :: 0 <= i < |rooms| ==> 0 < rooms[i]) && (forall i, j :: 0 <= i < j < |rooms| ==> rooms[i] < rooms[j]))
  decreases |rooms|
{
  RoomBatchAscendingFold(rooms, emptyHeldRoomOrder);
  if |rooms| > 0 {
    var localStep := (order: HeldRoomOrder, room: int) => HeldRoomOrder(room, (order.ascending && (order.previous < room)));
    var prefix := rooms[..|rooms|-1];
    var last := rooms[|rooms|-1];
    assert rooms == prefix + [last];
    RoomBatchRanks(prefix);
    RoomBatchAscendingFold(prefix, emptyHeldRoomOrder);
    ProofLib.FoldLeftAppend(localStep, emptyHeldRoomOrder, prefix, last);
    if (forall i :: 0 <= i < |rooms| ==> 0 < rooms[i]) && (forall i, j :: 0 <= i < j < |rooms| ==> rooms[i] < rooms[j]) {
      assert forall i :: 0 <= i < |prefix| ==> prefix[i] == rooms[i];
      if |prefix| > 0 { assert prefix[|prefix|-1] < last; }
    }
  }
}

lemma RoomBatchAscendingAppend(rooms: seq<int>, room: int)
  requires roomRanksAscending(rooms) && 0 < room
  requires forall r :: r in rooms ==> r < room
  ensures roomRanksAscending(rooms + [room])
{
  RoomBatchRanks(rooms);
  RoomBatchRanks(rooms + [room]);
  var all := rooms + [room];
  forall i, j | 0 <= i < j < |all| ensures all[i] < all[j] {
    if j == |rooms| { assert all[i] == rooms[i] && rooms[i] in rooms; }
  }
}

lemma RoomBatchAtView(s: MultiRoomLeases, caller: int)
  ensures batchAt(s, caller) == (var m := ProofLib.Filter((c: BatchLeaseCall) => (c.id == caller), s.calls); if |m| > 0 then m[0] else noLeaseCall)
{}

lemma RoomBatchInsertView(ordered: seq<int>, room: int)
  ensures insertRoom(ordered, room) == (if room in ordered then ordered else
    ((ProofLib.Filter((r: int) => (r < room), ordered) + [room]) + ProofLib.Filter((r: int) => (r > room), ordered)))
{}

lemma RoomBatchInsertSorted(ordered: seq<int>, room: int)
  requires roomRanksAscending(ordered) && 0 < room
  ensures roomRanksAscending(insertRoom(ordered, room)) && room in insertRoom(ordered, room)
{
  RoomBatchInsertView(ordered, room);
  RoomBatchRanks(ordered);
  if room !in ordered {
    var below := (r: int) => (r < room);
    var above := (r: int) => (r > room);
    var lo := ProofLib.Filter(below, ordered);
    var hi := ProofLib.Filter(above, ordered);
    RoomBatchFilterSorted(below, ordered, (x: int) => x);
    RoomBatchFilterSorted(above, ordered, (x: int) => x);
    forall x | x in lo ensures 0 < x < room { ProofLib.FilterMember(below, ordered, x); }
    forall x | x in hi ensures room < x { ProofLib.FilterMember(above, ordered, x); }
    var all := (lo + [room]) + hi;
    forall i, j | 0 <= i < j < |all| ensures all[i] < all[j] {
      if j < |lo| {
      } else if j == |lo| {
        assert all[i] == lo[i] && lo[i] in lo;
      } else if i < |lo| {
        assert all[i] == lo[i] && lo[i] in lo && all[j] == hi[j - |lo| - 1] && hi[j - |lo| - 1] in hi;
      } else if i == |lo| {
        assert all[j] == hi[j - |lo| - 1] && hi[j - |lo| - 1] in hi;
      } else {
        assert all[i] == hi[i - |lo| - 1] && all[j] == hi[j - |lo| - 1];
      }
    }
    forall i | 0 <= i < |all| ensures 0 < all[i] {
      if i < |lo| { assert all[i] in lo; } else if i > |lo| { assert all[i] == hi[i - |lo| - 1] && hi[i - |lo| - 1] in hi; }
    }
    RoomBatchRanks(all);
  }
}

lemma RoomBatchOrderedRooms(rooms: seq<int>)
  requires forall r :: r in rooms ==> r > 0
  ensures roomRanksAscending(orderedRooms(rooms))
  ensures |rooms| > 0 ==> |orderedRooms(rooms)| > 0
  decreases |rooms|
{
  if |rooms| == 0 {
    RoomBatchRanks(orderedRooms(rooms));
  } else {
    var prefix := rooms[..|rooms|-1];
    var last := rooms[|rooms|-1];
    assert rooms == prefix + [last];
    assert last in rooms;
    assert forall r :: r in prefix ==> r in rooms;
    RoomBatchOrderedRooms(prefix);
    ProofLib.FoldLeftAppend((ordered: seq<int>, room: int) => insertRoom(ordered, room), [], prefix, last);
    RoomBatchInsertSorted(orderedRooms(prefix), last);
  }
}

lemma RoomBatchHeldSame(s: MultiRoomLeases, t: MultiRoomLeases)
  requires |t.queue.leases| == |s.queue.leases|
  requires forall i :: 0 <= i < |s.queue.leases| ==> t.queue.leases[i].caller == s.queue.leases[i].caller && t.queue.leases[i].room == s.queue.leases[i].room
  ensures forall caller :: heldRooms(t, caller) == heldRooms(s, caller)
{
  forall caller ensures heldRooms(t, caller) == heldRooms(s, caller) {
    var p := (l: core__concurrency_Lease) => (l.caller == caller);
    ProofLib.FilterPointwise(p, p, (a: core__concurrency_Lease, b: core__concurrency_Lease) => a.room == b.room, s.queue.leases, t.queue.leases);
    RoomBatchHeldProjection(s, caller);
    RoomBatchHeldProjection(t, caller);
  }
}

lemma RoomBatchHeldAppend(s: MultiRoomLeases, t: MultiRoomLeases, lease: core__concurrency_Lease)
  requires t.queue.leases == s.queue.leases + [lease]
  ensures forall caller :: heldRooms(t, caller) == heldRooms(s, caller) + (if lease.caller == caller then [lease.room] else [])
{
  forall caller ensures heldRooms(t, caller) == heldRooms(s, caller) + (if lease.caller == caller then [lease.room] else []) {
    ProofLib.FilterAppend((l: core__concurrency_Lease) => (l.caller == caller), s.queue.leases, lease);
    RoomBatchHeldProjection(s, caller);
    RoomBatchHeldProjection(t, caller);
  }
}

lemma RoomBatchHeldRelease(s: MultiRoomLeases, t: MultiRoomLeases, caller: int, room: int)
  requires t.queue.leases == ProofLib.Filter((l: core__concurrency_Lease) => ((l.caller != caller) || (l.room != room)), s.queue.leases)
  ensures forall other :: other != caller ==> heldRooms(t, other) == heldRooms(s, other)
  ensures roomRanksAscending(heldRooms(s, caller)) ==> roomRanksAscending(heldRooms(t, caller))
{
  var keep := (l: core__concurrency_Lease) => ((l.caller != caller) || (l.room != room));
  forall other | other != caller ensures heldRooms(t, other) == heldRooms(s, other) {
    var mine := (l: core__concurrency_Lease) => (l.caller == other);
    RoomBatchFilterFilter(mine, keep, mine, s.queue.leases);
    RoomBatchHeldProjection(s, other);
    RoomBatchHeldProjection(t, other);
  }
  var mine := (l: core__concurrency_Lease) => (l.caller == caller);
  var notRoom := (l: core__concurrency_Lease) => (l.room != room);
  var both := (l: core__concurrency_Lease) => (l.caller == caller && l.room != room);
  RoomBatchFilterFilter(mine, keep, both, s.queue.leases);
  RoomBatchFilterFilter(notRoom, mine, both, s.queue.leases);
  RoomBatchHeldProjection(s, caller);
  RoomBatchHeldProjection(t, caller);
  if roomRanksAscending(heldRooms(s, caller)) {
    var before := ProofLib.Filter(mine, s.queue.leases);
    var after := ProofLib.Filter(notRoom, before);
    RoomBatchRanks(heldRooms(s, caller));
    assert forall i :: 0 <= i < |before| ==> before[i].room == heldRooms(s, caller)[i];
    RoomBatchFilterSorted(notRoom, before, (l: core__concurrency_Lease) => l.room);
    forall i | 0 <= i < |after| ensures 0 < after[i].room {
      assert after[i] in after;
      ProofLib.FilterMember(notRoom, before, after[i]);
      var j :| 0 <= j < |before| && before[j] == after[i];
    }
    RoomBatchRanks(heldRooms(t, caller));
  }
}

lemma RoomBatchWaiterUnique(q: core__concurrency_RoomState, a: core__concurrency_RoomWaiter, b: core__concurrency_RoomWaiter)
  requires core__concurrency_alwaysWaitersUnique(q) && a in q.waiting && b in q.waiting
  ensures (a.caller == b.caller || a.ticket == b.ticket) ==> a == b
{
  var byCaller := (x: core__concurrency_RoomWaiter) => (x.caller == a.caller);
  var byTicket := (x: core__concurrency_RoomWaiter) => (x.ticket == a.ticket);
  ProofLib.FilterMember(byCaller, q.waiting, a);
  ProofLib.FilterMember(byCaller, q.waiting, b);
  ProofLib.FilterMember(byTicket, q.waiting, a);
  ProofLib.FilterMember(byTicket, q.waiting, b);
  assert |ProofLib.Filter(byCaller, q.waiting)| == 1 && |ProofLib.Filter(byTicket, q.waiting)| == 1;
}

lemma RoomBatchCallsReplaced(s: MultiRoomLeases, t: MultiRoomLeases, caller: int, next: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && caller > 0 && batchAt(s, caller).id == caller && next.id == caller
  requires |t.calls| == |s.calls|
  requires forall i :: 0 <= i < |s.calls| ==> t.calls[i] == (if s.calls[i].id == caller then next else s.calls[i])
  ensures alwaysBatchIdentitiesUnique(t)
  ensures batchAt(s, caller) in s.calls
  ensures forall other :: other != caller ==> batchAt(t, other) == batchAt(s, other)
  ensures batchAt(t, caller) == next && next in t.calls
  ensures forall c :: c in t.calls ==> c == next || (c in s.calls && c.id != caller)
  ensures forall c :: c in s.calls && c.id != caller ==> c in t.calls
{
  RoomBatchIdentityProjection(s);
  RoomBatchIdentityProjection(t);
  forall c | c in t.calls ensures c == next || (c in s.calls && c.id != caller) {
    var i :| 0 <= i < |t.calls| && t.calls[i] == c;
    assert s.calls[i] in s.calls;
  }
  forall c | c in s.calls && c.id != caller ensures c in t.calls {
    var i :| 0 <= i < |s.calls| && s.calls[i] == c;
    assert t.calls[i] == c;
  }
  forall c | c in t.calls ensures c.id > 0 && |ProofLib.Filter((other: BatchLeaseCall) => other.id == c.id, t.calls)| == 1 {
    var i :| 0 <= i < |t.calls| && t.calls[i] == c;
    var p := (other: BatchLeaseCall) => other.id == c.id;
    ProofLib.FilterLengthPointwise(p, p, s.calls, t.calls);
    assert s.calls[i] in s.calls && s.calls[i].id == c.id;
  }
  forall other ensures batchAt(t, other) == (if other == caller then next else batchAt(s, other)) {
    var p := (c: BatchLeaseCall) => (c.id == other);
    ProofLib.FilterPointwise(p, p, (a: BatchLeaseCall, b: BatchLeaseCall) => a.id == other ==> b == (if other == caller then next else a), s.calls, t.calls);
    RoomBatchAtView(s, other);
    RoomBatchAtView(t, other);
    var m := ProofLib.Filter(p, s.calls);
    if |m| > 0 { ProofLib.FilterMember(p, s.calls, m[0]); }
  }
  var p := (c: BatchLeaseCall) => (c.id == caller);
  RoomBatchAtView(s, caller);
  RoomBatchAtView(t, caller);
  ProofLib.FilterSubset(p, s.calls);
  ProofLib.FilterSubset(p, t.calls);
}

lemma RoomBatchLeaseFrame(s: MultiRoomLeases, t: MultiRoomLeases)
  requires inv(s) && alwaysQueueInvariant(t)
  requires t.calls == s.calls && t.nested == s.nested && t.queue.waiting == s.queue.waiting
  requires t.queue.cancelled == s.queue.cancelled && t.queue.sealedCallers == s.queue.sealedCallers
  requires t.queue.finishedCallers == s.queue.finishedCallers && (s.queue.configured ==> t.queue.configured)
  requires |t.queue.leases| == |s.queue.leases|
  requires forall i :: 0 <= i < |s.queue.leases| ==> t.queue.leases[i].caller == s.queue.leases[i].caller && t.queue.leases[i].room == s.queue.leases[i].room
  ensures inv(t)
  ensures forall l :: l in s.queue.leases ==> exists a :: a in t.queue.leases && a.caller == l.caller && a.room == l.room
{
  RoomBatchHeldSame(s, t);
  assert forall caller :: batchAt(t, caller) == batchAt(s, caller);
  forall l | l in t.queue.leases ensures exists c :: c in t.calls && c.id == l.caller && !c.phase.BatchDone? && l.room in c.wanted {
    var i :| 0 <= i < |t.queue.leases| && t.queue.leases[i] == l;
    assert s.queue.leases[i] in s.queue.leases;
  }
  forall w | w in t.queue.waiting ensures exists l :: l in t.queue.leases && l.room == w.room {
    var l :| l in s.queue.leases && l.room == w.room;
    var i :| 0 <= i < |s.queue.leases| && s.queue.leases[i] == l;
    assert t.queue.leases[i] in t.queue.leases;
  }
  forall l | l in s.queue.leases ensures exists a :: a in t.queue.leases && a.caller == l.caller && a.room == l.room {
    var i :| 0 <= i < |s.queue.leases| && s.queue.leases[i] == l;
    assert t.queue.leases[i] in t.queue.leases;
  }
  assert alwaysHeldPrefixMatchesRequests(t);
  assert alwaysInvocationHoldsAllRooms(t);
  assert alwaysWaiterMatchesNextRoom(t);
  assert alwaysWaitsAboveHeldRooms(t);
  assert alwaysDoneHasNoLease(t);
  assert alwaysReverseReleaseRank(t);
  RoomBatchProgress(t);
}

lemma RoomBatchCallFrame(s: MultiRoomLeases, t: MultiRoomLeases, caller: int, next: BatchLeaseCall)
  requires inv(s) && t.queue == s.queue && t.nested == s.nested
  requires caller > 0 && batchAt(s, caller).id == caller && next.id == caller
  requires |t.calls| == |s.calls|
  requires forall i :: 0 <= i < |s.calls| ==> t.calls[i] == (if s.calls[i].id == caller then next else s.calls[i])
  requires next.wanted == batchAt(s, caller).wanted && 0 <= next.position <= |next.wanted|
  requires (next.phase.BatchReleasing? || next.phase.BatchDone?) == !next.resultKind.BatchPending?
  requires (next.phase.BatchAcquiring? || next.phase.BatchWaiting? || next.phase.BatchInvoking?) ==>
    next.phase == batchAt(s, caller).phase && next.position == batchAt(s, caller).position
  requires batchAt(s, caller).phase.BatchWaiting? ==> next.phase.BatchWaiting?
  requires next.phase.BatchDone? ==> |heldRooms(s, caller)| == 0 && !(exists w :: w in s.queue.waiting && w.caller == caller)
  ensures inv(t)
{
  var old_ := batchAt(s, caller);
  RoomBatchCallsReplaced(s, t, caller, next);
  assert forall x :: heldRooms(t, x) == heldRooms(s, x);
  assert next.position == old_.position ==> wantedRoom(next) == wantedRoom(old_);
  forall x | x in t.queue.cancelled ensures exists c :: c in t.calls && c.id == x {
    var c :| c in s.calls && c.id == x;
    if c.id == caller { assert next in t.calls; } else { assert c in t.calls; }
  }
  forall l | l in t.queue.leases ensures exists c :: c in t.calls && c.id == l.caller && !c.phase.BatchDone? && l.room in c.wanted {
    var c :| c in s.calls && c.id == l.caller && !c.phase.BatchDone? && l.room in c.wanted;
    if c.id == caller {
      RoomBatchIdentityLookup(s, c);
      RoomBatchIncludesHeldRoom(s, l);
      assert next in t.calls;
    } else {
      assert c in t.calls;
    }
  }
  forall w | w in t.queue.waiting ensures batchAt(t, w.caller).phase.BatchWaiting? && wantedRoom(batchAt(t, w.caller)) == w.room {
    if w.caller == caller { assert next.phase.BatchWaiting?; }
  }
  forall c | c in t.calls && c.phase.BatchWaiting? ensures exists w :: w in t.queue.waiting && w.caller == c.id && w.room == wantedRoom(c) {
    if c == next { assert old_ in s.calls && old_.phase.BatchWaiting?; }
  }
  forall c | c in t.calls && c.phase.BatchDone? ensures |heldRooms(t, c.id)| == 0 && !(exists w :: w in t.queue.waiting && w.caller == c.id) && !c.resultKind.BatchPending? {
    if c != next { assert c in s.calls; }
  }
  forall c | c in t.calls ensures roomRanksAscending(c.wanted) && roomRanksAscending(heldRooms(t, c.id)) {
    if c == next { assert old_ in s.calls; } else { assert c in s.calls; }
  }
  forall c | c in t.calls ensures (0 <= c.position && c.position <= |c.wanted| && (!(c.phase.BatchAcquiring? || c.phase.BatchWaiting?) || c.position < |c.wanted|)) && ((c.phase.BatchReleasing? || c.phase.BatchDone?) == !c.resultKind.BatchPending?) {
    if c == next { assert old_ in s.calls; } else { assert c in s.calls; }
  }
  forall c | c in t.calls && (c.phase.BatchAcquiring? || c.phase.BatchWaiting?) ensures |heldRooms(t, c.id)| == c.position && (forall r :: r in heldRooms(t, c.id) ==> r in c.wanted) && wantedRoom(c) > 0 && (forall r :: r in heldRooms(t, c.id) ==> r < wantedRoom(c)) && (c.phase.BatchAcquiring? ==> c.id !in t.queue.cancelled) {
    if c == next { assert old_ in s.calls; } else { assert c in s.calls; }
  }
  forall c | c in t.calls && c.phase.BatchInvoking? ensures heldRooms(t, c.id) == c.wanted && c.position == |c.wanted| {
    if c == next { assert old_ in s.calls; } else { assert c in s.calls; }
  }
  assert alwaysRequestedRoomsAscending(t);
  assert alwaysBatchesHaveValidPosition(t);
  assert alwaysStoredResultFollowsPhase(t);
  assert alwaysHeldPrefixMatchesRequests(t);
  assert alwaysInvocationHoldsAllRooms(t);
  assert alwaysWaiterMatchesNextRoom(t);
  assert alwaysWaitsAboveHeldRooms(t);
  assert alwaysDoneHasNoLease(t);
  assert alwaysAcquiringQueueAuthority(t);
  assert alwaysReverseReleaseRank(t);
  RoomBatchProgress(t);
}

lemma RoomBatchGrantedCalls(u: MultiRoomLeases, t: MultiRoomLeases, c: BatchLeaseCall, next: BatchLeaseCall, room: int)
  requires alwaysRequestedRoomsAscending(u) && alwaysBatchesHaveValidPosition(u) && alwaysStoredResultFollowsPhase(u)
  requires alwaysHeldPrefixMatchesRequests(u) && alwaysInvocationHoldsAllRooms(u) && alwaysWaitsAboveHeldRooms(u)
  requires alwaysDoneHasNoLease(u) && alwaysAcquiringQueueAuthority(u) && alwaysReverseReleaseRank(u)
  requires c in u.calls && c.phase.BatchWaiting? && wantedRoom(c) == room && c.id !in u.queue.cancelled
  requires next == c.(position := (c.position + 1), phase := (if ((c.position + 1) == |c.wanted|) then BatchLeasePhase.BatchInvoking else BatchLeasePhase.BatchAcquiring))
  requires forall d :: d in t.calls ==> d == next || (d in u.calls && d.id != c.id)
  requires forall d :: d in u.calls && d.id != c.id ==> d in t.calls
  requires forall y :: heldRooms(t, y) == heldRooms(u, y) + (if c.id == y then [room] else [])
  requires forall w :: w in t.queue.waiting ==> w in u.queue.waiting
  requires t.queue.cancelled == u.queue.cancelled && t.queue.sealedCallers == u.queue.sealedCallers && t.queue.finishedCallers == u.queue.finishedCallers
  ensures alwaysRequestedRoomsAscending(t) && alwaysBatchesHaveValidPosition(t) && alwaysStoredResultFollowsPhase(t)
  ensures alwaysHeldPrefixMatchesRequests(t) && alwaysInvocationHoldsAllRooms(t) && alwaysWaitsAboveHeldRooms(t)
  ensures alwaysDoneHasNoLease(t) && alwaysAcquiringQueueAuthority(t) && alwaysReverseReleaseRank(t)
{
  var held := heldRooms(u, c.id);
  assert heldRooms(t, c.id) == held + [room];
  RoomBatchRanks(c.wanted);
  RoomBatchRanks(held);
  assert room == c.wanted[c.position] && room in c.wanted && 0 < room;
  assert |held| == c.position && (forall r :: r in held ==> r in c.wanted && r < room);
  RoomBatchAscendingAppend(held, room);
  RoomBatchRanks(held + [room]);
  if next.phase.BatchInvoking? {
    RoomBatchSortedEqual(held + [room], c.wanted);
  } else {
    assert wantedRoom(next) == c.wanted[c.position + 1] && room < wantedRoom(next);
  }
  forall d | d in t.calls && d != next ensures d in u.calls && heldRooms(t, d.id) == heldRooms(u, d.id) {
  }
  assert alwaysRequestedRoomsAscending(t);
  assert alwaysBatchesHaveValidPosition(t);
  assert alwaysStoredResultFollowsPhase(t);
  assert alwaysHeldPrefixMatchesRequests(t);
  assert alwaysInvocationHoldsAllRooms(t);
  assert alwaysWaitsAboveHeldRooms(t);
  assert alwaysDoneHasNoLease(t);
  assert alwaysAcquiringQueueAuthority(t);
  assert alwaysReverseReleaseRank(t);
}

lemma RoomBatchGrantedQueue(u: MultiRoomLeases, t: MultiRoomLeases, g: core__concurrency_RoomWaiter, c: BatchLeaseCall, next: BatchLeaseCall)
  requires alwaysCancelledCallersOpened(u) && alwaysBatchIdentitiesUnique(u) && alwaysLeasesBelongToBatch(u) && alwaysWaiterMatchesNextRoom(u)
  requires g in u.queue.waiting && c in u.calls && c.id == g.caller && wantedRoom(c) == g.room && 0 <= c.position < |c.wanted|
  requires next.id == c.id && next.wanted == c.wanted && !next.phase.BatchDone? && !next.phase.BatchWaiting?
  requires forall w :: w in u.queue.waiting && w.room != g.room ==> exists l :: l in u.queue.leases && l.room == w.room
  requires t.queue.cancelled == u.queue.cancelled
  requires t.queue.leases == u.queue.leases + [core__concurrency_Lease(g.caller, g.room, true, 0)]
  requires forall w :: w in t.queue.waiting ==> w in u.queue.waiting && w.caller != g.caller
  requires forall w :: w in u.queue.waiting && w.caller != g.caller ==> w in t.queue.waiting
  requires forall other :: other != c.id ==> batchAt(t, other) == batchAt(u, other)
  requires next in t.calls && forall d :: d in t.calls ==> d == next || (d in u.calls && d.id != c.id)
  requires forall d :: d in u.calls && d.id != c.id ==> d in t.calls
  ensures alwaysCancelledCallersOpened(t) && alwaysLeasesBelongToBatch(t) && alwaysWaiterHasOwner(t) && alwaysWaiterMatchesNextRoom(t)
{
  assert c.wanted[c.position] == g.room;
  forall x | x in t.queue.cancelled ensures exists d :: d in t.calls && d.id == x {
    var d :| d in u.calls && d.id == x;
    if d.id != c.id { assert d in t.calls; }
  }
  forall l | l in t.queue.leases ensures exists d :: d in t.calls && d.id == l.caller && !d.phase.BatchDone? && l.room in d.wanted {
    if l in u.queue.leases {
      var d :| d in u.calls && d.id == l.caller && !d.phase.BatchDone? && l.room in d.wanted;
      if d.id == c.id { RoomBatchIdentityLookup(u, d); RoomBatchIdentityLookup(u, c); } else { assert d in t.calls; }
    } else {
      assert l.caller == next.id && l.room in next.wanted;
    }
  }
  forall w | w in t.queue.waiting ensures exists l :: l in t.queue.leases && l.room == w.room {
    if w.room == g.room { assert core__concurrency_Lease(g.caller, g.room, true, 0) in t.queue.leases; } else {
      var l :| l in u.queue.leases && l.room == w.room;
      assert l in t.queue.leases;
    }
  }
  forall d | d in t.calls && d.phase.BatchWaiting? ensures exists w :: w in t.queue.waiting && w.caller == d.id && w.room == wantedRoom(d) {
    var w :| w in u.queue.waiting && w.caller == d.id && w.room == wantedRoom(d);
    assert w in t.queue.waiting;
  }
  assert alwaysWaiterMatchesNextRoom(t);
}

lemma RoomBatchGrant(u: MultiRoomLeases, room: int)
  requires alwaysRequestedRoomsAscending(u) && alwaysCancelledCallersOpened(u) && alwaysNestedReuseExact(u)
  requires alwaysQueueInvariant(u) && alwaysBatchIdentitiesUnique(u) && alwaysBatchesHaveValidPosition(u)
  requires alwaysStoredResultFollowsPhase(u) && alwaysQueueConfiguredForCalls(u) && alwaysLeasesBelongToBatch(u)
  requires alwaysHeldPrefixMatchesRequests(u) && alwaysInvocationHoldsAllRooms(u) && alwaysWaiterMatchesNextRoom(u)
  requires alwaysWaitsAboveHeldRooms(u) && alwaysDoneHasNoLease(u) && alwaysAcquiringQueueAuthority(u) && alwaysReverseReleaseRank(u)
  requires forall w :: w in u.queue.waiting && w.room != room ==> exists l :: l in u.queue.leases && l.room == w.room
  ensures inv(grantAvailable(room, u))
  ensures grantAvailable(room, u).nested == u.nested && grantAvailable(room, u).queue.closed == u.queue.closed
  ensures forall l :: l in u.queue.leases ==> l in grantAvailable(room, u).queue.leases
  ensures forall w :: w in grantAvailable(room, u).queue.waiting ==> w in u.queue.waiting
{
  var t := grantAvailable(room, u);
  if !core__concurrency_canGrantRoom(u.queue, room) {
    assert t == u;
    RoomBatchProgress(u);
  } else {
    var isRoom := (w: core__concurrency_RoomWaiter) => (w.room == room);
    var w0 :| w0 in u.queue.waiting && w0.room == room;
    ProofLib.FilterMember(isRoom, u.queue.waiting, w0);
    var g := ProofLib.Filter(isRoom, u.queue.waiting)[0];
    ProofLib.FilterMember(isRoom, u.queue.waiting, g);
    var c := batchAt(u, g.caller);
    assert c.phase.BatchWaiting? && wantedRoom(c) == room;
    RoomBatchAtView(u, g.caller);
    ProofLib.FilterSubset((x: BatchLeaseCall) => (x.id == g.caller), u.calls);
    ProofLib.FilterMember((x: BatchLeaseCall) => (x.id == g.caller), u.calls, c);
    assert c in u.calls && c.id == g.caller;
    var next := c.(position := (c.position + 1), phase := (if ((c.position + 1) == |c.wanted|) then BatchLeasePhase.BatchInvoking else BatchLeasePhase.BatchAcquiring));
    forall i | 0 <= i < |u.calls| && u.calls[i].id == g.caller ensures u.calls[i] == c {
      RoomBatchIdentityLookup(u, u.calls[i]);
    }
    assert |t.calls| == |u.calls| && forall i :: 0 <= i < |u.calls| ==> t.calls[i] == (if u.calls[i].id == g.caller then next else u.calls[i]);
    RoomBatchCallsReplaced(u, t, g.caller, next);
    var lease := core__concurrency_Lease(g.caller, room, true, 0);
    assert t.queue.leases == u.queue.leases + [lease];
    RoomBatchHeldAppend(u, t, lease);
    var keep := (w: core__concurrency_RoomWaiter) => (w.ticket != g.ticket);
    assert t.queue.waiting == ProofLib.Filter(keep, u.queue.waiting);
    forall w | w in t.queue.waiting ensures w in u.queue.waiting && w.caller != g.caller {
      ProofLib.FilterMember(keep, u.queue.waiting, w);
      RoomBatchWaiterUnique(u.queue, w, g);
    }
    forall w | w in u.queue.waiting && w.caller != g.caller ensures w in t.queue.waiting {
      RoomBatchWaiterUnique(u.queue, w, g);
      ProofLib.FilterMember(keep, u.queue.waiting, w);
    }
    RoomBatchGrantInvariant(u, room);
    RoomBatchGrantedCalls(u, t, c, next, room);
    RoomBatchGrantedQueue(u, t, g, c, next);
    RoomBatchProgress(t);
  }
}

lemma RoomBatchFound(s: MultiRoomLeases, caller: int)
  requires alwaysBatchIdentitiesUnique(s) && !batchAt(s, caller).phase.BatchDone?
  ensures batchAt(s, caller) in s.calls && batchAt(s, caller).id == caller && caller > 0
  ensures forall i :: 0 <= i < |s.calls| && s.calls[i].id == caller ==> s.calls[i] == batchAt(s, caller)
{
  var p := (c: BatchLeaseCall) => (c.id == caller);
  RoomBatchAtView(s, caller);
  ProofLib.FilterSubset(p, s.calls);
  ProofLib.FilterMember(p, s.calls, batchAt(s, caller));
  RoomBatchIdentityProjection(s);
  forall i | 0 <= i < |s.calls| && s.calls[i].id == caller ensures s.calls[i] == batchAt(s, caller) {
    RoomBatchIdentityLookup(s, s.calls[i]);
  }
}

lemma RoomBatchLeasesKept(s: MultiRoomLeases, t: MultiRoomLeases)
  requires forall l :: l in s.queue.leases ==> l in t.queue.leases
  ensures stepReleasedAfterWriteSettlement(s, t)
{
  forall l | l in s.queue.leases ensures exists a :: a in t.queue.leases && a.caller == l.caller && a.room == l.room {
    assert l in t.queue.leases;
  }
  forall l | l in s.queue.leases ensures exists other :: other in t.queue.leases && other.room == l.room && other.caller == l.caller {
    assert l in t.queue.leases;
  }
}

lemma RoomBatchOpened(s: MultiRoomLeases, caller: int, requestedRooms: seq<int>, ambient: int, explicitOwner: int)
  requires inv(s) && canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner)
  ensures inv(openBatch(s, caller, requestedRooms, ambient, explicitOwner))
{
  var t := openBatch(s, caller, requestedRooms, ambient, explicitOwner);
  var nc := t.calls[|s.calls|];
  assert t.calls == s.calls + [nc] && nc.id == caller && nc.position == 0 && nc.wanted == orderedRooms(requestedRooms);
  forall c | c in s.calls ensures c.id != caller {
    if c.id == caller { RoomBatchIdentityLookup(s, c); }
  }
  forall x ensures batchAt(t, x) == (if x == caller then nc else batchAt(s, x)) {
    var p := (c: BatchLeaseCall) => (c.id == x);
    ProofLib.FilterAppend(p, s.calls, nc);
    RoomBatchAtView(s, x);
    RoomBatchAtView(t, x);
    var m := ProofLib.Filter(p, s.calls);
    if x == caller && |m| > 0 { ProofLib.FilterMember(p, s.calls, m[0]); }
  }
  RoomBatchIdentityProjection(s);
  RoomBatchIdentityProjection(t);
  forall c | c in t.calls ensures c.id > 0 && |ProofLib.Filter((other: BatchLeaseCall) => other.id == c.id, t.calls)| == 1 {
    var p := (other: BatchLeaseCall) => other.id == c.id;
    ProofLib.FilterAppend(p, s.calls, nc);
    if c == nc {
      var m := ProofLib.Filter(p, s.calls);
      if |m| > 0 { ProofLib.FilterMember(p, s.calls, m[0]); }
    }
  }
  forall l | l in s.queue.leases ensures l.caller != caller {}
  RoomBatchHeldProjection(s, caller);
  var mine := ProofLib.Filter((l: core__concurrency_Lease) => (l.caller == caller), s.queue.leases);
  if |mine| > 0 { ProofLib.FilterMember((l: core__concurrency_Lease) => (l.caller == caller), s.queue.leases, mine[0]); }
  assert heldRooms(t, caller) == [];
  RoomBatchRanks([]);
  forall w | w in s.queue.waiting ensures w.caller != caller {}
  assert caller !in s.queue.cancelled;
  RoomBatchOrderedRooms(requestedRooms);
  RoomBatchRanks(nc.wanted);
  if |requestedRooms| == 0 {
    assert requestedRooms == [];
    assert nc.wanted == [];
  }
  assert forall y :: heldRooms(t, y) == heldRooms(s, y);
  assert alwaysRequestedRoomsAscending(t);
  assert alwaysCancelledCallersOpened(t);
  assert alwaysBatchesHaveValidPosition(t);
  assert alwaysStoredResultFollowsPhase(t);
  assert alwaysLeasesBelongToBatch(t);
  assert alwaysHeldPrefixMatchesRequests(t);
  assert alwaysInvocationHoldsAllRooms(t);
  assert alwaysWaiterMatchesNextRoom(t);
  assert alwaysWaitsAboveHeldRooms(t);
  assert alwaysDoneHasNoLease(t);
  assert alwaysAcquiringQueueAuthority(t);
  assert alwaysReverseReleaseRank(t);
  RoomBatchProgress(t);
}

lemma RoomBatchQueued(s: MultiRoomLeases, caller: int)
  requires inv(s) && canAdvanceAcquisition(s, caller) && acquisitionFailure(s, batchAt(s, caller)).BatchPending?
  ensures inv(advanceAcquisition(s, caller))
  ensures forall l :: l in s.queue.leases ==> l in advanceAcquisition(s, caller).queue.leases
  ensures !s.queue.closed && advanceAcquisition(s, caller).nested == s.nested
{
  var c := batchAt(s, caller);
  RoomBatchFound(s, caller);
  var room := wantedRoom(c);
  RoomBatchQueueState(s);
  core__concurrency_queueRoom_ensures(s.queue, caller, room);
  var next := c.(phase := BatchLeasePhase.BatchWaiting);
  var u := s.(queue := core__concurrency_queueRoom(s.queue, caller, room), calls := (var s_map := s.calls; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.id == caller) then x.(phase := BatchLeasePhase.BatchWaiting) else x))));
  assert advanceAcquisition(s, caller) == grantAvailable(room, u);
  RoomBatchCallsReplaced(s, u, caller, next);
  var waiter := core__concurrency_RoomWaiter(caller, room, s.queue.nextTicket);
  assert u.queue.waiting == s.queue.waiting + [waiter] && u.queue.leases == s.queue.leases;
  assert forall y :: heldRooms(u, y) == heldRooms(s, y);
  forall w | w in s.queue.waiting ensures w.caller != caller {}
  forall x | x in u.queue.cancelled ensures exists d :: d in u.calls && d.id == x {
    var d :| d in s.calls && d.id == x;
    if d.id != caller { assert d in u.calls; }
  }
  forall l | l in u.queue.leases ensures exists d :: d in u.calls && d.id == l.caller && !d.phase.BatchDone? && l.room in d.wanted {
    var d :| d in s.calls && d.id == l.caller && !d.phase.BatchDone? && l.room in d.wanted;
    if d.id != caller { assert d in u.calls; }
  }
  forall w | w in u.queue.waiting ensures batchAt(u, w.caller).phase.BatchWaiting? && wantedRoom(batchAt(u, w.caller)) == w.room {
    if w != waiter { assert w in s.queue.waiting; }
  }
  forall d | d in u.calls && d.phase.BatchWaiting? ensures exists w :: w in u.queue.waiting && w.caller == d.id && w.room == wantedRoom(d) {
    if d == next { assert waiter in u.queue.waiting; } else {
      var w :| w in s.queue.waiting && w.caller == d.id && w.room == wantedRoom(d);
      assert w in u.queue.waiting;
    }
  }
  forall d | d in u.calls && d.phase.BatchDone? ensures !(exists w :: w in u.queue.waiting && w.caller == d.id) {
    assert d in s.calls && d.id != caller;
  }
  forall d | d in u.calls ensures roomRanksAscending(d.wanted) && roomRanksAscending(heldRooms(u, d.id)) {
    if d == next { assert c in s.calls; } else { assert d in s.calls; }
  }
  forall d | d in u.calls && d != next ensures d in s.calls {}
  assert alwaysRequestedRoomsAscending(u);
  assert alwaysBatchesHaveValidPosition(u);
  assert alwaysStoredResultFollowsPhase(u);
  assert alwaysHeldPrefixMatchesRequests(u);
  assert alwaysInvocationHoldsAllRooms(u);
  assert alwaysWaiterMatchesNextRoom(u);
  assert alwaysWaitsAboveHeldRooms(u);
  assert alwaysDoneHasNoLease(u);
  assert alwaysAcquiringQueueAuthority(u);
  assert alwaysReverseReleaseRank(u);
  forall w | w in u.queue.waiting && w.room != room ensures exists l :: l in u.queue.leases && l.room == w.room {
    assert w in s.queue.waiting;
  }
  RoomBatchGrant(u, room);
}

lemma RoomBatchReleased(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures inv(releaseBatchRoom(s, caller))
  ensures stepReleasedAfterWriteSettlement(s, releaseBatchRoom(s, caller))
  ensures forall w :: w in releaseBatchRoom(s, caller).queue.waiting ==> w in s.queue.waiting
  ensures releaseBatchRoom(s, caller).nested == s.nested
{
  var c := batchAt(s, caller);
  RoomBatchFound(s, caller);
  var room := releaseRoomId(s, caller);
  RoomBatchQueueState(s);
  core__concurrency_releaseRoom_ensures(s.queue, caller, room);
  var u := s.(queue := core__concurrency_releaseRoom(s.queue, caller, room));
  assert releaseBatchRoom(s, caller) == grantAvailable(room, u);
  var keep := (l: core__concurrency_Lease) => ((l.caller != caller) || (l.room != room));
  assert u.queue.leases == ProofLib.Filter(keep, s.queue.leases);
  RoomBatchHeldRelease(s, u, caller, room);
  forall l | l in u.queue.leases ensures l in s.queue.leases { ProofLib.FilterMember(keep, s.queue.leases, l); }
  forall l | l in s.queue.leases && keep(l) ensures l in u.queue.leases { ProofLib.FilterMember(keep, s.queue.leases, l); }
  forall d | d in u.calls && (d.phase.BatchAcquiring? || d.phase.BatchWaiting? || d.phase.BatchInvoking? || d.phase.BatchDone?) ensures d.id != caller {
    if d.id == caller { RoomBatchIdentityLookup(s, d); }
  }
  forall d | d in u.calls ensures roomRanksAscending(heldRooms(u, d.id)) {
    if d.id == caller { RoomBatchIdentityLookup(s, d); }
  }
  assert alwaysLeasesBelongToBatch(u);
  assert alwaysHeldPrefixMatchesRequests(u);
  assert alwaysInvocationHoldsAllRooms(u);
  assert alwaysWaiterMatchesNextRoom(u);
  assert alwaysWaitsAboveHeldRooms(u);
  assert alwaysDoneHasNoLease(u);
  assert alwaysReverseReleaseRank(u);
  forall w | w in u.queue.waiting && w.room != room ensures exists l :: l in u.queue.leases && l.room == w.room {
    var l :| l in s.queue.leases && l.room == w.room;
    assert keep(l) && l in u.queue.leases;
  }
  RoomBatchGrant(u, room);
  var t := releaseBatchRoom(s, caller);
  forall l | l in s.queue.leases ensures (exists a :: a in t.queue.leases && a.caller == l.caller && a.room == l.room) || batchAt(s, l.caller).phase.BatchReleasing? {
    if keep(l) { assert l in t.queue.leases; }
  }
  forall l | l in s.queue.leases ensures (exists other :: other in t.queue.leases && other.room == l.room && other.caller == l.caller) || (!l.acceptingWrites && l.writes == 0) {
    if exists other :: other in u.queue.leases && other.room == l.room && other.caller == l.caller {
      var other :| other in u.queue.leases && other.room == l.room && other.caller == l.caller;
      assert other in t.queue.leases;
    }
  }
}

lemma RoomBatchAbortWaiting(s: MultiRoomLeases, caller: int, cause: int)
  requires inv(s) && canAbortBatch(s, caller, cause) && batchAt(s, caller).phase.BatchWaiting?
  ensures inv(abortBatch(s, caller, cause))
  ensures abortBatch(s, caller, cause).queue.leases == s.queue.leases
  ensures forall w :: w in abortBatch(s, caller, cause).queue.waiting ==> w in s.queue.waiting
{
  var c := batchAt(s, caller);
  RoomBatchFound(s, caller);
  RoomBatchQueueState(s);
  core__concurrency_cancelQueued_ensures(s.queue, caller);
  var t := abortBatch(s, caller, cause);
  var next := c.(aborted := true, abortCause := cause, phase := BatchLeasePhase.BatchReleasing, resultKind := BatchLeaseResult.FailedAbort, errorRoom := wantedRoom(c), cause := cause);
  RoomBatchCallsReplaced(s, t, caller, next);
  var stay := (w: core__concurrency_RoomWaiter) => (w.caller != caller);
  assert t.queue.waiting == ProofLib.Filter(stay, s.queue.waiting);
  forall w | w in t.queue.waiting ensures w in s.queue.waiting && w.caller != caller { ProofLib.FilterMember(stay, s.queue.waiting, w); }
  forall w | w in s.queue.waiting && w.caller != caller ensures w in t.queue.waiting { ProofLib.FilterMember(stay, s.queue.waiting, w); }
  var added := (set_x: int) => !((set_x in s.queue.cancelled));
  assert t.queue.cancelled == s.queue.cancelled + ProofLib.Filter(added, [caller]);
  forall x | x in t.queue.cancelled ensures x in s.queue.cancelled || x == caller {
    if x !in s.queue.cancelled { ProofLib.FilterMember(added, [caller], x); }
  }
  assert forall y :: heldRooms(t, y) == heldRooms(s, y);
  forall x | x in t.queue.cancelled ensures exists d :: d in t.calls && d.id == x {
    if x != caller {
      var d :| d in s.calls && d.id == x;
      assert d in t.calls;
    }
  }
  forall l | l in t.queue.leases ensures exists d :: d in t.calls && d.id == l.caller && !d.phase.BatchDone? && l.room in d.wanted {
    var d :| d in s.calls && d.id == l.caller && !d.phase.BatchDone? && l.room in d.wanted;
    if d.id == caller { RoomBatchIdentityLookup(s, d); } else { assert d in t.calls; }
  }
  forall w | w in t.queue.waiting ensures exists l :: l in t.queue.leases && l.room == w.room {}
  forall d | d in t.calls && d.phase.BatchWaiting? ensures exists w :: w in t.queue.waiting && w.caller == d.id && w.room == wantedRoom(d) {
    var w :| w in s.queue.waiting && w.caller == d.id && w.room == wantedRoom(d);
    assert w in t.queue.waiting;
  }
  forall d | d in t.calls ensures roomRanksAscending(d.wanted) && roomRanksAscending(heldRooms(t, d.id)) {
    if d == next { assert c in s.calls; } else { assert d in s.calls; }
  }
  forall d | d in t.calls && d.phase.BatchAcquiring? ensures d.id !in t.queue.cancelled {
    assert d in s.calls && d.id != caller;
  }
  forall d | d in t.calls ensures (0 <= d.position && d.position <= |d.wanted|) {
    if d == next { assert c in s.calls; } else { assert d in s.calls; }
  }
  assert alwaysRequestedRoomsAscending(t);
  assert alwaysBatchesHaveValidPosition(t);
  assert alwaysStoredResultFollowsPhase(t);
  assert alwaysHeldPrefixMatchesRequests(t);
  assert alwaysInvocationHoldsAllRooms(t);
  assert alwaysWaiterMatchesNextRoom(t);
  assert alwaysWaitsAboveHeldRooms(t);
  assert alwaysDoneHasNoLease(t);
  assert alwaysAcquiringQueueAuthority(t);
  assert alwaysReverseReleaseRank(t);
  RoomBatchProgress(t);
}

lemma RoomBatchNested(s: MultiRoomLeases, requestedRooms: seq<int>, ambient: int, explicitOwner: int, explicitRoom: int)
  requires inv(s)
  ensures inv(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom))
{
  var t := resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom);
  assert t.queue == s.queue && t.calls == s.calls;
  assert forall y :: heldRooms(t, y) == heldRooms(s, y) && batchAt(t, y) == batchAt(s, y);
  assert alwaysNestedReuseExact(t);
  assert alwaysHeldPrefixMatchesRequests(t);
  assert alwaysInvocationHoldsAllRooms(t);
  assert alwaysWaiterMatchesNextRoom(t);
  assert alwaysWaitsAboveHeldRooms(t);
  assert alwaysDoneHasNoLease(t);
  assert alwaysReverseReleaseRank(t);
  RoomBatchProgress(t);
}

lemma configure_ensures(s: MultiRoomLeases, capacity: int, maxPerRoom: int, maxRooms: int)
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysRequestedRoomsAscending(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysCancelledCallersOpened(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysNestedReuseExact(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysQueueInvariant(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysBatchIdentitiesUnique(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysBatchesHaveValidPosition(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysHeldPrefixMatchesRequests(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysStoredResultFollowsPhase(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysQueueConfiguredForCalls(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysLeasesBelongToBatch(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysInvocationHoldsAllRooms(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysWaiterMatchesNextRoom(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysWaiterHasOwner(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysWaitsAboveHeldRooms(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysDoneHasNoLease(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysAcquiringQueueAuthority(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysReverseReleaseRank(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysBatchProgressOrTerminal(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> stepNestedDoesNotAcquire(s, "configure", configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> stepReleasedAfterWriteSettlement(s, configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> stepClosedAdmissionCannotGrow(s, configure(s, capacity, maxPerRoom, maxRooms)))
{
  if inv(s) && canConfigure(s, capacity, maxPerRoom, maxRooms) {
    RoomBatchQueueState(s);
    core__concurrency_configureRooms_ensures(s.queue, capacity, maxPerRoom, maxRooms);
    RoomBatchLeaseFrame(s, configure(s, capacity, maxPerRoom, maxRooms));
  }
}

lemma closeAdmission_ensures(s: MultiRoomLeases, cause: int)
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysRequestedRoomsAscending(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysCancelledCallersOpened(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysNestedReuseExact(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysQueueInvariant(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysBatchIdentitiesUnique(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysBatchesHaveValidPosition(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysHeldPrefixMatchesRequests(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysStoredResultFollowsPhase(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysQueueConfiguredForCalls(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysLeasesBelongToBatch(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysInvocationHoldsAllRooms(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysWaiterMatchesNextRoom(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysWaiterHasOwner(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysWaitsAboveHeldRooms(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysDoneHasNoLease(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysAcquiringQueueAuthority(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysReverseReleaseRank(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysBatchProgressOrTerminal(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> stepNestedDoesNotAcquire(s, "closeAdmission", closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> stepReleasedAfterWriteSettlement(s, closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> stepClosedAdmissionCannotGrow(s, closeAdmission(s, cause)))
{
  if inv(s) && canCloseAdmission(s, cause) {
    RoomBatchQueueState(s);
    core__concurrency_closeRoomAdmission_ensures(s.queue);
    RoomBatchLeaseFrame(s, closeAdmission(s, cause));
  }
}

lemma beginWrite_ensures(s: MultiRoomLeases, caller: int, room: int)
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysRequestedRoomsAscending(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysCancelledCallersOpened(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysNestedReuseExact(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysQueueInvariant(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysBatchIdentitiesUnique(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysBatchesHaveValidPosition(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysHeldPrefixMatchesRequests(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysStoredResultFollowsPhase(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysQueueConfiguredForCalls(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysLeasesBelongToBatch(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysInvocationHoldsAllRooms(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWaiterMatchesNextRoom(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWaiterHasOwner(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWaitsAboveHeldRooms(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysDoneHasNoLease(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysAcquiringQueueAuthority(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysReverseReleaseRank(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysBatchProgressOrTerminal(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepNestedDoesNotAcquire(s, "beginWrite", beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepReleasedAfterWriteSettlement(s, beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepClosedAdmissionCannotGrow(s, beginWrite(s, caller, room)))
{
  if inv(s) && canBeginWrite(s, caller, room) {
    RoomBatchQueueState(s);
    core__concurrency_beginWrite_ensures(s.queue, caller, room);
    RoomBatchLeaseFrame(s, beginWrite(s, caller, room));
  }
}

lemma finishWrite_ensures(s: MultiRoomLeases, caller: int, room: int)
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysRequestedRoomsAscending(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysCancelledCallersOpened(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysNestedReuseExact(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysQueueInvariant(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysBatchIdentitiesUnique(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysBatchesHaveValidPosition(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysHeldPrefixMatchesRequests(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysStoredResultFollowsPhase(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysQueueConfiguredForCalls(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysLeasesBelongToBatch(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysInvocationHoldsAllRooms(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWaiterMatchesNextRoom(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWaiterHasOwner(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWaitsAboveHeldRooms(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysDoneHasNoLease(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysAcquiringQueueAuthority(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysReverseReleaseRank(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysBatchProgressOrTerminal(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepNestedDoesNotAcquire(s, "finishWrite", finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepReleasedAfterWriteSettlement(s, finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepClosedAdmissionCannotGrow(s, finishWrite(s, caller, room)))
{
  if inv(s) && canFinishWrite(s, caller, room) {
    RoomBatchQueueState(s);
    core__concurrency_finishWrite_ensures(s.queue, caller, room);
    RoomBatchLeaseFrame(s, finishWrite(s, caller, room));
  }
}

lemma closeBatchWrites_ensures(s: MultiRoomLeases, caller: int)
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysRequestedRoomsAscending(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysCancelledCallersOpened(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysNestedReuseExact(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysQueueInvariant(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysBatchIdentitiesUnique(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysBatchesHaveValidPosition(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysHeldPrefixMatchesRequests(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysStoredResultFollowsPhase(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysQueueConfiguredForCalls(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysLeasesBelongToBatch(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysInvocationHoldsAllRooms(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysWaiterMatchesNextRoom(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysWaiterHasOwner(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysWaitsAboveHeldRooms(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysDoneHasNoLease(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysAcquiringQueueAuthority(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysReverseReleaseRank(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysBatchProgressOrTerminal(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> stepNestedDoesNotAcquire(s, "closeBatchWrites", closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> stepReleasedAfterWriteSettlement(s, closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> stepClosedAdmissionCannotGrow(s, closeBatchWrites(s, caller)))
{
  if inv(s) && canCloseBatchWrites(s, caller) {
    RoomBatchQueueState(s);
    core__concurrency_closeWrites_ensures(s.queue, caller, releaseRoomId(s, caller));
    RoomBatchLeaseFrame(s, closeBatchWrites(s, caller));
  }
}

lemma openBatch_ensures(s: MultiRoomLeases, caller: int, requestedRooms: seq<int>, ambient: int, explicitOwner: int)
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysRequestedRoomsAscending(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysCancelledCallersOpened(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysNestedReuseExact(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysQueueInvariant(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysBatchIdentitiesUnique(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysBatchesHaveValidPosition(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysHeldPrefixMatchesRequests(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysStoredResultFollowsPhase(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysQueueConfiguredForCalls(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysLeasesBelongToBatch(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysInvocationHoldsAllRooms(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysWaiterMatchesNextRoom(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysWaiterHasOwner(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysWaitsAboveHeldRooms(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysDoneHasNoLease(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysAcquiringQueueAuthority(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysReverseReleaseRank(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysBatchProgressOrTerminal(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> stepNestedDoesNotAcquire(s, "openBatch", openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> stepReleasedAfterWriteSettlement(s, openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> stepClosedAdmissionCannotGrow(s, openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
{
  if inv(s) && canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) {
    RoomBatchOpened(s, caller, requestedRooms, ambient, explicitOwner);
  }
}

lemma resolveNested_ensures(s: MultiRoomLeases, requestedRooms: seq<int>, ambient: int, explicitOwner: int, explicitRoom: int)
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysRequestedRoomsAscending(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysCancelledCallersOpened(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysNestedReuseExact(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysQueueInvariant(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysBatchIdentitiesUnique(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysBatchesHaveValidPosition(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysHeldPrefixMatchesRequests(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysStoredResultFollowsPhase(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysQueueConfiguredForCalls(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysLeasesBelongToBatch(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysInvocationHoldsAllRooms(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysWaiterMatchesNextRoom(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysWaiterHasOwner(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysWaitsAboveHeldRooms(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysDoneHasNoLease(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysAcquiringQueueAuthority(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysReverseReleaseRank(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysBatchProgressOrTerminal(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> stepNestedDoesNotAcquire(s, "resolveNested", resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> stepReleasedAfterWriteSettlement(s, resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> stepClosedAdmissionCannotGrow(s, resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
{
  if inv(s) && canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) {
    RoomBatchNested(s, requestedRooms, ambient, explicitOwner, explicitRoom);
  }
}

lemma abortBatch_ensures(s: MultiRoomLeases, caller: int, cause: int)
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysRequestedRoomsAscending(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysCancelledCallersOpened(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysNestedReuseExact(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysQueueInvariant(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysBatchIdentitiesUnique(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysBatchesHaveValidPosition(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysHeldPrefixMatchesRequests(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysStoredResultFollowsPhase(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysQueueConfiguredForCalls(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysLeasesBelongToBatch(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysInvocationHoldsAllRooms(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysWaiterMatchesNextRoom(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysWaiterHasOwner(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysWaitsAboveHeldRooms(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysDoneHasNoLease(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysAcquiringQueueAuthority(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysReverseReleaseRank(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysBatchProgressOrTerminal(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> stepNestedDoesNotAcquire(s, "abortBatch", abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> stepReleasedAfterWriteSettlement(s, abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> stepClosedAdmissionCannotGrow(s, abortBatch(s, caller, cause)))
{
  if inv(s) && canAbortBatch(s, caller, cause) {
    var c := batchAt(s, caller);
    if c.phase.BatchWaiting? {
      RoomBatchAbortWaiting(s, caller, cause);
    } else {
      RoomBatchFound(s, caller);
      RoomBatchCallFrame(s, abortBatch(s, caller, cause), caller, c.(aborted := true, abortCause := cause));
    }
    RoomBatchLeasesKept(s, abortBatch(s, caller, cause));
  }
}

lemma advanceAcquisition_ensures(s: MultiRoomLeases, caller: int)
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysRequestedRoomsAscending(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysCancelledCallersOpened(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysNestedReuseExact(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysQueueInvariant(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysBatchIdentitiesUnique(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysBatchesHaveValidPosition(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysHeldPrefixMatchesRequests(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysStoredResultFollowsPhase(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysQueueConfiguredForCalls(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysLeasesBelongToBatch(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysInvocationHoldsAllRooms(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysWaiterMatchesNextRoom(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysWaiterHasOwner(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysWaitsAboveHeldRooms(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysDoneHasNoLease(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysAcquiringQueueAuthority(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysReverseReleaseRank(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysBatchProgressOrTerminal(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> stepNestedDoesNotAcquire(s, "advanceAcquisition", advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> stepReleasedAfterWriteSettlement(s, advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> stepClosedAdmissionCannotGrow(s, advanceAcquisition(s, caller)))
{
  if inv(s) && canAdvanceAcquisition(s, caller) {
    var c := batchAt(s, caller);
    var failure := acquisitionFailure(s, c);
    if failure.BatchPending? {
      RoomBatchQueued(s, caller);
    } else {
      RoomBatchFound(s, caller);
      RoomBatchCallFrame(s, advanceAcquisition(s, caller), caller, c.(phase := BatchLeasePhase.BatchReleasing, resultKind := failure, errorRoom := wantedRoom(c), cause := (if failure.FailedClosed? then s.closeCause else (if failure.FailedAbort? then c.abortCause else 0))));
    }
    RoomBatchLeasesKept(s, advanceAcquisition(s, caller));
  }
}

lemma returnBody_ensures(s: MultiRoomLeases, caller: int, cause: int)
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysRequestedRoomsAscending(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysCancelledCallersOpened(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysNestedReuseExact(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysQueueInvariant(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysBatchIdentitiesUnique(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysBatchesHaveValidPosition(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysHeldPrefixMatchesRequests(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysStoredResultFollowsPhase(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysQueueConfiguredForCalls(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysLeasesBelongToBatch(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysInvocationHoldsAllRooms(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysWaiterMatchesNextRoom(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysWaiterHasOwner(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysWaitsAboveHeldRooms(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysDoneHasNoLease(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysAcquiringQueueAuthority(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysReverseReleaseRank(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysBatchProgressOrTerminal(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> stepNestedDoesNotAcquire(s, "returnBody", returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> stepReleasedAfterWriteSettlement(s, returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> stepClosedAdmissionCannotGrow(s, returnBody(s, caller, cause)))
{
  if inv(s) && canReturnBody(s, caller, cause) {
    var c := batchAt(s, caller);
    RoomBatchFound(s, caller);
    RoomBatchCallFrame(s, returnBody(s, caller, cause), caller, c.(phase := BatchLeasePhase.BatchReleasing, resultKind := (if (cause == 0) then BatchLeaseResult.BatchSucceeded else BatchLeaseResult.FailedBody), cause := cause));
    RoomBatchLeasesKept(s, returnBody(s, caller, cause));
  }
}

lemma finishBatch_ensures(s: MultiRoomLeases, caller: int)
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysRequestedRoomsAscending(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysCancelledCallersOpened(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysNestedReuseExact(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysQueueInvariant(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysBatchIdentitiesUnique(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysBatchesHaveValidPosition(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysHeldPrefixMatchesRequests(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysStoredResultFollowsPhase(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysQueueConfiguredForCalls(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysLeasesBelongToBatch(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysInvocationHoldsAllRooms(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysWaiterMatchesNextRoom(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysWaiterHasOwner(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysWaitsAboveHeldRooms(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysDoneHasNoLease(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysAcquiringQueueAuthority(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysReverseReleaseRank(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysBatchProgressOrTerminal(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> stepNestedDoesNotAcquire(s, "finishBatch", finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> stepReleasedAfterWriteSettlement(s, finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> stepClosedAdmissionCannotGrow(s, finishBatch(s, caller)))
{
  if inv(s) && canFinishBatch(s, caller) {
    var c := batchAt(s, caller);
    RoomBatchFound(s, caller);
    RoomBatchCallFrame(s, finishBatch(s, caller), caller, c.(phase := BatchLeasePhase.BatchDone));
    RoomBatchLeasesKept(s, finishBatch(s, caller));
  }
}

lemma releaseBatchRoom_ensures(s: MultiRoomLeases, caller: int)
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysRequestedRoomsAscending(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysCancelledCallersOpened(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysNestedReuseExact(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysQueueInvariant(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysBatchIdentitiesUnique(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysBatchesHaveValidPosition(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysHeldPrefixMatchesRequests(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysStoredResultFollowsPhase(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysQueueConfiguredForCalls(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysLeasesBelongToBatch(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysInvocationHoldsAllRooms(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysWaiterMatchesNextRoom(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysWaiterHasOwner(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysWaitsAboveHeldRooms(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysDoneHasNoLease(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysAcquiringQueueAuthority(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysReverseReleaseRank(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysBatchProgressOrTerminal(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> stepNestedDoesNotAcquire(s, "releaseBatchRoom", releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> stepReleasedAfterWriteSettlement(s, releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> stepClosedAdmissionCannotGrow(s, releaseBatchRoom(s, caller)))
{
  if inv(s) && canReleaseBatchRoom(s, caller) {
    RoomBatchReleased(s, caller);
  }
}

lemma finishNextClosingWrite_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysRequestedRoomsAscending(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysCancelledCallersOpened(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysNestedReuseExact(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysQueueInvariant(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysBatchIdentitiesUnique(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysBatchesHaveValidPosition(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysHeldPrefixMatchesRequests(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysStoredResultFollowsPhase(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysQueueConfiguredForCalls(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysLeasesBelongToBatch(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysInvocationHoldsAllRooms(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysWaiterMatchesNextRoom(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysWaiterHasOwner(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysWaitsAboveHeldRooms(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysDoneHasNoLease(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysAcquiringQueueAuthority(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysReverseReleaseRank(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysBatchProgressOrTerminal(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> stepNestedDoesNotAcquire(s, "finishNextClosingWrite", finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> stepReleasedAfterWriteSettlement(s, finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> stepClosedAdmissionCannotGrow(s, finishNextClosingWrite(s)))
{
  if inv(s) && canFinishNextClosingWrite(s) {
    finishWrite_ensures(s, closingWriter(s).caller, closingWriter(s).room);
  }
}

lemma advanceNextAcquisition_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysRequestedRoomsAscending(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysCancelledCallersOpened(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysNestedReuseExact(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysQueueInvariant(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysBatchIdentitiesUnique(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysBatchesHaveValidPosition(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysHeldPrefixMatchesRequests(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysStoredResultFollowsPhase(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysQueueConfiguredForCalls(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysLeasesBelongToBatch(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysInvocationHoldsAllRooms(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysWaiterMatchesNextRoom(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysWaiterHasOwner(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysWaitsAboveHeldRooms(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysDoneHasNoLease(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysAcquiringQueueAuthority(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysReverseReleaseRank(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysBatchProgressOrTerminal(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> stepNestedDoesNotAcquire(s, "advanceNextAcquisition", advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> stepReleasedAfterWriteSettlement(s, advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> stepClosedAdmissionCannotGrow(s, advanceNextAcquisition(s)))
{
  if inv(s) && canAdvanceNextAcquisition(s) {
    advanceAcquisition_ensures(s, nextAcquisition(s));
  }
}

lemma returnNextBody_ensures(s: MultiRoomLeases, cause: int)
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysRequestedRoomsAscending(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysCancelledCallersOpened(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysNestedReuseExact(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysQueueInvariant(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysBatchIdentitiesUnique(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysBatchesHaveValidPosition(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysHeldPrefixMatchesRequests(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysStoredResultFollowsPhase(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysQueueConfiguredForCalls(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysLeasesBelongToBatch(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysInvocationHoldsAllRooms(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysWaiterMatchesNextRoom(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysWaiterHasOwner(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysWaitsAboveHeldRooms(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysDoneHasNoLease(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysAcquiringQueueAuthority(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysReverseReleaseRank(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysBatchProgressOrTerminal(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> stepNestedDoesNotAcquire(s, "returnNextBody", returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> stepReleasedAfterWriteSettlement(s, returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> stepClosedAdmissionCannotGrow(s, returnNextBody(s, cause)))
{
  if inv(s) && canReturnNextBody(s, cause) {
    returnBody_ensures(s, nextBody(s), cause);
  }
}

lemma closeNextBatchWrites_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysRequestedRoomsAscending(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysCancelledCallersOpened(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysNestedReuseExact(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysQueueInvariant(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysBatchIdentitiesUnique(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysBatchesHaveValidPosition(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysHeldPrefixMatchesRequests(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysStoredResultFollowsPhase(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysQueueConfiguredForCalls(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysLeasesBelongToBatch(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysInvocationHoldsAllRooms(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysWaiterMatchesNextRoom(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysWaiterHasOwner(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysWaitsAboveHeldRooms(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysDoneHasNoLease(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysAcquiringQueueAuthority(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysReverseReleaseRank(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysBatchProgressOrTerminal(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> stepNestedDoesNotAcquire(s, "closeNextBatchWrites", closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> stepReleasedAfterWriteSettlement(s, closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> stepClosedAdmissionCannotGrow(s, closeNextBatchWrites(s)))
{
  if inv(s) && canCloseNextBatchWrites(s) {
    closeBatchWrites_ensures(s, nextWriteClosure(s));
  }
}

lemma releaseNextBatchRoom_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysRequestedRoomsAscending(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysCancelledCallersOpened(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysNestedReuseExact(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysQueueInvariant(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysBatchIdentitiesUnique(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysBatchesHaveValidPosition(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysHeldPrefixMatchesRequests(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysStoredResultFollowsPhase(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysQueueConfiguredForCalls(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysLeasesBelongToBatch(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysInvocationHoldsAllRooms(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysWaiterMatchesNextRoom(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysWaiterHasOwner(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysWaitsAboveHeldRooms(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysDoneHasNoLease(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysAcquiringQueueAuthority(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysReverseReleaseRank(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysBatchProgressOrTerminal(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> stepNestedDoesNotAcquire(s, "releaseNextBatchRoom", releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> stepReleasedAfterWriteSettlement(s, releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> stepClosedAdmissionCannotGrow(s, releaseNextBatchRoom(s)))
{
  if inv(s) && canReleaseNextBatchRoom(s) {
    releaseBatchRoom_ensures(s, nextRelease(s));
  }
}

lemma finishNextBatch_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysRequestedRoomsAscending(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysCancelledCallersOpened(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysNestedReuseExact(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysQueueInvariant(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysBatchIdentitiesUnique(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysBatchesHaveValidPosition(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysHeldPrefixMatchesRequests(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysStoredResultFollowsPhase(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysQueueConfiguredForCalls(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysLeasesBelongToBatch(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysInvocationHoldsAllRooms(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysWaiterMatchesNextRoom(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysWaiterHasOwner(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysWaitsAboveHeldRooms(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysDoneHasNoLease(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysAcquiringQueueAuthority(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysReverseReleaseRank(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysBatchProgressOrTerminal(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> stepNestedDoesNotAcquire(s, "finishNextBatch", finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> stepReleasedAfterWriteSettlement(s, finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> stepClosedAdmissionCannotGrow(s, finishNextBatch(s)))
{
  if inv(s) && canFinishNextBatch(s) {
    finishBatch_ensures(s, nextFinishedBatch(s));
  }
}
