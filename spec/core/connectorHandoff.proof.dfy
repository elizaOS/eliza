lemma {:induction false} HandoffFoldPrefix(xs: seq<core__accountValues_AccountValue>, acc: seq<core__accountValues_AccountValue>, limit: int)
  requires |acc| <= limit
  ensures Std.Collections.Seq.FoldLeft((prefix: seq<core__accountValues_AccountValue>, account: core__accountValues_AccountValue) => (if (|prefix| < limit) then (prefix + [account]) else prefix), acc, xs) == acc + xs[..(if |xs| < limit - |acc| then |xs| else limit - |acc|)]
  decreases |xs|
{
  if |xs| > 0 {
    if |acc| == limit {
      HandoffFoldPrefix(xs[1..], acc, limit);
    } else {
      HandoffFoldPrefix(xs[1..], acc + [xs[0]], limit);
      var amount := if |xs| < limit - |acc| then |xs| else limit - |acc|;
      assert 1 <= amount <= |xs|;
      assert (if |xs[1..]| < limit - |acc + [xs[0]]| then |xs[1..]| else limit - |acc + [xs[0]]|) == amount - 1;
      forall k | 0 <= k < amount
        ensures xs[..amount][k] == ([xs[0]] + xs[1..][..amount - 1])[k]
      {
        if k > 0 { assert xs[1..][k - 1] == xs[k]; }
      }
      assert xs[..amount] == [xs[0]] + xs[1..][..amount - 1];
    }
  }
}

lemma HandoffPrefixIsSlice(s: Handoff)
  requires 0 <= s.accountIndex <= |s.accountSnapshot|
  ensures acknowledgedAccounts(s) == s.accountSnapshot[..s.accountIndex]
{
  HandoffFoldPrefix(s.accountSnapshot, [], s.accountIndex);
}

lemma HandoffPrefixSameInputs(before: Handoff, after: Handoff)
  requires before.accountSnapshot == after.accountSnapshot && before.accountIndex == after.accountIndex
  ensures acknowledgedAccounts(before) == acknowledgedAccounts(after)
{
  ProofLib.FoldLeftPointwise((prefix: seq<core__accountValues_AccountValue>, account: core__accountValues_AccountValue) => (if (|prefix| < before.accountIndex) then (prefix + [account]) else prefix), (prefix: seq<core__accountValues_AccountValue>, account: core__accountValues_AccountValue) => (if (|prefix| < after.accountIndex) then (prefix + [account]) else prefix), [], before.accountSnapshot, after.accountSnapshot);
}

lemma HandoffPrefixPreserved(before: Handoff, after: Handoff)
  requires before.accountSnapshot == after.accountSnapshot && before.accountIndex == after.accountIndex
  requires targetStore(before).accounts == targetStore(after).accounts
  requires transferInProgress(after) ==> transferInProgress(before)
  ensures alwaysCopiedAccountPrefixRetained(before) ==> alwaysCopiedAccountPrefixRetained(after)
{
  HandoffPrefixSameInputs(before, after);
}

lemma HandoffSameAccountRule(left: core__connectorStorage_ConnectorStore, right: core__connectorStorage_ConnectorStore)
  requires left.accounts == right.accounts
  ensures core__connectorStorage_alwaysAccountIdentityUnique(left) == core__connectorStorage_alwaysAccountIdentityUnique(right)
{
}

lemma HandoffAccountStateSame(before: Handoff, after: Handoff)
  requires before.fallback.accounts == after.fallback.accounts && before.accountSnapshot == after.accountSnapshot
  ensures alwaysAccountSnapshotIdentityUnique(before) == alwaysAccountSnapshotIdentityUnique(after)
{
  HandoffSameAccountRule(before.fallback, after.fallback);
  HandoffSameAccountRule(core__connectorStorage_initial.(accounts := before.accountSnapshot), core__connectorStorage_initial.(accounts := after.accountSnapshot));
}

lemma HandoffAccountOwnerProjection(store: core__connectorStorage_ConnectorStore)
  requires core__connectorStorage_alwaysAccountIdentityUnique(store)
  ensures core__connectorStorage_inv(store.(flows := [], ownerBindings := []))
{
  HandoffSameAccountRule(store, store.(flows := [], ownerBindings := []));
}

lemma HandoffUpsertKeepsIdentity(store: core__connectorStorage_ConnectorStore, account: core__accountValues_AccountValue)
  requires core__connectorStorage_alwaysAccountIdentityUnique(store) && core__connectorStorage_canUpsertAccount(store, account)
  ensures core__connectorStorage_alwaysAccountIdentityUnique(core__connectorStorage_upsertAccount(store, account))
{
  var projected := store.(flows := [], ownerBindings := []);
  HandoffAccountOwnerProjection(store);
  core__connectorStorage_upsertAccount_ensures(projected, account);
  HandoffSameAccountRule(core__connectorStorage_upsertAccount(store, account), core__connectorStorage_upsertAccount(projected, account));
}

lemma HandoffUpsertContains(store: core__connectorStorage_ConnectorStore, account: core__accountValues_AccountValue)
  ensures account in core__connectorStorage_upsertAccount(store, account).accounts
{
  if exists prior :: prior in store.accounts && prior.provider == account.provider && prior.id == account.id {
    var i :| 0 <= i < |store.accounts| && store.accounts[i].provider == account.provider && store.accounts[i].id == account.id;
    assert core__connectorStorage_upsertAccount(store, account).accounts[i] == account;
  }
}

lemma HandoffUpsertKeepsOther(store: core__connectorStorage_ConnectorStore, account: core__accountValues_AccountValue, kept: core__accountValues_AccountValue)
  requires kept in store.accounts && (kept.provider != account.provider || kept.id != account.id)
  ensures kept in core__connectorStorage_upsertAccount(store, account).accounts
{
  var i :| 0 <= i < |store.accounts| && store.accounts[i] == kept;
  if exists prior :: prior in store.accounts && prior.provider == account.provider && prior.id == account.id {
    assert core__connectorStorage_upsertAccount(store, account).accounts[i] == kept;
  }
}

lemma HandoffAccountUniqueView(store: core__connectorStorage_ConnectorStore)
  ensures core__connectorStorage_alwaysAccountIdentityUnique(store) == !(exists account :: account in store.accounts && !(|ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), store.accounts)| == 1))
{
}

lemma HandoffSnapshotDistinct(s: Handoff, i: int, j: int)
  requires alwaysAccountSnapshotIdentityUnique(s)
  requires 0 <= i < |s.accountSnapshot| && 0 <= j < |s.accountSnapshot| && i != j
  ensures s.accountSnapshot[i].provider != s.accountSnapshot[j].provider || s.accountSnapshot[i].id != s.accountSnapshot[j].id
{
  HandoffAccountUniqueView(core__connectorStorage_initial.(accounts := s.accountSnapshot));
  var account := s.accountSnapshot[i];
  assert |ProofLib.Filter((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), s.accountSnapshot)| == 1;
  if s.accountSnapshot[i].provider == s.accountSnapshot[j].provider && s.accountSnapshot[i].id == s.accountSnapshot[j].id {
    ProofLib.FilterTwo((other: core__accountValues_AccountValue) => ((other.provider == account.provider) && (other.id == account.id)), s.accountSnapshot, i, j);
  }
}

lemma HandoffQueueOwner(s: Handoff)
  requires alwaysQueueSerializesHandoff(s)
  ensures core__connectorQueues_inv(s.queue)
{
}

lemma HandoffRunningTicketCanFinish(s: Handoff)
  requires alwaysQueueSerializesHandoff(s) && !s.phase.HandoffIdle?
  ensures core__connectorQueues_canFinish(s.queue, s.activeTicket)
{
  var entry :| entry in s.queue.entries && entry.ticket == s.activeTicket && entry.running;
  assert !entry.complete;
}

lemma enqueue_ensures(s: Handoff, manager: string)
  ensures (inv(s) ==> alwaysQueueSerializesHandoff(enqueue(s, manager)))
  ensures (inv(s) ==> alwaysSnapshotCursorsBounded(enqueue(s, manager)))
  ensures (inv(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(enqueue(s, manager)))
  ensures (inv(s) ==> alwaysAccountSnapshotIdentityUnique(enqueue(s, manager)))
  ensures (inv(s) ==> alwaysCopiedAccountPrefixRetained(enqueue(s, manager)))
  ensures (inv(s) ==> stepFailureRetainsFallback(s, "enqueue", enqueue(s, manager)))
  ensures (inv(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "enqueue", enqueue(s, manager)))
  ensures (inv(s) ==> stepClearRetainsEveryCopiedAccount(s, "enqueue", enqueue(s, manager)))
{
  if inv(s) {
    var after := enqueue(s, manager);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
    HandoffQueueOwner(s);
    core__connectorQueues_admit_ensures(s.queue, core__connectorQueues_QueueScope(manager, "storage"));
  }
}

lemma writeFallbackFlow_ensures(s: Handoff, value: core__connectorStorage_FlowValue)
  ensures (inv(s) ==> canWriteFallbackFlow(s, value) ==> alwaysQueueSerializesHandoff(writeFallbackFlow(s, value)))
  ensures (inv(s) ==> canWriteFallbackFlow(s, value) ==> alwaysSnapshotCursorsBounded(writeFallbackFlow(s, value)))
  ensures (inv(s) ==> canWriteFallbackFlow(s, value) ==> alwaysAwaitingFlowHasCurrentSnapshot(writeFallbackFlow(s, value)))
  ensures (inv(s) ==> canWriteFallbackFlow(s, value) ==> alwaysAccountSnapshotIdentityUnique(writeFallbackFlow(s, value)))
  ensures (inv(s) ==> canWriteFallbackFlow(s, value) ==> alwaysCopiedAccountPrefixRetained(writeFallbackFlow(s, value)))
  ensures (inv(s) ==> canWriteFallbackFlow(s, value) ==> stepFailureRetainsFallback(s, "writeFallbackFlow", writeFallbackFlow(s, value)))
  ensures (inv(s) ==> canWriteFallbackFlow(s, value) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "writeFallbackFlow", writeFallbackFlow(s, value)))
  ensures (inv(s) ==> canWriteFallbackFlow(s, value) ==> stepClearRetainsEveryCopiedAccount(s, "writeFallbackFlow", writeFallbackFlow(s, value)))
{
  if inv(s) && canWriteFallbackFlow(s, value) {
    var after := writeFallbackFlow(s, value);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma consumeFallbackFlow_ensures(s: Handoff, provider: string, token: string)
  ensures (inv(s) ==> canConsumeFallbackFlow(s, provider, token) ==> alwaysQueueSerializesHandoff(consumeFallbackFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFallbackFlow(s, provider, token) ==> alwaysSnapshotCursorsBounded(consumeFallbackFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFallbackFlow(s, provider, token) ==> alwaysAwaitingFlowHasCurrentSnapshot(consumeFallbackFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFallbackFlow(s, provider, token) ==> alwaysAccountSnapshotIdentityUnique(consumeFallbackFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFallbackFlow(s, provider, token) ==> alwaysCopiedAccountPrefixRetained(consumeFallbackFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFallbackFlow(s, provider, token) ==> stepFailureRetainsFallback(s, "consumeFallbackFlow", consumeFallbackFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFallbackFlow(s, provider, token) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "consumeFallbackFlow", consumeFallbackFlow(s, provider, token)))
  ensures (inv(s) ==> canConsumeFallbackFlow(s, provider, token) ==> stepClearRetainsEveryCopiedAccount(s, "consumeFallbackFlow", consumeFallbackFlow(s, provider, token)))
{
  if inv(s) && canConsumeFallbackFlow(s, provider, token) {
    var after := consumeFallbackFlow(s, provider, token);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma nextPhase_ensures(s: Handoff)
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysQueueSerializesHandoff(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysSnapshotCursorsBounded(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysAccountSnapshotIdentityUnique(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> alwaysCopiedAccountPrefixRetained(nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepFailureRetainsFallback(s, "nextPhase", nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "nextPhase", nextPhase(s)))
  ensures (inv(s) ==> canNextPhase(s) ==> stepClearRetainsEveryCopiedAccount(s, "nextPhase", nextPhase(s)))
{
  if inv(s) && canNextPhase(s) {
    var after := nextPhase(s);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma copyFlow_ensures(s: Handoff)
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysQueueSerializesHandoff(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysSnapshotCursorsBounded(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysAccountSnapshotIdentityUnique(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> alwaysCopiedAccountPrefixRetained(copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepFailureRetainsFallback(s, "copyFlow", copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "copyFlow", copyFlow(s)))
  ensures (inv(s) ==> canCopyFlow(s) ==> stepClearRetainsEveryCopiedAccount(s, "copyFlow", copyFlow(s)))
{
  if inv(s) && canCopyFlow(s) {
    var after := copyFlow(s);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma configureBridge_ensures(s: Handoff, methods: core__oauthBridge_AdapterMethods)
  ensures (inv(s) ==> canConfigureBridge(s) ==> alwaysQueueSerializesHandoff(configureBridge(s, methods)))
  ensures (inv(s) ==> canConfigureBridge(s) ==> alwaysSnapshotCursorsBounded(configureBridge(s, methods)))
  ensures (inv(s) ==> canConfigureBridge(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(configureBridge(s, methods)))
  ensures (inv(s) ==> canConfigureBridge(s) ==> alwaysAccountSnapshotIdentityUnique(configureBridge(s, methods)))
  ensures (inv(s) ==> canConfigureBridge(s) ==> alwaysCopiedAccountPrefixRetained(configureBridge(s, methods)))
  ensures (inv(s) ==> canConfigureBridge(s) ==> stepFailureRetainsFallback(s, "configureBridge", configureBridge(s, methods)))
  ensures (inv(s) ==> canConfigureBridge(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "configureBridge", configureBridge(s, methods)))
  ensures (inv(s) ==> canConfigureBridge(s) ==> stepClearRetainsEveryCopiedAccount(s, "configureBridge", configureBridge(s, methods)))
{
  if inv(s) && canConfigureBridge(s) {
    var after := configureBridge(s, methods);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma resolveCreate_ensures(s: Handoff, value: core__connectorStorage_FlowValue, succeeded: bool)
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysQueueSerializesHandoff(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysSnapshotCursorsBounded(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysAwaitingFlowHasCurrentSnapshot(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysAccountSnapshotIdentityUnique(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> alwaysCopiedAccountPrefixRetained(resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepFailureRetainsFallback(s, "resolveCreate", resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "resolveCreate", resolveCreate(s, value, succeeded)))
  ensures (inv(s) ==> canResolveCreate(s, value) ==> stepClearRetainsEveryCopiedAccount(s, "resolveCreate", resolveCreate(s, value, succeeded)))
{
  if inv(s) && canResolveCreate(s, value) {
    var after := resolveCreate(s, value, succeeded);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma finishBridgeCreate_ensures(s: Handoff)
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysQueueSerializesHandoff(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysSnapshotCursorsBounded(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysAccountSnapshotIdentityUnique(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> alwaysCopiedAccountPrefixRetained(finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepFailureRetainsFallback(s, "finishBridgeCreate", finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "finishBridgeCreate", finishBridgeCreate(s)))
  ensures (inv(s) ==> canFinishBridgeCreate(s) ==> stepClearRetainsEveryCopiedAccount(s, "finishBridgeCreate", finishBridgeCreate(s)))
{
  if inv(s) && canFinishBridgeCreate(s) {
    var after := finishBridgeCreate(s);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
    if s.bridge.phase.BridgeFailed? {
      HandoffQueueOwner(s);
      HandoffRunningTicketCanFinish(s);
      core__connectorQueues_finish_ensures(s.queue, s.activeTicket, false);
    }
  }
}

lemma replay_ensures(s: Handoff)
  ensures (inv(s) ==> canReplay(s) ==> alwaysQueueSerializesHandoff(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> alwaysSnapshotCursorsBounded(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> alwaysAccountSnapshotIdentityUnique(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> alwaysCopiedAccountPrefixRetained(replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepFailureRetainsFallback(s, "replay", replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "replay", replay(s)))
  ensures (inv(s) ==> canReplay(s) ==> stepClearRetainsEveryCopiedAccount(s, "replay", replay(s)))
{
  if inv(s) && canReplay(s) {
    var after := replay(s);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma resolveConsumption_ensures(s: Handoff, succeeded: bool)
  ensures (inv(s) ==> canResolveConsumption(s) ==> alwaysQueueSerializesHandoff(resolveConsumption(s, succeeded)))
  ensures (inv(s) ==> canResolveConsumption(s) ==> alwaysSnapshotCursorsBounded(resolveConsumption(s, succeeded)))
  ensures (inv(s) ==> canResolveConsumption(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(resolveConsumption(s, succeeded)))
  ensures (inv(s) ==> canResolveConsumption(s) ==> alwaysAccountSnapshotIdentityUnique(resolveConsumption(s, succeeded)))
  ensures (inv(s) ==> canResolveConsumption(s) ==> alwaysCopiedAccountPrefixRetained(resolveConsumption(s, succeeded)))
  ensures (inv(s) ==> canResolveConsumption(s) ==> stepFailureRetainsFallback(s, "resolveConsumption", resolveConsumption(s, succeeded)))
  ensures (inv(s) ==> canResolveConsumption(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "resolveConsumption", resolveConsumption(s, succeeded)))
  ensures (inv(s) ==> canResolveConsumption(s) ==> stepClearRetainsEveryCopiedAccount(s, "resolveConsumption", resolveConsumption(s, succeeded)))
{
  if inv(s) && canResolveConsumption(s) {
    var after := resolveConsumption(s, succeeded);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma finishBridgeConsumption_ensures(s: Handoff)
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysQueueSerializesHandoff(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysSnapshotCursorsBounded(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysAccountSnapshotIdentityUnique(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> alwaysCopiedAccountPrefixRetained(finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepFailureRetainsFallback(s, "finishBridgeConsumption", finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "finishBridgeConsumption", finishBridgeConsumption(s)))
  ensures (inv(s) ==> canFinishBridgeConsumption(s) ==> stepClearRetainsEveryCopiedAccount(s, "finishBridgeConsumption", finishBridgeConsumption(s)))
{
  if inv(s) && canFinishBridgeConsumption(s) {
    var after := finishBridgeConsumption(s);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
    if s.bridge.phase.BridgeFailed? {
      HandoffQueueOwner(s);
      HandoffRunningTicketCanFinish(s);
      core__connectorQueues_finish_ensures(s.queue, s.activeTicket, false);
    }
  }
}

lemma setClock_ensures(s: Handoff, now: int)
  ensures (inv(s) ==> alwaysQueueSerializesHandoff(setClock(s, now)))
  ensures (inv(s) ==> alwaysSnapshotCursorsBounded(setClock(s, now)))
  ensures (inv(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(setClock(s, now)))
  ensures (inv(s) ==> alwaysAccountSnapshotIdentityUnique(setClock(s, now)))
  ensures (inv(s) ==> alwaysCopiedAccountPrefixRetained(setClock(s, now)))
  ensures (inv(s) ==> stepFailureRetainsFallback(s, "setClock", setClock(s, now)))
  ensures (inv(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "setClock", setClock(s, now)))
  ensures (inv(s) ==> stepClearRetainsEveryCopiedAccount(s, "setClock", setClock(s, now)))
{
  if inv(s) {
    var after := setClock(s, now);
    HandoffAccountStateSame(s, after);
    HandoffPrefixPreserved(s, after);
  }
}

lemma beginOperation_ensures(s: Handoff, ticket: int, backend: string, kind: BackendKind, methods: core__oauthBridge_AdapterMethods)
  ensures (inv(s) ==> canBeginOperation(s, ticket, backend) ==> alwaysQueueSerializesHandoff(beginOperation(s, ticket, backend, kind, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, backend) ==> alwaysSnapshotCursorsBounded(beginOperation(s, ticket, backend, kind, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, backend) ==> alwaysAwaitingFlowHasCurrentSnapshot(beginOperation(s, ticket, backend, kind, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, backend) ==> alwaysAccountSnapshotIdentityUnique(beginOperation(s, ticket, backend, kind, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, backend) ==> alwaysCopiedAccountPrefixRetained(beginOperation(s, ticket, backend, kind, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, backend) ==> stepFailureRetainsFallback(s, "beginOperation", beginOperation(s, ticket, backend, kind, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, backend) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "beginOperation", beginOperation(s, ticket, backend, kind, methods)))
  ensures (inv(s) ==> canBeginOperation(s, ticket, backend) ==> stepClearRetainsEveryCopiedAccount(s, "beginOperation", beginOperation(s, ticket, backend, kind, methods)))
{
  if inv(s) && canBeginOperation(s, ticket, backend) {
    HandoffQueueOwner(s);
    core__connectorQueues_begin_ensures(s.queue, ticket);
    var after := beginOperation(s, ticket, backend, kind, methods);
    var i :| 0 <= i < |s.queue.entries| && s.queue.entries[i].ticket == ticket;
    assert |after.queue.entries| == |s.queue.entries|;
    assert after.queue.entries[i].ticket == after.activeTicket && after.queue.entries[i].running;
    HandoffPrefixIsSlice(after);
    if after.accountSnapshot == s.fallback.accounts {
      HandoffSameAccountRule(after.fallback, core__connectorStorage_initial.(accounts := after.accountSnapshot));
    }
  }
}

lemma beginNextOperation_ensures(s: Handoff, backend: string, kind: BackendKind, methods: core__oauthBridge_AdapterMethods)
  ensures (inv(s) ==> canBeginNextOperation(s, backend) ==> alwaysQueueSerializesHandoff(beginNextOperation(s, backend, kind, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, backend) ==> alwaysSnapshotCursorsBounded(beginNextOperation(s, backend, kind, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, backend) ==> alwaysAwaitingFlowHasCurrentSnapshot(beginNextOperation(s, backend, kind, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, backend) ==> alwaysAccountSnapshotIdentityUnique(beginNextOperation(s, backend, kind, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, backend) ==> alwaysCopiedAccountPrefixRetained(beginNextOperation(s, backend, kind, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, backend) ==> stepFailureRetainsFallback(s, "beginNextOperation", beginNextOperation(s, backend, kind, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, backend) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "beginNextOperation", beginNextOperation(s, backend, kind, methods)))
  ensures (inv(s) ==> canBeginNextOperation(s, backend) ==> stepClearRetainsEveryCopiedAccount(s, "beginNextOperation", beginNextOperation(s, backend, kind, methods)))
{
  if inv(s) && canBeginNextOperation(s, backend) {
    beginOperation_ensures(s, core__connectorQueues_firstEligible(s.queue), backend, kind, methods);
  }
}

lemma writeFallbackAccount_ensures(s: Handoff, account: core__accountValues_AccountValue)
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysQueueSerializesHandoff(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysSnapshotCursorsBounded(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysAwaitingFlowHasCurrentSnapshot(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysAccountSnapshotIdentityUnique(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> alwaysCopiedAccountPrefixRetained(writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepFailureRetainsFallback(s, "writeFallbackAccount", writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "writeFallbackAccount", writeFallbackAccount(s, account)))
  ensures (inv(s) ==> canWriteFallbackAccount(s, account) ==> stepClearRetainsEveryCopiedAccount(s, "writeFallbackAccount", writeFallbackAccount(s, account)))
{
  if inv(s) && canWriteFallbackAccount(s, account) {
    HandoffUpsertKeepsIdentity(s.fallback, account);
    var after := writeFallbackAccount(s, account);
    HandoffPrefixPreserved(s, after);
  }
}

lemma copyAccount_ensures(s: Handoff)
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysQueueSerializesHandoff(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysSnapshotCursorsBounded(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysAccountSnapshotIdentityUnique(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> alwaysCopiedAccountPrefixRetained(copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepFailureRetainsFallback(s, "copyAccount", copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "copyAccount", copyAccount(s)))
  ensures (inv(s) ==> canCopyAccount(s) ==> stepClearRetainsEveryCopiedAccount(s, "copyAccount", copyAccount(s)))
{
  if inv(s) && canCopyAccount(s) {
    var after := copyAccount(s);
    HandoffAccountStateSame(s, after);
    HandoffPrefixIsSlice(s);
    HandoffPrefixIsSlice(after);
    var copied := s.accountSnapshot[s.accountIndex];
    assert targetStore(after).accounts == core__connectorStorage_upsertAccount(targetStore(s), copied).accounts;
    HandoffUpsertContains(targetStore(s), copied);
    forall kept | kept in acknowledgedAccounts(s)
      ensures kept in targetStore(after).accounts
    {
      var j :| 0 <= j < s.accountIndex && s.accountSnapshot[j] == kept;
      HandoffSnapshotDistinct(s, j, s.accountIndex);
      HandoffUpsertKeepsOther(targetStore(s), copied, kept);
    }
    assert s.accountSnapshot[..s.accountIndex + 1] == s.accountSnapshot[..s.accountIndex] + [copied];
  }
}

lemma finishTransfer_ensures(s: Handoff)
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysQueueSerializesHandoff(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysSnapshotCursorsBounded(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysAccountSnapshotIdentityUnique(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> alwaysCopiedAccountPrefixRetained(finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepFailureRetainsFallback(s, "finishTransfer", finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "finishTransfer", finishTransfer(s)))
  ensures (inv(s) ==> canFinishTransfer(s) ==> stepClearRetainsEveryCopiedAccount(s, "finishTransfer", finishTransfer(s)))
{
  if inv(s) && canFinishTransfer(s) {
    HandoffPrefixIsSlice(s);
    assert acknowledgedAccounts(s) == s.accountSnapshot;
  }
}

lemma transferFails_ensures(s: Handoff)
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysQueueSerializesHandoff(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysSnapshotCursorsBounded(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysAccountSnapshotIdentityUnique(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> alwaysCopiedAccountPrefixRetained(transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepFailureRetainsFallback(s, "transferFails", transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "transferFails", transferFails(s)))
  ensures (inv(s) ==> canTransferFails(s) ==> stepClearRetainsEveryCopiedAccount(s, "transferFails", transferFails(s)))
{
  if inv(s) && canTransferFails(s) {
    HandoffQueueOwner(s);
    HandoffRunningTicketCanFinish(s);
    core__connectorQueues_finish_ensures(s.queue, s.activeTicket, false);
  }
}

lemma finishOperation_ensures(s: Handoff, success: bool)
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysQueueSerializesHandoff(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysSnapshotCursorsBounded(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysAwaitingFlowHasCurrentSnapshot(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysAccountSnapshotIdentityUnique(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> alwaysCopiedAccountPrefixRetained(finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepFailureRetainsFallback(s, "finishOperation", finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepMirrorOnlyConsumePreservesDurableTarget(s, "finishOperation", finishOperation(s, success)))
  ensures (inv(s) ==> canFinishOperation(s) ==> stepClearRetainsEveryCopiedAccount(s, "finishOperation", finishOperation(s, success)))
{
  if inv(s) && canFinishOperation(s) {
    HandoffQueueOwner(s);
    HandoffRunningTicketCanFinish(s);
    core__connectorQueues_finish_ensures(s.queue, s.activeTicket, success);
  }
}
