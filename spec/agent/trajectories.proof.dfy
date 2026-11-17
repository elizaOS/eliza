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
{
  if inv(t) && canRequestStore(t, caller) {
    RequestStoreBridge(t, caller);
    ProofLib.FilterCons((set_x: int) => !((set_x in t.store.waiting)), [caller]);
  }
}
