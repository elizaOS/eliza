// One durable owner row, two destination identities and one reviewed pause key.
module LinkedCalendarControl {
  type Control = {
    revision: int, paused: bool, destination: int,
    lease: int, issued: int, receiptRevision: int, result: str,
  }
  var s: Control

  pure val maxRevision = 6
  pure val maxIssued = 2
  pure def reviewInputs(current: int): Set[int] =
    if (current == 0) Set(0, 1) else Set(current, current - 1)
  action init = s' = {
    revision: 0, paused: true, destination: 0,
    lease: 0, issued: 0, receiptRevision: 0, result: "initial",
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

  action step = any {
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
    {
      nondet expected = reviewInputs(s.revision).union(
        if (s.receiptRevision == 0) Set() else Set(s.receiptRevision - 1)
      ).oneOf()
      nondet durable = Set(false, true).oneOf()
      reviewedPause(expected, durable)
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
