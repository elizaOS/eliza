// Queue settlement for one single request or one batch of two embedding items.
// Storage owns the exact-source comparison. Observation runs after its result.
module EmbeddingWriteSettlement {
  const Batch: bool
  pure val Items = if (Batch) Set(0, 1) else Set(0)
  type Item = {
    phase: str,
    source: int,
    singles: int,
    receipt: str,
    sourceAtReceipt: int,
    singlesAtReceipt: int,
    logFailed: bool,
    notification: str
  }
  var s: { items: int -> Item, batchStarted: bool }

  action init = s' = {
    items: Items.mapBy(_ => {
      phase: "queued", source: 0, singles: 0, receipt: "none",
      sourceAtReceipt: -1, singlesAtReceipt: -1,
      logFailed: false, notification: "none"
    }),
    batchStarted: false
  }
  def entry(id: int): Item = s.items.get(id)
  action update(id: int, nextItem: Item): bool =
    s' = { ...s, items: s.items.set(id, nextItem) }

  action edit(id: int): bool = all {
    entry(id).source == 0,
    update(id, { ...entry(id), source: 1 })
  }
  action startBatch = all {
    Batch, not(s.batchStarted),
    s' = { batchStarted: true,
      items: Items.mapBy(id => { ...entry(id), phase: "inference" }) }
  }
  action settleBatch(success: bool): bool = all {
    Batch, s.batchStarted,
    Items.forall(id => entry(id).phase == "inference" and entry(id).singles == 0),
    s' = { ...s,
      items: Items.mapBy(id => {
        ...entry(id), phase: if (success) "writing" else "retry"
      }) }
  }
  def primarySettled(id: int): bool =
    entry(id).singles > 0 or entry(id).phase.in(Set("retry", "done"))
  def canSettleWrite(id: int): bool =
    not(Batch) or entry(id).singles > 0 or
      Items.filter(other => other < id).forall(primarySettled)

  action startSingle(id: int): bool = all {
    (not(Batch) and entry(id).phase == "queued") or
      (entry(id).phase == "retry" and (not(Batch) or Items.forall(primarySettled))),
    update(id, { ...entry(id), phase: "inference", singles: entry(id).singles + 1 })
  }
  action failAttempt(id: int): bool =
    update(id, { ...entry(id),
      phase: if (entry(id).singles < 2) "retry" else "exhausted"
    })
  action settleSingle(id: int, success: bool): bool = all {
    entry(id).phase == "inference", entry(id).singles > 0,
    if (success) update(id, { ...entry(id), phase: "writing" })
    else failAttempt(id)
  }
  action settleWrite(id: int, acknowledged: bool): bool = all {
    entry(id).phase == "writing", canSettleWrite(id),
    if (acknowledged) update(id, { ...entry(id),
      phase: "logging",
      receipt: if (entry(id).source == 0) "stored" else "stale",
      sourceAtReceipt: entry(id).source, singlesAtReceipt: entry(id).singles
    }) else failAttempt(id)
  }
  action settleLog(id: int, failed: bool): bool = all {
    entry(id).phase == "logging",
    update(id, { ...entry(id), logFailed: failed,
      phase: if (entry(id).receipt == "stored") "notifying" else "done"
    })
  }
  action settleNotification(id: int, failed: bool): bool = all {
    entry(id).phase == "notifying",
    update(id, { ...entry(id), phase: "done",
      notification: if (failed) "rejected" else "sent"
    })
  }
  action advance(id: int): bool = any {
    startSingle(id),
    { nondet outcome = Bool.oneOf(); any {
      settleSingle(id, outcome), settleWrite(id, outcome),
      settleLog(id, outcome), settleNotification(id, outcome)
    } }
  }
  action advanceBatch = any {
    startBatch, { nondet success = Bool.oneOf(); settleBatch(success) }
  }
  action step = any {
    advanceBatch, { nondet id = Items.oneOf(); any { edit(id), advance(id) } },
    s' = s
  }

  val TypeOK = Items.forall(id => all {
    entry(id).phase.in(Set(
      "queued", "inference", "writing", "logging", "notifying", "retry", "done", "exhausted"
    )),
    entry(id).source.in(Set(0, 1)), entry(id).singles.in(0.to(2)),
    entry(id).receipt.in(Set("none", "stored", "stale")),
    entry(id).notification.in(Set("none", "sent", "rejected"))
  })
  val ExactSourceReceipt = Items.forall(id => all {
    (entry(id).receipt == "stored") == (entry(id).sourceAtReceipt == 0),
    (entry(id).receipt == "stale") == (entry(id).sourceAtReceipt == 1)
  })
  val ReceiptClosesRetry = Items.forall(id => (entry(id).receipt != "none").implies(all {
    entry(id).phase.in(Set("logging", "notifying", "done")),
    entry(id).singles == entry(id).singlesAtReceipt
  }))
  val OnlyStoredNotifies = Items.forall(id =>
    (entry(id).phase == "notifying" or entry(id).notification != "none")
      .implies(entry(id).receipt == "stored"))

  val Settled = Items.forall(id => entry(id).phase.in(Set("done", "exhausted")))
  temporal Fairness = all {
    advanceBatch.weakFair(s), Items.forall(id => advance(id).weakFair(s))
  }
  temporal FairItemsSettle = Fairness.implies(eventually(Settled))
  temporal ItemsSettle = eventually(Settled)
}

module EmbeddingSingleWrite {
  import EmbeddingWriteSettlement(Batch = false).*

  run rejectedDiagnosticLogStillNotifiesTest = init.then(startSingle(0))
    .then(settleSingle(0, true)).then(settleWrite(0, true))
    .then(settleLog(0, true)).then(settleNotification(0, false))
    .expect(ReceiptClosesRetry and Settled and entry(0).logFailed and entry(0).notification == "sent")
  run staleSourceRemainsTerminalTest = init.then(startSingle(0))
    .then(edit(0)).then(settleSingle(0, true)).then(settleWrite(0, true))
    .then(settleLog(0, true))
    .expect(Settled and entry(0).receipt == "stale" and entry(0).notification == "none")
  run uncommittedWriteFailureCanRetryTest = init.then(startSingle(0))
    .then(settleSingle(0, true)).then(settleWrite(0, false)).then(startSingle(0))
    .then(settleSingle(0, true)).then(settleWrite(0, true))
    .then(settleLog(0, false)).then(settleNotification(0, true))
    .expect(Settled and ReceiptClosesRetry and entry(0).singles == 2 and entry(0).notification == "rejected")
}

module EmbeddingBatchWrite {
  import EmbeddingWriteSettlement(Batch = true).*

  run observerRejectionDoesNotReplayBatchItemTest = init.then(startBatch)
    .then(settleBatch(true)).then(settleWrite(0, true)).then(settleLog(0, false))
    .then(settleNotification(0, true)).then(settleWrite(1, true)).then(settleLog(1, false))
    .then(settleNotification(1, false))
    .expect(Settled and ReceiptClosesRetry and entry(0).singles == 0 and entry(1).singles == 0)
  run uncommittedBatchItemFallsBackTest = init.then(startBatch)
    .then(settleBatch(true)).then(settleWrite(0, false))
    .then(settleWrite(1, true)).then(settleLog(1, false)).then(settleNotification(1, false))
    .then(startSingle(0)).then(settleSingle(0, true)).then(settleWrite(0, true))
    .then(settleLog(0, false)).then(settleNotification(0, false))
    .expect(Settled and ReceiptClosesRetry and entry(0).singles == 1 and entry(1).singles == 0)
}
