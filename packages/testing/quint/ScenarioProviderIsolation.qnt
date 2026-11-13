// Two LLM settings are restored together after the scenario mocks start.
// Endpoint classes abstract URL parsing, not provider responses or credentials.
module ScenarioProviderIsolation {
  val settings = Set("openai", "anthropic")
  val endpoints = Set("absent", "mock", "live")
  type State = {
    live: bool, selected: str -> str, own: str -> str,
    before: str -> str, current: str -> str, phase: str,
  }
  var s: State
  action start(live: bool, selectedOpenai: str, selectedAnthropic: str,
    ownOpenai: str, ownAnthropic: str, currentOpenai: str, currentAnthropic: str): bool = {
    val current = Map("openai" -> currentOpenai, "anthropic" -> currentAnthropic)
    s' = { live: live,
      selected: Map("openai" -> selectedOpenai, "anthropic" -> selectedAnthropic),
      own: Map("openai" -> ownOpenai, "anthropic" -> ownAnthropic),
      before: current, current: current, phase: "pending" }
  }
  action init = {
    nondet live = Set(false, true).oneOf()
    nondet selectedOpenai = endpoints.oneOf()
    nondet selectedAnthropic = endpoints.oneOf()
    nondet ownOpenai = endpoints.oneOf()
    nondet ownAnthropic = endpoints.oneOf()
    nondet currentOpenai = endpoints.oneOf()
    nondet currentAnthropic = endpoints.oneOf()
    start(live, selectedOpenai, selectedAnthropic,
      ownOpenai, ownAnthropic, currentOpenai, currentAnthropic)
  }
  action restore = all { s.phase == "pending",
    s' = if (not(s.live)) { ...s, phase: "deterministic" }
      else if (settings.exists(k => s.selected.get(k) == "mock")) { ...s, phase: "refused" }
      else { ...s, phase: "restored", current: settings.mapBy(k =>
        if (s.selected.get(k) != "absent") s.selected.get(k)
        else if (s.own.get(k) == "mock") "absent" else s.own.get(k)) }
  }
  action idle = s' = s
  action step = any { restore, idle }
  val LiveNeverKeepsMock = s.phase == "restored" implies
    settings.forall(k => s.current.get(k) != "mock")
  val RefusalPreservesEnvironment = s.phase == "refused" implies s.current == s.before
  val DeterministicKeepsEnvironment = not(s.live) implies s.current == s.before
  val SelectedProviderWins = s.phase == "restored" implies settings.forall(k =>
    s.selected.get(k) != "absent" implies s.current.get(k) == s.selected.get(k))
  val OwnLiveSettingIsRestored = s.phase == "restored" implies settings.forall(k =>
    (s.selected.get(k) == "absent" and s.own.get(k) == "live") implies s.current.get(k) == "live")
  val safety = LiveNeverKeepsMock and RefusalPreservesEnvironment and
    DeterministicKeepsEnvironment and SelectedProviderWins and OwnLiveSettingIsRestored
  run rejectsBeforeMutation = start(true, "mock", "absent", "live", "live", "live", "live")
    .then(restore).expect(s.phase == "refused" and s.current == s.before and safety)
  run restoresOwnLiveSetting = start(true, "absent", "absent", "mock", "live", "mock", "mock")
    .then(restore).expect(s.current.get("openai") == "absent" and s.current.get("anthropic") == "live" and safety)
  run selectedLiveSettingWins = start(true, "live", "absent", "mock", "live", "mock", "mock")
    .then(restore).expect(settings.forall(k => s.current.get(k) == "live") and safety)
  run deterministicKeepsMocks = start(false, "mock", "mock", "absent", "absent", "mock", "mock")
    .then(restore).expect(s.current == s.before and safety)
}
