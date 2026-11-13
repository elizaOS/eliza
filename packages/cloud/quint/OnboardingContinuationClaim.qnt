// Continuation token shard in OnboardingSessionCoordinator. Session binding
// is a separate authorized operation observed by the token's coordinator.
module OnboardingContinuationClaim {
  type Request = { lineage: int, phone: int, account: int, telegramMatches: bool }
  type State = {
    trusted: bool,
    age: int,
    boundAccount: int,
    lineage: int,
    phone: int,
    pinnedAccount: int,
    result: str,
    request: Request
  }
  var s: State

  pure def request(lineage: int, phone: int, account: int, matches: bool): Request = {
    lineage: lineage, phone: phone, account: account, telegramMatches: matches
  }
  pure def initial(trusted: bool): State = {
    trusted: trusted, age: 0, boundAccount: 0, lineage: 0, phone: 0,
    pinnedAccount: 0, result: "idle", request: request(0, 0, 0, false)
  }
  action init = {
    nondet trusted = Set(true, false).oneOf()
    s' = initial(trusted)
  }
  action trustedInit = s' = initial(true)

  pure def matchesClaim(x: State, req: Request): bool =
    x.lineage != 0 and x.lineage == req.lineage and x.phone == req.phone and
    (x.pinnedAccount == 0 or x.pinnedAccount == req.account) and req.telegramMatches

  pure def claimPermitted(x: State, req: Request): bool =
    x.trusted and x.age < 2 and req.telegramMatches and
    (x.boundAccount == 0 or x.boundAccount == req.account)

  pure def clearClaim(x: State): State = { ...x, lineage: 0, phone: 0, pinnedAccount: 0 }

  action claim(req: Request): bool = {
    val attempted = { ...s, request: req }
    val same = matchesClaim(s, req)
    s' = if (not(claimPermitted(s, req))) { ...attempted, result: "denied" }
      else if (s.lineage != 0 and not(same)) { ...attempted, result: "conflict" }
      else if (s.boundAccount != 0) { ...clearClaim(attempted), result: "replayed" }
      else { ...attempted, lineage: req.lineage, phone: req.phone,
        pinnedAccount: if (s.pinnedAccount != 0) s.pinnedAccount else req.account,
        result: "acquired" }
  }

  // Represents account publication by the trusted external redemption flow.
  // An authorized redemption already in flight may publish after expiry.
  action bind(account: int): bool = all {
    s.lineage != 0,
    s.boundAccount == 0,
    s.pinnedAccount == 0 or s.pinnedAccount == account,
    s' = { ...s, boundAccount: account, result: "bound" }
  }

  action complete(req: Request): bool = {
    val attempted = { ...s, request: req }
    s' = if (matchesClaim(s, req) and s.boundAccount != 0 and s.boundAccount == req.account)
      { ...clearClaim(attempted), result: "completed" }
      else { ...attempted, result: "conflict" }
  }

  action exactCleanup = all {
    s.boundAccount != 0,
    s.lineage != 0,
    complete(request(s.lineage, s.phone, s.boundAccount, true))
  }

  action tick = all { s.age < 2, s' = { ...s, age: s.age + 1, result: "idle" } }
  action restart = s' = { ...s, result: "idle" }
  action idle = s' = s
  action step = any {
    tick, restart, exactCleanup, idle,
    nondet account = Set(1, 2).oneOf()
    bind(account),
    nondet lineage = Set(1, 2).oneOf()
    nondet phone = Set(1, 2).oneOf()
    nondet account = Set(0, 1, 2).oneOf()
    nondet matches = Set(true, false).oneOf()
    val req = request(lineage, phone, account, matches)
    any { claim(req), complete(req) }
  }

  val SingleBoundAuthority = all {
    (s.lineage == 0).implies(s.phone == 0 and s.pinnedAccount == 0),
    (s.lineage != 0).implies(s.trusted and s.phone != 0),
    (s.boundAccount != 0 and s.pinnedAccount != 0).implies(s.boundAccount == s.pinnedAccount)
  }

  pure def claimFields(x: State): (int, int, int) = (x.lineage, x.phone, x.pinnedAccount)

  temporal admittedRequest = s.trusted and s.age < 2 and next(s.request.telegramMatches) and
    (s.boundAccount == 0 or s.boundAccount == next(s.request.account))
  temporal matchesLiveClaim = s.lineage != 0 and s.lineage == next(s.request.lineage) and
    s.phone == next(s.request.phone) and next(s.request.telegramMatches) and
    (s.pinnedAccount == 0 or s.pinnedAccount == next(s.request.account))

  temporal ClaimRequiresAuthority = always((all {
    (next(s.result) == "acquired").implies(
      s.boundAccount == 0 and admittedRequest and (s.lineage == 0 or matchesLiveClaim)),
    Set("denied", "conflict").contains(next(s.result)).implies(next(claimFields(s)) == claimFields(s)),
    (s.lineage != 0 and next(s.lineage) != 0).implies(
      next(s.lineage) == s.lineage and next(s.phone) == s.phone and
      (s.pinnedAccount == 0 or next(s.pinnedAccount) == s.pinnedAccount))
  }).orKeep(s))

  temporal CompletionRequiresExactBinding = always((all {
    Set("replayed", "completed").contains(next(s.result)).implies(
      s.boundAccount != 0 and s.boundAccount == next(s.request.account) and
      next(s.lineage) == 0 and (s.lineage == 0 or matchesLiveClaim)),
    (next(s.result) == "completed").implies(matchesLiveClaim),
    (next(s.result) == "replayed").implies(admittedRequest),
    (s.boundAccount != 0).implies(next(s.boundAccount) == s.boundAccount)
  }).orKeep(s))

  temporal RetiresBoundClaim = (s.boundAccount != 0 and s.lineage != 0).leadsTo(s.lineage == 0)
  temporal FairRetirement = exactCleanup.weakFair(s).implies(RetiresBoundClaim)

  run originalLineagePinsAccountTest = trustedInit
    .then(claim(request(1, 1, 0, true))).then(claim(request(2, 1, 1, true)))
    .expect(s.result == "conflict").then(claim(request(1, 1, 1, true)))
    .then(claim(request(1, 1, 2, true))).expect(s.result == "conflict" and s.pinnedAccount == 1)
  run replayRetiresRetainedClaimTest = trustedInit
    .then(claim(request(1, 1, 0, true))).then(bind(1)).then(restart)
    .then(claim(request(1, 1, 1, true))).expect(s.result == "replayed" and s.lineage == 0)
  run expiredAdmissionCannotReplaceClaimTest = trustedInit
    .then(claim(request(1, 1, 1, true))).then(tick).then(tick)
    .then(claim(request(2, 2, 2, true))).expect(s.result == "denied" and s.lineage == 1)
    .then(bind(1)).then(exactCleanup).expect(s.result == "completed" and s.lineage == 0)
}
