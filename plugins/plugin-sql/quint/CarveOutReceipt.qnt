// database-utils/carve-out-migration.ts. Receipt claim, source locking, copy,
// projection verification and receipt completion use one database transaction.
// The callback modeled here copies missing rows and verifies their projection.
module CarveOutReceipt {
  pure val Clients = Set("first", "second")
  pure val Rows = Set("a", "b")
  pure val None = "none"
  type State = {
    receipt: str, priorReceipt: str, lock: str, target: Set[str], staged: Set[str],
    tombstones: Set[str], before: Set[str], phase: str -> str, attempts: str -> int,
    completionWanted: str -> bool, verified: bool
  }
  var s: State
  action init = {
    nondet prior = Set("absent", "running", "completed").oneOf()
    s' = { receipt: "absent", priorReceipt: prior, lock: None, target: Set(), staged: Set(),
      tombstones: Set(), before: Set(), phase: Clients.mapBy(_ => "idle"), attempts: Clients.mapBy(_ => 0),
      completionWanted: Clients.mapBy(_ => true), verified: false }
  }
  action Begin(c: str): bool = {
    nondet complete = Set(true, false).oneOf()
    all {
      Set("idle", "failed", "done").contains(s.phase.get(c)), s.attempts.get(c) < 2, s.lock == None,
      if (s.receipt == "completed") s' = { ...s, phase: s.phase.set(c, "skipped"), attempts: s.attempts.set(c, s.attempts.get(c) + 1) }
      else s' = { ...s, lock: c, staged: s.target, before: s.target, verified: false, phase: s.phase.set(c, "claimed"),
        attempts: s.attempts.set(c, s.attempts.get(c) + 1), completionWanted: s.completionWanted.set(c, complete) }
    }
  }
  action PriorCheck(c: str): bool = all {
    s.lock == c, s.phase.get(c) == "claimed",
    if (s.priorReceipt == "completed") s' = { ...s, lock: None, phase: s.phase.set(c, "skipped") }
    else if (s.priorReceipt == "running") s' = { ...s, lock: None, phase: s.phase.set(c, "failed") }
    else s' = { ...s, phase: s.phase.set(c, "copy") }
  }
  action Copy(c: str): bool = all {
    s.lock == c, s.phase.get(c) == "copy",
    s' = { ...s, staged: s.staged.union(Rows), phase: s.phase.set(c, "verify") }
  }
  action Verify(c: str): bool = all {
    s.lock == c, s.phase.get(c) == "verify", Rows.subseteq(s.staged),
    s' = { ...s, verified: true, phase: s.phase.set(c, "commit") }
  }
  action Commit(c: str): bool = all {
    s.lock == c, s.phase.get(c) == "commit", s.verified,
    s' = { ...s, target: s.staged, receipt: if (s.completionWanted.get(c)) "completed" else "absent",
      lock: None, phase: s.phase.set(c, "done") }
  }
  action Rollback(c: str): bool = all {
    s.lock == c,
    s' = { ...s, staged: s.target, lock: None, phase: s.phase.set(c, "failed") }
  }
  action OwnerDelete(row: str): bool = all {
    s.lock == None, s.receipt == "completed", s.target.contains(row),
    s' = { ...s, target: s.target.exclude(Set(row)), tombstones: s.tombstones.union(Set(row)) }
  }
  action step = any {
    { nondet c = Clients.oneOf()
      any { Begin(c), PriorCheck(c), Copy(c), Verify(c), Commit(c), Rollback(c) } },
    { nondet row = Rows.oneOf()
      OwnerDelete(row) }, s' = s
  }
  val ReceiptPreventsResurrection = s.tombstones.intersect(s.target).size() == 0
  val SingleTransactionOwner = s.lock == None or Clients.contains(s.lock)
  val NoUncommittedCopy = (s.lock != None).implies(s.target == s.before)
  val PriorClaimRespected = (s.priorReceipt != "absent").implies(s.target.size() == 0)
  val VerifiedCompletion = (s.receipt == "completed").implies(s.verified)
}
