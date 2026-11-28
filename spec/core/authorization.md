# Authorization and disclosure

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Contracts come from `packages/core/src/roles.ts`, `access-context.ts`, `identity-clusters.ts`, `access-control/`, and `database/world-metadata-cas.ts`. Roles resolve from trusted connector stamps, configured ownership, verified identity links, deliberate grants and the current world. Untrusted message content never supplies authority. The policy functions below are exact decisions over already-resolved evidence. Cryptographic identity verification and storage transactions remain Effect service boundaries.

## Story: Read only the authorized records

> As a requester, I want to receive only records within my agent, world,
> room membership and disclosure scope, so that nothing I may not see
> reaches me.

As a requester, I receive records within my agent, world, verified room membership and disclosure scope. A caller at an established trusted boundary may omit AccessContext. A present empty room set denies room-backed reads. Filtering precedes ranking and pagination.

### Memory and artifact scopes preserve their distinct compatibility decisions

Memory records without a scope use author-private access. Artifacts without a scope use owner-private access. An unresolved memory actor reads no scope. Artifact owner and admin access precedes explicit grants, and a redacted grant narrows other actors even on an open scope. These functions receive normalized scopes, with malformed memory scopes rejected at decoding.

A supplied world ID limits reads to records in that world even when the caller supplies no room selection. When both are supplied, a record must satisfy both restrictions.

```quint
type Role = Unresolved | Guest | User | Admin | Owner | Agent | Runtime
type Scope = Shared | Room | Global | Private | UserPrivate | OwnerPrivate | AgentPrivate
type Grant = NoGrant | FullGrant | RedactedGrant
type Disclosure = None | Redacted | Full
pure def rank(role: Role): int = if (role == Owner) 4 else if (role == Admin) 3 else if (role == User) 2 else if (role == Guest) 1 else 0
pure def memoryReadable(scope: Scope, role: Role, sameEntity: bool, hasEntity: bool, hasDelegation: bool, delegatedOwner: bool): bool =
  if (role == Unresolved) false
  else if (scope == Shared or scope == Room or scope == Global) true
  else if (scope == OwnerPrivate) role == Owner or role == Runtime
  else if (scope == AgentPrivate) role == Owner or role == Agent or role == Runtime
  else hasEntity and role != Guest and (role == Agent or role == Runtime or (if (role == Owner and hasDelegation) delegatedOwner else sameEntity))
pure def artifactDisclosure(scope: Scope, role: Role, sameEntity: bool, hasEntity: bool, grant: Grant, hasContext: bool): Disclosure =
  if (not(hasContext) or role == Agent or role == Owner or role == Admin) Full
  else if (grant == FullGrant) Full
  else if (grant == RedactedGrant) Redacted
  else if (role == Unresolved) { if (scope == Shared or scope == Room or scope == Global) Full else None }
  else if (memoryReadable(scope, role, sameEntity, hasEntity, false, false)) Full else None
pure def locationReadable(agentMatches: bool, roomsSupplied: bool, roomMatches: bool, worldSupplied: bool, worldMatches: bool): bool =
  agentMatches and (not(roomsSupplied) or roomMatches) and (not(worldSupplied) or worldMatches)
pure def minimumDisclosure(left: Disclosure, right: Disclosure): Disclosure =
  if (left == None or right == None) None else if (left == Redacted or right == Redacted) Redacted else Full
pure def lawUnresolvedMemoryFailsClosed(scope: Scope, sameEntity: bool, hasEntity: bool): bool =
  not(memoryReadable(scope, Unresolved, sameEntity, hasEntity, false, false))
pure def lawEmptyRoomSelectionDenies(agentMatches: bool, worldSupplied: bool, worldMatches: bool): bool =
  not(locationReadable(agentMatches, true, false, worldSupplied, worldMatches))
pure def lawWorldSelectionRequiresMatch(agentMatches: bool, roomsSupplied: bool, roomMatches: bool): bool =
  not(locationReadable(agentMatches, roomsSupplied, roomMatches, true, false))
pure def lawAudienceCannotExceedMember(left: Disclosure): bool = minimumDisclosure(left, None) == None
```

### Verified cross-world membership is intersected with the agent membership

Only verified principal links may expand private recall. Every retained room must belong to both the verified requester cluster and the agent. Supplying no verified links retains the original requester.

```quint
pure def authorizedRooms(requesterRooms: Set[str], agentRooms: Set[str]): Set[str] = requesterRooms.intersect(agentRooms)
pure def lawRoomsRequireBothMemberships(requesterRooms: Set[str], agentRooms: Set[str]): bool =
  authorizedRooms(requesterRooms, agentRooms).subseteq(requesterRooms) and authorizedRooms(requesterRooms, agentRooms).subseteq(agentRooms)
```

## Story: Change roles against fresh authority

> As an owner or administrator, I want each role change authorized against
> the current world, so that it never overwrites a concurrent revocation.

As an owner or administrator, I change roles without overwriting a concurrent revocation. Each retry resolves and authorizes the current world snapshot. The authority replacement and audit row commit atomically. Unsupported CAS capability raises a typed failure. The model records one target and one actor, with unbounded revisions and finite sampled values.

### A role write captures the target and authority revision

Authority starts unresolved. The authenticated sender parameter supplies a role only after the owning boundary resolves trusted world evidence.

An owner may change any different role. An administrator may change a lower-ranked target to any role except owner. An administrator may therefore promote a lower-ranked user to administrator, as `roles.ts` does, but cannot change another administrator. Other actors cannot change roles.

```quint
type RolePhase = Idle | Read | Committed | Denied | Conflict | Exhausted
type Authorization = { phase: RolePhase, actorRole: Role, targetRole: Role, requestedRole: Role, revision: int, observedRevision: int, commits: int, auditRows: int, attempts: int, maxAttempts: int }
pure val initial: Authorization = { phase: Idle, actorRole: Unresolved, targetRole: User, requestedRole: User, revision: 0, observedRevision: 0, commits: 0, auditRows: 0, attempts: 0, maxAttempts: 3 }
pure def mayChange(actorRole: Role, targetRole: Role, requestedRole: Role): bool =
  targetRole != requestedRole and (actorRole == Owner or (actorRole == Admin and rank(targetRole) < rank(Admin) and requestedRole != Owner))
pure def canResolveAuthority(s: Authorization, by: Role): bool = s.phase == Idle
pure def resolveAuthority(s: Authorization, by: Role): Authorization = { ...s, actorRole: by }
pure val byValues = Set(Guest, User, Admin, Owner)
pure def canBegin(s: Authorization, requestedRole: Role, maxAttempts: int): bool = s.phase == Idle and rank(requestedRole) > 0 and maxAttempts >= 1
pure def begin(s: Authorization, requestedRole: Role, maxAttempts: int): Authorization = { ...s, phase: Read, requestedRole: requestedRole, observedRevision: s.revision, attempts: 1, maxAttempts: maxAttempts }
pure val maxAttemptsValues = Set(1, 3, 5)
pure val requestedRoleValues = Set(Guest, User, Admin, Owner)
```

### A concurrent revocation makes the captured role write stale

Revocation advances the world revision while preserving audit consistency for this modeled write. A stale write reports conflict, and retry captures the new revision before it can authorize again. The configured attempt bound is positive and defaults to three. Exhaustion returns conflict without another write.

```quint
pure def canRevoke(s: Authorization): bool = s.phase == Read and s.actorRole != Guest
pure def revoke(s: Authorization): Authorization = { ...s, actorRole: Guest, revision: s.revision + 1 }
pure def canConcurrentMetadataWrite(s: Authorization): bool = s.phase == Read
pure def concurrentMetadataWrite(s: Authorization): Authorization = { ...s, revision: s.revision + 1 }
pure def canConflict(s: Authorization): bool = s.phase == Read and s.observedRevision != s.revision
pure def conflict(s: Authorization): Authorization = { ...s, phase: if (s.attempts >= s.maxAttempts) Exhausted else Conflict }
pure def canRetry(s: Authorization): bool = s.phase == Conflict and s.attempts < s.maxAttempts
pure def retry(s: Authorization): Authorization = { ...s, phase: Read, observedRevision: s.revision, attempts: s.attempts + 1 }
pure def canConfirmExisting(s: Authorization): bool = s.phase == Read and s.observedRevision == s.revision and s.targetRole == s.requestedRole and (s.actorRole == Owner or (s.actorRole == Admin and rank(s.targetRole) < rank(Admin)))
pure def confirmExisting(s: Authorization): Authorization = { ...s, phase: Committed }
pure def canDeny(s: Authorization): bool = s.phase == Read and s.observedRevision == s.revision and not(mayChange(s.actorRole, s.targetRole, s.requestedRole)) and not(canConfirmExisting(s))
pure def deny(s: Authorization): Authorization = { ...s, phase: Denied }
pure def sometimesConcurrentRevocationDenied(s: Authorization): bool = s.phase == Denied and s.actorRole == Guest and s.revision > 0
```

### A committed role change has fresh authorization and one matching audit row

```quint
pure def canCommit(s: Authorization): bool = s.phase == Read and s.observedRevision == s.revision and mayChange(s.actorRole, s.targetRole, s.requestedRole)
pure def commit(s: Authorization): Authorization = { ...s, phase: Committed, targetRole: s.requestedRole, revision: s.revision + 1, commits: s.commits + 1, auditRows: s.auditRows + 1 }
pure def alwaysAuditIsAtomic(s: Authorization): bool = s.commits == s.auditRows and s.commits >= 0
pure def alwaysAttemptsRespectConfiguredBound(s: Authorization): bool = s.attempts >= 0 and s.maxAttempts >= 1 and s.attempts <= s.maxAttempts
pure def sometimesRetriesExhausted(s: Authorization): bool = s.phase == Exhausted and s.attempts == s.maxAttempts
pure def alwaysRevisionsAreValid(s: Authorization): bool = s.revision >= 0 and s.observedRevision >= 0 and s.observedRevision <= s.revision
pure def stepCommitUsesCurrentAuthority(before: Authorization, via: str, after: Authorization): bool =
  via != "commit" or (before.observedRevision == before.revision and mayChange(before.actorRole, before.targetRole, before.requestedRole) and after.targetRole == before.requestedRole)
pure def sometimesOwnerGrantsAdmin(s: Authorization): bool = s.phase == Committed and s.targetRole == Admin
```

### Role gates combine exclusions, minimum rank and all required memberships

A missing gate allows access before the host coerces or iterates caller roles.
For a present gate, host coercion and property evaluation retain source order
and failures. Explicit exclusions win. The `roles` and
`anyOf` sets form one alternative union: when nonempty, at least one of their
names must match. Every `allOf` name must match. Rank compares against the
caller's highest role, starting at zero even for an empty caller set.

Gate names are separate from resolved world roles. The host supplies the
exact result of `String(value).trim().toUpperCase()`; the pure policy maps
USER to MEMBER. Custom and empty names retain their membership identity
and rank zero. A normalized blank name is a real member, so `Set("")` is
different from an empty set. Missing, NONE, custom and blank minimum names
all require rank zero and admit an empty caller set unless another gate
condition denies it.

String coercion, trimming and Unicode uppercasing require conformance to
[the pinned gate helper](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/access-control/role-primitives.ts#L52-L143).
World `normalizeRole` instead maps unknown names to GUEST, maps MEMBER to
USER, and does not trim. `hasAtLeastRole` uppercases without trimming. Those
separate source contracts are not replaced by gate normalization.

```quint
pure def gateRoleKey(name: str): str = if (name == "USER") "MEMBER" else name
pure def gateRoleRank(name: str): int = {
  val key = gateRoleKey(name)
  if (key == "OWNER") 4 else if (key == "ADMIN") 3 else if (key == "MEMBER") 2 else if (key == "GUEST") 1 else 0
}
pure def gateRoleNames(names: Set[str]): Set[str] = names.map(name => gateRoleKey(name))
pure val userRolesValues = Set(Set(), Set("GUEST"), Set("USER"), Set("ADMIN", "OWNER"), Set("CUSTOM"), Set("AUDITOR"), Set(""))
pure val rolesValues = Set(Set(), Set("USER"), Set("ADMIN"), Set("CUSTOM"), Set(""))
pure val anyOfValues = Set(Set(), Set("USER"), Set("GUEST", "ADMIN"), Set("CUSTOM"), Set("AUDITOR"), Set(""))
pure val allOfValues = Set(Set(), Set("USER"), Set("ADMIN", "OWNER"), Set("CUSTOM"), Set(""))
pure val noneOfValues = Set(Set(), Set("GUEST"), Set("OWNER"), Set("CUSTOM"), Set(""))
pure val minimumValues = Set("", "NONE", "GUEST", "USER", "MEMBER", "ADMIN", "OWNER", "CUSTOM")
pure val requiredValues = Set("", "USER", "MEMBER", "CUSTOM", "AUDITOR")
pure val nameValues = Set("", "NONE", "USER", "MEMBER", "OWNER", "CUSTOM", "AUDITOR")
pure def roleGateAllowed(gatePresent: bool, userRoles: Set[str], roles: Set[str], anyOf: Set[str], allOf: Set[str], noneOf: Set[str], minimum: str): bool = {
  val callers = gateRoleNames(userRoles)
  val alternatives = gateRoleNames(roles.union(anyOf))
  val requiredNames = gateRoleNames(allOf)
  val excludedNames = gateRoleNames(noneOf)
  val minimumRank = gateRoleRank(minimum)
  not(gatePresent) or
    (callers.intersect(excludedNames).size() == 0 and
     (minimumRank == 0 or callers.exists(role => gateRoleRank(role) >= minimumRank)) and
     (alternatives.size() == 0 or callers.intersect(alternatives).size() > 0) and
     requiredNames.subseteq(callers))
}
pure def lawMissingRoleGateAllows(userRoles: Set[str], roles: Set[str], anyOf: Set[str], allOf: Set[str], noneOf: Set[str], minimum: str): bool =
  roleGateAllowed(false, userRoles, roles, anyOf, allOf, noneOf, minimum)
pure def lawGateRoleAliasIsIdempotent(name: str): bool = gateRoleKey(gateRoleKey(name)) == gateRoleKey(name)
pure def lawGateRoleRankIsBounded(name: str): bool = gateRoleRank(name) >= 0 and gateRoleRank(name) <= 4
pure def lawUnknownGateRoleRetainsNameAndZeroRank(name: str): bool =
  not(Set("OWNER", "ADMIN", "USER", "MEMBER", "GUEST").contains(name)) implies gateRoleKey(name) == name and gateRoleRank(name) == 0
pure def lawGateUserAndMemberHaveOneIdentity(name: str): bool =
  name == "USER" or name == "MEMBER" implies gateRoleKey(name) == "MEMBER" and gateRoleRank(name) == 2
pure def lawEmptyCallerMeetsZeroRankMinimum(minimum: str): bool =
  gateRoleRank(minimum) == 0 implies roleGateAllowed(true, Set(), Set(), Set(), Set(), Set(), minimum)
pure def lawEmptyCallerFailsPositiveRankMinimum(minimum: str): bool =
  gateRoleRank(minimum) > 0 implies not(roleGateAllowed(true, Set(), Set(), Set(), Set(), Set(), minimum))
pure def lawGateExclusionsWin(userRoles: Set[str], roles: Set[str], anyOf: Set[str], allOf: Set[str], noneOf: Set[str], minimum: str): bool =
  gateRoleNames(userRoles).intersect(gateRoleNames(noneOf)).size() > 0 implies not(roleGateAllowed(true, userRoles, roles, anyOf, allOf, noneOf, minimum))
pure def lawGateAlternativesCombineBothLists(userRoles: Set[str], roles: Set[str], anyOf: Set[str]): bool =
  roleGateAllowed(true, userRoles, roles, anyOf, Set(), Set(), "") ==
    roleGateAllowed(true, userRoles, roles.union(anyOf), Set(), Set(), Set(), "")
pure def lawGatePositiveMinimumRequiresRank(userRoles: Set[str], roles: Set[str], anyOf: Set[str], allOf: Set[str], noneOf: Set[str], minimum: str): bool =
  roleGateAllowed(true, userRoles, roles, anyOf, allOf, noneOf, minimum) and gateRoleRank(minimum) > 0 implies
    gateRoleNames(userRoles).exists(role => gateRoleRank(role) >= gateRoleRank(minimum))
pure def lawGateAlternativesRequireMembership(userRoles: Set[str], roles: Set[str], anyOf: Set[str], allOf: Set[str], noneOf: Set[str], minimum: str): bool = {
  val callers = gateRoleNames(userRoles)
  val alternatives = gateRoleNames(roles.union(anyOf))
  roleGateAllowed(true, userRoles, roles, anyOf, allOf, noneOf, minimum) and alternatives.size() > 0 implies
    callers.intersect(alternatives).size() > 0
}
pure def lawGateRequiresEveryNamedMembership(userRoles: Set[str], roles: Set[str], anyOf: Set[str], allOf: Set[str], noneOf: Set[str], minimum: str): bool =
  roleGateAllowed(true, userRoles, roles, anyOf, allOf, noneOf, minimum) implies gateRoleNames(allOf).subseteq(gateRoleNames(userRoles))
pure def lawGateMembershipDoesNotFollowRank(userRoles: Set[str], required: str): bool =
  not(gateRoleNames(userRoles).contains(gateRoleKey(required))) implies
    not(roleGateAllowed(true, userRoles, Set(), Set(), Set(required), Set(), ""))
pure def lawBlankGateRoleRemainsAMembership(userRoles: Set[str]): bool =
  roleGateAllowed(true, userRoles, Set(), Set(""), Set(), Set(), "") == userRoles.contains("")
```

### Trusted ownership and deliberate grants determine resolved roles

Canonical ownership and verified owner linkage are checked before stored grants. A stored owner grant requires manual provenance. Connector-admin grants require a current whitelist match. Only connector-stamped live metadata participates in the live match. Connector-admin status alone does not grant private-owner disclosure.

```quint
type GrantSource = Manual | ConnectorAdmin | CanonicalOwner | UnknownGrant
pure def resolveRole(canonicalOwner: bool, verifiedOwnerLink: bool, storedRole: Role, sourceKind: GrantSource, whitelistConfigured: bool, liveStampTrusted: bool, liveMatches: bool, storedMatches: bool): Role =
  if (canonicalOwner or verifiedOwnerLink) Owner
  else if (storedRole == Owner) { if (sourceKind == Manual) Owner else Guest }
  else if (storedRole == Admin or storedRole == User) {
    if (sourceKind == ConnectorAdmin) { if (whitelistConfigured and ((liveStampTrusted and liveMatches) or storedMatches)) Admin else Guest } else storedRole
  }
  else if (whitelistConfigured and ((liveStampTrusted and liveMatches) or storedMatches)) Admin else Guest
pure def privateAuthority(canonicalOwner: bool, manualGrant: bool, verifiedLinkedManualGrant: bool): bool = canonicalOwner or manualGrant or verifiedLinkedManualGrant
pure def lawUnprovenOwnerGrantFailsClosed(whitelistConfigured: bool, liveStampTrusted: bool, liveMatches: bool, storedMatches: bool): bool = resolveRole(false, false, Owner, UnknownGrant, whitelistConfigured, liveStampTrusted, liveMatches, storedMatches) == Guest
pure def lawUntrustedLiveStampCannotGrantAdmin(liveMatches: bool): bool = resolveRole(false, false, Guest, UnknownGrant, true, false, liveMatches, false) == Guest
```
