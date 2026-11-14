// Trajectory capture queue, graceful durability, and exact-owner crash recovery.
// Sources: plugin-assistant's TrajectoriesService and its row store
// (features/trajectories/store/trajectory-{storage,internals}.ts), the single
// owner of trajectory persistence, plus the host's dev-trajectory-recovery.ts
// and dev-trajectory-recovery-protocol.ts.
// Two captures and two execution identities abstract payloads and arbitrary IDs.
// Database transactions, compare-and-set and the supervisor's exit proof are trusted boundaries.
// A crash may lose uncommitted in-memory captures; graceful stop must drain them.
module runtime_trajectories {
  var s: { status: str, owner: int, accepted: int, persisted: int, stopping: bool, dead: bool, failed: bool, crashed: bool }
  action init = s' = { status: "absent", owner: -1, accepted: 0, persisted: 0, stopping: false, dead: false, failed: false, crashed: false }
  action start = all { s.status == "absent", not(s.stopping), s' = s.with("status", "active").with("owner", 0) }
  action capture = all { s.status == "active", not(s.stopping), s.accepted < 2, s' = s.with("accepted", s.accepted + 1) }
  action persist = all { s.persisted < s.accepted, not(s.crashed), s' = s.with("persisted", s.persisted + 1).with("failed", false) }
  action writeFailure = all { s.persisted < s.accepted, not(s.crashed), s' = s.with("failed", true) }
  action finish = all { s.status == "active", not(s.crashed), s.persisted == s.accepted, s' = s.with("status", "completed") }
  action stop = s' = s.with("stopping", true)
  action terminate = all { s.stopping, not(s.crashed), s.status == "active", s.persisted == s.accepted, s' = s.with("status", "terminated") }
  action confirmExit = all { s.status == "active", s.persisted == s.accepted, s' = s.with("dead", true).with("stopping", true) }
  action crash = all { s.status == "active", s' = s.with("crashed", true).with("dead", true).with("stopping", true) }
  action recover(owner: int): bool = all { s.dead, s.owner == owner, s.status == "active", s' = s.with("status", "terminated") }
  action rejectForeignRecovery = all { s.owner != 1, s' = s }
  action idle = s' = s
  action step = any { start, capture, persist, writeFailure, finish, stop, terminate, confirmExit, crash, recover(0), recover(1), rejectForeignRecovery, idle }
  val safety = all { s.persisted <= s.accepted, s.accepted <= 2, (Set("completed", "terminated").contains(s.status) and not(s.crashed)) implies s.persisted == s.accepted, s.status != "absent" implies s.owner == 0 }
  run failedWriteRetainsCaptureTest = init.then(start).then(capture).then(writeFailure).then(stop).then(persist).then(terminate).expect(safety and s.persisted == 1)
  run foreignRecoveryCannotMutateTest = init.then(start).then(rejectForeignRecovery).expect(s.status == "active").then(confirmExit).then(recover(0)).expect(safety and s.status == "terminated")
  run abruptDeathDoesNotInventDurabilityTest = init.then(start).then(capture).then(crash).then(recover(0)).expect(safety and s.crashed and s.accepted == 1 and s.persisted == 0)
}
