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
    QueryDirtyView(s); QueryDirtyView(register(s, agent, service));
    QueryDirtyAdd(s.dirtyAgents, agent);
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
    QueryDirtyView(s); QueryDirtyView(startAdapter(s, adapter));
    if s.activeAdapter != "" { QueryDirtyFold(s.registry, s.dirtyAgents, rearmRegistry(s)); }
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
    QueryPreservedDirty(s); QueryDirtyView(clearUnregisteredDirty(s));
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
    QueryDirtyView(s); QueryDirtyView(markDirty(s, agent));
    QueryDirtyAdd(s.dirtyAgents, agent);
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
    var after := unregister(s, agent, service);
    QueryUnregisterView(s, agent, service); QueryDirtyView(s); QueryDirtyView(after);
    if registrationFor(s, agent).service == service {
      QueryDirtyFilter(s.dirtyAgents, after.dirtyAgents, (dirty: string) => (dirty != agent));
    }
    QueryUnion(s.retiredServices, service);
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
    var after := closeService(s, service);
    QueryCloseServiceView(s, service); QueryUnion(s.closedServices, service);
    forall closed | closed in after.closedServices
      ensures closed in after.retiredServices && !pendingForService(after, closed) && closed !in after.busyServices
    {
      assert closed in s.closedServices || closed == service;
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
    QueryRetireAdapterView(s, adapter); QueryUnion(s.retiredAdapters, adapter);
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
    var after := closeAdapter(s, adapter);
    QueryCloseAdapterView(s, adapter); QueryUnion(s.closedAdapters, adapter);
    forall closed | closed in after.closedAdapters
      ensures closed in after.retiredAdapters && !pendingForAdapter(after, closed)
    {
      assert closed in s.closedAdapters || closed == adapter;
    }
    if after.activeAdapter != "" { assert after.activeAdapter != adapter; }
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
    var after := closeRetiredServices(s);
    QueryCloseRetiredServicesView(s);
    var eligible := ProofLib.Filter((service: string) => canCloseService(s, service), s.retiredServices);
    QueryUnionMany(s.closedServices, eligible);
    forall closed | closed in after.closedServices
      ensures closed in after.retiredServices && !pendingForService(after, closed) && closed !in after.busyServices
    {
      if closed !in s.closedServices {
        ProofLib.FilterMember((service: string) => canCloseService(s, service), s.retiredServices, closed);
      }
    }
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
    var after := closeRetiredAdapters(s);
    QueryCloseRetiredAdaptersView(s);
    var eligible := ProofLib.Filter((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters);
    QueryUnionMany(s.closedAdapters, eligible);
    forall closed | closed in after.closedAdapters
      ensures closed in after.retiredAdapters && !pendingForAdapter(after, closed) && (after.activeAdapter != "" ==> closed != after.activeAdapter)
    {
      if closed !in s.closedAdapters {
        ProofLib.FilterMember((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters, closed);
      }
    }
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
  if inv(s) && canStopScheduler(s) { QueryStopSnapshot(s); }
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
    QueryHandoffView(s, oldAdapter, replacementAdapter);
    QueryUnion(s.retiredAdapters, oldAdapter);
    QueryKeyFrame(s, after); QueryDirtyView(s); QueryDirtyView(after);
    if s.activeAdapter == oldAdapter { QueryDirtyFold(s.registry, s.dirtyAgents, rearmRegistry(s)); }
    forall i | 0 <= i < |after.queries|
      ensures after.queries[i].key == s.queries[i].key && after.queries[i].phase == s.queries[i].phase && after.queries[i].captured == s.queries[i].captured
    {
      var query := s.queries[i];
      if query.phase.Querying? && oldAdapter in query.adapters {
        QueryUnion(query.adapters, replacementAdapter);
      }
    }
    forall adapter | adapter in after.closedAdapters
      ensures !pendingForAdapter(after, adapter)
    {
      forall i | 0 <= i < |after.queries| && after.queries[i].phase.Querying?
        ensures adapter !in after.queries[i].adapters
      {
        var query := s.queries[i];
        if oldAdapter in query.adapters { QueryUnion(query.adapters, replacementAdapter); }
      }
    }
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
    QueryKeysLayout(s);
    forall i | 0 <= i < |after.queries|
      ensures after.queries[i].key == i + 1
    {
      if i < |s.queries| { assert after.queries[i] == s.queries[i]; }
    }
    QueryKeysFromOrder(after);
    QueryPreservedDirty(s); QueryDirtyView(after); QueryCapturedEntries(s);
    QueryLookup(after, s.nextQuery);
    assert queryFor(after, s.nextQuery).captured == queryRegistrations(s);
    forall service | service in after.closedServices
      ensures !pendingForService(after, service) && service !in after.busyServices
    {
      forall entry | entry in queryRegistrations(s) ensures entry.service != service { }
    }
    forall adapter | adapter in after.closedAdapters
      ensures !pendingForAdapter(after, adapter)
    {
      assert adapter != s.activeAdapter;
    }
    forall key | key in after.stopWaiting ensures 0 < key < after.nextQuery { }
    if s.stopReturned {
      forall query | query in after.queries && query.key in after.stopWaiting
        ensures !query.phase.Querying?
      {
        assert query.key != s.nextQuery;
        assert query in s.queries;
      }
    }
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
    var query := queryFor(s, key);
    QueryFinishQueryView(s, key, succeeded, resultRows); QueryLookup(s, key);
    QueryKeyFrame(s, after); QueryDirtyView(s); QueryDirtyView(after);
    if !succeeded && query.generation == s.generation {
      var captured := ProofLib.Filter((entry: Registration) => currentRegistration(s, query.generation, entry), query.captured);
      ProofLib.FoldLeftPointwise((agents: seq<string>, entry: Registration) => addDirty(agents, entry.agent), (dirty: seq<string>, entry: Registration) => addDirty(dirty, entry.agent), s.dirtyAgents, captured, captured);
      QueryDirtyFold(captured, s.dirtyAgents, after.dirtyAgents);
    }
    forall i | 0 <= i < |after.queries|
      ensures after.queries[i].key == s.queries[i].key && (after.queries[i].phase.Querying? ==> after.queries[i] == s.queries[i]) && (after.queries[i].phase.Running? ==> after.queries[i] == s.queries[i]) && (after.queries[i].phase.Ready? ==> |after.queries[i].remaining| > 0)
    {
      if s.queries[i].key == key { assert s.queries[i] == query; }
    }
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
    QueryFinishRunOwnership(s, key); QueryFinishRunKeysAndDirty(s, key);
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
    var query := queryFor(s, key);
    var group := query.remaining[0];
    var service := group.registered.service;
    var accepted := currentRegistration(s, query.generation, group.registered) && service !in s.busyServices;
    QueryDispatchNextView(s, key); QueryLookup(s, key); QueryKeyFrame(s, after);
    if accepted { QueryUnion(s.busyServices, service); }
    forall i | 0 <= i < |after.queries| && after.queries[i].phase.Running?
      ensures after.queries[i].running.registered.service in after.busyServices
    {
      var before := s.queries[i];
      if before.key == key {
        assert before == query && accepted;
        assert after.queries[i].running == group;
      } else { assert after.queries[i] == before; }
    }
    forall i, j | 0 <= i < |after.queries| && 0 <= j < |after.queries| && after.queries[i].phase.Running? && after.queries[j].phase.Running? && after.queries[i].running.registered.service == after.queries[j].running.registered.service
      ensures after.queries[i].key == after.queries[j].key
    {
      if s.queries[i].key == key && s.queries[j].key != key {
        assert accepted && s.queries[j].phase.Running?;
        assert service in s.busyServices;
      } else if s.queries[j].key == key && s.queries[i].key != key {
        assert accepted && s.queries[i].phase.Running?;
        assert service in s.busyServices;
      }
    }
    forall closed | closed in after.closedServices
      ensures closed !in after.busyServices && !pendingForService(after, closed)
    {
      if accepted { assert closed != service; }
    }
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
    if canFinishQuery(s, key) { finishQuery_ensures(s, key, succeeded, resultRows); }
    else if canDispatchNext(s, key) { dispatchNext_ensures(s, key); }
    else { finishRun_ensures(s, key); }
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
    QueryNextPendingQueryView(s);
    var pending := ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries);
    var query := nextPendingQuery(s);
    assert |pending| > 0 && query == pending[0];
    ProofLib.FilterMember((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries, query);
    QueryLookup(s, query.key);
    assert queryFor(s, query.key) == query;
    assert canAdvanceQuery(s, query.key);
    advanceQuery_ensures(s, query.key, succeeded, resultRows);
  }
}

lemma QueryKeysFilter(s: Drain)
  ensures alwaysQueryKeysUnique(s) == (s.nextQuery == |s.queries| + 1 && forall query :: query in s.queries ==> query.key > 0 && query.key < s.nextQuery && (if 0 <= query.key - 1 < |s.queries| then s.queries[query.key - 1] else absentQuery).key == query.key && |ProofLib.Filter((other: Query) => (other.key == query.key), s.queries)| == 1)
{
}

lemma QueryKeyAt(s: Drain, i: int)
  requires alwaysQueryKeysUnique(s)
  requires 0 <= i < |s.queries|
  ensures s.queries[i].key == i + 1
{
  QueryKeysFilter(s);
  var query := s.queries[i];
  var j := query.key - 1;
  assert 0 <= j < |s.queries| && s.queries[j].key == query.key;
  if i != j {
    ProofLib.FilterTwo((other: Query) => (other.key == query.key), s.queries, i, j);
  }
}

lemma QueryKeysLayout(s: Drain)
  requires alwaysQueryKeysUnique(s)
  ensures s.nextQuery == |s.queries| + 1
  ensures forall i :: 0 <= i < |s.queries| ==> s.queries[i].key == i + 1
{
  forall i | 0 <= i < |s.queries|
    ensures s.queries[i].key == i + 1
  {
    QueryKeyAt(s, i);
  }
}

lemma QueryKeysFromOrder(s: Drain)
  requires s.nextQuery == |s.queries| + 1
  requires forall i :: 0 <= i < |s.queries| ==> s.queries[i].key == i + 1
  ensures alwaysQueryKeysUnique(s)
{
  QueryKeysFilter(s);
  forall query | query in s.queries
    ensures query.key > 0 && query.key < s.nextQuery && (if 0 <= query.key - 1 < |s.queries| then s.queries[query.key - 1] else absentQuery).key == query.key && |ProofLib.Filter((other: Query) => (other.key == query.key), s.queries)| == 1
  {
    var i :| 0 <= i < |s.queries| && s.queries[i] == query;
    ProofLib.FilterOne((other: Query) => (other.key == query.key), s.queries, i);
  }
}

lemma QueryKeyFrame(before: Drain, after: Drain)
  requires alwaysQueryKeysUnique(before)
  requires after.nextQuery == before.nextQuery && |after.queries| == |before.queries|
  requires forall i :: 0 <= i < |after.queries| ==> after.queries[i].key == before.queries[i].key
  ensures alwaysQueryKeysUnique(after)
{
  QueryKeysLayout(before); QueryKeysFromOrder(after);
}

lemma QueryLookup(s: Drain, key: int)
  requires alwaysQueryKeysUnique(s)
  ensures 0 < key < s.nextQuery ==> queryFor(s, key) == s.queries[key - 1] && queryFor(s, key).key == key
  ensures !(0 < key < s.nextQuery) ==> queryFor(s, key) == absentQuery
  ensures forall query :: query in s.queries && query.key == key ==> queryFor(s, key) == query
{
  QueryKeysLayout(s);
  forall query | query in s.queries && query.key == key
    ensures queryFor(s, key) == query
  {
    var i :| 0 <= i < |s.queries| && s.queries[i] == query;
    assert query.key == i + 1;
  }
}

lemma QueryDirtyView(s: Drain)
  ensures alwaysDirtyKeysUnique(s) == (forall agent :: agent in s.dirtyAgents ==> |ProofLib.Filter((other: string) => (other == agent), s.dirtyAgents)| == 1)
{
}

lemma QueryDirtyAdd(xs: seq<string>, agent: string)
  requires forall item :: item in xs ==> |ProofLib.Filter((other: string) => (other == item), xs)| == 1
  ensures forall item :: item in addDirty(xs, agent) ==> |ProofLib.Filter((other: string) => (other == item), addDirty(xs, agent))| == 1
{
  if agent !in xs {
    forall item | item in addDirty(xs, agent)
      ensures |ProofLib.Filter((other: string) => (other == item), addDirty(xs, agent))| == 1
    {
      ProofLib.FilterAppend((other: string) => (other == item), xs, agent);
      if item == agent { ProofLib.FilterNone((other: string) => (other == item), xs); }
    }
  }
}

lemma QueryDirtyFold(xs: seq<Registration>, dirty: seq<string>, result: seq<string>)
  requires result == Std.Collections.Seq.FoldLeft((dirty: seq<string>, entry: Registration) => addDirty(dirty, entry.agent), dirty, xs)
  requires forall item :: item in dirty ==> |ProofLib.Filter((other: string) => (other == item), dirty)| == 1
  ensures forall item :: item in result ==> |ProofLib.Filter((other: string) => (other == item), result)| == 1
  decreases |xs|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |xs| > 0 {
    QueryDirtyAdd(dirty, xs[0].agent);
    QueryDirtyFold(xs[1..], addDirty(dirty, xs[0].agent), result);
  }
}

lemma QueryDirtyFilter(xs: seq<string>, kept: seq<string>, p: string -> bool)
  requires kept == ProofLib.Filter(p, xs)
  requires forall item :: item in xs ==> |ProofLib.Filter((other: string) => (other == item), xs)| == 1
  ensures forall item :: item in kept ==> |ProofLib.Filter((other: string) => (other == item), kept)| == 1
{
  forall item | item in kept
    ensures |ProofLib.Filter((other: string) => (other == item), kept)| == 1
  {
    ProofLib.FilterMember(p, xs, item);
    ProofLib.FilterOfFilterLength(p, (other: string) => (other == item), (other: string) => (other == item), xs);
    ProofLib.FilterMember((other: string) => (other == item), kept, item);
  }
}

lemma QueryEligibleNotPreserved(s: Drain, agent: string)
  ensures eligibleAgent(s, agent) ==> !preserveDirty(s, agent)
{
}

lemma QueryQueryRegistrationsView(s: Drain)
  ensures queryRegistrations(s) == ((var s_map := ProofLib.Filter((agent: string) => eligibleAgent(s, agent), s.dirtyAgents); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var agent := s_map[i_map]; registrationFor(s, agent))))
{
}

lemma QueryDirtyToPreserveView(s: Drain)
  ensures dirtyToPreserve(s) == (ProofLib.Filter((agent: string) => preserveDirty(s, agent), s.dirtyAgents))
{
}

lemma QueryUnregisterView(s: Drain, agent: string, service: string)
  ensures unregister(s, agent, service) == (s.(registry := ProofLib.Filter((entry: Registration) => ((entry.agent != agent) || (entry.service != service)), s.registry), retiredServices := (s.retiredServices + ProofLib.Filter((set_x: string) => !((set_x in s.retiredServices)), [service])), dirtyAgents := (if (registrationFor(s, agent).service == service) then ProofLib.Filter((dirty: string) => (dirty != agent), s.dirtyAgents) else s.dirtyAgents)))
{
}

lemma QueryFinishRunView(s: Drain, key: int)
  ensures finishRun(s, key) == (var local_8 := queryFor(s, key);
  var local_9 := local_8.running.registered;
  var local_10 := (if currentRegistration(s, local_8.generation, local_9) then addDirty(s.dirtyAgents, local_9.agent) else s.dirtyAgents);
  s.(busyServices := ProofLib.Filter((set_x: string) => !((set_x in [local_9.service])), s.busyServices), dirtyAgents := local_10, queries := (var s_map := s.queries; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var queuedQuery := s_map[i_map]; (if (queuedQuery.key == key) then queuedQuery.(phase := (if (|queuedQuery.remaining| > 0) then QueryPhase.Ready else QueryPhase.Done), running := absentTaskGroup) else queuedQuery)))))
{
}

lemma QueryDispatchNextView(s: Drain, key: int)
  ensures dispatchNext(s, key) == (var local_11 := queryFor(s, key);
  var local_12 := (if ((0 <= 0) && (0 < |local_11.remaining|)) then local_11.remaining[0] else absentTaskGroup);
  var local_13 := local_12.registered;
  var local_14 := (currentRegistration(s, local_11.generation, local_13) && !((local_13.service in s.busyServices)));
  var local_15 := (if (|local_11.remaining| > 0) then local_11.remaining[1..] else []);
  s.(dispatches := (if local_14 then (s.dispatches + 1) else s.dispatches), lastDispatched := (if local_14 then local_13 else s.lastDispatched), lastDispatchGeneration := (if local_14 then s.generation else s.lastDispatchGeneration), busyServices := (if local_14 then (s.busyServices + ProofLib.Filter((set_x: string) => !((set_x in s.busyServices)), [local_13.service])) else s.busyServices), queries := (var s_map := s.queries; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var queuedQuery := s_map[i_map]; (if (queuedQuery.key == key) then queuedQuery.(remaining := local_15, phase := (if local_14 then QueryPhase.Running else (if (|local_15| > 0) then QueryPhase.Ready else QueryPhase.Done)), running := (if local_14 then local_12 else absentTaskGroup)) else queuedQuery)))))
{
}

lemma QueryFinishQueryView(s: Drain, key: int, succeeded: bool, resultRows: seq<TaskResult>)
  ensures finishQuery(s, key, succeeded, resultRows) == (var local_5 := queryFor(s, key);
  var local_6 := (if (succeeded && (local_5.generation == s.generation)) then Std.Collections.Seq.FoldLeft((groups: seq<TaskGroup>, resultRow: TaskResult) => groupResult(s, local_5, groups, resultRow), [], resultRows) else []);
  var local_7 := (if (succeeded || (local_5.generation != s.generation)) then s.dirtyAgents else Std.Collections.Seq.FoldLeft((agents: seq<string>, entry: Registration) => addDirty(agents, entry.agent), s.dirtyAgents, ProofLib.Filter((entry: Registration) => currentRegistration(s, local_5.generation, entry), local_5.captured)));
  s.(queries := (var s_map := s.queries; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var entry := s_map[i_map]; (if (entry.key == key) then entry.(phase := (if (|local_6| > 0) then QueryPhase.Ready else QueryPhase.Done), remaining := local_6) else entry))), dirtyAgents := local_7, scopeError := (s.scopeError || ((succeeded && (local_5.generation == s.generation)) && (exists resultRow :: resultRow in resultRows && ((resultRow.agent == "") || !((exists entry :: entry in local_5.captured && (entry.agent == resultRow.agent)))))))))
{
}

lemma QueryHandoffView(s: Drain, oldAdapter: string, replacementAdapter: string)
  ensures handoff(s, oldAdapter, replacementAdapter) == (s.(activeAdapter := (if (s.activeAdapter == oldAdapter) then replacementAdapter else s.activeAdapter), generation := (if (s.activeAdapter == oldAdapter) then (s.generation + 1) else s.generation), dirtyAgents := (if (s.activeAdapter == oldAdapter) then rearmRegistry(s) else s.dirtyAgents), retiredAdapters := (s.retiredAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.retiredAdapters)), [oldAdapter])), queries := (var s_map := s.queries; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var query := s_map[i_map]; (if (query.phase.Querying? && (oldAdapter in query.adapters)) then query.(adapters := (query.adapters + ProofLib.Filter((set_x: string) => !((set_x in query.adapters)), [replacementAdapter]))) else query)))))
{
}

lemma QueryStopSchedulerView(s: Drain)
  ensures stopScheduler(s) == (s.(generation := (s.generation + 1), activeAdapter := "", registry := [], dirtyAgents := [], stopRequested := true, stopReturned := false, stopWaiting := (var s_map := ProofLib.Filter((query: Query) => query.phase.Querying?, s.queries); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var query := s_map[i_map]; query.key))))
{
}

lemma QueryCloseServiceView(s: Drain, service: string)
  ensures closeService(s, service) == (s.(closedServices := (s.closedServices + ProofLib.Filter((set_x: string) => !((set_x in s.closedServices)), [service]))))
{
}

lemma QueryCloseAdapterView(s: Drain, adapter: string)
  ensures closeAdapter(s, adapter) == (s.(closedAdapters := (s.closedAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.closedAdapters)), [adapter]))))
{
}

lemma QueryCloseRetiredServicesView(s: Drain)
  ensures closeRetiredServices(s) == (s.(closedServices := (s.closedServices + ProofLib.Filter((set_x: string) => !((set_x in s.closedServices)), ProofLib.Filter((service: string) => canCloseService(s, service), s.retiredServices)))))
{
}

lemma QueryCloseRetiredAdaptersView(s: Drain)
  ensures closeRetiredAdapters(s) == (s.(closedAdapters := (s.closedAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.closedAdapters)), ProofLib.Filter((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters)))))
{
}

lemma QueryNextPendingQueryView(s: Drain)
  ensures nextPendingQuery(s) == (if ((0 <= 0) && (0 < |ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)|)) then
    ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)[0]
  else
    absentQuery)
{
}

lemma QueryUnion(xs: seq<string>, item: string)
  ensures forall value :: value in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [item]) <==> value in xs || value == item
{
  forall value
    ensures value in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), [item]) <==> value in xs || value == item
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in xs)), [item], value);
  }
}

lemma QueryUnionMany(xs: seq<string>, items: seq<string>)
  ensures forall value :: value in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), items) ==> value in xs || value in items
{
  forall value | value in xs + ProofLib.Filter((set_x: string) => !((set_x in xs)), items)
    ensures value in xs || value in items
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in xs)), items, value);
  }
}

lemma QueryPreservedDirty(s: Drain)
  requires alwaysDirtyKeysUnique(s)
  ensures forall item :: item in dirtyToPreserve(s) ==> |ProofLib.Filter((other: string) => (other == item), dirtyToPreserve(s))| == 1
{
  QueryDirtyToPreserveView(s); QueryDirtyView(s);
  QueryDirtyFilter(s.dirtyAgents, dirtyToPreserve(s), (agent: string) => preserveDirty(s, agent));
}

lemma QueryCapturedEntries(s: Drain)
  requires alwaysCloseRequiresRetirement(s)
  ensures forall entry :: entry in queryRegistrations(s) ==> entry.agent != "" && entry.service !in s.busyServices && entry.service !in s.retiredServices && entry.service !in s.closedServices && entry.agent !in dirtyToPreserve(s)
{
  QueryQueryRegistrationsView(s); QueryDirtyToPreserveView(s);
  var selected := ProofLib.Filter((agent: string) => eligibleAgent(s, agent), s.dirtyAgents);
  forall entry | entry in queryRegistrations(s)
    ensures entry.agent != "" && entry.service !in s.busyServices && entry.service !in s.retiredServices && entry.service !in s.closedServices && entry.agent !in dirtyToPreserve(s)
  {
    var i :| 0 <= i < |queryRegistrations(s)| && queryRegistrations(s)[i] == entry;
    var agent := selected[i];
    ProofLib.FilterMember((agent: string) => eligibleAgent(s, agent), s.dirtyAgents, agent);
    assert entry == registrationFor(s, agent) && entry.agent == agent;
    QueryEligibleNotPreserved(s, agent);
    ProofLib.FilterMember((agent: string) => preserveDirty(s, agent), s.dirtyAgents, agent);
  }
}

lemma QueryRetireAdapterView(s: Drain, adapter: string)
  ensures retireAdapter(s, adapter) == (s.(retiredAdapters := (s.retiredAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.retiredAdapters)), [adapter])), activeAdapter := (if (s.activeAdapter == adapter) then "" else s.activeAdapter), registry := (if (s.activeAdapter == adapter) then [] else s.registry), dirtyAgents := (if (s.activeAdapter == adapter) then [] else s.dirtyAgents), generation := (if (s.activeAdapter == adapter) then (s.generation + 1) else s.generation)))
{
}

lemma QueryStopSnapshot(s: Drain)
  requires alwaysQueryKeysUnique(s)
  ensures alwaysStopSnapshotUsesIssuedKeys(stopScheduler(s))
{
  var after := stopScheduler(s);
  QueryStopSchedulerView(s); QueryKeysLayout(s);
  var pending := ProofLib.Filter((query: Query) => query.phase.Querying?, s.queries);
  forall key | key in after.stopWaiting
    ensures 0 < key < after.nextQuery
  {
    var i :| 0 <= i < |after.stopWaiting| && after.stopWaiting[i] == key;
    var query := pending[i];
    ProofLib.FilterMember((query: Query) => query.phase.Querying?, s.queries, query);
    assert query.key == key;
  }
}

lemma QueryFinishRunOwnership(s: Drain, key: int)
  requires inv(s) && canFinishRun(s, key)
  ensures alwaysRunningServiceOwnsBusySlot(finishRun(s, key))
  ensures alwaysRunningServicesAreUnique(finishRun(s, key))
  ensures alwaysClosedServicesHaveNoQueries(finishRun(s, key))
{
  var after := finishRun(s, key);
  var query := queryFor(s, key);
  var service := query.running.registered.service;
  QueryFinishRunView(s, key); QueryLookup(s, key);
  forall i | 0 <= i < |after.queries| && after.queries[i].phase.Running?
    ensures after.queries[i] == s.queries[i] && after.queries[i].running.registered.service in after.busyServices
  {
    var other := s.queries[i];
    assert other.key != key;
    assert other.running.registered.service != service;
    ProofLib.FilterMember((set_x: string) => !((set_x in [service])), s.busyServices, other.running.registered.service);
  }
  forall closed | closed in after.closedServices
    ensures closed !in after.busyServices && !pendingForService(after, closed)
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in [service])), s.busyServices, closed);
  }
}

lemma QueryFinishRunKeysAndDirty(s: Drain, key: int)
  requires inv(s) && canFinishRun(s, key)
  ensures alwaysQueryKeysUnique(finishRun(s, key))
  ensures alwaysDirtyKeysUnique(finishRun(s, key))
{
  var after := finishRun(s, key);
  var query := queryFor(s, key);
  QueryFinishRunView(s, key); QueryKeyFrame(s, after);
  QueryDirtyView(s); QueryDirtyView(after);
  if currentRegistration(s, query.generation, query.running.registered) { QueryDirtyAdd(s.dirtyAgents, query.running.registered.agent); }
}
