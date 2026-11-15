// Credential key selection belongs to the branded storage policy, not runner signals.
module AccountStorageKeyOwnership {
  const RuntimeOwner: bool
  const VaultAvailable: bool
  var s: { phase: str, signal: bool, process: int, key: str, exists: bool, readable: bool }
  val selectedKey = if (RuntimeOwner)
    (if (VaultAvailable) "vault" else "unavailable")
    else (if (s.process == 0) "isolated-0" else "isolated-1")
  action init = s' = { phase: "write", signal: false, process: 0,
    key: "none", exists: false, readable: false }
  action changeRunnerSignal = all { s.phase != "done", s' = {...s, signal: not(s.signal)} }
  action write = all { s.phase == "write", s' = {...s,
    key: selectedKey, exists: selectedKey != "unavailable",
    phase: if (selectedKey == "unavailable") "done" else "restart"} }
  action restart = all { s.phase == "restart", s' = {...s,
    process: 1, signal: not(s.signal), phase: "read"} }
  action read = all { s.phase == "read", s' = {...s,
    readable: s.exists and s.key == selectedKey, phase: "done"} }
  action step = any { changeRunnerSignal, write, restart, read, s' = s }
  val TypeOK = and {
    Set("write", "restart", "read", "done").contains(s.phase),
    Set(0, 1).contains(s.process),
    Set("none", "vault", "unavailable", "isolated-0", "isolated-1").contains(s.key),
  }
  val PolicyOwnsKey = s.exists implies
    (if (RuntimeOwner) s.key == "vault" else s.key == "isolated-0")
  val NoVaultFallback = RuntimeOwner and not(VaultAvailable) implies not(s.exists)
  val RuntimeSurvivesRestart = RuntimeOwner and VaultAvailable and s.phase == "done" implies s.readable
  val IsolatedKeyCannotReopen = not(RuntimeOwner) and s.phase == "done" implies not(s.readable)
  temporal OperationsSettle = and { write.weakFair(s), restart.weakFair(s), read.weakFair(s) }
    implies eventually(s.phase == "done")
  run runnerSignalsDoNotSelectKey = init.then(changeRunnerSignal).then(write).expect(PolicyOwnsKey and NoVaultFallback)
}
module AccountStorageKeyRuntime {
  import AccountStorageKeyOwnership(RuntimeOwner = true, VaultAvailable = true).*
  run persists = init.then(write).then(restart).then(changeRunnerSignal).then(read).expect(s.readable)
}
module AccountStorageKeyUnavailable {
  import AccountStorageKeyOwnership(RuntimeOwner = true, VaultAvailable = false).*
  run refuses = init.then(changeRunnerSignal).then(write).expect(not(s.exists) and s.phase == "done")
}
module AccountStorageKeyIsolated {
  import AccountStorageKeyOwnership(RuntimeOwner = false, VaultAvailable = false).*
  run isolated = init.then(write).then(restart).then(read).expect(not(s.readable))
}
