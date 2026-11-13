// Atomic Redis sandbox lease, replacement generation, expiry and shutdown.
// Source: src/sandbox-registry.ts. Lua commands are atomic, transport may fail.
// Two container generations share one routing identity; TTL is live/expired.
// register(owner) includes successor/environment registration, even during old-owner stop.
module runtime_registry {
  var s: { server: int, agent: int, generation: int, heartbeat: bool, stopping: bool, deletionCaller: int, deletedOwner: int, refreshCaller: int, refreshedOwner: int }
  action init = s' = { server: -1, agent: -1, generation: -1, heartbeat: false, stopping: false, deletionCaller: -1, deletedOwner: -1, refreshCaller: -1, refreshedOwner: -1 }
  action register(owner: int): bool = s' = s.with("server", owner).with("agent", owner).with("generation", owner)
  action beginHeartbeat = all { not(s.stopping), not(s.heartbeat), s' = s.with("heartbeat", true) }
  action finishHeartbeat = all { s.heartbeat, s' = s.with("heartbeat", false) }
  action refresh(owner: int): bool = all { s.generation == owner, s.server == owner, s.agent == owner, s' = s.with("refreshCaller", owner).with("refreshedOwner", s.generation) }
  action expire = s' = s.with("server", -1).with("agent", -1).with("generation", -1)
  action beginStop = s' = s.with("stopping", true)
  action deleteOwned(owner: int): bool = all { s.generation == owner, not(s.heartbeat), s' = s.with("deletionCaller", owner).with("deletedOwner", s.generation).with("server", -1).with("agent", -1).with("generation", -1) }
  action rejectStaleDelete(owner: int): bool = all { s.generation != owner, s' = s }
  action idle = s' = s
  action step = any { register(0), register(1), beginHeartbeat, finishHeartbeat, refresh(0), refresh(1), expire, beginStop, deleteOwned(0), deleteOwned(1), rejectStaleDelete(0), rejectStaleDelete(1), idle }
  val safety = all { s.server == s.agent, s.agent == s.generation, s.deletedOwner != -1 implies s.deletionCaller == s.deletedOwner, s.refreshedOwner != -1 implies s.refreshCaller == s.refreshedOwner }
  run staleContainerCannotDeleteSuccessorTest = init.then(register(0)).then(register(1)).then(rejectStaleDelete(0)).expect(safety and s.generation == 1)
  run pendingHeartbeatDrainedTest = init.then(register(0)).then(beginHeartbeat).then(beginStop).then(finishHeartbeat).then(deleteOwned(0)).expect(safety and s.generation == -1)
  action legacyDelete(owner: int): bool = s' = s.with("deletionCaller", owner).with("deletedOwner", s.generation).with("server", -1).with("agent", -1).with("generation", -1)
  action legacyStep = any { step, legacyDelete(0), legacyDelete(1) }
  run staleDeletionWitnessTest = init.then(register(0)).then(register(1)).then(legacyDelete(0)).expect(not(safety))
}
