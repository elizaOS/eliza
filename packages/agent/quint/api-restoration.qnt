// Conversation restore: async database read followed by synchronous publication.
// Latest live metadata and deletion tombstones win over an older snapshot.
// Probe cycles similarly must not publish results from a stopped generation.
module api_restoration {
  var s: { stored: bool, pending: bool, deleted: bool, liveVersion: int, capturedVersion: int, monitoring: bool, probe: bool, probeCurrent: bool, status: str }
  action init = s' = { stored: true, pending: false, deleted: false, liveVersion: 0, capturedVersion: 0, monitoring: false, probe: false, probeCurrent: false, status: "unknown" }
  action readSnapshot = all { s.stored, not(s.deleted), s.liveVersion == 0, not(s.pending), s' = s.with("pending", true).with("capturedVersion", 1) }
  action delete = s' = s.with("deleted", true).with("stored", false).with("liveVersion", 0)
  action insertNewer = all { not(s.deleted), s' = s.with("liveVersion", 2) }
  action publish = all { s.pending, s' = s.with("pending", false).with("liveVersion", if (not(s.deleted) and s.liveVersion == 0) s.capturedVersion else s.liveVersion) }
  action legacyPublish = all { s.pending, s' = s.with("pending", false).with("liveVersion", s.capturedVersion) }
  action startMonitor = all { not(s.monitoring), s' = s.with("monitoring", true).with("probeCurrent", false) }
  action startProbe = all { s.monitoring, not(s.probe), s' = s.with("probe", true).with("probeCurrent", true) }
  action stopMonitor = s' = s.with("monitoring", false).with("probeCurrent", false).with("status", "unknown")
  action finishProbe = all { s.probe, s' = s.with("probe", false).with("status", if (s.monitoring and s.probeCurrent) "ok" else s.status) }
  action idle = s' = s
  action step = any { readSnapshot, delete, insertNewer, publish, startMonitor, startProbe, stopMonitor, finishProbe, idle }
  action legacyStep = any { step, legacyPublish }
  val safety = all { s.deleted implies s.liveVersion == 0, not(s.monitoring) implies s.status == "unknown", s.liveVersion.in(Set(0, 1, 2)) }
  run deletedRoomMustNotReturnTest = init.then(readSnapshot).then(delete).then(publish).expect(safety)
  run legacyResurrectsDeletedRoomTest = init.then(readSnapshot).then(delete).then(legacyPublish).expect(not(safety))
  run newerLiveMetadataWinsTest = init.then(readSnapshot).then(insertNewer).then(publish).expect(s.liveVersion == 2)
  run stoppedProbeCannotPublishTest = init.then(startMonitor).then(startProbe).then(stopMonitor).then(startMonitor).then(finishProbe).expect(s.status == "unknown")
}
