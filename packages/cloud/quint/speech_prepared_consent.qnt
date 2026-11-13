// One server-generated consent and its prepared speech object.
// Legacy random recovery IDs retain the existing Redis path.
module speech_prepared_consent {
  var phase: str
  var live: bool
  // Bootstrap record and expiry alarm commit together.
  var armed: bool
  var preparedOnce: bool
  var admissions: int
  // Last outcome, not an unbounded diagnostic counter: this model is finite.
  var lastRefused: bool
  action init = all { phase' = "absent", live' = true, preparedOnce' = false,
    admissions' = 0, lastRefused' = false, armed' = false }
  action prepare = all { phase == "absent", live,
    phase' = "prepared", live' = live, preparedOnce' = true,
    admissions' = admissions, lastRefused' = lastRefused, armed' = true }
  action expire = all { live, live' = false, phase' = phase, preparedOnce' = preparedOnce,
    admissions' = admissions, lastRefused' = lastRefused, armed' = false }
  action retire = all { phase != "retired", phase' = "retired", live' = live,
    preparedOnce' = preparedOnce, admissions' = admissions, lastRefused' = lastRefused, armed' = false }
  action mint(ownerMatches: bool, organizationMatches: bool, nonceMatches: bool): bool = {
    val accepted = phase == "prepared" and live and ownerMatches and organizationMatches and nonceMatches
    all { phase' = if (accepted) "minted" else phase,
      admissions' = if (accepted) admissions + 1 else admissions,
      lastRefused' = not(accepted), preparedOnce' = preparedOnce, live' = live, armed' = armed }
  }
  // New prepared nonces have no Redis entry, so the legacy route cannot mint them.
  action legacyAttempt = all { lastRefused' = true, admissions' = admissions,
    phase' = phase, preparedOnce' = preparedOnce, live' = live, armed' = armed }
  // Durable restart preserves the original record and deadline, never fresh consent.
  action restart = all { phase' = phase, live' = live, preparedOnce' = preparedOnce,
    admissions' = admissions, lastRefused' = lastRefused, armed' = armed }
  // A failed atomic bootstrap publishes neither the row nor its alarm.
  action failedPrepare = all { phase == "absent", phase' = phase, live' = live,
    preparedOnce' = preparedOnce, admissions' = admissions, lastRefused' = lastRefused, armed' = armed }
  action step = any { prepare, failedPrepare, expire, retire, legacyAttempt, restart,
    { nondet ownerMatches = Bool.oneOf(); nondet organizationMatches = Bool.oneOf();
      nondet nonceMatches = Bool.oneOf(); mint(ownerMatches, organizationMatches, nonceMatches) } }
  val SingleUse = admissions >= 0 and admissions <= 1
  val ValidPhase = Set("absent", "prepared", "minted", "retired").contains(phase)
  val NoAdmissionWithoutPrepare = admissions > 0 implies preparedOnce
  val ArmedBeforeMint = phase == "prepared" and live implies armed
  val safety = SingleUse and ValidPhase and NoAdmissionWithoutPrepare and ArmedBeforeMint
  run failedPreparationLeavesNothing = init.then(failedPrepare).expect(phase == "absent" and not(armed) and safety)
  run replayAfterRestart = init.then(prepare).then(mint(true, true, true)).then(restart).then(mint(true, true, true)).expect(admissions == 1 and lastRefused and safety)
  run wrongOwner = init.then(prepare).then(mint(false, true, true)).expect(admissions == 0 and lastRefused and safety)
  run wrongOrganization = init.then(prepare).then(mint(true, false, true)).expect(admissions == 0 and lastRefused and safety)
  run wrongNonce = init.then(prepare).then(mint(true, true, false)).expect(admissions == 0 and lastRefused and safety)
  run expiredConsent = init.then(prepare).then(expire).then(mint(true, true, true)).expect(admissions == 0 and lastRefused and safety)
  run retiredConsent = init.then(prepare).then(retire).then(mint(true, true, true)).expect(admissions == 0 and lastRefused and safety)
  run missingPreparation = init.then(mint(true, true, true)).expect(admissions == 0 and lastRefused and safety)
  run crossRouteReplay = init.then(prepare).then(mint(true, true, true)).then(legacyAttempt).expect(admissions == 1 and lastRefused and safety)
  run originalPreparedConsentSurvivesRestart = init.then(prepare).then(restart).then(mint(true, true, true)).expect(admissions == 1 and safety)
  run restartDoesNotRenewExpiry = init.then(prepare).then(restart).then(expire).then(mint(true, true, true)).expect(admissions == 0 and lastRefused and safety)
}
