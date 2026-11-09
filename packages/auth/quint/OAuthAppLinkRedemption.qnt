// POST /auth/oauth/exchange reads one issued App Link code, checks its
// binding, takes a short lock, and consumes the same code before responding.
// The store TTL and the payload expiry are distinct checks in the route.
module OAuthAppLinkRedemption {
  val callers = Set(1, 2)
  val bindings = Set("match", "verifier", "redirect", "tenant", "policy")
  val lanes = Set("session", "mfa")
  val phases = Set("idle", "peeked", "validated", "locked", "consumed",
    "missing", "refused", "busy", "session", "mfa")
  val working = Set("peeked", "validated", "locked", "consumed", "missing")
  val locked = Set("locked", "consumed", "missing")
  val payloadExpiry = 2
  type Call = { phase: str, binding: str }
  type State = {
    calls: int -> Call, lane: str, now: int, storeExpiry: int, present: bool,
    owner: int, spentBy: int, spentAt: int,
  }
  var s: State

  action issued(lane: str, storeExpiry: int): bool = s' = {
    calls: callers.mapBy(_ => { phase: "idle", binding: "match" }),
    lane: lane, now: 0, storeExpiry: storeExpiry, present: true,
    owner: 0, spentBy: 0, spentAt: -1,
  }
  action init = {
    nondet lane = lanes.oneOf()
    nondet deadline = Set(payloadExpiry, payloadExpiry + 1).oneOf()
    issued(lane, deadline)
  }

  val live = s.present and s.now < s.storeExpiry
  action peek(c: int, binding: str): bool = all {
    s.calls.get(c).phase == "idle",
    s' = { ...s, calls: s.calls.put(c, {
      phase: if (live) "peeked" else "refused", binding: binding,
    }) },
  }
  action validate(c: int): bool = {
    val call = s.calls.get(c)
    all {
      call.phase == "peeked",
      s' = { ...s, calls: s.calls.put(c, { ...call,
        phase: if (s.now <= payloadExpiry and call.binding == "match") "validated"
          else "refused",
      }) },
    }
  }
  action acquire(c: int): bool = {
    val call = s.calls.get(c)
    all {
      call.phase == "validated",
      s' = { ...s,
        owner: if (s.owner == 0) c else s.owner,
        calls: s.calls.put(c, { ...call, phase: if (s.owner == 0) "locked" else "busy" }),
      },
    }
  }
  action consume(c: int): bool = {
    val call = s.calls.get(c)
    all {
      call.phase == "locked", s.owner == c,
      s' = { ...s, present: false,
        spentBy: if (live) c else s.spentBy,
        spentAt: if (live) s.now else s.spentAt,
        calls: s.calls.put(c, { ...call, phase: if (live) "consumed" else "missing" }),
      },
    }
  }
  action reply(c: int): bool = {
    val call = s.calls.get(c)
    all {
      call.phase.in(Set("consumed", "missing")), s.owner == c,
      s' = { ...s, owner: 0,
        calls: s.calls.put(c, { ...call, phase: if (call.phase == "consumed") s.lane else "refused" }),
      },
    }
  }
  action tick = all { s.now < 3, s' = { ...s, now: s.now + 1 } }
  action work(c: int): bool = any { validate(c), acquire(c), consume(c), reply(c) }
  action step = any {
    {
      nondet c = callers.oneOf()
      nondet binding = bindings.oneOf()
      peek(c, binding)
    },
    {
      nondet c = callers.oneOf()
      work(c)
    },
    tick, s' = s,
  }

  val TypeOK = and {
    s.calls.keys() == callers, s.lane.in(lanes), s.now.in(0.to(3)),
    s.storeExpiry.in(Set(payloadExpiry, payloadExpiry + 1)),
    s.owner.in(0.to(2)), s.spentBy.in(0.to(2)), s.spentAt.in((-1).to(3)),
    callers.forall(c => s.calls.get(c).phase.in(phases) and s.calls.get(c).binding.in(bindings)),
  }
  val SingleMatchingLockOwner = callers.forall(c =>
    s.calls.get(c).phase.in(locked).iff(s.owner == c) and
      (s.owner == c).implies(s.calls.get(c).binding == "match"))
  val RejectedBindingDoesNotSpend = callers.forall(c =>
    (s.calls.get(c).binding != "match").implies(s.spentBy != c)) and
      (not(s.present) and s.now < s.storeExpiry).implies(s.spentBy != 0)
  val AtMostOneSuccessfulRedemption =
    callers.filter(c => s.calls.get(c).phase.in(lanes)).size() <= 1
  val SuccessRequiresLiveConsume = callers.forall(c =>
    (s.calls.get(c).phase == "consumed" or s.calls.get(c).phase.in(lanes)).implies(and {
      s.spentBy == c, s.calls.get(c).binding == "match",
      not(s.present), s.spentAt >= 0, s.spentAt < s.storeExpiry,
    }))
  val ResultUsesIssuedLane = callers.forall(c =>
    s.calls.get(c).phase.in(lanes).implies(s.calls.get(c).phase == s.lane))
  temporal RequestsSettle = callers.forall(c => work(c).weakFair(s)) implies
    callers.forall(c => always(s.calls.get(c).phase.in(working).implies(
      eventually(not(s.calls.get(c).phase.in(working))))))

  run WrongVerifierLeavesCodeForOwnerTest = issued("session", 2)
    .then(peek(1, "verifier")).then(validate(1))
    .expect(s.present and s.spentBy == 0 and s.calls.get(1).phase == "refused")
    .then(peek(2, "match")).then(validate(2)).then(acquire(2)).then(consume(2)).then(reply(2))
    .expect(s.calls.get(2).phase == "session" and s.spentBy == 2)
  run ContendingCallerCannotAcquireTest = issued("session", 2)
    .then(peek(1, "match")).then(peek(2, "match")).then(validate(1)).then(validate(2))
    .then(acquire(1)).then(acquire(2)).expect(s.calls.get(2).phase == "busy" and s.owner == 1)
    .then(consume(1)).then(reply(1)).expect(s.calls.get(1).phase == "session")
  run StaleValidatedCallerCannotRedeemAgainTest = issued("session", 2)
    .then(peek(1, "match")).then(peek(2, "match")).then(validate(1)).then(validate(2))
    .then(acquire(1)).then(consume(1)).then(reply(1))
    .then(acquire(2)).then(consume(2)).then(reply(2))
    .expect(s.calls.get(1).phase == "session" and s.calls.get(2).phase == "refused")
  run StoreExpiryWhileLockHeldRefusesTest = issued("session", 2)
    .then(peek(1, "match")).then(validate(1)).then(acquire(1)).then(tick).then(tick)
    .then(consume(1)).then(reply(1))
    .expect(s.calls.get(1).phase == "refused" and s.spentBy == 0)
  run MfaCodeYieldsOnlyChallengeTest = issued("mfa", 2)
    .then(peek(1, "match")).then(validate(1)).then(acquire(1)).then(consume(1)).then(reply(1))
    .then(peek(2, "match")).expect(s.calls.get(1).phase == "mfa" and s.calls.get(2).phase == "refused")
}
