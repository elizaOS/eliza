# Durable OAuth bridge and process mirror

`DatabaseConnectorAccountStorage` in `connectors/account-manager.ts` owns an in-memory OAuth mirror beside optional durable adapter methods. The manager's facade queue serializes bridge calls. Other managers may mutate the same durable adapter between awaits, so durable responses are explicit captured values. The stores below embed the canonical [full-value store](./connectorStorage.md); verifier ownership embeds [oauthSecrets](./oauthSecrets.md).

## Story: Preserve one-time flow ownership across durable and process state

### Mirror mutation precedes optional durable calls and captured results remain stable

Create/update/delete first mutate the mirror. Get/consume capture its flow before awaiting the adapter. Durable lookup/update tries flow ID, then state only if the first result is absent. Durable consume returning absent never falls back to a reusable mirror. Without the corresponding adapter method, the mirror supplies that operation. Adapter failure preserves prior mirror mutation and propagates, rather than inventing a successful durable write.

```quint
import connectorStorage as D from "./connectorStorage"
import oauthSecrets as S from "./oauthSecrets"
import accountValues as A from "./accountValues"
type BridgeOperation = NoBridgeOperation | CreateFlow | GetFlow | UpdateFlow | ConsumeFlow | DeleteFlow
type BridgePhase = BridgeIdle | AwaitDurableId | AwaitDurableState | BridgeReturned | BridgeFailed
type AdapterMethods = { create: bool, get: bool, update: bool, consume: bool, delete: bool }
type OAuthBridge = { mirror: D::ConnectorStore, secrets: S::OAuthSecrets, methods: AdapterMethods, phase: BridgePhase, operation: BridgeOperation, provider: str, key: str, captured: D::FlowValue, hasCaptured: bool, result: D::FlowValue, hasResult: bool, deleted: bool, durableAcknowledged: bool, verifierRef: str, outbound: D::FlowValue, hasOutbound: bool, storedVerifier: bool }
pure val initial: OAuthBridge = { mirror: D::initial, secrets: S::initial, methods: { create: false, get: false, update: false, consume: false, delete: false }, phase: BridgeIdle, operation: NoBridgeOperation, provider: "", key: "", captured: D::emptyFlow, hasCaptured: false, result: D::emptyFlow, hasResult: false, deleted: false, durableAcknowledged: false, verifierRef: "", outbound: D::emptyFlow, hasOutbound: false, storedVerifier: false }
pure def canConfigure(s: OAuthBridge): bool = s.phase == BridgeIdle
pure def configure(s: OAuthBridge, methods: AdapterMethods): OAuthBridge = { ...s, methods: methods }
pure def durableOneTimeAuthority(methods: AdapterMethods): bool = methods.create and methods.get and methods.update and methods.consume and methods.delete
pure def persistentFlows(s: OAuthBridge): bool = s.methods.get and s.methods.update
pure def safeMetadata(metadata: A::Metadata): A::Metadata = { ...metadata, entries: metadata.entries.select(entry => entry.key != "codeVerifier" and entry.key != "code_verifier" and entry.key != "oauthCodeVerifier") }
pure def durableValue(value: D::FlowValue): D::FlowValue = { ...value, verifier: A::absentText, metadata: safeMetadata(value.metadata) }
pure def canBeginCreate(s: OAuthBridge, value: D::FlowValue): bool = (s.phase == BridgeIdle or s.phase == BridgeReturned or s.phase == BridgeFailed) and D::canReinsertFlow(s.mirror, value)
pure def beginCreate(s: OAuthBridge, value: D::FlowValue): OAuthBridge = {
  val swept = if (persistentFlows(s)) D::sweepExpired(s.mirror) else s.mirror
  { ...s, mirror: D::reinsertFlow(swept, value), phase: if (s.methods.create) AwaitDurableId else BridgeReturned, operation: CreateFlow, provider: value.provider, key: value.id, captured: value, hasCaptured: true, result: value, hasResult: not(s.methods.create), deleted: false, durableAcknowledged: false, verifierRef: "", outbound: durableValue(value), hasOutbound: s.methods.create }
}
pure def canBeginRead(s: OAuthBridge): bool = s.phase == BridgeIdle or s.phase == BridgeReturned or s.phase == BridgeFailed
pure def beginRead(s: OAuthBridge, provider: str, key: str): OAuthBridge = {
  val captured = D::flowAt(s.mirror, provider, key)
  { ...s, operation: GetFlow, phase: if (s.methods.get) AwaitDurableId else BridgeReturned, provider: provider, key: key, captured: captured, hasCaptured: captured.id != "", result: captured, hasResult: not(s.methods.get) and captured.id != "", durableAcknowledged: false, verifierRef: "" }
}
pure def canBeginUpdate(s: OAuthBridge): bool = s.phase == BridgeIdle or s.phase == BridgeReturned or s.phase == BridgeFailed
pure def beginUpdate(s: OAuthBridge, provider: str, key: str, updated: D::FlowValue, verifierRef: str): OAuthBridge = {
  val mirror = D::updateFlow(s.mirror, provider, key, updated)
  val captured = D::flowAt(mirror, provider, key)
  val withSecret = if (s.methods.update and updated.verifier.present and updated.verifier.text != "") S::storeVerifier(s.secrets, provider, if (captured.id != "") captured.id else key, updated.verifier.text, updated.hasExpiry, updated.expiresAt) else s.secrets
  { ...s, mirror: mirror, secrets: withSecret, operation: UpdateFlow, phase: if (s.methods.update) AwaitDurableId else BridgeReturned, provider: provider, key: key, captured: captured, hasCaptured: captured.id != "", result: captured, hasResult: not(s.methods.update) and captured.id != "", durableAcknowledged: false, verifierRef: verifierRef, outbound: durableValue(updated), hasOutbound: s.methods.update, storedVerifier: s.methods.update and updated.verifier.present and updated.verifier.text != "" }
}
pure def canBeginConsume(s: OAuthBridge): bool = s.phase == BridgeIdle or s.phase == BridgeReturned or s.phase == BridgeFailed
pure def beginConsume(s: OAuthBridge, provider: str, key: str): OAuthBridge = {
  val captured = D::flowAt(s.mirror, provider, key)
  val accepted = not(s.methods.consume) and D::canConsumeFlow(s.mirror, provider, key)
  { ...s, mirror: if (accepted) D::consumeFlow(s.mirror, provider, key) else s.mirror, operation: ConsumeFlow, phase: if (s.methods.consume) AwaitDurableId else BridgeReturned, provider: provider, key: key, captured: captured, hasCaptured: captured.id != "", result: captured, hasResult: accepted, durableAcknowledged: false, verifierRef: "" }
}
pure def canBeginDelete(s: OAuthBridge): bool = s.phase == BridgeIdle or s.phase == BridgeReturned or s.phase == BridgeFailed
pure def beginDelete(s: OAuthBridge, provider: str, key: str): OAuthBridge = { ...s, mirror: D::deleteFlow(s.mirror, provider, key), operation: DeleteFlow, phase: if (s.methods.delete) AwaitDurableId else BridgeReturned, provider: provider, key: key, deleted: D::flowAt(s.mirror, provider, key).id != "", hasResult: false, durableAcknowledged: false, verifierRef: "" }
```

### Durable terminal acknowledgement releases the correct mirror and verifier

A durable row takes precedence over the captured mirror, while the captured raw verifier is restored only in the returned process value. Terminal update clears the mirror only when a durable row acknowledged it. Terminal status still releases the verifier when persistence methods exist and the durable update returned absent. A durable expiry updates the mirror and the currently stored verifier's expiry. A failed adapter call preserves the mirror/secret changes that happened before the await.

```quint
pure def capturedVerifier(s: OAuthBridge, durable: D::FlowValue): A::OptionalText = if (s.captured.verifier.present) s.captured.verifier else durable.verifier
pure def canTerminalCleanup(s: OAuthBridge, result: D::FlowValue, acknowledged: bool): bool = (s.phase == AwaitDurableId or s.phase == AwaitDurableState) and (if (acknowledged) result.provider == s.provider else if (s.operation == ConsumeFlow) result.id == "" else result == s.captured)
pure def terminalCleanup(s: OAuthBridge, result: D::FlowValue, acknowledged: bool): OAuthBridge = {
  val terminal = s.operation == UpdateFlow and result.id != "" and result.status != D::PendingFlow and persistentFlows(s)
  val mirror = if (terminal and acknowledged) D::deleteFlow(s.mirror, result.provider, result.id) else if ((s.operation == CreateFlow or s.operation == UpdateFlow) and acknowledged and result.hasExpiry and s.hasCaptured) D::updateFlow(s.mirror, s.provider, s.captured.id, { ...s.captured, hasExpiry: true, expiresAt: result.expiresAt }) else s.mirror
  val secrets = if (terminal) S::removeVerifier(s.secrets, result.provider, result.id) else if (s.operation == UpdateFlow and acknowledged and result.hasExpiry and s.storedVerifier) S::updateExpiry(s.secrets, s.provider, if (s.captured.id != "") s.captured.id else s.key, result.expiresAt) else s.secrets
  { ...s, mirror: mirror, secrets: secrets, result: result, hasResult: result.id != "", durableAcknowledged: acknowledged, phase: BridgeReturned }
}
pure def canDurableResult(s: OAuthBridge): bool = s.phase == AwaitDurableId or s.phase == AwaitDurableState
pure def durableResult(s: OAuthBridge, present: bool, value: D::FlowValue, succeeded: bool): OAuthBridge = {
  val retryAlias = not(present) and s.phase == AwaitDurableId and (s.operation == GetFlow or s.operation == UpdateFlow or s.operation == DeleteFlow)
  val selected = if (present) { ...value, verifier: capturedVerifier(s, value) } else if (s.operation == ConsumeFlow) D::emptyFlow else s.captured
  if (not(succeeded) or (s.operation == CreateFlow and not(present))) { ...s, phase: BridgeFailed, hasResult: false }
  else if (retryAlias) { ...s, phase: AwaitDurableState }
  else if (s.operation == DeleteFlow) { ...s, phase: BridgeReturned, deleted: s.deleted or present, durableAcknowledged: present }
  else terminalCleanup(s, selected, present)
}
pure def setClock(s: OAuthBridge, now: int): OAuthBridge = { ...s, mirror: D::setClock(s.mirror, now), secrets: S::setClock(s.secrets, now) }
pure def alwaysOutboundSecretsAbsent(s: OAuthBridge): bool = not(s.hasOutbound) or not(s.outbound.verifier.present)
pure def alwaysMirrorIdentityUnique(s: OAuthBridge): bool = D::alwaysFlowAliasesUnique(s.mirror)
pure def alwaysDurableConsumeFailureDoesNotFallback(s: OAuthBridge): bool = s.phase == BridgeReturned and s.operation == ConsumeFlow and s.methods.consume and not(s.durableAcknowledged) implies not(s.hasResult)
pure def sometimesFailedWriteRetainsMirror(s: OAuthBridge): bool = s.phase == BridgeFailed and s.mirror.flows.length() > 0
pure val providerValues = Set("provider1", "provider2")
pure val keyValues = Set("flow1", "state1")
pure val verifierRefValues = Set("verifier1")
pure val valueValues: Set[D::FlowValue] = Set({ ...D::emptyFlow, provider: "provider1", id: "flow1", token: "state1", status: D::PendingFlow }, { ...D::emptyFlow, provider: "provider1", id: "flow1", token: "state1", status: D::CompletedFlow })
pure val updatedValues = valueValues
pure val resultValues = valueValues
pure val methodsValues = Set({ create: false, get: false, update: false, consume: false, delete: false }, { create: true, get: true, update: true, consume: true, delete: true })
```
