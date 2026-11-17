lemma RequestStoreBridge(t: TrajectoryCapture, caller: int)
  ensures requestStore(t, caller).store.waiting == t.store.waiting + ProofLib.Filter((set_x: int) => !((set_x in t.store.waiting)), [caller])
{}

lemma requestStore_ensures(t: TrajectoryCapture, caller: int)
  ensures (inv(t) ==> canRequestStore(t, caller) ==> alwaysSavedNeverExceedsAccepted(requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> alwaysStepsNeedAnInitializedStore(requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> alwaysGracefulEndIsDrained(requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> alwaysNothingAcceptedBeforeStart(requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> alwaysPersistenceOffSavesNothing(requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> alwaysDeadExecutionIsStopping(requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> alwaysWaitersHaveAnInitializer(requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> alwaysMigrationOnce(requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> stepRecoveryNeedsADeadExecution(t, "requestStore", requestStore(t, caller)))
  ensures (inv(t) ==> canRequestStore(t, caller) ==> stepWaitingCallerIsAnswered(t, requestStore(t, caller)))
{
  if inv(t) && canRequestStore(t, caller) {
    RequestStoreBridge(t, caller);
    ProofLib.FilterCons((set_x: int) => !((set_x in t.store.waiting)), [caller]);
  }
}

lemma InitFailedBridge(t: TrajectoryCapture)
  ensures initFailed(t).store.failedCallers == t.store.failedCallers + ProofLib.Filter((set_x: int) => !((set_x in t.store.failedCallers)), t.store.waiting)
{}

lemma initFailed_ensures(t: TrajectoryCapture)
  ensures (inv(t) ==> canInitFailed(t) ==> alwaysSavedNeverExceedsAccepted(initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> alwaysStepsNeedAnInitializedStore(initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> alwaysGracefulEndIsDrained(initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> alwaysNothingAcceptedBeforeStart(initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> alwaysPersistenceOffSavesNothing(initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> alwaysDeadExecutionIsStopping(initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> alwaysWaitersHaveAnInitializer(initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> alwaysMigrationOnce(initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> stepRecoveryNeedsADeadExecution(t, "initFailed", initFailed(t)))
  ensures (inv(t) ==> canInitFailed(t) ==> stepWaitingCallerIsAnswered(t, initFailed(t)))
{
  if inv(t) && canInitFailed(t) {
    InitFailedBridge(t);
    forall c | c in t.store.waiting ensures c in initFailed(t).store.failedCallers {
      ProofLib.FilterMember((set_x: int) => !((set_x in t.store.failedCallers)), t.store.waiting, c);
    }
  }
}
