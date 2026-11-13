// stripe-delivery-outbox.ts and stripe-legacy-adoption-cursors.ts.
// IDs abstract digest order. A cursor chooses work and never permits deletion.
// A legacy producer can append while adoption runs. KV raw lists are read-only;
// only atomic Redis removal is authorized by matching SQL receipt publication.
module StripeLegacyAdoption {
  const AtomicRemoval: bool
  const ForeignReceipt: bool
  pure val Workers = Set(1, 2)
  pure val Entries = Set(1, 2, 3, 4)
  pure val Valid = Set(1, 2, 4)
  type Worker = { phase: str, snapshot: Set[int], batch: List[int], held: int,
    used: int, first: int, last: int, revision: int, budgetSpent: bool, removal: Set[int] }
  pure val Idle = { phase: "idle", snapshot: Set(), batch: List(), held: 0,
    used: 0, first: 0, last: 0, revision: 0, budgetSpent: false, removal: Set() }
  // Settled call-local snapshots cannot affect later SQL/queue transitions.
  pure def Done(used: int): Worker = {...Idle, phase: "done", used: used}
  var s: { queue: Set[int], everQueued: Set[int], retained: Set[int], sql: int -> str,
    cursor: int, revision: int, workers: int -> Worker, reopened: bool }
  action init = s' = {
    queue: Set(1, 2, 3), everQueued: Set(1, 2, 3), retained: Set(),
    sql: Map(1 -> "marker", 2 -> (if (ForeignReceipt) "foreign" else "marker"), 3 -> "none", 4 -> "marker"),
    cursor: 0, revision: 0, workers: Workers.mapBy(_ => Idle), reopened: false
  }
  action Snapshot(w: int): bool = all {
    s.workers.get(w).phase == "idle",
    s' = {...s, workers: s.workers.set(w, {...Idle, phase: "reserve", snapshot: s.queue})}
  }
  pure def ordered(entries: Set[int], cursor: int): List[int] =
    List(1, 2, 3, 4).select(e => entries.contains(e) and e > cursor)
      .concat(List(1, 2, 3, 4).select(e => entries.contains(e) and e <= cursor))
  action Reserve(w: int, replied: bool): bool = {
    val order = ordered(s.workers.get(w).snapshot, s.cursor)
    val batch = if (order.length() <= 2) order else List(order.nth(0), order.nth(1))
    all {
      s.workers.get(w).phase == "reserve",
      s' = if (batch.length() == 0) {
        ...s, workers: s.workers.set(w, Done(0))
      } else {
        ...s, cursor: batch.head(), revision: s.revision + 1,
        workers: s.workers.set(w, {...s.workers.get(w), phase: if (replied) "select" else "done",
          batch: batch, first: batch.head(), revision: s.revision + 1})
      }
    }
  }
  action Choose(w: int): bool = {
    val worker = s.workers.get(w)
    all {
      worker.phase == "select", worker.batch.length() > 0,
      worker.used == 0 or not(worker.budgetSpent),
      s' = {...s, workers: s.workers.set(w, {...worker, phase: "adopt", held: worker.batch.head(),
        last: worker.batch.head(), used: worker.used + 1, batch: worker.batch.tail()})}
    }
  }
  action Budget(w: int): bool = all {
    not(Set("idle", "done").contains(s.workers.get(w).phase)), not(s.workers.get(w).budgetSpent),
    s' = {...s, workers: s.workers.set(w, {...s.workers.get(w), budgetSpent: true})}
  }
  action Adopt(w: int, committed: bool, replied: bool): bool = {
    val worker = s.workers.get(w)
    val entry = worker.held
    val known = Valid.contains(entry) and Set("marker", "pending", "done").contains(s.sql.get(entry))
    val after = if (known and committed and s.sql.get(entry) == "marker") "pending" else s.sql.get(entry)
    all {
      worker.phase == "adopt",
      s' = {...s, sql: s.sql.set(entry, after),
        retained: if (known and committed) s.retained.union(Set(entry)) else s.retained,
        reopened: s.reopened or (s.sql.get(entry) == "done" and after != "done"),
        workers: s.workers.set(w, {...worker,
          phase: if (known and committed and replied and AtomicRemoval) "remove-read" else "select"})}
    }
  }
  action ReadRemoval(w: int): bool = {
    val worker = s.workers.get(w)
    all { worker.phase == "remove-read", Set("pending", "done").contains(s.sql.get(worker.held)),
      s' = {...s, workers: s.workers.set(w, {...worker, phase: "remove-write",
        removal: s.queue.exclude(Set(worker.held))})} }
  }
  action Remove(w: int, applied: bool): bool = {
    val worker = s.workers.get(w)
    all { worker.phase == "remove-write",
      s' = {...s, queue: if (not(applied)) s.queue else if (AtomicRemoval)
        s.queue.exclude(Set(worker.held)) else worker.removal,
        workers: s.workers.set(w, {...worker, phase: "select"})} }
  }
  action RemovalFailed(w: int): bool = all {
    Set("remove-read", "remove-write").contains(s.workers.get(w).phase),
    s' = {...s, workers: s.workers.set(w, {...s.workers.get(w), phase: "select"})}
  }
  action Finish(w: int): bool = {
    val worker = s.workers.get(w)
    val eligible = worker.phase == "select" and
      (worker.batch.length() == 0 or (worker.used > 0 and worker.budgetSpent))
    val ownsHint = worker.revision == s.revision and worker.last != worker.first
    all { eligible,
      s' = {...s, cursor: if (ownsHint) worker.last else s.cursor,
        revision: if (ownsHint) s.revision + 1 else s.revision,
        workers: s.workers.set(w, Done(worker.used))} }
  }
  action Complete(entry: int): bool = all {
    s.sql.get(entry) == "pending", s' = {...s, sql: s.sql.set(entry, "done")}
  }
  // The row-level DB guard also covers old replicas without the new predicate.
  action Cleanup(entry: int): bool = s' = if (not(s.retained.contains(entry)) and s.sql.get(entry) != "pending") {
    ...s, sql: s.sql.set(entry, "none")
  } else s
  action Crash(w: int): bool = all {
    not(Set("idle", "done").contains(s.workers.get(w).phase)),
    s' = {...s, workers: s.workers.set(w, Done(s.workers.get(w).used))}
  }
  action Advance(w: int): bool = {
    nondet committed = Set(false, true).oneOf()
    nondet replied = Set(false, true).oneOf()
    nondet applied = Set(false, true).oneOf()
    any { Snapshot(w), Reserve(w, replied), Choose(w), Adopt(w, committed, replied),
      ReadRemoval(w), Remove(w, applied), RemovalFailed(w), Finish(w) }
  }
  action step = {
    nondet w = Workers.oneOf()
    nondet entry = Entries.oneOf()
    any { Advance(w), Budget(w), Complete(entry), Cleanup(entry), Crash(w), OldProducer, s' = s }
  }
  val safety = all {
    not(s.reopened),
    s.retained.forall(e => Set("pending", "done").contains(s.sql.get(e))),
    Valid.forall(e => (s.everQueued.contains(e) and not(s.queue.contains(e))) implies Set("pending", "done").contains(s.sql.get(e))),
    s.sql.get(3) == "none",
    Workers.forall(w => s.workers.get(w).used <= 2)
  }
  temporal CallsSettle = Workers.forall(w => Advance(w).weakFair(s)) implies
    eventually(always(Workers.forall(w => Set("idle", "done").contains(s.workers.get(w).phase))))

  // Negative witnesses for the documented unsupported or former transitions.
  action OldProducer = all { not(s.everQueued.contains(4)),
    s' = {...s, queue: s.queue.union(Set(4)), everQueued: s.everQueued.union(Set(4))} }
  action UnsafeKvRead(w: int): bool = all {
    s.workers.get(w).phase == "select", Set("pending", "done").contains(s.sql.get(s.workers.get(w).held)),
    s' = {...s, workers: s.workers.set(w, {...s.workers.get(w),
      phase: "unsafe-kv-write", removal: s.queue.exclude(Set(s.workers.get(w).held))})}
  }
  action UnsafeKvWrite(w: int): bool = all {
    s.workers.get(w).phase == "unsafe-kv-write",
    s' = {...s, queue: s.workers.get(w).removal,
      workers: s.workers.set(w, {...s.workers.get(w), phase: "select"})}
  }
  action UnsafeDrop(entry: int): bool = s' = {...s, queue: s.queue.exclude(Set(entry))}
  action UnsafeUnprotectedCleanup(entry: int): bool = s' = {...s, sql: s.sql.set(entry, "none")}
  action UnsafeUnboundedBatch(w: int): bool = s' = {...s, workers: s.workers.set(w, {...s.workers.get(w), used: 3})}
}
module StripeLegacyAdoption_redis {
  import StripeLegacyAdoption(AtomicRemoval=true, ForeignReceipt=false).*
  run lostSqlReplyRetainsRawTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1))
    .then(Adopt(1, true, false)).expect(safety and s.queue.contains(1) and s.sql.get(1) == "pending")
  run failedSqlRetainsRawTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1))
    .then(Adopt(1, false, false)).expect(safety and s.queue.contains(1) and s.sql.get(1) == "marker")
  run failedRemovalContinuesReservedWorkTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1))
    .then(Adopt(1, true, true)).then(RemovalFailed(1)).then(Choose(1)).then(Adopt(1, true, true))
    .expect(safety and s.queue.contains(1) and s.sql.get(2) == "pending")
  run lostCursorReplyIsNotAdoptionTest = init.then(Snapshot(1)).then(Reserve(1, false))
    .expect(safety and s.cursor == 1 and s.queue.contains(1) and s.sql.get(1) == "marker")
  run timeBudgetCannotAdvancePastUnattemptedTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Budget(1))
    .then(Choose(1)).then(Adopt(1, false, false)).then(Finish(1))
    .expect(safety and s.cursor == 1 and s.workers.get(1).used == 1)
  run staleFinishCannotRewindHintTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1)).then(Adopt(1, false, false))
    .then(Choose(1)).then(Adopt(1, false, false)).then(Snapshot(2)).then(Reserve(2, true)).then(Finish(1))
    .expect(safety and s.cursor == 2)
  run retainedCompletedReceiptSurvivesCleanupTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1))
    .then(Adopt(1, true, true)).then(ReadRemoval(1)).then(Remove(1, true)).then(Complete(1)).then(Cleanup(1))
    .expect(safety and s.sql.get(1) == "done" and s.retained.contains(1))
  run cleanupBeforeAdoptionQuarantinesMissingReceiptTest = init.then(Cleanup(1)).then(Snapshot(1))
    .then(Reserve(1, true)).then(Choose(1)).then(Adopt(1, true, true))
    .expect(safety and s.sql.get(1) == "none" and s.queue.contains(1) and not(s.retained.contains(1)))
  run oldCleanupWithoutDbGuardNegativeWitnessTest = init.then(Snapshot(1)).then(Reserve(1, true))
    .then(Choose(1)).then(Adopt(1, true, true)).then(Complete(1)).then(UnsafeUnprotectedCleanup(1))
    .expect(not(safety))
  run cleanupBeforeReceiptNegativeWitnessTest = init.then(UnsafeDrop(1)).expect(not(safety))
  run unboundedAdoptionNegativeWitnessTest = init.then(UnsafeUnboundedBatch(1)).expect(not(safety))
}

// The production owner visits all three legacy lists in the same cron call.
// A permanent remove error in the first list leaves its matching receipt/raw
// intact and must not abort selection of the processing and dead-letter lists.
module StripeLegacyAdoption_queues {
  pure val Lists = Set(1, 2, 3)
  var s: { list: int, phase: str, raw: Set[int], receipts: Set[int] }
  action init = s' = { list: 1, phase: "adopt", raw: Lists, receipts: Set() }
  action Adopt = all {
    s.phase == "adopt",
    s' = {...s, receipts: s.receipts.union(Set(s.list)), phase: "remove"}
  }
  action Remove = all {
    s.phase == "remove", s.receipts.contains(s.list),
    s' = {...s, raw: if (s.list == 1) s.raw else s.raw.exclude(Set(s.list)), phase: "next"}
  }
  action Next = all {
    s.phase == "next",
    s' = if (s.list == 3) {...s, phase: "done"} else {...s, list: s.list + 1, phase: "adopt"}
  }
  action step = any { Adopt, Remove, Next, s' = s }
  val safety = Lists.forall(list => not(s.raw.contains(list)) implies s.receipts.contains(list))
  val AllTransferred = s.receipts == Lists
  temporal LaterListsProgress = (Adopt.weakFair(s) and Remove.weakFair(s) and Next.weakFair(s)) implies eventually(AllTransferred)
  action UnsafeAbortOnRemoval = all { s.phase == "remove", s' = {...s, phase: "done"} }
  run permanentFirstRemovalFailureRetainsReceiptAndReachesLaterListsTest = init
    .then(Adopt).then(Remove).then(Next).then(Adopt).then(Remove).then(Next)
    .then(Adopt).then(Remove).then(Next).expect(safety and AllTransferred and s.raw == Set(1))
  run abortingOnFirstRemovalFailureNegativeWitnessTest = init.then(Adopt).then(UnsafeAbortOnRemoval)
    .expect(safety and not(AllTransferred) and s.raw == Lists)
}
module StripeLegacyAdoption_kv {
  import StripeLegacyAdoption(AtomicRemoval=false, ForeignReceipt=false).*
  run readOnlyAdoptionPreservesConcurrentOldWriterTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1)).then(Adopt(1, true, true))
    .then(OldProducer).then(Choose(1)).then(Adopt(1, true, true))
    .expect(safety and s.queue == Set(1, 2, 3, 4) and s.sql.get(1) == "pending" and s.sql.get(2) == "pending")
  run completedReceiptCannotReopenTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1)).then(Adopt(1, true, false)).then(Complete(1))
    .then(Choose(1)).then(Adopt(1, false, false)).then(Finish(1))
    .then(Snapshot(2)).then(Reserve(2, true)).then(Choose(2)).then(Adopt(2, false, false))
    .then(Choose(2)).then(Adopt(2, true, true))
    .expect(safety and s.sql.get(1) == "done" and s.queue.contains(1))
  run unfencedKvRemovalLosesConcurrentAppendNegativeWitnessTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1)).then(Adopt(1, true, true))
    .then(UnsafeKvRead(1)).then(OldProducer).then(UnsafeKvWrite(1)).expect(not(safety))
}
module StripeLegacyAdoption_conflict {
  import StripeLegacyAdoption(AtomicRemoval=false, ForeignReceipt=true).*
  run foreignReceiptRetainsOriginalTest = init.then(Snapshot(1)).then(Reserve(1, true)).then(Choose(1)).then(Adopt(1, false, false))
    .then(Choose(1)).then(Adopt(1, true, true)).expect(safety and s.sql.get(2) == "foreign" and s.queue.contains(2))
  run uniquenessAloneNegativeWitnessTest = init.then(UnsafeDrop(2)).expect(not(safety))
}

// Progress is deliberately narrower than the two-adopter safety model: one
// fair cron runs three times over a fixed snapshot, and SQL is available.
// Even a stale KV snapshot and a budget permitting only one attempt must not
// let the permanent poison entry starve the two valid entries.
module StripeLegacyAdoption_progress {
  pure val Valid = Set(2, 3)
  var s: { cursor: int, turn: int, phase: str, stored: Set[int], first: int,
    second: int, last: int, used: int }
  pure def following(e: int): int = if (e == 3) 1 else e + 1
  action init = s' = { cursor: 0, turn: 0, phase: "start", stored: Set(),
    first: 0, second: 0, last: 0, used: 0 }
  action Start = all {
    s.phase == "start", s.turn < 3,
    s' = {...s, cursor: following(s.cursor), first: following(s.cursor),
      second: following(following(s.cursor)), phase: "first", used: 0}
  }
  action First = all {
    s.phase == "first",
    s' = {...s, stored: if (Valid.contains(s.first)) s.stored.union(Set(s.first)) else s.stored,
      last: s.first, phase: "finish", used: 1}
  }
  action Second = all {
    s.phase == "finish", s.used == 1,
    s' = {...s, stored: if (Valid.contains(s.second)) s.stored.union(Set(s.second)) else s.stored,
      last: s.second, used: 2}
  }
  action Finish = all {
    s.phase == "finish",
    s' = {...s, cursor: s.last, turn: s.turn + 1,
      phase: if (s.turn + 1 == 3) "done" else "start"}
  }
  action step = any { Start, First, Second, Finish, s' = s }
  val safety = all { s.stored.forall(e => Valid.contains(e)), s.used <= 2 }
  val AllTransferred = Valid.forall(e => s.stored.contains(e))
  temporal Progress = (Start.weakFair(s) and First.weakFair(s) and Finish.weakFair(s)) implies eventually(AllTransferred)
  action UnsafeRestartAtHead = s' = {...s, cursor: 0}
  run oneAttemptBudgetStillReachesEveryValidEntryTest = init
    .then(Start).then(First).then(Finish).then(Start).then(First).then(Finish)
    .then(Start).then(First).then(Finish).expect(safety and AllTransferred)
  run restartingAtPoisonedPrefixNegativeWitnessTest = init
    .then(Start).then(First).then(Finish).then(UnsafeRestartAtHead)
    .then(Start).then(First).then(Finish).then(UnsafeRestartAtHead)
    .then(Start).then(First).then(Finish).expect(not(AllTransferred))
}
