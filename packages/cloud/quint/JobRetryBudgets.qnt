// Detached-job budget transitions from jobs.ts. One live generation can have
// two concurrent repository calls. Completed calls release their snapshots.
// UUIDs are fresh bounded integers; all rows and callbacks share one tenant.
// A successful budget commit leaves in_progress. Every other prepared call
// from that generation must lose the source status/generation CAS before a
// dependent writeback can run. Keep its pending-completion phase but discard
// fields that can no longer affect job counters, leases or durable receipts.
// Pre-commit storage preparation can still fail; its contents are outside this
// database projection and remain the Finish(storageSucceeds=false) outcome.
// The lease authority model separately covers missing and foreign resources.
module JobRetryBudgets {
  const Operations: Set[str]
  const Kind: str
  const RequeueBound: int
  const RequeueDelayMs: int
  const GenerationBound: int
  const Initial: Counters
  type Counters = { attempts: int, interruptions: int, requeues: int }
  type Call = {
    phase: str, operation: str, generation: int, owner: int,
    counters: Counters, payloadVersion: int, preserves: bool
  }
  type Receipt = {
    operation: str, before: Counters, after: Counters, preserves: bool,
    failed: bool, delayMs: int
  }
  type State = {
    status: str, generation: int, counters: Counters,
    leaseOwner: int, leaseAge: int, quiesced: bool, old: bool, due: bool,
    payloadVersion: int, cutoverValid: bool, additionalFence: bool,
    calls: int -> Call, dependentFailed: bool, last: Receipt,
    staleCommitted: bool, payloadMismatchCommitted: bool
  }
  pure val Callers = Set(1, 2)
  pure val MaxAttempts = 3
  pure val MaxInterruptions = 5
  pure val EmptyCounters = {attempts: 0, interruptions: 0, requeues: 0}
  pure val EmptyCall = {
    phase: "new", operation: "none", generation: 0, owner: 0,
    counters: EmptyCounters, payloadVersion: 0, preserves: false
  }
  var s: State

  action init = s' = {
    status: "in_progress", generation: 1, counters: Initial,
    leaseOwner: 1, leaseAge: 0, quiesced: false, old: false, due: true,
    payloadVersion: 0, cutoverValid: Kind == "canary", additionalFence: true,
    calls: Callers.mapBy(_ => EmptyCall), dependentFailed: false,
    last: {operation: "none", before: Initial, after: Initial, preserves: false,
      failed: false, delayMs: 0}, staleCommitted: false, payloadMismatchCommitted: false
  }
  pure def IsRecovery(operation: str): bool = Set("timeout", "restart").contains(operation)
  pure def Preserves(operation: str, cutoverValid: bool): bool = or {
    IsRecovery(operation) and Kind == "canary" and cutoverValid,
    operation == "timeout" and Kind == "durable"
  }
  def LiveOwner(call: Call): bool = call.owner == s.leaseOwner and s.leaseAge == 0
  def Current(call: Call): bool = and {
    s.status == "in_progress", not(s.quiesced), call.generation == s.generation,
    if (IsRecovery(call.operation)) and {
      s.old, s.leaseAge == 2, call.counters == s.counters,
      not(call.preserves and Kind == "canary") or call.payloadVersion == s.payloadVersion
    } else if (call.operation == "attempt") and {
      LiveOwner(call), call.counters.attempts == s.counters.attempts, s.additionalFence
    } else and {
      LiveOwner(call), call.counters == s.counters, call.payloadVersion == s.payloadVersion
    }
  }
  pure def NextCounters(call: Call): Counters = {
    attempts: call.counters.attempts +
      (if (call.operation == "attempt" or (call.operation == "timeout" and not(call.preserves))) 1 else 0),
    interruptions: call.counters.interruptions +
      (if (call.operation == "restart" and not(call.preserves)) 1 else 0),
    requeues: call.counters.requeues +
      (if (call.operation == "requeue" and RequeueBound >= 0) 1 else 0)
  }
  pure def Exhausted(call: Call, afterCounters: Counters): bool = if (call.operation == "attempt") {
    afterCounters.attempts >= MaxAttempts
  } else if (call.operation == "timeout") {
    not(call.preserves) and afterCounters.attempts >= MaxAttempts
  } else if (call.operation == "restart") {
    not(call.preserves) and afterCounters.interruptions > MaxInterruptions
  } else RequeueBound >= 0 and afterCounters.requeues > RequeueBound

  action Prepare(id: int, operation: str, owner: int): bool = all {
    Operations.contains(operation), s.calls.get(id).phase == "new", s.status == "in_progress",
    not(IsRecovery(operation)) or (s.old and s.leaseAge == 2),
    s' = {...s, calls: s.calls.set(id, {
      phase: "prepared", operation: operation, generation: s.generation, owner: owner,
      counters: s.counters, payloadVersion: s.payloadVersion,
      preserves: Preserves(operation, s.cutoverValid)
    })}
  }
  action Finish(id: int, storageSucceeds: bool): bool = {
    val call = s.calls.get(id)
    val afterCounters = NextCounters(call)
    val failed = Exhausted(call, afterCounters)
    val done = s.calls.set(id, {...EmptyCall, phase: "done"})
    val committedCalls = Callers.mapBy(other =>
      if (other == id) {...EmptyCall, phase: "done"}
      else if (s.calls.get(other).phase == "prepared") {...EmptyCall, phase: "prepared"}
      else s.calls.get(other))
    val delay = if (failed or IsRecovery(call.operation)) 0
      else if (call.operation == "attempt") 4.ipow(afterCounters.attempts - 1) * 30000
      else RequeueDelayMs
    all {
      call.phase == "prepared",
      s' = if (not(storageSucceeds) or not(Current(call))) {...s, calls: done}
      else {
        ...s, calls: committedCalls, status: if (failed) "failed" else "pending", counters: afterCounters,
        leaseOwner: 0, leaseAge: 0, quiesced: true,
        due: if (IsRecovery(call.operation)) s.due else delay == 0,
        dependentFailed: failed,
        last: {operation: call.operation, before: s.counters, after: afterCounters,
          preserves: call.preserves, failed: failed, delayMs: delay},
        staleCommitted: s.staleCommitted or call.generation != s.generation or
          (not(IsRecovery(call.operation)) and not(LiveOwner(call))),
        payloadMismatchCommitted: s.payloadMismatchCommitted or
          ((call.operation == "requeue" or (call.preserves and Kind == "canary")) and
            call.payloadVersion != s.payloadVersion)
      }
    }
  }
  action ResetCall(id: int): bool = all {
    s.calls.get(id).phase == "done", s' = {...s, calls: s.calls.set(id, EmptyCall)}
  }
  action Claim(owner: int): bool = all {
    s.status == "pending", s.due, s.generation < GenerationBound,
    s' = {...s, status: "in_progress", generation: s.generation + 1,
      leaseOwner: owner, leaseAge: 0, quiesced: false, old: false}
  }
  action Renew = all {
    s.status == "in_progress", s' = {...s, leaseAge: 0}
  }
  action Expire = all {s.status == "in_progress", s.leaseAge == 0, s' = {...s, leaseAge: 1}}
  action GraceEnds = all {s.status == "in_progress", s.leaseAge == 1, s' = {...s, leaseAge: 2}}
  action Age = all {s.status == "in_progress", not(s.old), s' = {...s, old: true}}
  action DelayEnds = all {s.status == "pending", not(s.due), s' = {...s, due: true}}
  action WriteProgress = all {
    s.status == "in_progress", s.leaseAge == 0, s.payloadVersion < 2,
    s' = {...s, payloadVersion: s.payloadVersion + 1}
  }
  action InvalidateCutover = all {
    Kind == "canary", s.cutoverValid, s.payloadVersion < 2,
    s' = {...s, cutoverValid: false, payloadVersion: s.payloadVersion + 1}
  }
  action InvalidateAdditionalFence = all {
    s.additionalFence, s' = {...s, additionalFence: false}
  }
  action step = any {
    {nondet id = Callers.oneOf(); nondet operation = Operations.oneOf(); nondet owner = Callers.oneOf(); Prepare(id, operation, owner)},
    {nondet id = Callers.oneOf(); nondet succeeds = Set(true, false).oneOf(); Finish(id, succeeds)},
    {nondet id = Callers.oneOf(); ResetCall(id)},
    {nondet owner = Callers.oneOf(); Claim(owner)},
    Renew, Expire, GraceEnds, Age, DelayEnds, WriteProgress, InvalidateCutover,
    InvalidateAdditionalFence, s' = s
  }
  val TypeOK = and {
    Set("pending", "in_progress", "failed").contains(s.status),
    1 <= s.generation and s.generation <= GenerationBound,
    0 <= s.counters.attempts and s.counters.attempts <= MaxAttempts,
    0 <= s.counters.interruptions and s.counters.interruptions <= MaxInterruptions + 1,
    0 <= s.counters.requeues and s.counters.requeues <= (if (RequeueBound < 0) Initial.requeues else RequeueBound + 1),
    Set(0, 1, 2).contains(s.leaseOwner), Set(0, 1, 2).contains(s.leaseAge),
    Set(0, 1, 2).contains(s.payloadVersion), s.calls.keys() == Callers,
    Callers.forall(id => Set("new", "prepared", "done").contains(s.calls.get(id).phase))
  }
  val LeaseAndQuiescenceAgree = if (s.status == "in_progress") {
    Callers.contains(s.leaseOwner) and not(s.quiesced)
  } else s.leaseOwner == 0 and s.quiesced
  val FailureWritebackAtomic = s.dependentFailed == (s.status == "failed")
  val ExhaustionRequiresBudget = s.status != "failed" or or {
    s.counters.attempts >= MaxAttempts, s.counters.interruptions > MaxInterruptions,
    RequeueBound >= 0 and s.counters.requeues > RequeueBound
  }
  val ExhaustedBudgetIsTerminal = not(or {
    s.counters.attempts >= MaxAttempts, s.counters.interruptions > MaxInterruptions,
    RequeueBound >= 0 and s.counters.requeues > RequeueBound
  }) or s.status == "failed"
  val BudgetSeparation = if (s.last.operation == "none") true else {
    val delta = {
      attempts: s.last.after.attempts - s.last.before.attempts,
      interruptions: s.last.after.interruptions - s.last.before.interruptions,
      requeues: s.last.after.requeues - s.last.before.requeues
    }
    if (s.last.operation == "attempt" or (s.last.operation == "timeout" and not(s.last.preserves))) {
      delta == {attempts: 1, interruptions: 0, requeues: 0}
    } else if (s.last.operation == "restart" and not(s.last.preserves)) {
      delta == {attempts: 0, interruptions: 1, requeues: 0}
    } else if (s.last.operation == "requeue" and RequeueBound >= 0) {
      delta == {attempts: 0, interruptions: 0, requeues: 1}
    } else delta == EmptyCounters
  }
  val BackoffMatchesAttempt = s.last.operation != "attempt" or s.last.failed or
    s.last.delayMs == 4.ipow(s.last.after.attempts - 1) * 30000
  val StaleGenerationCannotCommit = not(s.staleCommitted)
  val FullSnapshotRequired = not(s.payloadMismatchCommitted)
  val safety = TypeOK and LeaseAndQuiescenceAgree and FailureWritebackAtomic and
    ExhaustionRequiresBudget and ExhaustedBudgetIsTerminal and BudgetSeparation and BackoffMatchesAttempt and
    StaleGenerationCannotCommit and FullSnapshotRequired
  temporal PendingCallsFinish = Callers.forall(id => Finish(id, true).weakFair(s)) implies
    always(Callers.forall(id => s.calls.get(id).phase == "prepared" implies
      eventually(s.calls.get(id).phase != "prepared")))
}

module JobRetryBudgets_attempt {
  import JobRetryBudgets(Operations = Set("attempt"), Kind = "ordinary", RequeueBound = 5,
    RequeueDelayMs = 120000, GenerationBound = 3,
    Initial = {attempts: 0, interruptions: 2, requeues: 2}).*
  run threeFailuresExhaustAttemptsTest = init.then(Prepare(1, "attempt", 1)).then(Finish(1, true))
    .expect(s.counters.attempts == 1 and s.last.delayMs == 30000)
    .then(DelayEnds).then(Claim(1)).then(ResetCall(1)).then(Prepare(1, "attempt", 1)).then(Finish(1, true))
    .expect(s.counters.attempts == 2 and s.last.delayMs == 120000)
    .then(DelayEnds).then(Claim(1)).then(ResetCall(1)).then(Prepare(1, "attempt", 1)).then(Finish(1, true))
    .expect(safety and s.status == "failed" and s.counters.attempts == 3)
  run failedWritebackPreservesAttemptAndLeaseTest = init.then(Prepare(1, "attempt", 1))
    .then(Finish(1, false)).expect(safety and s.status == "in_progress" and s.counters.attempts == 0)
  run losingConcurrentAttemptCannotSpendTwiceTest = init.then(Prepare(1, "attempt", 1))
    .then(Prepare(2, "attempt", 1)).then(Finish(1, true)).then(Finish(2, true))
    .expect(safety and s.counters.attempts == 1)
}
module JobRetryBudgets_timeout {
  import JobRetryBudgets(Operations = Set("timeout"), Kind = "ordinary", RequeueBound = 5,
    RequeueDelayMs = 120000, GenerationBound = 3,
    Initial = {attempts: 0, interruptions: 2, requeues: 2}).*
  run timedOutExecutionSpendsOnlyAttemptTest = init.then(Age).then(Expire).then(GraceEnds)
    .then(Prepare(1, "timeout", 1)).then(Finish(1, true))
    .expect(safety and s.counters == {attempts: 1, interruptions: 2, requeues: 2} and s.due)
  run renewedLeaseInvalidatesTimeoutTest = init.then(Age).then(Expire).then(GraceEnds)
    .then(Prepare(1, "timeout", 1)).then(Renew).then(Finish(1, true))
    .expect(safety and s.status == "in_progress" and s.counters.attempts == 0)
}
module JobRetryBudgets_restart {
  import JobRetryBudgets(Operations = Set("restart"), Kind = "ordinary", RequeueBound = 5,
    RequeueDelayMs = 120000, GenerationBound = 6,
    Initial = {attempts: 2, interruptions: 0, requeues: 2}).*
  run sixthInterruptionIsTerminalTest = init.then(5.reps(_ => Age.then(Expire).then(GraceEnds)
    .then(Prepare(1, "restart", 1)).then(Finish(1, true)).then(Claim(1)).then(ResetCall(1))))
    .expect(s.counters.interruptions == 5 and s.status == "in_progress")
    .then(Age).then(Expire).then(GraceEnds).then(Prepare(1, "restart", 1)).then(Finish(1, true))
    .expect(safety and s.status == "failed" and s.counters.interruptions == 6)
}
module JobRetryBudgets_transport {
  import JobRetryBudgets(Operations = Set("requeue"), Kind = "ordinary", RequeueBound = 5,
    RequeueDelayMs = 120000, GenerationBound = 6,
    Initial = {attempts: 2, interruptions: 2, requeues: 0}).*
  run changedPayloadRejectsStaleRequeueTest = init.then(Prepare(1, "requeue", 1))
    .then(WriteProgress).then(Finish(1, true))
    .expect(safety and s.status == "in_progress" and s.counters.requeues == 0)
  run sixthTransportRequeueIsTerminalTest = init.then(5.reps(_ => Prepare(1, "requeue", 1)
    .then(Finish(1, true)).then(DelayEnds).then(Claim(1)).then(ResetCall(1))))
    .expect(s.counters.requeues == 5 and s.status == "in_progress")
    .then(Prepare(1, "requeue", 1)).then(Finish(1, true))
    .expect(safety and s.status == "failed" and s.counters.requeues == 6)
}
module JobRetryBudgets_capture {
  import JobRetryBudgets(Operations = Set("requeue"), Kind = "ordinary", RequeueBound = 10,
    RequeueDelayMs = 120000, GenerationBound = 11,
    Initial = {attempts: 2, interruptions: 2, requeues: 0}).*
  run eleventhCaptureRequeueIsTerminalTest = init.then(10.reps(_ => Prepare(1, "requeue", 1)
    .then(Finish(1, true)).then(DelayEnds).then(Claim(1)).then(ResetCall(1))))
    .expect(s.counters.requeues == 10 and s.status == "in_progress")
    .then(Prepare(1, "requeue", 1)).then(Finish(1, true))
    .expect(safety and s.status == "failed" and s.counters.requeues == 11)
}
module JobRetryBudgets_unbounded {
  import JobRetryBudgets(Operations = Set("requeue"), Kind = "ordinary", RequeueBound = -1,
    RequeueDelayMs = 600000, GenerationBound = 2,
    Initial = {attempts: 2, interruptions: 2, requeues: 5}).*
  run unboundedGateDoesNotSpendAnyBudgetTest = init.then(Prepare(1, "requeue", 1)).then(Finish(1, true))
    .expect(safety and s.counters == {attempts: 2, interruptions: 2, requeues: 5})
}
module JobRetryBudgets_durable {
  import JobRetryBudgets(Operations = Set("timeout"), Kind = "durable", RequeueBound = 5,
    RequeueDelayMs = 120000, GenerationBound = 2,
    Initial = {attempts: 2, interruptions: 2, requeues: 2}).*
  run durableTimeoutKeepsAttemptsTest = init.then(Age).then(Expire).then(GraceEnds)
    .then(Prepare(1, "timeout", 1)).then(Finish(1, true))
    .expect(safety and s.status == "pending" and s.counters.attempts == 2)
}
module JobRetryBudgets_canary {
  import JobRetryBudgets(Operations = Set("timeout", "restart"), Kind = "canary", RequeueBound = 5,
    RequeueDelayMs = 120000, GenerationBound = 3,
    Initial = {attempts: 2, interruptions: 2, requeues: 2}).*
  run changedCutoverCannotUseStalePreservationTest = init.then(Age).then(Expire).then(GraceEnds)
    .then(Prepare(1, "timeout", 1)).then(InvalidateCutover).then(Finish(1, true))
    .expect(s.status == "in_progress").then(ResetCall(1))
    .then(Prepare(1, "timeout", 1)).then(Finish(1, true))
    .expect(safety and s.status == "failed" and s.counters.attempts == 3)
}
module JobRetryBudgets_mixed {
  import JobRetryBudgets(Operations = Set("attempt", "timeout", "restart", "requeue"), Kind = "ordinary",
    RequeueBound = 0, RequeueDelayMs = 120000, GenerationBound = 8,
    Initial = {attempts: 0, interruptions: 0, requeues: 0}).*
  run recoveredGenerationFencesOldFailureTest = init.then(Prepare(1, "attempt", 1))
    .then(Age).then(Expire).then(GraceEnds).then(Prepare(2, "restart", 1)).then(Finish(2, true))
    .then(Claim(2)).then(Finish(1, true))
    .expect(safety and s.counters == {attempts: 0, interruptions: 1, requeues: 0})
}
