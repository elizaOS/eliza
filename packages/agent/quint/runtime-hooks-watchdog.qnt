// Hook reload/dispatch snapshot and sustained-memory restart latch.
// Sources: hooks/{registry,loader,discovery,eligibility}.ts; runtime/memory-watchdog.ts.
// Two hooks abstract ordered handlers; accepted dispatches drain their snapshot
// after disable. Restart failure re-arms only after the pending request settles.
module runtime_hooks_watchdog {
  var s: { enabled: bool, hooks: int, remaining: int, delivered: int, dispatching: bool, over: int, restart: str }
  action init = s' = { enabled: false, hooks: 0, remaining: 0, delivered: 0, dispatching: false, over: 0, restart: "idle" }
  action enable = s' = s.with("enabled", true).with("hooks", 2)
  action disable = s' = s.with("enabled", false).with("hooks", 0)
  action dispatch = all { not(s.dispatching), s.enabled, s' = s.with("remaining", s.hooks).with("delivered", 0).with("dispatching", true) }
  action deliver = all { s.dispatching, s.remaining > 0, s' = s.with("remaining", s.remaining - 1).with("delivered", s.delivered + 1) }
  action dispatchDone = all { s.dispatching, s.remaining == 0, s' = s.with("dispatching", false) }
  action highSample = all { s.restart == "idle", s.over < 2, s' = s.with("over", s.over + 1) }
  action lowSample = all { s.restart == "idle", s' = s.with("over", 0) }
  action requestRestart = all { s.restart == "idle", s.over == 2, s' = s.with("restart", "pending") }
  action restartFailed = all { s.restart == "pending", s' = s.with("restart", "idle") }
  action restartAccepted = all { s.restart == "pending", s' = s.with("restart", "accepted") }
  action idle = s' = s
  action step = any { enable, disable, dispatch, deliver, dispatchDone, highSample, lowSample, requestRestart, restartFailed, restartAccepted, idle }
  val safety = all { not(s.enabled) implies s.hooks == 0, s.delivered + s.remaining <= 2, s.over <= 2, s.restart != "idle" implies s.over == 2 }
  run disabledRegistryTest = init.then(enable).then(disable).expect(safety and s.hooks == 0)
  run acceptedDispatchDrainsTest = init.then(enable).then(dispatch).then(disable).then(deliver).then(deliver).then(dispatchDone).expect(safety and s.delivered == 2)
  run failedRestartRearmsTest = init.then(highSample).then(highSample).then(requestRestart).then(restartFailed).then(requestRestart).then(restartAccepted).expect(safety)
  // The disabled branch previously returned before clearing old handlers.
  action legacyDisable = s' = s.with("enabled", false)
  action legacyStep = any { enable, legacyDisable, idle }
  run staleHooksWitnessTest = init.then(enable).then(legacyDisable).expect(not(safety))
}
