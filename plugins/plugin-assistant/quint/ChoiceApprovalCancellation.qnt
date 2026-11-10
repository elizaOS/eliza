// CHOOSE_OPTION ABORT -> ApprovalService.cancelApproval -> runtime.deleteTask.
// One unclaimed approval with its registered owner, or one generic choice task.
// Authorization/validation precede this projection and use real runtime gates
// in the conformance flow. Owner cancellation happens before the storage await.
module ChoiceApprovalCancellation {
  const OwnsApproval: bool
  type State = { phase: str, caller: str }
  var s: State
  val taskPresent = Set("ready", "delete", "retained").contains(s.phase)
  val acknowledged = s.phase == "done"
  val inFlight = Set("delete", "confirm").contains(s.phase)
  val terminal = Set("retained", "done", "deliveryFailed").contains(s.phase)

  action init = s' = { phase: "ready", caller: if (OwnsApproval) "pending" else "absent" }
  action Abort = all {
    Set("ready", "retained").contains(s.phase),
    s' = { phase: "delete", caller: if (OwnsApproval) "cancelled" else s.caller }
  }
  action DeleteDone = all { s.phase == "delete", s' = { ...s, phase: "confirm" } }
  action DeleteFailed = all { s.phase == "delete", s' = { ...s, phase: "retained" } }
  action Confirm = all { s.phase == "confirm", s' = { ...s, phase: "done" } }
  action ConfirmationFailed = all { s.phase == "confirm", s' = { ...s, phase: "deliveryFailed" } }
  action step = any { Abort, DeleteDone, DeleteFailed, Confirm, ConfirmationFailed, s' = s }

  val TypeOK = Set("ready", "delete", "retained", "confirm", "done", "deliveryFailed").contains(s.phase) and
    Set("pending", "cancelled", "absent").contains(s.caller)
  val OwnerSettledBeforeDelete = (OwnsApproval and s.phase != "ready") implies s.caller == "cancelled"
  val AckRequiresDeletion = acknowledged implies not(taskPresent)
  val AckSettlesOwner = (OwnsApproval and acknowledged) implies s.caller == "cancelled"
  val GenericHasNoApprovalCaller = not(OwnsApproval) implies s.caller == "absent"

  temporal CancellationStays = always((s.caller == "cancelled" implies next(s.caller) == "cancelled").orKeep(s))
  temporal DeletedStaysDeleted = always((not(taskPresent) implies not(Set("ready", "delete", "retained").contains(next(s.phase)))).orKeep(s))
  temporal CompletionFairness = and {
    any { DeleteDone, DeleteFailed }.weakFair(s),
    any { Confirm, ConfirmationFailed }.weakFair(s)
  }
  temporal FairAttemptSettles = CompletionFairness implies always(inFlight implies eventually(terminal))
  temporal UnfairAttemptSettles = always(inFlight implies eventually(terminal))
}
module ChoiceApprovalCancellation_owned {
  import ChoiceApprovalCancellation(OwnsApproval = true).*
  run ownerSettlesBeforeAckTest = init.then(Abort).expect(s.caller == "cancelled")
    .then(DeleteDone).then(Confirm).expect(acknowledged and not(taskPresent))
  run failedDeleteCanBeRetriedTest = init.then(Abort).then(DeleteFailed)
    .expect(taskPresent and s.caller == "cancelled" and not(acknowledged))
    .then(Abort).then(DeleteDone).then(Confirm).expect(acknowledged)
}
module ChoiceApprovalCancellation_generic {
  import ChoiceApprovalCancellation(OwnsApproval = false).*
  run genericChoiceStillCancelsTest = init.then(Abort).then(DeleteDone).then(Confirm)
    .expect(acknowledged and s.caller == "absent")
}
