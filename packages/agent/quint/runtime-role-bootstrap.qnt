// Role bootstrap retry/coalescing and exact authority sync.
// Source: runtime/roles.ts; core setEntityRoleCas supplies the atomic write guard.
// Canonical owner is entity zero. Entity one may receive connector ADMIN only.
// This proves synchronized outcomes. whitelist() represents a new bootstrap
// configuration/environment, not an in-place edit of an initialized plugin closure.
module runtime_role_bootstrap {
  var s: { ownerRole: str, connectorRole: str, whitelisted: bool, pending: bool, attempt: int, synced: bool }
  action init = s' = { ownerRole: "guest", connectorRole: "guest", whitelisted: false, pending: false, attempt: 0, synced: false }
  action event = all { not(s.pending), s' = s.with("pending", true).with("attempt", 0).with("synced", false) }
  action whitelist(allowed: bool): bool = s' = s.with("whitelisted", allowed).with("synced", false)
  action synchronize = all { s.pending, s' = s.with("ownerRole", "owner").with("connectorRole", if (s.whitelisted) "admin" else "guest").with("pending", false).with("synced", true) }
  action storageUnavailable = all { s.pending, s.attempt < 3, s' = s.with("attempt", s.attempt + 1) }
  action exhausted = all { s.pending, s.attempt == 3, s' = s.with("pending", false) }
  action idle = s' = s
  action step = any { event, whitelist(true), whitelist(false), synchronize, storageUnavailable, exhausted, idle }
  val safety = all { s.attempt <= 3, s.connectorRole != "owner", s.synced implies s.ownerRole == "owner", s.synced implies ((s.connectorRole == "admin") == s.whitelisted) }
  run retryThenSyncTest = init.then(event).then(storageUnavailable).then(synchronize).expect(safety and s.synced)
  run revokeWhitelistGrantTest = init.then(whitelist(true)).then(event).then(synchronize).then(whitelist(false)).then(event).then(synchronize).expect(safety and s.connectorRole == "guest")
}
