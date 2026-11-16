# Entitlements and plan limits

A client reads the organization's plan from a signed entitlement issued for
the deployment's audience, falls back to billing limits only with an
explicit source, and binds every billing read to the credential that made
it. Promotional grants carry a stamp that is honored only while the primary
grant policy still authorizes it, and each plan bounds request rate with
paired token buckets. The entitlement audience is the deployment's
configuration ([deployment profile](./deployment.md)). The rule that an
answer belongs to the account that asked is stated for every account
service in [account authority](../auth/accountAuthority.md); the billing
read below is its application to billing. Ported from the develop SDK
`subscription-entitlement` and `cloud-account-billing` decisions and the
models `GrantPolicyStampAdmission` and `plan_request_buckets`.

## Story: Read my plan without substituting a different account or source

> As a person signed in to a client, I see the plan of the account I am
> signed in with, from the source that actually attests it, and never the
> plan of another account or a weaker source passed off as the signed one.

### An entitlement is accepted only for the expected signed identity and time

The token verifier admits supported ES256 tokens of the entitlement type
without an unrecognized critical extension. The issuer must match and the
audience must equal the deployment's configured entitlement audience.
Subject and organization IDs compare ignoring UUID letter case. Canonical
values represent that comparison. Validity cannot exceed one hour. The
issued and not-before checks allow up to one minute of clock skew. Expiry
is strict. Signature, JWKS selection and shape validation are boundary
evidence supplied by the verifier.

```quint
type TokenEvidence = { supportedHeader: bool, issuerMatches: bool, audience: str, subjectMatches: bool, organizationMatches: bool, validSignature: bool, validClaims: bool, issuedAt: int, notBefore: int, expiresAt: int }
pure def acceptsToken(token: TokenEvidence, expectedAudience: str, now: int): bool = token.supportedHeader and token.issuerMatches and expectedAudience != "" and token.audience == expectedAudience and token.subjectMatches and token.organizationMatches and token.validSignature and token.validClaims and token.expiresAt > token.issuedAt and token.expiresAt - token.issuedAt <= 3600000 and token.notBefore - 60000 <= now and token.issuedAt - 60000 <= now and token.expiresAt > now
pure val tokenValues = Set(
  { supportedHeader: true, issuerMatches: true, audience: "cloud-subscription", subjectMatches: true, organizationMatches: true, validSignature: true, validClaims: true, issuedAt: 0, notBefore: 0, expiresAt: 3600000 },
  { supportedHeader: true, issuerMatches: true, audience: "cloud-subscription", subjectMatches: true, organizationMatches: false, validSignature: true, validClaims: true, issuedAt: 0, notBefore: 0, expiresAt: 3600000 },
  { supportedHeader: true, issuerMatches: true, audience: "other-deployment", subjectMatches: true, organizationMatches: true, validSignature: true, validClaims: true, issuedAt: 0, notBefore: 0, expiresAt: 3600000 },
  { supportedHeader: true, issuerMatches: true, audience: "cloud-subscription", subjectMatches: true, organizationMatches: true, validSignature: false, validClaims: true, issuedAt: 0, notBefore: 0, expiresAt: 3600000 })
pure val expectedAudienceValues = Set("cloud-subscription", "other-deployment")
pure val nowValues = Set(-60001, -60000, 0, 3599999, 3600000)
pure def lawExpiredTokenRefused(token: TokenEvidence, expectedAudience: str, now: int): bool = token.expiresAt <= now implies not(acceptsToken(token, expectedAudience, now))
pure def lawForeignAccountCannotUseEntitlement(token: TokenEvidence, expectedAudience: str, now: int): bool = (not(token.subjectMatches) or not(token.organizationMatches)) implies not(acceptsToken(token, expectedAudience, now))
pure def lawOtherDeploymentAudienceRefused(token: TokenEvidence, expectedAudience: str, now: int): bool = token.audience != expectedAudience implies not(acceptsToken(token, expectedAudience, now))
```

### Absent signed coverage can use billing limits with an explicit source

An invalid or unreachable entitlement route does not fall back to a
less authoritative plan. A verified canceled plan remains inactive.
A signed absence of subscription retains its signed status except when
billing limits attest the explicit organization-credits mode. When the
signed route is unpublished, valid billing limits may supply a fallback
plan. Authentication refusal and account mismatch propagate, including
when the fallback route reports an authentication failure.

```quint
type SignedStatus = RouteUnpublished | SignedActive | SignedPastDue | SignedCancelled | SignedNone | SignedOutage | SignedInvalid | SignedAuthRefused
type LimitsStatus = NoLimits | LimitsActive | LimitsPastDue | LimitsInactive | LimitsCredits | LimitsOutage | LimitsAuthRefused
type EntitlementView = SignedActiveView | SignedWarningView | SignedInactiveView | FallbackActiveView | FallbackWarningView | FallbackInactiveView | CreditsView | OutageView | InvalidView | UnpublishedView | AuthenticationError
pure def entitlementView(signed: SignedStatus, limits: LimitsStatus): EntitlementView =
  if (signed == SignedAuthRefused) AuthenticationError
  else if (signed == SignedOutage) OutageView
  else if (signed == SignedInvalid) InvalidView
  else if (signed == SignedActive) SignedActiveView
  else if (signed == SignedPastDue) SignedWarningView
  else if (signed == SignedCancelled) SignedInactiveView
  else if (limits == LimitsAuthRefused) AuthenticationError
  else if (limits == LimitsCredits) CreditsView
  else if (signed == SignedNone) SignedInactiveView
  else if (limits == LimitsActive) FallbackActiveView
  else if (limits == LimitsPastDue) FallbackWarningView
  else if (limits == LimitsInactive) FallbackInactiveView
  else if (limits == LimitsOutage) OutageView
  else UnpublishedView
pure def lawCancelledNeverBecomesCredits(limits: LimitsStatus): bool = entitlementView(SignedCancelled, limits) == SignedInactiveView
pure def lawInvalidTokenDoesNotFallback(limits: LimitsStatus): bool = entitlementView(SignedInvalid, limits) == InvalidView
pure def lawSignedAbsenceUsesOnlyExplicitCredits(limits: LimitsStatus): bool = entitlementView(SignedNone, limits) == CreditsView implies limits == LimitsCredits
```

### A response is published against the credential read for that request

The billing client captures a nonempty, unexpired credential identity. It
re-reads the identity after transport and discards a changed or expired
account. When a method asks for the exact binding, the current binding
must match too. A cancelled operation reports cancellation. The host
never projects a failed HTTP response as a successful billing snapshot.
These decisions are parameterized by post-transport evidence.

```quint
type BillingCredential = { id: str, bindingKey: str, hasExpiry: bool, expiresAt: int }
type BillingRead = BillingReady | BillingCredentialMissing | BillingAccountChanged | BillingExpired | BillingCancelled | BillingHttpFailed
pure def billingResult(original: BillingCredential, latest: BillingCredential, now: int, exact: bool, aborted: bool, accepted: bool): BillingRead =
  if (aborted) BillingCancelled
  else if (original.id == "") BillingCredentialMissing
  else if (not(accepted)) BillingHttpFailed
  else if (latest.id != original.id or (exact and latest.bindingKey != original.bindingKey)) BillingAccountChanged
  else if (latest.hasExpiry and latest.expiresAt <= now) BillingExpired
  else BillingReady
pure val originalValues = Set({ id: "key-a", bindingKey: "binding-a", hasExpiry: false, expiresAt: 0 })
pure val latestValues = Set(
  { id: "key-a", bindingKey: "binding-a", hasExpiry: false, expiresAt: 0 },
  { id: "key-b", bindingKey: "binding-b", hasExpiry: false, expiresAt: 0 },
  { id: "key-a", bindingKey: "binding-a", hasExpiry: true, expiresAt: 3599999 })
pure def lawBillingSuccessNamesCurrentCredential(original: BillingCredential, latest: BillingCredential, now: int, exact: bool, aborted: bool, accepted: bool): bool = billingResult(original, latest, now, exact, aborted, accepted) == BillingReady implies (original.id != "" and latest.id == original.id and (not(exact) or latest.bindingKey == original.bindingKey) and (not(latest.hasExpiry) or latest.expiresAt > now) and not(aborted) and accepted)
```

## Story: Honor a promotional grant only while its policy authorizes it

> As an organization holding a promotional grant, I get its benefits while
> the grant is live, and they stop as soon as the grant is revoked or
> expires, even if a cached stamp says otherwise.

### A promotional stamp is admitted only when it is well formed, inside its window and matches the primary's live policy

The stamp is compared with the primary's locked grant policy. Its window
starts at the grant's start and ends at its expiry, or never for a
lifetime grant; a lifetime expiry only validates the stamp's shape and is
never authority by itself. A revoked grant cannot be refreshed into a
valid stamp.

```quint
type Stamp = { now: int, until: int, granted: bool, revoked: bool, generation: int, cached: bool, cachedGeneration: int, wellFormed: bool, accepted: int, acceptedQualified: bool }
pure val grantStart = 1
pure val initial: Stamp = { now: 0, until: -1, granted: false, revoked: false, generation: 0, cached: false, cachedGeneration: 0, wellFormed: true, accepted: 0, acceptedQualified: true }
pure def windowLive(s: Stamp): bool = s.now >= grantStart and (s.until == -1 or s.now < s.until)
pure def stampValid(s: Stamp): bool = s.cached and s.wellFormed and windowLive(s)
pure def primaryLive(s: Stamp): bool = s.granted and not(s.revoked) and windowLive(s)
pure val untilValues = Set(-1, 2)
pure def canGrantPromo(s: Stamp, until: int): bool = not(s.granted) and (until == -1 or until > grantStart)
pure def grantPromo(s: Stamp, until: int): Stamp = { ...s, granted: true, until: until, cached: true, cachedGeneration: s.generation }
pure def canAdmit(s: Stamp): bool = stampValid(s) and primaryLive(s) and s.cachedGeneration == s.generation
pure def admit(s: Stamp): Stamp = { ...s, accepted: s.accepted + 1, acceptedQualified: s.acceptedQualified and primaryLive(s) }
pure def canRevoke(s: Stamp): bool = s.granted and not(s.revoked)
pure def revoke(s: Stamp): Stamp = { ...s, revoked: true, generation: s.generation + 1 }
pure def canTick(s: Stamp): bool = true
pure def tick(s: Stamp): Stamp = { ...s, now: s.now + 1 }
pure def canCorrupt(s: Stamp): bool = s.wellFormed
pure def corrupt(s: Stamp): Stamp = { ...s, wellFormed: false }
pure def canRefresh(s: Stamp): bool = s.granted
pure def refresh(s: Stamp): Stamp = { ...s, cached: primaryLive(s), cachedGeneration: s.generation, wellFormed: true }
pure def alwaysAdmissionHadPrimaryAuthority(s: Stamp): bool = s.acceptedQualified
pure def alwaysStampInvalidBeforeStart(s: Stamp): bool = s.now < grantStart implies not(stampValid(s))
pure def alwaysExpiredStampInvalid(s: Stamp): bool = (s.until != -1 and s.now >= s.until) implies not(stampValid(s))
pure def stepRevocationFencesNewAdmission(before: Stamp, after: Stamp): bool = before.revoked implies after.accepted == before.accepted
pure def stepExpiryFencesNewAdmission(before: Stamp, after: Stamp): bool = (before.until != -1 and before.now >= before.until) implies after.accepted == before.accepted
pure def sometimesLifetimePromoAdmitted(s: Stamp): bool = s.until == -1 and s.accepted > 0
pure def sometimesRevokedStampRefused(s: Stamp): bool = s.revoked and s.cached and s.cachedGeneration != s.generation
```

## Story: Bound each plan's request rate

> As an operator, each plan admits requests at its burst and sustained
> rates, per resolved identity, and a refused caller is told a retry time
> at which the request will be admitted.

### A request is admitted only when both buckets hold a whole token, and a refusal names a usable retry time

Each identity has a burst bucket and a sustained bucket, refilled in
quarter-token units per tick up to their capacities from the last refill
boundary. A request spends one token (four units) from both or neither.
The refill boundary never moves back when the clock does. A refused reply
names the earliest time at which both buckets will hold a token.

```quint
type BucketLimits = { burstCapacity: int, sustainedCapacity: int, burstRate: int, sustainedRate: int }
type Bucket = { burst: int, sustained: int, at: int }
type BucketReply = { refused: bool, bucket: Bucket, retryAt: int }
pure def maximum(left: int, right: int): int = if (left >= right) left else right
pure def minimum(left: int, right: int): int = if (left <= right) left else right
pure def waitTicks(tokens: int, rate: int): int = if (tokens >= 4) 0 else if (rate <= 0) 0 else (4 - tokens + rate - 1) / rate
pure def consumeRequest(rates: BucketLimits, b: Bucket, now: int): BucketReply = {
  val boundary = maximum(b.at, now)
  val elapsed = boundary - b.at
  val burst = minimum(rates.burstCapacity, b.burst + elapsed * rates.burstRate)
  val sustained = minimum(rates.sustainedCapacity, b.sustained + elapsed * rates.sustainedRate)
  val admitted = burst >= 4 and sustained >= 4
  { refused: not(admitted), bucket: { burst: if (admitted) burst - 4 else burst, sustained: if (admitted) sustained - 4 else sustained, at: boundary },
    retryAt: boundary + maximum(waitTicks(burst, rates.burstRate), waitTicks(sustained, rates.sustainedRate)) }
}
pure val ratesValues = Set({ burstCapacity: 4, sustainedCapacity: 12, burstRate: 1, sustainedRate: 4 }, { burstCapacity: 12, sustainedCapacity: 4, burstRate: 4, sustainedRate: 1 })
pure val bValues = Set({ burst: 4, sustained: 4, at: 4 }, { burst: 0, sustained: 12, at: 4 }, { burst: 3, sustained: 0, at: 6 })
pure val clockValues = Set(0, 4, 5, 8)
pure def bucketInBounds(rates: BucketLimits, x: Bucket): bool = x.burst >= 0 and x.burst <= rates.burstCapacity and x.sustained >= 0 and x.sustained <= rates.sustainedCapacity
pure def lawTokensStayInBounds(rates: BucketLimits, b: Bucket, clock: int): bool = bucketInBounds(rates, b) implies bucketInBounds(rates, consumeRequest(rates, b, clock).bucket)
pure def lawRefillBoundaryNeverRetreats(rates: BucketLimits, b: Bucket, clock: int): bool = consumeRequest(rates, b, clock).bucket.at >= b.at
pure def lawRetryTimeIsUsable(rates: BucketLimits, b: Bucket, clock: int): bool = {
  val reply = consumeRequest(rates, b, clock)
  (reply.refused and rates.burstRate > 0 and rates.sustainedRate > 0 and rates.burstCapacity >= 4 and rates.sustainedCapacity >= 4) implies
    (reply.retryAt >= reply.bucket.at and reply.bucket.burst + (reply.retryAt - reply.bucket.at) * rates.burstRate >= 4 and reply.bucket.sustained + (reply.retryAt - reply.bucket.at) * rates.sustainedRate >= 4)
}
```
