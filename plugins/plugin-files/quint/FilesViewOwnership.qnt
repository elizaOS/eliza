// One shown-row request, two replacement snapshots and two view retirements.
// Grant delivery is a port receipt; renderer layout and filesystem identity are external.
module FilesShownSelection {
  type State = { phase: int, generation: int, epoch: int, active: bool,
    cancelled: bool, snapshot: int, owner: int, granted: bool,
    retained: bool, released: bool, result: int, admitted: bool }
  var s: State
  action init = s' = { phase: 0, generation: 0, epoch: 0, active: true,
    cancelled: false, snapshot: 0, owner: 0, granted: false,
    retained: false, released: false, result: 0, admitted: false }
  val current = s.active and not(s.cancelled) and s.generation == s.snapshot and s.epoch == s.owner
  action begin = all { s.phase == 0,
    s' = s.with("phase", 1).with("snapshot", s.generation).with("owner", s.epoch) }
  action replace = all { s.generation < 2, s' = s.with("generation", s.generation + 1) }
  action leave = all { s.active, s.epoch < 2,
    s' = s.with("active", false).with("epoch", s.epoch + 1) }
  action enter = all { not(s.active), s' = s.with("active", true) }
  action cancel = all { Set(1, 2).contains(s.phase), not(s.cancelled), s' = s.with("cancelled", true) }
  action accessReply(allowed: bool): bool = all { s.phase == 1,
    s' = s.with("phase", if (allowed and current) 2 else 3)
      .with("result", if (allowed and current) 0 else 2) }
  action grantReply(granted: bool): bool = all { s.phase == 2,
    s' = s.with("phase", 3).with("granted", granted)
      .with("retained", granted and current).with("released", granted and not(current))
      .with("result", if (granted and current) 1 else 2).with("admitted", current) }
  action advance = { nondet ok = Bool.oneOf(); any { accessReply(ok), grantReply(ok) } }
  action step = any { begin, replace, leave, enter, cancel, advance, s' = s }
  val TruthfulSnapshotReceipt = s.result != 1 or (s.admitted and s.retained and s.granted)
  val OneGrantDisposition = not(s.retained and s.released) and
    (s.granted implies (s.retained or s.released))
  val NoCancelledSuccess = not(s.cancelled) or s.result != 1
  temporal FairRequestSettles = (begin.weakFair(s) and advance.weakFair(s)) implies
    (s.phase < 3).leadsTo(s.phase == 3)
  temporal RequestSettles = (s.phase < 3).leadsTo(s.phase == 3)
  run replacedBeforeAccessCannotSelect = init.then(begin).then(replace).then(accessReply(true))
    .expect(s.result == 2 and not(s.granted))
  run replacedDuringSelectReleasesLateGrant = init.then(begin).then(accessReply(true))
    .then(replace).then(grantReply(true)).expect(s.released and s.result == 2)
  run leaveAndReturnCannotReviveOldGrant = init.then(begin).then(accessReply(true))
    .then(leave).then(enter).then(grantReply(true)).expect(s.released and s.result == 2)
  run cancellationReleasesLateGrant = init.then(begin).then(accessReply(true))
    .then(cancel).then(grantReply(true)).expect(s.released and s.result == 2)
  run exactDisplayedSnapshotCanOpen = init.then(begin).then(accessReply(true))
    .then(grantReply(true)).expect(s.result == 1 and OneGrantDisposition)
}

// Three chunks, one pending call, one retirement, and an unknown acknowledgement.
// Unknown effects may have committed; they are never automatically retried or undone.
module FilesBatchOwnership {
  type State = { phase: int, next: int, pending: int, retired: bool,
    calls: Set[int], confirmed: Set[int], undo: Set[int], unknown: Set[int],
    lateAdmission: bool, duplicate: bool }
  var s: State
  action init = s' = { phase: 0, next: 0, pending: 0, retired: false,
    calls: Set(), confirmed: Set(), undo: Set(), unknown: Set(),
    lateAdmission: false, duplicate: false }
  action dispatch = all { s.phase == 0, not(s.retired), s.next < 3,
    s' = s.with("phase", 1).with("pending", s.next)
      .with("calls", s.calls.union(Set(s.next)))
      .with("lateAdmission", s.lateAdmission or s.retired)
      .with("duplicate", s.duplicate or s.calls.contains(s.next)) }
  action confirm = all { s.phase == 1,
    s' = s.with("phase", if (s.retired or s.next == 2) 2 else 0)
      .with("next", s.next + 1)
      .with("confirmed", s.confirmed.union(Set(s.pending)))
      .with("undo", s.undo.union(Set(s.pending))) }
  action unknown = all { s.phase == 1,
    s' = s.with("phase", 2).with("unknown", s.unknown.union(Set(s.pending))) }
  action refuse = all { s.phase == 1, s' = s.with("phase", 2) }
  action retire = all { not(s.retired),
    s' = s.with("retired", true).with("phase", if (s.phase == 0) 2 else s.phase) }
  action settle = any { confirm, unknown, refuse }
  action step = any { dispatch, settle, retire, s' = s }
  val NoLaterOrRepeatedAdmission = not(s.lateAdmission) and not(s.duplicate)
  val ConfirmedUndoRetained = s.confirmed == s.undo and s.confirmed.subseteq(s.calls)
  val UnknownNeverInventsConfirmation = s.unknown.intersect(s.confirmed).size() == 0
  val FiniteChunks = s.calls.subseteq(Set(0, 1, 2)) and s.next >= 0 and s.next <= 3
  temporal FairBatchSettles = (dispatch.weakFair(s) and settle.weakFair(s)) implies
    (s.phase != 2).leadsTo(s.phase == 2)
  temporal BatchSettles = (s.phase != 2).leadsTo(s.phase == 2)
  run retirementDrainsOnlyAdmittedChunk = init.then(dispatch).then(retire).then(confirm)
    .expect(s.calls == Set(0) and s.undo == Set(0) and s.phase == 2)
  run unknownSecondChunkKeepsFirstUndo = init.then(dispatch).then(confirm)
    .then(dispatch).then(unknown).expect(s.undo == Set(0) and s.unknown == Set(1) and s.phase == 2)
  run partialRefusalKeepsConfirmedCount = init.then(dispatch).then(confirm)
    .then(dispatch).then(refuse).expect(s.confirmed == Set(0) and s.phase == 2)
  run completeBatchRetainsEveryOutcome = init.then(dispatch).then(confirm)
    .then(dispatch).then(confirm).then(dispatch).then(confirm)
    .expect(s.confirmed == Set(0, 1, 2) and ConfirmedUndoRetained)
}

// Two one-shot operation owners, one independent refresh and one query.
// Collection counts abstract0,100,101 and1200 whole selected paths, never their bytes.
module FilesViewState {
  type State = { filter: bool, cleared: bool, active: bool, longAbsence: bool,
    refresh: bool, busy: bool, started: Set[int], pending: Set[int], query: int,
    partial: bool, metadataKnown: bool, failed: bool, anyRows: bool, emptyClaim: bool, completeClaim: bool,
    requested: int, shared: int, shareDone: bool }
  var s: State
  action initKnown(known: bool): bool = {
    nondet partial = Bool.oneOf()
    nondet failed = Bool.oneOf()
    nondet rows = Bool.oneOf()
    nondet requested = Set(0, 100, 101, 1200).oneOf()
    s' = { filter: true, cleared: false, active: true, longAbsence: false,
      refresh: true, busy: false, started: Set(), pending: Set(), query: 0,
      partial: partial, metadataKnown: known, failed: failed, anyRows: rows, emptyClaim: false, completeClaim: false,
      requested: requested, shared: 0, shareDone: false }
  }
  action init = { nondet known = Bool.oneOf(); initKnown(known) }
  action leave = all { s.active, s' = s.with("active", false) }
  action age = all { not(s.longAbsence), s' = s.with("longAbsence", true) }
  action enter = all { not(s.active), s' = s.with("active", true) }
  action clear = all { not(s.cleared), s' = s.with("filter", false).with("cleared", true) }
  action begin(i: int): bool = all { not(s.started.contains(i)),
    s' = s.with("started", s.started.union(Set(i))).with("pending", s.pending.union(Set(i))).with("busy", true) }
  action finish(i: int): bool = all { s.pending.contains(i),
    s' = s.with("pending", s.pending.exclude(Set(i))).with("busy", s.pending.exclude(Set(i)).size() > 0) }
  action refreshReply = all { s.refresh, s' = s.with("refresh", false) }
  action queryReply = all { s.query == 0,
    s' = s.with("query", 1).with("completeClaim", s.metadataKnown and not(s.partial) and not(s.failed))
      .with("emptyClaim", s.metadataKnown and not(s.partial) and not(s.failed) and not(s.anyRows)) }
  action share = all { not(s.shareDone),
    s' = s.with("shareDone", true).with("shared", s.requested) }
  action step = any { leave, age, enter, clear, begin(0), begin(1), finish(0), finish(1),
    refreshReply, queryReply, share, s' = s }
  val FilterRestoration = s.filter == not(s.cleared)
  val NoInventedEmptyOrComplete = (s.emptyClaim or s.completeClaim) implies
    (s.metadataKnown and not(s.partial) and not(s.failed))
  val WholeAuthorizedSelection = not(s.shareDone) or s.shared == s.requested
  val OwnedBusyCount = s.pending.subseteq(s.started) and s.pending.size() <= 2 and
    s.busy == (s.pending.size() > 0)
  temporal FairOperationsDrain = (finish(0).weakFair(s) and finish(1).weakFair(s)) implies
    (s.pending.size() > 0).leadsTo(s.pending.size() == 0)
  temporal OperationsDrain = (s.pending.size() > 0).leadsTo(s.pending.size() == 0)
  run unknownMetadataCannotClaimEmpty = initKnown(false).then(queryReply)
    .expect(not(s.emptyClaim) and not(s.completeClaim))
  run longAbsenceKeepsFilter = init.then(leave).then(age).then(enter).expect(FilterRestoration and s.filter)
  run overlappingOwnersDrainSeparately = init.then(begin(0)).then(begin(1)).then(finish(0))
    .expect(s.pending == Set(1)).then(finish(1)).expect(s.pending.size() == 0)
  run queryAndShareKeepCompleteContext = init.then(queryReply).then(share)
    .expect(NoInventedEmptyOrComplete and WholeAuthorizedSelection)
}

// Optional external opening chooses one existing port, and a selected fallback
// still needs a real capability owned by the same view when its reply arrives.
module FilesOpenRouting {
  type State = { phase: int, previewable: bool, externalPort: bool, route: int,
    active: bool, replyActive: bool, reply: int, accepted: bool, released: bool, external: bool }
  var s: State
  action init = {
    nondet previewable = Bool.oneOf()
    nondet externalPort = Bool.oneOf()
    s' = { phase: 0, previewable: previewable, externalPort: externalPort, route: 0,
      active: true, replyActive: false, reply: 0, accepted: false, released: false, external: false }
  }
  action dispatch = all { s.phase == 0,
    s' = s.with("phase", 1).with("route", if (not(s.previewable) and s.externalPort) 1 else 0) }
  action leave = all { s.active, s' = s.with("active", false) }
  // 1=external opened receipt, 2=selected capability, 3=refusal,
  // 4=cancelled, 5=malformed selected reply without a capability.
  action reply(kind: int): bool = all { s.phase == 1, Set(1, 2, 3, 4, 5).contains(kind),
    s' = s.with("phase", 2).with("reply", kind).with("replyActive", s.active)
      .with("accepted", s.active and kind == 2)
      .with("released", not(s.active) and kind == 2)
      .with("external", kind == 1) }
  action advance = { nondet kind = Set(1, 2, 3, 4, 5).oneOf(); reply(kind) }
  action step = any { dispatch, leave, advance, s' = s }
  val ExactRouting = s.phase == 0 or s.route == (if (not(s.previewable) and s.externalPort) 1 else 0)
  val RealCurrentCapabilityOnly = s.accepted implies (s.reply == 2 and s.replyActive)
  val NoMalformedAcceptance = s.reply != 5 or not(s.accepted)
  val OneFallbackDisposition = s.reply != 2 or (s.accepted != s.released)
  temporal FairOpeningSettles = (dispatch.weakFair(s) and advance.weakFair(s)) implies
    (s.phase < 2).leadsTo(s.phase == 2)
  temporal OpeningSettles = (s.phase < 2).leadsTo(s.phase == 2)
  run malformedReplyCannotBecomePreview = init.then(dispatch).then(reply(5)).expect(not(s.accepted))
  run lateFallbackIsReleased = init.then(dispatch).then(leave).then(reply(2))
    .expect(s.released and not(s.accepted))
  run openedReceiptDoesNotCreateSelection = init.then(dispatch).then(reply(1))
    .expect(s.external and not(s.accepted) and not(s.released))
}
