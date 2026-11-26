lemma KeysView(d: core__queryDrain_Drain)
  ensures core__queryDrain_alwaysQueryKeysUnique(d) <==> ((d.nextQuery == (|d.queries| + 1)) && !((exists query :: query in d.queries && !(((((query.key > 0) && (query.key < d.nextQuery)) && ((if ((0 <= (query.key - 1)) && ((query.key - 1) < |d.queries|)) then d.queries[(query.key - 1)] else core__queryDrain_absentQuery).key == query.key)) && (|ProofLib.Filter((other: core__queryDrain_Query) => (other.key == query.key), d.queries)| == 1))))))
{
}

lemma KeysAligned(d: core__queryDrain_Drain)
  requires core__queryDrain_alwaysQueryKeysUnique(d)
  ensures d.nextQuery == |d.queries| + 1
  ensures forall i :: 0 <= i < |d.queries| ==> d.queries[i].key == i + 1
{
  KeysView(d);
  forall i | 0 <= i < |d.queries|
    ensures d.queries[i].key == i + 1
  {
    var query := d.queries[i];
    assert query in d.queries;
    if query.key - 1 != i {
      ProofLib.FilterTwo((other: core__queryDrain_Query) => (other.key == query.key), d.queries, i, query.key - 1);
    }
  }
}

lemma KeysFromAligned(d: core__queryDrain_Drain)
  requires d.nextQuery == |d.queries| + 1
  requires forall i :: 0 <= i < |d.queries| ==> d.queries[i].key == i + 1
  ensures core__queryDrain_alwaysQueryKeysUnique(d)
{
  KeysView(d);
  forall query | query in d.queries
    ensures |ProofLib.Filter((other: core__queryDrain_Query) => (other.key == query.key), d.queries)| == 1
  {
    var i :| 0 <= i < |d.queries| && d.queries[i] == query;
    ProofLib.FilterOne((other: core__queryDrain_Query) => (other.key == query.key), d.queries, i);
  }
}

lemma LinkAtView(s: SharedScheduler, tickId: int)
  ensures linkAt(s, tickId) == (if ((0 <= 0) && (0 < |ProofLib.Filter((link: TickQueryLink) => (link.tick == tickId), s.links)|)) then ProofLib.Filter((link: TickQueryLink) => (link.tick == tickId), s.links)[0] else noLink)
{
}

lemma AdvanceView(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures advanceQuery(s, key, succeeded, resultRows) == s.(drain := core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows), process := settleLinkedTick(s.process, (if ((0 <= 0) && (0 < |ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)|)) then ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0] else noLink), core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows)))
{
}

lemma LinkWithQuery(links: seq<TickQueryLink>, key: int, x: TickQueryLink)
  requires x in links && x.query == key
  ensures 0 < |ProofLib.Filter((row: TickQueryLink) => (row.query == key), links)|
  ensures ProofLib.Filter((row: TickQueryLink) => (row.query == key), links)[0] in links
  ensures ProofLib.Filter((row: TickQueryLink) => (row.query == key), links)[0].query == key
{
  ProofLib.FilterMember((row: TickQueryLink) => (row.query == key), links, x);
  ProofLib.FilterMember((row: TickQueryLink) => (row.query == key), links, ProofLib.Filter((row: TickQueryLink) => (row.query == key), links)[0]);
}

lemma DispatchBusyView(d: core__queryDrain_Drain, key: int)
  ensures core__queryDrain_dispatchNext(d, key).busyServices == (var q := core__queryDrain_queryFor(d, key); var g := (if ((0 <= 0) && (0 < |q.remaining|)) then q.remaining[0] else core__queryDrain_absentTaskGroup); if (core__queryDrain_currentRegistration(d, q.generation, g.registered) && !((g.registered.service in d.busyServices))) then (d.busyServices + ProofLib.Filter((set_x: string) => !((set_x in d.busyServices)), [g.registered.service])) else d.busyServices)
{
}

lemma FinishRunBusyView(d: core__queryDrain_Drain, key: int)
  ensures core__queryDrain_finishRun(d, key).busyServices == ProofLib.Filter((set_x: string) => !((set_x in [core__queryDrain_queryFor(d, key).running.registered.service])), d.busyServices)
{
}

lemma DrainAdvance(d: core__queryDrain_Drain, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires d.nextQuery == |d.queries| + 1 && forall i :: 0 <= i < |d.queries| ==> d.queries[i].key == i + 1
  requires 1 <= key <= |d.queries| && (d.queries[key - 1].phase.Querying? || d.queries[key - 1].phase.Ready? || d.queries[key - 1].phase.Running?)
  ensures var e := core__queryDrain_advanceQuery(d, key, succeeded, resultRows);
    |e.queries| == |d.queries| && e.nextQuery == d.nextQuery && e.generation == d.generation && e.activeAdapter == d.activeAdapter &&
    e.closedServices == d.closedServices && e.closedAdapters == d.closedAdapters && e.retiredServices == d.retiredServices &&
    e.retiredAdapters == d.retiredAdapters && e.stopWaiting == d.stopWaiting && e.stopReturned == d.stopReturned &&
    (forall i :: 0 <= i < |d.queries| ==> e.queries[i].key == d.queries[i].key && e.queries[i].generation == d.queries[i].generation) &&
    (forall i :: 0 <= i < |d.queries| && i != key - 1 ==> e.queries[i] == d.queries[i]) &&
    !e.queries[key - 1].phase.Querying? && !e.queries[key - 1].phase.Missing? &&
    (forall x :: x in e.busyServices ==> x in d.busyServices || x !in d.closedServices)
{
  var e := core__queryDrain_advanceQuery(d, key, succeeded, resultRows);
  if core__queryDrain_canFinishQuery(d, key) {
    assert e == core__queryDrain_finishQuery(d, key, succeeded, resultRows);
  } else if core__queryDrain_canDispatchNext(d, key) {
    assert e == core__queryDrain_dispatchNext(d, key);
    DispatchBusyView(d, key);
    var q := core__queryDrain_queryFor(d, key);
    var g := (if ((0 <= 0) && (0 < |q.remaining|)) then q.remaining[0] else core__queryDrain_absentTaskGroup);
    forall x | x in e.busyServices && x !in d.busyServices
      ensures x !in d.closedServices
    {
      ProofLib.FilterMember((set_x: string) => !((set_x in d.busyServices)), [g.registered.service], x);
    }
  } else {
    assert e == core__queryDrain_finishRun(d, key);
    FinishRunBusyView(d, key);
    forall x | x in e.busyServices
      ensures x in d.busyServices
    {
      ProofLib.FilterMember((set_x: string) => !((set_x in [core__queryDrain_queryFor(d, key).running.registered.service])), d.busyServices, x);
    }
  }
}

lemma AdvanceStorage(d: core__queryDrain_Drain, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires core__queryDrain_alwaysClosedServicesHaveNoQueries(d) && core__queryDrain_alwaysClosedAdaptersHaveNoQueries(d) && core__queryDrain_alwaysStopReceiptDrainedItsSnapshot(d)
  requires d.nextQuery == |d.queries| + 1 && forall i :: 0 <= i < |d.queries| ==> d.queries[i].key == i + 1
  requires 1 <= key <= |d.queries| && (d.queries[key - 1].phase.Querying? || d.queries[key - 1].phase.Ready? || d.queries[key - 1].phase.Running?)
  ensures core__queryDrain_alwaysClosedServicesHaveNoQueries(core__queryDrain_advanceQuery(d, key, succeeded, resultRows))
  ensures core__queryDrain_alwaysClosedAdaptersHaveNoQueries(core__queryDrain_advanceQuery(d, key, succeeded, resultRows))
  ensures core__queryDrain_alwaysStopReceiptDrainedItsSnapshot(core__queryDrain_advanceQuery(d, key, succeeded, resultRows))
  ensures core__queryDrain_alwaysQueryKeysUnique(core__queryDrain_advanceQuery(d, key, succeeded, resultRows))
{
  var e := core__queryDrain_advanceQuery(d, key, succeeded, resultRows);
  DrainAdvance(d, key, succeeded, resultRows);
  forall x | x in e.closedServices
    ensures !core__queryDrain_pendingForService(e, x) && x !in e.busyServices
  {
    if core__queryDrain_pendingForService(e, x) {
      var q :| q in e.queries && q.phase.Querying? && exists entry :: entry in q.captured && entry.service == x;
      var i :| 0 <= i < |e.queries| && e.queries[i] == q;
      assert d.queries[i] in d.queries;
    }
  }
  forall x | x in e.closedAdapters
    ensures !core__queryDrain_pendingForAdapter(e, x)
  {
    if core__queryDrain_pendingForAdapter(e, x) {
      var q :| q in e.queries && q.phase.Querying? && x in q.adapters;
      var i :| 0 <= i < |e.queries| && e.queries[i] == q;
      assert d.queries[i] in d.queries;
    }
  }
  if e.stopReturned {
    forall q | q in e.queries && q.key in e.stopWaiting
      ensures !q.phase.Querying?
    {
      var i :| 0 <= i < |e.queries| && e.queries[i] == q;
      assert d.queries[i] in d.queries;
    }
  }
  KeysFromAligned(e);
}

lemma AdvanceCore(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires inv(s) && 1 <= key <= |s.drain.queries|
  requires s.drain.queries[key - 1].phase.Querying? || s.drain.queries[key - 1].phase.Ready? || s.drain.queries[key - 1].phase.Running?
  ensures inv(advanceQuery(s, key, succeeded, resultRows))
  ensures stepOldTickCannotDetachReplacement(s, "advanceQuery", advanceQuery(s, key, succeeded, resultRows))
  ensures stepOldTickCannotDetachReplacement(s, "advance", advanceQuery(s, key, succeeded, resultRows))
{
  var d := s.drain;
  KeysAligned(d);
  DrainAdvance(d, key, succeeded, resultRows);
  AdvanceStorage(d, key, succeeded, resultRows);
  Settle(s, key, succeeded, resultRows);
  core__processScheduler_finishTick_ensures(s.process, ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0].tick);
  AdvanceTicks(s, key, succeeded, resultRows);
  AdvanceActive(s, key, succeeded, resultRows);
}

lemma advanceQuery_ensures(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysLinksPairIssuedTicksAndQueries(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysAdapterGenerationAgrees(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysActiveTickOwnsSameGenerationQuery(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysCapturedQueryOwnsTick(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysRetiredStorageDrains(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysOwnersKeepTheirRules(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> stepOldTickCannotDetachReplacement(s, "advanceQuery", advanceQuery(s, key, succeeded, resultRows)))
{
  if inv(s) && canAdvanceQuery(s, key) {
    KeysAligned(s.drain);
    AdvanceCore(s, key, succeeded, resultRows);
  }
}

lemma PendingView(d: core__queryDrain_Drain)
  ensures core__queryDrain_nextPendingQuery(d) == (if ((0 <= 0) && (0 < |ProofLib.Filter((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), d.queries)|)) then ProofLib.Filter((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), d.queries)[0] else core__queryDrain_absentQuery)
{
}

lemma advance_ensures(s: SharedScheduler, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures (inv(s) ==> canAdvance(s) ==> alwaysLinksPairIssuedTicksAndQueries(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysAdapterGenerationAgrees(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysActiveTickOwnsSameGenerationQuery(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysCapturedQueryOwnsTick(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysRetiredStorageDrains(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysOwnersKeepTheirRules(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> stepOldTickCannotDetachReplacement(s, "advance", advance(s, succeeded, resultRows)))
{
  if inv(s) && canAdvance(s) {
    var d := s.drain;
    KeysAligned(d);
    PendingView(d);
    var q := core__queryDrain_nextPendingQuery(d);
    ProofLib.FilterMember((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), d.queries, q);
    var i :| 0 <= i < |d.queries| && d.queries[i] == q;
    AdvanceCore(s, q.key, succeeded, resultRows);
  }
}

lemma QueryRegistrationsView(d: core__queryDrain_Drain)
  ensures core__queryDrain_queryRegistrations(d) == (var s_map := ProofLib.Filter((agent: string) => core__queryDrain_eligibleAgent(d, agent), d.dirtyAgents); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var agent := s_map[i_map]; core__queryDrain_registrationFor(d, agent)))
{
}

lemma CapturedNotRetired(d: core__queryDrain_Drain)
  ensures forall r :: r in core__queryDrain_queryRegistrations(d) ==> r.service !in d.retiredServices
{
  QueryRegistrationsView(d);
  var agents := ProofLib.Filter((agent: string) => core__queryDrain_eligibleAgent(d, agent), d.dirtyAgents);
  forall r | r in core__queryDrain_queryRegistrations(d)
    ensures r.service !in d.retiredServices
  {
    var i :| 0 <= i < |agents| && r == core__queryDrain_registrationFor(d, agents[i]);
    ProofLib.FilterMember((agent: string) => core__queryDrain_eligibleAgent(d, agent), d.dirtyAgents, agents[i]);
  }
}

lemma fire_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canFire(s) ==> alwaysLinksPairIssuedTicksAndQueries(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysAdapterGenerationAgrees(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysActiveTickOwnsSameGenerationQuery(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysCapturedQueryOwnsTick(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysRetiredStorageDrains(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysOwnersKeepTheirRules(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> stepOldTickCannotDetachReplacement(s, "fire", fire(s)))
{
  if inv(s) && canFire(s) {
    core__processScheduler_tick_ensures(s.process);
    if !attachedTickMayCapture(s) {
      TicksKeep(s, fire(s));
    } else if core__queryDrain_canBeginQuery(s.drain) {
      FireCaptureTicks(s);
      FireCaptureDrain(s);
      assert fire(s) == fire(s).(drain := core__queryDrain_beginQuery(s.drain));
    } else {
      FireEmpty(s);
    }
  }
}

lemma registerProcess_ensures(s: SharedScheduler, name: string)
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysLinksPairIssuedTicksAndQueries(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysAdapterGenerationAgrees(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysActiveTickOwnsSameGenerationQuery(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysCapturedQueryOwnsTick(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysRetiredStorageDrains(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysOwnersKeepTheirRules(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> stepOldTickCannotDetachReplacement(s, "registerProcess", registerProcess(s, name)))
{
  core__processScheduler_register_ensures(s.process, name);
}

lemma disposeProcess_ensures(s: SharedScheduler, id: int)
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysLinksPairIssuedTicksAndQueries(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysAdapterGenerationAgrees(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysCapturedQueryOwnsTick(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysRetiredStorageDrains(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysOwnersKeepTheirRules(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> stepOldTickCannotDetachReplacement(s, "disposeProcess", disposeProcess(s, id)))
{
  core__processScheduler_dispose_ensures(s.process, id);
}

lemma enterCallback_ensures(s: SharedScheduler, id: int)
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysLinksPairIssuedTicksAndQueries(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysAdapterGenerationAgrees(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysCapturedQueryOwnsTick(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysRetiredStorageDrains(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysOwnersKeepTheirRules(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> stepOldTickCannotDetachReplacement(s, "enterCallback", enterCallback(s, id)))
{
  core__processScheduler_enterProcess_ensures(s.process, id);
}

lemma returnCallback_ensures(s: SharedScheduler, id: int, succeeded: bool)
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysLinksPairIssuedTicksAndQueries(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysAdapterGenerationAgrees(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysCapturedQueryOwnsTick(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysRetiredStorageDrains(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysOwnersKeepTheirRules(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> stepOldTickCannotDetachReplacement(s, "returnCallback", returnCallback(s, id, succeeded)))
{
  core__processScheduler_finishProcess_ensures(s.process, id, succeeded);
}

lemma advanceDisposal_ensures(s: SharedScheduler, succeeded: bool)
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysLinksPairIssuedTicksAndQueries(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysAdapterGenerationAgrees(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysActiveTickOwnsSameGenerationQuery(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysCapturedQueryOwnsTick(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysRetiredStorageDrains(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysOwnersKeepTheirRules(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> stepOldTickCannotDetachReplacement(s, "advanceDisposal", advanceDisposal(s, succeeded)))
{
  core__processScheduler_advanceDisposal_ensures(s.process, succeeded);
  if inv(s) && canAdvanceDisposal(s) {
    TicksKeep(s, advanceDisposal(s, succeeded));
  }
}

lemma attach_ensures(s: SharedScheduler, adapter: string)
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysLinksPairIssuedTicksAndQueries(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysAdapterGenerationAgrees(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysActiveTickOwnsSameGenerationQuery(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysCapturedQueryOwnsTick(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysRetiredStorageDrains(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysOwnersKeepTheirRules(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> stepOldTickCannotDetachReplacement(s, "attach", attach(s, adapter)))
{
  core__processScheduler_startAdapter_ensures(s.process, adapter);
}

lemma RetiredView(d: core__queryDrain_Drain, adapter: string)
  ensures core__queryDrain_retireAdapter(d, adapter).retiredAdapters == d.retiredAdapters + ProofLib.Filter((set_x: string) => !((set_x in d.retiredAdapters)), [adapter])
{
}

lemma retireAdapter_ensures(s: SharedScheduler, adapter: string)
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysLinksPairIssuedTicksAndQueries(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysAdapterGenerationAgrees(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysActiveTickOwnsSameGenerationQuery(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysCapturedQueryOwnsTick(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysRetiredStorageDrains(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysOwnersKeepTheirRules(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> stepOldTickCannotDetachReplacement(s, "retireAdapter", retireAdapter(s, adapter)))
{
  if inv(s) && canRetireAdapter(s, adapter) {
    var after := retireAdapter(s, adapter);
    RetireOwners(s, adapter);
    StorageKeep(s.drain, after.drain);
    TicksKeep(s, after);
  }
}

lemma StopView(d: core__queryDrain_Drain)
  ensures |core__queryDrain_stopScheduler(d).stopWaiting| == |ProofLib.Filter((query: core__queryDrain_Query) => query.phase.Querying?, d.queries)|
  ensures forall i :: 0 <= i < |ProofLib.Filter((query: core__queryDrain_Query) => query.phase.Querying?, d.queries)| ==> core__queryDrain_stopScheduler(d).stopWaiting[i] == ProofLib.Filter((query: core__queryDrain_Query) => query.phase.Querying?, d.queries)[i].key
{
}

lemma stop_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canStop(s) ==> alwaysLinksPairIssuedTicksAndQueries(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysAdapterGenerationAgrees(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysActiveTickOwnsSameGenerationQuery(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysCapturedQueryOwnsTick(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysRetiredStorageDrains(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysOwnersKeepTheirRules(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepOldTickCannotDetachReplacement(s, "stop", stop(s)))
{
  if inv(s) && canStop(s) {
    var after := stop(s);
    StopOwners(s);
    StorageKeep(s.drain, after.drain);
    TicksKeep(s, after);
  }
}

lemma HandoffView(d: core__queryDrain_Drain, oldAdapter: string, replacementAdapter: string)
  ensures core__queryDrain_handoff(d, oldAdapter, replacementAdapter).retiredAdapters == d.retiredAdapters + ProofLib.Filter((set_x: string) => !((set_x in d.retiredAdapters)), [oldAdapter])
  ensures |core__queryDrain_handoff(d, oldAdapter, replacementAdapter).queries| == |d.queries|
  ensures forall i :: 0 <= i < |d.queries| ==> core__queryDrain_handoff(d, oldAdapter, replacementAdapter).queries[i] == (if (d.queries[i].phase.Querying? && (oldAdapter in d.queries[i].adapters)) then d.queries[i].(adapters := (d.queries[i].adapters + ProofLib.Filter((set_x: string) => !((set_x in d.queries[i].adapters)), [replacementAdapter]))) else d.queries[i])
{
}

lemma handoff_ensures(s: SharedScheduler, oldAdapter: string, replacementAdapter: string)
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysLinksPairIssuedTicksAndQueries(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysAdapterGenerationAgrees(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysActiveTickOwnsSameGenerationQuery(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysCapturedQueryOwnsTick(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysRetiredStorageDrains(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysOwnersKeepTheirRules(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> stepOldTickCannotDetachReplacement(s, "handoff", handoff(s, oldAdapter, replacementAdapter)))
{
  if inv(s) && canHandoff(s, oldAdapter, replacementAdapter) {
    HandoffOwners(s, oldAdapter, replacementAdapter);
    HandoffStorage(s.drain, oldAdapter, replacementAdapter);
    HandoffTicks(s, oldAdapter, replacementAdapter);
  }
}

lemma CloseAdaptersView(d: core__queryDrain_Drain)
  ensures core__queryDrain_closeRetiredAdapters(d).closedAdapters == d.closedAdapters + ProofLib.Filter((set_x: string) => !((set_x in d.closedAdapters)), ProofLib.Filter((adapter: string) => core__queryDrain_canCloseAdapter(d, adapter), d.retiredAdapters))
{
}

lemma closeAdapters_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysLinksPairIssuedTicksAndQueries(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysAdapterGenerationAgrees(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysActiveTickOwnsSameGenerationQuery(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysCapturedQueryOwnsTick(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysRetiredStorageDrains(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysOwnersKeepTheirRules(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> stepOldTickCannotDetachReplacement(s, "closeAdapters", closeAdapters(s)))
{
  if inv(s) && canCloseAdapters(s) {
    var d := s.drain;
    CloseAdaptersView(d);
    forall x | x in closeAdapters(s).drain.closedAdapters
      ensures x in d.retiredAdapters && !core__queryDrain_pendingForAdapter(d, x)
    {
      if x !in d.closedAdapters {
        ProofLib.FilterMember((set_x: string) => !((set_x in d.closedAdapters)), ProofLib.Filter((adapter: string) => core__queryDrain_canCloseAdapter(d, adapter), d.retiredAdapters), x);
        ProofLib.FilterMember((adapter: string) => core__queryDrain_canCloseAdapter(d, adapter), d.retiredAdapters, x);
      }
    }
  }
}

lemma CloseServicesView(d: core__queryDrain_Drain)
  ensures core__queryDrain_closeRetiredServices(d).closedServices == d.closedServices + ProofLib.Filter((set_x: string) => !((set_x in d.closedServices)), ProofLib.Filter((service: string) => core__queryDrain_canCloseService(d, service), d.retiredServices))
{
}

lemma closeServices_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysLinksPairIssuedTicksAndQueries(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysAdapterGenerationAgrees(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysActiveTickOwnsSameGenerationQuery(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysCapturedQueryOwnsTick(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysRetiredStorageDrains(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysOwnersKeepTheirRules(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> stepOldTickCannotDetachReplacement(s, "closeServices", closeServices(s)))
{
  if inv(s) && canCloseServices(s) {
    var d := s.drain;
    CloseServicesView(d);
    forall x | x in closeServices(s).drain.closedServices
      ensures x in d.retiredServices && !core__queryDrain_pendingForService(d, x) && x !in d.busyServices
    {
      if x !in d.closedServices {
        ProofLib.FilterMember((set_x: string) => !((set_x in d.closedServices)), ProofLib.Filter((service: string) => core__queryDrain_canCloseService(d, service), d.retiredServices), x);
        ProofLib.FilterMember((service: string) => core__queryDrain_canCloseService(d, service), d.retiredServices, x);
      }
    }
  }
}

lemma unregisterRuntime_ensures(s: SharedScheduler, agent: string, service: string)
  ensures (inv(s) ==> alwaysLinksPairIssuedTicksAndQueries(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysAdapterGenerationAgrees(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysActiveTickOwnsSameGenerationQuery(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysCapturedQueryOwnsTick(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysRetiredStorageDrains(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysOwnersKeepTheirRules(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> stepOldTickCannotDetachReplacement(s, "unregisterRuntime", unregisterRuntime(s, agent, service)))
{
  if inv(s) {
    var after := unregisterRuntime(s, agent, service);
    assert after.drain.queries == s.drain.queries;
    TicksKeep(s, after);
  }
}

lemma TicksKeep(s: SharedScheduler, t: SharedScheduler)
  requires alwaysCapturedQueryOwnsTick(s) && alwaysActiveTickOwnsSameGenerationQuery(s) && alwaysLinksPairIssuedTicksAndQueries(s)
  requires t.links == s.links && t.process.ticks == s.process.ticks && t.process.serial >= s.process.serial && t.drain.nextQuery >= s.drain.nextQuery
  requires |t.drain.queries| == |s.drain.queries|
  requires forall i :: 0 <= i < |s.drain.queries| ==> t.drain.queries[i].key == s.drain.queries[i].key && t.drain.queries[i].generation == s.drain.queries[i].generation && t.drain.queries[i].phase == s.drain.queries[i].phase
  requires t.process.activeTick == 0 || (t.process.activeTick == s.process.activeTick && t.process.generation == s.process.generation)
  ensures alwaysCapturedQueryOwnsTick(t) && alwaysActiveTickOwnsSameGenerationQuery(t) && alwaysLinksPairIssuedTicksAndQueries(t)
{
  forall q | q in t.drain.queries
    ensures exists l :: l in t.links && l.query == q.key && exists tick :: tick in t.process.ticks && tick.id == l.tick && tick.generation == q.generation && tick.completed == q.phase.Done?
  {
    var i :| 0 <= i < |t.drain.queries| && t.drain.queries[i] == q;
    assert s.drain.queries[i] in s.drain.queries;
  }
  if t.process.activeTick != 0 {
    assert activeLink(t) == activeLink(s);
  }
}

lemma StorageKeep(d: core__queryDrain_Drain, e: core__queryDrain_Drain)
  requires core__queryDrain_alwaysClosedServicesHaveNoQueries(d) && core__queryDrain_alwaysClosedAdaptersHaveNoQueries(d) && core__queryDrain_alwaysStopReceiptDrainedItsSnapshot(d)
  requires e.queries == d.queries && e.closedServices == d.closedServices && e.closedAdapters == d.closedAdapters && e.busyServices == d.busyServices
  requires e.stopReturned ==> d.stopReturned && e.stopWaiting == d.stopWaiting
  ensures core__queryDrain_alwaysClosedServicesHaveNoQueries(e) && core__queryDrain_alwaysClosedAdaptersHaveNoQueries(e) && core__queryDrain_alwaysStopReceiptDrainedItsSnapshot(e)
{
  assert forall x :: core__queryDrain_pendingForService(e, x) == core__queryDrain_pendingForService(d, x);
  assert forall x :: core__queryDrain_pendingForAdapter(e, x) == core__queryDrain_pendingForAdapter(d, x);
}

lemma HandoffStorage(d: core__queryDrain_Drain, oldAdapter: string, replacementAdapter: string)
  requires core__queryDrain_alwaysClosedServicesHaveNoQueries(d) && core__queryDrain_alwaysClosedAdaptersHaveNoQueries(d) && core__queryDrain_alwaysStopReceiptDrainedItsSnapshot(d)
  requires core__queryDrain_canHandoff(d, oldAdapter, replacementAdapter)
  ensures core__queryDrain_alwaysClosedServicesHaveNoQueries(core__queryDrain_handoff(d, oldAdapter, replacementAdapter))
  ensures core__queryDrain_alwaysClosedAdaptersHaveNoQueries(core__queryDrain_handoff(d, oldAdapter, replacementAdapter))
  ensures core__queryDrain_alwaysStopReceiptDrainedItsSnapshot(core__queryDrain_handoff(d, oldAdapter, replacementAdapter))
{
  var e := core__queryDrain_handoff(d, oldAdapter, replacementAdapter);
  HandoffView(d, oldAdapter, replacementAdapter);
  forall x | x in e.closedAdapters
    ensures !core__queryDrain_pendingForAdapter(e, x)
  {
    if core__queryDrain_pendingForAdapter(e, x) {
      var q :| q in e.queries && q.phase.Querying? && x in q.adapters;
      var i :| 0 <= i < |e.queries| && e.queries[i] == q;
      assert d.queries[i] in d.queries;
      if x !in d.queries[i].adapters {
        ProofLib.FilterMember((set_x: string) => !((set_x in d.queries[i].adapters)), [replacementAdapter], x);
      }
    }
  }
  forall x | x in e.closedServices
    ensures !core__queryDrain_pendingForService(e, x)
  {
    if core__queryDrain_pendingForService(e, x) {
      var q :| q in e.queries && q.phase.Querying? && exists entry :: entry in q.captured && entry.service == x;
      var i :| 0 <= i < |e.queries| && e.queries[i] == q;
      assert d.queries[i] in d.queries;
    }
  }
  if e.stopReturned {
    forall q | q in e.queries && q.key in e.stopWaiting
      ensures !q.phase.Querying?
    {
      var i :| 0 <= i < |e.queries| && e.queries[i] == q;
      assert d.queries[i] in d.queries;
    }
  }
}

lemma FireCaptureTicks(s: SharedScheduler)
  requires inv(s) && canFire(s) && attachedTickMayCapture(s) && core__queryDrain_canBeginQuery(s.drain)
  ensures alwaysCapturedQueryOwnsTick(fire(s)) && alwaysActiveTickOwnsSameGenerationQuery(fire(s)) && alwaysLinksPairIssuedTicksAndQueries(fire(s))
{
  var p := s.process;
  var d := s.drain;
  var p1 := core__processScheduler_tick(p);
  var d1 := core__queryDrain_beginQuery(d);
  var made := TickQueryLink(p.serial, d.nextQuery);
  var after := fire(s);
  KeysAligned(d);
  assert p1.activeTick == p.serial && p1.serial == p.serial + 1 && p1.generation == p.generation;
  assert p1.ticks == p.ticks + [core__processScheduler_TickEntry(p.serial, p.generation, false)];
  assert after == s.(process := p1, drain := d1, links := s.links + [made]);
  assert d1.queries == d.queries + [d1.queries[|d.queries|]] && d1.queries[|d.queries|].key == d.nextQuery;
  forall q | q in d1.queries
    ensures exists l :: l in after.links && l.query == q.key && exists tick :: tick in p1.ticks && tick.id == l.tick && tick.generation == q.generation && tick.completed == q.phase.Done?
  {
    if q in d.queries {
      var l :| l in s.links && l.query == q.key && exists tick :: tick in p.ticks && tick.id == l.tick && tick.generation == q.generation && tick.completed == q.phase.Done?;
      assert l in after.links;
    } else {
      assert made in after.links;
      assert p1.ticks[|p.ticks|] in p1.ticks;
    }
  }
  forall l | l in after.links
    ensures l.tick > 0 && l.tick < p1.serial && l.query < d1.nextQuery && forall other :: other in after.links ==> ((other.tick == l.tick) == (other.query == l.query))
  {
  }
  forall i | 0 <= i < |s.links|
    ensures s.links[i].tick != p.serial
  {
    assert s.links[i] in s.links;
  }
  LinkAtView(after, p.serial);
  ProofLib.FilterAppend((link: TickQueryLink) => (link.tick == p.serial), s.links, made);
  ProofLib.FilterNone((link: TickQueryLink) => (link.tick == p.serial), s.links);
  assert activeLink(after) == made;
  assert core__queryDrain_queryFor(d1, made.query) == d1.queries[|d.queries|];
}

lemma FireCaptureDrain(s: SharedScheduler)
  requires inv(s) && core__queryDrain_canBeginQuery(s.drain)
  ensures alwaysRetiredStorageDrains(fire(s).(drain := core__queryDrain_beginQuery(s.drain)))
  ensures core__queryDrain_alwaysQueryKeysUnique(core__queryDrain_beginQuery(s.drain)) && core__queryDrain_alwaysStopSnapshotUsesIssuedKeys(core__queryDrain_beginQuery(s.drain))
  ensures core__queryDrain_alwaysActiveAdapterIsOpen(core__queryDrain_beginQuery(s.drain)) && core__queryDrain_alwaysCloseRequiresRetirement(core__queryDrain_beginQuery(s.drain))
{
  var d := s.drain;
  var d1 := core__queryDrain_beginQuery(d);
  KeysAligned(d);
  KeysFromAligned(d1);
  CapturedNotRetired(d);
  assert d.nextQuery !in d.stopWaiting;
  var q := d1.queries[|d.queries|];
  assert d1.queries == d.queries + [q];
  forall x | x in d1.closedServices
    ensures !core__queryDrain_pendingForService(d1, x) && x !in d1.busyServices
  {
    assert x in d.retiredServices;
    assert !core__queryDrain_pendingForService(d, x);
  }
  forall x | x in d1.closedAdapters
    ensures !core__queryDrain_pendingForAdapter(d1, x)
  {
    assert !core__queryDrain_pendingForAdapter(d, x);
  }
}

lemma FireEmpty(s: SharedScheduler)
  requires inv(s) && canFire(s) && attachedTickMayCapture(s) && !core__queryDrain_canBeginQuery(s.drain)
  ensures inv(fire(s))
{
  var p := s.process;
  var p1 := core__processScheduler_tick(p);
  var p2 := core__processScheduler_finishTick(p1, p1.activeTick);
  var after := fire(s);
  core__processScheduler_tick_ensures(p);
  assert p1.activeTick == p.serial && p1.serial == p.serial + 1 && p1.generation == p.generation;
  assert p1.ticks == p.ticks + [core__processScheduler_TickEntry(p.serial, p.generation, false)];
  assert p1.ticks[|p.ticks|] in p1.ticks;
  core__processScheduler_finishTick_ensures(p1, p1.activeTick);
  assert after.process == p2 && after.links == s.links && after.drain.queries == s.drain.queries && after.drain.nextQuery == s.drain.nextQuery;
  forall j | 0 <= j < |p.ticks|
    ensures p2.ticks[j] == p.ticks[j]
  {
    assert p.ticks[j] in p.ticks;
  }
  forall q | q in after.drain.queries
    ensures exists l :: l in after.links && l.query == q.key && exists tick :: tick in p2.ticks && tick.id == l.tick && tick.generation == q.generation && tick.completed == q.phase.Done?
  {
    var l :| l in s.links && l.query == q.key && exists tick :: tick in p.ticks && tick.id == l.tick && tick.generation == q.generation && tick.completed == q.phase.Done?;
    var t :| t in p.ticks && t.id == l.tick && t.generation == q.generation && t.completed == q.phase.Done?;
    var j :| 0 <= j < |p.ticks| && p.ticks[j] == t;
    assert p2.ticks[j] in p2.ticks;
  }
  StorageKeep(s.drain, after.drain);
}

lemma Settle(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires alwaysCapturedQueryOwnsTick(s) && alwaysLinksPairIssuedTicksAndQueries(s)
  requires s.drain.nextQuery == |s.drain.queries| + 1 && forall i :: 0 <= i < |s.drain.queries| ==> s.drain.queries[i].key == i + 1
  requires 1 <= key <= |s.drain.queries| && (s.drain.queries[key - 1].phase.Querying? || s.drain.queries[key - 1].phase.Ready? || s.drain.queries[key - 1].phase.Running?)
  ensures 0 < |ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)|
  ensures var link := ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0];
    link in s.links && link.query == key && core__processScheduler_canFinishTick(s.process, link.tick) &&
    advanceQuery(s, key, succeeded, resultRows) == s.(drain := core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows), process := if core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows).queries[key - 1].phase.Done? then core__processScheduler_finishTick(s.process, link.tick) else s.process)
{
  var d := s.drain;
  DrainAdvance(d, key, succeeded, resultRows);
  AdvanceView(s, key, succeeded, resultRows);
  var qk := d.queries[key - 1];
  assert qk in d.queries;
  var lk :| lk in s.links && lk.query == qk.key && exists tick :: tick in s.process.ticks && tick.id == lk.tick && tick.generation == qk.generation && tick.completed == qk.phase.Done?;
  LinkWithQuery(s.links, key, lk);
  var link := ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0];
  assert link.tick == lk.tick;
  assert core__queryDrain_queryFor(core__queryDrain_advanceQuery(d, key, succeeded, resultRows), link.query) == core__queryDrain_advanceQuery(d, key, succeeded, resultRows).queries[key - 1];
}

lemma AdvanceTicks(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires alwaysCapturedQueryOwnsTick(s) && alwaysLinksPairIssuedTicksAndQueries(s)
  requires s.drain.nextQuery == |s.drain.queries| + 1 && forall i :: 0 <= i < |s.drain.queries| ==> s.drain.queries[i].key == i + 1
  requires 1 <= key <= |s.drain.queries| && (s.drain.queries[key - 1].phase.Querying? || s.drain.queries[key - 1].phase.Ready? || s.drain.queries[key - 1].phase.Running?)
  ensures alwaysCapturedQueryOwnsTick(advanceQuery(s, key, succeeded, resultRows)) && alwaysLinksPairIssuedTicksAndQueries(advanceQuery(s, key, succeeded, resultRows))
{
  var p := s.process;
  var d := s.drain;
  var e := core__queryDrain_advanceQuery(d, key, succeeded, resultRows);
  DrainAdvance(d, key, succeeded, resultRows);
  Settle(s, key, succeeded, resultRows);
  var link := ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0];
  var after := advanceQuery(s, key, succeeded, resultRows);
  var p2 := after.process;
  var settles := e.queries[key - 1].phase.Done?;
  assert |p2.ticks| == |p.ticks| && p2.serial == p.serial;
  assert forall j :: 0 <= j < |p.ticks| ==> p2.ticks[j].id == p.ticks[j].id && p2.ticks[j].generation == p.ticks[j].generation && (p.ticks[j].id != link.tick ==> p2.ticks[j] == p.ticks[j]) && (settles && p.ticks[j].id == link.tick ==> p2.ticks[j].completed);
  forall q | q in e.queries
    ensures exists l :: l in after.links && l.query == q.key && exists tick :: tick in p2.ticks && tick.id == l.tick && tick.generation == q.generation && tick.completed == q.phase.Done?
  {
    var i :| 0 <= i < |e.queries| && e.queries[i] == q;
    var q0 := d.queries[i];
    assert q0 in d.queries;
    var l :| l in s.links && l.query == q0.key && exists tick :: tick in p.ticks && tick.id == l.tick && tick.generation == q0.generation && tick.completed == q0.phase.Done?;
    var t :| t in p.ticks && t.id == l.tick && t.generation == q0.generation && t.completed == q0.phase.Done?;
    var j :| 0 <= j < |p.ticks| && p.ticks[j] == t;
    assert p2.ticks[j] in p2.ticks;
    assert (l.tick == link.tick) == (i == key - 1);
  }
}

lemma AdvanceActive(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires alwaysCapturedQueryOwnsTick(s) && alwaysLinksPairIssuedTicksAndQueries(s) && alwaysActiveTickOwnsSameGenerationQuery(s)
  requires s.drain.nextQuery == |s.drain.queries| + 1 && forall i :: 0 <= i < |s.drain.queries| ==> s.drain.queries[i].key == i + 1
  requires 1 <= key <= |s.drain.queries| && (s.drain.queries[key - 1].phase.Querying? || s.drain.queries[key - 1].phase.Ready? || s.drain.queries[key - 1].phase.Running?)
  ensures alwaysActiveTickOwnsSameGenerationQuery(advanceQuery(s, key, succeeded, resultRows))
  ensures stepOldTickCannotDetachReplacement(s, "advanceQuery", advanceQuery(s, key, succeeded, resultRows))
  ensures stepOldTickCannotDetachReplacement(s, "advance", advanceQuery(s, key, succeeded, resultRows))
{
  var p := s.process;
  var d := s.drain;
  var e := core__queryDrain_advanceQuery(d, key, succeeded, resultRows);
  DrainAdvance(d, key, succeeded, resultRows);
  Settle(s, key, succeeded, resultRows);
  var link := ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0];
  var after := advanceQuery(s, key, succeeded, resultRows);
  assert after.process.generation == p.generation && after.links == s.links;
  assert after.process.activeTick == (if e.queries[key - 1].phase.Done? && p.activeTick == link.tick then 0 else p.activeTick);
  if p.activeTick != 0 {
    var a := activeLink(s);
    ActiveLinkIn(s);
    assert (a.query == key) == (a.tick == link.tick);
    if after.process.activeTick != 0 {
      assert activeLink(after) == a;
      if a.query != key {
        assert core__queryDrain_queryFor(e, a.query) == core__queryDrain_queryFor(d, a.query);
      }
    }
  }
}

lemma ActiveLinkIn(s: SharedScheduler)
  requires alwaysActiveTickOwnsSameGenerationQuery(s) && s.process.activeTick != 0
  ensures activeLink(s) in s.links && activeLink(s).tick == s.process.activeTick
{
  LinkAtView(s, s.process.activeTick);
  ProofLib.FilterMember((link: TickQueryLink) => (link.tick == s.process.activeTick), s.links, ProofLib.Filter((link: TickQueryLink) => (link.tick == s.process.activeTick), s.links)[0]);
}

lemma HandoffOwners(s: SharedScheduler, oldAdapter: string, replacementAdapter: string)
  requires alwaysOwnersKeepTheirRules(s) && alwaysAdapterGenerationAgrees(s) && canHandoff(s, oldAdapter, replacementAdapter)
  ensures alwaysOwnersKeepTheirRules(handoff(s, oldAdapter, replacementAdapter))
{
  core__processScheduler_startAdapter_ensures(s.process, replacementAdapter);
  var d := s.drain;
  var e := core__queryDrain_handoff(d, oldAdapter, replacementAdapter);
  KeysAligned(d);
  HandoffView(d, oldAdapter, replacementAdapter);
  assert forall i :: 0 <= i < |d.queries| ==> e.queries[i].key == d.queries[i].key;
  KeysFromAligned(e);
  ProofLib.FilterMember((set_x: string) => !((set_x in d.retiredAdapters)), [oldAdapter], e.activeAdapter);
}

lemma RetireOwners(s: SharedScheduler, adapter: string)
  requires alwaysOwnersKeepTheirRules(s) && alwaysAdapterGenerationAgrees(s)
  ensures alwaysOwnersKeepTheirRules(retireAdapter(s, adapter))
{
  core__processScheduler_detachAdapter_ensures(s.process);
  var d := s.drain;
  RetiredView(d, adapter);
  if d.activeAdapter != adapter {
    ProofLib.FilterMember((set_x: string) => !((set_x in d.retiredAdapters)), [adapter], d.activeAdapter);
  }
}

lemma StopOwners(s: SharedScheduler)
  requires alwaysOwnersKeepTheirRules(s)
  ensures alwaysOwnersKeepTheirRules(stop(s))
{
  core__processScheduler_detachAdapter_ensures(s.process);
  var d := s.drain;
  var e := stop(s).drain;
  KeysAligned(d);
  StopView(d);
  ProofLib.FilterSubset((query: core__queryDrain_Query) => query.phase.Querying?, d.queries);
  forall k | k in e.stopWaiting
    ensures k > 0 && k < e.nextQuery
  {
    var i :| 0 <= i < |e.stopWaiting| && e.stopWaiting[i] == k;
    var q := ProofLib.Filter((query: core__queryDrain_Query) => query.phase.Querying?, d.queries)[i];
    var j :| 0 <= j < |d.queries| && d.queries[j] == q;
  }
}

lemma HandoffTicks(s: SharedScheduler, oldAdapter: string, replacementAdapter: string)
  requires alwaysCapturedQueryOwnsTick(s) && alwaysActiveTickOwnsSameGenerationQuery(s) && alwaysLinksPairIssuedTicksAndQueries(s)
  ensures alwaysCapturedQueryOwnsTick(handoff(s, oldAdapter, replacementAdapter)) && alwaysActiveTickOwnsSameGenerationQuery(handoff(s, oldAdapter, replacementAdapter)) && alwaysLinksPairIssuedTicksAndQueries(handoff(s, oldAdapter, replacementAdapter))
{
  var d := s.drain;
  var after := handoff(s, oldAdapter, replacementAdapter);
  HandoffView(d, oldAdapter, replacementAdapter);
  assert forall i :: 0 <= i < |d.queries| ==> after.drain.queries[i].key == d.queries[i].key && after.drain.queries[i].phase == d.queries[i].phase && after.drain.queries[i].generation == d.queries[i].generation;
  TicksKeep(s, after);
}
