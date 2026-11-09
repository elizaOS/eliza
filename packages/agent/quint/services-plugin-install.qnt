// plugin-installer/remote-plugin-adapter/self-updater: plan identity is validated
// before installation/configuration, completion means persisted configuration.
module services_plugin_install {
  var s: { phase: str, approved: int, resolved: int, validated: bool, configured: bool, receipt: bool }
  action init = s' = { phase: "idle", approved: 0, resolved: 0, validated: false, configured: false, receipt: false }
  action approve(identity: int): bool = all { s.phase == "idle", identity.in(Set(1,2)), s' = s.with("phase", "resolving").with("approved", identity) }
  action resolve(identity: int): bool = all { s.phase == "resolving", identity.in(Set(1,2)), s' = s.with("phase", if (identity == s.approved) "downloading" else "error").with("resolved", identity) }
  action downloaded = all { s.phase == "downloading", s' = s.with("phase", "validating") }
  action validate = all { s.phase == "validating", s.resolved == s.approved, s' = s.with("validated", true).with("phase", "configuring") }
  action configure = all { s.phase == "configuring", s' = s.with("configured", true).with("phase", "complete").with("receipt", true) }
  action failure = all { s.phase.in(Set("downloading","validating","configuring")), s' = s.with("phase", "error") }
  action keep = s' = s
  action step = any { approve(1), approve(2), resolve(1), resolve(2), downloaded, validate, configure, failure, keep }
  val safety = all { s.configured implies s.validated and s.approved == s.resolved, s.receipt == (s.phase == "complete"), s.receipt implies s.configured }
  run identityDriftRejectedTest = init.then(approve(1)).then(resolve(2)).expect(s.phase == "error" and not(s.configured))
  run completeRequiresConfigTest = init.then(approve(2)).then(resolve(2)).then(downloaded).then(validate).then(configure).expect(s.receipt)
}
