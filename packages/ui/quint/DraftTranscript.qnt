// Finite domain admits three invalidations/capture starts and three user edit revisions.
// DraftTranscriptGuard. Two retained callback closures and symbolic text values
// exercise supersession and edits across every asynchronous callback boundary.
module DraftTranscript {
  pure val callbacks = Set(1, 2)
  var s: {
    current: int,
    revision: int,
    generation: int,
    ticket: int -> int,
    captured: int -> int,
    active: Set[int],
    last: str,
    before: int,
    validGeneration: bool,
    validRevision: bool,
    final: bool,
    actionName: str,
    callback: int,
    text: int
  }
  action init = s' = {
    current: 0,
    revision: 0,
    generation: 0,
    ticket: Map(1 -> 0, 2 -> 0),
    captured: Map(1 -> 0, 2 -> 0),
    active: Set(),
    last: "init",
    before: 0,
    validGeneration: true,
    validRevision: true,
    final: false,
    actionName: "init",
    callback: 0,
    text: 0
  }
  action observe(text: int): bool = all {
    (text == s.current or s.revision < 3),
    s' = s
      .with("current", text)
      .with("revision", s.revision + (if (text != s.current) 1 else 0))
      .with("last", "observe")
      .with("actionName", "observe")
      .with("text", text)
  }
  action invalidate = all {
    s.generation < 3,
    s' = s
      .with("generation", s.generation + 1)
      .with("last", "invalidate")
      .with("actionName", "invalidate")
  }
  action begin(c: int): bool = all {
    s.generation < 3,
    s' = s
      .with("generation", s.generation + 1)
      .with("ticket", s.ticket.set(c, s.generation + 1))
      .with("captured", s.captured.set(c, s.revision))
      .with("active", s.active.union(Set(c)))
      .with("last", "begin")
      .with("actionName", "begin")
      .with("callback", c)
  }
  action deliver(c: int, text: int, final: bool): bool = all {
    s.active.contains(c),
    s' = s
      .with("before", s.current)
      .with("validGeneration", s.ticket.get(c) == s.generation)
      .with("validRevision", s.captured.get(c) == s.revision)
      .with("final", final)
      .with("actionName", "deliver")
      .with("callback", c)
      .with("text", text)
      .with("current", if (s.ticket.get(c) == s.generation and s.captured.get(c) == s.revision) text else s.current)
      .with("last", if (s.ticket.get(c) != s.generation) "ignored" else if (s.captured.get(c) != s.revision) (if (final) "conflict" else "ignored") else "applied")
  }
  action step = {
    nondet c = callbacks.oneOf();
    nondet text = Set(0, 1, 2).oneOf();
    nondet final = Set(true, false).oneOf()
    any {
      observe(text),
      invalidate,
      begin(c),
      deliver(c, text, final)
    }
  }
  val invariant = and {
    s.revision >= 0,
    s.generation >= 0,
    (s.last == "applied") implies (s.validGeneration and s.validRevision),
    (s.last == "ignored" or s.last == "conflict") implies s.current == s.before,
    (s.last == "conflict") implies (s.validGeneration and not(s.validRevision) and s.final)
  }
}
