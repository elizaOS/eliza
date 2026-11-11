/// One enrolled device and one candidate. Download completion and cryptographic acceptance are external facts.
module SystemUpdateHost {
  type State = {phase: str, active: bool, eligible: bool, stopped: bool,
    verified: bool, checked: bool, storageReady: bool, scratch: str, writing: bool,
    applyCalls: int, reboots: int}
  var s: State
  pure def initial(storageReady: bool): State = {
    phase: "idle", active: false, eligible: true, stopped: false,
    verified: false, checked: false, storageReady: storageReady, scratch: "none",
    writing: false, applyCalls: 0, reboots: 0
  }
  action init = s' = initial(true)
  action storageBlockedInit = s' = initial(false)
  action scratchRecoveryInit = s' = {...initial(true), phase: "downloading", scratch: "owned"}
  action foreignScratchInit = s' = {...initial(true), scratch: "foreign"}
  action start = all {not(s.active), s.phase.in(Set("idle", "downloading", "verified", "ready")),
    s' = {...s, active: true, stopped: false, checked: false}}
  action download = all {s.active, s.phase == "idle", s.eligible,
    s' = {...s, phase: "downloading"}}
  val checkingUnapplied = s.active and not(s.stopped) and not(s.checked)
    and s.phase.in(Set("downloading", "verified"))
  action writeScratch = all {checkingUnapplied, s.storageReady, s.scratch == "none",
    s' = {...s, scratch: "owned", writing: true}}
  action reclaimScratch = all {checkingUnapplied, s.scratch == "owned", not(s.writing),
    s' = {...s, scratch: "none"}}
  action refuseScratch = all {checkingUnapplied, s.scratch == "foreign",
    s' = {...s, active: false}}
  action verify = all {checkingUnapplied, s.storageReady, s.scratch == "none" or s.writing,
    s' = {...s, phase: "verified", verified: true, checked: true, scratch: "none", writing: false}}
  action deferStorage = all {checkingUnapplied, not(s.storageReady), s.scratch == "none",
    s' = {...s, active: false}}
  action reject = all {checkingUnapplied, s' = {...s, phase: "failed", active: false,
    scratch: if (s.writing) "none" else s.scratch, writing: false}}
  action apply = all {s.active, not(s.stopped), s.eligible, s.phase == "verified", s.checked,
    s' = {...s, phase: "applying", applyCalls: s.applyCalls + 1}}
  action callback = all {s.phase == "applying", s' = {...s, phase: "ready", active: false}}
  action failure = all {s.phase == "applying", s' = {...s, phase: "failed", active: false}}
  action checkHeld(valid: bool): bool = all {s.active, not(s.stopped), not(s.checked), s.phase == "ready",
    s' = {...s, active: valid and s.storageReady, checked: valid and s.storageReady}}
  action holdEngine = all {s.active, not(s.stopped), s.eligible, s.checked, s.phase == "ready",
    s' = {...s, active: false, checked: false}}
  action reboot = all {s.active, not(s.stopped), s.eligible, s.checked, s.phase == "ready",
    s' = {...s, phase: "reboot-intent", reboots: s.reboots + 1}}
  action observeTarget = all {s.phase == "reboot-intent", s' = {...s, phase: "complete", active: false}}
  action stop = all {s.active, s' = {...s, stopped: true,
    active: s.phase == "applying", checked: s.phase == "applying" and s.checked,
    scratch: if (s.writing) "none" else s.scratch, writing: false}}
  action crash = all {s.active, s' = {...s, active: false, checked: false,
    writing: false,
    phase: if (s.phase == "applying") "unknown" else if (s.phase == "reboot-intent") "source-retained" else s.phase}}
  action conditions(eligible: bool): bool = s' = {...s, eligible: eligible}
  action storage(ready: bool): bool = all {s.storageReady != ready,
    s' = {...s, storageReady: ready}}
  action stutter = s' = s
  action step = any {start, download, writeScratch, reclaimScratch, refuseScratch, verify, deferStorage, reject, apply, callback, failure,
    checkHeld(true), checkHeld(false), holdEngine, reboot, observeTarget, stop, crash, conditions(true), conditions(false), storage(true), storage(false), stutter}
  action stableStep = any {start, download, reclaimScratch, verify, deferStorage, apply, callback, checkHeld(true), reboot, observeTarget,
    storage(true), stutter}
  val NoUnverifiedApply = (s.applyCalls == 0 or s.verified) and (s.phase != "applying" or s.checked)
  val NoReplay = s.applyCalls >= 0 and s.applyCalls <= 1 and s.reboots >= 0 and s.reboots <= 1
  val UnknownNeverActive = s.phase != "unknown" or not(s.active)
  val ScratchNeverApplied = (s.scratch != "owned" or s.phase.in(Set("downloading", "verified", "failed")))
    and (not(s.writing) or (checkingUnapplied and s.scratch == "owned"))
  temporal StableDeliveryWork = start.weakFair(s) and download.weakFair(s) and verify.weakFair(s)
    and deferStorage.weakFair(s) and apply.weakFair(s) and callback.weakFair(s)
    and checkHeld(true).weakFair(s) and reboot.weakFair(s) and observeTarget.weakFair(s)
  temporal StableDeliveryCompletes = (storage(true).weakFair(s) and reclaimScratch.weakFair(s) and StableDeliveryWork)
    implies eventually(s.phase == "complete")
  temporal DeliveryWithoutStorageFairness = (reclaimScratch.weakFair(s) and StableDeliveryWork)
    implies eventually(s.phase == "complete")
  temporal DeliveryWithoutScratchFairness = (storage(true).weakFair(s) and StableDeliveryWork)
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
    .then(checkHeld(true)).then(conditions(true)).then(reboot).then(observeTarget).expect(s.phase == "complete" and NoReplay)
  run heldArtifactRefusalNeverWritesOrDispatchesTest = init.then(start).then(download).then(verify).then(apply)
    .then(callback).then(start).expect(not(s.checked) and s.reboots == 0).then(checkHeld(false))
    .expect(s.phase == "ready" and not(s.active) and not(s.checked) and not(s.writing) and s.applyCalls == 1 and s.reboots == 0)
  run heldVerificationStillRequiresEngineReadinessTest = init.then(start).then(download).then(verify).then(apply)
    .then(callback).then(start).then(checkHeld(true)).then(holdEngine)
    .expect(s.phase == "ready" and not(s.active) and s.applyCalls == 1 and s.reboots == 0)
  run lowSpacePreservesDownloadUntilLaterJobTest = storageBlockedInit.then(start).then(download)
    .then(deferStorage).expect(s.phase == "downloading" and not(s.active) and s.applyCalls == 0)
    .then(storage(true)).then(start).then(verify).then(apply).expect(s.applyCalls == 1 and NoUnverifiedApply)
  run lowSpaceOnRecheckPreservesVerifiedCandidateTest = init.then(start).then(download).then(verify)
    .then(stop).then(storage(false)).then(start).then(deferStorage)
    .expect(s.phase == "verified" and s.verified and not(s.checked) and s.applyCalls == 0)
    .then(start).then(storage(true)).then(verify).then(apply).expect(s.applyCalls == 1 and NoUnverifiedApply)
  run recoveredSpaceDoesNotExcuseRejectionTest = storageBlockedInit.then(start).then(download)
    .then(deferStorage).then(storage(true)).then(start).then(reject)
    .expect(s.phase == "failed" and s.applyCalls == 0 and not(s.active))
  run scratchAfterProcessDeathReusesOneSlotTest = init.then(start).then(download)
    .then(writeScratch).then(crash).expect(s.scratch == "owned" and not(s.writing))
    .then(start).then(reclaimScratch).then(writeScratch).then(crash)
    .then(start).then(reclaimScratch).then(writeScratch).then(verify)
    .expect(s.scratch == "none" and s.phase == "verified" and s.applyCalls == 0 and ScratchNeverApplied)
  run scratchUnrecognizedIsHeldTest = foreignScratchInit.then(start).then(download).then(refuseScratch)
    .expect(s.scratch == "foreign" and s.phase == "downloading" and not(s.active) and s.applyCalls == 0)
}
