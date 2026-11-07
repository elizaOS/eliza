// Logical clock 0..4; counters and imports range over the explicit finite limits.
// VoiceUsageState's transaction boundary. Organization key 0, user keyIds 1/2.
// Imports are atomic, idempotent and admitted only before first live operation.
module VoiceUsage {
  pure val keyIds = Set(0, 1)
  var s: {
    counts: int -> int,
    expires: int -> int,
    imports: int -> int,
    imported: Set[int],
    serving: bool,
    now: int,
    event: str,
    accepted: bool,
    user: int,
    amount: int,
    orgLimit: int,
    userLimit: int,
    previous: int -> int,
    wasServing: bool
  }
  action init = s' = {
    counts: keyIds.mapBy(_ => 0),
    expires: keyIds.mapBy(_ => 0),
    imports: keyIds.mapBy(_ => 0),
    imported: Set(),
    serving: false,
    now: 0,
    event: "init",
    accepted: false,
    user: 1,
    amount: 1,
    orgLimit: 3,
    userLimit: 2,
    previous: keyIds.mapBy(_ => 0),
    wasServing: false
  }
  pure def liveCounts(counts, expires, now) = keyIds.mapBy(k => if (expires.get(k) <= now) 0 else counts.get(k))
  action operation(user: int, amount: int, reserve: bool): bool = {
    val counts = liveCounts(s.counts, s.expires, s.now)
    val accepted = not(reserve) or (counts.get(0) + amount <= s.orgLimit and counts.get(user) + amount <= s.userLimit)
    val orgValue = if (reserve) counts.get(0) + amount else if (counts.get(0) >= amount) counts.get(0) - amount else 0
    val userValue = if (reserve) counts.get(user) + amount else if (counts.get(user) >= amount) counts.get(user) - amount else 0
    s' = s
      .with("serving", true)
      .with("previous", counts)
      .with("wasServing", s.serving)
      .with("user", user)
      .with("amount", amount)
      .with("event", if (reserve) "reserve" else "release")
      .with("accepted", accepted)
      .with("counts", if (accepted) counts.set(0, orgValue).set(user, userValue) else counts)
      .with("expires", if (accepted) s.expires.set(0, s.now + 3).set(user, s.now + 3) else s.expires)
  }
  action importSnapshot(values: int -> int, quiesced: bool): bool = {
    val accepted = not(s.serving) and quiesced and keyIds.forall(k => not(s.imported.contains(k)) or s.imports.get(k) == values.get(k))
    s' = s
      .with("previous", s.counts)
      .with("wasServing", s.serving)
      .with("event", "import")
      .with("accepted", accepted)
      .with("counts", if (accepted) keyIds.mapBy(k => if (s.imported.contains(k) or s.now >= 3) s.counts.get(k) else values.get(k)) else s.counts)
      .with("expires", if (accepted) keyIds.mapBy(k => if (s.imported.contains(k) or s.now >= 3) s.expires.get(k) else 3) else s.expires)
      .with("imports", if (accepted) values else s.imports)
      .with("imported", if (accepted) keyIds else s.imported)
  }
  action tick = all {
    s.now < 4,
    s' = s
      .with("now", s.now + 1)
      .with("event", "tick")
  }
  action alarm = s' = s
    .with("counts", liveCounts(s.counts, s.expires, s.now))
    .with("event", "alarm")
  action step = {
    nondet user = Set(1).oneOf();
    nondet amount = Set(1, 2).oneOf();
    nondet reserve = Set(true, false).oneOf();
    nondet v0 = Set(0, 1, 2).oneOf();
    nondet v1 = Set(0, 1, 2).oneOf();
    any {
      operation(user, amount, reserve),
      importSnapshot(Map(0 -> v0, 1 -> v1), reserve),
      tick,
      alarm
    }
  }
  val invariant = and {
    keyIds.forall(k => s.counts.get(k) >= 0),
    (s.event == "reserve" and s.accepted) implies (s.counts.get(0) <= s.orgLimit and s.counts.get(s.user) <= s.userLimit),
    (s.event == "reserve" and not(s.accepted)) implies s.counts == s.previous,
    (s.event == "import" and s.wasServing) implies (not(s.accepted) and s.counts == s.previous),
    (s.event == "import" and not(s.accepted)) implies s.counts == s.previous
  }
}
