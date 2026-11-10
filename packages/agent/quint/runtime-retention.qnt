// Scheduler worker publication, asynchronous installation, one sweep, and stop.
// Sources: runtime/retention-task.ts, memory-retention-service.ts, logs-retention-service.ts.
// Storage commits are atomic; scheduling uses the existing core TaskService.
module runtime_retention {
  var s: { phase: str, installing: bool, worker: bool, task: bool, sweep: bool, failure: bool }
  action init = s' = { phase: "new", installing: false, worker: false, task: false, sweep: false, failure: false }
  action start = all { s.phase == "new", s' = s.with("phase", "starting").with("installing", true).with("worker", true) }
  action install = all { s.installing, s.phase == "starting", s' = s.with("phase", "running").with("installing", false).with("task", true) }
  action installDuringStop = all { s.installing, s.phase == "stopping", s' = s.with("installing", false).with("task", true) }
  action failedInstall = all { s.installing, s' = s.with("installing", false).with("failure", true).with("worker", false) }
  action runSweep = all { s.phase == "running", not(s.sweep), s' = s.with("sweep", true) }
  action settleSweep = all { s.sweep, s' = s.with("sweep", false) }
  action stop = all { s.phase != "stopped", s.phase != "stopping", s' = s.with("phase", "stopping") }
  action finishStop = all { s.phase == "stopping", not(s.installing), not(s.sweep), s' = s.with("phase", "stopped").with("worker", false).with("task", false) }
  action idle = s' = s
  action step = any { start, install, installDuringStop, failedInstall, runSweep, settleSweep, stop, finishStop, idle }
  val safety = all { s.phase == "stopped" implies all { not(s.task), not(s.worker), not(s.installing), not(s.sweep) }, s.task implies s.worker }
  run stopDuringStartTest = init.then(start).then(stop).then(installDuringStop).then(finishStop).expect(safety and s.phase == "stopped")
  run drainSweepTest = init.then(start).then(install).then(runSweep).then(stop).then(settleSweep).then(finishStop).expect(safety)
  // Mutation witness for the old stop path, which did not await installation.
  action legacyFinishStop = all { s.phase == "stopping", s' = s.with("phase", "stopped").with("worker", false) }
  action legacyInstall = all { s.installing, s' = s.with("installing", false).with("task", true) }
  run oldStopRaceWitnessTest = init.then(start).then(stop).then(legacyFinishStop).then(legacyInstall).expect(not(safety))
  action legacyStep = any { start, stop, legacyFinishStop, legacyInstall, idle }
}
