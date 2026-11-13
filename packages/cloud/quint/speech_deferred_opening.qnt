// SpeechRelayCoordinator's proof-version-1 deferred import/retirement boundary.
// One minted capability, one public socket and one opening claim. Storage calls
// settle atomically here; unknown commit acknowledgements require another model.
// Leaving the revocation fence before stop exits to the separately unmodeled
// admission/provider region. No money/provider cleanup is inferred from absence.
module speech_deferred_opening {
  type State = { ledger: str, generation: int, upgrade: str, opening: str, closing: str }
  var s: State
  val stopped = s.closing != "idle"
  val allocated = Set("accepted", "closed").contains(s.upgrade)
  val openingSettled = Set("idle", "unclaimed", "settled").contains(s.opening)
  val confirmed = s.closing == "done"
  val proofMode = if (not(confirmed)) "unconfirmed"
    else if (s.opening == "settled") "not_dispatched" else "never_started"
  action init = s' = { ledger: "minted", generation: 0, upgrade: "importing", opening: "idle", closing: "idle" }

  action upgradeImportDone = all {
    s.upgrade == "importing",
    s' = s.with("upgrade", if (stopped or s.ledger != "minted") "refused" else "accepted")
  }
  action upgradeImportFailed = all { s.upgrade == "importing", s' = s.with("upgrade", "refused") }
  action hello = all {
    not(stopped), s.upgrade == "accepted", s.opening == "idle",
    s' = s.with("opening", "claiming")
  }
  action claimDone = all {
    s.opening == "claiming",
    s' = if (s.ledger == "minted") s.with("ledger", "starting").with("generation", 1).with("opening", "importing")
      else s.with("opening", "unclaimed")
  }
  action claimFailed = all { s.opening == "claiming", s' = s.with("opening", "unclaimed") }
  action openingImportDone = all {
    s.opening == "importing",
    s' = s.with("opening", if (stopped) "settled" else "fencing")
  }
  action openingImportFailed = all { s.opening == "importing", s' = s.with("opening", "settled") }
  action fenceDone = all {
    s.opening == "fencing",
    s' = s.with("opening", if (stopped) "settled" else "outside")
  }
  action fenceFailed = all { s.opening == "fencing", s' = s.with("opening", "settled") }

  action stop = all {
    not(stopped), s.opening != "outside",
    s' = s.with("closing", "importing")
  }
  action closeImportDone = all { s.closing == "importing", s' = s.with("closing", "marking") }
  action closeImportFailed = all { s.closing == "importing", s' = s.with("closing", "failed") }
  action markRetiring = all {
    s.closing == "marking",
    s' = s.with("ledger", "retiring").with("generation", s.generation + 1).with("closing", "joining")
      .with("upgrade", if (s.upgrade == "accepted") "closed" else s.upgrade)
  }
  action markFailed = all { s.closing == "marking", s' = s.with("closing", "failed") }
  action joinOpening = all {
    s.closing == "joining", openingSettled,
    s' = s.with("closing", "committing")
  }
  action commitProof = all { s.closing == "committing", s' = s.with("ledger", "closed").with("closing", "done") }
  action commitFailed = all { s.closing == "committing", s' = s.with("closing", "failed") }
  action step = any {
    upgradeImportDone, upgradeImportFailed, hello, claimDone, claimFailed,
    openingImportDone, openingImportFailed, fenceDone, fenceFailed, stop,
    closeImportDone, closeImportFailed, markRetiring, markFailed, joinOpening,
    commitProof, commitFailed, s' = s
  }

  val TypeOK = and {
    Set("minted", "starting", "retiring", "closed").contains(s.ledger),
    s.generation >= 0, s.generation <= 2,
    Set("importing", "accepted", "refused", "closed").contains(s.upgrade),
    Set("idle", "claiming", "importing", "fencing", "unclaimed", "settled", "outside").contains(s.opening),
    Set("idle", "importing", "marking", "joining", "committing", "done", "failed").contains(s.closing)
  }
  val ConfirmationJoinsOpening = confirmed implies (openingSettled and s.ledger == "closed")
  val ClaimedProofKeepsOriginalGeneration = (confirmed and s.opening == "settled") implies s.generation == 2
  val NeverStartedHasNoClaim = proofMode == "never_started" implies s.generation == 1
  temporal NoLateSocketAllocation = always((stopped and not(allocated) implies
    not(Set("accepted", "closed").contains(next(s.upgrade)))).orKeep(s))
  temporal NoAdmissionAfterStop = always((stopped and s.opening != "outside" implies next(s.opening) != "outside").orKeep(s))
  temporal ClosedLedgerIsFinal = always((s.ledger == "closed" implies next(s.ledger) == "closed").orKeep(s))
  temporal CompletionFairness = and {
    any { claimDone, claimFailed }.weakFair(s),
    any { openingImportDone, openingImportFailed }.weakFair(s),
    any { fenceDone, fenceFailed }.weakFair(s),
    any { closeImportDone, closeImportFailed }.weakFair(s),
    any { markRetiring, markFailed }.weakFair(s), joinOpening.weakFair(s),
    any { commitProof, commitFailed }.weakFair(s)
  }
  temporal FairCloseSettles = CompletionFairness implies always(stopped implies eventually(Set("done", "failed").contains(s.closing)))
  temporal UnfairCloseSettles = always(stopped implies eventually(Set("done", "failed").contains(s.closing)))

  run lateUpgradeImportCannotAllocateTest = init.then(stop).then(closeImportDone).then(markRetiring)
    .then(joinOpening).then(commitProof).then(upgradeImportDone)
    .expect(s.upgrade == "refused" and proofMode == "never_started")
  run claimedOpeningIsJoinedBeforeProofTest = init.then(upgradeImportDone).then(hello).then(claimDone)
    .then(stop).then(closeImportDone).then(markRetiring)
    .expect(not(openingSettled) and not(confirmed))
    .then(openingImportDone).expect(s.opening == "settled").then(joinOpening).then(commitProof)
    .expect(proofMode == "not_dispatched" and s.generation == 2)
  run retiredClaimCannotBeReusedTest = init.then(upgradeImportDone).then(hello).then(stop)
    .then(closeImportDone).then(markRetiring).then(claimDone).then(joinOpening).then(commitProof)
    .expect(proofMode == "never_started" and s.opening == "unclaimed")
  run failedCloseImportNeverConfirmsTest = init.then(stop).then(closeImportFailed).then(upgradeImportDone)
    .expect(s.ledger == "minted" and not(confirmed) and s.upgrade == "refused")
}
