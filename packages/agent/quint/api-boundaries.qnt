// Source-derived access scope, runtime-mode cache invalidation and configuration commit.
// Abstract identities: owner vs other. Host-only authorization is a precondition to mutation.
// External role resolution, cryptography, SSRF and provider behavior remain trusted contracts.
module api_boundaries {
  var s: { owner: bool, privateRoom: bool, scope: str, snapshot: bool, sourceCurrent: bool, loadFailed: bool, staged: bool, persisted: bool, active: bool }
  action init = s' = { owner: false, privateRoom: false, scope: "none", snapshot: false, sourceCurrent: false, loadFailed: false, staged: false, persisted: false, active: false }
  action owner = s' = s.with("owner", true)
  action privateRoom = s' = s.with("privateRoom", true)
  action ingest = s' = s.with("scope", if (s.owner and s.privateRoom) "owner-private" else "user-private")
  action load = s' = s.with("snapshot", true).with("sourceCurrent", true).with("loadFailed", false)
  action sourceChanged = s' = s.with("sourceCurrent", false).with("snapshot", false)
  action failedReload = s' = s.with("snapshot", false).with("loadFailed", true).with("sourceCurrent", false)
  action stage = all { s.owner, s' = s.with("staged", true) }
  action persist = all { s.staged, s' = s.with("persisted", true) }
  action activate = all { s.persisted, s' = s.with("active", true) }
  action idle = s' = s
  action step = any { owner, privateRoom, ingest, load, sourceChanged, failedReload, stage, persist, activate, idle }
  val safety = all { s.scope == "owner-private" implies (s.owner and s.privateRoom), s.snapshot implies (s.sourceCurrent and not(s.loadFailed)), s.active implies s.persisted }
  run changedSourceNeverReusesAuthorityTest = init.then(load).then(sourceChanged).then(failedReload).expect(not(s.snapshot))
  run publicOwnerIngestStaysPrivateToSenderTest = init.then(owner).then(ingest).expect(s.scope == "user-private")
  run durableConfigBeforeActivationTest = init.then(owner).then(stage).then(persist).then(activate).expect(safety)
}
