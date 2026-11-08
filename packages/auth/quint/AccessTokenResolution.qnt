// getAccessToken orchestration in src/auth/credentials.ts. RefreshMutex supplies
// each process-local FIFO queue. AccountCredentialGeneration supplies the atomic
// generation compare-and-swap. The model composes those boundaries with provider
// settlement, expiry decisions, policy epochs and the caller's returned outcome.
module AccessTokenResolution {
  val callers = Set(1, 2)
  val roots = Set(1, 2)
  val processes = Set(1, 2)
  val kinds = Set("direct", "fixed", "external", "unavailable", "oauth")
  val providerErrors = Set(
    "invalid-grant", "validation", "unauthorized", "forbidden",
    "rate-limit", "server", "network", "malformed"
  )
  type Credential = { generation: int, token: int, refresh: int, expires: int }
  type Request = {
    phase: str,
    root: int,
    process: int,
    policyEpoch: int,
    buffer: int,
    requestedBuffer: int,
    observed: Credential,
    issuedRefresh: int,
    responseToken: int,
    responseRefresh: int,
    responseLifetime: int,
    outcome: str,
    resultToken: int,
    resultGeneration: int,
    resultExpires: int,
    decisionTime: int,
    refreshed: bool,
    didPublish: bool,
    committedGeneration: int,
    errorFamily: str,
  }
  type State = {
    kind: str,
    records: int -> Credential,
    previousRecords: int -> Credential,
    epochs: int -> int,
    requests: int -> Request,
    queues: int -> List[int],
    active: int -> int,
    usedGrants: Set[int],
    nextGeneration: int,
    mutationUsed: bool,
    now: int,
    lastAction: str,
    lastCaller: int,
  }
  var s: State
  val absent = { generation: 0, token: 0, refresh: 0, expires: 0 }

  pure def request(root: int, process: int, policy: int, buffer: int, phase: str): Request = {
    phase: phase, root: root, process: process, policyEpoch: policy,
    buffer: if (buffer > 1) buffer else 1, requestedBuffer: buffer,
    observed: absent, issuedRefresh: 0, responseToken: 0, responseRefresh: 0,
    responseLifetime: 0, outcome: "pending", resultToken: 0, resultGeneration: 0, resultExpires: 0,
    decisionTime: 0, refreshed: false, didPublish: false,
    committedGeneration: 0, errorFamily: "",
  }
  pure def initial(kind: str, expires: int, first: Request, second: Request): State = {
    val records = roots.mapBy(root => {
      generation: root, token: root, refresh: root, expires: expires,
    })
    {
      kind: kind, records: records, previousRecords: records,
      epochs: roots.mapBy(_ => 0), requests: Map(1 -> first, 2 -> second),
      queues: processes.mapBy(_ => []), active: processes.mapBy(_ => 0),
      usedGrants: Set(), nextGeneration: 3, mutationUsed: false, now: 0,
      lastAction: "init", lastCaller: 1,
    }
  }
  action initAdmission = {
    nondet kind = kinds.oneOf()
    nondet expiry = Set(0, 1, 2, 3, 5).oneOf()
    // Negative values identify NaN/infinity/nonpositive input classes; 0 is omitted.
    nondet buffer = Set(-3, -2, -1, 0, 1, 2, 3).oneOf()
    nondet policy = Set(-2, -1, 0).oneOf()
    nondet present = Set(true, false).oneOf()
    val base = initial(kind, expiry, request(1, 1, policy, buffer, "idle"), request(2, 2, 0, 1, "unused"))
    s' = if (present) base else { ...base, records: base.records.set(1, absent) }
  }
  action initSameProcess = {
    nondet firstBuffer = Set(1, 2).oneOf()
    nondet secondBuffer = Set(1, 2).oneOf()
    s' = initial("oauth", 0, request(1, 1, 0, firstBuffer, "idle"), request(1, 1, 0, secondBuffer, "idle"))
  }
  action initSeparateProcesses = s' = initial("oauth", 0,
    request(1, 1, 0, 1, "idle"), request(1, 2, 0, 1, "idle"))
  action initSeparateRoots = s' = initial("oauth", 0,
    request(1, 1, 0, 1, "idle"), request(2, 1, 0, 1, "idle"))

  pure def finished(state: State, c: int, outcome: str, selected: Credential, refreshed: bool): State = {
    val r = state.requests.get(c)
    {
      ...state,
      requests: state.requests.set(c, {
        ...r, phase: "done", outcome: outcome, resultToken: if (outcome == "ok") selected.token else 0,
        resultExpires: selected.expires, resultGeneration: selected.generation,
        decisionTime: state.now, refreshed: refreshed,
      }),
      queues: state.queues.set(r.process, state.queues.get(r.process).select(id => id != c)),
      active: if (state.active.get(r.process) == c) state.active.set(r.process, 0) else state.active,
    }
  }
  pure def usable(record: Credential, now: int, buffer: int): bool = record.expires > now + buffer
  def policyValid(c: int): bool = s.requests.get(c).policyEpoch == -2 or
    s.requests.get(c).policyEpoch == s.epochs.get(s.requests.get(c).root)

  // Initial read plus synchronous decision, before entering the keyed queue.
  action start(c: int): bool = {
    val r = s.requests.get(c)
    val record = s.records.get(r.root)
    val observed = { ...s, requests: s.requests.set(c, { ...r, observed: record }), lastAction: "start", lastCaller: c }
    all {
      r.phase == "idle",
      s' = if (not(policyValid(c))) finished(observed, c, "storage-error", absent, false)
      else if (record.generation == 0) finished(observed, c, "auth", absent, false)
      else if (s.kind == "direct") finished(observed, c,
        if (record.expires > s.now) "ok" else "auth", record, false)
      else if (usable(record, s.now, r.buffer)) finished(observed, c, "ok", record, false)
      else if (s.kind == "fixed") finished(observed, c,
        if (record.expires <= s.now) "auth" else if (r.buffer == 1) "ok" else "insufficient", record, false)
      else if (s.kind.in(Set("external", "unavailable"))) finished(observed, c, "auth", record, false)
      else {
        ...observed,
        requests: observed.requests.set(c, { ...r, phase: "queued", observed: record }),
        queues: s.queues.set(r.process, s.queues.get(r.process).append(c)),
      },
    }
  }
  // The FIFO owner rereads the account and checks explicit write authority.
  action admit(c: int): bool = {
    val r = s.requests.get(c)
    val current = s.records.get(r.root)
    val observed = {
      ...s, requests: s.requests.set(c, { ...r, observed: current }),
      active: s.active.set(r.process, c), lastAction: "admit", lastCaller: c,
    }
    all {
      r.phase == "queued", s.active.get(r.process) == 0,
      s.queues.get(r.process).head() == c,
      s' = if (not(policyValid(c))) finished(observed, c, "storage-error", absent, false)
      else if (current.generation == 0) finished(observed, c, "auth", absent, false)
      else if (usable(current, s.now, r.buffer)) finished(observed, c, "ok", current, false)
      else if (r.policyEpoch == -2) finished(observed, c, "policy-error", absent, false)
      else {
        ...observed,
        requests: observed.requests.set(c, {
          ...r, phase: "provider", observed: current, issuedRefresh: current.refresh,
        }),
      },
    }
  }
  action providerSuccess(c: int, lifetime: int, rotate: bool): bool = {
    val r = s.requests.get(c)
    all {
      r.phase == "provider", not(s.usedGrants.contains(r.issuedRefresh)),
      s' = {
        ...s, lastAction: "provider-success", lastCaller: c,
        usedGrants: if (rotate) s.usedGrants.union(Set(r.issuedRefresh)) else s.usedGrants,
        requests: s.requests.set(c, {
          ...r, phase: "commit", responseToken: c + 2,
          responseRefresh: if (rotate) c + 2 else r.issuedRefresh,
          responseLifetime: lifetime,
        }),
      },
    }
  }
  action providerFailure(c: int, reason: str, consumed: bool): bool = {
    val r = s.requests.get(c)
    val kind = if (reason.in(Set("invalid-grant", "unauthorized", "forbidden"))) "auth" else "transient"
    all {
      r.phase == "provider",
      not(consumed) or reason.in(Set("network", "malformed", "timeout")),
      s' = finished({
        ...s, previousRecords: s.records, lastAction: "provider-failure", lastCaller: c,
        usedGrants: if (consumed) s.usedGrants.union(Set(r.issuedRefresh)) else s.usedGrants,
        requests: s.requests.set(c, { ...r, errorFamily: reason }),
      }, c, kind, r.observed, false),
    }
  }
  // The provider has settled. The storage CAS owns its own linearization point.
  action commit(c: int): bool = {
    val r = s.requests.get(c)
    val current = s.records.get(r.root)
    val fresh = {
      generation: s.nextGeneration, token: r.responseToken, refresh: r.responseRefresh,
      expires: s.now + r.responseLifetime,
    }
    val before = { ...s, previousRecords: s.records, lastAction: "commit", lastCaller: c }
    val updated = {
      ...before, records: s.records.set(r.root, fresh), nextGeneration: s.nextGeneration + 1,
      requests: s.requests.set(c, { ...r, didPublish: true, committedGeneration: fresh.generation }),
    }
    all {
      r.phase == "commit",
      s' = if (not(policyValid(c))) finished(before, c, "storage-error", absent, false)
      else if (current.generation == 0) finished(before, c, "auth", r.observed, false)
      else if (current.generation != r.observed.generation) finished(before, c,
        if (usable(current, s.now, r.buffer)) "ok"
        else if (current.expires > s.now) "insufficient" else "auth",
        current, false)
      else finished(updated, c,
        if (usable(fresh, s.now, r.buffer)) "ok" else "insufficient", fresh, usable(fresh, s.now, r.buffer)),
    }
  }
  action storageFailure(c: int, published: bool): bool = {
    val r = s.requests.get(c)
    val current = s.records.get(r.root)
    val fresh = {
      generation: s.nextGeneration, token: r.responseToken, refresh: r.responseRefresh,
      expires: s.now + r.responseLifetime,
    }
    all {
      r.phase == "commit", policyValid(c), current.generation == r.observed.generation,
      s' = finished({
        ...s, previousRecords: s.records, lastAction: "storage-failure", lastCaller: c,
        records: if (published) s.records.set(r.root, fresh) else s.records,
        nextGeneration: s.nextGeneration + if (published) 1 else 0,
        requests: s.requests.set(c, { ...r, didPublish: published,
          committedGeneration: if (published) fresh.generation else 0 }),
      }, c, "storage-error", absent, false),
    }
  }
  action mutate(root: int, operation: str, expires: int): bool = all {
    not(s.mutationUsed), callers.exists(c => s.requests.get(c).phase.in(Set("queued", "provider", "commit"))),
    s' = {
      ...s, mutationUsed: true, previousRecords: s.records, lastAction: operation, lastCaller: 1,
      records: s.records.set(root, if (operation == "replace") {
        generation: s.nextGeneration, token: 5, refresh: 5, expires: expires,
      } else absent),
      nextGeneration: s.nextGeneration + if (operation == "replace") 1 else 0,
      epochs: if (operation == "reset") s.epochs.set(root, s.epochs.get(root) + 1) else s.epochs,
    },
  }
  action tick = all { s.now < 3, s' = { ...s, now: s.now + 1, lastAction: "tick" } }
  action providerWork(c: int): bool = any {
    { nondet life = Set(1, 4).oneOf() nondet rotate = Set(true, false).oneOf() providerSuccess(c, life, rotate) },
    {
      nondet reason = providerErrors.oneOf()
      nondet consumed = Set(true, false).oneOf()
      providerFailure(c, reason, consumed)
    },
  }
  // The request signal aborts headers/body I/O after the refresh deadline.
  action providerDeadline(c: int): bool = {
    nondet consumed = Set(true, false).oneOf()
    providerFailure(c, "timeout", consumed)
  }
  action commitWork(c: int): bool = any { commit(c), storageFailure(c, false), storageFailure(c, true) }
  action step = any {
    { nondet c = callers.oneOf() any { start(c), admit(c), providerWork(c), providerDeadline(c), commitWork(c) } },
    { nondet root = roots.oneOf() nondet operation = Set("replace", "delete", "reset").oneOf()
      nondet expiry = Set(0, 5).oneOf() mutate(root, operation, expiry) },
    tick, s' = s,
  }

  val TypeOK = and {
    s.kind.in(kinds), s.now >= 0 and s.now <= 3,
    s.nextGeneration >= 3 and s.nextGeneration <= 6,
    roots.forall(root => {
      val record = s.records.get(root)
      record.generation >= 0 and record.generation <= 5 and
      record.token >= 0 and record.token <= 5 and
      record.refresh >= 0 and record.refresh <= 5 and
      record.expires >= 0 and record.expires <= 7
    }),
    callers.forall(c => s.requests.get(c).outcome.in(
      Set("pending", "ok", "auth", "transient", "insufficient", "policy-error", "storage-error"))),
  }
  val RequestedLifetimeNormalized = callers.forall(c => {
    val r = s.requests.get(c)
    r.buffer == (if (r.requestedBuffer > 1) r.requestedBuffer else 1)
  })
  val TokenResultMatchesOutcome = callers.forall(c => {
    val r = s.requests.get(c)
    (r.outcome == "ok") == (r.resultToken > 0)
  })
  val SuccessfulOutcomeOwnsGeneration = callers.forall(c => {
    val r = s.requests.get(c)
    r.outcome == "ok" implies r.resultGeneration > 0
  })
  val RejectedGrantKeepsCapturedGeneration = s.lastAction == "provider-failure" implies {
    val r = s.requests.get(s.lastCaller)
    r.resultGeneration == r.observed.generation
  }
  val CommitReceiptMatchesDecision = s.lastAction == "commit" implies {
    val r = s.requests.get(s.lastCaller)
    r.outcome == "storage-error" or r.resultGeneration ==
      (if (s.previousRecords.get(r.root).generation == 0) r.observed.generation
       else s.records.get(r.root).generation)
  }
  val ExplicitPolicyBeforeGrant = callers.forall(c =>
    s.requests.get(c).issuedRefresh == 0 or s.requests.get(c).policyEpoch != -2)
  val ActiveQueueOwnership = callers.forall(c => {
    val r = s.requests.get(c)
    r.phase.in(Set("provider", "commit")) implies
      s.active.get(r.process) == c and s.queues.get(r.process).head() == c
  })
  val QueueRereadsCurrentRecord = s.lastAction == "admit" implies {
    val r = s.requests.get(s.lastCaller)
    r.observed == s.records.get(r.root)
  }
  val StalePolicyCommitThrows = s.lastAction == "commit" implies {
    val r = s.requests.get(s.lastCaller)
    (r.policyEpoch != -2 and r.policyEpoch != s.epochs.get(r.root)) implies
      r.outcome == "storage-error" and not(r.didPublish)
  }
  val RefreshedRequiresPublication = callers.forall(c =>
    s.requests.get(c).refreshed implies s.requests.get(c).didPublish and s.requests.get(c).outcome == "ok")
  val SuccessfulLifetime = callers.forall(c => {
    val r = s.requests.get(c)
    r.outcome == "ok" implies r.resultExpires > r.decisionTime +
      if (s.kind == "direct" or (s.kind == "fixed" and r.buffer == 1)) 0 else r.buffer
  })
  val KnownFailureClassification = callers.forall(c => {
    val r = s.requests.get(c)
    r.errorFamily != "" implies r.outcome ==
      if (r.errorFamily.in(Set("invalid-grant", "unauthorized", "forbidden"))) "auth" else "transient"
  })
  val FailureDoesNotPublish = s.lastAction == "provider-failure" implies s.records == s.previousRecords
  val CommitStaysInPolicyRoot = s.lastAction.in(Set("commit", "storage-failure")) implies
    roots.forall(root => root == s.requests.get(s.lastCaller).root or
      s.records.get(root) == s.previousRecords.get(root))
  val RemovedRecordNotResurrected = s.lastAction == "commit" implies {
    val root = s.requests.get(s.lastCaller).root
    s.previousRecords.get(root).generation == 0 implies s.records.get(root).generation == 0
  }
  val ReplacementResultUsesCurrentCredential = s.lastAction == "commit" implies {
    val r = s.requests.get(s.lastCaller)
    val prior = s.previousRecords.get(r.root)
    (prior.generation != r.observed.generation and r.outcome == "ok") implies
      r.resultToken == prior.token and not(r.refreshed)
  }
  val StaleResponseCannotReplace = s.lastAction.in(Set("commit", "storage-failure")) implies {
    val r = s.requests.get(s.lastCaller)
    s.previousRecords.get(r.root).generation != r.observed.generation implies
      s.records.get(r.root) == s.previousRecords.get(r.root)
  }
  val RotatedGrantIsRetained = callers.forall(c => {
    val r = s.requests.get(c)
    r.didPublish and s.records.get(r.root).generation == r.committedGeneration implies
      s.records.get(r.root).refresh == r.responseRefresh
  })
  val invariant = and {
    TypeOK, RequestedLifetimeNormalized, TokenResultMatchesOutcome,
    SuccessfulOutcomeOwnsGeneration, RejectedGrantKeepsCapturedGeneration, CommitReceiptMatchesDecision,
    ExplicitPolicyBeforeGrant, ActiveQueueOwnership, QueueRereadsCurrentRecord,
    StalePolicyCommitThrows, ReplacementResultUsesCurrentCredential,
    RefreshedRequiresPublication,
    SuccessfulLifetime, KnownFailureClassification, FailureDoesNotPublish,
    CommitStaysInPolicyRoot, RemovedRecordNotResurrected, StaleResponseCannotReplace,
    RotatedGrantIsRetained,
  }
  temporal FairWork = callers.forall(c => and {
    start(c).weakFair(s), admit(c).weakFair(s), providerDeadline(c).weakFair(s), commitWork(c).weakFair(s),
  })
  temporal CallsSettle = FairWork.implies(eventually(callers.forall(c => s.requests.get(c).phase.in(Set("done", "unused")))))

  action initNoPolicy = s' = initial("oauth", 0,
    request(1, 1, -2, 1, "idle"), request(1, 1, 0, 1, "unused"))
  run missingPolicyDoesNotSpendGrantTest = initNoPolicy.then(start(1)).then(admit(1))
    .expect(s.requests.get(1).outcome == "policy-error" and s.requests.get(1).issuedRefresh == 0)
  run queuedCallerUsesRotatedTokenTest = initSameProcess.then(start(1)).then(start(2))
    .then(admit(1)).then(providerSuccess(1, 4, true)).then(commit(1)).then(admit(2))
    .expect(s.requests.get(2).outcome == "ok" and s.requests.get(2).issuedRefresh == 0)
  run deletedAccountCannotReturnRefreshedTokenTest = initSeparateProcesses.then(start(1))
    .then(admit(1)).then(providerSuccess(1, 4, true)).then(mutate(1, "delete", 0)).then(commit(1))
    .expect(s.requests.get(1).outcome == "auth" and s.records.get(1).generation == 0)
  run shortRotationSurvivesFailureTest = initSeparateProcesses.then(start(1)).then(admit(1))
    .then(providerSuccess(1, 1, true)).then(commit(1))
    .expect(s.requests.get(1).outcome == "insufficient" and s.records.get(1).refresh == 3)
  run resetRejectsCommitTest = initSeparateProcesses.then(start(1)).then(admit(1))
    .then(providerSuccess(1, 4, true)).then(mutate(1, "reset", 0)).then(commit(1))
    .expect(s.requests.get(1).outcome == "storage-error" and s.records.get(1).generation == 0)
  run replacementWinsBeforeCommitTest = initSeparateProcesses.then(start(1)).then(admit(1))
    .then(providerSuccess(1, 4, true)).then(mutate(1, "replace", 5)).then(commit(1))
    .expect(s.requests.get(1).outcome == "ok" and s.requests.get(1).resultToken == 5 and not(s.requests.get(1).refreshed))
  run publishedWriteFailureCanBeReadOnRetryTest = initSameProcess.then(start(1)).then(start(2))
    .then(admit(1)).then(providerSuccess(1, 4, true)).then(storageFailure(1, true)).then(admit(2))
    .expect(and {
      s.requests.get(1).outcome == "storage-error",
      s.requests.get(2).outcome == "ok", s.requests.get(2).issuedRefresh == 0,
    })
  run separateProcessesCanRaceTheRemoteGrantTest = initSeparateProcesses.then(start(1)).then(start(2))
    .then(admit(1)).then(admit(2)).then(providerSuccess(1, 4, true))
    .then(providerFailure(2, "invalid-grant", false)).then(commit(1))
    .expect(s.requests.get(1).outcome == "ok" and s.requests.get(2).outcome == "auth")

  run stalledProviderReleasesOwnerTest = initSameProcess.then(start(1)).then(start(2))
    .then(admit(1)).then(providerDeadline(1)).then(admit(2))
    .expect(s.requests.get(1).outcome == "transient" and s.requests.get(2).phase == "provider")

}
