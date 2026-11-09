/// Bounded per-identity advisory warmup cache; each identity is a URL/key hash.
module CloudWarmup {
  type State = { epoch: int, attempts: int, entries: int -> int, order: List[int],
    pending: Set[int], dispatched: int, lastSent: bool, lastAllowed: bool, lastCached: bool }
  var s: State
  pure val empty = Map(1 -> -1, 2 -> -1, 3 -> -1)
  action init = s' = { epoch: 0, attempts: 0, entries: empty, order: List(), pending: Set(),
    dispatched: 0, lastSent: false, lastAllowed: false, lastCached: false }
  action request(key: int, allowed: bool): bool = all {
    s.attempts < 4,
    { val cached = s.entries.get(key) == s.epoch
      val sending = allowed and not(cached)
      val full = s.order.length() == 2
      val evicted = if(full and sending) s.entries.set(s.order.head(), -1) else s.entries
      s' = {...s, attempts: s.attempts + 1, lastAllowed: allowed, lastCached: cached,
        lastSent: sending, dispatched: s.dispatched + (if(sending) 1 else 0),
        entries: if(sending) evicted.set(key,s.epoch) else s.entries,
        order: if(sending) (if(full) s.order.tail() else s.order).append(key) else s.order,
        pending: if(sending) s.pending.union(Set(s.attempts + 1)) else s.pending }
    }
  }
  /// Success, rejection, timeout and cancellation all retain the debounce claim.
  action finish(id: int): bool = all {s.pending.contains(id), s'= {...s,pending:s.pending.exclude(Set(id))}}
  action expire = all {s.epoch < 2, s'= {...s,epoch:s.epoch+1,entries:empty,order:List()}}
  action finishOne = finish(1)
  action finishTwo = finish(2)
  action finishThree = finish(3)
  action finishFour = finish(4)
  action step = any {request(1,true),request(2,true),request(3,true),request(1,false),
    finishOne,finishTwo,finishThree,finishFour,expire,s'=s}
  val bounded = s.order.length() <= 2 and s.pending.size() <= 4 and s.dispatched <= s.attempts
  val currentCache = s.order.foldl(true, (valid,key) => valid and s.entries.get(key) == s.epoch)
  val admittedOnly = s.lastSent implies s.lastAllowed and not(s.lastCached)
  val safety = bounded and currentCache and admittedOnly
  temporal Settles = (finishOne.weakFair(s) and finishTwo.weakFair(s) and finishThree.weakFair(s) and finishFour.weakFair(s)) implies
    1.to(4).forall(id => always(s.pending.contains(id) implies eventually(not(s.pending.contains(id)))))
  run concurrentTriggerTest = init.then(request(1,true)).then(request(1,true)).expect(s.dispatched == 1 and safety)
  run failureStillDebouncesTest = init.then(request(1,true)).then(finishOne).then(request(1,true)).expect(s.dispatched == 1 and safety)
  run changedIdentityTest = init.then(request(1,true)).then(request(2,true)).then(request(1,true)).expect(s.dispatched == 2 and safety)
  run expiryAllowsFreshWarmTest = init.then(request(1,true)).then(expire).then(request(1,true)).expect(s.dispatched == 2 and safety)
  run evictionStaysBoundedTest = init.then(request(1,true)).then(request(2,true)).then(request(3,true)).expect(s.order == List(2,3) and safety)
  run disabledNeverDispatchesTest = init.then(request(1,false)).expect(s.dispatched == 0 and safety)
}
