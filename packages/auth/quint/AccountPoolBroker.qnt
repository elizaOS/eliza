// AccountPoolBroker.lease: select, await a token decision, then validate and
// publish its exact credential receipt. One default resolver and one change.
module BrokerLeasePublication {
  type State = {
    generation: int, now: int, changed: bool, phase: str,
    receipt: int, receiptOrg: int, published: int, publishedOrg: int,
    publicationGeneration: int, issuedAt: int, expiresAt: int,
  }
  var s: State
  // Zero means absent. Generations and organization ids are opaque identities.
  pure def organization(generation: int): int =
    if (generation == 2) 8 else 7

  action init = s' = {
    generation: 1, now: 0, changed: false, phase: "idle", receipt: 0,
    receiptOrg: 0, published: 0, publishedOrg: 0, publicationGeneration: 0,
    issuedAt: 0, expiresAt: 0,
  }
  action begin = all { s.phase == "idle", s' = { ...s, phase: "pending" } }
  action replace(generation: int): bool = all {
    not(s.changed),
    s' = { ...s, changed: true, generation: generation },
  }
  action resolve(ok: bool): bool = all {
    s.phase == "pending",
    s' = if (ok and s.generation != 0)
      { ...s, phase: "resolved", receipt: s.generation, receiptOrg: organization(s.generation) }
      else { ...s, phase: "rejected" },
  }
  action publish = all {
    s.phase == "resolved",
    s' = if (s.receipt != s.generation)
      { ...s, phase: "refused" }
      else {
        ...s, phase: "active", published: s.receipt, publishedOrg: s.receiptOrg,
        publicationGeneration: s.generation, issuedAt: s.now, expiresAt: s.now + 2,
      },
  }
  action release = all {
    s.phase == "active", s' = { ...s, phase: "released" },
  }
  action prune = all {
    s.phase == "active", s.now >= s.expiresAt, s' = { ...s, phase: "expired" },
  }
  action work = any { resolve(true), resolve(false), publish }
  action step = any {
    begin, work, replace(0), replace(2), release, prune,
    all { s.now < 5, s' = { ...s, now: s.now + 1 } },
    s' = s,
  }
  val TypeOK = and {
    s.generation.in(0.to(2)), s.now.in(0.to(5)),
    s.phase.in(Set("idle", "pending", "resolved", "refused", "rejected", "active", "released", "expired")),
  }
  val PublishedReceiptOwnsGeneration = (s.published != 0).implies(
    s.published == s.receipt and s.published == s.publicationGeneration)
  val TokenAndOrganizationShareReceipt = (s.published != 0).implies(
    s.publishedOrg == s.receiptOrg and s.publishedOrg == organization(s.published))
  val ExpiryStartsAtPublication = (s.published != 0).implies(
    s.expiresAt == s.issuedAt + 2 and s.issuedAt <= s.now)
  val RefusedHasNoLease = s.phase.in(Set("refused", "rejected")).implies(s.published == 0)
  temporal ResolutionsSettle = work.weakFair(s) implies
    always(s.phase.in(Set("pending", "resolved")).implies(
      eventually(not(s.phase.in(Set("pending", "resolved"))))))

  run changedAfterDecisionRefusesTest = init.then(begin).then(resolve(true))
    .then(replace(2)).then(publish).expect(s.phase == "refused" and RefusedHasNoLease)
  run changedBeforeDecisionUsesNewContextTest = init.then(begin).then(replace(2))
    .then(resolve(true)).then(publish).expect(s.published == 2 and s.publishedOrg == 8)
}

// AccountPoolBroker.report: admit against the in-memory lease, serialize
// one account's reports, then fence the independent accounting/health writes.
// Both leases precede reports. Admitted work can finish after release or expiry.
module BrokerLeaseReports {
  val ids = Set(1, 2)
  val resultKinds = Set("success", "auth", "rate", "transient", "other")
  val settledPhases = Set("done", "unknown", "expired", "error")
  type Report = {
    phase: str, kind: str, usageWrite: int, healthWrite: int,
    statusOwner: int, baselineMatched: bool, preservedNewFailure: bool,
  }
  type State = {
    generation: int, replaced: bool, externalWrite: bool, detail: int,
    health: str, leases: int -> str, reports: int -> Report,
    queue: List[int], lastStatus: str, failed: bool, pending: bool,
  }
  var s: State
  val idle = {
    phase: "idle", kind: "success", usageWrite: 0, healthWrite: 0,
    statusOwner: 0, baselineMatched: true, preservedNewFailure: true,
  }

  action init = s' = {
    generation: 1, replaced: false, externalWrite: false, detail: 0,
    health: "rate", leases: ids.mapBy(_ => "active"), reports: ids.mapBy(_ => idle),
    queue: [], lastStatus: "none", failed: false, pending: false,
  }
  action close(id: int, reason: str): bool = all {
    s.leases.get(id) == "active" or (reason == "closed" and s.leases.get(id) == "elapsed"),
    s' = { ...s, leases: s.leases.set(id, reason) },
  }
  action replace(generation: int): bool = all {
    not(s.replaced),
    s' = { ...s, generation: generation, replaced: true, health: "ok", detail: 0 },
  }
  // Another writer can retain the same health category with newer details.
  action external(health: str): bool = all {
    not(s.externalWrite), s.generation != 0,
    s' = { ...s, externalWrite: true, health: health, detail: 1 },
  }
  action submit(id: int, kind: str): bool = {
    val status = s.leases.get(id)
    val phase = if (status == "active") "queued"
      else if (status == "elapsed") "expired" else "unknown"
    all {
      s.reports.get(id).phase == "idle",
      s' = {
        ...s, reports: s.reports.set(id, { ...idle, kind: kind, phase: phase }),
        queue: if (phase == "queued") s.queue.append(id) else s.queue,
        leases: if (phase == "expired") s.leases.set(id, "closed") else s.leases,
      },
    }
  }

  // The first report in the queue owns the mutex. Completion, including rejection, releases it.
  val queueOwner = if (s.queue.length() > 0) s.queue.nth(0) else 0
  action account(id: int, fault: str): bool = {
    val report = s.reports.get(id)
    val write = s.generation == 1 and fault != "before"
    all {
      id == queueOwner, report.phase == "queued",
      s' = {
        ...s, reports: s.reports.set(id, {
          ...report, usageWrite: if (write) s.generation else 0,
          phase: if (fault == "none") "recorded" else "error",
        }),
        queue: if (fault == "none") s.queue else s.queue.tail(),
      },
    }
  }
  action decide(id: int): bool = {
    val report = s.reports.get(id)
    val stale = s.generation != 1
    val success = report.kind == "success"
    val superseded = success and s.failed
    val updateStatus = not(stale or superseded)
    val nextStatus = if (updateStatus) report.kind else s.lastStatus
    val nextPending = if (not(updateStatus) or report.kind == "other") s.pending else not(success)
    val completed = stale or superseded
    all {
      id == queueOwner, report.phase == "recorded",
      s' = {
        ...s, reports: s.reports.set(id, {
          ...report, phase: if (completed) "done" else "writing",
          statusOwner: if (updateStatus) s.generation else 0,
          preservedNewFailure: not(superseded) or (nextStatus == s.lastStatus and nextPending == s.pending),
        }),
        leases: if (stale) s.leases.set(id, "closed") else s.leases,
        queue: if (completed) s.queue.tail() else s.queue,
        lastStatus: nextStatus, failed: s.failed or (updateStatus and not(success)),
        pending: nextPending,
      },
    }
  }
  action commit(id: int, fault: str): bool = {
    val report = s.reports.get(id)
    val baseline = s.health == "rate" and s.detail == 0
    val success = report.kind == "success"
    val invalidates = report.kind.in(Set("auth", "rate"))
    val write = s.generation == 1 and fault != "before" and
      (invalidates or (success and baseline))
    all {
      id == queueOwner, report.phase == "writing",
      s' = {
        ...s, reports: s.reports.set(id, {
          ...report, phase: if (fault == "none") "done" else "error",
          healthWrite: if (write) s.generation else 0, baselineMatched: baseline,
        }),
        queue: s.queue.tail(),
        health: if (write) (if (success) "ok" else report.kind) else s.health,
        detail: if (write) 2 else s.detail,
        leases: if (invalidates and fault == "none") s.leases.set(id, "closed") else s.leases,
      },
    }
  }

  val faults = Set("none", "before", "after")
  action work(id: int): bool = any {
    { nondet fault = faults.oneOf() account(id, fault) },
    decide(id),
    { nondet fault = faults.oneOf() commit(id, fault) },
  }
  action step = any {
    { nondet id = ids.oneOf() work(id) },
    { nondet id = ids.oneOf() nondet kind = resultKinds.oneOf() submit(id, kind) },
    { nondet id = ids.oneOf() close(id, "elapsed") },
    { nondet id = ids.oneOf() close(id, "closed") },
    replace(0), replace(2), external("rate"), external("auth"),
    s' = s,
  }
  val TypeOK = and {
    s.generation.in(0.to(2)), s.detail.in(0.to(2)), s.queue.length() <= 2,
    s.reports.keys() == ids, s.leases.keys() == ids,
    ids.forall(id => s.reports.get(id).phase.in(
      settledPhases.union(Set("idle", "queued", "recorded", "writing")))),
  }
  val OnlyHeadHoldsReportLock = ids.forall(id =>
    s.reports.get(id).phase.in(Set("recorded", "writing")).implies(queueOwner == id))
  val RejectedLeaseHasNoEffects = ids.forall(id => {
    val report = s.reports.get(id)
    report.phase.in(Set("unknown", "expired")).implies(
      report.usageWrite == 0 and report.healthWrite == 0 and report.statusOwner == 0)
  })
  val CredentialOwnsReportEffects = ids.forall(id => {
    val report = s.reports.get(id)
    report.usageWrite.in(Set(0, 1)) and report.healthWrite.in(Set(0, 1)) and report.statusOwner.in(Set(0, 1))
  })
  val NewHealthBaselineSurvives = ids.forall(id => {
    val report = s.reports.get(id)
    (report.kind == "success" and report.healthWrite != 0).implies(report.baselineMatched)
  })
  val NewFailureStatusSurvives = ids.forall(id => s.reports.get(id).preservedNewFailure)
  temporal ReportsSettle = ids.forall(id => work(id).weakFair(s)) implies
    ids.forall(id => always(s.reports.get(id).phase.in(Set("queued", "recorded", "writing"))
      .implies(eventually(s.reports.get(id).phase.in(settledPhases)))))

  run rateReportAfterReplacementKeepsNewHealthTest = init.then(submit(1, "rate"))
    .then(account(1, "none")).then(replace(2)).then(decide(1))
    .expect(s.health == "ok" and s.reports.get(1).statusOwner == 0)
  run concurrentHealthDuringWriteWinsTest = init.then(submit(1, "success"))
    .then(account(1, "none")).then(decide(1)).then(external("auth")).then(commit(1, "none"))
    .expect(s.health == "auth" and s.reports.get(1).healthWrite == 0)
  run lateSuccessKeepsFailureStatusTest = init.then(submit(2, "auth")).then(submit(1, "success"))
    .then(account(2, "none")).then(decide(2)).then(commit(2, "none"))
    .then(account(1, "none")).then(decide(1)).expect(s.lastStatus == "auth" and s.pending)
  run expiredLeaseDoesNotEnterQueueTest = init.then(close(1, "elapsed")).then(submit(1, "success"))
    .expect(s.queue.length() == 0 and s.reports.get(1).phase == "expired")
}
