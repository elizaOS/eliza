# Connector account and OAuth record ownership

`connectors/account-manager.ts` uses a per-instance account map, a dual-alias OAuth map and consumed-alias set, plus owner bindings. This canonical store is embedded by the database bridge/migration owner; it is not a second copy of their data. Account normalization and patching are defined in [accountValues](./accountValues.md).

## Story: Retain full account and flow values under exact identities

### Account replacement preserves identity ordering and complete values

The account map keys normalized provider and exact account ID. Replacing an existing account preserves insertion order. Account-key alias lookup applies only after no exact ID matches. Full metadata, role, purposes, access policy, timestamps and optional identities are retained in the canonical account value.

```quint
import accountValues as A from "./accountValues"
type FlowStatus = PendingFlow | CompletedFlow | FailedFlow | CancelledFlow
type FlowValue = { provider: str, id: str, token: str, status: FlowStatus, accountId: A::OptionalText, authUrl: A::OptionalText, error: A::OptionalText, redirectUri: A::OptionalText, verifier: A::OptionalText, createdAt: int, updatedAt: int, hasExpiry: bool, expiresAt: int, metadata: A::Metadata }
type FlowEntry = { value: FlowValue, consumed: bool }
type OwnerBinding = { connector: str, externalId: str, instanceId: str, body: str }
type ConnectorStore = { accounts: List[A::AccountValue], flows: List[FlowEntry], ownerBindings: List[OwnerBinding], now: int }
pure val emptyFlow: FlowValue = { provider: "", id: "", token: "", status: CancelledFlow, accountId: A::absentText, authUrl: A::absentText, error: A::absentText, redirectUri: A::absentText, verifier: A::absentText, createdAt: 0, updatedAt: 0, hasExpiry: false, expiresAt: 0, metadata: A::absentMetadata }
pure val noEntry: FlowEntry = { value: emptyFlow, consumed: false }
pure val initial: ConnectorStore = { accounts: List(), flows: List(), ownerBindings: List(), now: 0 }
pure def accountAt(s: ConnectorStore, provider: str, id: str): A::AccountValue = {
  val exact = s.accounts.select(account => account.provider == provider and account.id == id)
  if (exact.length() > 0) exact.nthOr(0, A::emptyAccount) else s.accounts.select(account => account.provider == provider and account.accountKey.present and account.accountKey.text == id).nthOr(0, A::emptyAccount)
}
pure def canUpsertAccount(s: ConnectorStore, account: A::AccountValue): bool = account.provider != "" and account.id != ""
pure def upsertAccount(s: ConnectorStore, account: A::AccountValue): ConnectorStore = { ...s, accounts: if (s.accounts.some(prior => prior.provider == account.provider and prior.id == account.id)) s.accounts.listMap(prior => if (prior.provider == account.provider and prior.id == account.id) account else prior) else s.accounts.append(account) }
pure def deleteAccount(s: ConnectorStore, provider: str, id: str): ConnectorStore = { ...s, accounts: s.accounts.select(account => account.provider != provider or account.id != accountAt(s, provider, id).id) }
pure def bindOwner(s: ConnectorStore, connector: str, externalId: str, instanceId: str, body: str): ConnectorStore = { ...s, ownerBindings: s.ownerBindings.select(binding => binding.connector != connector or binding.externalId != externalId or binding.instanceId != instanceId).append({ connector: connector, externalId: externalId, instanceId: instanceId, body: body }) }
pure def alwaysAccountIdentityUnique(s: ConnectorStore): bool = s.accounts.every(account => s.accounts.select(other => other.provider == account.provider and other.id == account.id).length() == 1)
pure def alwaysOwnerBindingIdentityUnique(s: ConnectorStore): bool = s.ownerBindings.every(binding => s.ownerBindings.select(other => other.connector == binding.connector and other.externalId == binding.externalId and other.instanceId == binding.instanceId).length() == 1)
```

### Pending flow consumption retains both aliases until terminal update

Newly generated flow and state identities are fresh per provider. Identical row reinsertion used by migration preserves insertion position and preserves an existing consumed marker; migration still invokes consumption after insertion. Updating retains provider/ID/state. Consumption requires pending, unconsumed and absent/zero/future expiry. Expired unconsumed rows are swept; consumed pending rows remain addressable. Clearing migration removes accounts, flows and consumed markers but retains owner bindings.

```quint
pure def flowEntry(s: ConnectorStore, provider: str, id: str): FlowEntry = s.flows.select(entry => entry.value.provider == provider and (entry.value.id == id or entry.value.token == id)).nthOr(0, noEntry)
pure def flowAt(s: ConnectorStore, provider: str, id: str): FlowValue = flowEntry(s, provider, id).value
pure def canCreateFlow(s: ConnectorStore, value: FlowValue): bool = value.provider != "" and value.id != "" and value.token != "" and not(s.flows.some(entry => entry.value.provider == value.provider and (entry.value.id == value.id or entry.value.token == value.token or entry.value.id == value.token or entry.value.token == value.id)))
pure def createFlow(s: ConnectorStore, value: FlowValue): ConnectorStore = { ...s, flows: s.flows.append({ value: value, consumed: false }) }
pure def canReinsertFlow(s: ConnectorStore, value: FlowValue): bool = value.provider != "" and value.id != "" and value.token != "" and s.flows.every(entry => entry.value.provider != value.provider or (entry.value.id == value.id and entry.value.token == value.token) or (entry.value.id != value.token and entry.value.token != value.token and entry.value.token != value.id))
pure def reinsertFlow(s: ConnectorStore, value: FlowValue): ConnectorStore = { ...s, flows: if (s.flows.some(entry => entry.value.provider == value.provider and entry.value.id == value.id)) s.flows.listMap(entry => if (entry.value.provider == value.provider and entry.value.id == value.id) { value: value, consumed: entry.consumed } else entry) else s.flows.append({ value: value, consumed: false }) }
pure def canConsumeFlow(s: ConnectorStore, provider: str, token: str): bool = flowAt(s, provider, token).id != "" and flowAt(s, provider, token).status == PendingFlow and not(flowEntry(s, provider, token).consumed) and (not(flowAt(s, provider, token).hasExpiry) or flowAt(s, provider, token).expiresAt == 0 or flowAt(s, provider, token).expiresAt > s.now)
pure def consumeFlow(s: ConnectorStore, provider: str, token: str): ConnectorStore = { ...s, flows: s.flows.listMap(entry => if (entry.value.provider == provider and (entry.value.id == token or entry.value.token == token)) { ...entry, consumed: true } else entry) }
pure def updateFlow(s: ConnectorStore, provider: str, id: str, updated: FlowValue): ConnectorStore = { ...s, flows: s.flows.listMap(entry => if (entry.value.provider == provider and (entry.value.id == id or entry.value.token == id)) { ...entry, value: { ...updated, provider: entry.value.provider, id: entry.value.id, token: entry.value.token, updatedAt: s.now } } else entry) }
pure def deleteFlow(s: ConnectorStore, provider: str, id: str): ConnectorStore = { ...s, flows: s.flows.select(entry => entry.value.provider != provider or (entry.value.id != id and entry.value.token != id)) }
pure def sweepExpired(s: ConnectorStore): ConnectorStore = { ...s, flows: s.flows.select(entry => entry.consumed or not(entry.value.hasExpiry) or entry.value.expiresAt == 0 or entry.value.expiresAt > s.now) }
pure def clearMigrated(s: ConnectorStore): ConnectorStore = { ...s, accounts: List(), flows: List() }
pure def setClock(s: ConnectorStore, now: int): ConnectorStore = { ...s, now: now }
pure def migratableFlows(s: ConnectorStore): List[FlowEntry] = s.flows.select(entry => entry.value.status == PendingFlow and (not(entry.value.hasExpiry) or entry.value.expiresAt == 0 or entry.value.expiresAt > s.now))
pure def alwaysFlowAliasesUnique(s: ConnectorStore): bool = s.flows.every(entry => s.flows.select(other => other.value.provider == entry.value.provider and (other.value.id == entry.value.id or other.value.token == entry.value.token or other.value.id == entry.value.token or other.value.token == entry.value.id)).length() == 1)
pure def sometimesFlowConsumed(s: ConnectorStore): bool = s.flows.some(entry => entry.consumed)
pure def sometimesAccountPersisted(s: ConnectorStore): bool = s.accounts.length() > 0
pure val accountValues: Set[A::AccountValue] = Set({ ...A::emptyAccount, id: "account1", provider: "provider1" }, { ...A::emptyAccount, id: "account2", provider: "provider1" })
pure val valueValues: Set[FlowValue] = Set({ ...emptyFlow, provider: "provider1", id: "flow1", token: "state1", status: PendingFlow }, { ...emptyFlow, provider: "provider1", id: "flow2", token: "state2", status: PendingFlow })
pure val updatedValues = valueValues
pure val providerValues = Set("provider1", "provider2")
pure val tokenValues = Set("state1", "state2")
pure val idValues = Set("flow1", "flow2", "account1")
```
