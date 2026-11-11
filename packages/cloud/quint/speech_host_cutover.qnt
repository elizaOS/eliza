// Sources: speech-host-cutover-admission.mjs, cloud-cf-release.yml,
// voice/speech/route.ts, speech-relay-coordinator.ts and both wrangler configs.
// Two namespaces; one old session plus one already-admitted preparation.
// The machine checks live freeze, expiry and exact identities. It CANNOT
// measure drain. step assumes the protected operator truthfully attests all
// admitted requests/sessions drained and holds admission off until the switch.
// dishonestAttest/unsafeThaw are excluded witnesses of that trust boundary.
// No provider, network propagation, cryptography, SQL or fleet liveness proof.
module speech_host_cutover {
  type State = { host: str, targetReady: bool, oldPhase: str, oldPending: bool,
    providerClosed: bool, settled: bool, receipt: bool, oldNamespace: bool,
    frozen: bool, attestation: str, preflight: bool, identityMatches: bool,
    newActive: bool, missedRevoke: bool }
  var s: State
  action init = s' = { host: "api", targetReady: false, oldPhase: "empty",
    oldPending: false, providerClosed: false, settled: false, receipt: false,
    oldNamespace: true, frozen: false, attestation: "none", preflight: false,
    identityMatches: true, newActive: false, missedRevoke: false }
  val drained = not(s.oldPending) and (s.oldPhase == "empty" or
    (s.oldPhase == "closed" and s.receipt))
  // A route accepted before the flag changes may finish afterward.
  action acceptOld = all { s.host == "api", not(s.frozen), s.oldPhase == "empty",
    not(s.oldPending), s' = s.with("oldPending", true) }
  action finishPreparation = all { s.oldPending,
    s' = s.with("oldPending", false).with("oldPhase", "prepared")
      .with("providerClosed", true).with("settled", true) }
  action startOld = all { s.host == "api", not(s.frozen), s.oldPhase == "prepared",
    s' = s.with("oldPhase", "active").with("providerClosed", false).with("settled", false) }
  action freezeAdmission = all { not(s.frozen), s' = s.with("frozen", true) }
  // Operator host-only provisioning creates the namespace without switching the API.
  action deployTarget = all { not(s.targetReady), s' = s.with("targetReady", true) }
  action beginRetirement = all { s.oldNamespace, Set("prepared", "active").contains(s.oldPhase),
    s' = s.with("oldPhase", "retiring") }
  action providerStops = all { s.oldPhase == "retiring", s' = s.with("providerClosed", true) }
  action accountingCommits = all { s.oldPhase == "retiring", s' = s.with("settled", true) }
  action confirmReceipt = all { s.oldPhase == "retiring", s.providerClosed, s.settled,
    s' = s.with("oldPhase", "closed").with("receipt", true) }
  // drained is HUMAN evidence, not a predicate computed by the script.
  action truthfulAttest = all { s.host == "api", s.frozen, drained,
    s' = s.with("attestation", "fresh") }
  action expireAttestation = all { s.attestation == "fresh",
    s' = s.with("attestation", "expired") }
  action identityDrifts = all { s.identityMatches, s' = s.with("identityMatches", false) }
  val canSwitch = s.host == "api" and s.targetReady and s.frozen and
    s.attestation == "fresh" and s.identityMatches
  action preflight = all { canSwitch, s' = s.with("preflight", true) }
  action switchBinding = all { canSwitch, s.preflight, s' = s.with("host", "speech") }
  // The source may retain the API host without provisioning or draining a new
  // namespace. Live metadata must still prove the namespace remains on the API.
  val canRetainApi = s.host == "api" and s.identityMatches
  action retainApiBinding = all { canRetainApi, s' = s }
  // Routine updates to the already-active target do not need a new attestation.
  action routineUpdate = all { s.host == "speech", s' = s }
  action startNew = all { s.host == "speech", not(s.newActive), s' = s.with("newActive", true) }
  action revokeOld = all { s.oldPhase == "active",
    s' = if (s.host == "api") s.with("oldPhase", "retiring") else s.with("missedRevoke", true) }
  action idle = s' = s
  action step = any { acceptOld, finishPreparation, startOld, freezeAdmission,
    deployTarget, beginRetirement, providerStops, accountingCommits, confirmReceipt,
    truthfulAttest, expireAttestation, identityDrifts, preflight, switchBinding,
    retainApiBinding, routineUpdate, startNew, revokeOld, idle }
  val receiptSafety = s.oldNamespace and (not(s.receipt) or
    (s.providerClosed and s.settled and s.oldPhase == "closed"))
  val safety = receiptSafety and not(s.missedRevoke) and (s.host == "api" or drained)
  action dishonestAttest = all { s.frozen, s' = s.with("attestation", "fresh") }
  action ungatedSwitch = all { s.targetReady, s' = s.with("host", "speech") }
  action unsafeThaw = s' = s.with("frozen", false)

  run absentTargetCannotActivateTest = init.then(freezeAdmission).then(truthfulAttest)
    .expect(not(canSwitch) and not(s.targetReady) and safety)
  run apiRetentionPreservesActiveSessionTest = init.then(acceptOld)
    .then(finishPreparation).then(startOld).then(retainApiBinding)
    .expect(s.host == "api" and not(s.targetReady) and not(s.frozen) and safety)
    .then(revokeOld).expect(s.oldPhase == "retiring" and safety)
  run apiRetentionCannotReverseCutoverTest = init.then(freezeAdmission).then(deployTarget)
    .then(truthfulAttest).then(preflight).then(switchBinding)
    .expect(not(canRetainApi) and safety)
  run apiRetentionRequiresStableIdentityTest = init.then(identityDrifts)
    .expect(not(canRetainApi) and safety)
  run drainedCutoverTest = init.then(acceptOld).then(finishPreparation).then(startOld)
    .then(freezeAdmission).then(beginRetirement).then(providerStops).then(accountingCommits)
    .then(confirmReceipt).then(deployTarget).then(truthfulAttest).then(preflight)
    .then(switchBinding).then(startNew).then(expireAttestation).then(routineUpdate).expect(safety)
  run pendingPreparationSurvivesFreezeTest = init.then(acceptOld).then(freezeAdmission)
    .expect(not(drained)).then(finishPreparation).then(beginRetirement).then(confirmReceipt)
    .then(deployTarget).then(truthfulAttest).then(preflight).then(switchBinding).expect(safety)
  run expiredAttestationCannotSwitchTest = init.then(freezeAdmission).then(deployTarget)
    .then(truthfulAttest).then(preflight).then(expireAttestation).expect(not(canSwitch) and safety)
  run namespaceDriftCannotSwitchTest = init.then(freezeAdmission).then(deployTarget)
    .then(truthfulAttest).then(preflight).then(identityDrifts).expect(not(canSwitch) and safety)
  run falseHumanClaimNegativeWitnessTest = init.then(acceptOld).then(finishPreparation)
    .then(startOld).then(freezeAdmission).then(deployTarget).then(dishonestAttest)
    .then(preflight).then(switchBinding).then(revokeOld).expect(not(safety) and s.missedRevoke)
  run thawViolatesHumanHoldNegativeWitnessTest = init.then(freezeAdmission).then(deployTarget)
    .then(truthfulAttest).then(preflight).then(unsafeThaw).then(acceptOld)
    .then(freezeAdmission).then(switchBinding).expect(not(safety))
  run priorUngatedSwitchNegativeWitnessTest = init.then(acceptOld).then(finishPreparation)
    .then(startOld).then(deployTarget).then(ungatedSwitch).then(revokeOld)
    .expect(receiptSafety and not(safety))
}
