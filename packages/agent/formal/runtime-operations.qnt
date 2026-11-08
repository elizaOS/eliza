// Runtime operations use one per-manager start lane, durable status and health receipts.
// Sources: runtime/operations/{manager,repository,classifier,health,cold-strategy,reload-hot}.ts.
// Abstracts one process; the filesystem repository is not a distributed lock.
module runtime_operations {
  var s: { status: str, key: int, prepared: bool, applied: bool, checked: bool, healthy: bool, receipt: bool }
  action init = s' = { status: "idle", key: -1, prepared: false, applied: false, checked: false, healthy: false, receipt: false }
  action submit(key: int): bool = all { s.status == "idle", s' = s.with("status", "pending").with("key", key).with("prepared", true).with("receipt", true) }
  action execute = all { s.status == "pending", s' = s.with("status", "running") }
  action apply = all { s.status == "running", s' = s.with("status", "checking").with("applied", true) }
  action passHealth = all { s.status == "checking", s' = s.with("checked", true).with("healthy", true).with("status", "succeeded") }
  action failHealth = all { s.status == "checking", s' = s.with("checked", true).with("status", "failed") }
  action failStrategy = all { s.status == "running", s' = s.with("status", "failed") }
  action dedupe(key: int): bool = all { s.status != "idle", s.key == key, s' = s }
  action rejectBusy(key: int): bool = all { Set("pending", "running", "checking").contains(s.status), s.key != key, s' = s }
  action reset = s' = { status: "idle", key: -1, prepared: false, applied: false, checked: false, healthy: false, receipt: false }
  action expire = all { Set("succeeded", "failed").contains(s.status), reset }
  action idle = s' = s
  action step = any { submit(0), submit(1), execute, apply, passHealth, failHealth, failStrategy, dedupe(0), dedupe(1), rejectBusy(0), rejectBusy(1), expire, idle }
  val safety = all { s.status != "idle" implies s.receipt and s.prepared, s.status == "succeeded" implies s.applied and s.checked and s.healthy, s.healthy implies s.checked, s.applied implies s.prepared }
  run failedHealthReceiptTest = init.then(submit(0)).then(execute).then(apply).then(failHealth).then(dedupe(0)).expect(safety and s.status == "failed" and s.applied)
  run duplicateDoesNotReapplyTest = init.then(submit(0)).then(dedupe(0)).then(rejectBusy(1)).then(execute).then(apply).then(passHealth).expect(safety)
}
