lemma register_ensures(s: Drain, agent: string, service: string)
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysClosedServicesHaveNoQueries(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysStopReceiptDrainedItsSnapshot(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysActiveAdapterIsOpen(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysRunningServiceOwnsBusySlot(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysRunningServicesAreUnique(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysQueryKeysUnique(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysDirtyKeysUnique(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysCloseRequiresRetirement(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysStopSnapshotUsesIssuedKeys(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysReadyHasDispatch(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysClosedAdaptersHaveNoQueries(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> stepDispatchUsesCurrentRegistration(s, register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> stepTakenClearsDirty(s, "register", register(s, agent, service)))
{
  if inv(s) && canRegister(s, agent, service) {
    QDDirty(s);
    QDAddDirty(s.dirtyAgents, agent);
    QDDirty(register(s, agent, service));
  }
}

lemma startAdapter_ensures(s: Drain, adapter: string)
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysClosedServicesHaveNoQueries(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysStopReceiptDrainedItsSnapshot(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysActiveAdapterIsOpen(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysRunningServiceOwnsBusySlot(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysRunningServicesAreUnique(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysQueryKeysUnique(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysDirtyKeysUnique(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysCloseRequiresRetirement(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysStopSnapshotUsesIssuedKeys(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysReadyHasDispatch(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysClosedAdaptersHaveNoQueries(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> stepDispatchUsesCurrentRegistration(s, startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> stepTakenClearsDirty(s, "startAdapter", startAdapter(s, adapter)))
{
  if inv(s) && canStartAdapter(s, adapter) {
    QDDirty(s);
    QDRearm(s);
    QDDirty(startAdapter(s, adapter));
  }
}

lemma clearUnregisteredDirty_ensures(s: Drain)
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysClosedServicesHaveNoQueries(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysStopReceiptDrainedItsSnapshot(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysActiveAdapterIsOpen(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysRunningServiceOwnsBusySlot(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysRunningServicesAreUnique(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysQueryKeysUnique(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysDirtyKeysUnique(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysCloseRequiresRetirement(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysStopSnapshotUsesIssuedKeys(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysReadyHasDispatch(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysClosedAdaptersHaveNoQueries(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> stepDispatchUsesCurrentRegistration(s, clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> stepTakenClearsDirty(s, "clearUnregisteredDirty", clearUnregisteredDirty(s)))
{
  if inv(s) && canClearUnregisteredDirty(s) {
    QDDirty(s);
    QDPreserve(s);
    QDDirty(clearUnregisteredDirty(s));
  }
}

lemma beginQuery_ensures(s: Drain)
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysClosedServicesHaveNoQueries(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysStopReceiptDrainedItsSnapshot(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysActiveAdapterIsOpen(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysRunningServiceOwnsBusySlot(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysRunningServicesAreUnique(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysQueryKeysUnique(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysDirtyKeysUnique(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysCloseRequiresRetirement(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysStopSnapshotUsesIssuedKeys(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysReadyHasDispatch(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysClosedAdaptersHaveNoQueries(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> stepDispatchUsesCurrentRegistration(s, beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> stepTakenClearsDirty(s, "beginQuery", beginQuery(s)))
{
  if inv(s) && canBeginQuery(s) {
    var after := beginQuery(s);
    QDDirty(s);
    QDPreserve(s);
    QDDirty(after);
    QDKeysIndexed(s);
    assert after.queries[|s.queries|].key == |s.queries| + 1;
    QDKeysByIndex(after);
  }
}

lemma markDirty_ensures(s: Drain, agent: string)
  ensures (inv(s) ==> alwaysClosedServicesHaveNoQueries(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysStopReceiptDrainedItsSnapshot(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysActiveAdapterIsOpen(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysRunningServiceOwnsBusySlot(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysRunningServicesAreUnique(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysQueryKeysUnique(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysDirtyKeysUnique(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysCloseRequiresRetirement(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysStopSnapshotUsesIssuedKeys(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysReadyHasDispatch(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysClosedAdaptersHaveNoQueries(markDirty(s, agent)))
  ensures (inv(s) ==> stepDispatchUsesCurrentRegistration(s, markDirty(s, agent)))
  ensures (inv(s) ==> stepTakenClearsDirty(s, "markDirty", markDirty(s, agent)))
{
  if inv(s) {
    QDDirty(s);
    QDAddDirty(s.dirtyAgents, agent);
    QDDirty(markDirty(s, agent));
  }
}

lemma closeService_ensures(s: Drain, service: string)
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysClosedServicesHaveNoQueries(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysStopReceiptDrainedItsSnapshot(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysActiveAdapterIsOpen(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysRunningServiceOwnsBusySlot(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysRunningServicesAreUnique(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysQueryKeysUnique(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysDirtyKeysUnique(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysCloseRequiresRetirement(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysStopSnapshotUsesIssuedKeys(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysReadyHasDispatch(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysClosedAdaptersHaveNoQueries(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> stepDispatchUsesCurrentRegistration(s, closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> stepTakenClearsDirty(s, "closeService", closeService(s, service)))
{
  if inv(s) && canCloseService(s, service) {
    QDAdd(s.closedServices, service);
    assert closeService(s, service).closedServices == s.closedServices + ProofLib.Filter((set_x: string) => !((set_x in s.closedServices)), [service]);
  }
}

lemma unregister_ensures(s: Drain, agent: string, service: string)
  ensures (inv(s) ==> alwaysClosedServicesHaveNoQueries(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysStopReceiptDrainedItsSnapshot(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysActiveAdapterIsOpen(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysRunningServiceOwnsBusySlot(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysRunningServicesAreUnique(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysQueryKeysUnique(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysDirtyKeysUnique(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysCloseRequiresRetirement(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysStopSnapshotUsesIssuedKeys(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysReadyHasDispatch(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysClosedAdaptersHaveNoQueries(unregister(s, agent, service)))
  ensures (inv(s) ==> stepDispatchUsesCurrentRegistration(s, unregister(s, agent, service)))
  ensures (inv(s) ==> stepTakenClearsDirty(s, "unregister", unregister(s, agent, service)))
{
  if inv(s) {
    QDDirty(s);
    QDFilterDistinct((dirty: string) => (dirty != agent), s.dirtyAgents);
    assert unregister(s, agent, service).dirtyAgents == (if registrationFor(s, agent).service == service then ProofLib.Filter((dirty: string) => (dirty != agent), s.dirtyAgents) else s.dirtyAgents);
    QDDirty(unregister(s, agent, service));
  }
}

lemma finishQuery_ensures(s: Drain, key: int, succeeded: bool, resultRows: seq<TaskResult>)
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysClosedServicesHaveNoQueries(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysStopReceiptDrainedItsSnapshot(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysActiveAdapterIsOpen(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysRunningServiceOwnsBusySlot(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysRunningServicesAreUnique(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysQueryKeysUnique(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysDirtyKeysUnique(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysCloseRequiresRetirement(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysStopSnapshotUsesIssuedKeys(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysReadyHasDispatch(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysClosedAdaptersHaveNoQueries(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> stepDispatchUsesCurrentRegistration(s, finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> stepTakenClearsDirty(s, "finishQuery", finishQuery(s, key, succeeded, resultRows)))
{
  if inv(s) && canFinishQuery(s, key) {
    var after := finishQuery(s, key, succeeded, resultRows);
    QDKeysKept(s, after);
    QDDirty(s);
    QDFoldDirtyAll((agents: seq<string>, entry: Registration) => addDirty(agents, entry.agent), s.dirtyAgents);
    QDDirty(after);
  }
}

lemma finishRun_ensures(s: Drain, key: int)
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysClosedServicesHaveNoQueries(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysStopReceiptDrainedItsSnapshot(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysActiveAdapterIsOpen(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysRunningServiceOwnsBusySlot(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysRunningServicesAreUnique(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysQueryKeysUnique(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysDirtyKeysUnique(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysCloseRequiresRetirement(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysStopSnapshotUsesIssuedKeys(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysReadyHasDispatch(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysClosedAdaptersHaveNoQueries(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> stepDispatchUsesCurrentRegistration(s, finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> stepTakenClearsDirty(s, "finishRun", finishRun(s, key)))
{
  if inv(s) && canFinishRun(s, key) {
    var after := finishRun(s, key);
    var own := queryFor(s, key).running.registered;
    QDKeysIndexed(s);
    QDKeysKept(s, after);
    QDDirty(s);
    QDAddDirty(s.dirtyAgents, own.agent);
    QDDirty(after);
    QDQueryingKept(s, after);
    QDDrop(s.busyServices, own.service);
    assert after.busyServices == ProofLib.Filter((set_x: string) => !((set_x in [own.service])), s.busyServices);
    assert s.queries[key - 1] in s.queries;
    forall query | query in after.queries && query.phase.Running? ensures query.running.registered.service in after.busyServices {
      var i :| 0 <= i < |after.queries| && after.queries[i] == query;
      assert s.queries[i] in s.queries;
    }
  }
}

lemma dispatchNext_ensures(s: Drain, key: int)
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysClosedServicesHaveNoQueries(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysStopReceiptDrainedItsSnapshot(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysActiveAdapterIsOpen(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysRunningServiceOwnsBusySlot(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysRunningServicesAreUnique(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysQueryKeysUnique(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysDirtyKeysUnique(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysCloseRequiresRetirement(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysStopSnapshotUsesIssuedKeys(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysReadyHasDispatch(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysClosedAdaptersHaveNoQueries(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> stepDispatchUsesCurrentRegistration(s, dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> stepTakenClearsDirty(s, "dispatchNext", dispatchNext(s, key)))
{
  if inv(s) && canDispatchNext(s, key) {
    var after := dispatchNext(s, key);
    var group := queryFor(s, key).remaining[0];
    var e := group.registered;
    var accepted := currentRegistration(s, queryFor(s, key).generation, e) && !(e.service in s.busyServices);
    QDKeysIndexed(s);
    QDKeysKept(s, after);
    QDQueryingKept(s, after);
    QDAdd(s.busyServices, e.service);
    assert after.busyServices == (if accepted then s.busyServices + ProofLib.Filter((set_x: string) => !((set_x in s.busyServices)), [e.service]) else s.busyServices);
    forall query | query in after.queries && query.phase.Running? ensures query.running.registered.service in after.busyServices {
      var i :| 0 <= i < |after.queries| && after.queries[i] == query;
      assert s.queries[i] in s.queries;
    }
  }
}

lemma retireAdapter_ensures(s: Drain, adapter: string)
  ensures (inv(s) ==> alwaysClosedServicesHaveNoQueries(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysStopReceiptDrainedItsSnapshot(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysActiveAdapterIsOpen(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysRunningServiceOwnsBusySlot(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysRunningServicesAreUnique(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysQueryKeysUnique(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysDirtyKeysUnique(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysCloseRequiresRetirement(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysStopSnapshotUsesIssuedKeys(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysReadyHasDispatch(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysClosedAdaptersHaveNoQueries(retireAdapter(s, adapter)))
  ensures (inv(s) ==> stepDispatchUsesCurrentRegistration(s, retireAdapter(s, adapter)))
  ensures (inv(s) ==> stepTakenClearsDirty(s, "retireAdapter", retireAdapter(s, adapter)))
{
  if inv(s) {
    QDAdd(s.retiredAdapters, adapter);
    assert retireAdapter(s, adapter).retiredAdapters == s.retiredAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.retiredAdapters)), [adapter]);
  }
}

lemma closeAdapter_ensures(s: Drain, adapter: string)
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysClosedServicesHaveNoQueries(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysStopReceiptDrainedItsSnapshot(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysActiveAdapterIsOpen(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysRunningServiceOwnsBusySlot(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysRunningServicesAreUnique(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysQueryKeysUnique(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysDirtyKeysUnique(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysCloseRequiresRetirement(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysStopSnapshotUsesIssuedKeys(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysReadyHasDispatch(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysClosedAdaptersHaveNoQueries(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> stepDispatchUsesCurrentRegistration(s, closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> stepTakenClearsDirty(s, "closeAdapter", closeAdapter(s, adapter)))
{
  if inv(s) && canCloseAdapter(s, adapter) {
    QDAdd(s.closedAdapters, adapter);
    assert closeAdapter(s, adapter).closedAdapters == s.closedAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.closedAdapters)), [adapter]);
  }
}

lemma stopScheduler_ensures(s: Drain)
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysClosedServicesHaveNoQueries(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysStopReceiptDrainedItsSnapshot(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysActiveAdapterIsOpen(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysRunningServiceOwnsBusySlot(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysRunningServicesAreUnique(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysQueryKeysUnique(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysDirtyKeysUnique(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysCloseRequiresRetirement(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysStopSnapshotUsesIssuedKeys(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysReadyHasDispatch(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysClosedAdaptersHaveNoQueries(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> stepDispatchUsesCurrentRegistration(s, stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> stepTakenClearsDirty(s, "stopScheduler", stopScheduler(s)))
{
  if inv(s) && canStopScheduler(s) {
    var after := stopScheduler(s);
    assert |after.stopWaiting| == |ProofLib.Filter((query: Query) => query.phase.Querying?, s.queries)|;
    forall k | k in after.stopWaiting ensures k > 0 && k < after.nextQuery {
      var i :| 0 <= i < |after.stopWaiting| && after.stopWaiting[i] == k;
      var query := ProofLib.Filter((query: Query) => query.phase.Querying?, s.queries)[i];
      assert k == query.key;
      ProofLib.FilterMember((query: Query) => query.phase.Querying?, s.queries, query);
    }
  }
}

lemma handoff_ensures(s: Drain, oldAdapter: string, replacementAdapter: string)
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysClosedServicesHaveNoQueries(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysStopReceiptDrainedItsSnapshot(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysActiveAdapterIsOpen(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysRunningServiceOwnsBusySlot(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysRunningServicesAreUnique(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysQueryKeysUnique(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysDirtyKeysUnique(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysCloseRequiresRetirement(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysStopSnapshotUsesIssuedKeys(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysReadyHasDispatch(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysClosedAdaptersHaveNoQueries(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> stepDispatchUsesCurrentRegistration(s, handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> stepTakenClearsDirty(s, "handoff", handoff(s, oldAdapter, replacementAdapter)))
{
  if inv(s) && canHandoff(s, oldAdapter, replacementAdapter) {
    var after := handoff(s, oldAdapter, replacementAdapter);
    QDKeysKept(s, after);
    QDDirty(s);
    QDRearm(s);
    QDDirty(after);
    QDAdd(s.retiredAdapters, oldAdapter);
    assert after.retiredAdapters == s.retiredAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.retiredAdapters)), [oldAdapter]);
    QDHandoffAdapters(s, oldAdapter, replacementAdapter);
    forall adapter | adapter in after.closedAdapters ensures !pendingForAdapter(after, adapter) {
      if pendingForAdapter(after, adapter) {
        var query :| query in after.queries && query.phase.Querying? && adapter in query.adapters;
        var i :| 0 <= i < |after.queries| && after.queries[i] == query;
        assert s.queries[i] in s.queries;
      }
    }
  }
}

lemma closeRetiredServices_ensures(s: Drain)
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysClosedServicesHaveNoQueries(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysStopReceiptDrainedItsSnapshot(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysActiveAdapterIsOpen(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysRunningServiceOwnsBusySlot(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysRunningServicesAreUnique(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysQueryKeysUnique(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysDirtyKeysUnique(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysCloseRequiresRetirement(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysStopSnapshotUsesIssuedKeys(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysReadyHasDispatch(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysClosedAdaptersHaveNoQueries(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> stepDispatchUsesCurrentRegistration(s, closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> stepTakenClearsDirty(s, "closeRetiredServices", closeRetiredServices(s)))
{
  if inv(s) && canCloseRetiredServices(s) {
    QDCloseRetiredServices(s);
  }
}

lemma closeRetiredAdapters_ensures(s: Drain)
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysClosedServicesHaveNoQueries(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysStopReceiptDrainedItsSnapshot(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysActiveAdapterIsOpen(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysRunningServiceOwnsBusySlot(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysRunningServicesAreUnique(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysQueryKeysUnique(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysDirtyKeysUnique(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysCloseRequiresRetirement(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysStopSnapshotUsesIssuedKeys(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysReadyHasDispatch(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysClosedAdaptersHaveNoQueries(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> stepDispatchUsesCurrentRegistration(s, closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> stepTakenClearsDirty(s, "closeRetiredAdapters", closeRetiredAdapters(s)))
{
  if inv(s) && canCloseRetiredAdapters(s) {
    QDCloseRetiredAdapters(s);
  }
}

lemma advanceQuery_ensures(s: Drain, key: int, succeeded: bool, resultRows: seq<TaskResult>)
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysClosedServicesHaveNoQueries(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysStopReceiptDrainedItsSnapshot(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysActiveAdapterIsOpen(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysRunningServiceOwnsBusySlot(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysRunningServicesAreUnique(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysQueryKeysUnique(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysDirtyKeysUnique(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysCloseRequiresRetirement(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysStopSnapshotUsesIssuedKeys(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysReadyHasDispatch(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysClosedAdaptersHaveNoQueries(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> stepDispatchUsesCurrentRegistration(s, advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> stepTakenClearsDirty(s, "advanceQuery", advanceQuery(s, key, succeeded, resultRows)))
{
  if inv(s) && canAdvanceQuery(s, key) {
    if canFinishQuery(s, key) {
      finishQuery_ensures(s, key, succeeded, resultRows);
    } else if canDispatchNext(s, key) {
      dispatchNext_ensures(s, key);
    } else {
      finishRun_ensures(s, key);
    }
  }
}

lemma advancePending_ensures(s: Drain, succeeded: bool, resultRows: seq<TaskResult>)
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysClosedServicesHaveNoQueries(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysStopReceiptDrainedItsSnapshot(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysActiveAdapterIsOpen(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysRunningServiceOwnsBusySlot(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysRunningServicesAreUnique(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysQueryKeysUnique(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysDirtyKeysUnique(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysCloseRequiresRetirement(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysStopSnapshotUsesIssuedKeys(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysReadyHasDispatch(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysClosedAdaptersHaveNoQueries(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> stepDispatchUsesCurrentRegistration(s, advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> stepTakenClearsDirty(s, "advancePending", advancePending(s, succeeded, resultRows)))
{
  if inv(s) && canAdvancePending(s) {
    var query := nextPendingQuery(s);
    QDPending(s);
    QDKeysIndexed(s);
    var i :| 0 <= i < |s.queries| && s.queries[i] == query;
    assert queryFor(s, query.key) == query;
    advanceQuery_ensures(s, query.key, succeeded, resultRows);
  }
}

lemma QDDistinctCount(xs: seq<string>)
  ensures (forall agent :: agent in xs ==> |ProofLib.Filter((other: string) => (other == agent), xs)| == 1) <==> ProofLib.Distinct(xs)
{
  if ProofLib.Distinct(xs) {
    forall agent | agent in xs ensures |ProofLib.Filter((other: string) => (other == agent), xs)| == 1 {
      ProofLib.FilterDistinctCountOne((other: string) => (other == agent), xs, agent);
    }
  }
  if forall agent :: agent in xs ==> |ProofLib.Filter((other: string) => (other == agent), xs)| == 1 {
    forall i, j | 0 <= i < j < |xs| ensures xs[i] != xs[j] {
      var agent := xs[i];
      assert agent in xs;
      if xs[j] == agent {
        ProofLib.FilterTwo((other: string) => (other == agent), xs, i, j);
      }
    }
  }
}

lemma QDDirty(s: Drain)
  ensures alwaysDirtyKeysUnique(s) <==> ProofLib.Distinct(s.dirtyAgents)
{
  assert alwaysDirtyKeysUnique(s) == !(exists agent :: agent in s.dirtyAgents && !(|ProofLib.Filter((other: string) => (other == agent), s.dirtyAgents)| == 1));
  QDDistinctCount(s.dirtyAgents);
}

lemma QDFilterDistinct(p: string -> bool, xs: seq<string>)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(ProofLib.Filter(p, xs))
{
  assert ProofLib.DistinctBy(xs, (x: string) => x);
  ProofLib.FilterKeepsDistinctBy(p, xs, (x: string) => x);
}

lemma QDAddDirty(xs: seq<string>, a: string)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(addDirty(xs, a))
{
}

lemma QDFoldDirty(f: (seq<string>, Registration) -> seq<string>, acc: seq<string>, rs: seq<Registration>)
  requires forall b, e :: f(b, e) == addDirty(b, e.agent)
  requires ProofLib.Distinct(acc)
  ensures ProofLib.Distinct(Std.Collections.Seq.FoldLeft(f, acc, rs))
  decreases |rs|
{
  if |rs| > 0 {
    QDAddDirty(acc, rs[0].agent);
    QDFoldDirty(f, f(acc, rs[0]), rs[1..]);
  }
}

lemma QDFoldDirtyAll(f: (seq<string>, Registration) -> seq<string>, acc: seq<string>)
  requires forall b, e :: f(b, e) == addDirty(b, e.agent)
  requires ProofLib.Distinct(acc)
  ensures forall rs :: ProofLib.Distinct(Std.Collections.Seq.FoldLeft(f, acc, rs))
{
  forall rs ensures ProofLib.Distinct(Std.Collections.Seq.FoldLeft(f, acc, rs)) {
    QDFoldDirty(f, acc, rs);
  }
}

lemma QDRearm(s: Drain)
  requires ProofLib.Distinct(s.dirtyAgents)
  ensures ProofLib.Distinct(rearmRegistry(s))
{
  QDFoldDirty((dirty: seq<string>, entry: Registration) => addDirty(dirty, entry.agent), s.dirtyAgents, s.registry);
}

lemma QDPreserve(s: Drain)
  requires ProofLib.Distinct(s.dirtyAgents)
  ensures ProofLib.Distinct(dirtyToPreserve(s))
{
  assert dirtyToPreserve(s) == ProofLib.Filter((agent: string) => preservedAgent(s, agent), s.dirtyAgents);
  QDFilterDistinct((agent: string) => preservedAgent(s, agent), s.dirtyAgents);
}

lemma QDKeysView(s: Drain)
  ensures alwaysQueryKeysUnique(s) == ((s.nextQuery == (|s.queries| + 1)) && !((exists query :: query in s.queries && !(((((query.key > 0) && (query.key < s.nextQuery)) && ((if ((0 <= (query.key - 1)) && ((query.key - 1) < |s.queries|)) then s.queries[(query.key - 1)] else absentQuery).key == query.key)) && (|ProofLib.Filter((other: Query) => (other.key == query.key), s.queries)| == 1))))))
{
}

lemma QDKeysIndexed(s: Drain)
  requires alwaysQueryKeysUnique(s)
  ensures s.nextQuery == |s.queries| + 1
  ensures forall i :: 0 <= i < |s.queries| ==> s.queries[i].key == i + 1
{
  QDKeysView(s);
  forall i | 0 <= i < |s.queries| ensures s.queries[i].key == i + 1 {
    var query := s.queries[i];
    assert query in s.queries;
    var k := query.key - 1;
    if k != i {
      ProofLib.FilterTwo((other: Query) => (other.key == query.key), s.queries, i, k);
    }
  }
}

lemma QDKeysByIndex(s: Drain)
  requires s.nextQuery == |s.queries| + 1
  requires forall i :: 0 <= i < |s.queries| ==> s.queries[i].key == i + 1
  ensures alwaysQueryKeysUnique(s)
{
  QDKeysView(s);
  forall query | query in s.queries ensures |ProofLib.Filter((other: Query) => (other.key == query.key), s.queries)| == 1 {
    var i :| 0 <= i < |s.queries| && s.queries[i] == query;
    ProofLib.FilterOne((other: Query) => (other.key == query.key), s.queries, i);
  }
}

lemma QDKeysKept(s: Drain, after: Drain)
  requires alwaysQueryKeysUnique(s)
  requires after.nextQuery == s.nextQuery && |after.queries| == |s.queries|
  requires forall i :: 0 <= i < |s.queries| ==> after.queries[i].key == s.queries[i].key
  ensures alwaysQueryKeysUnique(after)
{
  QDKeysIndexed(s);
  QDKeysByIndex(after);
}

lemma QDQueryingKept(s: Drain, after: Drain)
  requires |after.queries| == |s.queries|
  requires forall i :: 0 <= i < |s.queries| && after.queries[i].phase.Querying? ==> after.queries[i] == s.queries[i]
  ensures forall service :: pendingForService(after, service) ==> pendingForService(s, service)
  ensures forall adapter :: pendingForAdapter(after, adapter) ==> pendingForAdapter(s, adapter)
{
  forall service | pendingForService(after, service) ensures pendingForService(s, service) {
    var query :| query in after.queries && query.phase.Querying? && exists entry :: entry in query.captured && entry.service == service;
    var i :| 0 <= i < |after.queries| && after.queries[i] == query;
    assert s.queries[i] in s.queries;
  }
  forall adapter | pendingForAdapter(after, adapter) ensures pendingForAdapter(s, adapter) {
    var query :| query in after.queries && query.phase.Querying? && adapter in query.adapters;
    var i :| 0 <= i < |after.queries| && after.queries[i] == query;
    assert s.queries[i] in s.queries;
  }
}

lemma QDAdd(xs: seq<string>, v: string)
  ensures forall x :: x in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [v]) <==> x in xs || x == v
{
  forall x ensures x in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [v]) <==> x in xs || x == v {
    ProofLib.FilterMember((set_x: string) => !((set_x in xs)), [v], x);
  }
}

lemma QDDrop(xs: seq<string>, v: string)
  ensures forall x :: x in ProofLib.Filter((set_x: string) => !((set_x in [v])), xs) <==> x in xs && x != v
{
  forall x ensures x in ProofLib.Filter((set_x: string) => !((set_x in [v])), xs) <==> x in xs && x != v {
    ProofLib.FilterMember((set_x: string) => !((set_x in [v])), xs, x);
  }
}

lemma QDHandoffAdapters(s: Drain, oldAdapter: string, replacementAdapter: string)
  ensures |handoff(s, oldAdapter, replacementAdapter).queries| == |s.queries|
  ensures forall i, x :: 0 <= i < |s.queries| ==> (x in handoff(s, oldAdapter, replacementAdapter).queries[i].adapters <==> (x in s.queries[i].adapters || (x == replacementAdapter && s.queries[i].phase.Querying? && oldAdapter in s.queries[i].adapters)))
  ensures forall i :: 0 <= i < |s.queries| ==> handoff(s, oldAdapter, replacementAdapter).queries[i].phase == s.queries[i].phase && handoff(s, oldAdapter, replacementAdapter).queries[i].key == s.queries[i].key
{
  forall i, x | 0 <= i < |s.queries| ensures (x in handoff(s, oldAdapter, replacementAdapter).queries[i].adapters <==> (x in s.queries[i].adapters || (x == replacementAdapter && s.queries[i].phase.Querying? && oldAdapter in s.queries[i].adapters))) {
    var query := s.queries[i];
    ProofLib.FilterMember((set_x: string) => !((set_x in query.adapters)), [replacementAdapter], x);
  }
}

lemma QDCloseRetiredServices(s: Drain)
  ensures forall x :: x in closeRetiredServices(s).closedServices <==> x in s.closedServices || (x in s.retiredServices && canCloseService(s, x))
{
  assert closeRetiredServices(s).closedServices == s.closedServices + ProofLib.Filter((set_x: string) => !((set_x in s.closedServices)), ProofLib.Filter((service: string) => canCloseService(s, service), s.retiredServices));
  forall x ensures x in closeRetiredServices(s).closedServices <==> x in s.closedServices || (x in s.retiredServices && canCloseService(s, x)) {
    ProofLib.FilterMember((set_x: string) => !((set_x in s.closedServices)), ProofLib.Filter((service: string) => canCloseService(s, service), s.retiredServices), x);
    ProofLib.FilterMember((service: string) => canCloseService(s, service), s.retiredServices, x);
  }
}

lemma QDCloseRetiredAdapters(s: Drain)
  ensures forall x :: x in closeRetiredAdapters(s).closedAdapters <==> x in s.closedAdapters || (x in s.retiredAdapters && canCloseAdapter(s, x))
{
  assert closeRetiredAdapters(s).closedAdapters == s.closedAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.closedAdapters)), ProofLib.Filter((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters));
  forall x ensures x in closeRetiredAdapters(s).closedAdapters <==> x in s.closedAdapters || (x in s.retiredAdapters && canCloseAdapter(s, x)) {
    ProofLib.FilterMember((set_x: string) => !((set_x in s.closedAdapters)), ProofLib.Filter((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters), x);
    ProofLib.FilterMember((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters, x);
  }
}

lemma QDPending(s: Drain)
  ensures nextPendingQuery(s).key != 0 ==> nextPendingQuery(s) in s.queries && (nextPendingQuery(s).phase.Querying? || nextPendingQuery(s).phase.Ready? || nextPendingQuery(s).phase.Running?)
{
  assert nextPendingQuery(s) == (if 0 < |ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)| then ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)[0] else absentQuery);
  if 0 < |ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)| {
    ProofLib.FilterMember((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries, ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)[0]);
  }
}
