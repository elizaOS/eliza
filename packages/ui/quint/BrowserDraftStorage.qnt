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

// Two tabs open one unmarked draft before either starts writing. The first
// successful CAS takes the initial receipt. The losing controller must recover
// independently while the winning send or form restore is still pending.
module BrowserDraftCrossTabClaims {
  type Document = {
    documentRevision: int, draftRevision: int, text: str, sending: bool,
  }
  type State = {
    document: Document,
    send: str,
    consume: str,
    senderText: str,
    formText: str,
    formOffer: str,
  }

  var s: State

  pure val original: Document = {
    documentRevision: 1, draftRevision: 1, text: "draft", sending: false,
  }
  pure val marked: Document = {
    ...original, documentRevision: 2, draftRevision: 2, sending: true,
  }
  pure val cleared: Document = {
    ...original, documentRevision: 2, draftRevision: 2, text: "",
  }
  pure val released: Document = { ...original, documentRevision: 3, draftRevision: 3 }
  pure val confirmed: Document = { ...released, documentRevision: 4 }

  action init = s' = {
    document: original, send: "ready", consume: "ready",
    senderText: "draft", formText: "draft", formOffer: "",
  }

  action attemptHold = all {
    s.send == "ready",
    s' = if (s.document == original) {
      ...s, document: marked, send: "held", senderText: "",
    } else { ...s, send: "refused" },
  }

  action attemptConsume = all {
    s.consume == "ready",
    s' = if (s.document == original) {
      ...s, document: cleared, consume: "restoring",
    } else { ...s, consume: "unsettled", formOffer: s.document.text },
  }

  action acknowledgeClear = all {
    s.consume == "restoring" and s.send == "refused",
    s' = { ...s, consume: "cleared", formText: "" },
  }

  action release = all {
    s.send == "held" and s.consume == "unsettled",
    s' = { ...s, document: released, send: "released", senderText: "draft" },
  }

  // The stale consume's failed receipt still needs review even when the
  // released copy and the form editor now hold identical text.
  action retry = all {
    s.send == "released" and s.consume == "unsettled",
    s' = { ...s, consume: "retained" },
  }

  // keepCurrent performs a new CAS. The unmarked draft bytes stay identical,
  // while IndexedDB publishes a fresh document revision for the confirmation.
  action confirm = all {
    s.consume == "retained",
    s' = { ...s, document: confirmed, consume: "confirmed" },
  }

  action step = any {
    attemptHold, attemptConsume, acknowledgeClear, release, retry, confirm,
    s' = s,
  }

  val InitialReceiptHasOneWinner = not(
    Set("held", "released").contains(s.send) and
      Set("restoring", "cleared").contains(s.consume)
  )

  val StaleConsumePreservesMarkedReceipt = and {
    s.send == "held" implies s.document == marked,
    s.consume == "unsettled" implies s.formOffer == "draft" and s.formText == "draft",
  }

  val StaleHoldPreservesClearReceipt = and {
    Set("restoring", "cleared").contains(s.consume) implies s.document == cleared,
    s.send == "refused" implies s.senderText == "draft",
  }

  val RecoveryRequiresConfirmation = and {
    s.consume == "retained" implies s.document == released and s.formOffer == "draft",
    s.consume == "confirmed" implies s.document == confirmed and s.formText == "draft",
  }

  temporal StartedOperationsReachOutcome = always(
    (s.send != "ready" or s.consume != "ready") implies eventually(
      s.consume == "confirmed" or (s.consume == "cleared" and s.send == "refused")
    )
  )

  temporal UnderFairCrossTabRecovery = and {
    weakFair(attemptHold, s), weakFair(attemptConsume, s),
    weakFair(acknowledgeClear, s), weakFair(release, s), weakFair(retry, s),
    weakFair(confirm, s),
  } implies StartedOperationsReachOutcome

  run markWinsThenConsumeNeedsReviewTest = init
    .then(attemptHold).then(attemptConsume)
    .expect(s.consume == "unsettled" and StaleConsumePreservesMarkedReceipt)
    .then(release).then(retry).expect(s.consume == "retained" and RecoveryRequiresConfirmation)
    .then(confirm).expect(s.consume == "confirmed" and RecoveryRequiresConfirmation)

  run clearWinsBeforeHostAcknowledgementTest = init
    .then(attemptConsume).then(attemptHold)
    .expect(s.consume == "restoring" and s.send == "refused" and StaleHoldPreservesClearReceipt)
    .then(acknowledgeClear).expect(s.formText == "" and StaleHoldPreservesClearReceipt)
}

// A known non-dispatch releases one held draft. Closing the old page loses its
// editor and host acknowledgement state. A new browser reads the same profile.
module BrowserDraftReleaseReload {
  type Receipt = { revision: int, text: str, sending: bool }
  type State = {
    phase: str,
    saved: Receipt,
    editor: str,
    offered: str,
    restartFrom: str,
  }

  var s: State

  pure val mark: Receipt = { revision: 1, text: "draft", sending: true }
  pure val released: Receipt = { revision: 2, text: "draft+newer", sending: false }
  pure val reviewed: Receipt = { revision: 2, text: "draft", sending: false }

  action init = s' = {
    phase: "held", saved: mark, editor: "newer", offered: "", restartFrom: "none",
  }

  action requestRelease = all {
    s.phase == "held",
    s' = { ...s, phase: "restoring" },
  }

  action applyHostRestore = all {
    s.phase == "restoring",
    s' = { ...s, phase: "applied", editor: "draft+newer" },
  }

  action acknowledgeHostRestore = all {
    s.phase == "applied",
    s' = { ...s, phase: "writing" },
  }

  // Abstract the successful queued write and its receipt as one step.
  action confirmRelease = all {
    s.phase == "writing",
    s' = { ...s, phase: "confirmed", saved: released },
  }

  action closePage = all {
    Set("applied", "confirmed").contains(s.phase),
    s' = { ...s, phase: "closed", editor: "", restartFrom: s.phase },
  }

  action reopen = all {
    s.phase == "closed",
    s' = if (s.saved.sending) {
      ...s, phase: "review", offered: s.saved.text,
    } else { ...s, phase: "opened", editor: s.saved.text },
  }

  action chooseSaved = all {
    s.phase == "review",
    s' = { ...s, phase: "review-writing", editor: s.offered },
  }

  action confirmReviewedCopy = all {
    s.phase == "review-writing",
    s' = { ...s, phase: "reviewed", saved: reviewed, offered: "" },
  }

  action reloadReviewed = all {
    s.phase == "reviewed",
    s' = { ...s, phase: "opened", editor: s.saved.text },
  }

  action step = any {
    requestRelease, applyHostRestore, acknowledgeHostRestore, confirmRelease,
    closePage, reopen, chooseSaved, confirmReviewedCopy, reloadReviewed, s' = s,
  }

  val UnconfirmedReleaseRetainsMark = and {
    Set("held", "restoring", "applied", "writing").contains(s.phase) implies s.saved == mark,
    s.restartFrom == "applied" and Set("closed", "review", "review-writing").contains(s.phase)
      implies s.saved == mark,
  }

  val MarkedReloadOffersReview = s.phase == "review" implies and {
    s.saved == mark, s.editor == "", s.offered == mark.text,
  }

  val ConfirmedReleaseSurvivesReload = and {
    s.phase == "confirmed" or s.restartFrom == "confirmed" implies s.saved == released,
    s.phase == "opened" and s.restartFrom == "confirmed" implies s.editor == released.text,
  }

  val ReviewedCopyHasNewReceipt = and {
    s.phase == "reviewed" or (s.phase == "opened" and s.restartFrom == "applied")
      implies s.saved == reviewed and s.editor == reviewed.text,
    s.phase == "closed" implies s.editor == "",
  }

  temporal PendingWorkReachesReceiptOrClosure = and {
    Set("restoring", "applied", "writing").contains(s.phase)
      .leadsTo(Set("confirmed", "closed").contains(s.phase)),
    (s.phase == "closed").leadsTo(Set("review", "opened").contains(s.phase)),
    (s.phase == "review-writing").leadsTo(s.phase == "reviewed"),
  }

  temporal UnderFairRestoreWritesAndReopen = and {
    applyHostRestore.weakFair(s), acknowledgeHostRestore.weakFair(s),
    confirmRelease.weakFair(s), reopen.weakFair(s), confirmReviewedCopy.weakFair(s),
  } implies PendingWorkReachesReceiptOrClosure

  run UnacknowledgedRestoreNeedsReviewTest = init
    .then(requestRelease).then(applyHostRestore)
    .expect(s.editor == "draft+newer" and UnconfirmedReleaseRetainsMark)
    .then(closePage).then(reopen).expect(s.phase == "review" and MarkedReloadOffersReview)
    .then(chooseSaved).then(confirmReviewedCopy).then(reloadReviewed)
    .expect(s.phase == "opened" and ReviewedCopyHasNewReceipt)

  run ConfirmedReleaseRestoresMergedDraftTest = init
    .then(requestRelease).then(applyHostRestore).then(acknowledgeHostRestore)
    .then(confirmRelease).then(closePage).then(reopen)
    .expect(s.phase == "opened" and ConfirmedReleaseSurvivesReload)
}
