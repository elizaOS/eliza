// Native gateway admission: inference may reuse one owner read. A reset during
// inference drops that memo; dispatch and reply independently recheck ownership.
// One request, two owners, epoch 0..2. Account provider truth is an assumption.
module native_gateway_admission {
  var s: {
    owner: int, roomOwner: int, epoch: int, checkEpoch: int, requestEpoch: int,
    memo: int, admittedOwner: int, phase: str, sentWithAuthority: bool, returnedWithAuthority: bool
  }
  action init = s' = { owner: 0, roomOwner: 0, epoch: 0, checkEpoch: -1,
    requestEpoch: -1, memo: -1, admittedOwner: -1, phase: "idle",
    sentWithAuthority: true, returnedWithAuthority: true }
  action begin = all { s.phase == "idle", s' = { ...s, phase: "inference", checkEpoch: s.epoch } }
  action inferenceReadsOwner = all { s.phase == "inference", s.memo == -1, s' = { ...s, memo: s.owner } }
  action inferenceComplete = all {
    s.phase == "inference",
    s' = { ...s, phase: "owner", requestEpoch: s.epoch,
      memo: if (s.checkEpoch == s.epoch) s.memo else -1 }
  }
  action ownerRead = all { s.phase == "owner", s.memo == -1, s' = { ...s, memo: s.owner } }
  action admit = all {
    s.phase == "owner", s.memo >= 0,
    s' = if (s.requestEpoch == s.epoch and s.memo == s.roomOwner)
      { ...s, phase: "admitted", admittedOwner: s.memo }
      else { ...s, phase: "rejected" }
  }
  val current = s.requestEpoch == s.epoch and s.admittedOwner == s.owner
  action send = all {
    s.phase == "admitted",
    s' = if (current) { ...s, phase: "sent", sentWithAuthority: current }
      else { ...s, phase: "rejected" }
  }
  action reply = all {
    s.phase == "sent",
    s' = if (current) { ...s, phase: "returned", returnedWithAuthority: current }
      else { ...s, phase: "rejected" }
  }
  action reset = all { s.epoch < 2, s' = { ...s, epoch: s.epoch + 1, roomOwner: -1 } }
  action rotate = all { s.owner == 0, s' = { ...s, owner: 1 } }
  action reopen = all { s.roomOwner == -1, s' = { ...s, roomOwner: s.owner } }
  action legacySendWithoutRecheck = all {
    s.phase == "admitted", s' = { ...s, phase: "sent", sentWithAuthority: current }
  }
  action step = any { begin, inferenceReadsOwner, inferenceComplete, ownerRead,
    admit, send, reply, reset, rotate, reopen, s' = s }
  val safety = s.sentWithAuthority and s.returnedWithAuthority
  run sharedOwnerReadAdmitsTest = init.then(begin).then(inferenceReadsOwner)
    .then(inferenceComplete).then(admit).then(send).then(reply).expect(s.phase == "returned" and safety)
  run resetDuringInferenceDropsMemoTest = init.then(begin).then(inferenceReadsOwner)
    .then(reset).then(rotate).then(reopen).then(inferenceComplete)
    .expect(s.memo == -1 and s.requestEpoch == s.epoch and safety)
  run newOwnerReadAfterResetTest = init.then(begin).then(inferenceReadsOwner)
    .then(reset).then(rotate).then(reopen).then(inferenceComplete).then(ownerRead)
    .then(admit).then(send).expect(s.admittedOwner == 1 and safety)
  run rotationBeforeSendIsRejectedTest = init.then(begin).then(inferenceComplete)
    .then(ownerRead).then(admit).then(rotate).then(send).expect(s.phase == "rejected" and safety)
  run rotationBeforeReplyIsRejectedTest = init.then(begin).then(inferenceComplete)
    .then(ownerRead).then(admit).then(send).then(rotate).then(reply).expect(s.phase == "rejected" and safety)
  run missingDispatchGuardDetectedTest = init.then(begin).then(inferenceComplete)
    .then(ownerRead).then(admit).then(rotate).then(legacySendWithoutRecheck).expect(not(safety))
}
