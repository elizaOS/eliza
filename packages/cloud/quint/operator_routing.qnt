// Server routing ownership and acknowledged status publication.
// Sources: services/operator/capabilities/{redis,reconciler,deployment-status}.ts
// Two server owners and one agent represent an arbitrary reassignment. Redis
// compare-and-delete is atomic; status writes can fail between destinations.
// No fairness, Redis availability, Kubernetes delivery, or liveness is assumed.
module operator_routing {
  type State = {
    owner: int,
    cleanupOwner: int,
    preservedOwner: int,
    desired: str,
    routing: str,
    persisted: str,
    cache: str,
    phase: str,
    retired: bool,
    resetQueued: bool,
    finalizerQueued: bool,
    finalizerCompleted: bool
  }

  var s: State

  action init = s' = {
    owner: 0, cleanupOwner: 0, preservedOwner: 0,
    desired: "pending", routing: "pending", persisted: "pending",
    cache: "none", phase: "idle", retired: false,
    resetQueued: false, finalizerQueued: false, finalizerCompleted: false
  }

  action assignRoute(owner: int): bool = all {
    s' = s.with("owner", owner).with("preservedOwner", 0)
  }

  action scheduleCleanup(owner: int): bool = s' = s.with("cleanupOwner", owner)

  action cleanup = all {
    s.cleanupOwner != 0,
    s' = s.with("owner", if (s.owner == s.cleanupOwner) 0 else s.owner)
      .with("preservedOwner", if (s.owner != s.cleanupOwner) s.owner else 0)
      .with("cleanupOwner", 0)
  }

  // The reconcile reset and watch updates share a serial queue. Cache
  // invalidation occurs with the reset, never concurrently with watch writes.
  action reconcile = all {
    s.phase == "idle", not(s.finalizerQueued), not(s.resetQueued),
    s' = s.with("routing", "pending").with("persisted", "pending")
      .with("cache", "none").with("retired", false).with("finalizerCompleted", false)
  }

  action observe(phase: str): bool = all {
    s.phase == "idle", s.cache != phase, not(s.retired), not(s.finalizerQueued), not(s.resetQueued),
    s' = s.with("desired", phase).with("phase", "routingWrite")
  }

  action routingAcknowledged = all {
    s.phase == "routingWrite",
    s' = s.with("routing", s.desired).with("phase", "statusWrite")
  }

  action statusAcknowledged = all {
    s.phase == "statusWrite",
    s' = s.with("persisted", s.desired).with("cache", s.desired)
      .with("phase", "idle")
  }

  // Neither a rejected MULTI command nor a failed Kubernetes write creates
  // a cache receipt; the same observation remains retryable.
  action writeFailed = all {
    s.phase != "idle",
    s' = s.with("cache", "none").with("phase", "idle")
  }

  action finalize = all {
    s.phase == "idle", not(s.resetQueued),
    s' = s.with("retired", true).with("routing", "absent")
      .with("persisted", "absent").with("cache", "none")
      .with("finalizerQueued", false).with("finalizerCompleted", true)
  }

  // A reconciliation can already be queued when finalization fences new
  // observations. Its activation runs before the finalizer owns the queue.
  action queueReset = all {
    s.phase != "idle", not(s.resetQueued), not(s.finalizerQueued), not(s.retired),
    s' = s.with("resetQueued", true)
  }
  action queueFinalizer = all {
    s.resetQueued, not(s.finalizerQueued),
    s' = s.with("finalizerQueued", true).with("retired", true)
  }
  action queuedResetRuns = all {
    s.phase == "idle", s.resetQueued,
    s' = s.with("resetQueued", false).with("retired", false)
      .with("routing", "pending").with("persisted", "pending")
      .with("cache", "none").with("finalizerCompleted", false)
  }
  action queuedFinalizerRuns = all {
    s.phase == "idle", s.finalizerQueued, not(s.resetQueued),
    s' = s.with("retired", true).with("routing", "absent")
      .with("persisted", "absent").with("cache", "none")
      .with("finalizerQueued", false).with("finalizerCompleted", true)
  }
  action ignoreRetiredObservation = all { s.retired, s' = s }

  action idle = s' = s
  action step = {
    nondet owner = Set(1, 2).oneOf()
    nondet phase = Set("pending", "running", "scaleddown").oneOf()
    any {
      assignRoute(owner), scheduleCleanup(owner), cleanup, reconcile,
      observe(phase), routingAcknowledged, statusAcknowledged, writeFailed,
      finalize, queueReset, queueFinalizer, queuedResetRuns, queuedFinalizerRuns,
      ignoreRetiredObservation, idle
    }
  }

  val safety = all {
    s.preservedOwner != 0 implies s.owner == s.preservedOwner,
    s.phase == "idle" and s.cache != "none" implies
      s.routing == s.cache and s.persisted == s.cache,
    s.retired and not(s.finalizerQueued) implies s.routing == "absent" and s.persisted == "absent",
    s.finalizerCompleted implies s.retired
  }

  run reassignedRouteSurvivesOldCleanupTest = init.then(assignRoute(1))
    .then(scheduleCleanup(1)).then(assignRoute(2)).then(cleanup)
    .expect(s.owner == 2 and safety)

  run ownedRouteIsRemovedTest = init.then(assignRoute(1)).then(scheduleCleanup(1))
    .then(cleanup).expect(s.owner == 0 and safety)

  run failedStatusWriteRemainsRetryableTest = init.then(observe("running"))
    .then(routingAcknowledged).then(writeFailed).then(observe("running"))
    .then(routingAcknowledged).then(statusAcknowledged)
    .expect(s.persisted == "running" and safety)

  run sameReadyCountAfterReconcileTest = init.then(observe("running"))
    .then(routingAcknowledged).then(statusAcknowledged).then(reconcile)
    .then(observe("running")).then(routingAcknowledged).then(statusAcknowledged)
    .expect(s.persisted == "running" and safety)

  run finalizedServerIgnoresLateWatchTest = init.then(observe("running"))
    .then(routingAcknowledged).then(statusAcknowledged).then(finalize)
    .then(ignoreRetiredObservation).expect(s.routing == "absent" and safety)

  run priorQueuedActivationCannotReopenFinalizerTest = init.then(observe("running"))
    .then(queueReset).then(queueFinalizer).then(routingAcknowledged).then(statusAcknowledged)
    .then(queuedResetRuns).then(queuedFinalizerRuns).then(ignoreRetiredObservation)
    .expect(s.finalizerCompleted and s.routing == "absent" and safety)

  // Mutation witnesses for the pre-fix blind DEL and stale cache. Neither
  // transition participates in step; they show the invariant detects both bugs.
  action legacyCleanup = all {
    s.cleanupOwner != 0,
    s' = s.with("owner", 0).with("preservedOwner", s.owner)
  }
  action legacyReset = s' = s.with("routing", "pending").with("persisted", "pending")
  action legacyQueuedFinalizerRuns = all {
    s.phase == "idle", s.finalizerQueued, not(s.resetQueued),
    s' = s.with("routing", "absent").with("persisted", "absent")
      .with("cache", "none").with("finalizerQueued", false).with("finalizerCompleted", true)
  }
  run legacyOwnershipBugDetectedTest = init.then(assignRoute(1))
    .then(scheduleCleanup(1)).then(assignRoute(2)).then(legacyCleanup).expect(not(safety))
  run legacyCacheBugDetectedTest = init.then(observe("running"))
    .then(routingAcknowledged).then(statusAcknowledged).then(legacyReset).expect(not(safety))
  run legacyQueuedActivationDetectedTest = init.then(observe("running"))
    .then(queueReset).then(queueFinalizer).then(routingAcknowledged).then(statusAcknowledged)
    .then(queuedResetRuns).then(legacyQueuedFinalizerRuns).expect(not(safety))
}
