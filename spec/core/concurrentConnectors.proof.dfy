lemma ConnectorCallFacts(s: ConcurrentConnectors)
  ensures alwaysEachCallValid(s) == (forall call :: call in s.calls ==> core__messaging_inv(call.unit))
  ensures alwaysCallIdsUnique(s) == (forall call :: call in s.calls ==> call.id > 0 && |ProofLib.Filter((other: ConnectorCall) => other.id == call.id, s.calls)| == 1)
{}

lemma ConnectorCallbacksKept<T>(rows: seq<T>, retained: seq<T>, keep: T -> bool, valid: T -> bool)
  requires forall row :: row in rows ==> valid(row)
  requires retained == ProofLib.Filter(keep, rows)
  ensures forall row :: row in retained ==> valid(row)
{
  forall row | row in retained ensures valid(row) {
    ProofLib.FilterMember(keep, rows, row);
  }
}

lemma ConnectorNewCall(s: ConcurrentConnectors, after: ConcurrentConnectors, call: ConnectorCall)
  requires inv(s)
  requires after.calls == s.calls + [call] && call.id > 0 && core__messaging_inv(call.unit)
  requires forall prior :: prior in s.calls ==> prior.id != call.id
  ensures alwaysEachCallValid(after) && alwaysCallIdsUnique(after) && stepCapturedCallbacksStable(s, after)
{
  ConnectorCallFacts(s);
  ConnectorCallFacts(after);
  forall current | current in after.calls
    ensures core__messaging_inv(current.unit) && current.id > 0
    ensures |ProofLib.Filter((other: ConnectorCall) => other.id == current.id, after.calls)| == 1
  {
    var key := (other: ConnectorCall) => other.id == current.id;
    ProofLib.FilterAppend(key, s.calls, call);
    if current == call {
      ProofLib.FilterNone(key, s.calls);
    } else {
      assert current in s.calls;
    }
  }
}

lemma ConnectorLookupUnique(s: ConcurrentConnectors, call: ConnectorCall)
  requires alwaysCallIdsUnique(s) && call in s.calls
  ensures connectorCall(s, call.id) == call.unit
{
  ConnectorCallFacts(s);
  var key := (other: ConnectorCall) => other.id == call.id;
  var found := ProofLib.Filter(key, s.calls);
  assert |found| == 1;
  ProofLib.FilterMember(key, s.calls, call);
  assert found[0] == call;
}

lemma ConnectorMappedCalls(s: ConcurrentConnectors, after: ConcurrentConnectors)
  requires inv(s)
  requires |after.calls| == |s.calls|
  requires forall index :: 0 <= index < |s.calls| ==>
    (after.calls[index].id == s.calls[index].id &&
     core__messaging_inv(after.calls[index].unit) &&
     after.calls[index].unit.selectedOwner == s.calls[index].unit.selectedOwner &&
     after.calls[index].unit.selectedAccount == s.calls[index].unit.selectedAccount)
  ensures alwaysEachCallValid(after) && alwaysCallIdsUnique(after) && stepCapturedCallbacksStable(s, after)
{
  ConnectorCallFacts(s);
  ConnectorCallFacts(after);
  forall row | row in after.calls
    ensures core__messaging_inv(row.unit) && row.id > 0
    ensures |ProofLib.Filter((other: ConnectorCall) => other.id == row.id, after.calls)| == 1
  {
    var index :| 0 <= index < |after.calls| && after.calls[index] == row;
    assert s.calls[index] in s.calls;
    var key := (other: ConnectorCall) => other.id == row.id;
    ProofLib.FilterLengthPointwise(key, key, s.calls, after.calls);
  }
  forall prior | prior in s.calls
    ensures exists row :: (row in after.calls && row.id == prior.id &&
      row.unit.selectedOwner == prior.unit.selectedOwner && row.unit.selectedAccount == prior.unit.selectedAccount)
  {
    var index :| 0 <= index < |s.calls| && s.calls[index] == prior;
    assert after.calls[index] in after.calls;
  }
}

lemma beginCall_ensures(s: ConcurrentConnectors, callId: int, mode: core__messaging_DispatchMode, source: string, account: string)
  ensures (inv(s) ==> canBeginCall(s, callId, mode, source, account) ==> alwaysEachCallValid(beginCall(s, callId, mode, source, account)))
  ensures (inv(s) ==> canBeginCall(s, callId, mode, source, account) ==> alwaysCallIdsUnique(beginCall(s, callId, mode, source, account)))
  ensures (inv(s) ==> canBeginCall(s, callId, mode, source, account) ==> alwaysSharedCallbackIdsValid(beginCall(s, callId, mode, source, account)))
  ensures (inv(s) ==> canBeginCall(s, callId, mode, source, account) ==> stepCapturedCallbacksStable(s, beginCall(s, callId, mode, source, account)))
  ensures (inv(s) ==> canBeginCall(s, callId, mode, source, account) ==> stepRegistryDoesNotMutateCalls(s, "beginCall", beginCall(s, callId, mode, source, account)))
{
  if inv(s) && canBeginCall(s, callId, mode, source, account) {
    var prior := core__messaging_configureConnector(core__messaging_initial, mode, source, account);
    var slots := capturedDescriptors(s, mode);
    var unit := prior.(descriptors := slots, transports := s.transports);
    forall row | row in slots ensures row.handler >= 0 {
      var index :| 0 <= index < |slots| && slots[index] == row;
      assert s.descriptors[index] in s.descriptors;
    }
    assert core__messaging_inv(unit);
    assert core__messaging_canDispatchConnector(unit);
    core__messaging_dispatchConnector_ensures(unit);
    var admitted := ConnectorCall(callId, core__messaging_dispatchConnector(unit));
    var after := beginCall(s, callId, mode, source, account);
    assert after.calls == s.calls + [admitted];
    ConnectorNewCall(s, after, admitted);
  }
}

lemma invokeCall_ensures(s: ConcurrentConnectors, callId: int)
  ensures (inv(s) ==> canInvokeCall(s, callId) ==> alwaysEachCallValid(invokeCall(s, callId)))
  ensures (inv(s) ==> canInvokeCall(s, callId) ==> alwaysCallIdsUnique(invokeCall(s, callId)))
  ensures (inv(s) ==> canInvokeCall(s, callId) ==> alwaysSharedCallbackIdsValid(invokeCall(s, callId)))
  ensures (inv(s) ==> canInvokeCall(s, callId) ==> stepCapturedCallbacksStable(s, invokeCall(s, callId)))
  ensures (inv(s) ==> canInvokeCall(s, callId) ==> stepRegistryDoesNotMutateCalls(s, "invokeCall", invokeCall(s, callId)))
{
  if inv(s) && canInvokeCall(s, callId) {
    var after := invokeCall(s, callId);
    ConnectorCallFacts(s);
    forall index | 0 <= index < |s.calls|
      ensures after.calls[index].id == s.calls[index].id
      ensures core__messaging_inv(after.calls[index].unit)
      ensures after.calls[index].unit.selectedOwner == s.calls[index].unit.selectedOwner
      ensures after.calls[index].unit.selectedAccount == s.calls[index].unit.selectedAccount
    {
      var prior := s.calls[index];
      assert prior in s.calls;
      if prior.id == callId {
        ConnectorLookupUnique(s, prior);
        assert core__messaging_canInvokeCaptured(prior.unit);
        core__messaging_invokeCaptured_ensures(prior.unit);
      }
    }
    ConnectorMappedCalls(s, after);
  }
}

lemma finishCall_ensures(s: ConcurrentConnectors, callId: int, ok: bool)
  ensures (inv(s) ==> canFinishCall(s, callId, ok) ==> alwaysEachCallValid(finishCall(s, callId, ok)))
  ensures (inv(s) ==> canFinishCall(s, callId, ok) ==> alwaysCallIdsUnique(finishCall(s, callId, ok)))
  ensures (inv(s) ==> canFinishCall(s, callId, ok) ==> alwaysSharedCallbackIdsValid(finishCall(s, callId, ok)))
  ensures (inv(s) ==> canFinishCall(s, callId, ok) ==> stepCapturedCallbacksStable(s, finishCall(s, callId, ok)))
  ensures (inv(s) ==> canFinishCall(s, callId, ok) ==> stepRegistryDoesNotMutateCalls(s, "finishCall", finishCall(s, callId, ok)))
{
  if inv(s) && canFinishCall(s, callId, ok) {
    var after := finishCall(s, callId, ok);
    ConnectorCallFacts(s);
    forall index | 0 <= index < |s.calls|
      ensures after.calls[index].id == s.calls[index].id
      ensures core__messaging_inv(after.calls[index].unit)
      ensures after.calls[index].unit.selectedOwner == s.calls[index].unit.selectedOwner
      ensures after.calls[index].unit.selectedAccount == s.calls[index].unit.selectedAccount
    {
      var prior := s.calls[index];
      assert prior in s.calls;
      if prior.id == callId {
        ConnectorLookupUnique(s, prior);
        assert core__messaging_canFinishConnector(prior.unit, ok);
        core__messaging_finishConnector_ensures(prior.unit, ok);
      }
    }
    ConnectorMappedCalls(s, after);
  }
}

lemma registerDescriptor_ensures(s: ConcurrentConnectors, source: string, account: string, hook: int, post: int)
  ensures (inv(s) ==> canRegisterDescriptor(s, source, account, hook, post) ==> alwaysEachCallValid(registerDescriptor(s, source, account, hook, post)))
  ensures (inv(s) ==> canRegisterDescriptor(s, source, account, hook, post) ==> alwaysCallIdsUnique(registerDescriptor(s, source, account, hook, post)))
  ensures (inv(s) ==> canRegisterDescriptor(s, source, account, hook, post) ==> alwaysSharedCallbackIdsValid(registerDescriptor(s, source, account, hook, post)))
  ensures (inv(s) ==> canRegisterDescriptor(s, source, account, hook, post) ==> stepCapturedCallbacksStable(s, registerDescriptor(s, source, account, hook, post)))
  ensures (inv(s) ==> canRegisterDescriptor(s, source, account, hook, post) ==> stepRegistryDoesNotMutateCalls(s, "registerDescriptor", registerDescriptor(s, source, account, hook, post)))
{
  if inv(s) && canRegisterDescriptor(s, source, account, hook, post) {
    var after := registerDescriptor(s, source, account, hook, post);
    var keep := (row: ConnectorDescriptor) => row.source != source || row.account != account;
    var valid := (row: ConnectorDescriptor) => row.hook >= 0 && row.post >= 0;
    var kept := ProofLib.Filter(keep, s.descriptors);
    var added := ConnectorDescriptor(source, account, hook, post);
    assert after.descriptors == kept + [added];
    ConnectorCallbacksKept(s.descriptors, kept, keep, valid);
    forall row | row in after.descriptors ensures valid(row) {
      if row != added { assert row in kept; }
    }
  }
}

lemma registerTransport_ensures(s: ConcurrentConnectors, source: string, account: string, handler: int)
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysEachCallValid(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysCallIdsUnique(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysSharedCallbackIdsValid(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> stepCapturedCallbacksStable(s, registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> stepRegistryDoesNotMutateCalls(s, "registerTransport", registerTransport(s, source, account, handler)))
{
  if inv(s) && canRegisterTransport(s, source, account, handler) {
    var after := registerTransport(s, source, account, handler);
    var keep := (row: core__messaging_ConnectorEntry) => row.source != source || row.account != account;
    var valid := (row: core__messaging_ConnectorEntry) => row.handler > 0;
    var kept := ProofLib.Filter(keep, s.transports);
    var added := core__messaging_ConnectorEntry(source, account, handler);
    assert after.transports == kept + [added];
    ConnectorCallbacksKept(s.transports, kept, keep, valid);
    forall row | row in after.transports ensures valid(row) {
      if row != added { assert row in kept; }
    }
  }
}

lemma removeAccount_ensures(s: ConcurrentConnectors, source: string, account: string)
  ensures (inv(s) ==> alwaysEachCallValid(removeAccount(s, source, account)))
  ensures (inv(s) ==> alwaysCallIdsUnique(removeAccount(s, source, account)))
  ensures (inv(s) ==> alwaysSharedCallbackIdsValid(removeAccount(s, source, account)))
  ensures (inv(s) ==> stepCapturedCallbacksStable(s, removeAccount(s, source, account)))
  ensures (inv(s) ==> stepRegistryDoesNotMutateCalls(s, "removeAccount", removeAccount(s, source, account)))
{
  if inv(s) {
    var after := removeAccount(s, source, account);
    ConnectorCallbacksKept(s.descriptors, after.descriptors, (row: ConnectorDescriptor) => row.source != source || row.account != account, (row: ConnectorDescriptor) => row.hook >= 0 && row.post >= 0);
    ConnectorCallbacksKept(s.transports, after.transports, (row: core__messaging_ConnectorEntry) => row.source != source || row.account != account, (row: core__messaging_ConnectorEntry) => row.handler > 0);
  }
}

lemma removeSource_ensures(s: ConcurrentConnectors, source: string)
  ensures (inv(s) ==> alwaysEachCallValid(removeSource(s, source)))
  ensures (inv(s) ==> alwaysCallIdsUnique(removeSource(s, source)))
  ensures (inv(s) ==> alwaysSharedCallbackIdsValid(removeSource(s, source)))
  ensures (inv(s) ==> stepCapturedCallbacksStable(s, removeSource(s, source)))
  ensures (inv(s) ==> stepRegistryDoesNotMutateCalls(s, "removeSource", removeSource(s, source)))
{
  if inv(s) {
    var after := removeSource(s, source);
    ConnectorCallbacksKept(s.descriptors, after.descriptors, (row: ConnectorDescriptor) => row.source != source, (row: ConnectorDescriptor) => row.hook >= 0 && row.post >= 0);
    ConnectorCallbacksKept(s.transports, after.transports, (row: core__messaging_ConnectorEntry) => row.source != source, (row: core__messaging_ConnectorEntry) => row.handler > 0);
  }
}
