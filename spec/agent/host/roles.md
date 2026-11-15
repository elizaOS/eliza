# Role bootstrap

At boot and whenever a connector reports a new world, the host makes sure
the canonical owner holds the owner role and that a connector account holds
the admin role exactly when the owner's allowlist names it. Bootstrap
requests that arrive while one is pending coalesce into it. When storage is
unavailable the host retries a bounded number of times and then gives up
until the next request. The research baseline is
`packages/agent/src/runtime/roles.ts`, the kernel's role compare-and-set
write, and the `runtime-role-bootstrap` model.

## Story: Keep roles in step with the owner's allowlist

> As the owner, I hold the owner role on every world my agent joins, and a
> connector account I allow is an admin only while I allow it.

### A bootstrap request coalesces with one that is pending

```quint
type Role = Guest | Admin | OwnerRole
type Roles = { ownerRole: Role, connectorRole: Role, allowlisted: bool, pending: bool, attempt: int, synced: bool, requests: int }
pure val initial: Roles = { ownerRole: Guest, connectorRole: Guest, allowlisted: false, pending: false, attempt: 0, synced: false, requests: 0 }
pure def canRequestBootstrap(r: Roles): bool = not(r.pending)
pure def requestBootstrap(r: Roles): Roles = { ...r, pending: true, attempt: 0, synced: false, requests: r.requests + 1 }
pure def stepPendingBootstrapCoalesces(before: Roles, after: Roles): bool = before.pending and after.pending implies after.requests == before.requests
```

### Changing the allowlist makes the roles out of date until the next bootstrap

```quint
pure def canSetAllowlist(r: Roles, allowed: bool): bool = r.allowlisted != allowed
pure def setAllowlist(r: Roles, allowed: bool): Roles = { ...r, allowlisted: allowed, synced: false }
pure def stepAllowlistChangeUnsyncs(before: Roles, after: Roles): bool =
  after.allowlisted != before.allowlisted implies not(after.synced)
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

### After a bootstrap the owner holds the owner role and the connector is admin exactly when allowlisted

A connector account never receives the owner role.

```quint
pure def canSynchronize(r: Roles): bool = r.pending
pure def synchronize(r: Roles): Roles =
  { ...r, ownerRole: OwnerRole, connectorRole: if (r.allowlisted) Admin else Guest, pending: false, synced: true }
pure def alwaysSyncedRolesAreExact(r: Roles): bool =
  r.connectorRole != OwnerRole and (r.synced implies r.ownerRole == OwnerRole and ((r.connectorRole == Admin) iff r.allowlisted))
pure def sometimesAdminGranted(r: Roles): bool = r.synced and r.connectorRole == Admin
pure def sometimesAdminRevoked(r: Roles): bool = r.synced and r.connectorRole == Guest and r.requests >= 2
```
