// Source protocol in events/index.ts. Synchronous listener delivery is split
// into explicit steps so callback reentrancy and promise retirement are visible.
// One effect marks a partial selection operation, not a completed message jump.
module NavigateViewClaims {
  type Claim = {
    live: bool,
    claimed: bool,
    applying: bool,
    declined: Set[int],
    resolution: str,
    resolutions: int,
    effects: int
  }
  type Attempt = { request: int, listener: int, epoch: int, phase: str, effected: bool }
  type State = {
    capacity: int,
    requestLimit: int,
    lifecycle: bool,
    admitted: int,
    epoch: int,
    queue: List[int],
    mounted: Set[int],
    active: Set[int],
    claims: int -> Claim,
    attempts: int -> Attempt,
    allocated: int,
    attemptLimit: int
  }
  var s: State
  pure val requestIds = 1.to(17)
  pure val attemptIds = 1.to(4)
  pure val emptyClaim: Claim = {
    live: false, claimed: false, applying: false, declined: Set(),
    resolution: "unused", resolutions: 0, effects: 0
  }
  pure val emptyAttempt: Attempt = {
    request: 1, listener: 1, epoch: 0, phase: "unused", effected: false
  }
  pure def initial(capacity: int, limit: int, lifecycle: bool, attempts: int): State = {
    capacity: capacity,
    requestLimit: limit,
    lifecycle: lifecycle,
    admitted: 0,
    epoch: 0,
    queue: List(),
    mounted: Set(),
    active: Set(),
    claims: requestIds.mapBy(_ => emptyClaim),
    attempts: attemptIds.mapBy(_ => emptyAttempt),
    allocated: 0,
    attemptLimit: attempts
  }
  action init = s' = initial(2, 2, true, 2)
  action initOverflow = s' = initial(16, 17, false, 0)

  // commit() removes any queued occurrence and consumes its resolver once.
  // A callback retained before overflow still holds the old claim object.
  pure def commit(x: State, id: int, result: str): State = {
    val claim = x.claims.get(id)
    val pending = claim.resolution == "pending"
    {
      ...x,
      queue: x.queue.select(queuedId => queuedId != id),
      claims: x.claims.set(id, {
        ...claim,
        claimed: true,
        resolution: if (pending) result else claim.resolution,
        resolutions: claim.resolutions + (if (pending) 1 else 0)
      })
    }
  }
  action admit = {
    val id = s.admitted + 1
    val cleared = requestIds.mapBy(queuedId => {
      val claim = s.claims.get(queuedId)
      if (s.queue.indices().exists(index => s.queue.nth(index) == queuedId))
        { ...claim, declined: Set() } else claim
    })
    val queued = s.queue.append(id)
    val withRequest = {
      ...s,
      admitted: id,
      epoch: s.epoch + 1,
      queue: queued,
      claims: cleared.set(id, { ...emptyClaim, live: true, resolution: "pending" })
    }
    val updated = if (queued.length() <= s.capacity) withRequest else {
      val dropped = queued.head()
      val old = withRequest.claims.get(dropped)
      {
        ...withRequest,
        queue: queued.tail(),
        claims: withRequest.claims.set(dropped, {
          ...old,
          live: false,
          resolution: "dropped",
          resolutions: 1
        })
      }
    }
    all {
      s.admitted < s.requestLimit,
      s' = updated
    }
  }
  action mount(listener: int): bool = all {
    s.lifecycle,
    not(s.mounted.contains(listener)),
    s' = {
      ...s,
      mounted: s.mounted.union(Set(listener)),
      active: s.active.union(Set(listener))
    }
  }
  // Cleanup removes the DOM listener but leaves applying unchanged.
  action unmount(listener: int): bool = all {
    s.active.contains(listener),
    s' = { ...s, active: s.active.exclude(Set(listener)) }
  }
  action invoke(listener: int): bool = {
    val id = if (s.queue.length() > 0) s.queue.head() else 1
    val claim = s.claims.get(id)
    all {
      s.queue.length() > 0,
      s.allocated < s.attemptLimit,
      s.active.contains(listener),
      claim.live and not(claim.claimed) and not(claim.applying),
      not(claim.declined.contains(listener)),
      s' = {
        ...s,
        allocated: s.allocated + 1,
        attempts: s.attempts.set(s.allocated + 1, {
          request: id,
          listener: listener,
          epoch: s.epoch,
          phase: "invoking",
          effected: false
        })
      }
    }
  }
  // This effect projection uses the caller's mount and pending-identity guard.
  // Effects can still occur before the callback promise reports completion.
  action effect(attempt: int): bool = {
    val owner = s.attempts.get(attempt)
    val claim = s.claims.get(owner.request)
    all {
      Set("invoking", "pending").contains(owner.phase),
      s.active.contains(owner.listener),
      claim.live and not(claim.claimed),
      not(owner.effected),
      s' = {
        ...s,
        claims: s.claims.set(owner.request, { ...claim, effects: claim.effects + 1 }),
        attempts: s.attempts.set(attempt, { ...owner, effected: true })
      }
    }
  }
  action returnFromCallback(attempt: int, result: str): bool = {
    val owner = s.attempts.get(attempt)
    val claim = s.claims.get(owner.request)
    val returned = {
      ...s,
      attempts: s.attempts.set(attempt, {
        ...owner,
        phase: if (result == "promise") "pending" else "settled"
      })
    }
    val updated = if (result == "promise") {
      ...returned,
      claims: returned.claims.set(owner.request, { ...claim, applying: true })
    } else if (result == "applied") commit(returned, owner.request, "applied")
      else returned
    all {
      owner.phase == "invoking",
      s' = updated
    }
  }
  action settle(attempt: int, result: str): bool = {
    val owner = s.attempts.get(attempt)
    val claim = s.claims.get(owner.request)
    val stillActive = s.active.contains(owner.listener)
    val completed = {
      ...s,
      attempts: s.attempts.set(attempt, { ...owner, phase: "settled" }),
      claims: s.claims.set(owner.request, {
        ...claim,
        applying: false,
        declined: if (stillActive and result != "applied" and owner.epoch == s.epoch)
          claim.declined.union(Set(owner.listener)) else claim.declined
      })
    }
    all {
      owner.phase == "pending",
      s' = if (stillActive and result == "applied") commit(completed, owner.request, "applied")
        else completed
    }
  }
  action reject(id: int): bool = {
    val claim = s.claims.get(id)
    all {
      claim.live and not(claim.claimed) and claim.applying,
      s' = commit(s, id, "rejected")
    }
  }
  action idle = s' = s
  action step = any {
    admit,
    {
      nondet listener = Set(1, 2).oneOf()
      mount(listener)
    },
    {
      nondet listener = Set(1, 2).oneOf()
      unmount(listener)
    },
    {
      nondet listener = Set(1, 2).oneOf()
      invoke(listener)
    },
    {
      nondet attempt = attemptIds.oneOf()
      effect(attempt)
    },
    {
      nondet attempt = attemptIds.oneOf()
      nondet result = Set("promise", "applied", "declined", "threw").oneOf()
      returnFromCallback(attempt, result)
    },
    {
      nondet attempt = attemptIds.oneOf()
      nondet result = Set("applied", "declined", "threw").oneOf()
      settle(attempt, result)
    },
    {
      nondet id = requestIds.oneOf()
      reject(id)
    },
    idle
  }
  val queueBound = s.queue.length() <= s.capacity
  val oneResolution = requestIds.forall(id => s.claims.get(id).resolutions <= 1)
  val queuedClaimsLive = s.queue.indices().forall(index => {
    val claim = s.claims.get(s.queue.nth(index))
    claim.live and not(claim.claimed) and claim.resolution == "pending"
  })
  val distinctQueue = s.queue.indices().forall(left => s.queue.indices().forall(right =>
    left == right or s.queue.nth(left) != s.queue.nth(right)))
  val invariant = queueBound and oneResolution and queuedClaimsLive and distinctQueue
  // This is intentionally false in the current source: an active handler can
  // perform a partial effect, retire, then leave the request available to replay.
  val AtMostOnePartialEffect = requestIds.forall(id => s.claims.get(id).effects <= 1)
  // Counts never decrease. Once a duplicate is observed, this eventual safe
  // suffix is impossible. TLC retains an explicit looping counterexample.
  temporal EventuallySingleEffect = eventually(always(AtMostOnePartialEffect))
  // A stalled retired promise can retain applying forever even with a new
  // listener. No fairness of that retired external promise is assumed.
  temporal RetiredPromiseDoesNotBlock = always(
    s.active.contains(2) and s.claims.get(1).applying and not(s.active.contains(1))
      implies eventually(not(s.claims.get(1).applying)))

  run retiredPromiseRetainsClaimTest = init.then(mount(1)).then(admit).then(invoke(1))
    .then(returnFromCallback(1, "promise")).then(unmount(1)).then(mount(2))
    .expect(s.claims.get(1).applying and s.claims.get(1).resolution == "pending" and invariant)
  run retiredEffectIsReplayedTest = init.then(mount(1)).then(admit).then(invoke(1)).then(effect(1))
    .then(returnFromCallback(1, "promise")).then(unmount(1)).then(mount(2))
    .then(settle(1, "applied")).then(invoke(2)).then(effect(2))
    .then(returnFromCallback(2, "applied"))
    .expect(s.claims.get(1).effects == 2 and oneResolution and invariant)
}
