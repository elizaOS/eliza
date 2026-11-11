// Two conversation identities, a held receiver and separate SMS/MMS provider acknowledgements.
module NativeMessageNotice {
  pure val Threads = Set(1, 4294967296)
  var s: { notices: Set[int], targets: int -> int, role: bool, phase: str,
    selected: int, smsRead: Set[int], mmsRead: Set[int], sends: int, finished: bool }
  action init = s' = { notices: Threads, targets: Map(1 -> 1, 4294967296 -> 4294967296),
    role: true, phase: "idle", selected: 1, smsRead: Set(), mmsRead: Set(), sends: 0, finished: false }
  action choose(thread: int): bool = all { s.phase == "idle", Threads.contains(thread),
    s' = { ...s, selected: s.targets.get(thread), phase: "queued" } }
  action withdrawRole = s' = { ...s, role: false }
  action beginWorker = all { s.phase == "queued", s' = if (s.role)
    { ...s, phase: "mms", smsRead: Set(s.selected) }
    else { ...s, phase: "done", notices: s.notices.exclude(Set(s.selected)), finished: true } }
  action mmsAck = all { s.phase == "mms", s' = { ...s, mmsRead: Set(s.selected), phase: "done",
    notices: s.notices.exclude(Set(s.selected)), finished: true } }
  action mmsFailure = all { s.phase == "mms", s' = { ...s, phase: "done", finished: true } }
  action rejectWorker = all { s.phase == "queued", s' = { ...s, phase: "done", finished: true } }
  action completeProvider = any { mmsAck, mmsFailure }
  // Reply opens compose only; it cannot call the reviewed send owner.
  action reply = s' = s
  action step = any { { nondet thread = Threads.oneOf() choose(thread) }, withdrawRole,
    beginWorker, mmsAck, mmsFailure, rejectWorker, reply, s' = s }
  val FullConversationIdentity = Threads.forall(thread => s.targets.get(thread) == thread)
  val WritesHaveSelectedOwner = s.smsRead.subseteq(Set(s.selected)) and s.mmsRead.subseteq(Set(s.selected))
  val NoSendAuthority = s.sends == 0
  val FinishedReleasesReceiver = s.finished implies s.phase == "done"
  temporal ReceiverFinishes = (s.phase == "queued" or s.phase == "mms").leadsTo(s.finished)
  temporal FairReceiverFinishes = (beginWorker.weakFair(s) and completeProvider.weakFair(s)) implies ReceiverFinishes
  run collidingHashThreadsKeepTheirOwnTargetsTest = init.then(choose(4294967296)).expect(s.selected == 4294967296)
  run lostRoleDoesNotWriteTest = init.then(choose(1)).then(withdrawRole).then(beginWorker)
    .expect(s.smsRead.size() == 0 and s.mmsRead.size() == 0 and s.finished)
  run readAcknowledgementsDismissOnlySelectedNoticeTest = init.then(choose(1)).then(beginWorker).then(mmsAck)
    .expect(s.notices == Set(4294967296) and s.finished)
  run partialProviderFailureKeepsNoticeTest = init.then(choose(1)).then(beginWorker).then(mmsFailure)
    .expect(s.notices.contains(1) and s.smsRead == Set(1) and s.mmsRead.size() == 0 and s.finished)
  run rejectedWorkerReleasesReceiverTest = init.then(choose(1)).then(rejectWorker)
    .expect(s.notices.contains(1) and s.finished and s.smsRead.size() == 0)
}
