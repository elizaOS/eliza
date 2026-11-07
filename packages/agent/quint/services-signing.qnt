// signing-policy.ts and remote-signing-service.ts: atomic replay/rate reservation,
// one approval and one signer operation; failures return only unconsumed slots.
// Cryptography, authorization at the HTTP boundary, and concrete policy values are external.
// Policy is fixed for this projection; policy replacement needs separate validation.
module services_signing {
  var s: { phase: str, reserved: bool, human: bool, needsHuman: bool, signed: bool, receipt: bool }
  action init = s' = { phase: "new", reserved: false, human: false, needsHuman: false, signed: false, receipt: false }
  action submit(needsHuman: bool): bool = all { s.phase == "new", s' = s.with("phase", if (needsHuman) "pending" else "signing").with("reserved", true).with("needsHuman", needsHuman) }
  action approve = all { s.phase == "pending", s' = s.with("phase", "signing").with("human", true) }
  action rejectOrExpire = all { s.phase == "pending", s' = s.with("phase", "new").with("reserved", false) }
  action signSuccess = all { s.phase == "signing", s' = s.with("phase", "signed").with("signed", true) }
  action auditSuccess = all { s.phase == "signed", s' = s.with("phase", "complete").with("receipt", true) }
  action auditFailure = all { s.phase == "signed", s' = s.with("phase", "auditFailed") }
  action signFailure = all { s.phase == "signing", s' = s.with("phase", "new").with("reserved", false).with("human", false) }
  action keep = s' = s
  action step = any { submit(true), submit(false), approve, rejectOrExpire, signSuccess, auditSuccess, auditFailure, signFailure, keep }
  val safety = all { s.phase.in(Set("new", "pending", "signing", "signed", "complete", "auditFailed")), s.reserved == (s.phase != "new"), s.signed == s.phase.in(Set("signed", "complete", "auditFailed")), s.receipt == (s.phase == "complete"), s.signed implies s.reserved, s.signed and s.needsHuman implies s.human }
  run approvalConsumedOnceTest = init.then(submit(true)).then(approve).then(signSuccess).expect(s.signed and s.human and s.reserved)
  run failedSignerReturnsSlotTest = init.then(submit(false)).then(signFailure).then(submit(false)).then(signSuccess).then(auditSuccess).expect(s.receipt)
  run expiredApprovalReturnsSlotTest = init.then(submit(true)).then(rejectOrExpire).expect(not(s.reserved))
  run auditFailureRetainsConsumedReservationTest = init.then(submit(false)).then(signSuccess).then(auditFailure).expect(s.signed and s.reserved and not(s.receipt))
}
