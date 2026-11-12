// interactive-task-{runtime,store,http}.ts: durable dispatch, epoch fencing,
// explicit unknown outcomes, and cleanup acknowledgement. The native actuator
// must independently check authority immediately before every external effect.
module services_interactive_task {
  var s: { status: str, op: str, epoch: int, dispatchEpoch: int, revision: int, eventSequence: int, authority: bool, aborted: bool, poisoned: bool, cleanup: bool, effect: bool, evidence: bool }
  action init = s' = { status: "active", op: "idle", epoch: 0, dispatchEpoch: 0, revision: 0, eventSequence: 0, authority: true, aborted: false, poisoned: false, cleanup: false, effect: false, evidence: false }
  action prepare = all { s.status == "active", s.op == "idle", s.authority, not(s.poisoned or s.cleanup), s.revision < 8, s' = s.with("op", "prepared").with("revision", s.revision + 1).with("eventSequence", s.eventSequence + 1) }
  action dispatch = all { s.op == "prepared", s.status == "active", s.authority, not(s.poisoned), s.revision < 8, s' = s.with("op", "dispatched").with("dispatchEpoch", s.epoch).with("status", "waiting").with("revision", s.revision + 1).with("eventSequence", s.eventSequence + 1) }
  action effect = all { s.op == "dispatched", s.status == "waiting", s.authority, not(s.aborted or s.poisoned), s.dispatchEpoch == s.epoch, s' = s.with("effect", true) }
  action result = all { s.op == "dispatched", s.status == "waiting", not(s.aborted or s.poisoned), s.dispatchEpoch == s.epoch, s.revision < 8, s' = s.with("op", "resolved").with("status", "active").with("evidence", true).with("revision", s.revision + 1).with("eventSequence", s.eventSequence + 1) }
  action pause = all { s.status.in(Set("active", "waiting")), s.epoch < 2, s.revision < 8, s' = s.with("status", "paused").with("op", if (s.op == "dispatched") "unknown" else if (s.op == "prepared") "idle" else s.op).with("epoch", s.epoch + 1).with("aborted", true).with("cleanup", true).with("revision", s.revision + 1).with("eventSequence", s.eventSequence + 1) }
  action revoke = all { s.authority, s.epoch < 2, s.revision < 8, s' = s.with("authority", false).with("status", "paused").with("op", if (s.op == "dispatched") "unknown" else if (s.op == "prepared") "idle" else s.op).with("epoch", s.epoch + 1).with("aborted", true).with("cleanup", true).with("revision", s.revision + 1).with("eventSequence", s.eventSequence + 1) }
  action cleanupConfirmed = all { s.cleanup, s' = s.with("cleanup", false) }
  action cleanupFailure = all { s.cleanup, s' = s }
  action storageFailure = all { not(s.poisoned), s' = s.with("poisoned", true).with("aborted", true).with("cleanup", true) }
  action reconcile = all { s.op == "unknown", s.status == "paused", not(s.poisoned), s.revision < 8, s' = s.with("op", "resolved").with("evidence", true).with("revision", s.revision + 1).with("eventSequence", s.eventSequence + 1) }
  action resume = all { s.status == "paused", s.authority, not(s.cleanup or s.poisoned), s.op != "unknown", s.revision < 8, s' = s.with("status", "active").with("aborted", false).with("revision", s.revision + 1).with("eventSequence", s.eventSequence + 1) }
  action complete = all { s.status == "active", s.op.in(Set("idle", "resolved")), s.authority, not(s.poisoned), s.revision < 8, s' = s.with("status", "completed").with("aborted", true).with("cleanup", true).with("revision", s.revision + 1).with("eventSequence", s.eventSequence + 1) }
  action keep = s' = s
  action step = any { prepare, dispatch, effect, result, pause, revoke, cleanupConfirmed, cleanupFailure, storageFailure, reconcile, resume, complete, keep }
  val safety = all { s.epoch >= 0, s.epoch <= 2, s.revision >= 0, s.revision <= 8, s.eventSequence == s.revision, s.op == "resolved" implies s.evidence, s.status == "waiting" implies s.op == "dispatched", not(s.authority) implies s.status == "paused", s.poisoned implies s.aborted, s.status == "completed" implies s.op.in(Set("idle", "resolved")), s.op == "dispatched" implies s.dispatchEpoch == s.epoch }
  run pauseFencesLateResultTest = init.then(prepare).then(dispatch).then(effect).then(pause).expect(s.op == "unknown" and s.aborted and s.cleanup).then(cleanupConfirmed).then(reconcile).expect(s.status == "paused" and s.evidence)
  run storageFailureStopsEffectsTest = init.then(prepare).then(dispatch).then(storageFailure).expect(s.poisoned and s.aborted and not(s.effect))
  run completionWaitsForCleanupTest = init.then(prepare).then(dispatch).then(effect).then(result).then(complete).expect(s.cleanup and s.status == "completed").then(cleanupConfirmed).expect(not(s.cleanup))
}
