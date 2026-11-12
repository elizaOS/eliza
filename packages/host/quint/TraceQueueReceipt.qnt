// One native SQLite queue, one upload owner and one clean reopen. The entire
// retained queue fits in one upload batch in this finite projection.
module TraceQueueReceipt {
  pure val ids = Set(1, 2, 3)
  pure val capacity = 2
  var s: {
    rows: Set[int], batch: Set[int], dropped: int, cursor: int,
    withdrawn: bool, closed: bool, reopened: bool, result: str
  }

  action init = s' = {
    rows: Set(), batch: Set(), dropped: 0, cursor: -1,
    withdrawn: false, closed: false, reopened: false, result: "none"
  }

  action enqueue(id: int, sameDocument: bool): bool = all {
    not(s.closed),
    // Bound the persistent gap counter, rather than make it wrap.
    s.withdrawn or s.rows.contains(id) or s.rows.size() < capacity or s.dropped < 2,
    s' = if (s.withdrawn) s.with("result", "withdrawn")
      else if (s.rows.contains(id)) s.with("result", if (sameDocument) "replay" else "conflict")
      else if (s.rows.size() == capacity) { ...s, dropped: s.dropped + 1, result: "full" }
      else { ...s, rows: s.rows.union(Set(id)), result: "queued" },
  }
  action checkpoint(cursor: int): bool = all {
    not(s.closed), not(s.withdrawn),
    s' = { ...s, cursor: cursor, result: "checkpoint" },
  }
  action flush = all {
    not(s.closed),
    s' = if (s.batch != Set()) s.with("result", "busy")
      else if (s.rows == Set()) s.with("result", "empty")
      else { ...s, batch: s.rows, result: "pending" },
  }
  action settle(durable: bool, accepted: Set[int], count: int): bool = {
    val exact = durable and accepted == s.batch and count == s.batch.size()
    all {
      s.batch != Set(),
      s' = { ...s, batch: Set(),
        rows: if (exact) s.rows.exclude(s.batch) else s.rows,
        result: if (exact) "acknowledged" else "failed"
      },
    }
  }
  action reply = {
    nondet durable = Set(false, true).oneOf()
    nondet accepted = ids.powerset().oneOf()
    nondet count = accepted.size().to(3).oneOf()
    settle(durable, accepted, count)
  }
  action withdraw = all {
    not(s.closed),
    s' = { ...s, rows: Set(), cursor: -1, withdrawn: true, result: "withdrawn" },
  }
  action close = all {
    not(s.closed),
    s' = if (s.batch == Set()) { ...s, closed: true, result: "closed" }
      else s.with("result", "close-refused"),
  }
  action reopen = all {
    s.closed, not(s.reopened),
    s' = { ...s, closed: false, reopened: true, result: "reopened" },
  }
  action step = any {
    {
      nondet id = ids.oneOf()
      nondet sameDocument = Set(false, true).oneOf()
      enqueue(id, sameDocument)
    },
    {
      nondet cursor = Set(0, 1).oneOf()
      checkpoint(cursor)
    },
    flush, reply, withdraw, close, reopen, s' = s,
  }

  val QueueBounds = s.rows.size() <= capacity and s.batch.size() <= capacity
  val PendingOwnsSnapshot = not(s.withdrawn) implies s.batch.subseteq(s.rows)
  val WithdrawalClearsDurableCapture = s.withdrawn implies (s.rows == Set() and s.cursor == -1)
  val CloseRequiresSettledUpload = s.closed implies s.batch == Set()
  temporal ReceiptRetiresOnlyItsSnapshot = always((
    (s.batch != Set() and next(s.batch) == Set() and next(s.result) == "acknowledged")
      implies next(s.rows) == s.rows.exclude(s.batch)
  ).orKeep(s))
  temporal FailedReceiptKeepsRows = always((
    (s.batch != Set() and next(s.batch) == Set() and next(s.result) == "failed")
      implies next(s.rows) == s.rows
  ).orKeep(s))
  temporal WithdrawalPersists = always((s.withdrawn implies next(s.withdrawn)).orKeep(s))
  temporal FlushSettles = (s.batch != Set()).leadsTo(s.batch == Set())
  temporal FairFlushSettles = reply.weakFair(s) implies FlushSettles

  run exactReceiptKeepsLaterAppendTest = init.then(enqueue(1, true)).then(flush)
    .then(enqueue(2, true)).then(flush).expect(s.result == "busy" and s.batch == Set(1))
    .then(close).expect(s.result == "close-refused" and not(s.closed))
    .then(settle(true, Set(1), 1)).expect(s.rows == Set(2) and s.batch == Set())
  run inexactReceiptsKeepTheBatchTest = init.then(enqueue(1, true)).then(enqueue(2, true))
    .then(flush).then(settle(false, Set(1, 2), 2)).expect(s.rows == Set(1, 2))
    .then(flush).then(settle(true, Set(1), 1)).expect(s.rows == Set(1, 2))
    .then(flush).then(settle(true, Set(1), 2)).expect(s.rows == Set(1, 2))
    .then(flush).then(settle(true, Set(1, 3), 2)).expect(s.rows == Set(1, 2))
  run lateReceiptCannotUndoWithdrawalTest = init.then(enqueue(1, true)).then(checkpoint(1))
    .then(flush).then(withdraw).then(settle(true, Set(1), 1))
    .then(close).then(reopen).then(enqueue(2, true))
    .expect(s.withdrawn and s.rows == Set() and s.cursor == -1 and s.result == "withdrawn")
  run replayAndOverflowPreserveDurableStateTest = init.then(enqueue(1, true)).then(enqueue(2, true))
    .then(checkpoint(1)).then(enqueue(1, true)).expect(s.result == "replay" and s.dropped == 0)
    .then(enqueue(1, false)).expect(s.result == "conflict" and s.dropped == 0)
    .then(enqueue(3, true)).expect(s.result == "full" and s.rows == Set(1, 2) and s.dropped == 1)
    .then(close).then(reopen).expect(s.rows == Set(1, 2) and s.cursor == 1 and s.dropped == 1)
}
