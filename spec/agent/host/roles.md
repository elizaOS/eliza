# Role bootstrap

At boot and whenever a connector reports a new world, the host makes sure
the canonical owner holds the owner role and that a connector account holds
the admin role exactly when the owner's allowlist names it. Bootstrap
requests that arrive while one is pending coalesce into it. When storage is
unavailable the host retries a bounded number of times and then gives up
until the next request.

## Story: Keep roles in step with the owner's allowlist

> As the owner, I hold the owner role on every world my agent joins, and a
> connector account I allow is an admin only while I allow it.

### A bootstrap request coalesces with one that is pending

```quint
type Role = Guest | Admin | OwnerRole
type Roles = { ownerRole: Role, connectorRoles: int -> Role, allowlisted: Set[int], pending: bool, attempt: int, synced: bool, requests: int }
pure val accounts = Set(1, 2)
pure val initial: Roles = { ownerRole: Guest, connectorRoles: Map(1 -> Guest, 2 -> Guest), allowlisted: Set(), pending: false, attempt: 0, synced: false, requests: 0 }
pure def roleOf(r: Roles, account: int): Role = r.connectorRoles.getOr(account, Guest)
pure def canRequestBootstrap(r: Roles): bool = not(r.pending)
pure def requestBootstrap(r: Roles): Roles = { ...r, pending: true, attempt: 0, synced: false, requests: r.requests + 1 }
pure def stepPendingBootstrapCoalesces(before: Roles, after: Roles): bool = before.pending and after.pending implies after.requests == before.requests
```

### Changing the allowlist makes the roles out of date until the next bootstrap

The owner allows or disallows one account at a time; the others keep
their place on the allowlist.

```quint
pure val accountValues = accounts
pure def canSetAllowlist(r: Roles, account: int, allowed: bool): bool = accounts.contains(account) and r.allowlisted.contains(account) != allowed
pure def setAllowlist(r: Roles, account: int, allowed: bool): Roles =
  { ...r, allowlisted: if (allowed) r.allowlisted.union(Set(account)) else r.allowlisted.exclude(Set(account)), synced: false }
pure def stepAllowlistChangeUnsyncs(before: Roles, after: Roles): bool =
  not(after.allowlisted.subseteq(before.allowlisted) and before.allowlisted.subseteq(after.allowlisted)) implies not(after.synced)
pure def stepAllowlistChangesOneAccount(before: Roles, after: Roles): bool =
  accounts.filter(a => before.allowlisted.contains(a) != after.allowlisted.contains(a)).size() <= 1
```

### A bootstrap retries unavailable storage at most three times

```quint
pure val retryLimit = 3
pure def canStorageUnavailable(r: Roles): bool = r.pending and r.attempt < retryLimit
pure def storageUnavailable(r: Roles): Roles = { ...r, attempt: r.attempt + 1 }
pure def canGiveUp(r: Roles): bool = r.pending and r.attempt == retryLimit
pure def giveUp(r: Roles): Roles = { ...r, pending: false }
pure def alwaysRetriesBounded(r: Roles): bool = r.attempt >= 0 and r.attempt <= retryLimit
pure def sometimesGaveUp(r: Roles): bool = not(r.pending) and r.attempt == retryLimit and not(r.synced)
```

### After a bootstrap the owner holds the owner role and each connector account is admin exactly when allowlisted

A connector account never receives the owner role.

```quint
pure def syncedRole(r: Roles, account: int): Role = if (r.allowlisted.contains(account)) Admin else Guest
pure def canSynchronize(r: Roles): bool = r.pending
pure def synchronize(r: Roles): Roles =
  { ...r, ownerRole: OwnerRole, connectorRoles: Map(1 -> syncedRole(r, 1), 2 -> syncedRole(r, 2)), pending: false, synced: true }
pure def alwaysSyncedRolesAreExact(r: Roles): bool =
  accounts.forall(a => roleOf(r, a) != OwnerRole and (r.synced implies ((roleOf(r, a) == Admin) iff r.allowlisted.contains(a)))) and
  (r.synced implies r.ownerRole == OwnerRole)
pure def sometimesAdminGranted(r: Roles): bool = r.synced and roleOf(r, 1) == Admin
pure def sometimesAdminRevokedOtherKept(r: Roles): bool = r.synced and roleOf(r, 1) == Guest and roleOf(r, 2) == Admin and r.requests >= 2
```
