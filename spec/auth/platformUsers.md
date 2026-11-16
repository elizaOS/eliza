# Platform users

The hosted cloud keeps its own users and organizations, and the identity
service keeps the identities behind them. Each cloud user maps to exactly one
identity user, and each organization to exactly one tenant. When an account
is closed, the cloud deactivates the identity first and deletes it only
after, and a deactivation whose answer was lost is reconciled before it is
tried again. A sign-in subject (a Google account, a phone) that belongs to
one user is never linked to another because an email address matches.

[Cloud accounts](../cloud/accounts.md) imports this machine for the deletion
order of a closed account.

## Story: The cloud provisions, deactivates, reactivates and deletes the identity behind a cloud user

> As the hosted cloud, I want every account to have exactly one identity,
> removed only after it can no longer sign in, so that closing an account
> never leaves a working sign-in behind and never splits or merges accounts.

### Each cloud user maps to exactly one identity user, and each organization to exactly one tenant

```quint
type IdentityPhase = Provisioned | Deactivating | Deactivated | DeletionCommitted | IdentityDeleted
type PlatformUser = { cloudUser: int, identityUser: int, organization: int, phase: IdentityPhase, requestOpen: bool, ambiguous: bool, deactivatedOnce: bool }
type OrganizationTenant = { organization: int, tenant: int }
type SubjectLink = { subject: int, cloudUser: int }
type LinkProof = EmailMatchOnly | VerifiedSubjectSession
type PlatformResult = NoPlatformChange | PlatformApplied | AlreadyMapped | SubjectOwnedElsewhere | EmailAloneRefused | ReactivationRefused | ReconcileFirst
type PlatformUsers = { users: List[PlatformUser], tenants: List[OrganizationTenant], subjects: List[SubjectLink], nextIdentity: int, nextTenant: int, result: PlatformResult }
pure val initial: PlatformUsers = { users: List(), tenants: List(), subjects: List(), nextIdentity: 1, nextTenant: 1, result: NoPlatformChange }
pure def mapped(s: PlatformUsers, cloudUser: int): bool = s.users.some(u => u.cloudUser == cloudUser)
pure def canProvision(s: PlatformUsers, cloudUser: int, organization: int): bool = cloudUser > 0 and organization > 0
pure def provision(s: PlatformUsers, cloudUser: int, organization: int): PlatformUsers = {
  val hasTenant = s.tenants.some(t => t.organization == organization)
  if (mapped(s, cloudUser)) { ...s, result: AlreadyMapped }
  else { ...s, users: s.users.append({ cloudUser: cloudUser, identityUser: s.nextIdentity, organization: organization, phase: Provisioned, requestOpen: false, ambiguous: false, deactivatedOnce: false }),
    nextIdentity: s.nextIdentity + 1,
    tenants: if (hasTenant) s.tenants else s.tenants.append({ organization: organization, tenant: s.nextTenant }),
    nextTenant: if (hasTenant) s.nextTenant else s.nextTenant + 1, result: PlatformApplied }
}
pure val cloudUserValues = Set(1, 2)
pure val organizationValues = Set(1, 2)
pure def alwaysOneIdentityPerUser(s: PlatformUsers): bool =
  s.users.every(u => s.users.select(o => o.cloudUser == u.cloudUser).length() == 1 and s.users.select(o => o.identityUser == u.identityUser).length() == 1 and u.identityUser >= 1 and u.identityUser < s.nextIdentity)
pure def alwaysOneTenantPerOrganization(s: PlatformUsers): bool =
  s.tenants.every(t => s.tenants.select(o => o.organization == t.organization).length() == 1 and s.tenants.select(o => o.tenant == t.tenant).length() == 1 and t.tenant >= 1 and t.tenant < s.nextTenant)
    and s.users.every(u => s.tenants.some(t => t.organization == u.organization))
pure def sometimesTwoUsersShareATenant(s: PlatformUsers): bool = s.users.length() == 2 and s.tenants.length() == 1
```

### A subject owned by another user is never linked, and never by email alone

```quint
pure def canLinkSubject(s: PlatformUsers, cloudUser: int, subject: int, proof: LinkProof): bool = mapped(s, cloudUser) and subject > 0
pure def linkSubject(s: PlatformUsers, cloudUser: int, subject: int, proof: LinkProof): PlatformUsers =
  if (s.subjects.some(l => l.subject == subject and l.cloudUser != cloudUser)) { ...s, result: SubjectOwnedElsewhere }
  else if (proof != VerifiedSubjectSession) { ...s, result: EmailAloneRefused }
  else if (s.subjects.some(l => l.subject == subject)) { ...s, result: PlatformApplied }
  else { ...s, subjects: s.subjects.append({ subject: subject, cloudUser: cloudUser }), result: PlatformApplied }
pure val subjectValues = Set(7, 8)
pure def alwaysSubjectHasOneOwner(s: PlatformUsers): bool = s.subjects.every(l => s.subjects.select(o => o.subject == l.subject).length() == 1)
pure def stepSubjectNeverMoves(before: PlatformUsers, after: PlatformUsers): bool = before.subjects.every(l => after.subjects.includes(l))
pure def sometimesForeignSubjectRefused(s: PlatformUsers): bool = s.result == SubjectOwnedElsewhere
```

### Deactivation precedes deletion and is idempotent

```quint
pure def userOf(s: PlatformUsers, cloudUser: int): PlatformUser =
  s.users.select(u => u.cloudUser == cloudUser).nthOr(0, { cloudUser: 0, identityUser: 0, organization: 0, phase: IdentityDeleted, requestOpen: false, ambiguous: false, deactivatedOnce: false })
pure def updated(cloudUser: int, change: PlatformUser, s: PlatformUsers): List[PlatformUser] = s.users.listMap(u => if (u.cloudUser == cloudUser) change else u)
pure def canBeginDeactivation(s: PlatformUsers, cloudUser: int): bool = mapped(s, cloudUser)
pure def beginDeactivation(s: PlatformUsers, cloudUser: int): PlatformUsers = {
  val u = userOf(s, cloudUser)
  if (u.phase == Provisioned) { ...s, users: updated(cloudUser, { ...u, phase: Deactivating, requestOpen: true }, s), result: PlatformApplied }
  else if (u.ambiguous) { ...s, result: ReconcileFirst }
  else { ...s, result: PlatformApplied }
}
pure def canDeactivationAnswered(s: PlatformUsers, cloudUser: int): bool = userOf(s, cloudUser).phase == Deactivating and userOf(s, cloudUser).requestOpen
pure def deactivationAnswered(s: PlatformUsers, cloudUser: int): PlatformUsers =
  { ...s, users: updated(cloudUser, { ...userOf(s, cloudUser), phase: Deactivated, requestOpen: false, deactivatedOnce: true }, s), result: PlatformApplied }
pure def canCommitDeletion(s: PlatformUsers, cloudUser: int): bool = userOf(s, cloudUser).phase == Deactivated
pure def commitDeletion(s: PlatformUsers, cloudUser: int): PlatformUsers = { ...s, users: updated(cloudUser, { ...userOf(s, cloudUser), phase: DeletionCommitted }, s), result: PlatformApplied }
pure def canFinishDeletion(s: PlatformUsers, cloudUser: int): bool = userOf(s, cloudUser).phase == DeletionCommitted
pure def finishDeletion(s: PlatformUsers, cloudUser: int): PlatformUsers = { ...s, users: updated(cloudUser, { ...userOf(s, cloudUser), phase: IdentityDeleted }, s), result: PlatformApplied }
pure def committed(u: PlatformUser): bool = u.phase == DeletionCommitted or u.phase == IdentityDeleted
pure def alwaysDeletionFollowsDeactivation(s: PlatformUsers): bool =
  s.users.every(u => (committed(u) or u.phase == Deactivated) implies (u.deactivatedOnce and not(u.requestOpen) and not(u.ambiguous)))
pure def sometimesIdentityDeleted(s: PlatformUsers): bool = s.users.some(u => u.phase == IdentityDeleted)
```

### Reactivation is refused once deletion is committed

```quint
pure def canReactivate(s: PlatformUsers, cloudUser: int): bool = mapped(s, cloudUser)
pure def reactivate(s: PlatformUsers, cloudUser: int): PlatformUsers = {
  val u = userOf(s, cloudUser)
  if (u.phase == Deactivated) { ...s, users: updated(cloudUser, { ...u, phase: Provisioned }, s), result: PlatformApplied }
  else if (committed(u)) { ...s, result: ReactivationRefused }
  else { ...s, result: NoPlatformChange }
}
pure def stepCommittedDeletionIsFinal(before: PlatformUsers, after: PlatformUsers): bool =
  before.users.every(u => committed(u) implies after.users.some(v => v.cloudUser == u.cloudUser and committed(v)))
pure def sometimesReactivationRefused(s: PlatformUsers): bool = s.result == ReactivationRefused
pure def sometimesReactivated(s: PlatformUsers): bool = s.users.some(u => u.phase == Provisioned and u.deactivatedOnce)
```

### A deactivation whose answer was lost is reconciled before it is tried again

```quint
pure def canDeactivationLost(s: PlatformUsers, cloudUser: int): bool = userOf(s, cloudUser).phase == Deactivating and userOf(s, cloudUser).requestOpen
pure def deactivationLost(s: PlatformUsers, cloudUser: int): PlatformUsers =
  { ...s, users: updated(cloudUser, { ...userOf(s, cloudUser), requestOpen: false, ambiguous: true }, s), result: NoPlatformChange }
pure def canReconcile(s: PlatformUsers, cloudUser: int, observedDeactivated: bool): bool = userOf(s, cloudUser).ambiguous
pure def reconcile(s: PlatformUsers, cloudUser: int, observedDeactivated: bool): PlatformUsers = {
  val u = userOf(s, cloudUser)
  { ...s, users: updated(cloudUser, if (observedDeactivated) { ...u, phase: Deactivated, ambiguous: false, deactivatedOnce: true } else { ...u, ambiguous: false, requestOpen: true }, s), result: PlatformApplied }
}
pure def alwaysAmbiguousWaitsForReconcile(s: PlatformUsers): bool =
  s.users.every(u => (u.ambiguous implies (u.phase == Deactivating and not(u.requestOpen))) and (u.requestOpen implies u.phase == Deactivating) and (u.phase == Deactivating implies (u.requestOpen or u.ambiguous)))
pure def sometimesReconcileRequired(s: PlatformUsers): bool = s.result == ReconcileFirst
```
