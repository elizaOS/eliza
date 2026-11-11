// One server-generated consent and its prepared speech object.
// Legacy random recovery IDs retain the existing Redis path.
module speech_prepared_consent {
  var phase: str
  var live: bool
  var admissions: int
  var rejected: int
  action init = all { phase' = "absent", live' = true, admissions' = 0, rejected' = 0 }
  action prepare = all { phase == "absent", live,
    phase' = "prepared", live' = live, admissions' = admissions, rejected' = rejected }
  action expire = all { live, live' = false, phase' = phase, admissions' = admissions, rejected' = rejected }
  action retire = all { phase != "retired", phase' = "retired", live' = live, admissions' = admissions, rejected' = rejected }
  action mint(ownerMatches: bool, nonceMatches: bool): bool = {
    val accepted = phase == "prepared" and live and ownerMatches and nonceMatches
    all { phase' = if (accepted) "minted" else phase,
      admissions' = if (accepted) admissions + 1 else admissions,
      rejected' = if (accepted) rejected else rejected + 1,
      live' = live }
  }
  // New prepared nonces have no Redis entry, so the legacy route cannot mint them.
  action legacyAttempt = all { rejected' = rejected + 1, admissions' = admissions, phase' = phase, live' = live }
  action restart = all { phase' = phase, live' = live, admissions' = admissions, rejected' = rejected }
  action step = any { prepare, expire, retire, legacyAttempt, restart,
    { nondet ownerMatches = Bool.oneOf(); nondet nonceMatches = Bool.oneOf(); mint(ownerMatches, nonceMatches) } }
  val SingleUse = admissions <= 1
  val ValidPhase = Set("absent", "prepared", "minted", "retired").contains(phase)
  val NoAdmissionWithoutPrepare = phase != "absent" or admissions == 0
  val safety = SingleUse and ValidPhase and NoAdmissionWithoutPrepare
  run replayAfterRestart = init.then(prepare).then(mint(true, true)).then(restart).then(mint(true, true)).expect(admissions == 1 and safety)
  run wrongOwner = init.then(prepare).then(mint(false, true)).expect(admissions == 0 and safety)
  run wrongNonce = init.then(prepare).then(mint(true, false)).expect(admissions == 0 and safety)
  run expiredConsent = init.then(prepare).then(expire).then(mint(true, true)).expect(admissions == 0 and safety)
  run retiredConsent = init.then(prepare).then(retire).then(mint(true, true)).expect(admissions == 0 and safety)
  run missingPreparation = init.then(mint(true, true)).expect(admissions == 0 and safety)
  run crossRouteReplay = init.then(prepare).then(mint(true, true)).then(legacyAttempt).expect(admissions == 1 and safety)
}
