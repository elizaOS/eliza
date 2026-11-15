// Two opaque conversation identities (actual colliding 64-bit IDs are checked by the hook), a held receiver and separate SMS/MMS provider acknowledgements.
module NativeMessageNotice {
  pure val Threads = Set(1, 2)
  var s: { notices: Set[int], targets: int -> int, role: bool, phase: str,
    selected: int, tickets: int -> int, visible: int -> int, posting: bool, failedPost: bool, texts: int, captured: int, writeTicket: int,
    smsRead: Set[int], mmsRead: Set[int], sends: int, finished: bool }
  action init = s' = { notices: Threads, targets: Map(1 -> 1, 2 -> 2),
    role: true, phase: "idle", selected: 1, tickets: Map(1 -> 1, 2 -> 1), visible: Map(1 -> 1, 2 -> 1), posting: false, failedPost: false, texts: 1, captured: 0, writeTicket: 0,
    smsRead: Set(), mmsRead: Set(), sends: 0, finished: false }
  action choose(thread: int): bool = all { s.phase == "idle", Threads.contains(thread),
    s' = { ...s, selected: s.targets.get(thread), captured: s.tickets.get(thread), phase: "queued" } }
  action incomingBeforeOldRead = all { s.phase == "queued", s.tickets.get(s.selected) == 1,
    s' = { ...s, tickets: s.tickets.set(s.selected, 2), posting: true } }
  action publicationAck = all { s.posting, s' = { ...s, visible: s.visible.set(s.selected, 2), texts: 2, posting: false } }
  action publicationFailure = all { s.posting, s' = { ...s, tickets: s.tickets.set(s.selected, 0), failedPost: true, posting: false } }
  action latePublication = all { s.failedPost, s' = { ...s, visible: s.visible.set(s.selected, 2), texts: 2 } }
  action completePublication = any { publicationAck, publicationFailure }
  action withdrawRole = s' = { ...s, role: false }
  action beginWorker = all { s.phase == "queued", not(s.posting), s' = if (s.captured != s.tickets.get(s.selected) or s.captured != s.visible.get(s.selected))
    { ...s, phase: "done", finished: true }
    else if (s.role)
    { ...s, phase: "mms", smsRead: Set(s.selected), writeTicket: s.tickets.get(s.selected) }
    else { ...s, phase: "done", notices: s.notices.exclude(Set(s.selected)), finished: true } }
  action mmsAck = all { s.phase == "mms", s' = { ...s, mmsRead: Set(s.selected), phase: "done",
    notices: s.notices.exclude(Set(s.selected)), finished: true } }
  action mmsFailure = all { s.phase == "mms", s' = { ...s, phase: "done", finished: true } }
  action rejectWorker = all { s.phase == "queued", s' = { ...s, phase: "done", finished: true } }
  action completeProvider = any { mmsAck, mmsFailure }
  action retry = all { s.phase == "done", s.notices.contains(s.selected),
    s.smsRead.contains(s.selected), s.mmsRead.size() == 0, s.captured == s.tickets.get(s.selected),
    s' = { ...s, phase: "queued", finished: false } }
  // Reply opens compose only; it cannot call the reviewed send owner.
  action reply = s' = s
  action step = any { { nondet thread = Threads.oneOf() choose(thread) }, withdrawRole,
    incomingBeforeOldRead, publicationAck, publicationFailure, latePublication, beginWorker, mmsAck, mmsFailure, rejectWorker, retry, reply, s' = s }
  val FullConversationIdentity = Threads.forall(thread => s.targets.get(thread) == thread)
  val WritesHaveSelectedOwner = s.smsRead.subseteq(Set(s.selected)) and s.mmsRead.subseteq(Set(s.selected))
  val NoSendAuthority = s.sends == 0
  val FinishedReleasesReceiver = s.finished implies s.phase == "done"
  val StaleReceiptNeverWrites = (s.phase == "done" and s.captured != s.tickets.get(s.selected)) implies
    ((s.writeTicket == 0 or s.writeTicket != s.tickets.get(s.selected)) and s.notices.contains(s.selected))
  val ConfirmedReplacementRetainsHistory = (s.tickets.get(s.selected) == 2 and s.visible.get(s.selected) == 2) implies s.texts == 2
  temporal ReceiverFinishes = (s.phase == "queued" or s.phase == "mms").leadsTo(s.finished)
  temporal FairReceiverFinishes = (completePublication.weakFair(s) and beginWorker.weakFair(s) and completeProvider.weakFair(s)) implies ReceiverFinishes
  run collidingHashThreadsKeepTheirOwnTargetsTest = init.then(choose(2)).expect(s.selected == 2)
  run lostRoleDoesNotWriteTest = init.then(choose(1)).then(withdrawRole).then(beginWorker)
    .expect(s.smsRead.size() == 0 and s.mmsRead.size() == 0 and s.finished)
  run readAcknowledgementsDismissOnlySelectedNoticeTest = init.then(choose(1)).then(beginWorker).then(mmsAck)
    .expect(s.notices == Set(2) and s.finished)
  run partialProviderFailureKeepsNoticeTest = init.then(choose(1)).then(beginWorker).then(mmsFailure)
    .expect(s.notices.contains(1) and s.smsRead == Set(1) and s.mmsRead.size() == 0 and s.finished)
  run rejectedWorkerReleasesReceiverTest = init.then(choose(1)).then(rejectWorker)
    .expect(s.notices.contains(1) and s.finished and s.smsRead.size() == 0)
  run newerNoticeInvalidatesTheQueuedReadTest = init.then(choose(1)).then(incomingBeforeOldRead).then(publicationAck).then(beginWorker)
    .expect(s.notices.contains(1) and s.smsRead.size() == 0 and s.finished)
  run partialFailureKeepsItsCurrentRetryTest = init.then(choose(1)).then(beginWorker).then(mmsFailure)
    .then(retry).then(beginWorker).then(mmsAck).expect(not(s.notices.contains(1)) and s.finished)
  run delayedPublicationFencesTheOldReadTest = init.then(choose(1)).then(incomingBeforeOldRead)
    .expect(s.posting and s.visible.get(1) == 1 and s.tickets.get(1) == 2)
    .then(publicationAck).expect(s.texts == 2).then(beginWorker)
    .expect(s.smsRead.size() == 0 and s.finished)
  run failedPublicationCannotRestoreTheOldActionTest = init.then(choose(1)).then(incomingBeforeOldRead)
    .then(publicationFailure).then(beginWorker).expect(s.smsRead.size() == 0 and s.finished)
  run latePublicationDoesNotRestoreReadAuthorityTest = init.then(choose(1)).then(incomingBeforeOldRead)
    .then(publicationFailure).then(latePublication).then(beginWorker)
    .expect(s.visible.get(1) == 2 and s.tickets.get(1) == 0 and s.smsRead.size() == 0 and s.finished)
}
