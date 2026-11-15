// Logical time 0..4 includes both sides of the three-tick expiry.
// v1 execution authorization. Verification and atomic UPDATE are separate
// actions, so expiry may occur after verification and consumers may race.
// Cryptographic signature validity and full tenant/agent/capability/backend/
// payload matching are abstract input predicates, not cryptographic proofs.
module ExecutionAuthorization {
  pure val consumers = Set(1, 2, 3)
  var s: {
    status: str,
    now: int,
    expires: int,
    verified: Set[int],
    accepted: Set[int],
    badAccepted: bool
  }
  action init = s' = {
    status: "active",
    now: 0,
    expires: 3,
    verified: Set(),
    accepted: Set(),
    badAccepted: false
  }
  action verify(c: int, signature: bool, context: bool): bool = s' = if (signature and context and s.now < s.expires) s
    .with("verified", s.verified.union(Set(c))) else s
  action consume(c: int): bool = all {
    s.verified.contains(c),
    s' = if (s.status == "active" and s.now < s.expires)
    s
      .with("status", "consumed")
      .with("accepted", s.accepted.union(Set(c)))
      .with("badAccepted", s.badAccepted or s.now >= s.expires)
    else s
  }
  action tick = all {
    s.now < 4,
    s' = s
      .with("now", s.now + 1)
  }
  action step = {
    nondet c = consumers.oneOf();
    nondet signature = Set(true, false).oneOf();
    nondet context = Set(true, false).oneOf();
    any {
      verify(c, signature, context),
      consume(c),
      tick
    }
  }
  val invariant = and {
    s.accepted.size() <= 1,
    not(s.badAccepted),
    s.accepted.subseteq(s.verified),
    (s.accepted.size() > 0) implies s.status == "consumed"
  }
}
