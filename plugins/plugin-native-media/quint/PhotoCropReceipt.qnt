// One edit operation, four crop identities and a confirmed publication acknowledgement.
module PhotoCropReceipt {
  var s: { live: bool, reserved: bool, crop: int, published: int, lastAccepted: int, outcome: str }
  action init = s' = { live: true, reserved: false, crop: 0, published: 0, lastAccepted: 0, outcome: "none" }
  action save(crop: int): bool = all { s.live,
    s' = if (crop < 0 or crop > 3) { ...s, outcome: "refused" }
      else if (s.reserved and s.crop != crop) { ...s, outcome: "refused" }
      else if (s.reserved) { ...s, outcome: "saved", lastAccepted: crop }
      else { ...s, reserved: true, crop: crop, published: 1, lastAccepted: crop, outcome: "saved" } }
  action cancel = s' = { ...s, live: false }
  action restart = s' = { ...s, live: true }
  action step = any { { nondet crop = (-1).to(4).oneOf() save(crop) }, cancel, restart, s' = s }
  val OnePublishedCopy = s.published >= 0 and s.published <= 1
  val SuccessfulReplayKeepsCrop = s.outcome == "saved" implies s.crop == s.lastAccepted
  val InvalidCropNeverReserved = s.reserved implies (s.crop >= 0 and s.crop <= 3)
  run selectedRectangleSurvivesReplayTest = init.then(save(2)).then(save(2)).expect(s.published == 1)
  run changedRectangleCannotReuseReceiptTest = init.then(save(2)).then(save(3)).expect(s.outcome == "refused" and s.crop == 2)
  run centeredCropCannotReuseRectangleReceiptTest = init.then(save(2)).then(save(1)).expect(s.outcome == "refused")
  run invalidAreaDoesNotReserveAnEffectTest = init.then(save(4)).expect(not(s.reserved) and s.published == 0)
  run originalIdentitySurvivesRestartTest = init.then(save(2)).then(cancel).then(restart).then(save(3)).expect(s.outcome == "refused")
}
