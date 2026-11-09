// account-deletion-requests.ts reservePersonalAccountDeletion,
// activateReservedPersonalAccountDeletion, completeExportPhase,
// cancelDuringRecovery, finalizeCancellationIfComplete and
// activateExpiredPersonalAccountDeletion. One user/org/request identity.
module AccountDeletionRecovery {
  type State = {
    status: str, now: int, deadline: int, token: int, requestRevision: int,
    userRevision: int, organizationRevision: int, userActive: bool,
    organizationActive: bool, recoveryToken: bool, admissionToken: bool,
    authorityReceipt: bool, deactivationReceipt: bool, reactivationReceipt: bool,
    exportStatus: str, exportPhase: str, exportBeforeCall: bool,
    exportDelivered: bool, revokeReceipt: bool, revokePending: bool,
    irreversible: bool, eligible: bool, providerWork: bool,
    restoredWithReceipts: bool
  }
  var s: State
  action init = s' = {
    status: "none", now: 0, deadline: 2, token: 0, requestRevision: 0,
    userRevision: 0, organizationRevision: 0, userActive: true,
    organizationActive: true, recoveryToken: false, admissionToken: false,
    authorityReceipt: false, deactivationReceipt: false, reactivationReceipt: false,
    exportStatus: "none", exportPhase: "none", exportBeforeCall: false,
    exportDelivered: false, revokeReceipt: false, revokePending: false,
    irreversible: false, eligible: true, providerWork: false,
    restoredWithReceipts: false
  }
  action reserve = all {
    s.status == "none", s.eligible, s.userActive,
    s' = { ...s, status: "requested", token: 1, requestRevision: 1,
      recoveryToken: true, admissionToken: true, exportStatus: "pending", exportPhase: "pending" }
  }
  // A pre-fence replacement keeps the same request/revision/provider keys.
  action replacePackage = all {
    s.status == "requested", s.token < 2,
    s' = { ...s, token: s.token + 1, deadline: s.now + 2 }
  }
  action activate(credential: int): bool = all {
    s.status == "requested", s.recoveryToken, credential == s.token,
    s.now < s.deadline, s.eligible, not(s.providerWork),
    s' = { ...s, status: "reserved", userActive: false, organizationActive: false,
      userRevision: s.requestRevision, organizationRevision: s.requestRevision,
      authorityReceipt: true }
  }
  action startExport = all {
    Set("reserved", "recovery").contains(s.status), s.exportPhase == "pending",
    s' = { ...s, exportStatus: "building", exportPhase: "calling", exportBeforeCall: true }
  }
  action completeExport = all {
    s.exportBeforeCall, not(s.exportDelivered),
    if (Set("reserved", "recovery").contains(s.status) and s.exportStatus == "building" and s.exportPhase == "calling")
      s' = { ...s, status: "recovery", exportStatus: "ready", exportPhase: "completed", exportDelivered: true }
    else if (Set("expired", "deleted").contains(s.exportStatus))
      s' = { ...s, exportStatus: "expired", exportPhase: "canceled", exportDelivered: true,
        revokeReceipt: false, revokePending: true }
    else s' = s
  }
  action completeDeactivation = all {
    Set("reserved", "recovery").contains(s.status), not(s.deactivationReceipt),
    s' = { ...s, deactivationReceipt: true }
  }
  action cancel(credential: int): bool = all {
    Set("reserved", "recovery").contains(s.status), s.recoveryToken,
    credential == s.token, s.now < s.deadline,
    s' = { ...s, status: "canceling", admissionToken: false,
      exportStatus: "expired", exportPhase: if (s.exportPhase == "completed") "completed" else "canceled",
      reactivationReceipt: false, revokeReceipt: false, revokePending: true }
  }
  action completeReactivation = all {
    s.status == "canceling", not(s.reactivationReceipt),
    s' = { ...s, reactivationReceipt: true, deactivationReceipt: false }
  }
  action revokeExport = all {
    s.revokePending,
    s' = { ...s, exportStatus: "deleted", revokeReceipt: true, revokePending: false }
  }
  // A failed gate write rolls this transaction back. Credentials and user/org
  // DB authority change only with both durable cleanup receipts.
  action finishCancellation = all {
    s.status == "canceling", s.reactivationReceipt, s.revokeReceipt,
    s' = { ...s, status: "canceled", requestRevision: s.requestRevision + 1,
      userRevision: s.requestRevision + 1, organizationRevision: s.requestRevision + 1,
      userActive: true, organizationActive: true, recoveryToken: false,
      admissionToken: false, deactivationReceipt: false,
      restoredWithReceipts: s.reactivationReceipt and s.revokeReceipt }
  }
  action expireRecovery = all {
    Set("reserved", "recovery").contains(s.status), s.now >= s.deadline,
    s.eligible, not(s.providerWork), s.exportStatus == "ready", s.exportPhase == "completed",
    s.deactivationReceipt, s.userRevision == s.requestRevision, s.organizationRevision == s.requestRevision,
    s' = { ...s, status: "scheduled", irreversible: true,
      requestRevision: s.requestRevision + 1, userRevision: s.requestRevision + 1,
      organizationRevision: s.requestRevision + 1, recoveryToken: false, admissionToken: false,
      exportStatus: "expired", revokePending: true, revokeReceipt: false }
  }
  action tick = all { s.now < 4, s' = { ...s, now: s.now + 1 } }
  action changeEligibility = all { s.eligible, s' = { ...s, eligible: false } }
  action admitProviderWork = all { s.status == "requested", not(s.providerWork), s' = { ...s, providerWork: true } }
  action releaseProviderWork = all { s.providerWork, s' = { ...s, providerWork: false } }
  action step = any {
    reserve, replacePackage, startExport, completeExport, completeDeactivation,
    completeReactivation, revokeExport, finishCancellation, expireRecovery,
    tick, changeEligibility, admitProviderWork, releaseProviderWork,
    { nondet credential = Set(0, 1, 2).oneOf()
      any { activate(credential), cancel(credential) } }, s' = s
  }
  val FencesPublishedTogether = Set("reserved", "recovery", "canceling", "scheduled").contains(s.status)
    .implies(not(s.userActive) and not(s.organizationActive) and s.authorityReceipt)
  val RestoredOnlyAfterReceipts = (s.status == "canceled").implies(
    s.restoredWithReceipts and s.reactivationReceipt and s.userActive and s.organizationActive and not(s.recoveryToken) and not(s.admissionToken))
  val IrreversibleCannotRestore = s.irreversible.implies(
    s.status == "scheduled" and not(s.userActive) and not(s.organizationActive) and not(s.recoveryToken))
  val RevisionsAgree = Set("reserved", "recovery", "canceling", "scheduled", "canceled").contains(s.status)
    .implies(s.requestRevision == s.userRevision and s.requestRevision == s.organizationRevision)
  val ExportOnlyDuringRecovery = (s.exportStatus == "ready").implies(s.status == "recovery")
  val LateExportStaysFenced = (s.exportDelivered and Set("canceling", "canceled", "scheduled").contains(s.status))
    .implies(Set("expired", "deleted").contains(s.exportStatus))

  run cancellationRetainsBothCompletionReceiptsTest = init.then(reserve)
    .then(activate(1)).then(startExport).then(completeDeactivation).then(cancel(1))
    .then(completeReactivation).then(revokeExport).then(finishCancellation)
    .expect(RestoredOnlyAfterReceipts and s.restoredWithReceipts)

  // A late export requires fresh revocation without undoing the historical
  // evidence that both cleanup receipts existed when authority was restored.
  run lateExportPreservesRestorationEvidenceTest = init.then(reserve)
    .then(activate(1)).then(startExport).then(completeDeactivation).then(cancel(1))
    .then(completeReactivation).then(revokeExport).then(finishCancellation)
    .then(completeExport)
    .expect(RestoredOnlyAfterReceipts and s.restoredWithReceipts
      and not(s.revokeReceipt) and s.revokePending and LateExportStaysFenced)

  // Test-only mutation of the real transition: remove the revocation guard.
  // It must violate the historical receipt invariant; it is not in step.
  action legacyFinishWithoutRevocation = all {
    s.status == "canceling", s.reactivationReceipt,
    s' = { ...s, status: "canceled", requestRevision: s.requestRevision + 1,
      userRevision: s.requestRevision + 1, organizationRevision: s.requestRevision + 1,
      userActive: true, organizationActive: true, recoveryToken: false,
      admissionToken: false, deactivationReceipt: false,
      restoredWithReceipts: s.reactivationReceipt and s.revokeReceipt }
  }
  run missingRevocationGuardDetectedTest = init.then(reserve)
    .then(activate(1)).then(startExport).then(completeDeactivation).then(cancel(1))
    .then(completeReactivation).then(legacyFinishWithoutRevocation)
    .expect(not(RestoredOnlyAfterReceipts) and not(s.restoredWithReceipts))
}
