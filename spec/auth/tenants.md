# Tenants

Each branded deployment is a tenant of the identity service. A tenant lists
the redirects sign-in may return to, its registered application clients
(each with its own native Google client ids), the sign-in methods it
enables, and whether people may join it on their own. Only an owner or an
admin with a recent second factor may change any of it.

New in v4, from develop `src/server/routes/tenant-config.ts`, `tenants.ts`
and the provider discovery route. Product identities are tenant data, never
constants of this package.

## Story: Configure a branded deployment's tenant, app clients and allowed returns

> As the owner of a branded deployment, I want sign-in to return only to the
> addresses I registered and to offer only the methods I enabled, and I want
> only owners and admins who just confirmed a second factor to change that.

### A redirect is accepted only on an exact allowlist entry, HTTPS or loopback

Only HTTPS addresses and loopback addresses with their exact port can be
listed, and a return address must equal a listed entry exactly: no prefix,
wildcard or host match.

```quint
type RedirectEntry = { url: str, https: bool, loopback: bool }
pure def listable(entry: RedirectEntry): bool = entry.url != "" and (entry.https or entry.loopback)
pure def redirectAccepted(allowlist: Set[str], candidate: str): bool = candidate != "" and allowlist.contains(candidate)
pure def lawOnlyExactEntriesAccepted(allowlist: Set[str], candidate: str): bool = redirectAccepted(allowlist, candidate) implies allowlist.contains(candidate)
pure def lawPlainHttpNeverListed(entry: RedirectEntry): bool = (not(entry.https) and not(entry.loopback)) implies not(listable(entry))
pure val allowlistValues = Set(Set("https://app.example.org/auth"), Set("https://app.example.org/auth", "http://127.0.0.1:8123/cb"))
pure val candidateValues = Set("https://app.example.org/auth", "https://app.example.org/auth/x", "http://127.0.0.1:9999/cb")
pure val entryValues = Set({ url: "https://app.example.org/auth", https: true, loopback: false }, { url: "http://evil.example/cb", https: false, loopback: false }, { url: "http://127.0.0.1:8123/cb", https: false, loopback: true })
```

### Tenant changes need an owner or admin session with a recent second factor

```quint
type TenantRole = TenantOwner | TenantAdmin | TenantMember
type TenantActor = { role: TenantRole, recentMfa: bool }
type JoinMode = JoinClosed | JoinOpen | JoinByInvite
type ChangeResult = NoChange | ChangeApplied | ChangeRefused | EntryRefused
type AppClient = { id: str, nativeClientIds: Set[str] }
type TenantConfig = { redirects: Set[str], clients: List[AppClient], enabledMethods: Set[str], joinMode: JoinMode, joinChanged: bool, lastActor: TenantActor, result: ChangeResult }
pure val nobody: TenantActor = { role: TenantMember, recentMfa: false }
pure val initial: TenantConfig = {
  redirects: Set(), clients: List({ id: "client-1", nativeClientIds: Set() }, { id: "client-2", nativeClientIds: Set() }),
  enabledMethods: Set("email"), joinMode: JoinClosed, joinChanged: false, lastActor: nobody, result: NoChange
}
pure def mayChange(actor: TenantActor): bool = (actor.role == TenantOwner or actor.role == TenantAdmin) and actor.recentMfa
pure def addRedirect(s: TenantConfig, actor: TenantActor, entry: RedirectEntry): TenantConfig =
  if (not(mayChange(actor))) { ...s, lastActor: actor, result: ChangeRefused }
  else if (not(listable(entry))) { ...s, lastActor: actor, result: EntryRefused }
  else { ...s, redirects: s.redirects.union(Set(entry.url)), lastActor: actor, result: ChangeApplied }
pure val actorValues = Set({ role: TenantOwner, recentMfa: true }, { role: TenantAdmin, recentMfa: false }, { role: TenantMember, recentMfa: true })
pure def stepChangesNeedRecentOwnerOrAdmin(before: TenantConfig, after: TenantConfig): bool =
  (not(after.redirects.subseteq(before.redirects) and before.redirects.subseteq(after.redirects)) or after.joinMode != before.joinMode
    or not(after.enabledMethods.subseteq(before.enabledMethods) and before.enabledMethods.subseteq(after.enabledMethods))
    or after.clients.listMap(c => c.nativeClientIds.size()) != before.clients.listMap(c => c.nativeClientIds.size()))
    implies mayChange(after.lastActor)
pure def sometimesMemberRefused(s: TenantConfig): bool = s.result == ChangeRefused and s.lastActor.role == TenantMember
pure def sometimesRedirectListed(s: TenantConfig): bool = s.redirects.size() > 0
```

### An app client's native Google client ids are its own, and adding one keeps the others

```quint
pure def canAddNativeClientId(s: TenantConfig, client: str, nativeId: str): bool = nativeId != "" and s.clients.some(c => c.id == client)
pure def addNativeClientId(s: TenantConfig, actor: TenantActor, client: str, nativeId: str): TenantConfig =
  if (not(mayChange(actor))) { ...s, lastActor: actor, result: ChangeRefused }
  else { ...s, clients: s.clients.listMap(c => if (c.id == client) { ...c, nativeClientIds: c.nativeClientIds.union(Set(nativeId)) } else c), lastActor: actor, result: ChangeApplied }
pure val clientValues = Set("client-1", "client-2")
pure val nativeIdValues = Set("native-a", "native-b")
pure def stepNativeIdsAreKept(before: TenantConfig, after: TenantConfig): bool =
  before.clients.every(c => after.clients.some(d => d.id == c.id and c.nativeClientIds.subseteq(d.nativeClientIds)))
pure def stepNativeIdsStayWithTheirClient(before: TenantConfig, via: str, after: TenantConfig): bool =
  via == "addNativeClientId" implies after.clients.select(d => before.clients.some(c => c.id == d.id and not(d.nativeClientIds.subseteq(c.nativeClientIds)))).length() <= 1
pure def sometimesTwoNativeIdsOnOneClient(s: TenantConfig): bool = s.clients.some(c => c.nativeClientIds.size() == 2)
```

### Provider discovery reports only the methods the tenant enables, within a bounded request

```quint
type DiscoveryRequest = { bodyBytes: int, depth: int }
pure val maxDiscoveryBody = 4096
pure val maxDiscoveryDepth = 4
pure def discoveryAccepted(request: DiscoveryRequest): bool = request.bodyBytes >= 0 and request.bodyBytes <= maxDiscoveryBody and request.depth <= maxDiscoveryDepth
pure def reportedMethods(offered: Set[str], supported: Set[str]): Set[str] = offered.intersect(supported)
pure def lawDiscoveryReportsOnlyEnabled(offered: Set[str], supported: Set[str]): bool = reportedMethods(offered, supported).subseteq(offered)
pure def lawOversizedDiscoveryRefused(request: DiscoveryRequest): bool = (request.bodyBytes > maxDiscoveryBody or request.depth > maxDiscoveryDepth) implies not(discoveryAccepted(request))
pure val offeredValues = Set(Set("email"), Set("email", "google"))
pure val supportedValues = Set(Set("email", "sms", "google"), Set("sms"))
pure val requestValues = Set({ bodyBytes: 10, depth: 1 }, { bodyBytes: 5000, depth: 1 }, { bodyBytes: 10, depth: 9 })
pure def canEnableMethod(s: TenantConfig, method: str): bool = method != ""
pure def enableMethod(s: TenantConfig, actor: TenantActor, method: str): TenantConfig =
  if (not(mayChange(actor))) { ...s, lastActor: actor, result: ChangeRefused }
  else { ...s, enabledMethods: s.enabledMethods.union(Set(method)), lastActor: actor, result: ChangeApplied }
pure val methodValues = Set("google", "sms")
pure def sometimesGoogleEnabled(s: TenantConfig): bool = s.enabledMethods.contains("google")
```

### Joining a tenant is closed until an owner or admin opens it

```quint
pure def setJoinMode(s: TenantConfig, actor: TenantActor, mode: JoinMode): TenantConfig =
  if (not(mayChange(actor))) { ...s, lastActor: actor, result: ChangeRefused }
  else { ...s, joinMode: mode, joinChanged: true, lastActor: actor, result: ChangeApplied }
pure def alwaysJoinClosedUntilChanged(s: TenantConfig): bool = s.joinMode != JoinClosed implies s.joinChanged
pure def sometimesJoinOpened(s: TenantConfig): bool = s.joinMode == JoinOpen
```
