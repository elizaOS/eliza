// browserDocumentDraftSlot and BrowserDocumentStore compareExchange.
// The draft sees bytes, while the IndexedDB transaction checks the exact
// document revision and bytes captured by the adapter's internal read.
module BrowserDraftStorage {
  pure val Writers = Set(1, 2)

  type Snapshot = { revision: int, raw: str }
  type Operation = {
    phase: str,
    expected: str,
    captured: Snapshot,
    cancelled: bool,
    writtenRevision: int,
  }
  type State = {
    initial: Snapshot,
    document: Snapshot,
    reopened: Snapshot,
    transaction: int,
    resetRevision: int,
    operations: int -> Operation,
    staleCommit: bool,
  }

  var s: State

  pure val absent: Snapshot = { revision: 0, raw: "absent" }
  pure val unopened: Snapshot = { revision: -1, raw: "absent" }
  pure val unused: Operation = {
    phase: "unused", expected: "none", captured: absent,
    cancelled: false, writtenRevision: 0,
  }

  pure def slotRaw(snapshot: Snapshot): str =
    if (snapshot.raw == "absent" or snapshot.raw == "tombstone") "none"
    else snapshot.raw

  pure def writeRaw(id: int): str = if (id == 1) "edited" else "cleared"

  pure def update(t: State, id: int, operation: Operation): State =
    { ...t, operations: t.operations.set(id, operation) }

  pure def setPhase(t: State, id: int, phase: str): State =
    update(t, id, { ...t.operations.get(id), phase: phase })

  pure def active(phase: str): bool =
    Set("dispatched", "checked", "staged", "committed").contains(phase)

  pure def recordedBytes(t: State, snapshot: Snapshot): bool = or {
    snapshot == t.initial,
    t.resetRevision > 0 and snapshot.revision == t.resetRevision
      and snapshot.raw == "tombstone",
    Writers.exists(id => {
      val revision = t.operations.get(id).writtenRevision
      revision > 0 and snapshot.revision == revision and snapshot.raw == writeRaw(id)
    }),
  }

  action init = {
    nondet initial = Set(absent, { revision: 1, raw: "legacy" }).oneOf()
    s' = {
      initial: initial, document: initial, reopened: unopened,
      transaction: 0, resetRevision: 0,
      operations: Writers.mapBy(_ => unused), staleCommit: false,
    }
  }

  action observe(id: int): bool = all {
    s.operations.get(id).phase == "unused",
    s' = update(s, id, { ...unused, phase: "observed", expected: slotRaw(s.document) }),
  }

  action dispatch(id: int): bool = all {
    s.operations.get(id).phase == "observed",
    s' = setPhase(s, id, "dispatched"),
  }

  action adapterRead(id: int): bool = {
    val operation = s.operations.get(id)
    all {
      operation.phase == "dispatched",
      s' = if (operation.expected == slotRaw(s.document))
        update(s, id, { ...operation, phase: "checked", captured: s.document })
      else setPhase(s, id, "conflict"),
    }
  }

  action transactionCheck(id: int): bool = {
    val operation = s.operations.get(id)
    all {
      operation.phase == "checked",
      s.transaction == 0,
      s' = if (operation.captured == s.document)
        { ...setPhase(s, id, "staged"), transaction: id }
      else setPhase(s, id, "conflict"),
    }
  }

  action commit(id: int): bool = {
    val operation = s.operations.get(id)
    val revision = s.document.revision + 1
    all {
      s.transaction == id,
      s' = {
        ...update(s, id, { ...operation, phase: "committed", writtenRevision: revision }),
        transaction: 0, document: { revision: revision, raw: writeRaw(id) },
        staleCommit: s.staleCommit or operation.captured != s.document,
      },
    }
  }

  action failWrite(id: int): bool = {
    val phase = s.operations.get(id).phase
    all {
      Set("dispatched", "checked", "staged").contains(phase),
      s' = {
        ...setPhase(s, id, "failed"),
        transaction: if (s.transaction == id) 0 else s.transaction,
      },
    }
  }

  // The draft raw slot has no signal. An already dispatched write can commit
  // even if the draft caller subsequently reports AbortError.
  action cancel(id: int): bool = {
    val operation = s.operations.get(id)
    all {
      not(operation.cancelled),
      operation.phase == "observed" or active(operation.phase),
      s' = update(s, id, {
        ...operation, cancelled: true,
        phase: if (operation.phase == "observed") "cancelled" else operation.phase,
      }),
    }
  }

  action settle(id: int): bool = {
    val operation = s.operations.get(id)
    all {
      operation.phase == "committed",
      s' = setPhase(s, id, if (operation.cancelled) "cancelled" else "saved"),
    }
  }

  // Close can win before commit or follow it before the caller sees a receipt.
  action close(id: int): bool = all {
    active(s.operations.get(id).phase),
    s' = {
      ...setPhase(s, id, "closed"),
      transaction: if (s.transaction == id) 0 else s.transaction,
    },
  }

  action resetDocument = all {
    s.transaction == 0,
    s.resetRevision == 0,
    s' = {
      ...s, resetRevision: s.document.revision + 1,
      document: { revision: s.document.revision + 1, raw: "tombstone" },
    },
  }

  // A fresh page reads the committed snapshot independently of old callers.
  action reopen = all {
    s.reopened == unopened,
    s' = { ...s, reopened: s.document },
  }

  action advance(id: int): bool = any {
    adapterRead(id), transactionCheck(id), commit(id), failWrite(id), settle(id),
  }

  action step = any {
    { nondet id = Writers.oneOf() observe(id) },
    { nondet id = Writers.oneOf() dispatch(id) },
    { nondet id = Writers.oneOf() cancel(id) },
    { nondet id = Writers.oneOf() close(id) },
    advance(1), advance(2), resetDocument, reopen, s' = s,
  }

  val ExactReceiptAtCommit = not(s.staleCommit)

  val StagedTransactionIsExclusive = Writers.forall(id =>
    (s.operations.get(id).phase == "staged") == (s.transaction == id)
  )

  val SavedReceiptRequiresCommit = Writers.forall(id => {
    val operation = s.operations.get(id)
    (operation.phase == "saved").implies(
      not(operation.cancelled) and operation.writtenRevision > 0
    )
  })

  val OnlyCommittedBytesVisible = {
    val first = s.operations.get(1).writtenRevision
    val second = s.operations.get(2).writtenRevision
    val revision = s.document.revision
    and {
      revision == s.initial.revision + (if (first > 0) 1 else 0)
        + (if (second > 0) 1 else 0) + (if (s.resetRevision > 0) 1 else 0),
      recordedBytes(s, s.document),
    }
  }

  val ReopenReadsCommittedBytes =
    s.reopened == unopened or recordedBytes(s, s.reopened)

  temporal EveryDispatchedWriteSettles = and {
    always(active(s.operations.get(1).phase).implies(
      eventually(not(active(s.operations.get(1).phase))))),
    always(active(s.operations.get(2).phase).implies(
      eventually(not(active(s.operations.get(2).phase))))),
  }

  temporal UnderFairTransactions = and {
    weakFair(advance(1), s),
    weakFair(advance(2), s),
  } implies EveryDispatchedWriteSettles
}
