// Device approval HTTP contract. The SQL queue owns these transitions. The
// generic approval list has no device authority and hides these records.
module api_approvals {
  type Phase = Pending | Approved | Rejected | Expired | Dispatched | Uncertain |
    AppliedByReceipt | AppliedByReview | ConfirmedNotApplied
  type Binding = Exact | Foreign | WrongDigest
  type Reply = Idle | Refused | Accepted | Permit | Lost | Hidden
  type State = { phase: Phase, deadlineReached: bool, claims: int, reply: Reply }
  var s: State

  pure val Bindings = Set(Exact, Foreign, WrongDigest)
  pure val Outcomes = Set(AppliedByReceipt, AppliedByReview, ConfirmedNotApplied)
  pure val Terminal = Outcomes.union(Set(Rejected, Expired))

  action init = s' = { phase: Pending, deadlineReached: false, claims: 0, reply: Idle }
  action decide(binding: Binding, approved: bool): bool = s' = {
    val target = if (approved) Approved else Rejected
    if (binding == Exact and (s.phase == target or (s.phase == Pending and not(s.deadlineReached))))
      { ...s, phase: target, reply: Accepted }
    else { ...s, reply: Refused }
  }
  action deadline = s' = { ...s, deadlineReached: true }
  action purgePending = all {
    s.phase == Pending and s.deadlineReached,
    s' = { ...s, phase: Expired, reply: Idle }
  }
  action claim(binding: Binding, responseLost: bool): bool = s' =
    if (binding == Exact and s.phase == Approved and not(s.deadlineReached))
      // One database transaction owns both the claim and the dispatch mark.
      { ...s, phase: Dispatched, claims: s.claims + 1, reply: if (responseLost) Lost else Permit }
    else { ...s, reply: Refused }
  action receipt(binding: Binding, attemptMatches: bool, applied: bool, sameReceipt: bool): bool = s' =
    if (binding != Exact or not(attemptMatches)) { ...s, reply: Refused }
    else if (s.phase == Dispatched)
      { ...s, phase: if (applied) AppliedByReceipt else Uncertain, reply: Accepted }
    else if (sameReceipt and ((s.phase.in(Set(AppliedByReceipt, AppliedByReview)) and applied) or (s.phase == Uncertain and not(applied))))
      { ...s, reply: Accepted }
    else { ...s, reply: Refused }
  action reconcile(binding: Binding, attemptMatches: bool, confirmed: bool, applied: bool, sameReceipt: bool): bool = s' = {
    val target = if (applied) AppliedByReview else ConfirmedNotApplied
    if (binding == Exact and attemptMatches and confirmed and (s.phase == Uncertain or (sameReceipt and s.phase == target)))
      { ...s, phase: target, reply: Accepted }
    else { ...s, reply: Refused }
  }

  action readAggregate = s' = { ...s, reply: Hidden }
  action restart = s' = { ...s, reply: Idle }
  action deviceReceipt = {
    nondet applied = Set(false, true).oneOf()
    all { s.phase == Dispatched, receipt(Exact, true, applied, false) }
  }
  action confirmedReview = {
    nondet applied = Set(false, true).oneOf()
    all { s.phase == Uncertain, reconcile(Exact, true, true, applied, false) }
  }
  action step = any {
    s' = s,
    deadline,
    purgePending,
    readAggregate,
    restart,
    {
      nondet binding = Bindings.oneOf()
      nondet choice = Set(false, true).oneOf()
      any {
        decide(binding, choice),
        claim(binding, choice),
        {
          nondet attemptMatches = Set(false, true).oneOf()
          nondet sameReceipt = Set(false, true).oneOf()
          any {
            receipt(binding, attemptMatches, choice, sameReceipt),
            {
              nondet confirmed = Set(false, true).oneOf()
              reconcile(binding, attemptMatches, confirmed, choice, sameReceipt)
            }
          }
        }
      }
    }
  }

  val AtMostOneClaim = s.claims.in(Set(0, 1))
  val DispatchPrecedesReceipt = s.phase.in(Outcomes.union(Set(Dispatched, Uncertain))) implies s.claims == 1
  val PermitRequiresCommittedDispatch = s.reply == Permit implies (s.phase == Dispatched and s.claims == 1)

  temporal ClaimCommitsDispatch = always((
    (next(s.claims) > s.claims).implies(s.phase == Approved and not(s.deadlineReached) and next(s.phase) == Dispatched)
  ).orKeep(s))
  temporal TerminalRecordIsStable = always((
    s.phase.in(Terminal).implies(next(s.phase) == s.phase and next(s.claims) == s.claims)
  ).orKeep(s))
  temporal RefusalsKeepDurableState = always((
    (next(s.reply) == Refused).implies(next(s.phase) == s.phase and next(s.claims) == s.claims)
  ).orKeep(s))
  temporal DispatchClassified = (s.phase == Dispatched).leadsTo(s.phase != Dispatched)
  temporal UnderFairDeviceReceipt = deviceReceipt.weakFair(s).implies(DispatchClassified)
  temporal UnderFairConfirmedReview = confirmedReview.weakFair(s).implies((s.phase == Uncertain).leadsTo(s.phase != Uncertain))

  run ConsentAndGenericListDoNotDispatchTest = init.then(decide(Exact, true)).then(readAggregate)
    .expect(s.phase == Approved and s.claims == 0 and s.reply == Hidden)
  run ExpiredApprovalCannotDispatchTest = init.then(decide(Exact, true)).then(deadline)
    .then(claim(Exact, false)).expect(s.phase == Approved and s.claims == 0 and s.reply == Refused)
  run LostClaimReplyCannotRedispatchTest = init.then(decide(Exact, true)).then(claim(Exact, true)).then(restart)
    .then(claim(Exact, false)).expect(s.phase == Dispatched and s.claims == 1 and s.reply == Refused)
  run WrongBindingAndAttemptCannotSettleTest = init.then(decide(Exact, true)).then(claim(Exact, false))
    .then(receipt(Foreign, true, true, false)).expect(s.phase == Dispatched and s.reply == Refused)
    .then(receipt(Exact, false, true, false)).expect(s.phase == Dispatched and s.reply == Refused)
  run ConfirmedNonDeliveryCannotClaimAgainTest = init.then(decide(Exact, true)).then(claim(Exact, false))
    .then(receipt(Exact, true, false, false)).then(reconcile(Exact, true, false, false, false))
    .expect(s.phase == Uncertain and s.reply == Refused)
    .then(reconcile(Exact, true, true, false, false)).then(claim(Exact, false))
    .expect(s.phase == ConfirmedNotApplied and s.claims == 1 and s.reply == Refused)
  run ExactReceiptReplayKeepsOneClaimTest = init.then(decide(Exact, true)).then(claim(Exact, false))
    .then(receipt(Exact, true, true, false)).then(receipt(Exact, true, true, true))
    .expect(s.phase == AppliedByReceipt and s.claims == 1 and s.reply == Accepted)
    .then(receipt(Exact, true, true, false))
    .expect(s.phase == AppliedByReceipt and s.claims == 1 and s.reply == Refused)
}
