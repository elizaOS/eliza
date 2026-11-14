// One exact reviewed Calendar mutation and its durable approval and attempt rows.
module CalendarMutationLedger {
  type State = {
    approval: str, attempt: str, generation: int, token: int,
    restarted: bool, reconciliationAttempt: bool, ownerConfirmed: bool,
    attemptReceipt: int, approvalReceipt: int, refusedTokens: Set[int],
  }
  var s: State

  action init = s' = {
    approval: "approved", attempt: "absent", generation: 0, token: 0,
    restarted: false, reconciliationAttempt: false, ownerConfirmed: false,
    attemptReceipt: 0, approvalReceipt: 0, refusedTokens: Set(),
  }

  val claimable = or {
    s.attempt == "absent" and s.approval == "approved",
    s.attempt == "failed_retryable" and Set("retryable", "executing").contains(s.approval),
  }

  action claim = all {
    claimable and s.generation < 2,
    s' = { ...s, attempt: "executing", approval: "executing", generation: s.generation + 1,
      token: s.generation + 1, reconciliationAttempt: false },
  }

  action invalidateBeforeClaim = all {
    claimable,
    s' = { ...s, attempt: "invalidated", approval: "expired" },
  }

  // Old versions left the approval executing when the attempt became retryable.
  action readLegacyRetry = all {
    s.attempt == "failed_retryable" and s.approval == "retryable",
    s' = { ...s, approval: "executing" },
  }

  action recordReceipt(token: int): bool = all {
    token > 0 and token <= s.generation,
    if (s.attempt == "executing" and token == s.token) {
      s' = { ...s, attempt: "succeeded", approval: "done", attemptReceipt: token }
    } else {
      s' = { ...s, refusedTokens: s.refusedTokens.union(Set(token)) }
    },
  }

  action recordRefusal = all {
    s.attempt == "executing",
    s' = { ...s, attempt: "failed_retryable", approval: "retryable", token: 0 },
  }

  action recordUnknown = all {
    s.attempt == "executing",
    s' = { ...s, attempt: "ambiguous", approval: "reconciliation_required",
      reconciliationAttempt: true },
  }

  action restartAndInspect = all {
    not(s.restarted),
    s' = if (s.attempt == "executing") {
      ...s, restarted: true, attempt: "ambiguous", approval: "reconciliation_required",
      reconciliationAttempt: true,
    } else { ...s, restarted: true },
  }

  val awaitingReconciliation = s.attempt == "ambiguous" and
    s.approval == "reconciliation_required" and s.reconciliationAttempt

  action confirmNonDelivery = all {
    awaitingReconciliation,
    s' = { ...s, attempt: "failed_retryable", approval: "retryable", token: 0 },
  }

  action confirmWithoutReceipt = all {
    awaitingReconciliation,
    s' = { ...s, approval: "done", ownerConfirmed: true },
  }

  action reconcileReceipt(matchesOperation: bool): bool = all {
    awaitingReconciliation,
    s' = if (matchesOperation) {
      ...s, attempt: "succeeded", approval: "done", attemptReceipt: 3, approvalReceipt: 3,
    } else s,
  }

  action settleClaim = all {
    s.attempt == "executing",
    any { recordReceipt(s.token), recordRefusal, recordUnknown },
  }

  action settleReconciliation = any { confirmNonDelivery, confirmWithoutReceipt, reconcileReceipt(true) }

  action step = any { claim, invalidateBeforeClaim, readLegacyRetry, settleClaim,
    recordReceipt(1), recordReceipt(2), restartAndInspect, settleReconciliation,
    reconcileReceipt(false), s' = s }

  val PairedDurableRows = and {
    (s.attempt == "absent") == (s.approval == "approved"),
    (s.attempt == "invalidated") == (s.approval == "expired"),
    s.attempt == "executing" implies s.approval == "executing",
    s.approval == "executing" implies Set("executing", "failed_retryable").contains(s.attempt),
    s.attempt == "failed_retryable" implies Set("retryable", "executing").contains(s.approval),
    s.approval == "retryable" implies s.attempt == "failed_retryable",
    (s.approval == "done") == (s.attempt == "succeeded" or s.ownerConfirmed),
    (s.approval == "reconciliation_required") == (s.attempt == "ambiguous" and not(s.ownerConfirmed)),
  }

  val ExactClaimAndReconciliation = and {
    Set("executing", "ambiguous", "succeeded").contains(s.attempt) implies s.token == s.generation and s.token > 0,
    Set("absent", "failed_retryable", "invalidated").contains(s.attempt) implies s.token == 0,
    s.approval == "reconciliation_required" implies s.reconciliationAttempt,
    s.attempt == "ambiguous" implies not(claimable),
  }

  val ReplayRequiresDurableReceipt = and {
    (s.attempt == "succeeded") == (s.attemptReceipt != 0),
    (s.approvalReceipt != 0) == (s.attemptReceipt == 3),
    s.approvalReceipt != 0 implies s.approvalReceipt == s.attemptReceipt and s.reconciliationAttempt,
    Set(1, 2).contains(s.attemptReceipt) implies s.attemptReceipt == s.token,
    s.ownerConfirmed implies s.attempt == "ambiguous" and s.attemptReceipt == 0,
  }

  temporal DurableReceiptIsImmutable = always((s.attemptReceipt != 0 implies
    next(s.attemptReceipt) == s.attemptReceipt and next(s.approvalReceipt) == s.approvalReceipt
  ).orKeep(s))

  temporal RefusedTokenPreservesRows = always((
    next(s.refusedTokens) != s.refusedTokens implies
      next(s.attempt) == s.attempt and next(s.approval) == s.approval and
      next(s.token) == s.token and next(s.attemptReceipt) == s.attemptReceipt and
      next(s.approvalReceipt) == s.approvalReceipt
  ).orKeep(s))

  temporal ClaimSettles = (s.attempt == "executing").leadsTo(s.attempt != "executing")
  temporal ReconciliationSettles = (s.approval == "reconciliation_required").leadsTo(s.approval != "reconciliation_required")
  temporal FairClaimSettles = settleClaim.weakFair(s) implies ClaimSettles
  temporal FairReconciliationSettles = settleReconciliation.weakFair(s) implies ReconciliationSettles

  run ReceiptSurvivesRestartTest = init.then(claim).then(recordReceipt(1))
    .then(restartAndInspect).then(recordReceipt(1))
    .expect(s.approval == "done" and s.attemptReceipt == 1 and s.approvalReceipt == 0)

  run OwnerConfirmationCannotReplayTest = init.then(claim).then(restartAndInspect)
    .then(recordReceipt(1)).then(confirmWithoutReceipt)
    .expect(s.approval == "done" and s.attempt == "ambiguous" and s.attemptReceipt == 0 and not(claimable))

  run ReconciledReceiptRequiresExactOperationTest = init.then(claim).then(recordUnknown)
    .then(reconcileReceipt(false)).expect(awaitingReconciliation and s.attemptReceipt == 0)
    .then(reconcileReceipt(true)).expect(s.approval == "done" and s.attemptReceipt == 3 and s.approvalReceipt == 3)

  run NonDeliveryReclaimsWithNewTokenTest = init.then(claim).then(recordUnknown)
    .then(confirmNonDelivery).then(claim).then(recordReceipt(1))
    .expect(s.approval == "executing" and s.token == 2 and s.refusedTokens == Set(1))
    .then(recordReceipt(2)).expect(s.attemptReceipt == 2 and s.approval == "done")

  run RetryInvalidatesBeforeDispatchTest = init.then(claim).then(recordRefusal)
    .then(invalidateBeforeClaim).expect(s.approval == "expired" and s.attempt == "invalidated")

  run LegacyRetryInvalidatesBeforeDispatchTest = init.then(claim).then(recordRefusal)
    .then(readLegacyRetry).then(invalidateBeforeClaim)
    .expect(s.approval == "expired" and s.attempt == "invalidated")
}
