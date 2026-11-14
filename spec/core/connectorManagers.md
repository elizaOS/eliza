# Connector manager registry and account policy

Source `connectors/account-manager.ts` resolves one manager per actual runtime object, with a separate standalone singleton. A registered compatible service takes precedence over the per-runtime cache. Supplying storage updates the selected manager's explicit storage. Each manager retains a stable storage facade and its own provider registry.

## Story: Resolve account providers through the correct manager

As a host, I want account/provider registration scoped to my runtime and an explicit storage override retained by that manager.

### A runtime cache preserves its manager while a compatible registered service takes precedence

Runtime keys represent object identities. The empty key represents the standalone singleton, which does not inspect a runtime service. Manager identities are fresh process-local references, and provider ids are trimmed and lowercased at the boundary. Registering the same provider replaces that manager's provider object. Unregistering it leaves other managers untouched.

```quint
import accountValues as A from "./accountValues"
type ManagerRecord = { runtime: str, id: int, storage: str }
type ProviderRecord = { manager: int, provider: str, reference: int }
type ConnectorManagers = { nextId: int, managers: List[ManagerRecord], providers: List[ProviderRecord], selected: int }
pure val initial: ConnectorManagers = { nextId: 1, managers: List(), providers: List(), selected: 0 }
pure def resolveManager(s: ConnectorManagers, runtime: str, serviceId: int, storage: str): ConnectorManagers = {
  val cached = s.managers.select(manager => manager.runtime == runtime)
  val selected = if (runtime != "" and serviceId > 0) serviceId else if (cached.length() > 0) cached.nthOr(0, { runtime: runtime, id: 0, storage: "" }).id else s.nextId
  val creates = not(runtime != "" and serviceId > 0) and cached.length() == 0
  { ...s, selected: selected, nextId: if (creates) s.nextId + 1 else s.nextId, managers: if (creates) s.managers.append({ runtime: runtime, id: selected, storage: storage }) else if (storage != "") s.managers.listMap(manager => if (manager.id == selected) { ...manager, storage: storage } else manager) else s.managers }
}
pure def canRegisterProvider(s: ConnectorManagers, manager: int, provider: str, reference: int): bool = manager > 0 and provider != "" and reference > 0
pure def registerProvider(s: ConnectorManagers, manager: int, provider: str, reference: int): ConnectorManagers = { ...s, providers: s.providers.select(entry => entry.manager != manager or entry.provider != provider).append({ manager: manager, provider: provider, reference: reference }) }
pure def unregisterProvider(s: ConnectorManagers, manager: int, provider: str): ConnectorManagers = { ...s, providers: s.providers.select(entry => entry.manager != manager or entry.provider != provider) }
pure def alwaysOneCachedManagerPerRuntime(s: ConnectorManagers): bool = s.managers.every(manager => s.managers.select(other => manager.runtime == other.runtime).length() == 1)
pure def alwaysOneProviderPerManager(s: ConnectorManagers): bool = s.providers.every(entry => s.providers.select(other => other.manager == entry.manager and other.provider == entry.provider).length() == 1)
pure def sometimesIndependentManagers(s: ConnectorManagers): bool = s.managers.length() > 1
pure def sometimesProviderAvailable(s: ConnectorManagers): bool = s.providers.length() > 0
```

### Stored disable and revoke decisions win over provider readiness

When the provider owns status, live provider status replaces a stored status except disabled and revoked. A stored account missing from live inventory becomes pending unless explicitly disabled or revoked. Stored identity, role, purposes and access policy remain authoritative. Ambiguous live identity matches fail with `CONNECTOR_ACCOUNT_AMBIGUOUS`.

```quint
type AccountStatus = AccountConnected | AccountPending | AccountDisabled | AccountRevoked | AccountError
pure def mergedAccountStatus(stored: AccountStatus, provider: AccountStatus, providerOwns: bool, found: bool): AccountStatus = if (not(providerOwns) or stored == AccountDisabled or stored == AccountRevoked) stored else if (found) provider else AccountPending
pure def lawDisabledAccountStaysDisabled(provider: AccountStatus, found: bool): bool = mergedAccountStatus(AccountDisabled, provider, true, found) == AccountDisabled
pure def policyAllows(account: A::AccountValue, policy: A::AccountPolicy, purpose: A::OptionalText, verifiedBinding: bool): bool = A::accountPolicyDenial(account, policy, purpose, verifiedBinding) == A::PolicyAllowed
pure def lawMissingOwnerBindingRefuses(account: A::AccountValue, policy: A::AccountPolicy, purpose: A::OptionalText): bool = account.gate == "owner_binding" implies not(policyAllows(account, policy, purpose, false))
pure val accountValues = A::accountValues
pure val policyValues = A::policyValues
pure val purposeValues = A::purposeValues

```
