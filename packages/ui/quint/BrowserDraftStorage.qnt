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

// DurableDraftController hold, consume and release over two IndexedDB keys.
// Revision numbers stand for fresh receipts, with an exact marked-row read
// by a second controller before any release write.
module BrowserDraftHoldConsume {
  type Receipt = { text: str, revision: int, sending: bool }
  type State = {
    mode: str,
    send: str,
    outgoing: Receipt,
    form: Receipt,
    editor: str,
    consume: str,
    releaseRequested: bool,
    reopened: bool,
    reopenedEditor: str,
    offered: str,
  }

  var s: State

  pure val initialDraft: Receipt = { text: "draft", revision: 1, sending: false }
  pure val sendMark: Receipt = { ...initialDraft, revision: 2, sending: true }
  pure val reviewedForm: Receipt = { text: "form", revision: 1, sending: false }
  pure val consumedForm: Receipt = { ...reviewedForm, text: "", revision: 2 }

  action start(mode: str): bool = s' = {
    mode: mode, send: "ready", outgoing: initialDraft, form: reviewedForm,
    editor: "draft", consume: "idle", releaseRequested: false,
    reopened: false, reopenedEditor: "", offered: "",
  }

  action init = {
    nondet mode = Set("held", "queued", "separate").oneOf()
    start(mode)
  }

  // hold claims the send synchronously after its queue wait, before marking.
  action claimHold = all {
    s.send == "ready",
    s' = { ...s, send: "marking" },
  }

  action confirmMark = all {
    s.send == "marking",
    s.mode != "queued" or s.consume == "refused",
    s' = { ...s, send: "held", outgoing: sendMark },
  }

  // A held owner retains the marked row as the editor changes. In the
  // separate-key case, open restores the previously saved form.
  action prepareForm = all {
    s.mode != "queued",
    s.send == "held",
    s.editor == "draft",
    s' = { ...s, editor: "form" },
  }

  action consume = all {
    s.consume == "idle",
    if (s.mode == "queued") s.send == "marking"
      else s.send == "held" and s.editor == "form",
    s' = if (s.mode == "separate") {
      ...s, consume: "restoring", form: consumedForm,
    } else { ...s, consume: "refused" },
  }

  action openFreshController = all {
    s.mode == "held",
    s.send == "held" and s.consume == "refused",
    not(s.reopened),
    s' = {
      ...s, reopened: true,
      reopenedEditor: if (s.outgoing.sending) "" else s.outgoing.text,
      offered: if (s.outgoing.sending) s.outgoing.text else "",
    },
  }

  action requestRelease = all {
    not(s.releaseRequested),
    s.send == "held",
    if (s.mode == "held") s.consume == "refused"
      else s.mode == "separate" and s.consume == "restoring",
    s' = { ...s, releaseRequested: true },
  }

  action acknowledgeFormRestore = all {
    s.consume == "restoring",
    s' = { ...s, consume: "cleared", editor: "" },
  }

  action finishRelease = {
    val restored = if (s.mode == "held") "draft+form" else "draft"
    all {
      s.releaseRequested and s.send == "held",
      s.consume != "restoring",
      s' = {
        ...s, send: "released",
        outgoing: { text: restored, revision: 3, sending: false },
        editor: if (s.mode == "held") restored else s.editor,
      },
    }
  }

  action step = any {
    claimHold, confirmMark, prepareForm, consume, openFreshController,
    requestRelease, acknowledgeFormRestore, finishRelease, s' = s,
  }

  val HeldSendOwnsReceipt = and {
    s.send == "marking" implies s.outgoing == initialDraft,
    s.send == "held" implies s.outgoing == sendMark,
  }
  val SameKeyConsumeIsRefused =
    s.mode != "separate" implies Set("idle", "refused").contains(s.consume)
  val FreshControllerOffersMarkForReview =
    s.reopened implies s.reopenedEditor == "" and s.offered == "draft"
  val PendingRestoreBlocksRelease =
    s.consume == "restoring" implies
      s.send == "held" and s.form == consumedForm and s.editor == "form"
  val ReleasePreservesDrafts = s.send == "released" implies and {
    s.outgoing.revision == 3 and not(s.outgoing.sending),
    if (s.mode == "held")
      s.outgoing.text == "draft+form" and s.editor == "draft+form"
    else
      s.outgoing.text == "draft" and s.form == consumedForm and s.editor == "",
  }

  temporal RequestedReleaseSettles = always(
    s.releaseRequested implies eventually(s.send == "released")
  )
  temporal UnderFairRestoreAndRelease = and {
    weakFair(acknowledgeFormRestore, s),
    weakFair(finishRelease, s),
  } implies RequestedReleaseSettles

  run heldSendRetainsReceiptTest = start("held")
    .then(claimHold).then(confirmMark).then(prepareForm).then(consume)
    .then(openFreshController).expect(s.reopened and FreshControllerOffersMarkForReview)
    .then(requestRelease).then(finishRelease).expect(ReleasePreservesDrafts)

  run holdClaimsQueueFirstTest = start("queued")
    .then(claimHold).then(consume).expect(s.consume == "refused" and HeldSendOwnsReceipt)
    .then(confirmMark).expect(s.send == "held" and HeldSendOwnsReceipt)

  run separateFormAcknowledgesBeforeReleaseTest = start("separate")
    .then(claimHold).then(confirmMark).then(prepareForm).then(consume)
    .then(requestRelease).expect(PendingRestoreBlocksRelease and HeldSendOwnsReceipt)
    .then(acknowledgeFormRestore).then(finishRelease).expect(ReleasePreservesDrafts)
}
