// permissions-registry.ts: per-permission serialized native probes, a stop fence,
// and dirty persistence retained after failure. Native probes cannot be aborted;
// shutdown drains them and discards any late result before flushing prior state.
module services_permissions {
  var s: { status: str, durable: str, dirty: bool, checking: bool, queued: bool, stopped: bool, returned: bool, revision: int, stopRevision: int, persistFailed: bool, settings: bool }
  action init = s' = { status: "unknown", durable: "unknown", dirty: false, checking: false, queued: false, stopped: false, returned: false, revision: 0, stopRevision: 0, persistFailed: false, settings: false }
  action check = all { not(s.stopped), not(s.checking), s' = s.with("checking", true) }
  action queue = all { not(s.stopped), s.checking, not(s.queued), s' = s.with("queued", true) }
  action observed(status: str): bool = all { s.checking, not(s.stopped), s.revision < 2, status.in(Set("granted","denied")), s' = s.with("checking", s.queued).with("queued", false).with("status", status).with("dirty", true).with("revision", s.revision + 1) }
  action probeFailed = all { s.checking, s' = s.with("checking", s.queued and not(s.stopped)).with("queued", false) }
  action stoppedProbeSettles = all { s.stopped, s.checking, s' = s.with("checking", false).with("queued", false) }
  action openSettings = all { not(s.stopped or s.settings), s' = s.with("settings", true) }
  action settingsDone = all { s.settings, s' = s.with("settings", false) }
  action flush = all { s.dirty, s' = s.with("durable", s.status).with("dirty", false).with("persistFailed", false) }
  action flushFailed = all { s.dirty, s' = s.with("persistFailed", true) }
  action stop = all { not(s.stopped), s' = s.with("stopped", true).with("stopRevision", s.revision).with("queued", false) }
  action drained = all { s.stopped, not(s.checking or s.queued or s.dirty or s.settings), s' = s.with("returned", true) }
  action keep = s' = s
  action step = any { check, queue, observed("granted"), observed("denied"), probeFailed, stoppedProbeSettles, openSettings, settingsDone, flush, flushFailed, stop, drained, keep }
  action legacyLateProbe = all { s.stopped, s.checking, s.revision < 2, s' = s.with("checking", false).with("status", "granted").with("dirty", true).with("revision", s.revision + 1) }
  action legacySettings = all { s.returned, s' = s.with("settings", true) }
  action legacyStep = any { step, legacyLateProbe, legacySettings }
  val safety = all { not(s.dirty) implies s.durable == s.status, s.stopped implies s.revision == s.stopRevision, s.returned implies not(s.checking or s.dirty or s.queued or s.settings), s.revision >= 0, s.revision <= 2 }
  run serializedRequestWinsTest = init.then(check).then(queue).then(observed("denied")).then(observed("granted")).then(flush).expect(s.durable == "granted")
  run shutdownDiscardsLateProbeTest = init.then(check).then(stop).then(stoppedProbeSettles).then(drained).expect(s.status == "unknown" and s.returned)
  run failedPersistenceRetainsDirtyStateTest = init.then(check).then(observed("denied")).then(flushFailed).expect(s.dirty and s.persistFailed).then(stop).then(flush).then(drained).expect(s.durable == "denied")
  run stopDrainsSettingsLaunchTest = init.then(openSettings).then(stop).then(settingsDone).then(drained).expect(s.returned and not(s.settings))

  run lateProbeWitnessTest = init.then(check).then(stop)
    .then(legacyLateProbe).expect(not(safety))
  run lateSettingsWitnessTest = init.then(stop).then(drained)
    .then(legacySettings).expect(not(safety))
}
