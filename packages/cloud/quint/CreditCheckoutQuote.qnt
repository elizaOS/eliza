// Quote creation, idempotency races and customer pinning before the dispatch
// protocol in CreditCheckoutOrder. IDs/digests stand for equality classes.
module CreditCheckoutQuote {
  const SameUser: bool
  const SameDigest: bool
  const SeparateOrganizations: bool
  type Row = { present: bool, user: int, digest: int, creator: int, customer: int, started: bool }
  var s: {
    rows: int -> Row, original: int -> Row,
    phase: int -> str, valid: Set[int], organizationCustomer: int -> int,
    selectedCustomer: int -> int, observedCustomer: int -> int
  }
  pure val ids = Set(1, 2)
  pure val empty = { present: false, user: 0, digest: 0, creator: 0, customer: 0, started: false }
  pure def org(caller) = if (caller == 2 and SeparateOrganizations) 2 else 1
  pure def user(caller) = if (caller == 2 and not(SameUser)) 2 else 1
  pure def digest(caller) = if (caller == 2 and not(SameDigest)) 2 else 1
  action init = s' = {
    rows: ids.mapBy(_ => empty), original: ids.mapBy(_ => empty),
    phase: ids.mapBy(_ => "idle"), valid: Set(), organizationCustomer: ids.mapBy(_ => 1),
    selectedCustomer: ids.mapBy(_ => 0), observedCustomer: ids.mapBy(_ => 0)
  }
  // valid includes all schema/amount/key/digest checks and the caller's
  // already-established authorization. Invalid input performs no insert.
  action validate(caller, valid) = all {
    s.phase.get(caller) == "idle",
    s' = s.with("phase", s.phase.set(caller, if (valid) "ready" else "invalid"))
      .with("valid", if (valid) s.valid.union(Set(caller)) else s.valid)
  }
  action insert(caller, loseReply) = all {
    s.phase.get(caller) == "ready",
    val owner = org(caller)
    val row = { present: true, user: user(caller), digest: digest(caller), creator: caller, customer: 0, started: false }
    s' = if (s.rows.get(owner).present)
      s.with("phase", s.phase.set(caller, "lookup"))
    else s.with("rows", s.rows.set(owner, row)).with("original", s.original.set(owner, row))
      .with("phase", s.phase.set(caller, if (loseReply) "lookup" else "accepted"))
  }
  action resolveWinner(caller) = all {
    s.phase.get(caller) == "lookup",
    val row = s.rows.get(org(caller))
    s' = s.with("phase", s.phase.set(caller,
      if (row.present and row.user == user(caller) and row.digest == digest(caller)) "accepted" else "conflict"))
      .with("observedCustomer", s.observedCustomer.set(caller, row.customer))
  }
  action rotateCustomer(owner) = s' = s.with("organizationCustomer",
    s.organizationCustomer.set(owner, if (s.organizationCustomer.get(owner) == 1) 2 else 1))
  action pinCustomer(caller, candidate) = all {
    s.phase.get(caller) == "accepted",
    val owner = org(caller)
    val row = s.rows.get(owner)
    s' = if (s.observedCustomer.get(caller) != 0)
      s.with("phase", s.phase.set(caller, if (candidate == s.observedCustomer.get(caller)) "bound" else "customer_conflict"))
        .with("selectedCustomer", s.selectedCustomer.set(caller, s.observedCustomer.get(caller)))
      else if (row.customer != 0) s.with("phase", s.phase.set(caller, "bound"))
        .with("selectedCustomer", s.selectedCustomer.set(caller, row.customer))
      else if (row.started or candidate != s.organizationCustomer.get(owner))
        s.with("phase", s.phase.set(caller, "customer_conflict"))
      else s.with("rows", s.rows.set(owner, row.with("customer", candidate)))
        .with("original", s.original.set(owner, s.original.get(owner).with("customer", candidate)))
        .with("phase", s.phase.set(caller, "bound"))
        .with("selectedCustomer", s.selectedCustomer.set(caller, candidate))
  }
  action dispatch(caller) = all {
    s.phase.get(caller) == "bound",
    s.rows.get(org(caller)).customer != 0,
    val owner = org(caller)
    val row = s.rows.get(owner)
    s' = s.with("rows", s.rows.set(owner, row.with("started", true)))
      .with("phase", s.phase.set(caller, "dispatched"))
  }
  action step = any {
    nondet caller = ids.oneOf()
    nondet valid = Set(true, false).oneOf()
    nondet lost = Set(true, false).oneOf()
    nondet customer = ids.oneOf()
    any { validate(caller, valid), insert(caller, lost), resolveWinner(caller),
      pinCustomer(caller, customer), dispatch(caller), rotateCustomer(caller) },
    s' = s
  }
  val OriginalQuoteImmutable = ids.forall(owner => {
    val row = s.rows.get(owner)
    val original = s.original.get(owner)
    row.present == original.present and row.user == original.user and
      row.digest == original.digest and row.creator == original.creator and row.customer == original.customer
  })
  val SuccessfulReplayMatches = ids.forall(caller =>
    Set("accepted", "bound", "dispatched").contains(s.phase.get(caller)) implies
      (s.rows.get(org(caller)).present and s.rows.get(org(caller)).user == user(caller) and
       s.rows.get(org(caller)).digest == digest(caller)))
  val InvalidInputCannotInsert = ids.forall(owner =>
    s.rows.get(owner).present implies s.valid.contains(s.rows.get(owner).creator))
  val DispatchHasPinnedCustomer = ids.forall(owner =>
    s.rows.get(owner).started implies s.rows.get(owner).customer != 0) and
    ids.forall(caller => s.phase.get(caller) == "dispatched" implies
      s.rows.get(org(caller)).customer == s.selectedCustomer.get(caller))
  val safety = OriginalQuoteImmutable and SuccessfulReplayMatches and InvalidInputCannotInsert and DispatchHasPinnedCustomer

  action unsafeQuoteUserOverwrite = all {
    s.rows.get(1).present,
    s' = s.with("rows", s.rows.set(1, s.rows.get(1).with("user", 2)))
  }
  run twoConcurrentQuotesStayOwnedTest = init.then(validate(1, true)).then(validate(2, true))
    .then(insert(1, false)).then(insert(2, true)).then(resolveWinner(2))
    .expect(s.phase.get(2) == (if (SeparateOrganizations or (SameUser and SameDigest)) "accepted" else "conflict") and safety)
  run unauthorizedQuoteMutationIsDetectedTest = init.then(validate(1, true)).then(insert(1, false))
    .then(unsafeQuoteUserOverwrite).expect(not(OriginalQuoteImmutable))
  run lostInsertReplyUsesOriginalQuoteTest = init.then(validate(1, true)).then(insert(1, true))
    .then(resolveWinner(1)).expect(s.phase.get(1) == "accepted" and safety)
  run invalidQuoteNeverCreatesAuthorityTest = init.then(validate(1, false))
    .expect(not(s.rows.get(1).present) and safety)
  run staleCustomerCandidateCannotPinTest = init.then(validate(1, true)).then(insert(1, false))
    .then(rotateCustomer(1)).then(pinCustomer(1, 1))
    .expect(s.phase.get(1) == "customer_conflict" and s.rows.get(1).customer == 0 and safety)
  run pinnedCustomerSurvivesLaterRotationTest = init.then(validate(1, true)).then(insert(1, false))
    .then(pinCustomer(1, 1)).then(rotateCustomer(1)).then(dispatch(1))
    .expect(s.rows.get(1).customer == 1 and s.rows.get(1).started and safety)
}
module CreditCheckoutQuoteReplay {
  import CreditCheckoutQuote(SameUser = true, SameDigest = true, SeparateOrganizations = false).*
  run staleQuoteReadAdoptsConcurrentWinnerTest = init.then(validate(1, true)).then(validate(2, true))
    .then(insert(1, false)).then(insert(2, false)).then(resolveWinner(2))
    .then(pinCustomer(1, 1)).then(rotateCustomer(1)).then(pinCustomer(2, 2)).then(dispatch(2))
    .expect(s.selectedCustomer.get(2) == 1 and safety)
  run alreadyObservedCustomerCannotChangeTest = init.then(validate(1, true)).then(insert(1, false))
    .then(pinCustomer(1, 1)).then(validate(2, true)).then(insert(2, false)).then(resolveWinner(2))
    .then(rotateCustomer(1)).then(pinCustomer(2, 2))
    .expect(s.phase.get(2) == "customer_conflict" and safety)
}
module CreditCheckoutQuoteUserConflict { import CreditCheckoutQuote(SameUser = false, SameDigest = true, SeparateOrganizations = false).* }
module CreditCheckoutQuoteDigestConflict { import CreditCheckoutQuote(SameUser = true, SameDigest = false, SeparateOrganizations = false).* }
module CreditCheckoutQuoteTenantIsolation { import CreditCheckoutQuote(SameUser = true, SameDigest = true, SeparateOrganizations = true).* }
