// One irreversible app deletion; one database and one container. Provider
// identity is fixed. Remote absence is distinct from a local completion receipt.
module app_teardown_authority {
  type State = { app: bool, active: bool, admitted: bool, revoked: bool, plan: bool,
    lease: bool, database: bool, container: bool, dbStarted: bool, containerStarted: bool,
    dbReceipt: bool, containerReceipt: bool, dbQuiescent: bool, containerQuiescent: bool,
    releases: int, capacity: int, finalizing: bool, rootReceipt: bool,
    complete: bool, objects: bool, cleanupPermit: bool, unsafeDispatch: bool }
  var s: State
  action init = s' = { app: true, active: true, admitted: false, revoked: false, plan: false,
    lease: true, database: true, container: true, dbStarted: false, containerStarted: false,
    dbReceipt: false, containerReceipt: false, dbQuiescent: false, containerQuiescent: false,
    releases: 0, capacity: 2, finalizing: false, rootReceipt: false,
    complete: false, objects: true, cleanupPermit: false, unsafeDispatch: false }
  action admit = all { not(s.admitted), s.app, s' = { ...s, admitted: true, active: false } }
  action acknowledgeRevocation = all { s.admitted, s' = { ...s, revoked: true } }
  action replay = all { s.admitted, s' = s }
  action reactivate = all { not(s.admitted), s.app, s' = { ...s, active: true } }
  action prepare = all { s.admitted, s.revoked, s.app, s.lease, not(s.plan), s' = { ...s, plan: true } }
  action loseLease = all { s.lease, s' = { ...s, lease: false } }
  action recoverLease = all { not(s.lease), s' = { ...s, lease: true } }
  action dispatchDatabase = all { s.plan, s.lease, not(s.dbReceipt), s' = { ...s, dbStarted: true } }
  // A successful DROP can happen even when its reply is lost. Repeating that
  // immutable target can confirm absence, but never itself releases capacity.
  action databaseAbsent = all { s.dbStarted, s' = { ...s, database: false } }
  action confirmDatabase = all { s.lease, s.dbStarted, not(s.database), not(s.dbReceipt),
    s' = { ...s, dbReceipt: true, capacity: s.capacity - 1, releases: s.releases + 1 } }
  action quiesceDatabase = all { s.dbReceipt, s' = { ...s, dbQuiescent: true } }
  action dispatchContainer = all { s.plan, s.lease, not(s.containerReceipt),
    s' = { ...s, containerStarted: true } }
  action containerAbsent = all { s.containerStarted, s' = { ...s, container: false } }
  action confirmContainer = all { s.lease, s.containerStarted, not(s.container), not(s.containerReceipt),
    s' = { ...s, containerReceipt: true } }
  action quiesceContainer = all { s.containerReceipt, s' = { ...s, containerQuiescent: true } }
  val ready = s.plan and s.dbReceipt and s.containerReceipt and s.dbQuiescent and s.containerQuiescent
  action beginFinalize = all { s.app, s.lease, ready, not(s.finalizing), s' = { ...s, finalizing: true } }
  // 0 rolls back, 1 acknowledges commit, 2 loses the reply after commit.
  action finishFinalize(mode) = all { s.finalizing, mode == 0 or s.lease, s' = { ...s, finalizing: false,
    app: if (mode == 0) s.app else false,
    rootReceipt: s.rootReceipt or mode != 0,
    cleanupPermit: s.cleanupPermit or mode == 1 } }
  action finish = { nondet mode = 0.to(2).oneOf() finishFinalize(mode) }
  action settle = all { s.lease, s.rootReceipt, s' = { ...s, complete: true } }
  action cleanup = all { s.cleanupPermit, s' = { ...s, objects: false } }
  action step = any { admit, acknowledgeRevocation, replay, reactivate, prepare, loseLease, recoverLease,
    dispatchDatabase, databaseAbsent, confirmDatabase, quiesceDatabase,
    dispatchContainer, containerAbsent, confirmContainer, quiesceContainer,
    beginFinalize, finish, settle, cleanup, s' = s }
  val safety = all {
    s.admitted implies not(s.active),
    (s.dbStarted or s.containerStarted) implies s.revoked,
    not(s.app) implies (s.rootReceipt and ready and not(s.database) and not(s.container)),
    s.complete implies s.rootReceipt,
    s.dbReceipt implies not(s.database),
    s.containerReceipt implies not(s.container),
    s.releases <= 1 and s.capacity == 2 - s.releases,
    not(s.objects) implies (s.cleanupPermit and not(s.app)),
    not(s.unsafeDispatch),
  }
  temporal FinalWriteSettles = finish.weakFair(s) implies
    always(s.finalizing implies eventually(not(s.finalizing)))
  run completeTest = init.then(admit).then(acknowledgeRevocation).then(prepare).then(dispatchDatabase)
    .then(databaseAbsent).then(confirmDatabase).then(quiesceDatabase)
    .then(dispatchContainer).then(containerAbsent).then(confirmContainer).then(quiesceContainer)
    .then(beginFinalize).then(finishFinalize(1)).then(settle).then(cleanup)
    .expect(safety and s.complete and not(s.objects))
  run acknowledgedReplayTest = init.then(admit).then(acknowledgeRevocation)
    .then(replay).then(replay).expect(safety and s.revoked)
  run responseLossRecoveryTest = init.then(admit).then(acknowledgeRevocation).then(prepare).then(dispatchDatabase)
    .then(databaseAbsent).then(dispatchDatabase).then(confirmDatabase)
    .expect(safety and s.capacity == 1 and s.releases == 1)
  run receiptWaitTest = init.then(admit).then(acknowledgeRevocation).then(prepare).then(dispatchDatabase).then(databaseAbsent)
    .expect(safety and s.app and not(s.dbReceipt) and s.capacity == 2)
  run staleLeaseBlocksDispatchTest = init.then(admit).then(acknowledgeRevocation).then(prepare).then(loseLease)
    .expect(safety and not(s.dbStarted) and not(s.containerStarted))
  run lostFinalReplyTest = init.then(admit).then(acknowledgeRevocation).then(prepare).then(dispatchDatabase).then(databaseAbsent)
    .then(confirmDatabase).then(quiesceDatabase).then(dispatchContainer).then(containerAbsent)
    .then(confirmContainer).then(quiesceContainer).then(beginFinalize).then(finishFinalize(2))
    .then(settle).expect(safety and s.complete and s.objects and not(s.cleanupPermit))
  action unsafeUnacknowledgedPlan = s' = { ...s, plan: true }
  run revocationDeliveryRequiredWitnessTest = init.then(admit).then(unsafeUnacknowledgedPlan).then(dispatchDatabase).expect(not(safety))
  action unsafeReactivate = s' = { ...s, active: true }
  action unsafeCascade = s' = { ...s, app: false }
  action unsafeSecondRelease = s' = { ...s, releases: s.releases + 1, capacity: s.capacity - 1 }
  action unsafeStaleDispatch = s' = { ...s, dbStarted: true, unsafeDispatch: not(s.lease) }
  run reversibleFenceWitnessTest = init.then(admit).then(unsafeReactivate).expect(not(safety))
  run dispatchIsNotCompletionWitnessTest = init.then(admit).then(acknowledgeRevocation).then(prepare)
    .then(dispatchDatabase).then(unsafeCascade).expect(not(safety))
  run existenceCheckDoubleReleaseWitnessTest = init.then(admit).then(acknowledgeRevocation).then(prepare)
    .then(dispatchDatabase).then(databaseAbsent).then(confirmDatabase).then(unsafeSecondRelease)
    .expect(not(safety) and s.releases == 2)
  run expiredLeaseWitnessTest = init.then(admit).then(acknowledgeRevocation).then(prepare).then(loseLease)
    .then(unsafeStaleDispatch).expect(not(safety))
}

// Two credentials in distinct organizations. The app lock closes issuance;
// a new key that won first forces a complete pre-commit lock-plan retry.
module app_teardown_admission {
  type State = { keys: Set[int], planned: Set[int], revoked: Set[int], admitted: bool, active: bool, permits: int }
  var s: State
  action init = s' = { keys: Set(0), planned: Set(), revoked: Set(), admitted: false, active: true, permits: 0 }
  action plan = all { not(s.admitted), s' = { ...s, planned: s.keys } }
  action issue = all { not(s.admitted), s' = { ...s, keys: s.keys.union(Set(1)) } }
  action admit = all { not(s.admitted), s.keys.subseteq(s.planned),
    s' = { ...s, revoked: s.keys, admitted: true, active: false, permits: 1 } }
  action replay = all { s.admitted, s' = s }
  action step = any { plan, issue, admit, replay, s' = s }
  val safety = all { s.admitted implies (s.keys.subseteq(s.revoked) and not(s.active)), s.permits <= 1 }
  run lateCredentialReplanTest = init.then(plan).then(issue).then(plan).then(admit)
    .then(replay).expect(safety and s.revoked == Set(0,1) and s.permits == 1)
  run admissionStopsLaterIssueTest = init.then(plan).then(admit).then(replay).expect(safety)
  action unsafeAdmitStalePlan = s' = { ...s, revoked: s.planned, admitted: true, active: false, permits: 1 }
  run omittedOrganizationWitnessTest = init.then(plan).then(issue)
    .then(unsafeAdmitStalePlan).expect(not(safety))
}

// GitHub owner/name DELETE has no atomic immutable-id precondition. This model
// assumes no external rename/reuse across its final identity read and dispatch.
// Unknown outcomes retain the one-shot receipt; neither 404 nor retry implies success.
module app_teardown_repository {
  type State = { pinned: bool, dispatched: bool, providerPresent: bool, receipt: bool, calls: int, ready: bool }
  var s: State
  action init = s' = { pinned: false, dispatched: false, providerPresent: true, receipt: false, calls: 0, ready: false }
  action pin = s' = { ...s, pinned: true }
  action reserve = all { s.pinned, not(s.dispatched), s' = { ...s, dispatched: true } }
  action send = all { s.dispatched, s.calls == 0, s' = { ...s, calls: s.calls + 1 } }
  action effect = all { s.calls == 1, s' = { ...s, providerPresent: false } }
  action acknowledge = all { s.calls == 1, not(s.providerPresent), s' = { ...s, receipt: true } }
  action complete = all { s.receipt, s' = { ...s, ready: true } }
  action step = any { pin, reserve, send, effect, acknowledge, complete, s' = s }
  val safety = all { s.calls <= 1, s.ready implies s.receipt, s.receipt implies not(s.providerPresent) }
  run acknowledgedDeleteTest = init.then(pin).then(reserve).then(send).then(effect).then(acknowledge).then(complete).expect(safety and s.ready)
  run unknownDeleteRemainsPendingTest = init.then(pin).then(reserve).then(send).then(effect).expect(safety and not(s.receipt) and not(s.ready))
  action unsafeRepeat = s' = { ...s, calls: s.calls + 1 }
  action unsafeInferAbsent = s' = { ...s, ready: true }
  run unknownRepeatWitnessTest = init.then(pin).then(reserve).then(send).then(unsafeRepeat).expect(not(safety))
  run absenceIsNotReceiptWitnessTest = init.then(pin).then(reserve).then(send).then(effect).then(unsafeInferAbsent).expect(not(safety))
}

// One fully restored competing job. Its exact revision must still match when
// finalization holds the app lock; missing or changed payload is unavailable.
module app_teardown_quiescence {
  type State = { revision: int, own: bool, observed: int, observedOwn: bool, full: bool, deleted: bool }
  var s: State
  action init = s' = { revision: 0, own: false, observed: -1, observedOwn: true, full: false, deleted: false }
  action restore = s' = { ...s, observed: s.revision, observedOwn: s.own, full: true }
  action changeTarget = all { s.revision == 0, not(s.deleted), s' = { ...s, revision: 1, own: true } }
  action finalize = all { s.full, s.observed == s.revision, not(s.observedOwn), s' = { ...s, deleted: true } }
  action step = any { restore, changeTarget, finalize, s' = s }
  val safety = s.deleted implies not(s.own)
  run otherAppProgressTest = init.then(restore).then(finalize).expect(safety and s.deleted)
  run changedTargetBlocksTest = init.then(restore).then(changeTarget).then(restore).expect(safety and not(s.deleted))
  action unsafeFinalizeStale = all { s.full, not(s.observedOwn), s' = { ...s, deleted: true } }
  run staleTargetWitnessTest = init.then(restore).then(changeTarget).then(unsafeFinalizeStale).expect(not(safety))
}
