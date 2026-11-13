// agent-backup-restore-v3-candidate-fs-control.ts: active lock uses drain before
// kernel release. Repeated use-release callbacks are idempotent. A failed kernel
// cleanup is terminal in this wrapper but is not an acknowledged release.
module services_fs_lease {
  var s: { phase: str, users: Set[int], kernelHeld: bool, acknowledged: bool, failed: bool }
  action init = s' = { phase: "active", users: Set(), kernelHeld: true, acknowledged: false, failed: false }
  action acquireUse(id: int): bool = all { s.phase == "active", id.in(Set(1,2)), not(s.users.contains(id)), s' = s.with("users", s.users.union(Set(id))) }
  action releaseUse(id: int): bool = s' = s.with("users", s.users.exclude(Set(id)))
  action release = all { s.phase == "active", s' = s.with("phase", "releasing") }
  action cleanupSuccess = all { s.phase == "releasing", s.users.size() == 0, s' = s.with("phase", "released").with("kernelHeld", false).with("acknowledged", true) }
  action cleanupFailure = all { s.phase == "releasing", s.users.size() == 0, s' = s.with("phase", "released").with("failed", true) }
  action keep = s' = s
  action step = any { acquireUse(1), acquireUse(2), releaseUse(1), releaseUse(2), release, cleanupSuccess, cleanupFailure, keep }
  val safety = all { s.users.subseteq(Set(1,2)), s.phase == "released" implies s.users.size() == 0, s.acknowledged implies not(s.kernelHeld or s.failed), s.failed implies not(s.acknowledged), s.users.size() > 0 implies s.kernelHeld }
  run drainsAllUsesTest = init.then(acquireUse(1)).then(acquireUse(2)).then(release).then(releaseUse(1)).then(releaseUse(1)).expect(s.users == Set(2)).then(releaseUse(2)).then(cleanupSuccess).expect(s.acknowledged)
  run failedCleanupNeverAcknowledgedTest = init.then(release).then(cleanupFailure).expect(s.failed and not(s.acknowledged))
}
