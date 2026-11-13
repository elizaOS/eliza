// scheduled-task/store.ts claimForFire and commitApply, with runner.ts
// applyWithResult. One tenant-scoped task and two concurrent request identities.
// JSON equality guards are represented by a revision equality guard. The
// transaction atomically writes state, the merged receipt map and its log.
module ScheduledTaskCommit {
  pure val Clients = Set("first", "second")
  pure val Keys = Set("complete", "snooze")
  type State = {
    status: str, revision: int, occurrence: int, transferred: bool,
    receipts: Set[str], logs: Set[str], applications: str -> int,
    claims: int -> int, phase: str -> str, snapshot: str -> int,
    request: str -> str, key: str -> str, guarded: str -> bool,
    attempts: str -> int, result: str -> str, accepted: str -> bool
  }
  var s: State
  action init = s' = {
    status: "scheduled", revision: 0, occurrence: 0, transferred: false,
    receipts: Set(), logs: Set(), applications: Keys.mapBy(_ => 0), claims: 0.to(2).mapBy(_ => 0),
    phase: Clients.mapBy(_ => "idle"), snapshot: Clients.mapBy(_ => 0),
    request: Clients.mapBy(_ => "claim"), key: Clients.mapBy(_ => "complete"),
    guarded: Clients.mapBy(_ => true), attempts: Clients.mapBy(_ => 0),
    result: Clients.mapBy(_ => "none"), accepted: Clients.mapBy(_ => true)
  }
  action Read(c: str): bool = {
    nondet kind = Set("claim", "apply").oneOf()
    nondet key = Keys.oneOf()
    nondet guarded = Set(true, false).oneOf()
    nondet authorized = Set(true, false).oneOf()
    all {
      Set("idle", "retry").contains(s.phase.get(c)), s.attempts.get(c) < 2,
      s' = { ...s, phase: s.phase.set(c, "ready"), snapshot: s.snapshot.set(c, s.revision),
        request: s.request.set(c, kind), result: s.result.set(c, "none"), key: s.key.set(c, key), guarded: s.guarded.set(c, guarded),
        accepted: s.accepted.set(c, authorized), attempts: s.attempts.set(c, s.attempts.get(c) + 1) }
    }
  }
  action Claim(c: str): bool = all {
    s.phase.get(c) == "ready", s.request.get(c) == "claim",
    if (s.accepted.get(c) and not(s.transferred) and s.status == "scheduled" and s.snapshot.get(c) == s.revision)
      s' = { ...s, status: "fired", revision: s.revision + 1,
        claims: s.claims.set(s.occurrence, s.claims.get(s.occurrence) + 1),
        phase: s.phase.set(c, "done"), result: s.result.set(c, "fired") }
    else s' = { ...s, phase: s.phase.set(c, "done"), result: s.result.set(c, "raced") }
  }
  action Commit(c: str): bool = {
    val k = s.key.get(c)
    val replay = s.receipts.contains(k) and s.logs.contains(k)
    val canWrite = s.accepted.get(c) and not(s.transferred) and not(s.receipts.contains(k))
      and (not(s.guarded.get(c)) or s.snapshot.get(c) == s.revision)
    all {
      s.phase.get(c) == "ready", s.request.get(c) == "apply",
      if (canWrite) s' = { ...s,
        status: if (k == "complete") "completed" else "scheduled",
        occurrence: if (k == "snooze") s.occurrence + 1 else s.occurrence,
        revision: s.revision + 1, receipts: s.receipts.union(Set(k)), logs: s.logs.union(Set(k)),
        applications: s.applications.set(k, s.applications.get(k) + 1),
        phase: s.phase.set(c, "done"), result: s.result.set(c, "applied") }
      else s' = { ...s, phase: s.phase.set(c, "done"), result: s.result.set(c, if (replay and s.accepted.get(c)) "replayed" else "raced") }
    }
  }
  // A failed transaction makes no partial row/log/receipt writes. A retry may
  // observe an already committed receipt after a lost response.
  action AbortWrite(c: str): bool = all {
    s.phase.get(c) == "ready",
    s' = { ...s, phase: s.phase.set(c, "done"), result: s.result.set(c, "error") }
  }
  action LostResponse(c: str): bool = all {
    s.phase.get(c) == "done", s.attempts.get(c) < 2,
    s' = { ...s, phase: s.phase.set(c, "retry") }
  }
  action Transfer = all { not(s.transferred), s' = { ...s, transferred: true, revision: s.revision + 1 } }
  action nextStep = any {
    { nondet c = Clients.oneOf()
      any { Read(c), Claim(c), Commit(c), AbortWrite(c), LostResponse(c) } }, Transfer,
    s' = s
  }
  action step = nextStep
  val ReceiptLogAtomicity = s.receipts == s.logs
  val ApplyAtMostOnce = Keys.forall(k => s.applications.get(k) <= 1)
  val ClaimAtMostOnce = s.claims.keys().forall(o => s.claims.get(o) <= 1)
  val DurableReceiptAccounting = Keys.forall(k => s.receipts.contains(k).iff(s.applications.get(k) == 1))
  val AuthorizationBound = Clients.forall(c =>
    Set("fired", "applied", "replayed").contains(s.result.get(c)).implies(s.accepted.get(c)))
  val TypeOK = and {
    Set("scheduled", "fired", "completed").contains(s.status), s.occurrence >= 0 and s.occurrence <= 1,
    s.receipts.subseteq(Keys), s.logs.subseteq(Keys), s.applications.keys() == Keys,
    Clients.forall(c => s.attempts.get(c) >= 0 and s.attempts.get(c) <= 2)
  }
}
