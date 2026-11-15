// A standalone scheduling worker owns its boot write until it settles.
// Unload withdraws the worker before draining that write and reading its rows.
module ScheduledDriverTeardown {
  pure val Generations = Set(1, 2)
  pure val WriteResults = Set("committed", "ack-lost", "rejected")
  var s: {
    generation: int, phase: str, hooks: Set[int], pending: int,
    row: bool, writeReceipt: str
  }

  action initialize(row: bool): bool = s' = {
    generation: 1, phase: "active", hooks: Set(1), pending: 0,
    row: row, writeReceipt: "none"
  }
  action init = any { initialize(false), initialize(true) }

  val retired = s.phase.in(Set("clean", "cleanup-error"))
  val retiring = s.phase == "retiring"
  val ownsDriver = s.phase == "active"

  action boot(generation: int): bool = all {
    s.hooks.contains(generation),
    {
      val dropped = s.with("hooks", s.hooks.exclude(Set(generation)))
      s' = if (ownsDriver and generation == s.generation)
        { ...dropped, pending: generation, writeReceipt: "pending" }
      else dropped
    }
  }

  action settleWrite(receipt: str): bool = all {
    s.pending != 0, WriteResults.contains(receipt),
    s' = { ...s, pending: 0, row: s.row or receipt != "rejected",
      writeReceipt: receipt }
  }

  action unload = all {
    ownsDriver,
    s' = s.with("phase", "retiring")
  }
  action settleCleanup(ok: bool): bool = all {
    retiring, s.pending == 0,
    s' = { ...s, phase: if (ok) "clean" else "cleanup-error",
      row: not(ok) and s.row }
  }
  action reload = all {
    retired, s.generation == 1,
    s' = { ...s, phase: "active", generation: 2, hooks: s.hooks.union(Set(2)),
      writeReceipt: "none" }
  }
  action advance = any {
    settleWrite("committed"), settleWrite("ack-lost"), settleWrite("rejected"),
    settleCleanup(true), settleCleanup(false)
  }
  action idle = s' = s
  action step = any { boot(1), boot(2), unload, advance, reload, idle }

  val safety = all {
    Generations.contains(s.generation),
    s.phase.in(Set("active", "retiring", "clean", "cleanup-error")),
    s.hooks.subseteq(Generations),
    (s.pending != 0) == (s.writeReceipt == "pending"),
    s.pending != 0 implies
      (s.pending == s.generation and not(retired) and not(s.hooks.contains(s.pending))),
    retired implies s.pending == 0,
    s.phase == "clean" implies not(s.row)
  }

  temporal UnloadWithoutFairness = retiring.leadsTo(retired)
  temporal UnloadSettles = advance.weakFair(s).implies(UnloadWithoutFairness)

  run heldWriteTest = initialize(false).then(boot(1)).then(unload)
    .then(settleWrite("committed")).expect(safety and s.row and retiring)
    .then(settleCleanup(true)).expect(safety and retired and not(s.row))
  run lostAcknowledgementTest = initialize(false).then(boot(1)).then(unload)
    .then(settleWrite("ack-lost")).expect(safety and s.row)
    .then(settleCleanup(true)).then(reload).then(boot(2)).then(settleWrite("committed"))
    .expect(safety and s.row and ownsDriver)
  run staleDeferredHookTest = initialize(false).then(unload).then(settleCleanup(true))
    .then(reload).then(boot(1)).expect(safety and not(s.row) and s.pending == 0)
    .then(boot(2)).then(settleWrite("committed")).expect(safety and s.row)
  run failedCleanupTest = initialize(true).then(boot(1)).then(unload)
    .then(settleWrite("rejected")).then(settleCleanup(false))
    .expect(safety and s.row and s.phase == "cleanup-error")
    .then(reload).then(boot(2)).then(settleWrite("committed")).expect(safety and s.row)

  // The old unload read and deleted the existing rows before the write settled.
  action legacyCleanup = all {
    retiring, s.pending != 0,
    s' = { ...s, phase: "clean", row: false }
  }
  run lateRowWitnessTest = initialize(false).then(boot(1)).then(unload)
    .then(legacyCleanup).then(settleWrite("committed")).expect(not(safety) and s.row)
}
