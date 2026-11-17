lemma beginConsume_ensures(s: OAuthBridge, provider: string, key: string)
  ensures (inv(s) ==> canBeginConsume(s) ==> alwaysOutboundSecretsAbsent(beginConsume(s, provider, key)))
  ensures (inv(s) ==> canBeginConsume(s) ==> alwaysMirrorIdentityUnique(beginConsume(s, provider, key)))
  ensures (inv(s) ==> canBeginConsume(s) ==> alwaysMirrorKeepsStoreRules(beginConsume(s, provider, key)))
  ensures (inv(s) ==> canBeginConsume(s) ==> alwaysDurableConsumeFailureDoesNotFallback(beginConsume(s, provider, key)))
{
  if inv(s) && !(s.methods.consume) && core__connectorStorage_canConsumeFlow(s.mirror, provider, key) {
    core__connectorStorage_consumeFlow_ensures(s.mirror, provider, key);
  }
}

lemma beginDelete_ensures(s: OAuthBridge, provider: string, key: string)
  ensures (inv(s) ==> canBeginDelete(s) ==> alwaysOutboundSecretsAbsent(beginDelete(s, provider, key)))
  ensures (inv(s) ==> canBeginDelete(s) ==> alwaysMirrorIdentityUnique(beginDelete(s, provider, key)))
  ensures (inv(s) ==> canBeginDelete(s) ==> alwaysMirrorKeepsStoreRules(beginDelete(s, provider, key)))
  ensures (inv(s) ==> canBeginDelete(s) ==> alwaysDurableConsumeFailureDoesNotFallback(beginDelete(s, provider, key)))
{
  core__connectorStorage_deleteFlow_ensures(s.mirror, provider, key);
}

lemma beginCreate_ensures(s: OAuthBridge, value: core__connectorStorage_FlowValue)
  ensures (inv(s) ==> canBeginCreate(s, value) ==> alwaysOutboundSecretsAbsent(beginCreate(s, value)))
  ensures (inv(s) ==> canBeginCreate(s, value) ==> alwaysMirrorIdentityUnique(beginCreate(s, value)))
  ensures (inv(s) ==> canBeginCreate(s, value) ==> alwaysMirrorKeepsStoreRules(beginCreate(s, value)))
  ensures (inv(s) ==> canBeginCreate(s, value) ==> alwaysDurableConsumeFailureDoesNotFallback(beginCreate(s, value)))
{
  if inv(s) && canBeginCreate(s, value) {
    if persistentFlows(s) {
      var swept := core__connectorStorage_sweepExpired(s.mirror);
      core__connectorStorage_sweepExpired_ensures(s.mirror);
      assert swept.flows == ProofLib.Filter((entry: core__connectorStorage_FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > s.mirror.now)), s.mirror.flows);
      forall entry | entry in swept.flows ensures entry in s.mirror.flows {
        ProofLib.FilterMember((entry: core__connectorStorage_FlowEntry) => (((entry.consumed || !(entry.value.hasExpiry)) || (entry.value.expiresAt == 0)) || (entry.value.expiresAt > s.mirror.now)), s.mirror.flows, entry);
      }
      core__connectorStorage_reinsertFlow_ensures(swept, value);
    } else {
      core__connectorStorage_reinsertFlow_ensures(s.mirror, value);
    }
  }
}

lemma beginUpdate_ensures(s: OAuthBridge, provider: string, key: string, updated: core__connectorStorage_FlowValue, verifierRef: string)
  ensures (inv(s) ==> canBeginUpdate(s) ==> alwaysOutboundSecretsAbsent(beginUpdate(s, provider, key, updated, verifierRef)))
  ensures (inv(s) ==> canBeginUpdate(s) ==> alwaysMirrorIdentityUnique(beginUpdate(s, provider, key, updated, verifierRef)))
  ensures (inv(s) ==> canBeginUpdate(s) ==> alwaysMirrorKeepsStoreRules(beginUpdate(s, provider, key, updated, verifierRef)))
  ensures (inv(s) ==> canBeginUpdate(s) ==> alwaysDurableConsumeFailureDoesNotFallback(beginUpdate(s, provider, key, updated, verifierRef)))
{
  core__connectorStorage_updateFlow_ensures(s.mirror, provider, key, updated);
}

lemma terminalCleanup_ensures(s: OAuthBridge, result: core__connectorStorage_FlowValue, acknowledged: bool)
  ensures (inv(s) ==> canTerminalCleanup(s, result, acknowledged) ==> alwaysOutboundSecretsAbsent(terminalCleanup(s, result, acknowledged)))
  ensures (inv(s) ==> canTerminalCleanup(s, result, acknowledged) ==> alwaysMirrorIdentityUnique(terminalCleanup(s, result, acknowledged)))
  ensures (inv(s) ==> canTerminalCleanup(s, result, acknowledged) ==> alwaysMirrorKeepsStoreRules(terminalCleanup(s, result, acknowledged)))
  ensures (inv(s) ==> canTerminalCleanup(s, result, acknowledged) ==> alwaysDurableConsumeFailureDoesNotFallback(terminalCleanup(s, result, acknowledged)))
{
  Cleanup(s, result, acknowledged);
}

lemma durableResult_ensures(s: OAuthBridge, present: bool, value: core__connectorStorage_FlowValue, succeeded: bool)
  ensures (inv(s) ==> canDurableResult(s) ==> alwaysOutboundSecretsAbsent(durableResult(s, present, value, succeeded)))
  ensures (inv(s) ==> canDurableResult(s) ==> alwaysMirrorIdentityUnique(durableResult(s, present, value, succeeded)))
  ensures (inv(s) ==> canDurableResult(s) ==> alwaysMirrorKeepsStoreRules(durableResult(s, present, value, succeeded)))
  ensures (inv(s) ==> canDurableResult(s) ==> alwaysDurableConsumeFailureDoesNotFallback(durableResult(s, present, value, succeeded)))
{
  if inv(s) {
    var selected := if present then value.(verifier := capturedVerifier(s, value)) else (if s.operation.ConsumeFlow? then core__connectorStorage_emptyFlow else s.captured);
    Cleanup(s, selected, present);
  }
}

lemma Cleanup(s: OAuthBridge, result: core__connectorStorage_FlowValue, acknowledged: bool)
  ensures inv(s) ==> alwaysMirrorIdentityUnique(terminalCleanup(s, result, acknowledged)) && alwaysMirrorKeepsStoreRules(terminalCleanup(s, result, acknowledged))
{
  core__connectorStorage_deleteFlow_ensures(s.mirror, result.provider, result.id);
  core__connectorStorage_updateFlow_ensures(s.mirror, s.provider, s.captured.id, s.captured.(hasExpiry := true, expiresAt := result.expiresAt));
}
