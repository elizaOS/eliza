// startGatewayLifecycle. Four optional resource handles are acquired in order.
// The HTTP close event follows connection drain before reverse-order cleanup.
module GatewayLifecycle {
  pure val resources = Set(0, 1, 2, 3)
  var s: {
    phase: str,
    next: int,
    acquired: Set[int],
    released: Set[int],
    releaseCount: int -> int,
    cleanupOwner: bool,
    listening: bool,
    readyReported: bool,
    admitted: bool,
    connectedRequest: bool,
    managedJoined: bool,
    closeObserved: bool,
    errors: int,
    lastReleased: int
  }
  action init = s' = {
    phase: "acquiring",
    next: 0,
    acquired: Set(),
    released: Set(),
    releaseCount: resources.mapBy(_ => 0),
    cleanupOwner: false,
    listening: false,
    readyReported: false,
    admitted: false,
    connectedRequest: false,
    managedJoined: false,
    closeObserved: false,
    errors: 0,
    lastReleased: 4
  }
  action acquire(present: bool): bool = all {
    s.phase == "acquiring",
    s.next < 4,
    s' = s
      .with("next", s.next + 1)
      .with("acquired", if (present) s.acquired.union(Set(s.next)) else s.acquired)
  }
  action bind = all {
    s.phase == "acquiring",
    s.next == 4,
    s' = s
      .with("phase", "binding")
  }
  action listen = all {
    s.phase == "binding",
    s' = s
      .with("phase", "ready")
      .with("listening", true)
      .with("readyReported", true)
  }
  action admitRequest = all {
    s.phase == "ready", not(s.admitted),
    s' = { ...s, admitted: true, connectedRequest: true }
  }
  action finishRequest = all {
    s.connectedRequest,
    s' = s.with("connectedRequest", false)
  }
  action startDrain(managed: bool): bool = all {
    s.phase == "ready",
    s' = { ...s, phase: "draining", listening: false, managedJoined: managed }
  }
  action joinDrain = all {
    s.phase == "draining", not(s.managedJoined),
    s' = s.with("managedJoined", true)
  }
  action externalClose = startDrain(false)
  action managedClose = any { startDrain(true), joinDrain }
  action receiveHttpClose = all {
    s.phase == "draining", not(s.connectedRequest),
    s' = { ...s, phase: "cleanup", closeObserved: true, cleanupOwner: true }
  }
  action startupFailure = all {
    s.phase.in(Set("acquiring", "binding")),
    s' = { ...s, phase: "cleanup", cleanupOwner: true }
  }
  action dispose(r: int, failed: bool): bool = all {
    s.phase == "cleanup",
    s.acquired.contains(r),
    not(s.released.contains(r)),
    s.acquired.filter(other => not(s.released.contains(other))).forall(other => other <= r),
    s' = s
      .with("released", s.released.union(Set(r)))
      .with("releaseCount", s.releaseCount.set(r, s.releaseCount.get(r) + 1))
      .with("errors", s.errors + (if (failed) 1 else 0))
      .with("lastReleased", r)
  }
  action finish = all {
    s.phase == "cleanup",
    s.acquired == s.released,
    s' = s
      .with("phase", "closed")
  }
  action releaseNext = {
    nondet resource = resources.oneOf()
    nondet failed = Set(false, true).oneOf()
    dispose(resource, failed)
  }
  action step = any {
    {
      nondet present = Set(false, true).oneOf()
      acquire(present)
    },
    bind, listen, admitRequest, finishRequest, externalClose, managedClose,
    receiveHttpClose, startupFailure, releaseNext, finish, s' = s,
  }
  val invariant = and {
    s.released.subseteq(s.acquired),
    resources.forall(r => s.releaseCount.get(r) <= 1),
    (s.phase == "ready") implies s.listening,
    (s.phase == "closed") implies s.acquired == s.released,
    s.cleanupOwner implies Set("cleanup", "closed").contains(s.phase),
  }
  val CleanupRequiresHttpClose = and {
    s.connectedRequest implies not(s.cleanupOwner),
    (s.readyReported and s.cleanupOwner) implies s.closeObserved,
    (s.phase == "draining") implies (not(s.listening) and not(s.closeObserved)),
  }
  temporal DrainEventuallySettles = always(
    s.phase.in(Set("draining", "cleanup")) implies eventually(s.phase == "closed")
  )
  temporal FairDrainAndCleanup =
    (finishRequest.weakFair(s) and receiveHttpClose.weakFair(s) and
      releaseNext.weakFair(s) and finish.weakFair(s)) implies DrainEventuallySettles

  run externalCloseAndManagedJoinTest = init
    .then(acquire(true)).then(acquire(true)).then(acquire(false)).then(acquire(false))
    .then(bind).then(listen).then(admitRequest).then(externalClose).then(managedClose)
    .expect(not(s.listening) and s.connectedRequest and s.managedJoined and s.released == Set())
    .then(finishRequest).then(receiveHttpClose).then(dispose(1, false)).then(dispose(0, false))
    .then(finish).expect(s.phase == "closed" and s.closeObserved and s.errors == 0)

  run bindFailureRollsBackWithoutCloseEventTest = init
    .then(acquire(true)).then(acquire(false)).then(acquire(false)).then(acquire(true))
    .then(bind).then(startupFailure).then(dispose(3, true)).then(dispose(0, false))
    .then(finish).expect(s.phase == "closed" and not(s.closeObserved) and s.errors == 1)
}
