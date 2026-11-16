lemma quarantineCompleted_ensures(s: TaskServiceOwners, task: string, success: bool)
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysExecutionsHavePendingOwner(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysActiveTickOwned(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysStoppedHasNoTimer(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysStopReturnsAfterOperations(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysQuarantinedTaskHasNoWorker(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> stepQuarantineFollowsStartupGrace(s, "quarantineCompleted", quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "quarantineCompleted", quarantineCompleted(s, task, success)))
{
  if inv(s) && canQuarantineCompleted(s, task) {
    var after := quarantineCompleted(s, task, success);
    forall q | q in after.quarantined
      ensures q !in after.workers
    {
      if q !in s.quarantined { ProofLib.FilterMember((set_x: string) => !((set_x in s.quarantined)), [task], q); }
    }
  }
}

lemma healCompleted_ensures(s: TaskServiceOwners, task: string, success: bool)
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysExecutionsHavePendingOwner(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysActiveTickOwned(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysStoppedHasNoTimer(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysStopReturnsAfterOperations(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysQuarantinedTaskHasNoWorker(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> stepQuarantineFollowsStartupGrace(s, "healCompleted", healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "healCompleted", healCompleted(s, task, success)))
{
  if inv(s) && canHealCompleted(s, task) && success {
    var after := healCompleted(s, task, success);
    forall q | q in after.quarantined
      ensures q !in after.workers
    {
      ProofLib.FilterMember((set_x: string) => !((set_x in [task])), s.quarantined, q);
    }
  }
}

lemma registerWorker_ensures(s: TaskServiceOwners, task: string)
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysExecutionsHavePendingOwner(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysActiveTickOwned(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysStoppedHasNoTimer(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysStopReturnsAfterOperations(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysQuarantinedTaskHasNoWorker(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> stepQuarantineFollowsStartupGrace(s, "registerWorker", registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "registerWorker", registerWorker(s, task)))
{
  if inv(s) && canRegisterWorker(s, task) {
    var after := registerWorker(s, task);
    forall q | q in after.quarantined
      ensures q !in after.workers
    {
      ProofLib.FilterMember((set_x: string) => !((set_x in [task])), s.quarantined, q);
      if q in after.workers && q !in s.workers { ProofLib.FilterMember((set_x: string) => !((set_x in s.workers)), [task], q); }
    }
  }
}
