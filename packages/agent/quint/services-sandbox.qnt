// sandbox-manager.ts: serialized standard/max lifecycle, two separately owned containers.
// Cleanup failure must remain retryable and must not publish stopped while resources exist.
module services_sandbox {
  var s: { phase: str, main: bool, browser: bool, mainExists: bool, browserExists: bool, error: bool }
  action init = s' = { phase: "uninitialized", main: false, browser: false, mainExists: false, browserExists: false, error: false }
  action start = all { s.phase.in(Set("uninitialized", "stopped")), s' = s.with("phase", "initializing").with("error", false) }
  action createMain = all { s.phase == "initializing", not(s.main), s' = s.with("main", true).with("mainExists", true) }
  action createBrowser = all { s.phase == "initializing", s.main, not(s.browser), s' = s.with("browser", true).with("browserExists", true) }
  action ready = all { s.phase == "initializing", s.main, s' = s.with("phase", "ready") }
  action startFail = all { s.phase == "initializing", s' = s.with("phase", "degraded").with("error", true) }
  action recover = all { s.phase == "degraded", not(s.main), not(s.browser), s' = s.with("phase", "initializing").with("error", false) }
  action stop = all { s.phase.in(Set("ready", "degraded", "uninitialized")), s' = s.with("phase", "stopping") }
  action removeBrowser = all { s.phase == "stopping", s.browser, s' = s.with("browser", false).with("browserExists", false) }
  action removeMain = all { s.phase == "stopping", s.main, s' = s.with("main", false).with("mainExists", false) }
  action loseMainAck = all { s.phase == "stopping", s.main, s' = s.with("mainExists", false) }
  action confirmMainAbsent = all { s.phase == "stopping", s.main, not(s.mainExists), s' = s.with("main", false) }
  action cleanupFailure = all { s.phase == "stopping", s.main or s.browser, s' = s.with("phase", "degraded").with("error", true) }
  action stopped = all { s.phase == "stopping", not(s.main), not(s.browser), s' = s.with("phase", "stopped") }
  action keep = s' = s
  action step = any { start, createMain, createBrowser, ready, startFail, recover, stop, removeBrowser, removeMain, loseMainAck, confirmMainAbsent, cleanupFailure, stopped, keep }
  action legacyStep = any { step, all { s.phase == "stopping", s.main or s.browser, s' = s.with("phase", "stopped") } }
  val safety = all { s.phase.in(Set("uninitialized", "initializing", "ready", "degraded", "stopping", "stopped")), s.phase == "stopped" implies not(s.main or s.browser), s.phase == "ready" implies s.main, s.mainExists implies s.main, s.browserExists implies s.browser }
  run retryFailedStopTest = init.then(start).then(createMain).then(createBrowser).then(ready).then(stop).then(removeBrowser).then(cleanupFailure).expect(s.phase == "degraded" and s.main).then(stop).then(removeMain).then(stopped).expect(not(s.main or s.browser))
  run failedStartIsNotReadyTest = init.then(start).then(startFail).expect(s.phase == "degraded" and s.error)
  run lostRemovalAcknowledgementCanReconcileTest = init.then(start).then(createMain).then(ready).then(stop).then(loseMainAck).then(cleanupFailure).then(stop).then(confirmMainAbsent).then(stopped).expect(not(s.main or s.mainExists))

  run discardedCleanupWitnessTest = init.then(start).then(createMain)
    .then(ready).then(stop)
    .then(all { s.phase == "stopping", s.main, s' = s.with("phase", "stopped") })
    .expect(not(safety))
}
