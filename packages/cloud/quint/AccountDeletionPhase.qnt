// Four lease generations, two workers, three attempts and logical clock 0..6.
// Provider phase of account-deletion-saga, with two workers, durable before-call
// marker, finite leases and generation-guarded repository updates.
module AccountDeletionPhase {
  pure val workers = Set(1, 2)
  var s: {
    status: str,
    generation: int,
    expiry: int,
    due: int,
    now: int,
    attempts: int,
    workerGeneration: int -> int,
    pc: int -> str,
    reconciling: int -> bool,
    provider: bool,
    receipt: bool,
    executionAdmitted: bool,
    completionAdmitted: bool
  }
  action init = s' = {
    status: "pending",
    generation: 0,
    expiry: 0,
    due: 0,
    now: 0,
    attempts: 0,
    workerGeneration: workers.mapBy(_ => 0),
    pc: workers.mapBy(_ => "idle"),
    reconciling: workers.mapBy(_ => false),
    provider: false,
    receipt: false,
    executionAdmitted: true,
    completionAdmitted: true
  }
  action lease(w: int): bool = all {
    s.pc.get(w) == "idle",
    s.generation < 4,
    not(Set("completed", "action_required").contains(s.status)),
    s.expiry <= s.now,
    s.due <= s.now,
    s' = if (s.attempts >= 3) s
      .with("status", "action_required") else s
      .with("generation", s.generation + 1)
      .with("expiry", s.now + 3)
      .with("status", if (Set("calling", "reconciling").contains(s.status)) "reconciling" else "leased")
      .with("workerGeneration", s.workerGeneration.set(w, s.generation + 1))
      .with("reconciling", s.reconciling.set(w, Set("calling", "reconciling").contains(s.status)))
      .with("pc", s.pc.set(w, "inspect"))
  }
  action inspect(w: int, failure: bool): bool = all {
    s.pc.get(w) == "inspect",
    s' = if (failure) s
      .with("pc", s.pc.set(w, "inspectionFailed")) else s
      .with("pc", s.pc.set(w, if (s.provider) "complete" else if (s.reconciling.get(w)) "absenceConfirmed" else "mark"))
  }
  // markPhaseRetryable/deferPhaseReconciliation never update a stale generation.
  action retry(w: int): bool = {
    val owns = s.workerGeneration.get(w) == s.generation
    val writable = owns and Set("leased", "reconciling").contains(s.status)
    val stillUnknown = s.reconciling.get(w) and s.pc.get(w) == "inspectionFailed"
    all {
      Set("inspectionFailed", "absenceConfirmed").contains(s.pc.get(w)),
      s' = s
          .with("pc", s.pc.set(w, "idle"))
          .with("status", if (writable) (if (stillUnknown) "reconciling" else "retry") else s.status)
          .with("expiry", if (writable) 0 else s.expiry)
          .with("due", if (writable) s.now + 1 else s.due)
    }
  }
  // markPhaseProviderCallStarted commits before adapter.execute is entered.
  action mark(w: int): bool = {
    val currentLease = s.workerGeneration.get(w) == s.generation and s.status == "leased"
    all {
      s.pc.get(w) == "mark",
      s' = if (currentLease) s
          .with("status", "calling")
          .with("attempts", s.attempts + 1)
          .with("pc", s.pc.set(w, "execute"))
          .with("executionAdmitted", not(s.reconciling.get(w)))
      else s.with("pc", s.pc.set(w, "idle"))
    }
  }
  // A provider can apply the effect before its response is lost.
  action execute(w: int, applied: bool, ambiguous: bool): bool = all {
    s.pc.get(w) == "execute",
    s' = s
        .with("provider", s.provider or applied)
        .with("pc", s.pc.set(w, if (ambiguous) "ambiguous" else "postInspect"))
  }
  // Inspection after execute confirms completion or retains the unknown outcome.
  action postInspect(w: int, failure: bool): bool = all {
    s.pc.get(w) == "postInspect",
    s' = s.with("pc", s.pc.set(w,
      if (s.provider and not(failure)) "complete" else "ambiguous"))
  }
  // markPhaseForReconciliation preserves the before-call receipt across retries.
  action ambiguous(w: int): bool = {
    val currentCall = s.workerGeneration.get(w) == s.generation and s.status == "calling"
    all {
      s.pc.get(w) == "ambiguous",
      s' = s
          .with("pc", s.pc.set(w, "idle"))
          .with("status", if (currentCall) "reconciling" else s.status)
          .with("expiry", if (currentCall) 0 else s.expiry)
          .with("due", if (currentCall) s.now + 1 else s.due)
    }
  }
  // completeProviderPhase checks both the generation and the live lease at commit.
  action complete(w: int): bool = {
    val valid = and {
      s.workerGeneration.get(w) == s.generation,
      Set("leased", "calling", "reconciling").contains(s.status),
      s.expiry > s.now
    }
    all {
      s.pc.get(w) == "complete",
      s' = s
          .with("pc", s.pc.set(w, "idle"))
          .with("status", if (valid) "completed" else s.status)
          .with("expiry", if (valid) 0 else s.expiry)
          .with("receipt", s.receipt or valid)
          .with("completionAdmitted", s.completionAdmitted and (not(valid) or s.provider))
    }
  }
  // Either inspection can require operator action instead of another mutation.
  action requireAction(w: int): bool = {
    val writable = and {
      s.workerGeneration.get(w) == s.generation,
      Set("leased", "calling", "reconciling").contains(s.status)
    }
    all {
      Set("inspect", "postInspect").contains(s.pc.get(w)),
      s' = s
          .with("pc", s.pc.set(w, "idle"))
          .with("status", if (writable) "action_required" else s.status)
          .with("expiry", if (writable) 0 else s.expiry)
    }
  }
  action tick = all {
    s.now < 6,
    s' = s
      .with("now", s.now + 1)
  }
  action step = {
    nondet w = workers.oneOf();
    nondet applied = Set(true, false).oneOf();
    nondet failure = Set(true, false).oneOf();
    any {
      lease(w),
      inspect(w, failure),
      retry(w),
      mark(w),
      execute(w, applied, failure),
      postInspect(w, failure),
      ambiguous(w),
      complete(w),
      requireAction(w),
      tick
    }
  }
  val invariant = and {
    s.executionAdmitted,
    s.completionAdmitted,
    (s.status == "completed") implies (s.receipt and s.provider),
    s.attempts >= 0
  }
}
