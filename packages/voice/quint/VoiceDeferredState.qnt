// Small projections of the queued-frame and deferred-diagnostic state machines.
module LiveFrameBacklog {
  var s: {queued: int, finished: bool, discarded: bool, fatal: int, expected: int, nulls: int, overflowed: bool}
  action init = s' = {queued: 0, finished: false, discarded: false, fatal: 0, expected: 0, nulls: 0, overflowed: false}
  // Capacity two represents the production boundary of 960 frames; a batch can cross it.
  action accept = all {
    not(s.finished),
    nondet frames = Set(1, 2).oneOf()
    s' = if (s.queued + frames > 2)
      s.with("finished", true).with("fatal", 1).with("expected", 0)
        .with("nulls", s.expected).with("overflowed", true)
      else s.with("queued", s.queued + frames)
  }
  action closeSegment = all {
    not(s.finished), s.expected < 2, s' = s.with("expected", s.expected + 1)
  }
  // A late provider completion can release retained closures but cannot revive a disposed stream.
  action settlePost = all {s.queued > 0, s' = s.with("queued", s.queued - 1)}
  action cancel = all {
    not(s.finished), s' = s.with("finished", true).with("discarded", true).with("expected", 0)
  }
  action step = any {accept, closeSegment, settlePost, cancel, s' = s}
  val QueueBounded = s.queued >= 0 and s.queued <= 2
  val OneOverflowFailure = s.fatal >= 0 and s.fatal <= 1 and (s.overflowed implies s.fatal == 1)
  val FailureSettlesSegments = s.overflowed implies s.finished and s.expected == 0
  val CancelFencesResults = s.discarded implies s.finished and s.expected == 0 and s.fatal == 0
  temporal RetainedPostsSettle = s.finished.leadsTo(s.queued == 0)
  temporal FairRetainedPostsSettle = settlePost.weakFair(s).implies(RetainedPostsSettle)
}

module DeferredVoiceTiming {
  var s: {
    begun: bool, active: bool, ready: bool, sent: bool,
    dirty: bool, scheduled: bool, stored: bool, cleared: bool,
    writes: int, previousWrites: int, previousActive: bool, last: str
  }
  action init = s' = {
    begun: false, active: false, ready: false, sent: false,
    dirty: false, scheduled: false, stored: false, cleared: false,
    writes: 0, previousWrites: 0, previousActive: false, last: "init"
  }
  action begin = all {
    not(s.begun), s' = s.with("begun", true).with("active", true)
      .with("dirty", true).with("scheduled", true).with("last", "begin")
  }
  action ready = all {
    s.active, not(s.ready), s' = s.with("ready", true).with("dirty", true)
      .with("scheduled", true).with("previousWrites", s.writes).with("last", "mark")
  }
  action send = all {
    s.active, s.ready, not(s.sent), s' = s.with("sent", true).with("dirty", true)
      .with("scheduled", true).with("previousWrites", s.writes).with("last", "mark")
  }
  // At most begin, ready and send can produce a new changed record in this instance.
  action flush = all {
    s.dirty, s' = s.with("dirty", false).with("scheduled", false)
      .with("stored", true).with("writes", s.writes + 1).with("last", "flush")
  }
  action storageFailure = all {
    s.dirty, s' = s.with("dirty", false).with("scheduled", false)
      .with("previousActive", s.active).with("last", "storage-failure")
  }
  action finish = all {s.active, s' = s.with("active", false).with("last", "finish")}
  action clear = all {
    s.begun, s' = s.with("active", false).with("dirty", false).with("stored", false)
      .with("cleared", true).with("last", "clear")
  }
  action staleTimer = all {
    s.scheduled, not(s.dirty), s' = s.with("scheduled", false).with("last", "timer")
  }
  action step = any {begin, ready, send, flush, storageFailure, finish, clear, staleTimer, s' = s}
  val MarksDoNoStorageWrite = s.last == "mark" implies s.writes == s.previousWrites
  val SendRequiresReady = s.sent implies s.ready
  val StorageDoesNotRetireTurn = s.last == "storage-failure" implies s.active == s.previousActive
  val ClearCannotResurrect = s.cleared implies not(s.stored) and not(s.dirty) and not(s.active)
  temporal PendingWriteSettles = s.dirty.leadsTo(not(s.dirty))
  temporal FairPendingWriteSettles = flush.weakFair(s).implies(PendingWriteSettles)
}
