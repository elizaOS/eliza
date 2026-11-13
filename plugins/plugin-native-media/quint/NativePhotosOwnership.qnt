// PermittedPhotosPlugin captures one read ticket before worker admission.
// PermittedMediaCatalog checks it before I/O and again on main-thread delivery.
// Access strings and lifecycle events are environment inputs in this projection.
module NativePhotosPublication {
  type Phase = Fresh | Queued | Reading | Posted | Resolved | Rejected
  type Read = { phase: Phase, ticket: int, publishedEpoch: int, notified: bool }
  type State = {
    epoch: int, access: int, lastAccess: int, foreground: bool, unlocked: bool, closed: bool,
    reads: int -> Read, worker: List[int], active: int, main: List[int],
  }
  pure val Requests = Set(0, 1)
  pure val emptyRead = { phase: Fresh, ticket: -1, publishedEpoch: -1, notified: false }
  var s: State
  val usable = s.foreground and s.unlocked and not(s.closed)
  val checkedEpoch = if (s.access == s.lastAccess) s.epoch else s.epoch + 1
  pure def checked(t: State, id: int, read: Read): State =
    t.with("reads", t.reads.set(id, read))

  action init = s' = {
    epoch: 0, access: 0, lastAccess: -1, foreground: true, unlocked: true, closed: false,
    reads: Requests.mapBy(_ => emptyRead), worker: [], active: -1, main: [],
  }
  action admit(id) = all {
    s.reads.get(id).phase == Fresh,
    not(usable) or checkedEpoch <= 3,
    s' = if (not(usable)) checked(s, id, emptyRead.with("phase", Rejected))
      else checked(s, id, emptyRead.with("phase", Queued).with("ticket", checkedEpoch))
        .with("epoch", checkedEpoch).with("lastAccess", s.access)
        .with("worker", s.worker.append(id)),
  }
  action begin = all {
    s.worker.length() > 0, s.active == -1,
    not(usable) or checkedEpoch <= 3,
    val id = s.worker.head()
    val current = usable and s.reads.get(id).ticket == checkedEpoch
    s' = checked(s, id, s.reads.get(id).with("phase", if (current) Reading else Rejected))
      .with("worker", s.worker.tail()).with("active", if (current) id else -1)
      .with("epoch", if (usable) checkedEpoch else s.epoch)
      .with("lastAccess", if (usable) s.access else s.lastAccess),
  }
  action finish(ok) = all {
    s.active >= 0,
    val id = s.active
    s' = checked(s, id, s.reads.get(id).with("phase", if (ok) Posted else Rejected))
      .with("active", -1).with("main", if (ok) s.main.append(id) else s.main),
  }
  action publish = all {
    s.main.length() > 0,
    not(usable) or checkedEpoch <= 3,
    val id = s.main.head()
    val current = usable and s.reads.get(id).ticket == checkedEpoch
    val read = s.reads.get(id).with("phase", if (current) Resolved else Rejected)
      .with("publishedEpoch", if (current) checkedEpoch else -1).with("notified", current)
    s' = checked(s, id, read).with("main", s.main.tail())
      .with("epoch", if (usable) checkedEpoch else s.epoch)
      .with("lastAccess", if (usable) s.access else s.lastAccess),
  }
  action invalidate = all {
    s.epoch < 3, checkedEpoch < 3,
    s' = s.with("epoch", s.epoch + 1),
  }
  action scopeChanges = all {
    not(s.closed), s.epoch < 3,
    s' = s.with("access", 1 - s.access),
  }
  action pause = all {
    s.foreground, s.epoch < 3, checkedEpoch < 3,
    s' = s.with("foreground", false).with("epoch", s.epoch + 1),
  }
  action resume = all {
    not(s.foreground), not(s.closed), s.epoch < 3, checkedEpoch < 3,
    s' = s.with("foreground", true).with("epoch", s.epoch + 1),
  }
  action lock = all {
    s.unlocked, s.epoch < 3, checkedEpoch < 3,
    s' = s.with("unlocked", false).with("epoch", s.epoch + 1),
  }
  action unlock = all { not(s.unlocked), s' = s.with("unlocked", true) }
  action close = all {
    not(s.closed), s.epoch < 3, checkedEpoch < 3,
    s' = s.with("closed", true).with("epoch", s.epoch + 1),
  }
  action workerFinishes = any { finish(true), finish(false) }
  action step = any {
    s' = s, begin, workerFinishes, publish,
    invalidate, scopeChanges, pause, resume, lock, unlock, close,
    nondet id = Requests.oneOf()
    admit(id),
  }
  val TicketRetainedAtPublication = Requests.forall(id => {
    val read = s.reads.get(id)
    read.phase == Resolved implies read.publishedEpoch == read.ticket
  })
  val CallbackRequiresPublication = Requests.forall(id =>
    s.reads.get(id).notified implies s.reads.get(id).phase == Resolved)
  val QueueOwnership = all {
    s.active >= 0 implies s.reads.get(s.active).phase == Reading,
    s.worker.indices().forall(index => s.reads.get(s.worker.nth(index)).phase == Queued),
    s.main.indices().forall(index => s.reads.get(s.main.nth(index)).phase == Posted),
  }
  temporal EveryReadSettles = Requests.forall(id =>
    s.reads.get(id).phase.in(Set(Queued, Reading, Posted)).leadsTo(
      s.reads.get(id).phase.in(Set(Resolved, Rejected))))
  temporal UnderFairWorkerAndMain =
    (begin.weakFair(s) and workerFinishes.weakFair(s) and publish.weakFair(s)).implies(EveryReadSettles)

  run freshAdmissionNeverRenewsOlderTicketTest = init.then(admit(0)).then(begin).then(finish(true))
    .then(scopeChanges).then(admit(1)).then(begin).then(finish(true)).then(publish)
    .expect(s.reads.get(0).phase == Rejected).then(publish)
    .expect(s.reads.get(1).phase == Resolved and CallbackRequiresPublication)
  run pauseResumeCannotReviveReadTest = init.then(admit(0)).then(begin).then(finish(true))
    .then(pause).then(resume).then(publish).expect(s.reads.get(0).phase == Rejected)
  run invalidatedQueueNeverReadsTest = init.then(admit(0)).then(invalidate).then(begin)
    .expect(s.reads.get(0).phase == Rejected and s.active == -1)
  run changedDuringReadCannotPublishTest = init.then(admit(0)).then(begin).then(invalidate)
    .then(finish(true)).then(publish).expect(s.reads.get(0).phase == Rejected)
}

// PermittedMediaReview retains copied ids/revisions in each Request object.
// A native result can release the pending slot before RESUMED. The captured
// request then enters the shared worker independently of a later pending review.
module NativePhotosReviewSelection {
  type Phase = Fresh | NativeReview | WaitingResume | Queued | Applying | Settled | Cancelled
  type Applied = { request: int, slot: int, item: int, revision: int }
  var s: {
    phases: int -> Phase, ids: int -> List[int], revisions: int -> List[int],
    callerIds: List[int], callerRevisions: List[int], versions: int -> int,
    pending: int, resumed: bool, closed: bool, destroyed: bool, expired: Set[int],
    queue: List[int], active: int, cursor: int, applied: Set[Applied],
  }
  pure val Requests = Set(0, 1)
  pure val Items = Set(0, 1, 2)

  action init = s' = {
    phases: Requests.mapBy(_ => Fresh), ids: Requests.mapBy(_ => []), revisions: Requests.mapBy(_ => []),
    callerIds: [0, 1], callerRevisions: [0, 0], versions: Map(0 -> 0, 1 -> 0, 2 -> 1),
    pending: -1, resumed: true, closed: false, destroyed: false, expired: Set(),
    queue: [], active: -1, cursor: 0, applied: Set(),
  }
  action admit(id) = all {
    s.phases.get(id) == Fresh, s.pending == -1, not(s.closed),
    s' = s.with("pending", id).with("phases", s.phases.set(id, NativeReview))
      .with("ids", s.ids.set(id, s.callerIds)).with("revisions", s.revisions.set(id, s.callerRevisions)),
  }
  action callerChanges = all {
    s.callerIds == [0, 1],
    s' = s.with("callerIds", [2]).with("callerRevisions", [1]),
  }
  action result(ok) = all {
    s.pending >= 0,
    val id = s.pending
    val accepted = ok and not(s.closed) and not(s.expired.contains(id))
    val phase = if (not(accepted)) Cancelled else if (s.resumed) Queued else WaitingResume
    s' = s.with("pending", -1).with("phases", s.phases.set(id, phase))
      .with("queue", if (phase == Queued) s.queue.append(id) else s.queue),
  }
  action pause = all { s.resumed, s' = s.with("resumed", false) }
  def readyOnResume(id: int): bool =
    s.phases.get(id) == WaitingResume and not(s.closed) and not(s.expired.contains(id))
  // ON_RESUME invokes its registered observers synchronously. Pause cannot
  // interleave before a captured observer has queued or rejected its request.
  action resumeInOrder(order) = all {
    not(s.resumed), not(s.destroyed),
    val queued = order.indices().fold(s.queue, (queue, index) =>
      if (readyOnResume(order.nth(index))) queue.append(order.nth(index)) else queue)
    s' = s.with("resumed", true).with("queue", queued)
      .with("phases", Requests.mapBy(id =>
        if (s.phases.get(id) == WaitingResume)
          if (readyOnResume(id)) Queued else Cancelled
        else s.phases.get(id))),
  }
  action resume = {
    nondet order = Set([0, 1], [1, 0]).oneOf()
    resumeInOrder(order)
  }
  action expire(id) = all {
    not(s.expired.contains(id)),
    s' = s.with("expired", s.expired.union(Set(id))),
  }
  action close = all {
    not(s.closed),
    s' = s.with("closed", true).with("pending", -1).with("phases",
      if (s.pending >= 0) s.phases.set(s.pending, Cancelled) else s.phases),
  }
  action destroy = all {
    not(s.destroyed),
    s' = s.with("destroyed", true).with("closed", true).with("pending", -1)
      .with("phases", Requests.mapBy(id =>
        if (s.phases.get(id).in(Set(NativeReview, WaitingResume))) Cancelled else s.phases.get(id))),
  }
  action changeItem(selectedItem) = all {
    s.versions.get(selectedItem) == 0,
    s' = s.with("versions", s.versions.set(selectedItem, 1)),
  }
  action begin = all {
    s.active == -1, s.queue.length() > 0,
    val id = s.queue.head()
    s' = s.with("active", id).with("cursor", 0).with("queue", s.queue.tail())
      .with("phases", s.phases.set(id, Applying)),
  }
  action applyNext(ok) = all {
    s.active >= 0,
    val id = s.active
    all {
      s.cursor < s.ids.get(id).length(),
      val selectedItem = s.ids.get(id).nth(s.cursor)
      val revision = s.revisions.get(id).nth(s.cursor)
      val accepted = ok and not(s.closed) and not(s.expired.contains(id)) and s.versions.get(selectedItem) == revision
      s' = s.with("cursor", s.cursor + 1).with("applied",
        if (accepted) s.applied.union(Set({ request: id, slot: s.cursor, item: selectedItem, revision: revision }))
        else s.applied),
    },
  }
  action finish = all {
    s.active >= 0, s.cursor == s.ids.get(s.active).length(),
    s' = s.with("phases", s.phases.set(s.active, Settled)).with("active", -1),
  }
  action nativeAnswers = any { result(true), result(false) }
  action workerContinues = any { begin, applyNext(true), applyNext(false), finish }
  action lifecycleContinues = all {
    Requests.exists(id => s.phases.get(id) == WaitingResume),
    any { resume, all { s.closed, destroy } },
  }
  action step = any {
    s' = s, callerChanges, nativeAnswers, pause, resume, destroy, workerContinues, close,
    nondet id = Requests.oneOf()
    any { admit(id), expire(id) },
    nondet selectedItem = Items.oneOf()
    changeItem(selectedItem),
  }
  val CapturedSelectionOwnsEveryOutcome = s.applied.forall(effect =>
    effect.item == s.ids.get(effect.request).nth(effect.slot) and
    effect.revision == s.revisions.get(effect.request).nth(effect.slot))
  val OnePendingReview = s.pending >= 0 implies s.phases.get(s.pending) == NativeReview
  val WorkerKeepsCapturedRequest = all {
    s.active >= 0 implies s.phases.get(s.active) == Applying,
    s.queue.indices().forall(index => s.phases.get(s.queue.nth(index)) == Queued),
  }
  val ResumedCallbacksAreDelivered = s.resumed implies
    Requests.forall(id => s.phases.get(id) != WaitingResume)
  temporal EachAcceptedReviewSettles = Requests.forall(id =>
    s.phases.get(id).in(Set(NativeReview, WaitingResume, Queued, Applying))
      .leadsTo(s.phases.get(id).in(Set(Settled, Cancelled))))
  temporal UnderFairNativeLifecycleAndWorker = (
    nativeAnswers.weakFair(s) and lifecycleContinues.weakFair(s)
    and workerContinues.weakFair(s)
  ).implies(EachAcceptedReviewSettles)

  run nextPendingSelectionCannotReplaceDeferredReviewTest = init.then(admit(0)).then(pause)
    .then(result(true)).then(callerChanges).then(admit(1)).then(changeItem(0))
    .then(resumeInOrder([0, 1])).then(begin).then(applyNext(true)).then(applyNext(true)).then(finish)
    .expect(s.applied == Set({ request: 0, slot: 1, item: 1, revision: 0 }) and s.pending == 1)
    .then(result(true)).then(begin).then(applyNext(true)).then(finish)
    .expect(s.applied.contains({ request: 1, slot: 0, item: 2, revision: 1 }) and CapturedSelectionOwnsEveryOutcome)
  run twoResumeCallbacksKeepSeparateRequestsTest = init.then(admit(0)).then(pause).then(result(true))
    .then(callerChanges).then(admit(1)).then(result(true)).then(resumeInOrder([1, 0]))
    .then(begin).then(applyNext(true)).then(finish).then(begin)
    .then(applyNext(true)).then(applyNext(true)).then(finish)
    .expect(s.applied.size() == 3 and CapturedSelectionOwnsEveryOutcome and ResumedCallbacksAreDelivered)
  run closingBeforeResumeNeverDispatchesTest = init.then(admit(0)).then(pause).then(result(true))
    .then(close).then(resumeInOrder([0, 1])).expect(s.phases.get(0) == Cancelled and s.applied == Set())
  run closingQueuedBatchPreservesUnverifiedOutcomeTest = init.then(admit(0)).then(result(true)).then(close)
    .then(begin).then(applyNext(true)).then(applyNext(true)).then(finish)
    .expect(s.phases.get(0) == Settled and s.applied == Set())
}
