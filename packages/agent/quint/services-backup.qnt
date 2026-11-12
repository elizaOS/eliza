// agent-backup-authority.ts and agent-backup.ts: generation retirement, complete
// capture framing, and explicit cancellation. Two data frames abstract arbitrary size.
module services_backup {
  var s: { generation: int, retired: bool, phase: str, frames: int, cancelled: bool, complete: bool, lock: bool }
  action init = s' = { generation: 0, retired: false, phase: "idle", frames: 0, cancelled: false, complete: false, lock: false }
  action acquire = all { not(s.lock), s' = s.with("lock", true) }
  action retire = all { s.lock, s.phase == "idle", not(s.retired), s.generation < 2, s' = s.with("retired", true).with("generation", s.generation + 1) }
  action acknowledgeCleanup = all { s.lock, s.retired, s' = s.with("retired", false) }
  action capture = all { s.lock, not(s.retired), s.phase == "idle", s' = s.with("phase", "capturing").with("frames", 0).with("cancelled", false).with("complete", false) }
  action data = all { s.phase == "capturing", not(s.cancelled), s.frames < 2, s' = s.with("frames", s.frames + 1) }
  action cancel = all { s.phase == "capturing", s' = s.with("cancelled", true).with("phase", "aborted") }
  action finish = all { s.phase == "capturing", not(s.cancelled), s.frames == 2, s' = s.with("phase", "complete").with("complete", true) }
  action release = all { s.phase != "capturing", s' = s.with("lock", false) }
  action resetCapture = all { s.phase.in(Set("complete","aborted")), s' = s.with("phase", "idle").with("frames", 0).with("cancelled", false).with("complete", false) }
  action keep = s' = s
  action step = any { acquire, retire, acknowledgeCleanup, capture, data, cancel, finish, release, resetCapture, keep }
  val safety = all { s.generation >= 0, s.generation <= 2, s.frames >= 0, s.frames <= 2, s.complete implies s.frames == 2 and not(s.cancelled), s.phase == "capturing" implies s.lock and not(s.retired), s.cancelled implies not(s.complete) }
  run cancellationHasNoCompleteFrameTest = init.then(acquire).then(capture).then(data).then(cancel).expect(not(s.complete))
  run retirementBlocksCaptureTest = init.then(acquire).then(retire).expect(s.retired).then(acknowledgeCleanup).then(capture).then(data).then(data).then(finish).expect(s.complete and s.generation == 1)
}
