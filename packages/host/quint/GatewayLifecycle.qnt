// startGatewayLifecycle. Four optional resource handles are acquired in order.
// Cleanup owns a single promise and releases in reverse order despite failure.
module GatewayLifecycle {
  pure val resources = Set(0, 1, 2, 3)
  var s: {
    phase: str,
    next: int,
    acquired: Set[int],
    released: Set[int],
    releaseCount: int -> int,
    cleanupOwner: bool,
    listening: bool,
    readyReported: bool,
    errors: int,
    lastReleased: int
  }
  action init = s' = {
    phase: "acquiring",
    next: 0,
    acquired: Set(),
    released: Set(),
    releaseCount: resources.mapBy(_ => 0),
    cleanupOwner: false,
    listening: false,
    readyReported: false,
    errors: 0,
    lastReleased: 4
  }
  action acquire(present: bool): bool = all {
    s.phase == "acquiring",
    s.next < 4,
    s' = s
      .with("next", s.next + 1)
      .with("acquired", if (present) s.acquired.union(Set(s.next)) else s.acquired)
  }
  action bind = all {
    s.phase == "acquiring",
    s.next == 4,
    s' = s
      .with("phase", "binding")
  }
  action listen = all {
    s.phase == "binding",
    s' = s
      .with("phase", "ready")
      .with("listening", true)
      .with("readyReported", true)
  }
  action cleanup = all {
    s.phase != "closed",
    s' = s
      .with("phase", "cleanup")
      .with("cleanupOwner", true)
      .with("listening", false)
  }
  action dispose(r: int, failed: bool): bool = all {
    s.phase == "cleanup",
    s.acquired.contains(r),
    not(s.released.contains(r)),
    s.acquired.filter(other => not(s.released.contains(other))).forall(other => other <= r),
    s' = s
      .with("released", s.released.union(Set(r)))
      .with("releaseCount", s.releaseCount.set(r, s.releaseCount.get(r) + 1))
      .with("errors", s.errors + (if (failed) 1 else 0))
      .with("lastReleased", r)
  }
  action finish = all {
    s.phase == "cleanup",
    s.acquired == s.released,
    s' = s
      .with("phase", "closed")
  }
  action step = {
    nondet present = Set(true, false).oneOf();
    nondet r = resources.oneOf();
    any {
      acquire(present),
      bind,
      listen,
      cleanup,
      dispose(r, present),
      finish,
      s' = s
    }
  }
  val invariant = and {
    s.released.subseteq(s.acquired),
    resources.forall(r => s.releaseCount.get(r) <= 1),
    (s.phase == "ready") implies s.listening,
    (s.phase == "closed") implies s.acquired == s.released,
    s.cleanupOwner implies Set("cleanup", "closed").contains(s.phase)
  }
}
