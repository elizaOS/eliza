/// One enrolled device and one candidate; cryptographic acceptance is an external fact.
module SystemUpdateHost {
  type State = {phase: str, active: bool, eligible: bool, stopped: bool,
    verified: bool, applyCalls: int, reboots: int}
  var s: State
  action init = s' = {phase: "idle", active: false, eligible: true, stopped: false,
    verified: false, applyCalls: 0, reboots: 0}
  action start = all {not(s.active), s.phase.in(Set("idle", "downloading", "verified", "ready")),
    s' = {...s, active: true, stopped: false}}
  action download = all {s.active, s.phase == "idle", s.eligible,
    s' = {...s, phase: "downloading"}}
  action verify = all {s.active, s.phase == "downloading",
    s' = {...s, phase: "verified", verified: true}}
  action reject = all {s.active, s.phase == "downloading", s' = {...s, phase: "failed", active: false}}
  action apply = all {s.active, not(s.stopped), s.eligible, s.phase == "verified", s.verified,
    s' = {...s, phase: "applying", applyCalls: s.applyCalls + 1}}
  action callback = all {s.phase == "applying", s' = {...s, phase: "ready", active: false}}
  action failure = all {s.phase == "applying", s' = {...s, phase: "failed", active: false}}
  action reboot = all {s.active, not(s.stopped), s.eligible, s.phase == "ready",
    s' = {...s, phase: "reboot-intent", reboots: s.reboots + 1}}
  action observeTarget = all {s.phase == "reboot-intent", s' = {...s, phase: "complete", active: false}}
  action stop = all {s.active, s' = {...s, stopped: true,
    active: s.phase == "applying", phase: s.phase}}
  action crash = all {s.active, s' = {...s, active: false,
    phase: if (s.phase == "applying") "unknown" else if (s.phase == "reboot-intent") "source-retained" else s.phase}}
  action conditions(eligible: bool): bool = s' = {...s, eligible: eligible}
  action stutter = s' = s
  action step = any {start, download, verify, reject, apply, callback, failure,
    reboot, observeTarget, stop, crash, conditions(true), conditions(false), stutter}
  action stableStep = any {start, download, verify, apply, callback, reboot, observeTarget, stutter}
  val NoUnverifiedApply = s.applyCalls == 0 or s.verified
  val NoReplay = s.applyCalls >= 0 and s.applyCalls <= 1 and s.reboots >= 0 and s.reboots <= 1
  val UnknownNeverActive = s.phase != "unknown" or not(s.active)
  temporal StableDeliveryCompletes = (start.weakFair(s) and download.weakFair(s)
    and verify.weakFair(s) and apply.weakFair(s) and callback.weakFair(s)
    and reboot.weakFair(s) and observeTarget.weakFair(s))
    implies eventually(s.phase == "complete")
  run stoppedDownloadResumesBeforeApplyTest = init.then(start).then(download).then(stop)
    .then(start).then(verify).then(apply).expect(s.applyCalls == 1 and NoUnverifiedApply and NoReplay)
  run rejectedPackageNoApplyTest = init.then(start).then(download).then(reject)
    .expect(s.applyCalls == 0 and NoUnverifiedApply and NoReplay)
  run interruptedApplyStaysUnknownTest = init.then(start).then(download).then(verify).then(apply)
    .then(crash).expect(s.phase == "unknown" and s.applyCalls == 1 and UnknownNeverActive)
  run stoppedVerificationCannotApplyTest = init.then(start).then(download).then(verify).then(stop)
    .expect(not(s.active) and s.applyCalls == 0)
  run readyWaitsForEligibleJobTest = init.then(start).then(download).then(verify).then(apply)
    .then(callback).then(conditions(false)).then(start).expect(s.phase == "ready" and s.reboots == 0)
    .then(conditions(true)).then(reboot).then(observeTarget).expect(s.phase == "complete" and NoReplay)
}
