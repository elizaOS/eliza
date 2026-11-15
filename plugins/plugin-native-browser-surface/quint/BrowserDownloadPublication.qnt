// Final publication of one host-owned Android download after review.
module BrowserDownloadPublication {
  type State = { phase: str, entry: bool, pending: bool,
    cancellationWon: bool, publicationWon: bool, published: bool, saved: bool }
  var s: State
  action init = s' = { phase: "copying", entry: true, pending: true,
    cancellationWon: false, publicationWon: false, published: false, saved: false }
  action copied = all {
    s.phase == "copying", s' = { ...s, phase: "ready" }
  }
  action claim = all {
    s.phase == "ready", s' = { ...s, phase: "publishing", publicationWon: true }
  }
  action removeEntry = {
    val wins = Set("copying", "ready").contains(s.phase)
    s' = { ...s, entry: false, cancellationWon: s.cancellationWon or wins,
      phase: if (wins) "cancelled" else s.phase }
  }
  action cleanup = all {
    s.phase == "cancelled", s.pending, s' = { ...s, pending: false }
  }
  action failCopy = all {
    Set("copying", "ready").contains(s.phase), s' = { ...s, phase: "failed", pending: false }
  }
  action providerResult(success: bool): bool = all {
    s.phase == "publishing", s' = { ...s, pending: false, published: success, saved: success,
      phase: if (success) "saved" else "failed" }
  }
  action committedWithoutReceipt = all {
    s.phase == "publishing", s' = { ...s, pending: false, published: true, phase: "unconfirmed" }
  }
  action providerSettles = any {
    providerResult(true), providerResult(false), committedWithoutReceipt
  }
  action step = any {
    copied, claim, removeEntry, cleanup, failCopy, providerSettles, s' = s
  }

  val ExclusiveAdmission = not(s.cancellationWon and s.publicationWon)
  val CancellationHasNoReceipt = s.cancellationWon implies not(s.entry or s.published or s.saved)
  val SavedRequiresPublication = s.saved implies (s.publicationWon and s.published and s.phase == "saved" and not(s.pending))
  val FailureHasNoReceipt = (s.phase == "failed") implies not(s.published or s.saved or s.pending)
  val UnconfirmedPreservesFile = (s.phase == "unconfirmed") implies s.publicationWon and s.published and not(s.saved)
  temporal DecidedTransferSettles = (cleanup.weakFair(s) and providerSettles.weakFair(s)).implies(
    always((s.phase == "cancelled" or s.phase == "publishing").implies(eventually(not(s.pending)))))

  run cancellationAtEofTest = init.then(copied).then(removeEntry).then(cleanup)
    .expect(s.cancellationWon and not(s.publicationWon or s.pending or s.saved or s.entry))
  run cancelDuringCopyTest = init.then(removeEntry).then(cleanup)
    .expect(s.cancellationWon and not(s.pending or s.saved or s.entry))
  run admittedBeforeRemovalTest = init.then(copied).then(claim).then(removeEntry)
    .then(providerResult(true)).expect(s.saved and s.publicationWon and not(s.entry or s.cancellationWon))
  run savedBeforeRemovalTest = init.then(copied).then(claim).then(providerResult(true))
    .then(removeEntry).expect(s.saved and not(s.entry))
  run updateFailureTest = init.then(copied).then(claim).then(providerResult(false))
    .expect(s.phase == "failed" and not(s.pending or s.saved))
  run committedWithoutReceiptTest = init.then(copied).then(claim).then(committedWithoutReceipt)
    .then(removeEntry).expect(s.published and not(s.saved or s.pending or s.entry))
  run copyFailureTest = init.then(failCopy).expect(s.phase == "failed" and not(s.pending or s.saved))
}
