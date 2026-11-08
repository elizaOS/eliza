// Conservative strategy fallback after classifying against pre-prepare config.
// Source: runtime/operations/manager.ts resolveExecutableTier; classifier.ts.
// Tiers 0/1/2 represent hot/warm/cold. Configuration is fixed per request.
module runtime_operation_tiers {
  var s: { strategies: Set[int], requested: int, cursor: int, selected: int, status: str }
  action init = s' = { strategies: Set(), requested: -1, cursor: -1, selected: -1, status: "idle" }
  action configure(strategies: Set[int]): bool = all { s.status == "idle", s' = s.with("strategies", strategies) }
  action submit(tier: int): bool = all { s.status == "idle", s' = s.with("requested", tier).with("cursor", tier).with("status", "selecting") }
  action selectTier = all { s.status == "selecting", s.strategies.contains(s.cursor), s' = s.with("selected", s.cursor).with("status", "selected") }
  action upgrade = all { s.status == "selecting", not(s.strategies.contains(s.cursor)), s.cursor < 2, s' = s.with("cursor", s.cursor + 1) }
  action unavailable = all { s.status == "selecting", not(s.strategies.contains(s.cursor)), s.cursor == 2, s' = s.with("status", "failed") }
  action configureAny = { nondet strategies = Set(0, 1, 2).powerset().oneOf(); configure(strategies) }
  action idle = s' = s
  action step = any { configureAny, submit(0), submit(1), submit(2), selectTier, upgrade, unavailable, idle }
  val safety = all {
    s.status == "selected" implies all {
      s.selected >= s.requested,
      s.strategies.contains(s.selected),
      s.strategies.forall(tier => tier < s.requested or tier >= s.selected)
    },
    s.status == "failed" implies s.strategies.forall(tier => tier < s.requested)
  }
  run unavailableWarmUpgradesToColdTest = init.then(configure(Set(0, 2))).then(submit(1)).then(upgrade).then(selectTier).expect(safety and s.selected == 2)
  run coldNeverFallsBackToHotTest = init.then(configure(Set(0))).then(submit(2)).then(unavailable).expect(safety and s.status == "failed")
  run cheapestAvailableTierTest = init.then(configure(Set(0, 1, 2))).then(submit(0)).then(selectTier).expect(safety and s.selected == 0)
}
