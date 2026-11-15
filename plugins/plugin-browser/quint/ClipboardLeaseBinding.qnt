// credential-clipboard.ts: a lease keeps its admitted executable paths and
// environment even when later work selects another clipboard backend.
module ClipboardLeaseBinding {
  pure val Ports = Set(0, 1)
  var s: { phase: str, current: int, bound: int, values: int -> str,
    available: Set[int], secret: bool, superseded: bool, lastCleanup: int }
  action init = {
    nondet initial = Ports.oneOf()
    s' = { phase: "new", current: initial, bound: -1,
      values: Ports.mapBy(_ => "other"), available: Ports,
      secret: false, superseded: false, lastCleanup: -1 }
  }
  action admit = all {
    s.phase == "new",
    s' = { ...s, phase: "active", bound: s.current,
      values: s.values.set(s.current, "owned"), secret: true }
  }
  action switchEnvironment = all {
    s.phase == "active", s' = s.with("current", 1 - s.current)
  }
  action newerCopy = all {
    s.phase == "active",
    s' = { ...s, values: s.values.set(s.bound, "newer"), superseded: true }
  }
  action removeExecutable = all {
    s.phase == "active",
    s' = s.with("available", s.available.exclude(Set(s.bound)))
  }
  // Both explicit/automatic expiry and process-exit cleanup use the same
  // bound command pair. An unavailable command never selects another port.
  action finish = all {
    s.phase == "active",
    s' = { ...s, phase: "done", secret: false, lastCleanup: s.bound,
      values: if (s.available.contains(s.bound) and s.values.get(s.bound) == "owned")
        s.values.set(s.bound, "empty") else s.values }
  }
  action step = any { admit, switchEnvironment, newerCopy, removeExecutable, finish, s' = s }
  val safety = all {
    Ports.contains(s.current),
    s.phase != "new" implies Ports.contains(s.bound),
    s.phase == "active" implies s.secret,
    s.phase == "done" implies (not(s.secret) and s.lastCleanup == s.bound),
    s.phase != "new" implies Ports.exclude(Set(s.bound)).forall(p => s.values.get(p) == "other"),
    s.superseded implies s.values.get(s.bound) == "newer"
  }
  temporal Settles = finish.weakFair(s).implies((s.phase == "active").leadsTo(s.phase == "done"))
  run changedPathTest = init.then(admit).then(switchEnvironment).then(finish).expect(safety and s.values.get(s.bound) == "empty")
  run newerCopyTest = init.then(admit).then(newerCopy).then(switchEnvironment).then(finish).expect(safety and s.values.get(s.bound) == "newer")
  run missingExecutableTest = init.then(admit).then(removeExecutable).then(switchEnvironment).then(finish).expect(safety and s.values.get(s.bound) == "owned")
}
