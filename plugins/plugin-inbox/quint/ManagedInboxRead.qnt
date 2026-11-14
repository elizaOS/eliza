// Managed aggregate reads are fresh owner-bound snapshots, never legacy cache rows.
module ManagedInboxRead {
  pure val Requests = Set("bounded", "missing-limit", "account-override", "missed-only")
  var s: { owner: int, pendingOwner: int, returnedOwner: int, phase: str,
    permission: bool, kind: str, calls: int, cacheReads: int }
  action init = s' = { owner: 0, pendingOwner: -1, returnedOwner: -1, phase: "idle",
    permission: true, kind: "bounded", calls: 0, cacheReads: 0 }
  action begin(kind: str): bool = all {
    s.phase == "idle", kind.in(Requests),
    s' = { ...s, kind: kind, phase: if (kind == "bounded") "pending" else "failed",
      pendingOwner: if (kind == "bounded") s.owner else -1,
      calls: if (kind == "bounded") 1 else 0 }
  }
  action replaceOwner = all { s.phase == "pending", s' = { ...s, owner: 1 - s.owner } }
  action revoke = all { s.phase == "pending", s' = { ...s, permission: false } }
  action receive = all {
    s.phase == "pending",
    s' = { ...s, phase: if (s.permission and s.pendingOwner == s.owner) "done" else "failed",
      returnedOwner: if (s.permission and s.pendingOwner == s.owner) s.owner else -1 }
  }
  action sourceFailure = all {
    s.phase == "pending", s' = { ...s, phase: "failed", returnedOwner: -1 }
  }
  action settle = any { receive, sourceFailure }
  action nextRead = all {
    s.phase.in(Set("done", "failed")),
    s' = { ...s, phase: "idle", permission: true, kind: "bounded",
      pendingOwner: -1, returnedOwner: -1, calls: 0 }
  }
  action step = any {
    { nondet kind = Requests.oneOf(); begin(kind) }, replaceOwner, revoke, settle, nextRead
  }
  val TypeOK = s.owner.in(Set(0, 1)) and s.pendingOwner.in(Set(-1, 0, 1))
    and s.returnedOwner.in(Set(-1, 0, 1)) and s.phase.in(Set("idle", "pending", "done", "failed"))
    and s.kind.in(Requests) and s.calls.in(Set(0, 1)) and s.cacheReads == 0
  val CurrentOwnerOnly = s.phase == "done" implies s.permission and s.returnedOwner == s.owner
  val FailureHasNoMail = s.phase == "failed" implies s.returnedOwner == -1
  val UnsupportedReadNeverDispatches = s.kind != "bounded" implies s.calls == 0
  val LegacyCacheNeverRead = s.cacheReads == 0
  temporal ReadFinishesWithoutFairness = (s.phase == "pending").leadsTo(s.phase != "pending")
  temporal ReadFinishes = settle.weakFair(s).implies(ReadFinishesWithoutFairness)
  run changedOwnerRefusesTest = init.then(begin("bounded")).then(replaceOwner)
    .then(receive).expect(s.phase == "failed" and FailureHasNoMail)
  run revokedReadRefusesTest = init.then(begin("bounded")).then(revoke)
    .then(receive).expect(s.phase == "failed" and FailureHasNoMail)
  run rereadUsesCurrentOwnerTest = init.then(begin("bounded")).then(replaceOwner)
    .then(receive).then(nextRead).then(begin("bounded")).then(receive)
    .expect(s.phase == "done" and s.returnedOwner == 1)
  run unsupportedReadRefusesTest = init.then(begin("missed-only"))
    .expect(s.phase == "failed" and UnsupportedReadNeverDispatches)
}
