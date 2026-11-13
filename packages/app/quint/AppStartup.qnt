// At most two runtime-start attempts; further starts are outside this finite instance.
// Exact phase graph of AppStartupStateMachine. Logical time records transition
// order only. Date.now values do not order transitions in the implementation.
module AppStartup {
  pure val phases = Set("api-binding", "api-bound", "awaiting-onboarding", "runtime-starting", "runtime-ready", "features-starting", "ready", "degraded", "stopping", "failed")
  pure val allowed = Map(
  "api-binding" -> Set("api-bound", "failed", "stopping"),
  "api-bound" -> Set("awaiting-onboarding", "runtime-starting", "failed", "stopping"),
  "awaiting-onboarding" -> Set("runtime-starting", "failed", "stopping"),
  "runtime-starting" -> Set("runtime-ready", "features-starting", "ready", "degraded", "failed", "stopping"),
  "runtime-ready" -> Set("features-starting", "ready", "degraded", "runtime-starting", "stopping"),
  "features-starting" -> Set("ready", "degraded", "runtime-starting", "stopping"),
  "ready" -> Set("runtime-starting", "degraded", "stopping"),
  "degraded" -> Set("runtime-starting", "ready", "stopping"),
  "stopping" -> Set("failed"), "failed" -> Set("runtime-starting", "stopping"))
  pure def agentState(p) = if (p == "awaiting-onboarding") "not_started" else if (p == "failed") "error" else if (p == "stopping") "stopped" else if (Set("runtime-ready", "features-starting", "ready", "degraded").contains(p)) "running" else "starting"
  var s: {
    phase: str,
    agent: str,
    attempt: int,
    previous: str,
    previousAttempt: int,
    requested: str,
    accepted: bool
  }
  action init = s' = {
    phase: "api-binding",
    agent: "starting",
    attempt: 0,
    previous: "api-binding",
    previousAttempt: 0,
    requested: "api-binding",
    accepted: false
  }
  action move(p: str): bool = {
    val accepted = p != s.phase and allowed.get(s.phase).contains(p)
    all {
      (not(accepted and p == "runtime-starting") or s.attempt < 2),
      s' = {
        phase: if (accepted) p else s.phase,
        agent: if (accepted) agentState(p) else s.agent,
        attempt: s.attempt + (if (accepted and p == "runtime-starting") 1 else 0),
        previous: s.phase,
        previousAttempt: s.attempt,
        requested: p,
        accepted: accepted
      }
    }
  }
  action step = {
    nondet p = phases.oneOf();
    move(p)
  }
  val invariant = and {
    phases.contains(s.phase),
    s.agent == agentState(s.phase),
    s.attempt == s.previousAttempt + (if (s.accepted and s.requested == "runtime-starting") 1 else 0),
    s.accepted implies allowed.get(s.previous).contains(s.phase),
    not(s.accepted) implies s.phase == s.previous
  }
}
