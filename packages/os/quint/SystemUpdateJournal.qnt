/// The host persists each intent before effects. Android transport and disk I/O are separate.
module SystemUpdateJournal {
  type State = {phase: str, operation: str, applyCalls: int}
  var s: State
  action init = s' = {phase: "IDLE", operation: "init", applyCalls: 0}
  action download = all {s.phase == "IDLE", s' = {...s, phase: "DOWNLOADING", operation: "download"}}
  action verify = all {s.phase == "DOWNLOADING", s' = {...s, phase: "VERIFIED", operation: "verify"}}
  action rejectPackage = all {s.phase == "DOWNLOADING", s' = {...s, phase: "FAILED", operation: "reject"}}
  action withdraw = all {s.phase.in(Set("DOWNLOADING", "VERIFIED")), s' = {...s, phase: "IDLE", operation: "withdraw"}}
  action apply = all {s.phase == "VERIFIED", s' = {...s, phase: "APPLY_INTENT", operation: "apply", applyCalls: s.applyCalls + 1}}
  action busy = all {s.phase == "VERIFIED", s' = {...s, operation: "busy"}}
  action acknowledge = all {s.phase == "APPLY_INTENT", s' = {...s, phase: "APPLYING", operation: "acknowledge"}}
  action success = all {s.phase.in(Set("APPLY_INTENT", "APPLYING")), s' = {...s, phase: "REBOOT_READY", operation: "success"}}
  action failure = all {s.phase.in(Set("APPLY_INTENT", "APPLYING")), s' = {...s, phase: "FAILED", operation: "failure"}}
  action foreign = all {s.phase.in(Set("APPLY_INTENT", "APPLYING")), s' = {...s, phase: "UNKNOWN", operation: "foreign"}}
  action reboot = all {s.phase == "REBOOT_READY", s' = {...s, phase: "REBOOT_INTENT", operation: "reboot"}}
  action restart = all {s.phase != "IDLE", s' = {...s, operation: "restart", phase:
    if (s.phase.in(Set("APPLY_INTENT", "APPLYING", "COMPLETE"))) "UNKNOWN"
    else if (s.phase == "REBOOT_INTENT") "SOURCE_RETAINED" else s.phase}}
  action targetBoot = all {s.phase != "IDLE", s' = {...s, phase: "COMPLETE", operation: "target"}}
  action retryUnknown = all {s.phase == "UNKNOWN", s' = {...s, operation: "retry"}}
  action stutter = s' = {...s, operation: "stutter"}
  action step = any {download, verify, rejectPackage, withdraw, apply, busy, acknowledge, success, failure, foreign, reboot, restart, targetBoot, retryUnknown, stutter}
  val AtMostOneApply = s.applyCalls >= 0 and s.applyCalls <= 1
  val TypeOK = s.phase.in(Set("IDLE", "DOWNLOADING", "VERIFIED", "APPLY_INTENT", "APPLYING", "REBOOT_READY", "REBOOT_INTENT", "COMPLETE", "SOURCE_RETAINED", "FAILED", "UNKNOWN"))
  val invariant = AtMostOneApply and TypeOK
  run rejectedPackageNeverAppliesTest = init.then(download).then(rejectPackage).expect(s.phase == "FAILED" and s.applyCalls == 0 and invariant)
  run withdrawnUnappliedCanBeReplacedTest = init.then(download).then(verify).then(withdraw).then(download).then(verify).then(apply).expect(s.applyCalls == 1 and invariant)
  run completedPathTest = init.then(download).then(verify).then(apply).then(acknowledge).then(success).then(reboot).then(targetBoot).expect(s.phase == "COMPLETE" and invariant)
  run unknownIsNeverReplayedTest = init.then(download).then(verify).then(apply).then(restart).then(retryUnknown).expect(s.phase == "UNKNOWN" and s.applyCalls == 1 and invariant)
  run foreignCallbackIsUnknownTest = init.then(download).then(verify).then(apply).then(foreign).expect(s.phase == "UNKNOWN" and invariant)
  run retainedSourceIsNotRollbackProofTest = init.then(download).then(verify).then(apply).then(success).then(reboot).then(restart).expect(s.phase == "SOURCE_RETAINED" and invariant)
}
