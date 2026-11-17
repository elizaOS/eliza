# Identity cutover from v3

Eliza v3 ran its identity service under a different name, and that name
was in its routes, token issuer and claims, database columns, browser
storage keys, cookies and device secure-storage slot. v4 renames all of it
to `auth` in one cutover, with no aliases: one path only. The service
renames its columns in one migration that keeps every account mapping,
then accepts only tokens of the v4 issuer, so every v3 session ends. A
device starting v4 deletes the v3 session state it finds without reading it
as a v4 session, and the person signs in again.

The renamed state is the service's routes, token issuer and claims (`auth`),
the columns `auth_user_id`, `auth_tenant_id` and `auth_tenant_api_key`, the
browser storage keys and cookies, and the device's `session.auth_token`
secure slot. [Secure slots](./secureSlots.md) and
[platform users](./platformUsers.md) hold it.

## Story: Move every installation to the v4 identity names without splitting an account

> As a person upgrading to v4, I accept signing in once more, but I want to
> keep exactly the account I had, and no old token, cookie or stored session
> to keep working or to be mistaken for a new one.

### The column rename runs in one migration and keeps every account mapping

A failed migration leaves the v3 columns and the v3 service as they were.

```quint
type ServerPhase = ServingV3 | Migrating | ServingV4
type ColumnNames = LegacyColumns | AuthColumns
type AccountMapping = { cloudUser: int, identityUser: int, organization: int, tenant: int }
type Issuer = LegacyIssuer | AuthIssuer
type DeviceSession = NoDeviceSession | LegacySession | AuthSession
type Device = { id: int, version: int, legacyToken: bool, legacyCookie: bool, legacySlot: bool, session: DeviceSession }
type TokenCheck = { issuer: Issuer, accepted: bool, phase: ServerPhase }
type NameGeneration = V3Name | V4Name
type NameLookup = { name: NameGeneration, found: bool, phase: ServerPhase }
type StateMigration = { server: ServerPhase, columns: ColumnNames, mappings: List[AccountMapping], devices: List[Device], checks: List[TokenCheck], lookups: List[NameLookup], failedMigrations: int }
pure val initial: StateMigration = {
  server: ServingV3, columns: LegacyColumns,
  mappings: List({ cloudUser: 1, identityUser: 11, organization: 1, tenant: 21 }, { cloudUser: 2, identityUser: 12, organization: 1, tenant: 21 }),
  devices: List({ id: 1, version: 3, legacyToken: true, legacyCookie: true, legacySlot: true, session: LegacySession }, { id: 2, version: 3, legacyToken: false, legacyCookie: true, legacySlot: false, session: LegacySession }),
  checks: List(), lookups: List(), failedMigrations: 0
}
pure def canBeginMigration(s: StateMigration): bool = s.server == ServingV3
pure def beginMigration(s: StateMigration): StateMigration = { ...s, server: Migrating }
pure def canRenameColumns(s: StateMigration, fails: bool): bool = s.server == Migrating
pure def renameColumns(s: StateMigration, fails: bool): StateMigration =
  if (fails) { ...s, server: ServingV3, columns: LegacyColumns, failedMigrations: s.failedMigrations + 1 } else { ...s, server: ServingV4, columns: AuthColumns }
pure def stepMappingsNeverChange(before: StateMigration, after: StateMigration): bool = after.mappings == before.mappings
pure def alwaysColumnsMatchTheService(s: StateMigration): bool = (s.columns == AuthColumns) iff (s.server == ServingV4)
pure def sometimesFailedMigrationRolledBack(s: StateMigration): bool = s.failedMigrations > 0 and s.server == ServingV3
pure def sometimesCutOver(s: StateMigration): bool = s.server == ServingV4
```

### After the cutover only tokens of the v4 issuer are accepted, and none during the migration

```quint
pure def tokenAccepted(server: ServerPhase, issuer: Issuer): bool = (server == ServingV3 and issuer == LegacyIssuer) or (server == ServingV4 and issuer == AuthIssuer)
pure def verifyToken(s: StateMigration, issuer: Issuer): StateMigration = { ...s, checks: s.checks.append({ issuer: issuer, accepted: tokenAccepted(s.server, issuer), phase: s.server }) }
pure def alwaysAcceptedTokensMatchTheirPhase(s: StateMigration): bool =
  s.checks.every(c => c.accepted implies ((c.phase == ServingV4 and c.issuer == AuthIssuer) or (c.phase == ServingV3 and c.issuer == LegacyIssuer)))
pure def sometimesLegacyTokenRefusedAfterCutover(s: StateMigration): bool = s.checks.some(c => c.phase == ServingV4 and c.issuer == LegacyIssuer and not(c.accepted))
```

### A device starting v4 deletes its v3 session state without adopting it, and its person signs in again

```quint
pure def canDeviceStartsV4(s: StateMigration, device: int): bool = s.devices.some(d => d.id == device and d.version == 3)
pure def deviceStartsV4(s: StateMigration, device: int): StateMigration =
  { ...s, devices: s.devices.listMap(d => if (d.id == device) { ...d, version: 4, legacyToken: false, legacyCookie: false, legacySlot: false, session: NoDeviceSession } else d) }
pure def canDeviceSignsIn(s: StateMigration, device: int): bool = s.server == ServingV4 and s.devices.some(d => d.id == device and d.version == 4)
pure def deviceSignsIn(s: StateMigration, device: int): StateMigration = { ...s, devices: s.devices.listMap(d => if (d.id == device) { ...d, session: AuthSession } else d) }
pure val deviceValues = Set(1, 2)
pure def alwaysV4DeviceHoldsNoLegacyState(s: StateMigration): bool =
  s.devices.every(d => d.version == 4 implies (not(d.legacyToken) and not(d.legacyCookie) and not(d.legacySlot) and d.session != LegacySession))
pure def alwaysAuthSessionNeedsTheCutover(s: StateMigration): bool = s.devices.every(d => d.session == AuthSession implies (d.version == 4 and s.server == ServingV4))
pure def sometimesDeviceSignedInAgain(s: StateMigration): bool = s.devices.some(d => d.session == AuthSession)
```

### No two devices share an id

```quint
pure def alwaysDeviceIdsUnique(s: StateMigration): bool = s.devices.every(d => s.devices.select(o => o.id == d.id).length() == 1)
```

### The v3 names are not served in v4: no alias routes, keys or cookies

A request to a v3 route prefix, or a lookup of a v3 storage key or cookie,
finds nothing in v4.

```quint
pure def servedInV4(name: NameGeneration): bool = name == V4Name
pure def nameServed(server: ServerPhase, name: NameGeneration): bool = (server == ServingV3 and name == V3Name) or (server == ServingV4 and servedInV4(name))
pure def lookUpName(s: StateMigration, name: NameGeneration): StateMigration = { ...s, lookups: s.lookups.append({ name: name, found: nameServed(s.server, name), phase: s.server }) }
pure val nameValues = Set(V3Name, V4Name)
pure def alwaysV3NamesFindNothingInV4(s: StateMigration): bool = s.lookups.every(l => (l.phase == ServingV4 and l.name == V3Name) implies not(l.found))
pure def sometimesV3NameMissedAfterCutover(s: StateMigration): bool = s.lookups.some(l => l.phase == ServingV4 and l.name == V3Name)
```
