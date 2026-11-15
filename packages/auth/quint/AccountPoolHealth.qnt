// Default AccountPool metadata and immediate token/usage verification.
// Credential storage owns the generation CAS. The model represents its atomic
// outcome, while the separate account-storage models cover locks and reset.
module AccountPoolHealth {
  val Accounts = Set(1, 2)
  val Calls = Set(1, 2)
  val StorageModes = Set("success", "before-error", "after-error")
  val Health = Set("ok", "rate-limited", "needs-reauth", "invalid", "expired")
  type Account = {
    generation: int, health: str, detail: int, until: int,
    enabled: bool, ends: int, usage: int, reset: int,
  }
  type Call = {
    phase: str, account: int, captured: Account, receipt: int,
    health: str, detail: int, until: int, response: int, outcome: str, confirmedUsage: bool,
  }
  type State = {
    accounts: int -> Account, calls: int -> Call, before: int -> Account,
    nextGeneration: int, replacementUsed: bool, verdictUsed: bool, extensionUsed: bool,
    now: int, eventTime: int, last: str, lastAccount: int, lastCall: int, expected: int,
    violations: Set[str],
  }
  val Missing = {
    generation: 0,
    health: "ok",
    detail: 0,
    until: 0,
    enabled: false,
    ends: 3,
    usage: 0,
    reset: 3,
  }
  val EmptyCall = {
    phase: "idle",
    account: 1,
    captured: Missing,
    receipt: 0,
    health: "ok",
    detail: 0,
    until: 0,
    response: 0,
    outcome: "pending",
    confirmedUsage: false,
  }
  var s: State
  action init = {
    val accounts = Accounts.mapBy(a => {...Missing, generation: a, enabled: true})
    s' = {
      accounts: accounts, before: Accounts.mapBy(_ => Missing), calls: Calls.mapBy(_ => EmptyCall),
      nextGeneration: 3, replacementUsed: false, verdictUsed: false, extensionUsed: false,
      now: 0, eventTime: 0, last: "none", lastAccount: 1, lastCall: 1, expected: 0,
      violations: Set(),
    }
  }
  pure def Present(account: Account): bool = account.generation > 0
  pure def Expired(account: Account, now: int): bool = account.ends <= now
  pure def SameHealth(a: Account, c: Call): bool = and {
    a.health == c.health,
    a.detail == c.detail,
    a.until == c.until,
  }
  // Transition checks still read the receipt and health baseline of the call
  // that just finished. Keep those inputs until FinishTransition checks them.
  pure def FinishCall(state: State, id: int): State = {
    ...state,
    calls: state.calls.set(id, {
      ...state.calls.get(id),
      phase: "done",
      captured: Missing,
      outcome: if (state.calls.get(id).outcome == "pending") {
        "discarded"
      } else {
        state.calls.get(id).outcome
      },
    }),
  }
  // No enabled action reads a completed call's inputs. Preserve the exact
  // outcome and response after evaluating the checks on the committing edge.
  pure def ProjectCompletedCall(state: State, id: int): State = {
    val call = state.calls.get(id)
    if (call.phase == "done") {
      ...state,
      calls: state.calls.set(id, {
        ...EmptyCall, phase: "done", outcome: call.outcome,
        response: call.response, confirmedUsage: call.confirmedUsage,
      }),
    } else state
  }
  pure def SetAccount(state: State, id: int, account: Account, operation: str, expected: int): State = {
    ...state, before: state.accounts, accounts: state.accounts.set(id, account),
    last: operation, lastAccount: id, expected: expected, eventTime: state.now,
  }

  action Start(id: int, accountId: int): bool = all {
    s.calls.get(id).phase == "idle",
    s' = {...s, calls: s.calls.set(id, {
      ...EmptyCall, account: accountId, phase: "resolve",
      // Resolution reads only the starting generation. CaptureSnapshot
      // separately retains the entire record for explicit metadata writes.
      captured: { ...Missing, generation: s.accounts.get(accountId).generation },
    })},
  }
  // Once resolution succeeds, only its receipt and later usage baseline remain
  // observable. The pre-resolution account snapshot is dead at that point.
  // A successful refresh returns the new durable generation. When another
  // writer won its CAS, getAccessToken returns that current fresh credential.
  action ResolveSuccess(id: int, rotate: bool): bool = {
    val call = s.calls.get(id)
    val current = s.accounts.get(call.account)
    val rotates = rotate and current.generation == call.captured.generation and Present(current)
    val selected = if (rotates) {...current, generation: s.nextGeneration} else current
    val updatedState = if (rotates) {
      SetAccount(s, call.account, selected, "rotate", current.generation)
    } else {
      {...s, before: s.accounts}
    }
    all {
      call.phase == "resolve",
      s' = if (not(Present(selected))) FinishCall(s, id).ProjectCompletedCall(id) else {
        ...updatedState, nextGeneration: s.nextGeneration + (if (rotates) 1 else 0), lastCall: id,
        last: if (rotates) "rotate" else "resolve-success", lastAccount: call.account,
        calls: updatedState.calls.set(id, {...call, phase: "ready", captured: Missing, receipt: selected.generation}),
      }.FinishTransition(),
    }
  }
  // An auth rejection belongs to the generation that supplied the grant.
  // The pool's expected-generation guard refuses an old rejection after relink.
  action ResolveFailure(id: int, auth: bool, storage: str): bool = {
    val call = s.calls.get(id)
    val current = s.accounts.get(call.account)
    val matches = auth and Present(current) and current.generation == call.captured.generation
    val applies = matches and storage != "before-error"
    val updated = if (Expired(current, s.now)) {
      {...current, health: "expired", detail: 1, until: 0}
    } else {
      {...current, health: "needs-reauth", detail: 1, until: 0}
    }
    val updatedState = SetAccount(s, call.account, if (applies) updated else current, "resolve-failure", call.captured.generation)
    all {
      call.phase == "resolve", StorageModes.contains(storage),
      s' = FinishCall({...updatedState, lastCall: id, calls: updatedState.calls.set(id, {
        ...call, outcome: if (matches and storage != "success") "storage-error" else if (auth) "auth" else "transient",
      })}, id).FinishTransition(),
    }
  }
  action StartUsage(id: int): bool = {
    val call = s.calls.get(id)
    val current = s.accounts.get(call.account)
    all {
      call.phase == "ready",
      s' = if (not(Present(current)) or current.generation != call.receipt) {
        FinishCall(s, id).ProjectCompletedCall(id)
      } else if (Expired(current, s.now)) {
        {...s, calls: s.calls.set(id, {...call, phase: "expiry"})}
      } else {
        ...s,
        calls: s.calls.set(id, {
          ...call,
          phase: "usage",
          health: current.health,
          detail: current.detail,
          until: current.until,
        }),
      },
    }
  }
  action FinishExpiry(id: int, storage: str): bool = {
    val call = s.calls.get(id)
    val current = s.accounts.get(call.account)
    val eligible = Present(current) and current.generation == call.receipt and Expired(current, s.now)
    val applies = eligible and storage != "before-error"
    val state = SetAccount(s, call.account,
      if (applies) {...current, health: "expired", detail: 1, until: 0} else current,
      if (applies) "expire-apply" else "expire-refuse", call.receipt)
    all {
      call.phase == "expiry", StorageModes.contains(storage),
      s' = FinishCall({...state, lastCall: id, calls: state.calls.set(id, {
        ...call, outcome: if (eligible and storage != "success") "storage-error" else "discarded",
      })}, id).FinishTransition(),
    }
  }
  action UsageSuccess(id: int, response: int, storage: str): bool = {
    val call = s.calls.get(id)
    val current = s.accounts.get(call.account)
    val matches = Present(current) and current.generation == call.receipt
    val applies = matches and storage != "before-error"
    val selected = if (SameHealth(current, call)) {
      {...current, health: "ok", detail: 0, until: 0}
    } else {
      current
    }
    val updated = if (applies) {...selected, usage: response, reset: response + 1} else current
    val updatedState = SetAccount(s, call.account, updated, "usage-success", call.receipt)
    all {
      call.phase == "usage", StorageModes.contains(storage),
      s' = FinishCall({...updatedState, lastCall: id, calls: updatedState.calls.set(id, {
        ...call, response: response, confirmedUsage: matches and storage == "success", outcome: if (not(matches)) "discarded" else if (storage == "success") "ok" else "storage-error",
      })}, id).FinishTransition(),
    }
  }
  action UsageFailure(id: int, verdict: str, storage: str): bool = {
    val call = s.calls.get(id)
    val current = s.accounts.get(call.account)
    val matches = Present(current) and current.generation == call.receipt and verdict != "transient"
    val applies = matches and storage != "before-error"
    // Account1 is Anthropic. Account2 carries the current Codex primary reset.
    val updated = if (verdict == "rate-limited") {
      ...current,
      health: verdict,
      detail: 1,
      until: if (call.account == 2 and current.reset > s.now) {
        current.reset
      } else {
        s.now + 1
      },
    } else if (Expired(current, s.now)) {
      {...current, health: "expired", detail: 1, until: 0}
    } else {
      {...current, health: "needs-reauth", detail: 1, until: 0}
    }
    val updatedState = SetAccount(s, call.account, if (applies) updated else current, "usage-failure", call.receipt)
    all {
      call.phase == "usage", StorageModes.contains(storage),
      s' = FinishCall({...updatedState, lastCall: id, calls: updatedState.calls.set(id, {
        ...call, outcome: if (matches and storage != "success") "storage-error" else verdict,
      })}, id).FinishTransition(),
    }
  }
  action CaptureSnapshot(id: int, accountId: int): bool = all {
    s.calls.get(id).phase == "idle",
    s' = {...s, calls: s.calls.set(id, {
      ...EmptyCall, phase: "snapshot", account: accountId,
      captured: s.accounts.get(accountId), receipt: s.accounts.get(accountId).generation,
    })},
  }
  // Public metadata snapshots retain the private generation through spreads.
  // persistAccount checks it while the existing credential storage lock is held.
  action WriteSnapshot(id: int, storage: str): bool = {
    val call = s.calls.get(id)
    val current = s.accounts.get(call.account)
    val matches = Present(current) and current.generation == call.receipt
    val applies = storage != "before-error" and matches
    val updatedState = SetAccount(s, call.account,
      if (applies) {...call.captured, health: "invalid", detail: 1} else current,
      "snapshot-write", call.receipt)
    all {
      call.phase == "snapshot", StorageModes.contains(storage),
      s' = FinishCall({...updatedState, lastCall: id, calls: updatedState.calls.set(id, {
        ...call, outcome: if (not(matches)) "discarded" else if (storage == "success") "ok" else "storage-error",
      })}, id).FinishTransition()
    }
  }
  action Replace(accountId: int, remove: bool): bool = {
    val replacement = if (remove) Missing else {...Missing, generation: s.nextGeneration, enabled: true, usage: 2}
    all {
      not(s.replacementUsed),
      s' = {...SetAccount(s, accountId, replacement, "replace", 0),
        replacementUsed: true, nextGeneration: s.nextGeneration + (if (remove) 0 else 1)}.FinishTransition(),
    }
  }
  action NewHealth(accountId: int, health: str, detail: int): bool = {
    val current = s.accounts.get(accountId)
    all {
      not(s.verdictUsed), Present(current), Health.contains(health),
      Set(1, 2).contains(detail),
      s' = {...SetAccount(s, accountId, {
        ...current, health: health, detail: if (health == "ok") 0 else detail,
        until: if (health == "rate-limited") 3 else 0,
      }, "verdict", current.generation), verdictUsed: true}.FinishTransition(),
    }
  }
  action EndSubscription(accountId: int): bool = all {
    not(s.verdictUsed), Present(s.accounts.get(accountId)),
    s' = {...SetAccount(s, accountId, {...s.accounts.get(accountId), ends: s.now}, "end-subscription", 0), verdictUsed: true}.FinishTransition(),
  }
  action ExtendSubscription(accountId: int): bool = all {
    not(s.extensionUsed), Present(s.accounts.get(accountId)), Expired(s.accounts.get(accountId), s.now),
    s' = {...SetAccount(s, accountId, {...s.accounts.get(accountId), ends: 3}, "extend-subscription", 0), extensionUsed: true}.FinishTransition(),
  }
  action CallWork(id: int): bool = any {
    {
      nondet rotate = Set(true, false).oneOf()
      ResolveSuccess(id, rotate)
    },
    {
      nondet auth = Set(true, false).oneOf()
      nondet storage = StorageModes.oneOf()
      ResolveFailure(id, auth, storage)
    },
    StartUsage(id),
    {
      nondet storage = StorageModes.oneOf()
      FinishExpiry(id, storage)
    },
    {
      nondet response = Set(1, 2).oneOf()
      nondet storage = StorageModes.oneOf()
      UsageSuccess(id, response, storage)
    },
    {
      nondet verdict = Set("transient", "auth", "rate-limited").oneOf()
      nondet storage = StorageModes.oneOf()
      UsageFailure(id, verdict, storage)
    },
    {
      nondet storage = StorageModes.oneOf()
      WriteSnapshot(id, storage)
    },
  }
  action BoundedStep(callIds: Set[int], tick: bool, externalWrites: bool): bool = any {
    {nondet id = callIds.oneOf(); nondet a = Accounts.oneOf(); Start(id, a)},
    {nondet id = callIds.oneOf(); nondet a = Accounts.oneOf(); CaptureSnapshot(id, a)},
    {nondet id = callIds.oneOf(); CallWork(id)},
    all {
      externalWrites,
      any {
        {nondet a = Accounts.oneOf(); nondet remove = Set(true, false).oneOf(); Replace(a, remove)},
        {
          nondet a = Accounts.oneOf()
          nondet health = Health.oneOf()
          nondet detail = Set(1, 2).oneOf()
          NewHealth(a, health, detail)
        },
        {nondet a = Accounts.oneOf(); EndSubscription(a)},
        {nondet a = Accounts.oneOf(); ExtendSubscription(a)},
      },
    },
    all {tick, s.now < 2, s' = {...s, now: s.now + 1}},
    s' = s,
  }

  // The full combination remains available for explicit runs. The shared
  // checker verifies three overlapping partitions with smaller state spaces.
  action step = BoundedStep(Calls, true, true)
  action concurrentOwnershipStep = BoundedStep(Calls, false, true)
  action timedExternalWritesStep = BoundedStep(Set(1), true, true)
  action concurrentCooldownStep = BoundedStep(Calls, true, false)

  val TypeOK = and {
    s.accounts.keys() == Accounts, s.calls.keys() == Calls,
    0 <= s.now and s.now <= 2, 3 <= s.nextGeneration and s.nextGeneration <= 6,
    Accounts.forall(a => Health.contains(s.accounts.get(a).health)),
    Calls.forall(id => Set("idle", "resolve", "ready", "usage", "expiry", "snapshot", "done").contains(s.calls.get(id).phase)),
  }
  pure def CheckStaleObservationCannotWrite(t: State): bool = t.last.in(Set("resolve-failure", "usage-success", "usage-failure", "snapshot-write")) and
    t.expected != t.before.get(t.lastAccount).generation implies t.accounts == t.before
  pure def CheckDeletedAccountCannotReappear(t: State): bool = t.last.in(Set("resolve-failure", "usage-success", "usage-failure", "snapshot-write")) and
    not(Present(t.before.get(t.lastAccount))) implies t.accounts == t.before
  pure def CheckOtherProviderUnchanged(t: State): bool = Accounts.forall(a => a == t.lastAccount or t.accounts.get(a) == t.before.get(a))
  pure def CheckUsagePreservesNewHealth(t: State): bool = t.last == "usage-success" implies {
    val call = t.calls.get(t.lastCall)
    val before = t.before.get(t.lastAccount)
    not(SameHealth(before, call)) implies
      t.accounts.get(t.lastAccount).health == before.health and
      t.accounts.get(t.lastAccount).detail == before.detail and
      t.accounts.get(t.lastAccount).until == before.until
  }
  pure def CheckAppliedUsageMatchesResponse(t: State): bool = t.last == "usage-success" and t.expected == t.before.get(t.lastAccount).generation and t.expected > 0 and t.calls.get(t.lastCall).outcome != "storage-error" implies
    t.accounts.get(t.lastAccount).usage == t.calls.get(t.lastCall).response
  pure def CheckFailurePreservesUsage(t: State): bool = t.last.in(Set("resolve-failure", "usage-failure")) implies
    t.accounts.get(t.lastAccount).usage == t.before.get(t.lastAccount).usage and
    t.accounts.get(t.lastAccount).reset == t.before.get(t.lastAccount).reset
  pure def CheckExpiryVerdictUsesCurrentSubscription(t: State): bool = t.last == "expire-apply" implies Expired(t.accounts.get(t.lastAccount), t.now)
  pure def CheckCurrentResetControlsCooldown(t: State): bool = t.last == "usage-failure" and
    t.calls.get(t.lastCall).outcome == "rate-limited" and t.expected == t.before.get(t.lastAccount).generation implies {
      val before = t.before.get(t.lastAccount)
      t.accounts.get(t.lastAccount).until ==
        (if (t.lastAccount == 2 and before.reset > t.eventTime) before.reset else t.eventTime + 1)
    }
  val UsageAcknowledgementNeedsCommit = Calls.forall(id => {
    val call = s.calls.get(id)
    call.confirmedUsage implies call.outcome == "ok" and call.response > 0
  })
  pure def CheckRotatedReceiptIsCurrent(t: State): bool = t.last == "rotate" implies t.calls.get(t.lastCall).receipt == t.accounts.get(t.lastAccount).generation
  val StaleObservationCannotWrite = not(s.violations.contains("StaleObservationCannotWrite"))
  val DeletedAccountCannotReappear = not(s.violations.contains("DeletedAccountCannotReappear"))
  val OtherProviderUnchanged = not(s.violations.contains("OtherProviderUnchanged"))
  val UsagePreservesNewHealth = not(s.violations.contains("UsagePreservesNewHealth"))
  val AppliedUsageMatchesResponse = not(s.violations.contains("AppliedUsageMatchesResponse"))
  val FailurePreservesUsage = not(s.violations.contains("FailurePreservesUsage"))
  val ExpiryVerdictUsesCurrentSubscription = not(s.violations.contains("ExpiryVerdictUsesCurrentSubscription"))
  val CurrentResetControlsCooldown = not(s.violations.contains("CurrentResetControlsCooldown"))
  val RotatedReceiptIsCurrent = not(s.violations.contains("RotatedReceiptIsCurrent"))
  // The historical before/last fields are only read by transition checks.
  // Evaluate those checks before erasing their dead records. Sticky witnesses
  // preserve every violating prefix without multiplying later protocol states.
  pure def FinishTransition(t: State): State = {
    val checks = Map(
      "StaleObservationCannotWrite" -> CheckStaleObservationCannotWrite(t),
      "DeletedAccountCannotReappear" -> CheckDeletedAccountCannotReappear(t),
      "OtherProviderUnchanged" -> CheckOtherProviderUnchanged(t),
      "UsagePreservesNewHealth" -> CheckUsagePreservesNewHealth(t),
      "AppliedUsageMatchesResponse" -> CheckAppliedUsageMatchesResponse(t),
      "FailurePreservesUsage" -> CheckFailurePreservesUsage(t),
      "ExpiryVerdictUsesCurrentSubscription" -> CheckExpiryVerdictUsesCurrentSubscription(t),
      "CurrentResetControlsCooldown" -> CheckCurrentResetControlsCooldown(t),
      "RotatedReceiptIsCurrent" -> CheckRotatedReceiptIsCurrent(t)
    )
    {
      ...ProjectCompletedCall(t, t.lastCall),
      violations: t.violations.union(checks.keys().filter(name => not(checks.get(name)))),
      before: Accounts.mapBy(_ => Missing), last: "none", lastAccount: 1,
      lastCall: 1, expected: 0, eventTime: 0,
    }
  }
  temporal CallsSettle = Calls.forall(id => CallWork(id).weakFair(s)) implies
    always(Calls.forall(id => s.calls.get(id).phase.in(Set("resolve", "ready", "usage", "expiry", "snapshot")) implies
      eventually(s.calls.get(id).phase == "done")))
  run oldUsageCannotCrossReplacementTest = init.then(Start(1, 1)).then(ResolveSuccess(1, false))
    .then(StartUsage(1)).then(Replace(1, false)).then(UsageSuccess(1, 1, "success"))
    .expect(StaleObservationCannotWrite and s.accounts.get(1).usage == 2)
  run oldAuthFailureCannotParkReplacementTest = init.then(Start(1, 1)).then(Replace(1, false))
    .then(ResolveFailure(1, true, "success")).expect(StaleObservationCannotWrite and s.accounts.get(1).health == "ok")
  run currentRotationCanRefreshUsageTest = init.then(Start(1, 1)).then(ResolveSuccess(1, true))
    .then(StartUsage(1)).then(UsageSuccess(1, 1, "success")).expect(s.accounts.get(1).usage == 1)
  run newerHealthSurvivesUsageTest = init.then(Start(1, 1)).then(ResolveSuccess(1, false))
    .then(StartUsage(1)).then(NewHealth(1, "needs-reauth", 2)).then(UsageSuccess(1, 1, "success"))
    .expect(UsagePreservesNewHealth and s.accounts.get(1).health == "needs-reauth")
  run earlyExpiryHasNoUsageReceiptTest = init.then(Start(1, 1)).then(ResolveSuccess(1, true))
    .then(EndSubscription(1)).then(StartUsage(1)).then(FinishExpiry(1, "success")).expect(not(s.calls.get(1).confirmedUsage) and s.accounts.get(1).health == "expired")

  run extendedSubscriptionRejectsOldExpiryTest = init.then(Start(1, 1)).then(ResolveSuccess(1, false))
    .then(EndSubscription(1)).then(StartUsage(1)).then(ExtendSubscription(1)).then(FinishExpiry(1, "success"))
    .expect(s.accounts.get(1).health == "ok" and not(s.calls.get(1).confirmedUsage))

  run cooldownOnlyChangeSurvivesUsageTest = init
    .then(Start(2, 1)).then(ResolveSuccess(2, false)).then(StartUsage(2))
    .then(UsageFailure(2, "rate-limited", "success"))
    .then(Start(1, 1)).then(ResolveSuccess(1, false)).then(StartUsage(1))
    .then(NewHealth(1, "rate-limited", 1)).then(UsageSuccess(1, 1, "success"))
    .expect(UsagePreservesNewHealth and s.accounts.get(1).until == 3)

  run expiredVerdictDropsPriorCooldownTest = init
    .then(Start(1, 1)).then(ResolveSuccess(1, false)).then(StartUsage(1))
    .then(UsageFailure(1, "rate-limited", "success"))
    .then(EndSubscription(1)).then(Start(2, 1))
    .then(ResolveFailure(2, true, "success"))
    .expect(s.accounts.get(1).health == "expired" and
      s.accounts.get(1).detail == 1 and s.accounts.get(1).until == 0)

  run healthFailureRetainsConcurrentUsageTest = init.then(Start(1, 1)).then(Start(2, 1))
    .then(ResolveSuccess(2, false)).then(StartUsage(2)).then(UsageSuccess(2, 2, "success"))
    .then(ResolveFailure(1, true, "success")).expect(FailurePreservesUsage and s.accounts.get(1).usage == 2)

}

// Profile email is a backfill. A current address owns the field even if a
// missing-email observation was captured before provider I/O or the lock wait.
module AccountPoolBackfill {
  val StorageModes = Set("success", "before-error", "after-error")
  type State = {
    phase: str, generation: int, capturedGeneration: int,
    email: int, initialEmail: int, fetchedEmail: int,
    freshEmail: int, beforeEmail: int, beforeGeneration: int,
    replacementUsed: bool, emailWriteUsed: bool, outcome: str,
  }
  var s: State
  pure def initial(email: int): State = {
    phase: "idle", generation: 1, capturedGeneration: 0,
    email: email, initialEmail: email, fetchedEmail: 0,
    freshEmail: 0, beforeEmail: email, beforeGeneration: 1,
    replacementUsed: false, emailWriteUsed: false, outcome: "pending",
  }
  action init = {
    nondet email = Set(0, 2).oneOf()
    s' = initial(email)
  }
  action initEmpty = s' = initial(0)
  action start = all {
    s.phase == "idle",
    s' = {...s, capturedGeneration: s.generation,
      phase: if (s.email == 0) "profile" else "merge"},
  }
  action profileReturns(hasEmail: bool): bool = all {
    s.phase == "profile",
    s' = {...s, fetchedEmail: if (hasEmail) 1 else 0, phase: "merge"},
  }
  action readFresh = all {
    s.phase == "merge",
    s' = if (s.generation != s.capturedGeneration) {
      ...s, phase: "done", outcome: "discarded", beforeEmail: s.email, beforeGeneration: s.generation,
    } else {...s, phase: "lock", freshEmail: s.email},
  }
  action commit(storage: str): bool = {
    val applies = s.generation == s.capturedGeneration and storage != "before-error"
    all {
      s.phase == "lock", StorageModes.contains(storage),
      s' = {...s, phase: "done", beforeEmail: s.email, beforeGeneration: s.generation,
        email: if (applies and s.email == 0 and s.fetchedEmail > 0) s.fetchedEmail else s.email,
        outcome: if (s.generation != s.capturedGeneration) "discarded"
          else if (storage == "success") "updated" else "storage-error"},
    }
  }
  action installEmail = all {
    s.phase.in(Set("profile", "merge", "lock")), not(s.emailWriteUsed),
    s' = {...s, email: 2, emailWriteUsed: true},
  }
  action replaceCredential(hasEmail: bool): bool = all {
    s.phase.in(Set("profile", "merge", "lock")), not(s.replacementUsed),
    s' = {...s, generation: 2, email: if (hasEmail) 2 else 0, replacementUsed: true},
  }
  action work = any {
    {nondet hasEmail = Set(true, false).oneOf(); profileReturns(hasEmail)},
    readFresh,
    {nondet storage = StorageModes.oneOf(); commit(storage)},
  }
  action step = any {
    start, work, installEmail,
    {nondet hasEmail = Set(true, false).oneOf(); replaceCredential(hasEmail)},
    s' = s,
  }
  val TypeOK = and {
    s.phase.in(Set("idle", "profile", "merge", "lock", "done")),
    Set(1, 2).contains(s.generation), Set(0, 1, 2).contains(s.capturedGeneration),
    Set(0, 1, 2).contains(s.email), Set(0, 1).contains(s.fetchedEmail),
    s.outcome.in(Set("pending", "updated", "discarded", "storage-error")),
  }
  val ExistingEmailWins = s.phase == "done" and s.beforeEmail > 0 implies s.email == s.beforeEmail
  val ReplacementIsNotBackfilled = s.phase == "done" and s.beforeGeneration != s.capturedGeneration implies
    s.email == s.beforeEmail
  val BackfillUsesOnlyObservedEmail = s.phase == "done" and s.email != s.beforeEmail implies
    s.beforeEmail == 0 and s.email == s.fetchedEmail and s.beforeGeneration == s.capturedGeneration
  val ExistingEmailSkipsProfile = s.initialEmail > 0 implies s.fetchedEmail == 0
  temporal BackfillSettles = (start.weakFair(s) and work.weakFair(s)) implies eventually(s.phase == "done")
  run newerEmailDuringProfileWinsTest = initEmpty.then(start).then(installEmail)
    .then(profileReturns(true)).then(readFresh).then(commit("success")).expect(ExistingEmailWins and s.email == 2)
  run newerEmailDuringLockWaitWinsTest = initEmpty.then(start).then(profileReturns(true))
    .then(readFresh).then(installEmail).then(commit("success")).expect(ExistingEmailWins and s.email == 2)
  run replacementDuringLockWaitWinsTest = initEmpty.then(start).then(profileReturns(true))
    .then(readFresh).then(replaceCredential(false)).then(commit("success")).expect(ReplacementIsNotBackfilled and s.email == 0)
  run failedPublicationRetainsUncertainBackfillTest = initEmpty.then(start).then(profileReturns(true))
    .then(readFresh).then(commit("after-error")).expect(s.outcome == "storage-error" and s.email == 1)
}

// Codex usage must use the organization carried by the exact token decision.
// Generations stand for credential identities, with organization0 absent.
// This independent instance keeps context identity out of the health product.
module AccountPoolContext {
  type State = {
    phase: str,
    refresh: bool,
    generation: int,
    organization: int,
    capturedOrganization: int,
    resultGeneration: int,
    resultOrganization: int,
    requestOrganization: int,
    observedGeneration: int,
    replacementUsed: bool,
    applied: bool,
    outcome: str,
  }
  var s: State
  pure def initial(organization: int, refresh: bool): State = {
    phase: "resolve",
    refresh: refresh,
    generation: 1,
    organization: organization,
    capturedOrganization: organization,
    resultGeneration: 0,
    resultOrganization: 0,
    requestOrganization: 0,
    observedGeneration: 0,
    replacementUsed: false,
    applied: false,
    outcome: "pending",
  }
  action init = {
    nondet organization = Set(0, 1).oneOf()
    nondet refresh = Set(true, false).oneOf()
    s' = initial(organization, refresh)
  }
  action initNamedRefresh = s' = initial(1, true)
  action initNamedDirect = s' = initial(1, false)
  action resolve = all {
    s.phase == "resolve",
    s' = {
      ...s,
      phase: "admit",
      resultGeneration: if (s.refresh) s.generation else 1,
      resultOrganization: if (s.refresh) s.organization else s.capturedOrganization,
    },
  }
  action replace(organization: int): bool = all {
    not(s.replacementUsed),
    Set(0, 2).contains(organization),
    s' = {
      ...s,
      generation: 2,
      organization: organization,
      replacementUsed: true,
    },
  }
  action admit = all {
    s.phase == "admit",
    s' = if (s.generation != s.resultGeneration) {
      ...s,
      phase: "done",
      outcome: "discarded",
    } else {
      ...s,
      phase: "poll",
      requestOrganization: s.resultOrganization,
    },
  }
  action publish(storage: str): bool = {
    val current = s.generation == s.resultGeneration
    val applied = current and storage != "before-error"
    all {
      s.phase == "poll",
      Set("success", "before-error", "after-error").contains(storage),
      s' = {
        ...s,
        phase: "done",
        observedGeneration: s.generation,
        applied: applied,
        outcome: if (not(current)) "discarded"
          else if (storage == "success") "updated" else "storage-error",
      },
    }
  }
  action work = any {
    resolve,
    admit,
    {
      nondet storage = Set("success", "before-error", "after-error").oneOf()
      publish(storage)
    },
  }
  action step = any {
    work,
    {
      nondet organization = Set(0, 2).oneOf()
      replace(organization)
    },
    s' = s,
  }
  val TypeOK = and {
    s.phase.in(Set("resolve", "admit", "poll", "done")),
    Set(1, 2).contains(s.generation),
    Set(0, 1, 2).contains(s.organization),
    Set(0, 1, 2).contains(s.resultOrganization),
    Set(0, 1, 2).contains(s.requestOrganization),
  }
  val TokenAndOrganizationShareDecision =
    s.resultGeneration == 1 implies s.resultOrganization == s.capturedOrganization
  val ReplacementOrganizationIsSelected =
    s.resultGeneration == 2 implies s.resultOrganization == s.organization
  val PollCarriesTokenOrganization =
    s.phase.in(Set("poll", "done")) and s.outcome != "discarded" implies
      s.requestOrganization == s.resultOrganization
  val PublicationOwnsGeneration =
    s.applied implies s.resultGeneration == s.observedGeneration
  temporal ContextSettles = work.weakFair(s) implies eventually(s.phase == "done")

  run replacementContextTravelsWithTokenTest = initNamedRefresh
    .then(replace(2)).then(resolve).then(admit).then(publish("success"))
    .expect(s.requestOrganization == 2 and s.outcome == "updated")
  run directOldTokenCannotProbeReplacementTest = initNamedDirect
    .then(replace(2)).then(resolve).then(admit)
    .expect(s.outcome == "discarded" and not(s.applied))
  run replacementAfterAdmissionCannotPublishTest = initNamedRefresh
    .then(resolve).then(admit).then(replace(2)).then(publish("success"))
    .expect(s.requestOrganization == 1 and s.outcome == "discarded")
  run absentOrganizationStaysAbsentTest = initNamedRefresh
    .then(replace(0)).then(resolve).then(admit).then(publish("success"))
    .expect(s.requestOrganization == 0 and s.outcome == "updated")
}
