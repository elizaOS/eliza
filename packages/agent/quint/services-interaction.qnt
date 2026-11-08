// message-interaction-host/store: durable commitment precedes external effect;
// crashes after commit require reconciliation, never blind re-execution.
// Claim/authorization semantics are delegated to core and abstracted by guards.
module services_interaction {
  var s: { phase: str, lockOwner: int, authorized: bool, commitment: bool, receipt: bool, effects: int, marker: bool }
  action init = s' = { phase: "pending", lockOwner: 0, authorized: true, commitment: false, receipt: false, effects: 0, marker: false }
  action acquire(owner: int): bool = all { s.lockOwner == 0, not(s.marker), owner.in(Set(1,2)), s' = s.with("lockOwner", owner) }
  action release = all { s.lockOwner != 0, s' = s.with("lockOwner", 0) }
  action claim = all { s.phase == "pending", s.lockOwner != 0, s.authorized, s' = s.with("phase", "claimed") }
  action commit = all { s.phase == "claimed", s.lockOwner != 0, s.authorized, s' = s.with("phase", "committed").with("commitment", true) }
  action effect = all { s.phase == "committed", s.effects == 0, s' = s.with("effects", 1).with("phase", "effected") }
  action completeReceipt = all { s.phase == "effected", s' = s.with("phase", "completed").with("receipt", true) }
  action completionWriteFailed = all { s.phase == "effected", s' = s.with("phase", "uncertain") }
  action crash = all { s.lockOwner != 0, s' = s.with("lockOwner", 0).with("marker", true) }
  action reconcileLock = all { s.marker, s.lockOwner == 0, s' = s.with("marker", false) }
  action reconcileEffect = all { s.phase == "committed", s.commitment, s' = s.with("phase", "uncertain") }
  action revoke = s' = s.with("authorized", false)
  action keep = s' = s
  action step = any { acquire(1), acquire(2), release, claim, commit, effect, completeReceipt, completionWriteFailed, crash, reconcileLock, reconcileEffect, revoke, keep }
  val safety = all { s.lockOwner.in(Set(0,1,2)), s.effects.in(Set(0,1)), s.effects > 0 implies s.commitment, s.phase.in(Set("committed", "effected", "completed", "uncertain")) == s.commitment, s.receipt implies s.phase == "completed", s.marker implies s.lockOwner == 0 }
  run commitCrashDoesNotRepeatTest = init.then(acquire(1)).then(claim).then(commit).then(crash).then(reconcileLock).then(reconcileEffect).expect(s.commitment and not(s.receipt) and s.effects == 0 and s.phase == "uncertain")
  run commitmentBeforeEffectTest = init.then(acquire(2)).then(claim).then(commit).then(release).then(effect).expect(s.effects == 1 and not(s.receipt)).then(completeReceipt).expect(s.receipt)
  run failedCompletionDoesNotEraseEffectTest = init.then(acquire(1)).then(claim).then(commit).then(effect).then(completionWriteFailed).expect(s.commitment and s.effects == 1 and not(s.receipt))
}
