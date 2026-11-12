// One old locate is cancelled. One optional replacement locate or typed origin
// supersedes it before its asynchronous native cleanup receipt settles.
module MapsLocateRetirement {
  var s: { generation: int, cleanup: bool, phase: str, accepted: bool, owner: bool }
  action init = s' = { generation: 0, cleanup: false, phase: "old-loading", accepted: false, owner: true }
  action cancel = all { s.owner, s.generation == 0,
    s' = { ...s, generation: 1, cleanup: true, phase: "idle" } }
  action replaceLocate = all { s.owner, s.generation == 1,
    s' = { ...s, generation: 2, phase: "new-loading" } }
  action replaceOrigin = all { s.owner, s.generation == 1,
    s' = { ...s, generation: 2, phase: "idle" } }
  // setOrigin retires this completed one-shot watch before publishing the fix.
  action acceptFix = all { s.owner, s.phase == "new-loading",
    s' = { ...s, generation: 3, phase: "ready", accepted: true } }
  action oldFix = all { s.generation > 0, s' = s }
  action cleanupDone = all { s.cleanup, s' = { ...s, cleanup: false } }
  action cleanupFailed = all { s.cleanup,
    s' = { ...s, cleanup: false,
      phase: if (s.owner and s.generation == 1) "error" else s.phase } }
  action leave = all { s.owner, s' = { ...s, owner: false } }
  action settle = any { cleanupDone, cleanupFailed }
  action step = any { cancel, replaceLocate, replaceOrigin, acceptFix, oldFix, settle, leave, s' = s }
  val TypeOK = s.generation.in(0.to(3)) and
    s.phase.in(Set("old-loading", "idle", "new-loading", "ready", "error"))
  val AcceptedFixIsPreserved = s.accepted implies s.phase == "ready"
  val CleanupErrorBelongsToCancelledOwner = s.phase == "error" implies s.generation == 1
  temporal ReadyStaysReady = always((s.phase == "ready" implies next(s.phase) == "ready").orKeep(s))
  temporal FairCleanupSettles = settle.weakFair(s) implies s.cleanup.leadsTo(not(s.cleanup))
  temporal UnfairCleanupSettles = s.cleanup.leadsTo(not(s.cleanup))
  run cancelledFixCannotRestoreOldOriginTest = init.then(cancel).then(oldFix)
    .expect(s.phase == "idle")
  run lateCleanupCannotReplaceAcceptedFixTest = init.then(cancel).then(replaceLocate)
    .then(acceptFix).then(cleanupFailed).expect(AcceptedFixIsPreserved)
}
