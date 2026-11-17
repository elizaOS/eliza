lemma IdentityAt(xs: seq<core__accountValues_AccountValue>, account: core__accountValues_AccountValue, i: int)
  requires 0 <= i < |xs| && xs[i] == account
  ensures |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> (xs[j].provider, xs[j].id) != (account.provider, account.id)
{
  ProofLib.FilterCountOneIffUnique((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), xs, (a: core__accountValues_AccountValue) => (a.provider, a.id), i);
}

lemma IdentityFilter(st: core__connectorStorage_ConnectorStore)
  ensures core__connectorStorage_alwaysAccountIdentityUnique(st) == !((exists account :: account in st.accounts && !((|ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), st.accounts)| == 1))))
{
}

lemma IdentityUnique(st: core__connectorStorage_ConnectorStore)
  ensures core__connectorStorage_alwaysAccountIdentityUnique(st) <==> ProofLib.DistinctBy(st.accounts, (a: core__accountValues_AccountValue) => (a.provider, a.id))
{
  IdentityFilter(st);
  var xs := st.accounts;
  if core__connectorStorage_alwaysAccountIdentityUnique(st) {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures (xs[i].provider, xs[i].id) != (xs[j].provider, xs[j].id)
    {
      assert xs[i] in xs;
      IdentityAt(xs, xs[i], i);
    }
  }
  if ProofLib.DistinctBy(xs, (a: core__accountValues_AccountValue) => (a.provider, a.id)) {
    forall account | account in xs
      ensures |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == account;
      IdentityAt(xs, account, i);
    }
  }
}

lemma Upsert(st: core__connectorStorage_ConnectorStore, account: core__accountValues_AccountValue)
  ensures account in core__connectorStorage_upsertAccount(st, account).accounts
  ensures forall x :: x in st.accounts && (x.provider, x.id) != (account.provider, account.id) ==> x in core__connectorStorage_upsertAccount(st, account).accounts
  ensures ProofLib.DistinctBy(st.accounts, (a: core__accountValues_AccountValue) => (a.provider, a.id)) ==> ProofLib.DistinctBy(core__connectorStorage_upsertAccount(st, account).accounts, (a: core__accountValues_AccountValue) => (a.provider, a.id))
{
  var after := core__connectorStorage_upsertAccount(st, account).accounts;
  if exists prior :: prior in st.accounts && ((prior.provider == account.provider) && (prior.id == account.id)) {
    var prior :| prior in st.accounts && ((prior.provider == account.provider) && (prior.id == account.id));
    var k :| 0 <= k < |st.accounts| && st.accounts[k] == prior;
    assert after[k] == account;
    forall x | x in st.accounts && (x.provider, x.id) != (account.provider, account.id)
      ensures x in after
    {
      var i :| 0 <= i < |st.accounts| && st.accounts[i] == x;
      assert after[i] == x;
    }
    assert forall i :: 0 <= i < |after| ==> (after[i].provider, after[i].id) == (st.accounts[i].provider, st.accounts[i].id);
  } else {
    assert after == st.accounts + [account];
    if ProofLib.DistinctBy(st.accounts, (a: core__accountValues_AccountValue) => (a.provider, a.id)) {
      ProofLib.DistinctByConcat(st.accounts, [account], (a: core__accountValues_AccountValue) => (a.provider, a.id));
    }
  }
}

lemma FirstPrefix(count: int, xs: seq<core__accountValues_AccountValue>, i: int)
  requires 0 <= i <= |xs| && 0 <= count
  ensures Std.Collections.Seq.FoldLeft((done: seq<core__accountValues_AccountValue>, account: core__accountValues_AccountValue) => (if (|done| < count) then (done + [account]) else done), [], xs[..i]) == xs[..(if i < count then i else count)]
  decreases i
{
  if i > 0 {
    FirstPrefix(count, xs, i - 1);
    assert xs[..i] == xs[..i - 1] + [xs[i - 1]];
    ProofLib.FoldLeftAppend((done: seq<core__accountValues_AccountValue>, account: core__accountValues_AccountValue) => (if (|done| < count) then (done + [account]) else done), [], xs[..i - 1], xs[i - 1]);
  }
}

lemma Copied(s: Handoff)
  requires 0 <= s.accountIndex <= |s.accountSnapshot|
  ensures copiedAccounts(s) == s.accountSnapshot[..s.accountIndex]
{
  FirstPrefix(s.accountIndex, s.accountSnapshot, |s.accountSnapshot|);
  assert s.accountSnapshot[..|s.accountSnapshot|] == s.accountSnapshot;
}

lemma QueueFinish(s: Handoff, success: bool)
  requires alwaysQueueSerializesHandoff(s) && !s.phase.HandoffIdle?
  ensures core__connectorQueues_alwaysOneRunningPerScope(core__connectorQueues_finish(s.queue, s.activeTicket, success)) && core__connectorQueues_alwaysStartedAfterPredecessors(core__connectorQueues_finish(s.queue, s.activeTicket, success)) && core__connectorQueues_alwaysAllocatedTickets(core__connectorQueues_finish(s.queue, s.activeTicket, success)) && core__connectorQueues_alwaysCompletedEntrySettled(core__connectorQueues_finish(s.queue, s.activeTicket, success))
{
  var entry :| entry in s.queue.entries && ((entry.ticket == s.activeTicket) && entry.running);
  assert core__connectorQueues_canFinish(s.queue, s.activeTicket);
  core__connectorQueues_finish_ensures(s.queue, s.activeTicket, success);
}

lemma QueueBegin(s: Handoff, ticket: int, service: int, adapter: int, hasRuntime: bool, methods: core__oauth__bridge_AdapterMethods)
  requires alwaysQueueSerializesHandoff(s) && canBeginOperation(s, ticket, service, adapter)
  ensures alwaysQueueSerializesHandoff(beginOperation(s, ticket, service, adapter, hasRuntime, methods))
{
  core__connectorQueues_begin_ensures(s.queue, ticket);
  var entry :| entry in s.queue.entries && ((((entry.ticket == ticket) && !(entry.running)) && !(entry.complete)) && !((exists prior :: prior in s.queue.entries && !((((prior.scope != entry.scope) || (prior.ticket >= entry.ticket)) || prior.complete)))));
  var i :| 0 <= i < |s.queue.entries| && s.queue.entries[i] == entry;
  var after := beginOperation(s, ticket, service, adapter, hasRuntime, methods);
  assert after.queue.entries[i].ticket == ticket && after.queue.entries[i].running;
  assert after.queue.entries[i] in after.queue.entries;
}

lemma CopiedOnBegin(s: Handoff, ticket: int, service: int, adapter: int, hasRuntime: bool, methods: core__oauth__bridge_AdapterMethods)
  ensures copiedAccounts(beginOperation(s, ticket, service, adapter, hasRuntime, methods)) == []
{
  Copied(beginOperation(s, ticket, service, adapter, hasRuntime, methods));
}

lemma enqueue_ensures(s: Handoff, manager: string)
  ensures (inv(s) ==> alwaysDurableOperationSeesNoBootAccounts(enqueue(s, manager)))
  ensures (inv(s) ==> alwaysCopiedAccountsReachTheTarget(enqueue(s, manager)))
  ensures (inv(s) ==> alwaysAllocatedIdentitiesAreValid(enqueue(s, manager)))
  ensures (inv(s) ==> alwaysQueueSerializesHandoff(enqueue(s, manager)))
  ensures (inv(s) ==> alwaysSnapshotCursorsBounded(enqueue(s, manager)))
  ensures (inv(s) ==> stepFacadeNeverChanges(s, enqueue(s, manager)))
  ensures (inv(s) ==> stepFallbackNeverChanges(s, enqueue(s, manager)))
  ensures (inv(s) ==> stepWarningIsSticky(s, enqueue(s, manager)))
  ensures (inv(s) ==> stepOperationUsesResolvedBackend(s, "enqueue", enqueue(s, manager)))
  ensures (inv(s) ==> stepFailureRetainsFallback(s, "enqueue", enqueue(s, manager)))
  ensures (inv(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "enqueue", enqueue(s, manager)))
  ensures (inv(s) ==> stepClearRetainsEveryCopiedAccount(s, "enqueue", enqueue(s, manager)))
{
  if inv(s) {
    core__connectorQueues_admit_ensures(s.queue, core__connectorQueues_QueueScope(manager, "storage"));
    if !(s.phase.HandoffIdle?) {
      var entry :| entry in s.queue.entries && ((entry.ticket == s.activeTicket) && entry.running);
      assert entry in enqueue(s, manager).queue.entries;
    }
    Copied(s);
    Copied(enqueue(s, manager));
  }
}

lemma beginOperation_ensures(s: Handoff, ticket: int, service: int, adapter: int, hasRuntime: bool, methods: core__oauth__bridge_AdapterMethods)
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> alwaysDurableOperationSeesNoBootAccounts(beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> alwaysCopiedAccountsReachTheTarget(beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> alwaysAllocatedIdentitiesAreValid(beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> alwaysQueueSerializesHandoff(beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> alwaysSnapshotCursorsBounded(beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> stepFacadeNeverChanges(s, beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> stepFallbackNeverChanges(s, beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> stepWarningIsSticky(s, beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> stepOperationUsesResolvedBackend(s, "beginOperation", beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> stepFailureRetainsFallback(s, "beginOperation", beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "beginOperation", beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, service, adapter) ==> stepClearRetainsEveryCopiedAccount(s, "beginOperation", beginOperation(s, ticket, service, adapter, hasRuntime, methods)))
{
  if inv(s) && canBeginOperation(s, ticket, service, adapter) {
    QueueBegin(s, ticket, service, adapter, hasRuntime, methods);
    CopiedOnBegin(s, ticket, service, adapter, hasRuntime, methods);
  }
}

lemma beginNextOperation_ensures(s: Handoff, service: int, adapter: int, hasRuntime: bool, methods: core__oauth__bridge_AdapterMethods)
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> alwaysDurableOperationSeesNoBootAccounts(beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> alwaysCopiedAccountsReachTheTarget(beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> alwaysAllocatedIdentitiesAreValid(beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> alwaysQueueSerializesHandoff(beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> alwaysSnapshotCursorsBounded(beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> stepFacadeNeverChanges(s, beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> stepFallbackNeverChanges(s, beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> stepWarningIsSticky(s, beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> stepOperationUsesResolvedBackend(s, "beginNextOperation", beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> stepFailureRetainsFallback(s, "beginNextOperation", beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "beginNextOperation", beginNextOperation(s, service, adapter, hasRuntime, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, service, adapter) ==> stepClearRetainsEveryCopiedAccount(s, "beginNextOperation", beginNextOperation(s, service, adapter, hasRuntime, methods)))
{
  if inv(s) && canBeginNextOperation(s, service, adapter) {
    QueueBegin(s, core__connectorQueues_firstEligible(s.queue), service, adapter, hasRuntime, methods);
    CopiedOnBegin(s, core__connectorQueues_firstEligible(s.queue), service, adapter, hasRuntime, methods);
  }
}

lemma finishBridgeCreate_ensures(s: Handoff)
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysDurableOperationSeesNoBootAccounts(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysCopiedAccountsReachTheTarget(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysAllocatedIdentitiesAreValid(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysQueueSerializesHandoff(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysSnapshotCursorsBounded(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepFacadeNeverChanges(s, finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepFallbackNeverChanges(s, finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepWarningIsSticky(s, finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepOperationUsesResolvedBackend(s, "finishBridgeCreate", finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepFailureRetainsFallback(s, "finishBridgeCreate", finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "finishBridgeCreate", finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepClearRetainsEveryCopiedAccount(s, "finishBridgeCreate", finishBridgeCreate(s)))
{
  if inv(s) && canFinishBridgeCreate(s) {
    QueueFinish(s, false);
    Copied(s);
    Copied(finishBridgeCreate(s));
  }
}

lemma finishBridgeConsumption_ensures(s: Handoff)
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysDurableOperationSeesNoBootAccounts(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysCopiedAccountsReachTheTarget(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysAllocatedIdentitiesAreValid(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysQueueSerializesHandoff(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysSnapshotCursorsBounded(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepFacadeNeverChanges(s, finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepFallbackNeverChanges(s, finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepWarningIsSticky(s, finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepOperationUsesResolvedBackend(s, "finishBridgeConsumption", finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepFailureRetainsFallback(s, "finishBridgeConsumption", finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "finishBridgeConsumption", finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepClearRetainsEveryCopiedAccount(s, "finishBridgeConsumption", finishBridgeConsumption(s)))
{
  if inv(s) && canFinishBridgeConsumption(s) {
    QueueFinish(s, false);
    Copied(s);
    Copied(finishBridgeConsumption(s));
  }
}

lemma transferFails_ensures(s: Handoff)
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysDurableOperationSeesNoBootAccounts(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysCopiedAccountsReachTheTarget(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysAllocatedIdentitiesAreValid(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysQueueSerializesHandoff(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysSnapshotCursorsBounded(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepFacadeNeverChanges(s, transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepFallbackNeverChanges(s, transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepWarningIsSticky(s, transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepOperationUsesResolvedBackend(s, "transferFails", transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepFailureRetainsFallback(s, "transferFails", transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "transferFails", transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepClearRetainsEveryCopiedAccount(s, "transferFails", transferFails(s)))
{
  if inv(s) && canTransferFails(s) {
    QueueFinish(s, false);
    Copied(s);
    Copied(transferFails(s));
  }
}

lemma finishOperation_ensures(s: Handoff, success: bool)
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysDurableOperationSeesNoBootAccounts(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysCopiedAccountsReachTheTarget(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysAllocatedIdentitiesAreValid(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysQueueSerializesHandoff(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysSnapshotCursorsBounded(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepFacadeNeverChanges(s, finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepFallbackNeverChanges(s, finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepWarningIsSticky(s, finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepOperationUsesResolvedBackend(s, "finishOperation", finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepFailureRetainsFallback(s, "finishOperation", finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "finishOperation", finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepClearRetainsEveryCopiedAccount(s, "finishOperation", finishOperation(s, success)))
{
  if inv(s) && canFinishOperation(s) {
    QueueFinish(s, success);
  }
}

lemma copyAccount_ensures(s: Handoff)
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysDurableOperationSeesNoBootAccounts(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysCopiedAccountsReachTheTarget(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysAllocatedIdentitiesAreValid(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysQueueSerializesHandoff(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysSnapshotCursorsBounded(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepFacadeNeverChanges(s, copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepFallbackNeverChanges(s, copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepWarningIsSticky(s, copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepOperationUsesResolvedBackend(s, "copyAccount", copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepFailureRetainsFallback(s, "copyAccount", copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "copyAccount", copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepClearRetainsEveryCopiedAccount(s, "copyAccount", copyAccount(s)))
{
  if inv(s) && canCopyAccount(s) {
    var after := copyAccount(s);
    var account := s.accountSnapshot[s.accountIndex];
    Copied(s);
    Copied(after);
    IdentityUnique(s.fallback);
    Upsert(targetStore(s), account);
    assert targetStore(after).accounts == core__connectorStorage_upsertAccount(targetStore(s), account).accounts;
    assert after.accountSnapshot[..after.accountIndex] == s.accountSnapshot[..s.accountIndex] + [account];
    forall x | x in s.accountSnapshot[..s.accountIndex]
      ensures x in targetStore(after).accounts
    {
      var j :| 0 <= j < s.accountIndex && s.accountSnapshot[j] == x;
      assert (x.provider, x.id) != (account.provider, account.id);
    }
  }
}

lemma writeFallbackAccount_ensures(s: Handoff, account: core__accountValues_AccountValue)
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysDurableOperationSeesNoBootAccounts(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysCopiedAccountsReachTheTarget(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysAllocatedIdentitiesAreValid(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysQueueSerializesHandoff(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysSnapshotCursorsBounded(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepFacadeNeverChanges(s, writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepFallbackNeverChanges(s, writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepWarningIsSticky(s, writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepOperationUsesResolvedBackend(s, "writeFallbackAccount", writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepFailureRetainsFallback(s, "writeFallbackAccount", writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "writeFallbackAccount", writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepClearRetainsEveryCopiedAccount(s, "writeFallbackAccount", writeFallbackAccount(s, account)))
{
  if inv(s) && canWriteFallbackAccount(s, account) {
    IdentityUnique(s.fallback);
    IdentityUnique(writeFallbackAccount(s, account).fallback);
    Upsert(s.fallback, account);
  }
}

lemma finishTransfer_ensures(s: Handoff)
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysDurableOperationSeesNoBootAccounts(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysCopiedAccountsReachTheTarget(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysAllocatedIdentitiesAreValid(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysQueueSerializesHandoff(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysSnapshotCursorsBounded(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepFacadeNeverChanges(s, finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepFallbackNeverChanges(s, finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepWarningIsSticky(s, finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepOperationUsesResolvedBackend(s, "finishTransfer", finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepFailureRetainsFallback(s, "finishTransfer", finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "finishTransfer", finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepClearRetainsEveryCopiedAccount(s, "finishTransfer", finishTransfer(s)))
{
  if inv(s) && canFinishTransfer(s) {
    Copied(s);
    assert s.accountSnapshot[..s.accountIndex] == s.accountSnapshot;
    assert targetStore(finishTransfer(s)) == targetStore(s);
  }
}

lemma nextPhase_ensures(s: Handoff)
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysDurableOperationSeesNoBootAccounts(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysCopiedAccountsReachTheTarget(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysAllocatedIdentitiesAreValid(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysQueueSerializesHandoff(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysSnapshotCursorsBounded(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepFacadeNeverChanges(s, nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepFallbackNeverChanges(s, nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepWarningIsSticky(s, nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepOperationUsesResolvedBackend(s, "nextPhase", nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepFailureRetainsFallback(s, "nextPhase", nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "nextPhase", nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepClearRetainsEveryCopiedAccount(s, "nextPhase", nextPhase(s)))
{
  if inv(s) && canNextPhase(s) {
    Copied(s);
    Copied(nextPhase(s));
  }
}

lemma copyFlow_ensures(s: Handoff)
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysDurableOperationSeesNoBootAccounts(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysCopiedAccountsReachTheTarget(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysAllocatedIdentitiesAreValid(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysQueueSerializesHandoff(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysSnapshotCursorsBounded(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepFacadeNeverChanges(s, copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepFallbackNeverChanges(s, copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepWarningIsSticky(s, copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepOperationUsesResolvedBackend(s, "copyFlow", copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepFailureRetainsFallback(s, "copyFlow", copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "copyFlow", copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepClearRetainsEveryCopiedAccount(s, "copyFlow", copyFlow(s)))
{
  if inv(s) && canCopyFlow(s) {
    Copied(s);
    Copied(copyFlow(s));
  }
}

lemma getFacade_ensures(s: Handoff)
  ensures (inv(s) ==> alwaysDurableOperationSeesNoBootAccounts(getFacade(s)))
  ensures (inv(s) ==> alwaysCopiedAccountsReachTheTarget(getFacade(s)))
  ensures (inv(s) ==> alwaysAllocatedIdentitiesAreValid(getFacade(s)))
  ensures (inv(s) ==> alwaysQueueSerializesHandoff(getFacade(s)))
  ensures (inv(s) ==> alwaysSnapshotCursorsBounded(getFacade(s)))
  ensures (inv(s) ==> stepFacadeNeverChanges(s, getFacade(s)))
  ensures (inv(s) ==> stepFallbackNeverChanges(s, getFacade(s)))
  ensures (inv(s) ==> stepWarningIsSticky(s, getFacade(s)))
  ensures (inv(s) ==> stepOperationUsesResolvedBackend(s, "getFacade", getFacade(s)))
  ensures (inv(s) ==> stepFailureRetainsFallback(s, "getFacade", getFacade(s)))
  ensures (inv(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "getFacade", getFacade(s)))
  ensures (inv(s) ==> stepClearRetainsEveryCopiedAccount(s, "getFacade", getFacade(s)))
{
  if inv(s) && true {
    Copied(s);
    Copied(getFacade(s));
  }
}

lemma setExplicit_ensures(s: Handoff, reference: int)
  ensures (inv(s) ==> alwaysDurableOperationSeesNoBootAccounts(setExplicit(s, reference)))
  ensures (inv(s) ==> alwaysCopiedAccountsReachTheTarget(setExplicit(s, reference)))
  ensures (inv(s) ==> alwaysAllocatedIdentitiesAreValid(setExplicit(s, reference)))
  ensures (inv(s) ==> alwaysQueueSerializesHandoff(setExplicit(s, reference)))
  ensures (inv(s) ==> alwaysSnapshotCursorsBounded(setExplicit(s, reference)))
  ensures (inv(s) ==> stepFacadeNeverChanges(s, setExplicit(s, reference)))
  ensures (inv(s) ==> stepFallbackNeverChanges(s, setExplicit(s, reference)))
  ensures (inv(s) ==> stepWarningIsSticky(s, setExplicit(s, reference)))
  ensures (inv(s) ==> stepOperationUsesResolvedBackend(s, "setExplicit", setExplicit(s, reference)))
  ensures (inv(s) ==> stepFailureRetainsFallback(s, "setExplicit", setExplicit(s, reference)))
  ensures (inv(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "setExplicit", setExplicit(s, reference)))
  ensures (inv(s) ==> stepClearRetainsEveryCopiedAccount(s, "setExplicit", setExplicit(s, reference)))
{
  if inv(s) && true {
    Copied(s);
    Copied(setExplicit(s, reference));
  }
}

lemma setClock_ensures(s: Handoff, now: int)
  ensures (inv(s) ==> alwaysDurableOperationSeesNoBootAccounts(setClock(s, now)))
  ensures (inv(s) ==> alwaysCopiedAccountsReachTheTarget(setClock(s, now)))
  ensures (inv(s) ==> alwaysAllocatedIdentitiesAreValid(setClock(s, now)))
  ensures (inv(s) ==> alwaysQueueSerializesHandoff(setClock(s, now)))
  ensures (inv(s) ==> alwaysSnapshotCursorsBounded(setClock(s, now)))
  ensures (inv(s) ==> stepFacadeNeverChanges(s, setClock(s, now)))
  ensures (inv(s) ==> stepFallbackNeverChanges(s, setClock(s, now)))
  ensures (inv(s) ==> stepWarningIsSticky(s, setClock(s, now)))
  ensures (inv(s) ==> stepOperationUsesResolvedBackend(s, "setClock", setClock(s, now)))
  ensures (inv(s) ==> stepFailureRetainsFallback(s, "setClock", setClock(s, now)))
  ensures (inv(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "setClock", setClock(s, now)))
  ensures (inv(s) ==> stepClearRetainsEveryCopiedAccount(s, "setClock", setClock(s, now)))
{
  if inv(s) && true {
    Copied(s);
    Copied(setClock(s, now));
  }
}

lemma resolveCreate_ensures(s: Handoff, value: core__connectorStorage_FlowValue, succeeded: bool)
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysDurableOperationSeesNoBootAccounts(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysCopiedAccountsReachTheTarget(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysAllocatedIdentitiesAreValid(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysQueueSerializesHandoff(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysSnapshotCursorsBounded(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepFacadeNeverChanges(s, resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepFallbackNeverChanges(s, resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepWarningIsSticky(s, resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepOperationUsesResolvedBackend(s, "resolveCreate", resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepFailureRetainsFallback(s, "resolveCreate", resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "resolveCreate", resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepClearRetainsEveryCopiedAccount(s, "resolveCreate", resolveCreate(s, value, succeeded)))
{
  if inv(s) && canResolveCreate(s, value) {
    Copied(s);
    Copied(resolveCreate(s, value, succeeded));
  }
}

lemma replay_ensures(s: Handoff)
  ensures (inv(s) ==> canReplay(s) ==> alwaysDurableOperationSeesNoBootAccounts(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> alwaysCopiedAccountsReachTheTarget(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> alwaysAllocatedIdentitiesAreValid(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> alwaysQueueSerializesHandoff(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> alwaysSnapshotCursorsBounded(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepFacadeNeverChanges(s, replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepFallbackNeverChanges(s, replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepWarningIsSticky(s, replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepOperationUsesResolvedBackend(s, "replay", replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepFailureRetainsFallback(s, "replay", replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "replay", replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepClearRetainsEveryCopiedAccount(s, "replay", replay(s)))
{
  if inv(s) && canReplay(s) {
    Copied(s);
    Copied(replay(s));
  }
}
