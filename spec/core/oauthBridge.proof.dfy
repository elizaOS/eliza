lemma BridgeSameFlows(left: core__connectorStorage_ConnectorStore, right: core__connectorStorage_ConnectorStore)
  requires left.flows == right.flows
  ensures core__connectorStorage_alwaysFlowAliasesUnique(left) == core__connectorStorage_alwaysFlowAliasesUnique(right)
{
}

lemma BridgeFlowOwnerProjection(mirror: core__connectorStorage_ConnectorStore)
  requires core__connectorStorage_alwaysFlowAliasesUnique(mirror)
  ensures core__connectorStorage_inv(mirror.(accounts := [], ownerBindings := []))
{
  BridgeSameFlows(mirror, mirror.(accounts := [], ownerBindings := []));
}

lemma BridgeSweepFlowView(mirror: core__connectorStorage_ConnectorStore)
  ensures core__connectorStorage_sweepExpired(mirror).flows == ProofLib.Filter((entry: core__connectorStorage_FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > mirror.now)), mirror.flows)
{
}

lemma BridgeSweepKeepsAliases(mirror: core__connectorStorage_ConnectorStore)
  requires core__connectorStorage_alwaysFlowAliasesUnique(mirror)
  ensures core__connectorStorage_alwaysFlowAliasesUnique(core__connectorStorage_sweepExpired(mirror))
{
  var projected := mirror.(accounts := [], ownerBindings := []);
  BridgeFlowOwnerProjection(mirror);
  core__connectorStorage_sweepExpired_ensures(projected);
  BridgeSweepFlowView(mirror);
  BridgeSweepFlowView(projected);
  ProofLib.FilterSamePredicate((entry: core__connectorStorage_FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > mirror.now)), (entry: core__connectorStorage_FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > projected.now)), mirror.flows);
  BridgeSameFlows(core__connectorStorage_sweepExpired(mirror), core__connectorStorage_sweepExpired(projected));
}

lemma BridgeReinsertAfterSweep(mirror: core__connectorStorage_ConnectorStore, value: core__connectorStorage_FlowValue)
  requires core__connectorStorage_canReinsertFlow(mirror, value)
  ensures core__connectorStorage_canReinsertFlow(core__connectorStorage_sweepExpired(mirror), value)
{
  BridgeSweepFlowView(mirror);
  forall entry | entry in core__connectorStorage_sweepExpired(mirror).flows
    ensures entry in mirror.flows
  {
    ProofLib.FilterMember((entry: core__connectorStorage_FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > mirror.now)), mirror.flows, entry);
  }
}

lemma BridgeDeleteFlowKeepsAliases(mirror: core__connectorStorage_ConnectorStore, provider: string, key: string)
  requires core__connectorStorage_alwaysFlowAliasesUnique(mirror)
  ensures core__connectorStorage_alwaysFlowAliasesUnique(core__connectorStorage_deleteFlow(mirror, provider, key))
{
  var projected := mirror.(accounts := [], ownerBindings := []);
  BridgeFlowOwnerProjection(mirror);
  core__connectorStorage_deleteFlow_ensures(projected, provider, key);
  assert core__connectorStorage_deleteFlow(mirror, provider, key).flows == core__connectorStorage_deleteFlow(projected, provider, key).flows;
  BridgeSameFlows(core__connectorStorage_deleteFlow(mirror, provider, key), core__connectorStorage_deleteFlow(projected, provider, key));
}

lemma BridgeUpdateFlowKeepsAliases(mirror: core__connectorStorage_ConnectorStore, provider: string, key: string, updated: core__connectorStorage_FlowValue)
  requires core__connectorStorage_alwaysFlowAliasesUnique(mirror)
  ensures core__connectorStorage_alwaysFlowAliasesUnique(core__connectorStorage_updateFlow(mirror, provider, key, updated))
{
  var projected := mirror.(accounts := [], ownerBindings := []);
  BridgeFlowOwnerProjection(mirror);
  core__connectorStorage_updateFlow_ensures(projected, provider, key, updated);
  assert core__connectorStorage_updateFlow(mirror, provider, key, updated).flows == core__connectorStorage_updateFlow(projected, provider, key, updated).flows;
  BridgeSameFlows(core__connectorStorage_updateFlow(mirror, provider, key, updated), core__connectorStorage_updateFlow(projected, provider, key, updated));
}

lemma BridgeConsumeFlowKeepsAliases(mirror: core__connectorStorage_ConnectorStore, provider: string, key: string)
  requires core__connectorStorage_alwaysFlowAliasesUnique(mirror)
  requires core__connectorStorage_canConsumeFlow(mirror, provider, key)
  ensures core__connectorStorage_alwaysFlowAliasesUnique(core__connectorStorage_consumeFlow(mirror, provider, key))
{
  var projected := mirror.(accounts := [], ownerBindings := []);
  BridgeFlowOwnerProjection(mirror);
  core__connectorStorage_consumeFlow_ensures(projected, provider, key);
  assert core__connectorStorage_consumeFlow(mirror, provider, key).flows == core__connectorStorage_consumeFlow(projected, provider, key).flows;
  BridgeSameFlows(core__connectorStorage_consumeFlow(mirror, provider, key), core__connectorStorage_consumeFlow(projected, provider, key));
}

lemma BridgeReinsertFlowKeepsAliases(mirror: core__connectorStorage_ConnectorStore, value: core__connectorStorage_FlowValue)
  requires core__connectorStorage_alwaysFlowAliasesUnique(mirror)
  requires core__connectorStorage_canReinsertFlow(mirror, value)
  ensures core__connectorStorage_alwaysFlowAliasesUnique(core__connectorStorage_reinsertFlow(mirror, value))
{
  var projected := mirror.(accounts := [], ownerBindings := []);
  BridgeFlowOwnerProjection(mirror);
  core__connectorStorage_reinsertFlow_ensures(projected, value);
  assert core__connectorStorage_reinsertFlow(mirror, value).flows == core__connectorStorage_reinsertFlow(projected, value).flows;
  BridgeSameFlows(core__connectorStorage_reinsertFlow(mirror, value), core__connectorStorage_reinsertFlow(projected, value));
}

lemma BridgeTerminalAliases(s: OAuthBridge, result: core__connectorStorage_FlowValue, acknowledged: bool)
  requires alwaysMirrorIdentityUnique(s)
  ensures alwaysMirrorIdentityUnique(terminalCleanup(s, result, acknowledged))
{
  var terminal := s.operation.UpdateFlow? && result.id != "" && result.status != core__connectorStorage_FlowStatus.PendingFlow && persistentFlows(s);
  if terminal && acknowledged {
    BridgeDeleteFlowKeepsAliases(s.mirror, result.provider, result.id);
  } else if (s.operation.CreateFlow? || s.operation.UpdateFlow?) && acknowledged && result.hasExpiry && s.hasCaptured {
    BridgeUpdateFlowKeepsAliases(s.mirror, s.provider, s.captured.id, s.captured.(hasExpiry := true, expiresAt := result.expiresAt));
  }
}

lemma beginConsume_ensures(s: OAuthBridge, provider: string, key: string)
  ensures (inv(s) ==> canBeginConsume(s) ==> alwaysOutboundSecretsAbsent(beginConsume(s, provider, key)))
  ensures (inv(s) ==> canBeginConsume(s) ==> alwaysMirrorIdentityUnique(beginConsume(s, provider, key)))
  ensures (inv(s) ==> canBeginConsume(s) ==> alwaysDurableConsumeFailureDoesNotFallback(beginConsume(s, provider, key)))
{
  if inv(s) && canBeginConsume(s) {
    if !s.methods.consume && core__connectorStorage_canConsumeFlow(s.mirror, provider, key) {
      BridgeConsumeFlowKeepsAliases(s.mirror, provider, key);
    }
  }
}

lemma beginDelete_ensures(s: OAuthBridge, provider: string, key: string)
  ensures (inv(s) ==> canBeginDelete(s) ==> alwaysOutboundSecretsAbsent(beginDelete(s, provider, key)))
  ensures (inv(s) ==> canBeginDelete(s) ==> alwaysMirrorIdentityUnique(beginDelete(s, provider, key)))
  ensures (inv(s) ==> canBeginDelete(s) ==> alwaysDurableConsumeFailureDoesNotFallback(beginDelete(s, provider, key)))
{
  if inv(s) && canBeginDelete(s) {
    BridgeDeleteFlowKeepsAliases(s.mirror, provider, key);
  }
}

lemma beginUpdate_ensures(s: OAuthBridge, provider: string, key: string, updated: core__connectorStorage_FlowValue, verifierRef: string)
  ensures (inv(s) ==> canBeginUpdate(s) ==> alwaysOutboundSecretsAbsent(beginUpdate(s, provider, key, updated, verifierRef)))
  ensures (inv(s) ==> canBeginUpdate(s) ==> alwaysMirrorIdentityUnique(beginUpdate(s, provider, key, updated, verifierRef)))
  ensures (inv(s) ==> canBeginUpdate(s) ==> alwaysDurableConsumeFailureDoesNotFallback(beginUpdate(s, provider, key, updated, verifierRef)))
{
  if inv(s) && canBeginUpdate(s) {
    BridgeUpdateFlowKeepsAliases(s.mirror, provider, key, updated);
  }
}

lemma beginCreate_ensures(s: OAuthBridge, value: core__connectorStorage_FlowValue)
  ensures (inv(s) ==> canBeginCreate(s, value) ==> alwaysOutboundSecretsAbsent(beginCreate(s, value)))
  ensures (inv(s) ==> canBeginCreate(s, value) ==> alwaysMirrorIdentityUnique(beginCreate(s, value)))
  ensures (inv(s) ==> canBeginCreate(s, value) ==> alwaysDurableConsumeFailureDoesNotFallback(beginCreate(s, value)))
{
  if inv(s) && canBeginCreate(s, value) {
    if persistentFlows(s) {
      BridgeSweepKeepsAliases(s.mirror);
      BridgeReinsertAfterSweep(s.mirror, value);
      BridgeReinsertFlowKeepsAliases(core__connectorStorage_sweepExpired(s.mirror), value);
    } else {
      BridgeReinsertFlowKeepsAliases(s.mirror, value);
    }
  }
}

lemma terminalCleanup_ensures(s: OAuthBridge, result: core__connectorStorage_FlowValue, acknowledged: bool)
  ensures (inv(s) ==> canTerminalCleanup(s, result, acknowledged) ==> alwaysOutboundSecretsAbsent(terminalCleanup(s, result, acknowledged)))
  ensures (inv(s) ==> canTerminalCleanup(s, result, acknowledged) ==> alwaysMirrorIdentityUnique(terminalCleanup(s, result, acknowledged)))
  ensures (inv(s) ==> canTerminalCleanup(s, result, acknowledged) ==> alwaysDurableConsumeFailureDoesNotFallback(terminalCleanup(s, result, acknowledged)))
{
  if inv(s) && canTerminalCleanup(s, result, acknowledged) {
    BridgeTerminalAliases(s, result, acknowledged);
  }
}

lemma durableResult_ensures(s: OAuthBridge, present: bool, value: core__connectorStorage_FlowValue, succeeded: bool)
  ensures (inv(s) ==> canDurableResult(s) ==> alwaysOutboundSecretsAbsent(durableResult(s, present, value, succeeded)))
  ensures (inv(s) ==> canDurableResult(s) ==> alwaysMirrorIdentityUnique(durableResult(s, present, value, succeeded)))
  ensures (inv(s) ==> canDurableResult(s) ==> alwaysDurableConsumeFailureDoesNotFallback(durableResult(s, present, value, succeeded)))
{
  if inv(s) && canDurableResult(s) {
    var selected := if present then value.(verifier := capturedVerifier(s, value)) else if s.operation.ConsumeFlow? then core__connectorStorage_emptyFlow else s.captured;
    BridgeTerminalAliases(s, selected, present);
  }
}
