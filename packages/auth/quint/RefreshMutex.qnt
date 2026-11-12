// The absent predecessor is sentinel 0, representing an already-resolved promise.
// KeyedMutex.acquire. Each caller registers its nonrejecting tail before await.
// Caller 1 and 2 share a key. Caller 3 uses an independent key.
module RefreshMutex {
  pure val callers = Set(1, 2, 3)
  pure val keyIds = Set(0, 1)
  pure val key = Map(1 -> 0, 2 -> 0, 3 -> 1)
  var s: {
    pc: int -> str,
    predecessor: int -> int,
    tail: int -> int,
    starts: int -> int,
    outcome: int -> str
  }
  action init = s' = {
    pc: Set(0, 1, 2, 3).mapBy(c => if (c == 0) "done" else "idle"),
    predecessor: callers.mapBy(_ => 0),
    tail: keyIds.mapBy(_ => 0),
    starts: callers.mapBy(_ => 0),
    outcome: callers.mapBy(_ => "none")
  }
  action acquire(c: int): bool = all {
    s.pc.get(c) == "idle",
    s' = s
      .with("pc", s.pc.set(c, "queued"))
      .with("predecessor", s.predecessor.set(c, s.tail.get(key.get(c))))
      .with("tail", s.tail.set(key.get(c), c))
  }
  action start(c: int): bool = all {
    s.pc.get(c) == "queued",
    (s.predecessor.get(c) == 0 or s.pc.get(s.predecessor.get(c)) == "done"),
    s' = s
      .with("pc", s.pc.set(c, "running"))
      .with("starts", s.starts.set(c, s.starts.get(c) + 1))
  }
  action settle(c: int, outcome: str): bool = all {
    s.pc.get(c) == "running",
    s' = s
      .with("pc", s.pc.set(c, "done"))
      .with("outcome", s.outcome.set(c, outcome))
      .with("tail", if (s.tail.get(key.get(c)) == c) s.tail.set(key.get(c), 0) else s.tail)
  }
  action step = {
    nondet c = callers.oneOf();
    nondet outcome = Set("ok", "threw").oneOf();
    any {
      acquire(c),
      start(c),
      settle(c, outcome),
      s' = s
    }
  }
  val invariant = and {
    keyIds.forall(k => callers.filter(c => key.get(c) == k and s.pc.get(c) == "running").size() <= 1),
    callers.forall(c => s.starts.get(c) <= 1),
    callers.forall(c => (s.pc.get(c) == "running" or s.pc.get(c) == "done") implies (s.predecessor.get(c) == 0 or s.pc.get(s.predecessor.get(c)) == "done")),
    callers.forall(c => (s.pc.get(c) == "queued" or s.pc.get(c) == "running") implies s.tail.get(key.get(c)) != 0)
  }
}
