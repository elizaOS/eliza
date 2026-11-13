// push/notification-push-service.ts and push-token-registry.ts. Two concurrent
// lazy-bus attachments retain their startup epoch; stop invalidates both, and
// completion rechecks ownership. One token's durable write success/failure is
// separate from publication. APNs/FCM transport is tested outside this model.
module services_push {
  var s: { subscribed: bool, listeners: int, epoch: int, pending1: int, pending2: int, stopped: bool, committed: bool, candidate: bool, writing: bool, attempts: int }
  action init = s' = { subscribed: false, listeners: 0, epoch: 0, pending1: -1, pending2: -1, stopped: false, committed: false, candidate: false, writing: false, attempts: 0 }
  action attach = s' = s.with("subscribed", true).with("listeners", 1).with("stopped", false)
  action begin1 = all { not(s.subscribed), s.pending1 == -1, s' = s.with("pending1", s.epoch).with("stopped", false) }
  action begin2 = all { not(s.subscribed), s.pending2 == -1, s' = s.with("pending2", s.epoch).with("stopped", false) }
  action complete1 = all { s.pending1 != -1, s' = s.with("pending1", -1).with("subscribed", s.subscribed or (s.pending1 == s.epoch and not(s.stopped))).with("listeners", if (s.pending1 == s.epoch and not(s.stopped)) 1 else s.listeners) }
  action complete2 = all { s.pending2 != -1, s' = s.with("pending2", -1).with("subscribed", s.subscribed or (s.pending2 == s.epoch and not(s.stopped))).with("listeners", if (s.pending2 == s.epoch and not(s.stopped)) 1 else s.listeners) }
  action stop = all { s.epoch < 2, s' = s.with("subscribed", false).with("listeners", 0).with("epoch", s.epoch + 1).with("stopped", true) }
  action stage(present: bool): bool = all { not(s.writing), s' = s.with("candidate", present).with("writing", true) }
  action persistSuccess = all { s.writing, s' = s.with("committed", s.candidate).with("writing", false) }
  action persistFailure = all { s.writing, s' = s.with("candidate", s.committed).with("writing", false) }
  action deliver = all { s.subscribed, s.committed, s.attempts < 2, s' = s.with("attempts", s.attempts + 1) }
  action resetAttempts = s' = s.with("attempts", 0)
  action keep = s' = s
  action step = any { attach, begin1, begin2, complete1, complete2, stop, stage(true), stage(false), persistSuccess, persistFailure, deliver, resetAttempts, keep }
  // Old attach checked ownership only before await, then subscribed unconditionally.
  action legacyComplete1 = all { s.pending1 != -1, s.listeners < 2, s' = s.with("pending1", -1).with("subscribed", true).with("listeners", s.listeners + 1) }
  action legacyComplete2 = all { s.pending2 != -1, s.listeners < 2, s' = s.with("pending2", -1).with("subscribed", true).with("listeners", s.listeners + 1) }
  action legacyStep = any { step, legacyComplete1, legacyComplete2 }
  val safety = all { s.listeners.in(Set(0,1)), s.subscribed == (s.listeners == 1), s.stopped implies s.listeners == 0, s.attempts >= 0, s.attempts <= 2, not(s.writing) implies s.candidate == s.committed }
  run repeatedAttachAndStopTest = init.then(attach).then(attach).expect(s.listeners == 1).then(stop).expect(s.listeners == 0)
  run concurrentLazyAttachTest = init.then(begin1).then(begin2).then(complete2).then(complete1).expect(s.listeners == 1)
  run stoppedLazyAttachNeverPublishesTest = init.then(begin1).then(begin2).then(stop).then(complete1).then(complete2).expect(s.listeners == 0 and s.stopped)
  run rejectedWriteStaysInvisibleTest = init.then(stage(true)).expect(not(s.committed)).then(persistFailure).expect(not(s.committed)).then(stage(true)).then(persistSuccess).expect(s.committed)

  run duplicateListenerWitnessTest = init.then(begin1).then(begin2)
    .then(legacyComplete1).then(legacyComplete2).expect(not(safety))
  run stoppedAttachWitnessTest = init.then(begin1).then(stop)
    .then(legacyComplete1).expect(not(safety))
}
