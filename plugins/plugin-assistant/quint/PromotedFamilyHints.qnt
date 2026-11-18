// Read-only selection from one authorized, frozen action catalog.
module PromotedFamilyHints {
  val Children = Set("create", "delete")
  var s: { phase: int, available: bool, foreign: bool, precise: str, hints: Set[str] }

  action initialize(available: bool, foreign: bool, precise: str): bool =
    s' = { phase: 0, available: available, foreign: foreign, precise: precise, hints: Set() }
  action init = {
    nondet available = Set(false, true).oneOf()
    nondet foreign = Set(false, true).oneOf()
    nondet precise = Set("none", "create", "delete").oneOf()
    initialize(available, foreign, precise)
  }
  val authorizedChildren = if (s.available) Children else Set()
  // The requested precise operation wins; an umbrella alone is only a family
  // hint when every claimant belongs to that family.
  val requiredHints =
    if (not(s.available)) Set()
    else if (s.precise != "none") Set(s.precise)
    else if (s.foreign) Set()
    else Children
  action request = all { s.phase == 0, s' = s.with("phase", 1) }
  action resolve = all {
    s.phase == 1,
    s' = s.with("phase", 2).with("hints", requiredHints)
  }
  action advance = any { request, resolve }
  action step = any { advance, s' = s }
  val TypeOK = s.phase.in(0.to(2)) and s.precise.in(Set("none", "create", "delete"))
    and s.hints.subseteq(Children)
  val HintsStayInAuthorizedCatalog = s.hints.subseteq(authorizedChildren)
  val FamilyContract = s.phase == 2 implies s.hints == requiredHints
  val PreciseOperationWins = s.phase == 2 and s.available and s.precise != "none"
    implies s.hints == Set(s.precise)
  val ForeignClaimCannotStealUmbrella = s.phase == 2 and s.foreign and s.precise == "none"
    implies s.hints == Set()
  temporal Settles = (s.phase < 2).leadsTo(s.phase == 2)
  temporal FairSettlement = advance.weakFair(s) implies Settles
  temporal TerminalStable = always((s.phase == 2 implies
    next(s.phase) == 2 and next(s.hints) == s.hints).orKeep(s))

  run sharedUmbrellaTest = initialize(true, false, "none").then(request).then(resolve)
    .expect(s.hints == Children)
  run explicitOperationTest = initialize(true, false, "delete").then(request).then(resolve)
    .expect(s.hints == Set("delete"))
  run unrelatedClaimTest = initialize(true, true, "none").then(request).then(resolve)
    .expect(s.hints == Set())
  run omittedCatalogTest = initialize(false, false, "delete").then(request).then(resolve)
    .expect(s.hints == Set())
}
