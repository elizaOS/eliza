// One server-generated consent and its prepared speech object.
// Legacy random recovery IDs retain the existing Redis path.
module speech_prepared_consent {
  var credential: str
  var phase: str
  var live: bool
  // Bootstrap record and expiry alarm commit together.
  var armed: bool
  var preparedOnce: bool
  var admissions: int
  // Last outcome, not an unbounded diagnostic counter: this model is finite.
  var lastRefused: bool
  action init = all { phase' = "absent", live' = true, preparedOnce' = false,
    admissions' = 0, lastRefused' = false, armed' = false, credential' = "checking" }
  action check(result: str): bool = all {
    Set("checking", "retrying").contains(credential),
    credential' = if (result == "allowed") "allowed"
      else if (result == "timeout" and credential == "checking") "retrying"
      else "refused",
    phase' = phase, live' = live, admissions' = admissions,
    armed' = armed, preparedOnce' = preparedOnce, lastRefused' = lastRefused
  }
  action authorize = check("allowed")
  action prepare = all { phase == "absent", live, credential == "allowed",
    phase' = "prepared", live' = live, preparedOnce' = true,
    admissions' = admissions, lastRefused' = lastRefused, armed' = true, credential' = credential }
  action expire = all { live, live' = false, phase' = phase, preparedOnce' = preparedOnce,
    admissions' = admissions, lastRefused' = lastRefused, armed' = false, credential' = credential }
  action retire = all { phase != "retired", phase' = "retired", live' = live,
    preparedOnce' = preparedOnce, admissions' = admissions, lastRefused' = lastRefused, armed' = false, credential' = credential }
  action mint(ownerMatches: bool, organizationMatches: bool, nonceMatches: bool): bool = {
    val accepted = phase == "prepared" and live and ownerMatches and organizationMatches and nonceMatches
    all { phase' = if (accepted) "minted" else phase,
      admissions' = if (accepted) admissions + 1 else admissions,
      lastRefused' = not(accepted), preparedOnce' = preparedOnce, live' = live, armed' = armed, credential' = credential }
  }
  // New prepared nonces have no Redis entry, so the legacy route cannot mint them.
  action legacyAttempt = all { lastRefused' = true, admissions' = admissions,
    phase' = phase, preparedOnce' = preparedOnce, live' = live, armed' = armed, credential' = credential }
  // Durable restart preserves the original record and deadline, never fresh consent.
  action restart = all { phase' = phase, live' = live, preparedOnce' = preparedOnce,
    admissions' = admissions, lastRefused' = lastRefused, armed' = armed, credential' = credential }
  // A failed atomic bootstrap publishes neither the row nor its alarm.
  action failedPrepare = all { phase == "absent", phase' = phase, live' = live,
    preparedOnce' = preparedOnce, admissions' = admissions, lastRefused' = lastRefused, armed' = armed, credential' = credential }
  action step = any { prepare, failedPrepare, expire, retire, legacyAttempt, restart,
    { nondet result = Set("allowed", "denied", "timeout", "canceled").oneOf(); check(result) },
    { nondet ownerMatches = Bool.oneOf(); nondet organizationMatches = Bool.oneOf();
      nondet nonceMatches = Bool.oneOf(); mint(ownerMatches, organizationMatches, nonceMatches) } }
  val SingleUse = admissions >= 0 and admissions <= 1
  val ValidPhase = Set("absent", "prepared", "minted", "retired").contains(phase)
  val NoAdmissionWithoutPrepare = admissions > 0 implies preparedOnce
  val ArmedBeforeMint = phase == "prepared" and live implies armed
  val NoPrepareWithoutAuthorization = Set("prepared", "minted").contains(phase) implies credential == "allowed"
  val safety = NoPrepareWithoutAuthorization and SingleUse and ValidPhase and NoAdmissionWithoutPrepare and ArmedBeforeMint
  run failedPreparationLeavesNothing = init.then(failedPrepare).expect(phase == "absent" and not(armed) and safety)
  run replayAfterRestart = init.then(authorize).then(prepare).then(mint(true, true, true)).then(restart).then(mint(true, true, true)).expect(admissions == 1 and lastRefused and safety)
  run wrongOwner = init.then(authorize).then(prepare).then(mint(false, true, true)).expect(admissions == 0 and lastRefused and safety)
  run wrongOrganization = init.then(authorize).then(prepare).then(mint(true, false, true)).expect(admissions == 0 and lastRefused and safety)
  run wrongNonce = init.then(authorize).then(prepare).then(mint(true, true, false)).expect(admissions == 0 and lastRefused and safety)
  run expiredConsent = init.then(authorize).then(prepare).then(expire).then(mint(true, true, true)).expect(admissions == 0 and lastRefused and safety)
  run retiredConsent = init.then(authorize).then(prepare).then(retire).then(mint(true, true, true)).expect(admissions == 0 and lastRefused and safety)
  run missingPreparation = init.then(mint(true, true, true)).expect(admissions == 0 and lastRefused and safety)
  run crossRouteReplay = init.then(authorize).then(prepare).then(mint(true, true, true)).then(legacyAttempt).expect(admissions == 1 and lastRefused and safety)
  run originalPreparedConsentSurvivesRestart = init.then(authorize).then(prepare).then(restart).then(mint(true, true, true)).expect(admissions == 1 and safety)
  run restartDoesNotRenewExpiry = init.then(authorize).then(prepare).then(restart).then(expire).then(mint(true, true, true)).expect(admissions == 0 and lastRefused and safety)
  run coldCredentialRechecked = init.then(check("timeout")).then(authorize).then(prepare).expect(phase == "prepared" and safety)
  run deniedAfterTimeout = init.then(check("timeout")).then(check("denied")).expect(credential == "refused" and phase == "absent" and safety)
  run repeatedTimeoutFailsClosed = init.then(check("timeout")).then(check("timeout")).expect(credential == "refused" and phase == "absent" and safety)
  run stopAfterTimeout = init.then(check("timeout")).then(check("canceled")).expect(credential == "refused" and phase == "absent" and safety)
}
