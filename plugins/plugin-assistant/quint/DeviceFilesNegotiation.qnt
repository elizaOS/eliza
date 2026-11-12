// Per-request Files capability over one authenticated enrollment. The
// maintained approval queue owns the proposal; Files transport does not
// grant review or prove a storage effect.
module DeviceFilesNegotiation {
  type Caller = SessionOwner | GatewayOwner | RetiredTurn | Other
  type Header = Legacy | Files | Malformed
  type Request = Advertise | Register | Poll | Propose | Approve | Claim | Receipt | Revoke
  type Enrollment = Unregistered | Live | Revoked
  type Proposal = Absent | Pending | Approved | Dispatched | Done
  type Reply = Idle | Refused | Advertised | Hidden | Visible | Accepted
  type State = { enrollment: Enrollment, proposal: Proposal, reply: Reply }
  var s: State

  pure val Callers = Set(SessionOwner, GatewayOwner, RetiredTurn, Other)
  pure val Headers = Set(Legacy, Files, Malformed)
  pure val Writes = Set(Propose, Approve, Claim, Receipt)
  pure val Requests = Writes.union(Set(Advertise, Register, Poll, Revoke))

  action init = s' = { enrollment: Unregistered, proposal: Absent, reply: Idle }
  action route(caller: Caller, header: Header, request: Request): bool = s' = {
    val refused = { ...s, reply: Refused }
    val accepted = { ...s, reply: Accepted }
    if (caller.in(Set(Other, RetiredTurn)) or header == Malformed) refused
    else if (Writes.contains(request) and (s.enrollment != Live or header != Files)) refused
    else match request {
      | Advertise =>
        if (caller == GatewayOwner) { ...s, reply: Advertised }
        else refused
      | Register =>
        if (s.enrollment == Revoked) refused
        else { ...s, enrollment: Live, reply: Advertised }
      | Revoke =>
        if (s.enrollment == Live) { ...accepted, enrollment: Revoked }
        else refused
      | Poll =>
        if (s.enrollment != Live) refused
        else { ...s, reply: if (header == Files and s.proposal != Absent) Visible else Hidden }
      | Propose =>
        if (s.proposal == Absent)
          { ...accepted, proposal: Pending }
        else refused
      | Approve =>
        if (s.proposal == Pending)
          { ...accepted, proposal: Approved }
        else refused
      | Claim =>
        if (s.proposal == Approved)
          { ...accepted, proposal: Dispatched }
        else refused
      | Receipt =>
        if (s.proposal == Dispatched)
          { ...accepted, proposal: Done }
        else refused
    }
  }
  action step = any {
    s' = s,
    {
      nondet caller = Callers.oneOf()
      nondet header = Headers.oneOf()
      nondet request = Requests.oneOf()
      route(caller, header, request)
    }
  }

  action legacyPoll = route(SessionOwner, Legacy, Poll)
  action filesPoll = route(SessionOwner, Files, Poll)
  action legacyWrite = {
    nondet request = Writes.oneOf()
    route(SessionOwner, Legacy, request)
  }
  action invalidRequest = {
    nondet caller = Callers.oneOf()
    nondet header = Headers.oneOf()
    nondet request = Requests.oneOf()
    all { caller.in(Set(Other, RetiredTurn)) or header == Malformed, route(caller, header, request) }
  }

  val ProposalNeedsEnrollment = s.proposal != Absent implies s.enrollment != Unregistered
  val VisibilityNeedsLiveEnrollment = s.reply == Visible implies
    (s.enrollment == Live and s.proposal != Absent)
  temporal LegacyCannotSeeFiles = always((legacyPoll.implies(next(s.reply) != Visible)).orKeep(s))
  temporal LegacyCannotChangeFiles = always((legacyWrite.implies(next(s.proposal) == s.proposal)).orKeep(s))
  temporal InvalidRequestCannotChangeAuthority = always((
    invalidRequest.implies(next(s.enrollment) == s.enrollment and next(s.proposal) == s.proposal)
  ).orKeep(s))
  temporal RevocationRetainsProposal = always((
    (s.enrollment == Revoked).implies(next(s.enrollment) == Revoked and next(s.proposal) == s.proposal)
  ).orKeep(s))
  temporal VisibleOrRevoked = always((
    (s.enrollment == Live and s.proposal != Absent)
      .implies(eventually(s.reply == Visible or s.enrollment == Revoked))
  ))
  temporal UnderFairFilesPolling = filesPoll.weakFair(s).implies(VisibleOrRevoked)

  run OnlyVerifiedGatewayAdvertisesTest = init.then(route(SessionOwner, Legacy, Advertise))
    .expect(s.reply == Refused and s.enrollment == Unregistered)
    .then(route(GatewayOwner, Legacy, Advertise))
    .expect(s.reply == Advertised and s.enrollment == Unregistered)

  run ExistingEnrollmentNegotiatesWithoutReenrollingTest = init.then(route(SessionOwner, Legacy, Register))
    .expect(s.reply == Advertised and s.enrollment == Live)
    .then(route(SessionOwner, Malformed, Register))
    .expect(s.reply == Refused and s.enrollment == Live)
    .then(route(SessionOwner, Files, Register))
    .expect(s.reply == Advertised and s.enrollment == Live)

  run CapabilityGatesTheReviewedFilesPathTest = init.then(route(SessionOwner, Legacy, Register))
    .then(route(SessionOwner, Legacy, Propose))
    .then(route(RetiredTurn, Files, Propose)).expect(s.proposal == Absent)
    .then(route(SessionOwner, Files, Propose)).then(legacyPoll)
    .expect(s.reply == Hidden and s.proposal == Pending)
    .then(filesPoll).expect(s.reply == Visible)
    .then(route(SessionOwner, Files, Claim))
    .then(route(SessionOwner, Legacy, Approve)).expect(s.proposal == Pending)
    .then(route(SessionOwner, Files, Approve))
    .then(route(SessionOwner, Legacy, Claim)).expect(s.proposal == Approved)
    .then(route(SessionOwner, Files, Claim))
    .then(route(SessionOwner, Legacy, Receipt)).expect(s.proposal == Dispatched)
    .then(route(SessionOwner, Files, Receipt))
    .then(route(SessionOwner, Files, Claim)).expect(s.proposal == Done)

  run RevocationFencesReadsAndEffectsTest = init.then(route(SessionOwner, Files, Register))
    .then(route(SessionOwner, Files, Propose)).then(route(SessionOwner, Legacy, Revoke))
    .then(route(SessionOwner, Files, Approve)).then(filesPoll)
    .expect(s.enrollment == Revoked and s.reply == Refused and s.proposal == Pending)
}
