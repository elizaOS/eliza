// Two original immutable object keys, one v2 APP_DELETE root and two lease generations.
// App metadata removal is distinct from durable, per-object cleanup completion.
module app_cleanup_manifest {
  type State = { app: bool, fenced: bool, plan: bool, job: bool, org: bool,
    objects: Set[int], cursor: int, io: int, generation: int, ioGeneration: int,
    completed: bool, staleAck: bool }
  var s: State
  action init = s' = { app: true, fenced: false, plan: false, job: true, org: true,
    objects: Set(0, 1), cursor: 0, io: -1, generation: 0, ioGeneration: 0,
    completed: false, staleAck: false }
  action admit = all { s.app, not(s.fenced), s' = { ...s, fenced: true } }
  // SQL stores the complete immutable plan and appDeleted together with the cascade.
  action finalize = all { s.app, s.fenced,
    s' = { ...s, app: false, plan: true } }
  // A lost SQL reply changes no durable authority: replay reads the same root.
  action replay = all { s.job, s' = s }
  action begin = all { not(s.app), s.plan, s.job, s.cursor < 2, s.io == -1,
    s' = { ...s, io: s.cursor, ioGeneration: s.generation } }
  // Provider success can precede a lost acknowledgement; repeated exact-key delete is idempotent.
  action providerSuccess = all { s.io >= 0,
    s' = { ...s, objects: s.objects.exclude(Set(s.io)) } }
  action loseReply = all { s.io >= 0, s' = { ...s, io: -1 } }
  action acknowledge = all { s.io == s.cursor, s.io >= 0,
    not(s.objects.contains(s.io)), s.ioGeneration == s.generation,
    s' = { ...s, cursor: s.cursor + 1, io: -1 } }
  action takeover = all { s.generation == 0, not(s.completed),
    s' = { ...s, generation: 1 } }
  action complete = all { s.cursor == 2, s.job,
    s' = { ...s, completed: true } }
  action removeOrg = all { s.completed, s' = { ...s, org: false, job: false, plan: false } }
  action step = any { admit, finalize, replay, begin, providerSuccess, loseReply,
    acknowledge, takeover, complete, removeOrg, s' = s }
  val safety = all {
    not(s.app) and not(s.completed) implies s.job and s.org and s.plan,
    s.objects != Set(0, 1) implies not(s.app),
    s.cursor > 0 implies not(s.objects.contains(0)),
    s.cursor == 2 implies s.objects == Set(),
    s.completed implies s.cursor == 2,
    not(s.staleAck),
  }
  run lostCascadeReplyRecoveryTest = init.then(admit).then(finalize).then(replay)
    .then(begin).then(providerSuccess).then(acknowledge).then(begin)
    .then(providerSuccess).then(acknowledge).then(complete).then(removeOrg)
    .expect(safety and not(s.job) and s.objects == Set())
  run unknownProviderReplyRetriesExactKeyTest = init.then(admit).then(finalize)
    .then(begin).then(providerSuccess).then(loseReply).then(begin)
    .then(providerSuccess).then(acknowledge).expect(safety and s.cursor == 1)
  run partialCleanupRetainsPlanTest = init.then(admit).then(finalize)
    .then(begin).then(providerSuccess).then(acknowledge).then(replay)
    .expect(safety and s.plan and s.objects == Set(1))
  run staleInFlightSuccessRemainsRecoverableTest = init.then(admit).then(finalize)
    .then(begin).then(takeover).then(providerSuccess).then(loseReply)
    .then(begin).then(providerSuccess).then(acknowledge).expect(safety and s.cursor == 1)
  // Excluded bad implementations establish sensitivity to the original lost-plan bug.
  action unsafeRemoveJobAfterMetadata = all { not(s.app),
    s' = { ...s, job: false, org: false, plan: false } }
  run originalCascadeLosesCleanupWitnessTest = init.then(admit).then(finalize)
    .then(unsafeRemoveJobAfterMetadata).expect(not(safety) and s.objects == Set(0, 1))
  action unsafeAcknowledgeBeforeEffect = all { s.io >= 0,
    s' = { ...s, cursor: s.cursor + 1, io: -1 } }
  run acknowledgementWithoutEffectWitnessTest = init.then(admit).then(finalize)
    .then(begin).then(unsafeAcknowledgeBeforeEffect).expect(not(safety))
  action unsafeStaleAck = all { s.io >= 0, s.ioGeneration != s.generation,
    s' = { ...s, cursor: s.cursor + 1, io: -1, staleAck: true } }
  run staleReceiptWitnessTest = init.then(admit).then(finalize).then(begin)
    .then(takeover).then(providerSuccess).then(unsafeStaleAck).expect(not(safety))
}

// The deployment row owns the full upload plan before PUT. Unknown in-flight
// writes are not quiescent merely because the caller failed or time passed.
module app_cleanup_uploads {
  type State = { app: bool, deleting: bool, phase: str, plan: bool,
    permit: bool, inFlight: bool, quiesced: bool, objects: Set[int], cleaned: bool }
  var s: State
  action init = s' = { app:true, deleting:false, phase:"pending", plan:true,
    permit:false, inFlight:false, quiesced:false, objects:Set(), cleaned:false }
  action begin = all { s.app, not(s.deleting), s.phase == "pending",
    s' = {...s, phase:"uploading"} }
  action admitPut = all { s.app, not(s.deleting), s.phase == "uploading", not(s.inFlight), not(s.quiesced),
    s' = {...s, permit:true} }
  action sendPut = all { s.permit, s' = {...s, permit:false, inFlight:true} }
  action remoteEffect = all { s.inFlight, s' = {...s, objects:s.objects.union(Set(0))} }
  action acknowledge = all { s.inFlight, s.objects.contains(0), s' = {...s, inFlight:false} }
  action unknown = all { s.inFlight, s' = {...s, phase:"failed"} }
  action fence = all { s.app, s' = {...s, deleting:true} }
  action quiesce = all { not(s.permit), not(s.inFlight), s.phase == "uploading",
    s' = {...s, quiesced:true, phase:"ready"} }
  action cascade = all { s.deleting, s.plan, (s.phase == "pending" or s.quiesced),
    s' = {...s, app:false} }
  action cleanup = all { not(s.app), not(s.inFlight), not(s.permit), s.plan,
    s' = {...s, objects:Set(), cleaned:true} }
  action step = any {begin,admitPut,sendPut,remoteEffect,acknowledge,unknown,fence,quiesce,cascade,cleanup,s'=s}
  val safety = all {
    s.cleaned implies s.objects == Set(),
    not(s.app) implies (not(s.inFlight) and not(s.permit)),
    s.inFlight implies s.plan,
    s.phase == "failed" implies not(s.cleaned),
  }
  run pendingDraftRetiresTest = init.then(fence).then(cascade).then(cleanup).expect(safety and s.cleaned)
  run pausedPutRequiresQuiescenceTest = init.then(begin).then(admitPut).then(sendPut).then(fence)
    .then(remoteEffect).then(acknowledge).then(quiesce).then(cascade).then(cleanup).expect(safety and s.cleaned)
  run unknownPutRetainsAuthorityTest = init.then(begin).then(admitPut).then(sendPut)
    .then(unknown).then(fence).then(remoteEffect).expect(safety and s.app and not(s.cleaned))
  action unsafeCascade = all {s.deleting,s'={...s,app:false,objects:Set(),cleaned:true}}
  run latePutAfterOldCascadeWitnessTest = init.then(begin).then(admitPut).then(sendPut).then(fence)
    .then(unsafeCascade).then(remoteEffect).expect(not(safety) and s.cleaned and s.objects != Set())
  action unsafeResetPending = all {s.inFlight, s'={...s,phase:"pending"}}
  run resetStartedAsUnstartedWitnessTest = init.then(begin).then(admitPut).then(sendPut).then(fence)
    .then(unsafeResetPending).then(cascade).expect(not(safety))

}

// One projected row; bulk operations apply the same local deleting set to each row.
module app_cleanup_ui {
  type State = { deleting: bool, receipt: bool, row: bool, label: str, actions: bool, toast: bool, authorized: bool, resync: bool, navigated: bool, observing: bool, job: int, cleanup: bool }
  var s: State
  action init = s'={deleting:false,receipt:false,row:true,label:"Active",actions:true,toast:false,authorized:true,resync:false,navigated:false,observing:false,job:-1,cleanup:false}
  action begin = all {s.row,not(s.deleting),s'={...s,deleting:true,label:"Deleting",actions:false,observing:true,job:0}}
  action pollPending = all {s.deleting,not(s.receipt),s'=s}
  action receiveReceipt = all {s.deleting,s.authorized,s.observing,s'={...s,receipt:true,cleanup:true}}
  action metadataOnly = all {s.deleting,s.authorized,s.observing,s'={...s,receipt:true}}
  action loseObservation = all {s.deleting,s.observing,s'={...s,observing:false}}
  action resume = all {s.deleting,s.authorized,not(s.observing),s'={...s,observing:true}}
  action publishComplete = all {s.receipt,s.cleanup,s.authorized,s'={...s,deleting:false,row:false,toast:true,resync:true,navigated:true,observing:false}}
  action refreshMissing = all {s.deleting,s'=s}
  action authoritySwitch = s'={...s,authorized:false,deleting:false,row:false,actions:false,toast:false,resync:false,navigated:false,observing:false}
  action delayedRefresh = all {s.resync,s.authorized,s'={...s,resync:false}}
  action step = any {begin,pollPending,refreshMissing,authoritySwitch,receiveReceipt,publishComplete,delayedRefresh,metadataOnly,loseObservation,resume,s'=s}
  val safety = all {
    s.deleting implies (s.row and s.label == "Deleting" and not(s.actions)),
    (not(s.row) and s.authorized) implies (s.receipt and s.cleanup),
    s.toast implies (s.receipt and s.cleanup and s.authorized),
    s.deleting implies s.job == 0,
    s.resync implies s.authorized,
    s.navigated implies (s.receipt and s.cleanup and s.authorized),
  }
  run pendingRowThenReceiptTest = init.then(begin).then(pollPending).then(refreshMissing).then(receiveReceipt).then(publishComplete).expect(safety and s.toast and not(s.row))
  run authoritySwitchRetiresOldUiTest = init.then(begin).then(authoritySwitch).expect(safety and not(s.toast))
  run lostObservationResumesOriginalTest = init.then(begin).then(metadataOnly).then(loseObservation).then(resume).then(receiveReceipt).then(publishComplete).expect(safety and s.job == 0 and s.toast)
  action unsafeRepeatDelete = all {s.deleting,not(s.observing),s'={...s,job:1,observing:true}}
  run observationFailureCannotCreateAnotherJobWitnessTest = init.then(begin).then(loseObservation).then(unsafeRepeatDelete).expect(not(safety))
  action unsafeIgnoreCleanup = all {s.receipt,s'={...s,deleting:false,row:false,toast:true,navigated:true}}
  run metadataOnlyCompletionWitnessTest = init.then(begin).then(metadataOnly).then(unsafeIgnoreCleanup).expect(not(safety))
  action unsafeLateToast = s'={...s,receipt:true,toast:true}
  run retiredAuthorityToastWitnessTest = init.then(begin).then(authoritySwitch).then(unsafeLateToast).expect(not(safety))
  action unsafeLateNavigation = s'={...s,receipt:true,navigated:true}
  run retiredDetailNavigationWitnessTest = init.then(begin).then(authoritySwitch).then(unsafeLateNavigation).expect(not(safety))
  run completedOwnerRetiresTimerTest = init.then(begin).then(receiveReceipt).then(publishComplete).then(authoritySwitch).expect(safety and not(s.resync))
  action unsafeStaleTimer = s'={...s,resync:true}
  run staleRefreshWitnessTest = init.then(begin).then(receiveReceipt).then(publishComplete).then(authoritySwitch).then(unsafeStaleTimer).expect(not(safety))
  action unsafeActiveBadge = all {s.deleting,s'={...s,label:"Active"}}
  run oldActiveBadgeWitnessTest = init.then(begin).then(unsafeActiveBadge).expect(not(safety))
  action unsafeEarlyRemoval = all {s.deleting,s'={...s,row:false,deleting:false,toast:true}}
  run earlyRemovalWitnessTest = init.then(begin).then(unsafeEarlyRemoval).expect(not(safety))
}

// Two local batches compete for one UI admission slot. Closing a dialog is not
// permission for another batch to overwrite the first batch's pending rows.
module app_cleanup_batches {
  type State = { owner: int, running: Set[int], pending: Set[int], finished: Set[int] }
  var s: State
  action init = s'={owner:-1,running:Set(),pending:Set(),finished:Set()}
  action admit(id) = all {s.owner == -1,not(s.finished.contains(id)),
    s'={...s,owner:id,running:Set(id),pending:Set(id)}}
  action finish(id) = all {s.owner == id,s.running.contains(id),
    s'={...s,owner:-1,running:Set(),pending:Set(),finished:s.finished.union(Set(id))}}
  action step = {nondet id=Set(0,1).oneOf() any {admit(id),finish(id),s'=s}}
  val safety = all {s.running == s.pending,s.running.size() <= 1,
    s.owner == -1 implies s.running == Set()}
  run serialBatchOwnershipTest = init.then(admit(0)).then(finish(0)).then(admit(1)).then(finish(1))
    .expect(safety and s.finished == Set(0,1))
  action oldOverlappingAdmission = s'={...s,owner:1,running:s.running.union(Set(1)),pending:Set(1)}
  run replacedPendingOwnerWitnessTest = init.then(admit(0)).then(oldOverlappingAdmission).expect(not(safety))
}
