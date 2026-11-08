// A2ATaskStoreService's Redis branch. The lease token and each task mutation
// must be compared and written in one Redis command. Index writes follow the
// task write and can fail independently. Redis persistence and failover are
// outside this single-server instance.
module RedisTaskLease {
  pure val Actors = Set(1, 2)
  pure val Modes = Set("append", "set", "delete")
  type Call = { phase: str, mode: str, snapshot: Set[int], exists: bool, result: str }
  pure val unused: Call = { phase: "unused", mode: "append", snapshot: Set(), exists: false, result: "pending" }
  var s: {
    lease: int, record: Set[int], exists: bool, indexed: bool,
    calls: int -> Call, required: Set[int], unauthorizedWrite: bool,
    unauthorizedRelease: bool, releaseObserved: int,
  }
  action init = s' = {
    lease: 0, record: Set(), exists: true, indexed: true,
    calls: Actors.mapBy(_ => unused), required: Set(), unauthorizedWrite: false,
    unauthorizedRelease: false, releaseObserved: 0,
  }
  action begin(actor: int, mode: str): bool = all {
    s.calls.get(actor).phase == "unused",
    s' = { ...s, calls: s.calls.set(actor, { ...unused, phase: "waiting", mode: mode }) },
  }
  action acquire(actor: int): bool = all {
    s.calls.get(actor).phase == "waiting", s.lease == 0,
    s' = { ...s, lease: actor, calls: s.calls.set(actor, { ...s.calls.get(actor), phase: "held" }) },
  }
  action read(actor: int): bool = {
    val call = s.calls.get(actor)
    all {
      call.phase == "held",
      s' = { ...s, calls: s.calls.set(actor, {
        ...call, snapshot: s.record, exists: s.exists,
        phase: if (call.mode != "set" and not(s.exists)) "release" else "write",
        result: if (call.mode != "set" and not(s.exists)) "missing" else "pending",
      }) },
    }
  }
  pure def changed(call: Call, actor: int): Set[int] =
    if (call.mode == "delete") Set()
    else if (call.mode == "set") Set(actor)
    else call.snapshot.union(Set(actor))
  action write(actor: int): bool = {
    val call = s.calls.get(actor)
    val owns = s.lease == actor
    all {
      call.phase == "write",
      s' = if (not(owns)) { ...s, calls: s.calls.set(actor,
        { ...call, phase: "release", result: "lost" }) }
      else {
        ...s, record: changed(call, actor), exists: call.mode != "delete",
        required: if (call.mode == "append") s.required.union(Set(actor)) else Set(),
        indexed: s.indexed,
        calls: s.calls.set(actor, { ...call,
          phase: "index", result: "committed" }),
      },
    }
  }
  action index(actor: int, succeeds: bool): bool = {
    val call = s.calls.get(actor)
    all {
      call.phase == "index",
      s' = { ...s, indexed: if (succeeds) call.mode != "delete" else s.indexed,
        calls: s.calls.set(actor, { ...call, phase: "release",
          result: if (succeeds) "committed" else "unknown" }) },
    }
  }
  action failBeforeWrite(actor: int): bool = all {
    Set("waiting", "held", "write").contains(s.calls.get(actor).phase),
    s' = { ...s, calls: s.calls.set(actor,
      { ...s.calls.get(actor), phase: "release", result: "failed" }) },
  }
  action release(actor: int): bool = all {
    s.calls.get(actor).phase == "release",
    s' = { ...s, lease: if (s.lease == actor) 0 else s.lease,
      calls: s.calls.set(actor, { ...s.calls.get(actor), phase: "done" }) },
  }
  action expire = all { s.lease != 0, s' = { ...s, lease: 0 } }
  action advance(actor: int): bool = any {
    acquire(actor), read(actor), write(actor), index(actor, true), index(actor, false),
    failBeforeWrite(actor), release(actor),
  }
  action step = any {
    { nondet actor = Actors.oneOf()
      nondet mode = Modes.oneOf()
      begin(actor, mode) },
    advance(1), advance(2), expire, s' = s,
  }
  val HoldsCommittedAppends = s.required.subseteq(s.record)
  val ExpiredOwnerCannotWrite = not(s.unauthorizedWrite)
  val ExpiredOwnerCannotRelease = not(s.unauthorizedRelease)
  val Bounds = s.lease >= 0 and s.lease <= 2 and s.record.subseteq(Actors)
    and s.required.subseteq(Actors)
  val invariant = HoldsCommittedAppends and ExpiredOwnerCannotWrite
    and ExpiredOwnerCannotRelease and Bounds
  temporal CallsSettle = (advance(1).weakFair(s) and advance(2).weakFair(s)
    and expire.weakFair(s)).implies(Actors.forall(actor =>
      always((s.calls.get(actor).phase != "unused").implies(
        eventually(s.calls.get(actor).phase == "done")))))
  // Old SETEX accepted a stale snapshot after its token expired.
  action legacyWrite(actor: int): bool = {
    val call = s.calls.get(actor)
    all {
      call.phase == "write",
      s' = { ...s, record: changed(call, actor), exists: call.mode != "delete",
        unauthorizedWrite: s.unauthorizedWrite or s.lease != actor,
        required: s.required.union(Set(actor)),
        calls: s.calls.set(actor, { ...call, phase: "index", result: "committed" }) },
    }
  }
  // Old GET and DEL were separate commands. Expiry can change ownership
  // after the GET result and before the following DEL.
  action legacyReadRelease(actor: int): bool = all {
    s.calls.get(actor).phase == "release", s.lease == actor,
    s' = { ...s, releaseObserved: actor },
  }
  action legacyDeleteRelease(actor: int): bool = all {
    s.releaseObserved == actor,
    s' = { ...s, lease: 0, unauthorizedRelease: s.lease != 0 and s.lease != actor,
      releaseObserved: 0 },
  }
  run lateOwnerCannotOverwriteTest = init.then(begin(1, "append")).then(acquire(1))
    .then(read(1)).then(expire).then(begin(2, "append")).then(acquire(2)).then(read(2))
    .then(write(2)).then(index(2, true)).then(release(2)).then(write(1))
    .expect(invariant and s.record == Set(2) and s.calls.get(1).result == "lost")
  run legacyLateOwnerLosesCommittedAppendTest = init.then(begin(1, "append")).then(acquire(1))
    .then(read(1)).then(expire).then(begin(2, "append")).then(acquire(2)).then(read(2))
    .then(write(2)).then(index(2, true)).then(release(2)).then(legacyWrite(1))
    .expect(not(HoldsCommittedAppends) and not(ExpiredOwnerCannotWrite))
  run releaseCannotDeleteNewOwnerTest = init.then(begin(1, "append")).then(acquire(1))
    .then(failBeforeWrite(1)).then(expire).then(begin(2, "append")).then(acquire(2))
    .then(release(1)).expect(invariant and s.lease == 2)
  run legacyReleaseDeletesNewOwnerTest = init.then(begin(1, "append")).then(acquire(1))
    .then(failBeforeWrite(1)).then(legacyReadRelease(1)).then(expire)
    .then(begin(2, "append")).then(acquire(2)).then(legacyDeleteRelease(1))
    .expect(not(ExpiredOwnerCannotRelease) and s.lease == 0)
  run failedDeleteIndexRetainsStaleMemberTest = init.then(begin(1, "delete"))
    .then(acquire(1)).then(read(1)).then(write(1)).then(index(1, false))
    .expect(invariant and not(s.exists) and s.indexed and s.calls.get(1).result == "unknown")
  run deletionAfterAppendIsExplicitTest = init.then(begin(1, "append")).then(acquire(1))
    .then(read(1)).then(write(1)).then(index(1, true)).then(release(1))
    .then(begin(2, "delete")).then(acquire(2)).then(read(2)).then(write(2))
    .expect(invariant and not(s.exists) and s.record == Set())
}

