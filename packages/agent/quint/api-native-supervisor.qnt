// native-host/runtime-supervisor.mjs and private-runtime-launch.mjs.
// Two owner identities; one owned child. Receipt failure must reap the child.
module api_native_supervisor {
  var s: { desired: int, captured: int, running: int, busy: bool, closeRequested: bool, closed: bool, spawned: bool, receipt: bool, failed: bool, backoff: bool }
  action init = s' = { desired: 0, captured: 0, running: 0, busy: false, closeRequested: false, closed: false, spawned: false, receipt: false, failed: false, backoff: false }
  action identity(i: int): bool = s' = s.with("desired", i)
  action reconcile = all { not(s.busy), not(s.closeRequested), s.running == 0, s.desired != 0, not(s.backoff), s' = s.with("busy", true).with("captured", s.desired) }
  action spawn = all { s.busy, not(s.spawned), s' = s.with("spawned", true) }
  action receipt = all { s.spawned, s.busy, s' = s.with("receipt", true) }
  action startComplete = all { s.busy, s.spawned, s.receipt, s' = s.with("busy", false).with("running", if (not(s.closeRequested) and s.desired == s.captured) s.captured else 0).with("spawned", not(s.closeRequested) and s.desired == s.captured) }
  action launchFailure = all { s.busy, s' = s.with("busy", false).with("failed", true).with("spawned", false).with("running", 0).with("backoff", true).with("receipt", false) }
  action stop = all { s.running != 0, s' = s.with("running", 0).with("spawned", false).with("receipt", false) }
  action retry = all { s.backoff, s' = s.with("backoff", false).with("failed", false) }
  action close = s' = s.with("closeRequested", true)
  action finishClose = all { s.closeRequested, not(s.busy), s.running == 0, not(s.spawned), s' = s.with("closed", true) }
  action drainStop = all { s.closeRequested, stop }
  action idle = s' = s
  action step = any { identity(0), identity(1), identity(2), reconcile, spawn, receipt, startComplete, launchFailure, stop, retry, close, finishClose, idle }
  val safety = all { s.running != 0 implies (s.spawned and s.receipt), s.failed implies not(s.spawned), s.backoff implies not(s.busy), s.closed implies (s.closeRequested and not(s.busy) and s.running == 0 and not(s.spawned)) }
  temporal CloseCompletes = (spawn.weakFair(s) and receipt.weakFair(s)
    and startComplete.weakFair(s) and launchFailure.weakFair(s)
    and drainStop.weakFair(s) and finishClose.weakFair(s)).implies(
      s.closeRequested.leadsTo(s.closed))
  run changedIdentityReapsNewChildTest = init.then(identity(1)).then(reconcile).then(spawn).then(receipt).then(identity(2)).then(startComplete).expect(s.running == 0 and not(s.spawned))
  run failedReceiptReapsChildTest = init.then(identity(1)).then(reconcile).then(spawn).then(launchFailure).expect(s.running == 0 and not(s.spawned) and s.backoff)
  run closeDuringSpawnTest = init.then(identity(1)).then(reconcile).then(spawn).then(receipt).then(close).then(startComplete).then(finishClose).expect(s.closed and not(s.spawned))
  run closeWaitsForOwnedChildTest = init.then(identity(1)).then(reconcile).then(spawn).then(receipt).then(startComplete).then(close).then(stop).then(finishClose).expect(s.closed and s.running == 0)
}
