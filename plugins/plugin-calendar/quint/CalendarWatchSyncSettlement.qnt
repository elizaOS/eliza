// One durable watch channel and two independently returning sync attempts.
module CalendarWatchSyncSettlement {
  type State = {
    channel: str, lease: int, expired: bool, claimed: Set[int],
    inFlight: Set[int], recorded: Set[int], ignored: Set[int],
    last: int, pending: int, failures: int,
  }
  var s: State

  action init = s' = {
    channel: "active", lease: -1, expired: false, claimed: Set(), inFlight: Set(),
    recorded: Set(), ignored: Set(), last: 0, pending: 2, failures: 0,
  }

  action claimOld = all {
    s.channel == "active" and not(s.claimed.contains(0)),
    s' = { ...s, lease: 0, claimed: Set(0), inFlight: Set(0) },
  }

  action expireOld = all {
    s.lease == 0 and not(s.expired),
    s' = { ...s, expired: true },
  }

  action claimReplacement = all {
    s.channel == "active" and s.lease == 0 and s.expired,
    s' = { ...s, lease: 1, claimed: s.claimed.union(Set(1)), inFlight: s.inFlight.union(Set(1)) },
  }

  action beginStop = all {
    s.channel == "active",
    s' = { ...s, channel: "stopping" },
  }

  action confirmStop = all {
    s.channel == "stopping",
    s' = { ...s, channel: "stopped", pending: 0, lease: -1 },
  }

  action failOld = all {
    s.inFlight.contains(0),
    val remaining = s.inFlight.exclude(Set(0))
    s' = if (s.lease == 0 and s.channel == "active") {
      ...s, channel: "error", lease: -1, failures: s.failures + 1,
      inFlight: remaining, recorded: s.recorded.union(Set(0)),
    } else {
      ...s, inFlight: remaining, ignored: s.ignored.union(Set(0)),
    },
  }

  // The existing success path can still complete while stopping if its token
  // matches. After stop confirmation the stale completion is refused.
  action settleReplacement = all {
    s.inFlight.contains(1),
    val remaining = s.inFlight.exclude(Set(1))
    s' = if (s.lease == 1) {
      ...s, lease: -1, last: s.pending, pending: 0,
      inFlight: remaining, recorded: s.recorded.union(Set(1)),
    } else {
      ...s, inFlight: remaining, ignored: s.ignored.union(Set(1)),
    },
  }

  action step = any { claimOld, expireOld, claimReplacement, beginStop, confirmStop,
    failOld, settleReplacement, s' = s }

  val ExactAttemptAccounting = and {
    s.claimed == s.inFlight.union(s.recorded).union(s.ignored),
    s.inFlight.intersect(s.recorded.union(s.ignored)) == Set(),
    s.recorded.intersect(s.ignored) == Set(),
  }
  val ErrorRequiresCurrentFailure = (s.channel == "error") implies
    s.failures == 1 and s.last == 0 and s.pending == 2 and s.recorded.contains(0)
  val StoppedClearsPending = (s.channel == "stopped") implies s.pending == 0 and s.lease == -1

  temporal SupersededFailurePreservesDurableState = always((
    s.inFlight.contains(0) and not(next(s.inFlight).contains(0)) and
      (s.lease != 0 or s.channel != "active") implies
      next(s.channel) == s.channel and next(s.lease) == s.lease and
      next(s.last) == s.last and next(s.pending) == s.pending and next(s.failures) == s.failures
  ).orKeep(s))

  temporal PendingWorkSettles = and {
    s.inFlight.contains(0).leadsTo(not(s.inFlight.contains(0))),
    s.inFlight.contains(1).leadsTo(not(s.inFlight.contains(1))),
    (s.channel == "stopping").leadsTo(s.channel == "stopped"),
  }
  temporal FairPendingWorkSettles = and {
    failOld.weakFair(s), settleReplacement.weakFair(s), confirmStop.weakFair(s),
  } implies PendingWorkSettles

  run OldFailurePreservesReplacementTest = init.then(claimOld).then(expireOld)
    .then(claimReplacement).then(failOld)
    .expect(s.channel == "active" and s.lease == 1 and s.pending == 2 and s.failures == 0)
    .then(settleReplacement).expect(s.last == 2 and s.pending == 0 and s.recorded == Set(1))

  run OldFailurePreservesStoppedRowTest = init.then(claimOld).then(beginStop)
    .then(confirmStop).then(failOld)
    .expect(s.channel == "stopped" and s.lease == -1 and s.pending == 0 and s.failures == 0)

  run OldFailurePreservesStopInFlightTest = init.then(claimOld).then(beginStop).then(failOld)
    .expect(s.channel == "stopping" and s.failures == 0).then(confirmStop)
    .expect(StoppedClearsPending)

  run CurrentFailureRemainsObservableTest = init.then(claimOld).then(failOld)
    .expect(s.channel == "error" and s.lease == -1 and ErrorRequiresCurrentFailure)
}
