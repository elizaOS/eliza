// Exact Photos Filter discovery and reviewed proposal receipt. The queue has
// one operation key and one execution attempt. Phone UI effects are external.
module DevicePhotosFilter {
  type Turn = NoPhone | Neither | Library | View | Photos
  type Proof = Exact | OtherInstallation | WrongDigest | StaleAttempt | MissingCapability
  type Count = { shown: int, more: bool }
  type Receipt = CountOnly(Count) | UnexpectedFields | Unconfirmed | NotApplied
  type Proposal = Absent | Pending | Approved | Dispatched | Uncertain | Done(Count) | Closed
  type State = { registered: bool, turn: Turn, offered: bool, checking: bool, proposal: Proposal }
  var s: State

  pure val Turns = Set(NoPhone, Neither, Library, View, Photos)
  pure val Proofs = Set(Exact, OtherInstallation, WrongDigest, StaleAttempt, MissingCapability)
  pure val Counts = Set(0, 1, 2).fold(Set(), (counts, shown) =>
    counts.union(Set(false, true).map(more => { shown: shown, more: more })))
  pure val Receipts = Counts.map(count => CountOnly(count)).union(Set(UnexpectedFields, Unconfirmed, NotApplied))

  pure def available(x: State): bool = x.registered and x.turn == Photos
  pure def hasCount(p: Proposal): bool = match p {
    | Done(_) => true
    | _ => false
  }

  action init = s' = { registered: false, turn: NoPhone, offered: false, checking: false, proposal: Absent }
  action register = all {
    not(s.registered),
    s' = { ...s, registered: true }
  }
  action bind(turn: Turn): bool = s' = { ...s, turn: turn, offered: false, checking: false }
  action discover = s' = { ...s, offered: available(s) }

  // The in-flight callback owns a check for this foreground turn only.
  // Rebinding drops that check even if the replacement supports Photos.
  action startSubmission(exactOperation: bool): bool = s' =
    if (available(s) and exactOperation and s.proposal == Absent)
      { ...s, checking: true }
    else s
  action commitSubmission = s' =
    if (s.checking) { ...s, checking: false, proposal: Pending }
    else s

  action decide(proof: Proof, approve: bool): bool = s' =
    if (proof == Exact and s.proposal == Pending)
      { ...s, proposal: if (approve) Approved else Closed }
    else s

  // Closed projects rejection and elapsed expiry. The stored row can still
  // say approved after its deadline, but it no longer authorizes a claim.
  action expire = all {
    s.proposal.in(Set(Pending, Approved)),
    s' = { ...s, proposal: Closed }
  }
  action claim(proof: Proof): bool = s' =
    if (proof == Exact and s.proposal == Approved)
      { ...s, proposal: Dispatched }
    else s

  action receipt(proof: Proof, candidate: Receipt): bool = s' =
    if (proof == Exact and s.proposal == Dispatched)
      match candidate {
        | CountOnly(count) => { ...s, proposal: Done(count) }
        | Unconfirmed => { ...s, proposal: Uncertain }
        | _ => s
      }
    else s

  action reconcile(proof: Proof, confirmed: bool, candidate: Receipt): bool = s' =
    if (proof == Exact and confirmed and s.proposal == Uncertain)
      match candidate {
        | CountOnly(count) => { ...s, proposal: Done(count) }
        | NotApplied => { ...s, proposal: Closed }
        | _ => s
      }
    else s

  action settlePending = any { decide(Exact, true), decide(Exact, false), expire }
  action deliverReceipt = {
    nondet count = Counts.oneOf()
    any { receipt(Exact, CountOnly(count)), receipt(Exact, Unconfirmed) }
  }

  action step = any {
    register, discover, commitSubmission, settlePending, deliverReceipt, s' = s,
    nondet turn = Turns.oneOf()
    bind(turn),
    nondet exactOperation = Set(false, true).oneOf()
    startSubmission(exactOperation),
    nondet proof = Proofs.oneOf()
    nondet candidate = Receipts.oneOf()
    nondet confirmed = Set(false, true).oneOf()
    any {
      decide(proof, confirmed), claim(proof), receipt(proof, candidate),
      reconcile(proof, confirmed, candidate)
    }
  }

  val DiscoveryRequiresDevice = s.offered implies available(s)
  val OnlyCurrentTurnCanCommit = s.checking implies (available(s) and s.proposal == Absent)
  val ProposalRequiresRegistration = s.proposal != Absent implies s.registered
  temporal NewProposalRequiresEligibleTurn = always((
    (s.proposal == Absent and next(s.proposal) != Absent)
      .implies(available(s))
  ).orKeep(s))
  temporal CountRequiresDispatch = always((
    (hasCount(next(s.proposal)) and not(hasCount(s.proposal)))
      .implies(s.proposal.in(Set(Dispatched, Uncertain)))
  ).orKeep(s))
  temporal TerminalRecordIsStable = always((
    (hasCount(s.proposal) or s.proposal == Closed)
      .implies(next(s.proposal) == s.proposal)
  ).orKeep(s))
  temporal PendingResolves = always((s.proposal == Pending).implies(eventually(s.proposal != Pending)))
  temporal ClaimedSettles = always((s.proposal == Dispatched).implies(eventually(s.proposal != Dispatched)))
  temporal UnderFairCommit = commitSubmission.weakFair(s).implies(
    always(s.checking.implies(eventually(not(s.checking)))))
  temporal UnderFairReview = settlePending.weakFair(s).implies(PendingResolves)
  temporal UnderFairReceipt = deliverReceipt.weakFair(s).implies(ClaimedSettles)

  run missingRegistrationAndCapabilitiesTest = init.then(bind(Photos)).then(discover)
    .then(startSubmission(true)).expect(not(s.offered) and s.proposal == Absent)
    .then(register).then(bind(Library)).then(discover).then(startSubmission(true))
    .expect(not(s.offered) and s.proposal == Absent)

  run discoveryAndRevocationTest = init.then(register).then(bind(Photos))
    .then(discover).expect(s.offered and s.proposal == Absent)
    .then(startSubmission(true)).then(bind(NoPhone)).then(bind(Photos))
    .then(commitSubmission).expect(not(s.offered) and s.proposal == Absent)

  run reviewedReceiptAndReplayTest = init.then(register).then(bind(Photos)).then(discover)
    .then(startSubmission(false)).expect(s.proposal == Absent)
    .then(startSubmission(true)).then(commitSubmission).then(claim(Exact)).then(decide(OtherInstallation, true))
    .expect(s.proposal == Pending).then(decide(Exact, true)).then(claim(Exact))
    .then(receipt(Exact, UnexpectedFields))
    .then(receipt(StaleAttempt, CountOnly({ shown: 2, more: false })))
    .expect(s.proposal == Dispatched)
    .then(receipt(Exact, CountOnly({ shown: 2, more: false })))
    .then(receipt(Exact, CountOnly({ shown: 1, more: false })))
    .then(startSubmission(true)).then(commitSubmission).then(claim(Exact)).expect(s.proposal == Done({ shown: 2, more: false }))

  run explicitOutcomeReviewTest = init.then(register).then(bind(Photos))
    .then(startSubmission(true)).then(commitSubmission).then(decide(Exact, true)).then(claim(Exact)).then(receipt(Exact, Unconfirmed))
    .then(claim(Exact)).then(reconcile(Exact, false, CountOnly({ shown: 0, more: false })))
    .expect(s.proposal == Uncertain)
    .then(reconcile(Exact, true, CountOnly({ shown: 0, more: false })))
    .expect(s.proposal == Done({ shown: 0, more: false }))

  run elapsedApprovalCannotClaimTest = init.then(register).then(bind(Photos))
    .then(startSubmission(true)).then(commitSubmission).then(decide(Exact, true)).then(expire).then(claim(Exact))
    .expect(s.proposal == Closed)
}
