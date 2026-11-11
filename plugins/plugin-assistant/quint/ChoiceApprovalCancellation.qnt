// CHOOSE_OPTION ABORT -> ApprovalService.cancelPendingApproval -> deleteTask.
// Authorization and choice validation precede this projection. A live pending
// owner retains its callback and original deadline if deletion fails. Claimed
// and missing owners are refused before any task or callback effect.
module ChoiceApprovalCancellation {
  const InitialOwner: str
  val owned = InitialOwner == "pending"
  val cancellable = owned or InitialOwner == "absent"
  val initialDeadline = if (owned) "active" else "absent"
  type State = { phase: str, caller: str, deadline: str }
  var s: State
  val taskPresent = Set("ready", "delete", "retained", "refused").contains(s.phase)
  val acknowledged = s.phase == "done"
  val inFlight = Set("delete", "confirm").contains(s.phase)
  val terminal = Set("retained", "refused", "done", "deliveryFailed").contains(s.phase)

  action init = s' = { phase: "ready", caller: InitialOwner, deadline: initialDeadline }
  action Abort = all {
    Set("ready", "retained").contains(s.phase),
    s' = if (cancellable) { ...s, phase: "delete", deadline: if (owned) "paused" else "absent" }
      else { ...s, phase: "refused" }
  }
  action DeleteDone = all {
    s.phase == "delete",
    s' = { phase: "confirm", caller: if (owned) "cancelled" else s.caller,
      deadline: if (owned) "cleared" else "absent" }
  }
  action DeleteFailed = all {
    s.phase == "delete", s' = { ...s, phase: "retained", deadline: initialDeadline }
  }
  action Confirm = all { s.phase == "confirm", s' = { ...s, phase: "done" } }
  action ConfirmationFailed = all { s.phase == "confirm", s' = { ...s, phase: "deliveryFailed" } }
  action step = any { Abort, DeleteDone, DeleteFailed, Confirm, ConfirmationFailed, s' = s }

  val TypeOK = Set("ready", "delete", "retained", "refused", "confirm", "done", "deliveryFailed").contains(s.phase) and
    Set("pending", "cancelled", "claimed", "unknown", "absent").contains(s.caller) and
    Set("active", "paused", "cleared", "absent").contains(s.deadline)
  val OwnerSettlesAfterDeletion = (s.caller == "cancelled") implies not(taskPresent)
  val FailedDeleteRetainsOwner = (owned and taskPresent) implies s.caller == "pending"
  val DeadlineRetained = owned implies (s.deadline ==
    if (s.phase == "delete") "paused" else if (taskPresent) "active" else "cleared")
  val AckRequiresDeletion = acknowledged implies not(taskPresent)
  val AckSettlesOwner = (owned and acknowledged) implies s.caller == "cancelled"
  val GenericHasNoApprovalCaller = (InitialOwner == "absent") implies s.caller == "absent"
  val RefusedHasNoEffects = not(cancellable) implies
    (taskPresent and not(acknowledged) and s.caller == InitialOwner and s.deadline == initialDeadline)

  temporal CancellationStays = always((s.caller == "cancelled" implies next(s.caller) == "cancelled").orKeep(s))
  temporal DeletedStaysDeleted = always((not(taskPresent) implies not(Set("ready", "delete", "retained", "refused").contains(next(s.phase)))).orKeep(s))
  temporal CompletionFairness = and {
    any { DeleteDone, DeleteFailed }.weakFair(s),
    any { Confirm, ConfirmationFailed }.weakFair(s)
  }
  temporal FairAttemptSettles = CompletionFairness implies always(inFlight implies eventually(terminal))
  temporal UnfairAttemptSettles = always(inFlight implies eventually(terminal))
}
module ChoiceApprovalCancellation_owned {
  import ChoiceApprovalCancellation(InitialOwner = "pending").*
  run ownerSettlesAfterDeletionTest = init.then(Abort)
    .expect(s.caller == "pending" and s.deadline == "paused")
    .then(DeleteDone).then(Confirm).expect(acknowledged and not(taskPresent))
  run failedDeleteCanBeRetriedTest = init.then(Abort).then(DeleteFailed)
    .expect(taskPresent and s.caller == "pending" and s.deadline == "active" and not(acknowledged))
    .then(Abort).then(DeleteDone).then(Confirm).expect(acknowledged)
}
module ChoiceApprovalCancellation_generic {
  import ChoiceApprovalCancellation(InitialOwner = "absent").*
  run genericChoiceStillCancelsTest = init.then(Abort).then(DeleteDone).then(Confirm)
    .expect(acknowledged and s.caller == "absent")
}
module ChoiceApprovalCancellation_claimed {
  import ChoiceApprovalCancellation(InitialOwner = "claimed").*
  run claimedOwnerIsRefusedTest = init.then(Abort)
    .expect(s.phase == "refused" and RefusedHasNoEffects)
}
module ChoiceApprovalCancellation_missing {
  import ChoiceApprovalCancellation(InitialOwner = "unknown").*
  run missingOwnerIsRefusedTest = init.then(Abort)
    .expect(s.phase == "refused" and RefusedHasNoEffects)
}
