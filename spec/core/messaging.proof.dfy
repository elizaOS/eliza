lemma MessagingRowsValid(s: ConnectorState)
  ensures alwaysSelectableHandlersAreValid(s) ==
    ((forall row :: row in s.descriptors ==> row.handler >= 0) &&
     (forall row :: row in s.transports ==> row.handler > 0))
{}

lemma MessagingRetained(s: ConnectorState, after: ConnectorState)
  requires alwaysSelectableHandlersAreValid(s)
  requires forall row :: row in after.descriptors ==> row in s.descriptors || row.handler >= 0
  requires forall row :: row in after.transports ==> row in s.transports || row.handler > 0
  ensures alwaysSelectableHandlersAreValid(after)
{
  MessagingRowsValid(s);
  MessagingRowsValid(after);
}

lemma MessagingSelectedCallback(s: ConnectorState)
  requires alwaysSelectableHandlersAreValid(s)
  ensures |selectedEntries(s)| > 0 ==> selectedEntries(s)[0].handler >= 0
{
  MessagingRowsValid(s);
  var rows := if s.mode.Send? then s.transports else s.descriptors;
  var exact := (d: ConnectorEntry) => d.source == s.targetSource && d.account == s.targetAccount;
  var fallback := (d: ConnectorEntry) => d.source == s.targetSource && d.account == "";
  if |selectedEntries(s)| > 0 {
    var row := selectedEntries(s)[0];
    assert row in selectedEntries(s);
    if |ProofLib.Filter(exact, rows)| > 0 || s.mode.Post? {
      assert selectedEntries(s) == ProofLib.Filter(exact, rows);
      ProofLib.FilterMember(exact, rows, row);
    } else {
      assert selectedEntries(s) == ProofLib.Filter(fallback, rows);
      ProofLib.FilterMember(fallback, rows, row);
    }
  }
}

lemma registerConnector_ensures(s: ConnectorState, source: string, account: string, handler: int)
  ensures (inv(s) ==> canRegisterConnector(s, source, account, handler) ==> alwaysUnsupportedNeverInvokes(registerConnector(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterConnector(s, source, account, handler) ==> alwaysUsesCapturedHandler(registerConnector(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterConnector(s, source, account, handler) ==> alwaysAwaitBeforeInvocation(registerConnector(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterConnector(s, source, account, handler) ==> alwaysSuccessRequiresSettlement(registerConnector(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterConnector(s, source, account, handler) ==> alwaysHandlerHasInvoked(registerConnector(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterConnector(s, source, account, handler) ==> alwaysSelectableHandlersAreValid(registerConnector(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterConnector(s, source, account, handler) ==> alwaysAwaitedCallbackWasSelected(registerConnector(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterConnector(s, source, account, handler) ==> stepCapturedOwnerStable(s, "registerConnector", registerConnector(s, source, account, handler)))
{
  if inv(s) && canRegisterConnector(s, source, account, handler) {
    var after := registerConnector(s, source, account, handler);
    var keep := (d: ConnectorEntry) => d.source != source || d.account != account;
    var added := ConnectorEntry(source, account, handler);
    assert after.descriptors == ProofLib.Filter(keep, s.descriptors) + [added];
    forall row | row in after.descriptors ensures row in s.descriptors || row.handler >= 0 {
      if row != added {
        assert row in ProofLib.Filter(keep, s.descriptors);
        ProofLib.FilterMember(keep, s.descriptors, row);
      }
    }
    if s.mode.Send? && handler > 0 {
      assert after.transports == ProofLib.Filter(keep, s.transports) + [added];
      forall row | row in after.transports ensures row in s.transports || row.handler > 0 {
        if row != added {
          assert row in ProofLib.Filter(keep, s.transports);
          ProofLib.FilterMember(keep, s.transports, row);
        }
      }
    }
    MessagingRetained(s, after);
  }
}

lemma registerTransport_ensures(s: ConnectorState, source: string, account: string, handler: int)
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysUnsupportedNeverInvokes(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysUsesCapturedHandler(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysAwaitBeforeInvocation(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysSuccessRequiresSettlement(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysHandlerHasInvoked(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysSelectableHandlersAreValid(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> alwaysAwaitedCallbackWasSelected(registerTransport(s, source, account, handler)))
  ensures (inv(s) ==> canRegisterTransport(s, source, account, handler) ==> stepCapturedOwnerStable(s, "registerTransport", registerTransport(s, source, account, handler)))
{
  if inv(s) && canRegisterTransport(s, source, account, handler) {
    var after := registerTransport(s, source, account, handler);
    var keep := (d: ConnectorEntry) => d.source != source || d.account != account;
    var added := ConnectorEntry(source, account, handler);
    assert after.transports == ProofLib.Filter(keep, s.transports) + [added];
    forall row | row in after.transports ensures row in s.transports || row.handler > 0 {
      if row != added {
        assert row in ProofLib.Filter(keep, s.transports);
        ProofLib.FilterMember(keep, s.transports, row);
      }
    }
    MessagingRetained(s, after);
  }
}

lemma dispatchConnector_ensures(s: ConnectorState)
  ensures (inv(s) ==> canDispatchConnector(s) ==> alwaysUnsupportedNeverInvokes(dispatchConnector(s)))
  ensures (inv(s) ==> canDispatchConnector(s) ==> alwaysUsesCapturedHandler(dispatchConnector(s)))
  ensures (inv(s) ==> canDispatchConnector(s) ==> alwaysAwaitBeforeInvocation(dispatchConnector(s)))
  ensures (inv(s) ==> canDispatchConnector(s) ==> alwaysSuccessRequiresSettlement(dispatchConnector(s)))
  ensures (inv(s) ==> canDispatchConnector(s) ==> alwaysHandlerHasInvoked(dispatchConnector(s)))
  ensures (inv(s) ==> canDispatchConnector(s) ==> alwaysSelectableHandlersAreValid(dispatchConnector(s)))
  ensures (inv(s) ==> canDispatchConnector(s) ==> alwaysAwaitedCallbackWasSelected(dispatchConnector(s)))
  ensures (inv(s) ==> canDispatchConnector(s) ==> stepCapturedOwnerStable(s, "dispatchConnector", dispatchConnector(s)))
{
  if inv(s) && canDispatchConnector(s) {
    MessagingSelectedCallback(s);
  }
}

lemma removeConnector_ensures(s: ConnectorState, source: string, account: string)
  ensures (inv(s) ==> canRemoveConnector(s, source, account) ==> alwaysUnsupportedNeverInvokes(removeConnector(s, source, account)))
  ensures (inv(s) ==> canRemoveConnector(s, source, account) ==> alwaysUsesCapturedHandler(removeConnector(s, source, account)))
  ensures (inv(s) ==> canRemoveConnector(s, source, account) ==> alwaysAwaitBeforeInvocation(removeConnector(s, source, account)))
  ensures (inv(s) ==> canRemoveConnector(s, source, account) ==> alwaysSuccessRequiresSettlement(removeConnector(s, source, account)))
  ensures (inv(s) ==> canRemoveConnector(s, source, account) ==> alwaysHandlerHasInvoked(removeConnector(s, source, account)))
  ensures (inv(s) ==> canRemoveConnector(s, source, account) ==> alwaysSelectableHandlersAreValid(removeConnector(s, source, account)))
  ensures (inv(s) ==> canRemoveConnector(s, source, account) ==> alwaysAwaitedCallbackWasSelected(removeConnector(s, source, account)))
  ensures (inv(s) ==> canRemoveConnector(s, source, account) ==> stepCapturedOwnerStable(s, "removeConnector", removeConnector(s, source, account)))
{
  if inv(s) && canRemoveConnector(s, source, account) {
    var after := removeConnector(s, source, account);
    var keep := (d: ConnectorEntry) => d.source != source || d.account != account;
    forall row | row in after.descriptors ensures row in s.descriptors {
      assert after.descriptors == ProofLib.Filter(keep, s.descriptors);
      ProofLib.FilterMember(keep, s.descriptors, row);
    }
    forall row | row in after.transports ensures row in s.transports {
      assert after.transports == ProofLib.Filter(keep, s.transports);
      ProofLib.FilterMember(keep, s.transports, row);
    }
    MessagingRetained(s, after);
  }
}

lemma removeSource_ensures(s: ConnectorState, source: string)
  ensures (inv(s) ==> canRemoveSource(s, source) ==> alwaysUnsupportedNeverInvokes(removeSource(s, source)))
  ensures (inv(s) ==> canRemoveSource(s, source) ==> alwaysUsesCapturedHandler(removeSource(s, source)))
  ensures (inv(s) ==> canRemoveSource(s, source) ==> alwaysAwaitBeforeInvocation(removeSource(s, source)))
  ensures (inv(s) ==> canRemoveSource(s, source) ==> alwaysSuccessRequiresSettlement(removeSource(s, source)))
  ensures (inv(s) ==> canRemoveSource(s, source) ==> alwaysHandlerHasInvoked(removeSource(s, source)))
  ensures (inv(s) ==> canRemoveSource(s, source) ==> alwaysSelectableHandlersAreValid(removeSource(s, source)))
  ensures (inv(s) ==> canRemoveSource(s, source) ==> alwaysAwaitedCallbackWasSelected(removeSource(s, source)))
  ensures (inv(s) ==> canRemoveSource(s, source) ==> stepCapturedOwnerStable(s, "removeSource", removeSource(s, source)))
{
  if inv(s) && canRemoveSource(s, source) {
    var after := removeSource(s, source);
    var keep := (d: ConnectorEntry) => d.source != source;
    forall row | row in after.descriptors ensures row in s.descriptors {
      assert after.descriptors == ProofLib.Filter(keep, s.descriptors);
      ProofLib.FilterMember(keep, s.descriptors, row);
    }
    forall row | row in after.transports ensures row in s.transports {
      assert after.transports == ProofLib.Filter(keep, s.transports);
      ProofLib.FilterMember(keep, s.transports, row);
    }
    MessagingRetained(s, after);
  }
}
