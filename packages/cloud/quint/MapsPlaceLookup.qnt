// One already admitted reverse lookup. Provider settlement is an external step.
module MapsPlaceLookup {
  var s: {
    prefer: bool, cancelled: bool, nearby: str, fallback: str,
    phase: str, result: str, nearbyCalls: int, geocodeCalls: int
  }
  action init = {
    nondet prefer = Set(false, true).oneOf()
    nondet cancelled = Set(false, true).oneOf()
    nondet nearby = Set("place", "empty", "invalid", "outage").oneOf()
    nondet fallback = Set("address", "empty", "invalid", "outage").oneOf()
    s' = { prefer: prefer, cancelled: cancelled, nearby: nearby, fallback: fallback,
      phase: "start", result: "pending", nearbyCalls: 0, geocodeCalls: 0 }
  }
  action begin = all {
    s.phase == "start",
    s' = if (s.cancelled) { ...s, phase: "done", result: "cancelled" }
      else if (s.prefer) { ...s, phase: "nearby", nearbyCalls: 1 }
      else { ...s, phase: "geocode", geocodeCalls: 1 }
  }
  action settleNearby = all {
    s.phase == "nearby",
    s' = if (s.nearby == "empty") { ...s, phase: "geocode", geocodeCalls: 1 }
      else { ...s, phase: "done", result: s.nearby }
  }
  action settleGeocode = all {
    s.phase == "geocode",
    s' = { ...s, phase: "done", result: s.fallback }
  }
  action advance = any { begin, settleNearby, settleGeocode }
  action step = any { advance, s' = s }
  val safety = all {
    s.nearbyCalls.in(Set(0, 1)), s.geocodeCalls.in(Set(0, 1)),
    s.nearbyCalls == 1 implies s.prefer,
    s.geocodeCalls == 1 implies (not(s.prefer) or s.nearby == "empty"),
    s.cancelled implies (s.nearbyCalls == 0 and s.geocodeCalls == 0),
    s.phase == "done" implies s.result != "pending",
    s.phase == "done" and s.cancelled implies s.result == "cancelled",
    s.phase == "done" and not(s.cancelled) implies
      s.result == (if (s.prefer and s.nearby != "empty") s.nearby else s.fallback)
  }
  temporal Settles = advance.weakFair(s) implies (s.phase == "start").leadsTo(s.phase == "done")
  run settlesTest = init.then(begin).then(
    any { advance, s' = s }
  ).then(any { advance, s' = s }).expect(safety)
}
