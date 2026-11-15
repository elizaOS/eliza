// One durable owner row shared by control, dispatch and reviewed mapping edits.
module LinkedCalendarControlState {
  type Mapping = { destination: int, providerId: int, handoffKey: bool, disposition: str }
  type MappingReceipt = { revision: int, operation: str, requestDestination: int, after: Mapping }
  type Control = {
    revision: int, paused: bool, destination: int,
    lease: int, issued: int, receiptRevision: int, result: str,
    mapping: Mapping, mappingReceipt: MappingReceipt,
  }
  var s: Control

  pure val maxRevision = 6
  pure val maxIssued = 2
  pure val originalMapping = { destination: 1, providerId: 1, handoffKey: false, disposition: "clean" }
  pure def reviewInputs(current: int): Set[int] =
    if (current == 0) Set(0, 1) else Set(current, current - 1)
  action init = s' = {
    revision: 0, paused: true, destination: 0,
    lease: 0, issued: 0, receiptRevision: 0, result: "initial",
    mapping: originalMapping,
    mappingReceipt: { revision: 0, operation: "none", requestDestination: 0, after: originalMapping },
  }

  action update(operation: str, expected: int, destination: int): bool = {
    val allowed = expected == s.revision and s.revision < maxRevision and
      (operation == "pause" or
        (s.lease == 0 and ((operation == "select" and s.paused) or
          (operation == "resume" and s.destination != 0))))
    s' = if (allowed) {
      ...s, revision: s.revision + 1, result: "updated",
      paused: operation != "resume",
      destination: if (operation == "select") destination else s.destination,
    } else s.with("result", "refused")
  }

  action reviewedPause(expected: int, receiptWriteSucceeds: bool): bool = {
    s' = if (s.receiptRevision > 0) s.with("result",
      if (expected + 1 != s.receiptRevision) "key-conflict"
      else if (s.revision != s.receiptRevision) "superseded"
      else "replayed")
    else if (expected != s.revision or s.revision == maxRevision)
      s.with("result", "refused")
    else if (receiptWriteSucceeds) {
      ...s, paused: true, revision: s.revision + 1,
      receiptRevision: s.revision + 1, result: "committed",
    } else s.with("result", "rolled-back")
  }

  action acquire(expected: int, destination: int): bool = {
    val allowed = expected == s.revision and not(s.paused) and
      s.lease == 0 and destination == s.destination and s.issued < maxIssued
    s' = if (allowed) {
      ...s, lease: s.issued + 1, issued: s.issued + 1, result: "admitted",
    } else s.with("result", "refused")
  }

  action settle(token: int, pausedRevision: int): bool = {
    val ordinary = pausedRevision == -1
    val allowed = s.lease != 0 and token == s.lease and
      (ordinary or (s.paused and pausedRevision == s.revision and s.revision < maxRevision))
    s' = if (allowed) {
      ...s, lease: 0, result: if (ordinary) "settled" else "recovered",
      revision: if (ordinary) s.revision else s.revision + 1,
    } else s.with("result", "refused")
  }

  action receiveOwnerSettlement = all {
    s.lease != 0,
    settle(s.lease, -1),
  }

  // Reopening or reconstructing a repository reads the same durable row.
  action reopen = s' = s.with("result", "reopened")

  action controlStep(checkPauseReceipt: bool): bool = any {
    {
      nondet expected = reviewInputs(s.revision).oneOf()
      nondet destination = Set(0, 1, 2).oneOf()
      update("select", expected, destination)
    },
    {
      nondet op = Set("resume", "pause").oneOf()
      nondet expected = reviewInputs(s.revision).oneOf()
      update(op, expected, 0)
    },
    all {
      checkPauseReceipt,
      nondet expected = reviewInputs(s.revision).union(
        if (s.receiptRevision == 0) Set() else Set(s.receiptRevision - 1)
      ).oneOf()
      nondet durable = Set(false, true).oneOf()
      reviewedPause(expected, durable),
    },
    {
      nondet expected = reviewInputs(s.revision).oneOf()
      nondet destination = Set(1, 2).oneOf()
      acquire(expected, destination)
    },
    {
      nondet token = 1.to(maxIssued).oneOf()
      nondet pausedRevision = reviewInputs(s.revision).union(Set(-1)).oneOf()
      settle(token, pausedRevision)
    },
    reopen, s' = s,
  }

  val DestinationOwnsDispatch =
    (not(s.paused) or s.lease != 0) implies s.destination != 0
  val ExactOwnerIdentity = s.lease == 0 or s.lease == s.issued
  val ReceiptRevisionCommitted = s.receiptRevision <= s.revision

  temporal AdmissionRequiresCurrentControl = always((
    next(s.issued) != s.issued implies
      not(s.paused) and s.lease == 0 and s.revision == next(s.revision) and
      s.destination == next(s.destination)
  ).orKeep(s))
  temporal PausePreservesAdmittedOwner = always((
    s.lease != 0 and next(s.revision) > s.revision and next(s.result) != "recovered"
      implies next(s.lease) == s.lease and next(s.destination) == s.destination
  ).orKeep(s))
  temporal OwnerReleasePreservesDestination = always((
    s.lease != 0 and next(s.lease) == 0 implies
      next(s.destination) == s.destination and next(s.paused) == s.paused and
      next(s.issued) == s.issued and
      (next(s.revision) == s.revision or
        (s.paused and next(s.revision) == s.revision + 1))
  ).orKeep(s))
  temporal PauseReceiptCommitsOnce = always((
    (s.receiptRevision != 0 implies next(s.receiptRevision) == s.receiptRevision) and
    (next(s.receiptRevision) != s.receiptRevision implies
      next(s.revision) == s.revision + 1 and next(s.paused) and next(s.lease) == s.lease)
  ).orKeep(s))
  temporal DispatchSettles = and {
    (s.lease == 1).leadsTo(s.lease != 1),
    (s.lease == 2).leadsTo(s.lease != 2),
  }
  temporal FairDispatchSettles = receiveOwnerSettlement.weakFair(s) implies DispatchSettles
}

module LinkedCalendarControl {
  import LinkedCalendarControlState.*

  action step = controlStep(true)

  run PauseWaitsForExactOwnerTest = init.then(update("select", 0, 1))
    .then(update("resume", 1, 0)).then(acquire(2, 1)).then(reviewedPause(2, true))
    .then(update("select", 3, 2)).expect(s.result == "refused" and s.lease == 1)
    .then(update("resume", 3, 0)).expect(s.result == "refused" and s.lease == 1)
    .then(settle(2, -1)).expect(s.result == "refused" and s.lease == 1)
    .then(settle(1, -1)).then(update("resume", 3, 0))
    .then(acquire(4, 1)).expect(s.result == "admitted" and s.lease == 2)

  run ReopenRetainsLeaseAndRecoveryInvalidatesReviewTest = init.then(update("select", 0, 1))
    .then(update("resume", 1, 0)).then(acquire(2, 1)).then(update("pause", 2, 0))
    .then(reopen).expect(s.lease == 1 and s.revision == 3 and s.paused)
    .then(settle(1, 2)).expect(s.result == "refused" and s.lease == 1)
    .then(settle(1, 3)).expect(s.result == "recovered" and s.revision == 4 and s.lease == 0)
    .then(update("resume", 3, 0)).expect(s.result == "refused" and s.paused)
    .then(update("resume", 4, 0)).expect(not(s.paused))

  run PauseReceiptRollsBackAndReplaysTest = init.then(reviewedPause(0, false))
    .expect(s.revision == 0 and s.receiptRevision == 0 and s.result == "rolled-back")
    .then(reviewedPause(0, true)).then(reopen).then(reviewedPause(0, true))
    .expect(s.revision == 1 and s.receiptRevision == 1 and s.result == "replayed")
    .then(reviewedPause(1, true)).expect(s.result == "key-conflict" and s.revision == 1)
    .then(update("select", 1, 1)).then(reviewedPause(0, true))
    .expect(s.result == "superseded" and s.revision == 2 and s.receiptRevision == 1)
}

module LinkedCalendarMapping {
  import LinkedCalendarControlState.*

  action editMapping(operation: str, expected: int, exactLinkReview: bool,
      destination: int, receiptWriteSucceeds: bool): bool = {
    val receipt = s.mappingReceipt
    val sameRequest = expected + 1 == receipt.revision and exactLinkReview and
      operation == receipt.operation and destination == receipt.requestDestination
    val allowed = s.paused and s.lease == 0 and expected == s.revision and
      s.revision < maxRevision and exactLinkReview and
      (operation == "retain-local" or (s.destination != 0 and
        destination == s.destination and destination != s.mapping.destination))
    val nextMapping = if (operation == "retain-local")
      s.mapping.with("disposition", "local-only")
    else { destination: destination, providerId: 0, handoffKey: true, disposition: "create" }
    s' = if (receipt.revision > 0) s.with("result",
      if (sameRequest and s.revision == receipt.revision) "mapping-replayed" else "refused")
    else if (not(allowed)) s.with("result", "refused")
    else if (not(receiptWriteSucceeds)) s.with("result", "mapping-rolled-back")
    else {
      ...s, revision: s.revision + 1, mapping: nextMapping, result: "mapping-committed",
      mappingReceipt: { revision: s.revision + 1, operation: operation,
        requestDestination: destination, after: nextMapping },
    }
  }

  val mappingReviewInputs = reviewInputs(s.revision).union(
    if (s.mappingReceipt.revision == 0) Set() else Set(s.mappingReceipt.revision - 1)
  )

  action step = any {
    controlStep(false),
    {
      nondet expected = mappingReviewInputs.oneOf()
      nondet exactLinkReview = Set(false, true).oneOf()
      nondet durable = Set(false, true).oneOf()
      editMapping("retain-local", expected, exactLinkReview, 0, durable)
    },
    {
      nondet expected = mappingReviewInputs.oneOf()
      nondet exactLinkReview = Set(false, true).oneOf()
      nondet destination = Set(1, 2).oneOf()
      nondet durable = Set(false, true).oneOf()
      editMapping("rebind", expected, exactLinkReview, destination, durable)
    },
  }

  val MappingHasDurableReceipt = if (s.mappingReceipt.revision == 0)
    s.mapping == originalMapping
  else s.mappingReceipt.revision <= s.revision and s.mappingReceipt.after == s.mapping

  val RetainLocalPreservesProviderIdentity = (s.mappingReceipt.operation == "retain-local") implies
    s.mapping == originalMapping.with("disposition", "local-only")

  val RebindStagesFreshCreate = (s.mappingReceipt.operation == "rebind") implies
    s.mapping.destination == s.mappingReceipt.requestDestination and
    s.mapping.destination != originalMapping.destination and
    s.mapping.providerId == 0 and s.mapping.handoffKey and s.mapping.disposition == "create"

  temporal MappingCommitRequiresDrainedPause = always((
    next(s.mappingReceipt) != s.mappingReceipt implies
      s.mappingReceipt.revision == 0 and s.paused and s.lease == 0 and
      next(s.paused) and next(s.lease) == 0 and next(s.destination) == s.destination and
      next(s.revision) == s.revision + 1 and next(s.mappingReceipt.revision) == next(s.revision) and
      (next(s.mappingReceipt.operation) == "rebind" implies next(s.mapping.destination) == s.destination)
  ).orKeep(s))

  temporal MappingReplayAndRollbackPreserveRows = always((
    (next(s.result) == "mapping-replayed" or next(s.result) == "mapping-rolled-back") implies
      next(s.with("result", "irrelevant")) == s.with("result", "irrelevant")
  ).orKeep(s))

  run RebindStagesFreshCreateTest = init.then(update("select", 0, 2))
    .then(editMapping("rebind", 1, true, 1, true)).expect(s.result == "refused")
    .then(editMapping("rebind", 1, true, 2, false))
    .expect(s.result == "mapping-rolled-back" and s.revision == 1 and s.mapping == originalMapping)
    .then(editMapping("rebind", 1, true, 2, true)).expect(RebindStagesFreshCreate)
    .then(reopen).then(editMapping("rebind", 1, true, 2, true))
    .expect(s.result == "mapping-replayed" and s.revision == 2)
    .then(update("pause", 2, 0)).then(editMapping("rebind", 1, true, 2, true))
    .expect(s.result == "refused" and s.revision == 3 and s.mappingReceipt.revision == 2)

  run RetainLocalRollsBackAndReplaysTest = init.then(update("select", 0, 2))
    .then(editMapping("retain-local", 1, false, 0, true)).expect(s.result == "refused")
    .then(editMapping("retain-local", 1, true, 0, false))
    .expect(s.result == "mapping-rolled-back" and s.revision == 1 and s.mapping == originalMapping)
    .then(editMapping("retain-local", 1, true, 0, true))
    .expect(RetainLocalPreservesProviderIdentity and s.result == "mapping-committed")
    .then(editMapping("rebind", 1, true, 2, true)).expect(s.result == "refused")
    .then(reopen).then(editMapping("retain-local", 1, true, 0, true))
    .expect(s.result == "mapping-replayed" and s.revision == 2)

  run MappingWaitsForAdmittedOwnerTest = init.then(update("select", 0, 2))
    .then(update("resume", 1, 0)).then(acquire(2, 2)).then(update("pause", 2, 0))
    .then(editMapping("retain-local", 3, true, 0, true))
    .expect(s.result == "refused" and s.lease == 1 and s.mapping == originalMapping)
    .then(editMapping("rebind", 3, true, 2, true))
    .expect(s.result == "refused" and s.lease == 1 and s.mapping == originalMapping)
    .then(settle(1, -1)).then(editMapping("rebind", 3, true, 2, true))
    .expect(s.result == "mapping-committed" and s.revision == 4)
}
