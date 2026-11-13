// Atomic staging Stripe configuration: input validation precedes Worker publication.
module StagingStripeBindings {
  type State = {
    staging: bool, catalog: int, providerValid: bool, extrasValid: bool,
    extraCount: int, phase: str, queued: int, applied: int
  }
  var s: State

  // catalog: 0 = all blank, 1 = partial, 2 = complete test, 3 = complete live.
  pure def initial(staging: bool, catalog: int, providerValid: bool,
    extrasValid: bool, extraCount: int): State = {
    staging: staging, catalog: catalog, providerValid: providerValid,
    extrasValid: extrasValid, extraCount: extraCount, phase: "initial",
    queued: 0, applied: 0
  }
  action init = {
    nondet staging = Set(true, false).oneOf()
    nondet catalog = Set(0, 1, 2, 3).oneOf()
    nondet providerValid = Set(true, false).oneOf()
    nondet extrasValid = Set(true, false).oneOf()
    nondet extraCount = Set(0, 1, 2).oneOf()
    s' = initial(staging, catalog, providerValid, extrasValid, extraCount)
  }
  pure def allowed(x: State): bool = not(x.staging) or
    ((x.catalog == 0 or (x.catalog == 2 and x.providerValid)) and x.extrasValid)
  pure def intended(x: State): int = if (not(x.staging)) 0
    else (if (x.catalog == 2) 5 else 0) + x.extraCount

  action prepare = all {
    s.phase == "initial",
    s' = if (allowed(s)) { ...s, phase: "prepared", queued: intended(s) }
      else { ...s, phase: "rejected" }
  }
  // Submission can lose its reply. The Worker changes all named bindings or none.
  action submit = all {
    s.phase == "prepared",
    nondet applied = Set(0, s.queued).oneOf()
    s' = { ...s, phase: "uncertain", applied: applied }
  }
  action observe = all {
    s.phase == "uncertain",
    s' = { ...s, phase: if (s.applied == s.queued) "complete" else "failed" }
  }
  action cancel = all { s.phase == "prepared", s' = { ...s, phase: "cancelled" } }
  action idle = s' = s
  action step = any { prepare, submit, observe, cancel, idle }

  val ProductionPreserved = not(s.staging).implies(s.queued == 0 and s.applied == 0)
  val OnlyValidatedInput = (s.queued > 0 or s.applied > 0).implies(allowed(s))
  val AtomicPublication = s.applied == 0 or s.applied == intended(s)
  val RefusalPreserved = Set("initial", "rejected", "cancelled").contains(s.phase)
    .implies(s.applied == 0)
  temporal Terminal = eventually(Set("rejected", "complete", "failed", "cancelled").contains(s.phase))
  temporal FairCompletion = (prepare.weakFair(s) and submit.weakFair(s) and observe.weakFair(s))
    implies Terminal

  action partialInit = s' = initial(true, 1, true, true, 2)
  action blankInit = s' = initial(true, 0, false, true, 0)
  action productionInit = s' = initial(false, 3, false, false, 2)
  action testInit = s' = initial(true, 2, true, true, 2)
  run rejectsPartialTest = partialInit.then(prepare).expect(s.phase == "rejected" and s.applied == 0)
  run preservesBlankTest = blankInit.then(prepare).then(submit).expect(s.applied == 0)
  run preservesProductionTest = productionInit.then(prepare).then(submit).expect(ProductionPreserved)
  run queuesWholeCatalogTest = testInit.then(prepare).expect(s.queued == 7)
}
