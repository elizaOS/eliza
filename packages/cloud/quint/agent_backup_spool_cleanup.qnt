// Capture-v3 janitor after the catalogue can authorize local cleanup. Two
// executions share one durable intent and one exclusive filesystem lock.
module agent_backup_spool_cleanup {
  type Kind = Protected | Terminal
  type Proof = Unavailable | Exact | Expired
  type Spool = Whole | Partial | Absent
  type Phase = Idle | Authorized | Locked | Cancelling | Confirmed | ReleaseUnknown
  type State = {
    kind: Kind, proof: Proof, spool: Spool, intent: bool,
    phase: Phase, execution: int, lock: int,
  }
  var s: State

  action init = {
    nondet kind = Set(Protected, Terminal).oneOf()
    s' = { kind: kind, proof: Unavailable, spool: Whole, intent: false,
      phase: Idle, execution: 0, lock: 0 }
  }
  pure def acceptsProof(kind: Kind, proof: Proof): bool =
    proof == Exact or (kind == Protected and proof == Expired)

  action seeProof(proof: Proof): bool = s' = s.with("proof", proof)
  action persistIntent = all {
    s.proof == Exact, s.spool == Whole, not(s.intent),
    s' = s.with("intent", true),
  }
  action authorize(execution: int): bool = all {
    s.phase == Idle, s.intent, acceptsProof(s.kind, s.proof),
    s' = { ...s, phase: Authorized, execution: execution },
  }
  action open(execution: int): bool = all {
    s.phase == Authorized, s.execution == execution, s.spool != Absent,
    s' = { ...s, phase: Locked, lock: execution },
  }
  // An unsuccessful open does not convey ownership. This includes a live
  // competing lock or a local preflight error after successful lock release.
  action openFailed(execution: int): bool = all {
    s.phase == Authorized, s.execution == execution,
    s' = { ...s, phase: Idle, execution: 0 },
  }
  action openReleaseUnknown(execution: int): bool = all {
    s.phase == Authorized, s.execution == execution,
    s' = { ...s, phase: ReleaseUnknown, lock: execution },
  }
  action observeAbsent(execution: int): bool = all {
    s.phase == Authorized, s.execution == execution, s.spool == Absent,
    s' = s.with("phase", Confirmed),
  }
  action unlinkSome(execution: int): bool = all {
    s.phase == Locked, s.lock == execution, s.spool == Whole,
    s' = s.with("spool", Partial),
  }
  action releaseForRetry(execution: int): bool = all {
    s.phase == Locked, s.lock == execution,
    s' = { ...s, phase: Idle, execution: 0, lock: 0 },
  }
  action finishCleanup(execution: int): bool = all {
    s.phase == Locked, s.lock == execution,
    s' = { ...s, spool: Absent, phase: Confirmed, lock: 0 },
  }
  action cancel(execution: int): bool = all {
    s.execution == execution,
    if (s.phase == Locked) s' = s.with("phase", Cancelling)
    else all {
      s.phase.in(Set(Authorized, Confirmed)),
      s' = { ...s, phase: Idle, execution: 0 },
    },
  }
  action releaseCancelled(execution: int): bool = all {
    s.phase == Cancelling, s.lock == execution,
    s' = { ...s, phase: Idle, execution: 0, lock: 0 },
  }
  // Conservatively retain ownership uncertainty if the filesystem cannot
  // confirm release. An abort still propagates and the intent stays pending.
  action releaseFailed(execution: int): bool = all {
    s.phase.in(Set(Locked, Cancelling)), s.lock == execution,
    s' = s.with("phase", ReleaseUnknown),
  }
  action retire(execution: int): bool = all {
    s.phase == Confirmed, s.execution == execution, s.spool == Absent,
    s' = { ...s, intent: false, phase: Idle, execution: 0 },
  }
  action idle = s' = s
  action step = any {
    persistIntent, idle,
    {
      nondet proof = Set(Unavailable, Exact, Expired).oneOf()
      seeProof(proof)
    },
    {
      nondet execution = Set(1, 2).oneOf()
      any { authorize(execution), open(execution), openFailed(execution),
        openReleaseUnknown(execution), observeAbsent(execution), unlinkSome(execution),
        releaseForRetry(execution),
        finishCleanup(execution), cancel(execution), releaseCancelled(execution),
        releaseFailed(execution), retire(execution) }
    },
  }

  val IntentOwnsAttempt = s.phase != Idle implies s.intent
  val LockMatchesExecution = if (s.phase.in(Set(Locked, Cancelling, ReleaseUnknown)))
    s.lock != 0 and s.lock == s.execution else s.lock == 0
  val PartialSpoolNeedsIntent = s.spool == Partial implies s.intent
  val ConfirmedAbsence = s.phase == Confirmed implies s.spool == Absent
  temporal SafeCleanupTransitions = always(and {
    (s.spool != next(s.spool)) implies (s.phase == Locked and s.intent),
    (s.intent and not(next(s.intent))) implies (s.phase == Confirmed and s.spool == Absent),
    (s.lock != 0 and next(s.lock) != 0) implies next(s.lock) == s.lock,
    (s.phase == Idle and next(s.phase) == Authorized) implies acceptsProof(s.kind, s.proof),
    (s.phase == Cancelling) implies (next(s.spool) == s.spool and next(s.intent) == s.intent),
  }.orKeep(s))

  action stableInit = {
    nondet kind = Set(Protected, Terminal).oneOf()
    nondet removed = Set(false, true).oneOf()
    s' = { kind: kind, proof: if (kind == Protected) Expired else Exact, intent: true,
      spool: if (removed) Absent else Partial, phase: if (removed) Idle else Cancelling,
      execution: if (removed) 0 else 1, lock: if (removed) 0 else 1 }
  }
  action releaseFirst = releaseCancelled(1)
  action authorizeSecond = authorize(2)
  action openSecond = open(2)
  action observeAbsentSecond = observeAbsent(2)
  action finishSecond = finishCleanup(2)
  action retireSecond = retire(2)
  action stableStep = any {
    releaseFirst, authorizeSecond, openSecond, observeAbsentSecond, finishSecond, retireSecond, idle,
  }
  temporal IntentEventuallyRetires = eventually(not(s.intent))
  temporal FairStableRecovery =
    (releaseFirst.weakFair(s) and authorizeSecond.weakFair(s) and openSecond.weakFair(s) and
      observeAbsentSecond.weakFair(s) and finishSecond.weakFair(s) and retireSecond.weakFair(s))
    implies IntentEventuallyRetires

  run interruptedCleanupSurvivesUntilFreshProofTest = init
    .then(seeProof(Exact)).then(persistIntent).then(authorize(1)).then(open(1))
    .then(unlinkSome(1)).then(cancel(1)).then(releaseFirst).then(seeProof(Unavailable))
    .expect(s.phase == Idle and s.lock == 0 and s.spool == Partial and s.intent)
    .then(seeProof(Exact)).then(authorizeSecond).then(openSecond).then(finishSecond)
    .then(retireSecond).expect(s.spool == Absent and not(s.intent))

  run canceledReceiptIsReconfirmedOnRestartTest = init
    .then(seeProof(Exact)).then(persistIntent).then(authorize(1)).then(open(1))
    .then(finishCleanup(1)).then(cancel(1))
    .expect(s.intent and s.spool == Absent and s.lock == 0)
    .then(authorizeSecond).then(observeAbsentSecond).then(retireSecond).expect(not(s.intent))

  run failedOpenPreservesSpoolAndIntentTest = init
    .then(seeProof(Exact)).then(persistIntent).then(authorize(1)).then(openFailed(1))
    .expect(s.intent and s.spool == Whole and s.phase == Idle and s.lock == 0)

  run failedOpenWithUncertainReleaseKeepsIntentTest = init
    .then(seeProof(Exact)).then(persistIntent).then(authorize(1)).then(openReleaseUnknown(1))
    .expect(s.phase == ReleaseUnknown and s.intent and s.spool == Whole and LockMatchesExecution)

  run unknownReleaseCannotConfirmCleanupTest = init
    .then(seeProof(Exact)).then(persistIntent).then(authorize(1)).then(open(1))
    .then(cancel(1)).then(releaseFailed(1))
    .expect(s.phase == ReleaseUnknown and s.intent and s.spool == Whole and LockMatchesExecution)
}
