# Connector account lifecycle

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/connectors/account-manager.ts`, `packages/core/src/connectors.ts`, `connector-account-catalog.ts`, and `packages/core/src/types/connector-account-policy.ts` and `connector-setup.ts`. A connector account is the agent's link to one identity at one provider, with the credentials that act for it. The full stored records and their OAuth flows are [connector storage](./connectorStorage.md); which manager answers for a provider is [connector managers](./connectorManagers.md); the observations of a handoff in progress are [connector migration](./connectorMigration.md); OAuth completion is [OAuth lifecycle](./oauthLifecycle.md) and its verifiers [OAuth secrets](./oauthSecrets.md).

## Story: Connector account lifecycle

> As a user, I want each identity I connect at a provider to be one account
> of the agent, its credentials gone when I remove it, and every account
> still there after the agent moves from its boot-time store to durable
> storage, so that I never act through a duplicate or a forgotten account.

### Each provider identity is one account

An account is keyed by its provider and the identity the provider reports. Connecting an identity that already has an account updates that account and keeps its identity; it never adds a second. Disabling an account keeps it and its key.

```quint
type Backend = Fallback | Durable
type ConnectorAccount = { id: int, provider: str, identity: str, active: bool }
type ConnectorAccounts = { backend: Backend, fallback: List[ConnectorAccount], durable: List[ConnectorAccount], secrets: List[int], revoked: List[int], nextId: int }
pure val initial: ConnectorAccounts = { backend: Fallback, fallback: List(), durable: List(), secrets: List(), revoked: List(), nextId: 1 }
pure val providerValues = Set("p1", "p2")
pure val identityValues = Set("user-1", "user-2")
pure val idValues = Set(1, 2, 3)
pure def visible(s: ConnectorAccounts): List[ConnectorAccount] = if (s.backend == Fallback) s.fallback else s.durable
pure def withVisible(accounts: List[ConnectorAccount], s: ConnectorAccounts): ConnectorAccounts = if (s.backend == Fallback) { ...s, fallback: accounts } else { ...s, durable: accounts }
pure def holds(s: ConnectorAccounts, id: int): bool = visible(s).some(a => a.id == id)
pure def canConnectIdentity(s: ConnectorAccounts, provider: str, identity: str): bool = provider != "" and identity != ""
pure def connectIdentity(s: ConnectorAccounts, provider: str, identity: str): ConnectorAccounts =
  if (visible(s).some(a => a.provider == provider and a.identity == identity))
    withVisible(visible(s).listMap(a => if (a.provider == provider and a.identity == identity) { ...a, active: true } else a), s)
  else
    { ...withVisible(visible(s).append({ id: s.nextId, provider: provider, identity: identity, active: true }), s), nextId: s.nextId + 1 }
pure def canSetActive(s: ConnectorAccounts, id: int, active: bool): bool = holds(s, id)
pure def setActive(s: ConnectorAccounts, id: int, active: bool): ConnectorAccounts = withVisible(visible(s).listMap(a => if (a.id == id) { ...a, active: active } else a), s)
pure def alwaysOneAccountPerIdentity(s: ConnectorAccounts): bool =
  visible(s).every(a => visible(s).select(b => b.provider == a.provider and b.identity == a.identity).length() == 1 and visible(s).select(b => b.id == a.id).length() == 1 and a.id > 0 and a.id < s.nextId)
pure def sometimesDisabledAccountKept(s: ConnectorAccounts): bool = visible(s).some(a => not(a.active))
```

### Removing an account revokes it and deletes its credentials

Removal first lets the provider revoke the account, then deletes the stored account. No credential outlives the account it acts for, so a removed account can never be used again.

```quint
pure def canStoreSecret(s: ConnectorAccounts, id: int): bool = holds(s, id) and not(s.secrets.includes(id))
pure def storeSecret(s: ConnectorAccounts, id: int): ConnectorAccounts = { ...s, secrets: s.secrets.append(id) }
pure def canRemoveAccount(s: ConnectorAccounts, id: int): bool = holds(s, id)
pure def removeAccount(s: ConnectorAccounts, id: int): ConnectorAccounts =
  { ...withVisible(visible(s).select(a => a.id != id), s), secrets: s.secrets.select(x => x != id), revoked: if (s.revoked.includes(id)) s.revoked else s.revoked.append(id) }
pure def alwaysNoCredentialOutlivesItsAccount(s: ConnectorAccounts): bool = s.secrets.every(id => holds(s, id))
pure def stepRemovalRevokes(before: ConnectorAccounts, after: ConnectorAccounts): bool =
  visible(before).every(a => holds(after, a.id) or after.revoked.includes(a.id))
pure def sometimesRemovedAndRevoked(s: ConnectorAccounts): bool = s.revoked.length() > 0 and s.backend == Durable
```

### Moving to durable storage preserves every account and credential

Before durable storage is ready the agent keeps accounts in a boot-time store. The handoff copies every account into durable storage with its identity and key, keeps every credential, and only then clears the boot-time store; afterwards every operation uses durable storage.

```quint
pure def canMigrate(s: ConnectorAccounts): bool = s.backend == Fallback
pure def migrate(s: ConnectorAccounts): ConnectorAccounts = { ...s, backend: Durable, durable: s.durable.concat(s.fallback), fallback: List() }
pure def stepMigrationPreservesAccounts(before: ConnectorAccounts, via: str, after: ConnectorAccounts): bool =
  via == "migrate" implies (visible(before).every(a => visible(after).includes(a)) and visible(after).every(a => visible(before).includes(a)) and after.secrets == before.secrets)
pure def alwaysDurableStoreAloneAfterHandoff(s: ConnectorAccounts): bool = (s.backend == Durable implies s.fallback.length() == 0) and (s.backend == Fallback implies s.durable.length() == 0)
pure def sometimesMigratedWithCredential(s: ConnectorAccounts): bool = s.backend == Durable and s.secrets.length() > 0
```
