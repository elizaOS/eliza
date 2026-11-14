# First-party catalog

Source contracts are `catalog/{registry,loader,schema,runtime-kernel,apps,generate}.ts`. The generated JSON assets, entry schemas, app-session types, package-name parsing, connector authentication normalization, display order, search scoring and freshness policy remain public compatibility obligations.

## Story: Discover and register first-party capabilities

As a host or plugin, I want validated catalog entries with deterministic runtime overrides and consistent lookup indexes.

### A valid runtime registration overrides its id and invalidates cached indexes

`registerRegistryEntry` validates and normalizes before mutation. Re-registering the same id replaces its entry. Bundled entries remain the fallback. Loading rebuilds indexes after a registration. Missing packaged catalog data produces the source's explicit warning and empty bundled set. Malformed existing JSON or duplicate bundled ids fails with the source error contract.

```quint
type Registry = { bundled: str -> int, contributed: str -> int, contributedIds: Set[str], cached: bool }
pure val initial: Registry = { bundled: Map(), contributed: Map(), contributedIds: Set(), cached: false }
pure def canRegister(r: Registry, valid: bool): bool = valid
pure def register(r: Registry, id: str, version: int, valid: bool): Registry = { ...r, contributed: r.contributed.put(id, version), contributedIds: r.contributedIds.union(Set(id)), cached: false }
pure def load(r: Registry): Registry = { ...r, cached: true }
pure def lookup(r: Registry, id: str): int = if (r.contributed.keys().contains(id)) r.contributed.get(id) else r.bundled.getOr(id, -1)
pure def stepRegistrationDropsCache(before: Registry, via: str, after: Registry): bool = via == "register" implies not(after.cached)
pure val rValues = Set(initial)
pure def lawRuntimeEntryWins(r: Registry, id: str, version: int): bool = lookup(register(r, id, version, true), id) == version
pure def sometimesCatalogCached(r: Registry): bool = r.cached
pure def sometimesCatalogContributed(r: Registry): bool = r.contributedIds.size() > 0
```

### Legacy connector authentication fills only the missing agent account

An explicitly configured agent account wins. A legacy OAuth mode maps to cloud OAuth, token and credentials map to API key, and none remains none. Owner account configuration survives normalization.

```quint
type LegacyAuth = Token | OAuth | Credentials | NoAuth
type AccountAuth = ApiKey | CloudOAuth | AccountNone
pure def normalizeAuth(auth: LegacyAuth): AccountAuth = if (auth == OAuth) CloudOAuth else if (auth == NoAuth) AccountNone else ApiKey
pure def agentAuth(explicit: bool, configured: AccountAuth, legacy: LegacyAuth): AccountAuth = if (explicit) configured else normalizeAuth(legacy)
pure def lawExplicitAgentAuthWins(configured: AccountAuth, legacy: LegacyAuth): bool = agentAuth(true, configured, legacy) == configured
pure def lawOAuthMigration(auth: LegacyAuth): bool = auth == OAuth implies normalizeAuth(auth) == CloudOAuth
```
