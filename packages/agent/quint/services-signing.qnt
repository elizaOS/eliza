// signing-policy.ts and remote-signing-service.ts. One current request, two
// payloads and one policy replacement. Submission audit, approval, signer and
// final audit remain separate awaits. Signer dispatch is the policy boundary;
// a later policy replacement cannot retract a signature already dispatched.
module services_signing {
  type State = {
    phase: str,
    reserved: bool,
    needsHuman: bool,
    human: bool,
    signed: bool,
    receipt: bool,
    submissionReceipt: bool,
    policyEpoch: int,
    policyAllows: bool,
    requestEpoch: int,
    dispatchEpoch: int,
    input: int,
    captured: int,
    listed: int,
    signature: int,
    now: int,
    expires: int,
    result: str,
  }
  var s: State
  val settledPhases = Set("new", "complete", "auditFailed")

  action init = s' = {
    phase: "new", reserved: false, needsHuman: false, human: false,
    signed: false, receipt: false, submissionReceipt: false,
    policyEpoch: 0, policyAllows: true, requestEpoch: 0, dispatchEpoch: -1,
    input: 1, captured: 0, listed: 0, signature: 0,
    now: 0, expires: 0, result: "none",
  }

  action submit(needsHuman: bool): bool = all {
    s.phase == "new",
    s' = {
      ...s, phase: "submissionAudit", reserved: s.policyAllows,
      needsHuman: needsHuman, human: false, signed: false, receipt: false,
      submissionReceipt: false, requestEpoch: s.policyEpoch, dispatchEpoch: -1,
      captured: s.input, listed: 0, signature: 0, expires: 0,
      result: "waiting",
    },
  }

  action submissionAuditSuccess = all {
    s.phase == "submissionAudit",
    val admitted = s.reserved and s.requestEpoch == s.policyEpoch
    s' = {
      ...s,
      phase: if (not(s.reserved)) "rejectionAudit"
        else if (not(admitted)) "new"
        else if (s.needsHuman) "pending" else "signing",
      reserved: admitted,
      submissionReceipt: true,
      dispatchEpoch: if (admitted and not(s.needsHuman)) s.policyEpoch else -1,
      expires: if (admitted and s.needsHuman) s.now + 2 else 0,
      result: if (s.reserved and not(admitted)) "policy_changed" else "waiting",
    },
  }
  action submissionAuditFailure = all {
    s.phase == "submissionAudit",
    s' = { ...s, phase: "new", reserved: false, result: "audit_failed" },
  }
  action rejectionAudit(success: bool): bool = all {
    s.phase == "rejectionAudit",
    s' = { ...s, phase: "new", result: if (success) "denied" else "audit_failed" },
  }

  action approve = all {
    s.phase == "pending",
    s.now <= s.expires,
    s' = {
      ...s, phase: "signing", human: true, dispatchEpoch: s.policyEpoch,
      result: "waiting",
    },
  }
  action rejectOrExpire = all {
    s.phase == "pending",
    s' = {
      ...s, phase: "new", reserved: false, human: false,
      result: if (s.now > s.expires) "expired" else "rejected",
    },
  }
  action refuseRepeatedApproval = all {
    s.phase != "pending",
    s' = { ...s, result: "approval_not_found" },
  }

  action showPending = s' = if (s.phase == "pending" and s.now > s.expires) {
    ...s, phase: "new", reserved: false, listed: 0, result: "expired",
  } else {
    ...s, listed: if (s.phase == "pending") s.captured else 0,
  }
  action mutateInput(value: int): bool = s' = { ...s, input: value }
  action mutateListing(value: int): bool = all {
    s.listed != 0,
    s' = { ...s, listed: value },
  }

  action updatePolicy(allows: bool): bool = all {
    s.policyEpoch == 0,
    s' = {
      ...s, policyEpoch: 1, policyAllows: allows,
      phase: if (s.phase == "pending") "new" else s.phase,
      reserved: if (s.phase == "pending") false else s.reserved,
      result: if (s.phase == "pending") "policy_changed" else s.result,
    },
  }

  action signSuccess = all {
    s.phase == "signing",
    s' = {
      ...s, phase: "signed", signed: true, signature: s.captured,
      result: "waiting",
    },
  }
  action signFailure = all {
    s.phase == "signing",
    s' = {
      ...s, phase: "failureAudit", reserved: false, result: "waiting",
    },
  }
  action failedSignAudit(success: bool): bool = all {
    s.phase == "failureAudit",
    s' = {
      ...s, phase: "new", human: false,
      result: if (success) "signer_failed" else "audit_failed",
    },
  }
  action auditSuccess = all {
    s.phase == "signed",
    s' = { ...s, phase: "complete", receipt: true, result: "success" },
  }
  action auditFailure = all {
    s.phase == "signed",
    s' = { ...s, phase: "auditFailed", result: "audit_failed" },
  }
  action tick = all { s.now < 3, s' = { ...s, now: s.now + 1 } }
  action keep = s' = s
  action submissionSettles = any { submissionAuditSuccess, submissionAuditFailure }
  action rejectionSettles = any { rejectionAudit(true), rejectionAudit(false) }
  action approvalDecided = any { approve, rejectOrExpire }
  action signerSettles = any { signSuccess, signFailure }
  action failureAuditSettles = any { failedSignAudit(true), failedSignAudit(false) }
  action finalAuditSettles = any { auditSuccess, auditFailure }
  action step = any {
    submit(true), submit(false), submissionSettles, rejectionSettles,
    approvalDecided, refuseRepeatedApproval, showPending,
    mutateInput(1), mutateInput(2), mutateListing(1), mutateListing(2),
    updatePolicy(true), updatePolicy(false), signerSettles,
    failureAuditSettles, finalAuditSettles, tick, keep,
  }

  val TypeOK = and {
    s.phase.in(Set("new", "submissionAudit", "rejectionAudit", "pending",
      "signing", "signed", "failureAudit", "complete", "auditFailed")),
    s.policyEpoch.in(Set(0, 1)), s.requestEpoch.in(Set(0, 1)),
    s.input.in(Set(1, 2)), s.captured.in(Set(0, 1, 2)),
    s.listed.in(Set(0, 1, 2)), s.signature.in(Set(0, 1, 2)),
    s.now.in(0.to(3)), s.expires.in(0.to(5)),
  }
  val ReservationLifecycle =
    (s.phase != "submissionAudit").implies(s.reserved ==
      s.phase.in(Set("pending", "signing", "signed", "complete", "auditFailed")))
  val SignatureConsumesReservation = s.signed.implies(s.reserved)
  val SignatureRequiresConfirmation = (s.signed and s.needsHuman).implies(s.human)
  val ImmutableAdmittedPayload = s.signed.implies(s.signature == s.captured)
  val DurableSubmissionBeforeDispatch =
    s.phase.in(Set("signing", "signed", "complete", "auditFailed"))
      .implies(s.submissionReceipt)
  val CurrentPolicyAtDispatch =
    s.phase.in(Set("signing", "signed", "complete", "auditFailed"))
      .implies(s.dispatchEpoch == s.requestEpoch)
  val PendingApprovalUsesCurrentPolicy =
    (s.phase == "pending").implies(s.requestEpoch == s.policyEpoch)
  val ReceiptAfterSignature = s.receipt == (s.phase == "complete")
  val SignatureState = s.signed == s.phase.in(Set("signed", "complete", "auditFailed"))
  val safety = TypeOK and ReservationLifecycle and SignatureConsumesReservation and
    SignatureRequiresConfirmation and ImmutableAdmittedPayload and
    DurableSubmissionBeforeDispatch and CurrentPolicyAtDispatch and
    PendingApprovalUsesCurrentPolicy and ReceiptAfterSignature and SignatureState

  temporal FairWork = and {
    submissionSettles.weakFair(s), rejectionSettles.weakFair(s),
    approvalDecided.weakFair(s), signerSettles.weakFair(s),
    failureAuditSettles.weakFair(s), finalAuditSettles.weakFair(s),
  }
  temporal RequestEventuallySettles = FairWork.implies(always(
    not(settledPhases.contains(s.phase)).implies(eventually(settledPhases.contains(s.phase)))))

  run approvalConsumedOnceTest = init.then(submit(true)).then(submissionAuditSuccess)
    .then(approve).then(signSuccess).then(refuseRepeatedApproval)
    .expect(s.signed and s.human and s.reserved)
  run failedSignerReturnsSlotTest = init.then(submit(false)).then(submissionAuditSuccess)
    .then(signFailure).then(failedSignAudit(true)).then(submit(false))
    .then(submissionAuditSuccess).then(signSuccess).then(auditSuccess).expect(s.receipt)
  run expiredApprovalReturnsSlotTest = init.then(submit(true)).then(submissionAuditSuccess)
    .then(rejectOrExpire).expect(not(s.reserved))
  run auditFailureRetainsConsumedReservationTest = init.then(submit(false))
    .then(submissionAuditSuccess).then(signSuccess).then(auditFailure)
    .expect(s.signed and s.reserved and not(s.receipt))
  run policyReplacementDuringSubmissionTest = init.then(submit(true))
    .then(updatePolicy(false)).then(submissionAuditSuccess)
    .expect(s.phase == "new" and not(s.reserved) and s.result == "policy_changed")
  run policyReplacementRevokesPendingTest = init.then(submit(true))
    .then(submissionAuditSuccess).then(updatePolicy(false)).then(refuseRepeatedApproval)
    .expect(not(s.reserved) and not(s.signed))
  run callerAndListingMutationCannotChangeSignatureTest = init.then(submit(true))
    .then(mutateInput(2)).then(submissionAuditSuccess).then(showPending)
    .then(mutateListing(2)).then(approve).then(signSuccess).then(auditSuccess)
    .expect(s.signature == 1 and s.input == 2 and s.listed == 2)
  run policyCannotRetractDispatchedSignatureTest = init.then(submit(false))
    .then(submissionAuditSuccess).then(updatePolicy(false)).then(signSuccess).then(auditSuccess)
    .expect(s.signature == 1 and s.reserved and s.policyEpoch == 1 and s.dispatchEpoch == 0)
  run submissionEvidenceFailureReturnsSlotTest = init.then(submit(true))
    .then(submissionAuditFailure).expect(not(s.reserved) and not(s.signed))
}
