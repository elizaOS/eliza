// remote-coding-runner.ts: full operations hold leases through create, prepare,
// request and response. Stop fences new effects, drains leases, then destroys
// an owned runner. Failed create/prepare remains retryable before shutdown.
module services_remote_runner {
  var s: { phase: str, users: int, resource: bool, prepared: bool, stopping: bool, stopped: bool, effects: int, effectsAtStop: int }
  action init = s' = { phase: "empty", users: 0, resource: false, prepared: false, stopping: false, stopped: false, effects: 0, effectsAtStop: 0 }
  action request = all { not(s.stopping), s.users < 2, s' = s.with("users", s.users + 1).with("phase", if (s.phase == "empty") "creating" else if (s.phase == "created") "preparing" else s.phase) }
  action created = all { s.phase == "creating", s' = s.with("phase", if (s.stopping) "created" else "preparing").with("resource", true) }
  action createFailure = all { s.phase == "creating", s' = s.with("phase", "empty").with("users", 0) }
  action prepareDone = all { s.phase == "preparing", s' = s.with("phase", "ready").with("prepared", true) }
  action prepareFailure = all { s.phase == "preparing", s' = s.with("phase", "created").with("users", 0) }
  action invoke = all { s.phase == "ready", s.users > 0, not(s.stopping), s.effects < 2, s' = s.with("effects", s.effects + 1) }
  action release = all { s.phase.in(Set("ready","created")), s.users > 0, s' = s.with("users", s.users - 1) }
  action stop = all { not(s.stopping), s' = s.with("stopping", true).with("effectsAtStop", s.effects) }
  action stopComplete = all { s.stopping, s.users == 0, s.phase.in(Set("empty","created","ready")), s' = s.with("stopped", true).with("resource", false).with("prepared", false).with("phase", "empty") }
  action keep = s' = s
  action step = any { request, created, createFailure, prepareDone, prepareFailure, invoke, release, stop, stopComplete, keep }
  action legacyStop = all { s.phase.in(Set("created","preparing","ready")), s' = s.with("stopping", true).with("stopped", true).with("resource", false).with("prepared", false).with("effectsAtStop", s.effects) }
  action legacyStep = any { step, legacyStop }
  val safety = all { s.users >= 0, s.users <= 2, s.prepared implies s.resource, s.phase == "ready" implies s.prepared, s.stopped implies not(s.resource or s.prepared) and s.users == 0, s.stopping implies s.effects == s.effectsAtStop }
  run failedCreateAllowsRetryTest = init.then(request).then(createFailure).then(request).then(created).then(prepareDone).expect(s.phase == "ready")
  run stopDuringCreateFencesEffectTest = init.then(request).then(stop).then(created).then(release).then(stopComplete).expect(s.stopped and s.effects == 0)
  run stopDrainsExistingOperationTest = init.then(request).then(created).then(prepareDone).then(invoke).then(stop).then(release).then(stopComplete).expect(s.stopped and s.effects == 1)

  run prematureStopWitnessTest = init.then(request).then(created)
    .then(legacyStop).expect(not(safety))
}
