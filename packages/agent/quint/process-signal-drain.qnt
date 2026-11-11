// The Agent process adapter owns SIGINT/SIGTERM while its shared cleanup runs.
// Explicit external SIGKILL can end the process with a partial cleanup receipt.
module process_signal_drain {
  pure val Signals = Set("SIGINT", "SIGTERM")
  pure val Cleanup = ["last", "first", "sandbox", "runtime"]

  var s: {
    outcome: str, first: str, repeat: str, receipts: List[str],
    pendingCallback: bool, cleanupFailed: bool, reporter: str
  }

  action init = s' = {
    outcome: "running", first: "none", repeat: "none", receipts: [],
    pendingCallback: false, cleanupFailed: false, reporter: "none"
  }

  val draining = s.outcome == "draining"
  val settled = s.receipts.length() == Cleanup.length() and not(s.pendingCallback)
  val exited = s.outcome.in(Set("exit-0", "exit-1"))

  action start(signal: str): bool = all {
    s.outcome == "running", Signals.contains(signal),
    s' = { ...s, outcome: "draining", first: signal }
  }

  action repeat(signal: str): bool = all {
    draining, s.repeat == "none", Signals.contains(signal),
    s' = s.with("repeat", signal)
  }

  action beginCleanup = all {
    draining, not(s.pendingCallback), s.receipts.length() < Cleanup.length(),
    s' = { ...s, receipts: s.receipts.append(Cleanup.nth(s.receipts.length())),
      pendingCallback: true }
  }

  action settle(ok: bool): bool = all {
    draining, s.pendingCallback,
    s' = { ...s, pendingCallback: false, cleanupFailed: s.cleanupFailed or not(ok) }
  }

  action exitClean = all {
    draining, settled, not(s.cleanupFailed),
    s' = s.with("outcome", "exit-0")
  }

  action exitFailed(reporterOk: bool): bool = all {
    draining, settled, s.cleanupFailed,
    s' = { ...s, outcome: "exit-1",
      reporter: if (reporterOk) "returned" else "threw" }
  }

  action hardKill = all {
    draining,
    s' = s.with("outcome", "SIGKILL")
  }

  action advance = any {
    beginCleanup, settle(true), settle(false), exitClean, exitFailed(true), exitFailed(false)
  }
  action idle = s' = s
  action step = any {
    start("SIGINT"), start("SIGTERM"), repeat("SIGINT"), repeat("SIGTERM"),
    advance, hardKill, idle
  }

  val safety = all {
    s.outcome.in(Set("running", "draining", "exit-0", "exit-1", "SIGKILL")),
    (s.outcome == "running") == (s.first == "none"),
    s.first != "none" implies Signals.contains(s.first),
    s.repeat != "none" implies (s.first != "none" and Signals.contains(s.repeat)),
    s.receipts.length() <= Cleanup.length(),
    s.receipts.indices().forall(i => s.receipts.nth(i) == Cleanup.nth(i)),
    s.pendingCallback implies s.receipts.length() > 0,
    exited implies settled,
    s.outcome == "exit-0" implies not(s.cleanupFailed),
    s.outcome == "exit-1" implies (s.cleanupFailed and s.reporter.in(Set("returned", "threw"))),
    s.outcome != "exit-1" implies s.reporter == "none"
  }

  temporal DrainWithoutFairness = always(s.outcome != "SIGKILL")
    .implies(draining.leadsTo(exited))
  temporal DrainCompletes = advance.weakFair(s).implies(DrainWithoutFairness)

  action completeCallback = beginCleanup.then(settle(true))
  action finishCleanup = completeCallback.then(completeCallback).then(completeCallback)
  run repeatedTerminationTest = init.then(start("SIGTERM")).then(beginCleanup)
    .then(repeat("SIGTERM")).then(settle(true)).then(finishCleanup).then(exitClean)
    .expect(safety and s.outcome == "exit-0")
  run repeatedInterruptFailureTest = init.then(start("SIGINT")).then(beginCleanup).then(repeat("SIGINT"))
    .then(settle(false)).then(finishCleanup).then(exitFailed(false))
    .expect(safety and s.outcome == "exit-1" and s.reporter == "threw")
  run mixedSignalsTest = init.then(start("SIGTERM")).then(beginCleanup).then(repeat("SIGINT"))
    .then(settle(true)).then(finishCleanup).then(exitClean)
    .expect(safety and s.outcome == "exit-0")
  run explicitKillTest = init.then(start("SIGTERM")).then(beginCleanup).then(hardKill)
    .expect(safety and s.outcome == "SIGKILL" and not(settled))

  // The former once-listener returned repeated same-signal delivery to the OS.
  action legacySameSignal = all {
    draining, s.repeat == "none",
    s' = { ...s, repeat: s.first, outcome: s.first }
  }
  run legacyPrematureExitTest = init.then(start("SIGTERM")).then(beginCleanup)
    .then(legacySameSignal).expect(not(safety) and not(settled))
}
