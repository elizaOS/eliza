# Account sign-in methods

A signed-in person reviews the methods that can sign in to their account
(email, phone, Google, passkey) and links or removes one. Each mutation
needs a fresh review, since what was shown may be stale; the last method is
never removed, an identity that belongs to someone else is never linked, and
an answer that leaves the outcome unknown is never retried: the inventory is
read again first. Times are in seconds.

New in v4, after the preflight-and-commit pattern of develop
`packages/auth/quint/AccountProviderDeletion.qnt`; the behavior is develop
`native-host/account-methods.mjs` and `src/server/routes/user.ts`.

## Story: Review, link and remove my sign-in methods

> As a person, I want to see how I can sign in and change it safely, so that
> I never lock myself out, never take over someone else's identity, and never
> act on a list that changed under me.

### A mutation needs the id of a review less than a minute old, and one review admits one mutation

```quint
type MethodKind = EmailMethod | PhoneMethod | GoogleMethod | PasskeyMethod
type LinkedMethod = { kind: MethodKind, identity: str }
type AuthorityScope = PersonalAuthority | TenantAuthority
type MutationResult = NoMutation | Reviewed | MethodUnlinked | MethodLinked | ReviewStale | LastMethodProtected | IdentityCollision | MethodAbsent | OutcomeUnknown | ScopeRefused
type AccountMethods = { now: int, methods: List[LinkedMethod], reviewId: int, reviewedAt: int, nextReview: int, attemptOpen: bool, mustReread: bool, result: MutationResult }
pure val initial: AccountMethods = {
  now: 0, methods: List({ kind: EmailMethod, identity: "person@example.org" }, { kind: GoogleMethod, identity: "google-subject-1" }),
  reviewId: 0, reviewedAt: 0, nextReview: 1, attemptOpen: false, mustReread: false, result: NoMutation
}
pure val reviewLifetime = 60
pure def freshReview(s: AccountMethods, reviewId: int): bool =
  reviewId > 0 and reviewId == s.reviewId and s.attemptOpen and not(s.mustReread) and s.now - s.reviewedAt < reviewLifetime
pure def review(s: AccountMethods, authority: AuthorityScope): AccountMethods =
  if (authority != PersonalAuthority) { ...s, result: ScopeRefused }
  else { ...s, reviewId: s.nextReview, nextReview: s.nextReview + 1, reviewedAt: s.now, attemptOpen: true, mustReread: false, result: Reviewed }
pure def canElapse(s: AccountMethods, seconds: int): bool = seconds > 0
pure def elapse(s: AccountMethods, seconds: int): AccountMethods = { ...s, now: s.now + seconds }
pure val secondsValues = Set(10, 60)
pure val reviewIdValues = Set(1, 2)
pure val authorityValues = Set(PersonalAuthority, TenantAuthority)
pure def stepMutationNeedsFreshReview(before: AccountMethods, via: str, after: AccountMethods): bool =
  (after.methods != before.methods) implies (before.attemptOpen and not(before.mustReread) and before.now - before.reviewedAt < reviewLifetime and not(after.attemptOpen))
pure def sometimesStaleReviewRefused(s: AccountMethods): bool = s.result == ReviewStale
```

### The last remaining sign-in method cannot be removed

```quint
pure def hasMethod(s: AccountMethods, kind: MethodKind): bool = s.methods.some(m => m.kind == kind)
pure def unlink(s: AccountMethods, authority: AuthorityScope, reviewId: int, kind: MethodKind): AccountMethods =
  if (authority != PersonalAuthority) { ...s, result: ScopeRefused }
  else if (not(freshReview(s, reviewId))) { ...s, result: ReviewStale }
  else if (not(hasMethod(s, kind))) { ...s, attemptOpen: false, result: MethodAbsent }
  else if (s.methods.length() <= 1) { ...s, attemptOpen: false, result: LastMethodProtected }
  else { ...s, methods: s.methods.select(m => m.kind != kind), attemptOpen: false, result: MethodUnlinked }
pure val kindValues = Set(EmailMethod, PhoneMethod, GoogleMethod)
pure def alwaysAtLeastOneMethod(s: AccountMethods): bool = s.methods.length() >= 1
pure def sometimesLastMethodProtected(s: AccountMethods): bool = s.result == LastMethodProtected
```

### A phone or Google identity owned by another user is refused

An identity is linked once per account, and a collision changes nothing.

```quint
pure def canLink(s: AccountMethods, authority: AuthorityScope, reviewId: int, kind: MethodKind, identity: str, ownedByOther: bool): bool = identity != ""
pure def link(s: AccountMethods, authority: AuthorityScope, reviewId: int, kind: MethodKind, identity: str, ownedByOther: bool): AccountMethods =
  if (authority != PersonalAuthority) { ...s, result: ScopeRefused }
  else if (not(freshReview(s, reviewId))) { ...s, result: ReviewStale }
  else if (ownedByOther or s.methods.some(m => m.identity == identity) or hasMethod(s, kind)) { ...s, attemptOpen: false, result: IdentityCollision }
  else { ...s, methods: s.methods.append({ kind: kind, identity: identity }), attemptOpen: false, result: MethodLinked }
pure val identityValues = Set("+15550100", "google-subject-2")
pure def alwaysIdentitiesUnique(s: AccountMethods): bool =
  s.methods.every(m => s.methods.select(o => o.identity == m.identity).length() == 1 and s.methods.select(o => o.kind == m.kind).length() == 1)
pure def stepCollisionChangesNothing(before: AccountMethods, after: AccountMethods): bool = after.result == IdentityCollision implies after.methods == before.methods
pure def sometimesCollisionRefused(s: AccountMethods): bool = s.result == IdentityCollision
pure def sometimesPhoneLinked(s: AccountMethods): bool = s.result == MethodLinked and hasMethod(s, PhoneMethod)
```

### An ambiguous mutation consumes its attempt, and the inventory must be read again before another

The answer was lost, so the change may or may not have happened. Nothing
retries it; only a new review admits another mutation.

```quint
pure def canMutationUnanswered(s: AccountMethods, reviewId: int, kind: MethodKind, applied: bool): bool = freshReview(s, reviewId) and hasMethod(s, kind) and s.methods.length() > 1
pure def mutationUnanswered(s: AccountMethods, reviewId: int, kind: MethodKind, applied: bool): AccountMethods =
  { ...s, methods: if (applied) s.methods.select(m => m.kind != kind) else s.methods, attemptOpen: false, mustReread: true, result: OutcomeUnknown }
pure def alwaysUnknownOutcomeBlocksMutation(s: AccountMethods): bool = s.mustReread implies not(s.attemptOpen)
pure def sometimesUnknownOutcome(s: AccountMethods): bool = s.mustReread and s.result == OutcomeUnknown
```

### Tenant-scoped authority never authorizes personal account-method routes

```quint
pure def stepTenantAuthorityChangesNothing(before: AccountMethods, after: AccountMethods): bool =
  after.result == ScopeRefused implies (after.methods == before.methods and after.reviewId == before.reviewId and after.attemptOpen == before.attemptOpen)
pure def sometimesTenantAuthorityRefused(s: AccountMethods): bool = s.result == ScopeRefused
```
