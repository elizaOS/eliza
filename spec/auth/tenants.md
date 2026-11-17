# Tenants

Each branded deployment is a tenant of the identity service. A tenant lists
the redirects sign-in may return to, its registered application clients
(each with its own native Google client ids), the sign-in methods it
enables, and whether people may join it on their own. Only an owner or an
admin with a recent second factor may add or remove any of it.

Product identities are tenant data, never constants of this package.

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
pure val entryValues = Set({ url: "https://app.example.org/auth", https: true, loopback: false }, { url: "http://evil.example/cb", https: false, loopback: false }, { url: "http://127.0.0.1:8123/cb", https: false, loopback: true })
```

### Tenant changes need an owner or admin session with a recent second factor

The actor arrives with whether its second factor is recent, as
[second factor](./mfa.md) defines it.

```quint
type TenantRole = TenantOwner | TenantAdmin | TenantMember
type TenantActor = { role: TenantRole, recentMfa: bool }
type JoinMode = JoinClosed | JoinOpen
type ChangeResult = NoChange | ChangeApplied | ChangeRefused | EntryRefused | RedirectRemoved | NativeIdRemoved | MethodDisabled
type AppClient = { id: str, nativeClientIds: Set[str] }
type DiscoveryRequest = { bodyBytes: int, depth: int, asked: Set[str] }
type TenantConfig = {
  redirects: Set[str], clients: List[AppClient], enabledMethods: Set[str], joinMode: JoinMode, joinChanged: bool, lastActor: TenantActor, result: ChangeResult,
  discovery: DiscoveryRequest, reported: Set[str]
}
pure val nobody: TenantActor = { role: TenantMember, recentMfa: false }
pure val initial: TenantConfig = {
  redirects: Set(), clients: List({ id: "client-1", nativeClientIds: Set() }, { id: "client-2", nativeClientIds: Set() }),
  enabledMethods: Set("email"), joinMode: JoinClosed, joinChanged: false, lastActor: nobody, result: NoChange,
  discovery: { bodyBytes: 0, depth: 0, asked: Set() }, reported: Set()
}
pure def mayChange(actor: TenantActor): bool = (actor.role == TenantOwner or actor.role == TenantAdmin) and actor.recentMfa
pure def addRedirect(s: TenantConfig, actor: TenantActor, entry: RedirectEntry): TenantChange = changeBy(actor, s,
  if (not(listable(entry))) { ...s, result: EntryRefused } else { ...s, redirects: s.redirects.union(Set(entry.url)), result: ChangeApplied })
pure val actorValues = Set({ role: TenantOwner, recentMfa: true }, { role: TenantAdmin, recentMfa: false }, { role: TenantMember, recentMfa: true })
pure def stepChangesNeedRecentOwnerOrAdmin(before: TenantConfig, after: TenantConfig): bool = configChanged(before, after) implies mayChange(after.lastActor)
pure def sometimesMemberRefused(s: TenantConfig): bool = s.result == ChangeRefused and s.lastActor.role == TenantMember
pure def sometimesRedirectListed(s: TenantConfig): bool = s.redirects.size() > 0
```

### Two app clients never share an id, and a tenant's sets hold each entry once

No two app clients of a tenant have the same id. The redirects, the
enabled methods and each client's native client ids are sets, so each
holds an entry once; the rule states that too because the generated code
and its proof keep sets as lists, and the proof that a removal takes at
most one entry rests on it.

```quint
pure def alwaysEntriesListedOnce(s: TenantConfig): bool =
  s.redirects.forall(u => s.redirects.filter(v => v == u).size() == 1) and
    s.enabledMethods.forall(m => s.enabledMethods.filter(n => n == m).size() == 1) and
    s.clients.every(c => s.clients.select(d => d.id == c.id).length() == 1 and c.nativeClientIds.forall(i => c.nativeClientIds.filter(j => j == i).size() == 1))
```

### An app client's native Google client ids are its own, and adding one keeps the others

```quint
pure def canAddNativeClientId(s: TenantConfig, client: str, nativeId: str): bool = nativeId != "" and s.clients.some(c => c.id == client)
pure def addNativeClientId(s: TenantConfig, actor: TenantActor, client: str, nativeId: str): TenantChange = changeBy(actor, s,
  { ...s, clients: s.clients.listMap(c => if (c.id == client) { ...c, nativeClientIds: c.nativeClientIds.union(Set(nativeId)) } else c), result: ChangeApplied })
pure val clientValues = Set("client-1", "client-2")
pure val nativeIdValues = Set("native-a", "native-b")
pure def stepAddingNativeIdKeepsOthers(before: TenantConfig, via: str, after: TenantConfig): bool =
  via == "addNativeClientId" implies before.clients.every(c => after.clients.some(d => d.id == c.id and c.nativeClientIds.subseteq(d.nativeClientIds)))
pure def stepNativeIdsStayWithTheirClient(before: TenantConfig, via: str, after: TenantConfig): bool =
  via == "addNativeClientId" implies after.clients.select(d => before.clients.some(c => c.id == d.id and not(d.nativeClientIds.subseteq(c.nativeClientIds)))).length() <= 1
pure def sometimesTwoNativeIdsOnOneClient(s: TenantConfig): bool = s.clients.some(c => c.nativeClientIds.size() == 2)
```

### Provider discovery reports only the methods the tenant enables, within a bounded request

A discovery request names the methods it asks about; the answer is those
of them the tenant enables. An oversized or too deeply nested request is
refused and reports nothing.

```quint
pure val maxDiscoveryBody = 4096
pure val maxDiscoveryDepth = 4
pure def discoveryAccepted(request: DiscoveryRequest): bool = request.bodyBytes >= 0 and request.bodyBytes <= maxDiscoveryBody and request.depth <= maxDiscoveryDepth
pure def discover(s: TenantConfig, request: DiscoveryRequest): TenantConfig =
  { ...s, discovery: request, reported: if (discoveryAccepted(request)) request.asked.intersect(s.enabledMethods) else Set() }
pure val requestValues = Set({ bodyBytes: 512, depth: 2, asked: Set("email", "google", "sms") }, { bodyBytes: 8192, depth: 2, asked: Set("email") }, { bodyBytes: 512, depth: 9, asked: Set("email") })
pure def canEnableMethod(s: TenantConfig, method: str): bool = method != ""
pure def enableMethod(s: TenantConfig, actor: TenantActor, method: str): TenantChange = changeBy(actor, s,
  { ...s, enabledMethods: s.enabledMethods.union(Set(method)), result: ChangeApplied })
pure val methodValues = Set("google", "sms")
pure def stepDiscoveryReportsOnlyEnabled(before: TenantConfig, via: str, after: TenantConfig): bool =
  via == "discover" implies (after.reported.subseteq(before.enabledMethods.intersect(after.discovery.asked)) and (not(discoveryAccepted(after.discovery)) implies after.reported.size() == 0))
pure def sometimesGoogleEnabled(s: TenantConfig): bool = s.enabledMethods.contains("google")
pure def sometimesDiscoveryLeavesOutDisabledMethod(s: TenantConfig): bool = s.discovery.asked.contains("sms") and not(s.reported.contains("sms")) and s.reported.contains("email")
pure def sometimesOversizedDiscoveryRefused(s: TenantConfig): bool = not(discoveryAccepted(s.discovery)) and s.discovery.asked.size() > 0
```

### Joining a tenant is closed until an owner or admin opens it

```quint
pure def setJoinMode(s: TenantConfig, actor: TenantActor, mode: JoinMode): TenantChange = changeBy(actor, s,
  { ...s, joinMode: mode, joinChanged: true, result: ChangeApplied })
pure def alwaysJoinClosedUntilChanged(s: TenantConfig): bool = s.joinMode != JoinClosed implies s.joinChanged
pure def sometimesJoinOpened(s: TenantConfig): bool = s.joinMode == JoinOpen
```

### An owner or admin with a recent second factor can remove a redirect, a native client id or a method

A leaked or retired entry is revoked by removing it; removing an entry
that is not there changes nothing.

```quint
pure def removal(present: bool, removed: ChangeResult, s: TenantConfig): TenantConfig = { ...s, result: if (present) removed else NoChange }
pure def removeRedirect(s: TenantConfig, actor: TenantActor, url: str): TenantChange = changeBy(actor, s,
  removal(s.redirects.contains(url), RedirectRemoved, { ...s, redirects: s.redirects.exclude(Set(url)) }))
pure val urlValues = Set("https://app.example.org/auth")
pure def canRemoveNativeClientId(s: TenantConfig, actor: TenantActor, client: str, nativeId: str): bool = s.clients.some(c => c.id == client)
pure def removeNativeClientId(s: TenantConfig, actor: TenantActor, client: str, nativeId: str): TenantChange = changeBy(actor, s,
  removal(s.clients.some(c => c.id == client and c.nativeClientIds.contains(nativeId)), NativeIdRemoved,
    { ...s, clients: s.clients.listMap(c => if (c.id == client) { ...c, nativeClientIds: c.nativeClientIds.exclude(Set(nativeId)) } else c) }))
pure def disableMethod(s: TenantConfig, actor: TenantActor, method: str): TenantChange = changeBy(actor, s,
  removal(s.enabledMethods.contains(method), MethodDisabled, { ...s, enabledMethods: s.enabledMethods.exclude(Set(method)) }))
pure def removedAtMostOne(before: Set[str], after: Set[str]): bool = after.subseteq(before) and before.size() - after.size() <= 1
pure def stepRemovalTakesOnlyTheNamedEntry(before: TenantConfig, via: str, after: TenantConfig): bool =
  (via == "removeRedirect" implies removedAtMostOne(before.redirects, after.redirects)) and
    (via == "disableMethod" implies removedAtMostOne(before.enabledMethods, after.enabledMethods)) and
    (via == "removeNativeClientId" implies (after.clients.length() == before.clients.length() and
      after.clients.select(d => before.clients.some(c => c.id == d.id and not(sameSet(c.nativeClientIds, d.nativeClientIds)))).length() <= 1 and
      before.clients.every(c => after.clients.some(d => d.id == c.id and removedAtMostOne(c.nativeClientIds, d.nativeClientIds))))) and
    (after.result == NoChange implies not(configChanged(before, after)))
pure def sometimesRedirectRemoved(s: TenantConfig): bool = s.result == RedirectRemoved and s.redirects.size() == 0
pure def sometimesNativeIdRemoved(s: TenantConfig): bool = s.result == NativeIdRemoved and s.clients.some(c => c.nativeClientIds.size() == 1)
pure def sometimesAbsentEntryRemovalChangesNothing(s: TenantConfig): bool = s.result == NoChange and s.lastActor.recentMfa
```

### Every applied tenant change is written to the audit log

Each change that takes effect emits one entry for the
[audit log](./audit.md); a refused change emits none.

```quint
type AuditEntry = TenantChangeApplied | TenantEntryRemoved
type TenantChange = { state: TenantConfig, out: List[AuditEntry] }
pure def auditEntries(result: ChangeResult): List[AuditEntry] =
  if (result == ChangeApplied) List(TenantChangeApplied)
  else if (result == RedirectRemoved or result == NativeIdRemoved or result == MethodDisabled) List(TenantEntryRemoved)
  else List()
pure def changeBy(actor: TenantActor, s: TenantConfig, permitted: TenantConfig): TenantChange = {
  val settledChange = if (mayChange(actor)) { ...permitted, lastActor: actor } else { ...s, lastActor: actor, result: ChangeRefused }
  { state: settledChange, out: auditEntries(settledChange.result) }
}
pure def sameSet(a: Set[str], b: Set[str]): bool = a.subseteq(b) and b.subseteq(a)
pure def configChanged(before: TenantConfig, after: TenantConfig): bool =
  not(sameSet(before.redirects, after.redirects)) or after.joinMode != before.joinMode or not(sameSet(before.enabledMethods, after.enabledMethods))
    or after.clients.listMap(c => c.nativeClientIds.size()) != before.clients.listMap(c => c.nativeClientIds.size())
pure def stepChangeIsAudited(before: TenantConfig, after: TenantConfig, out: List[AuditEntry]): bool =
  (configChanged(before, after) implies out.length() == 1) and ((after.result == ChangeRefused or after.result == EntryRefused) implies out.length() == 0)
```
