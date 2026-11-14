# Cloud entitlement and credential-bound billing

AlphaPhone projects `packages/cloud/sdk/src/subscription-entitlement.ts`
and `cloud-account-billing.ts` from its Eliza pin. Its renderer calls
these through `apps/app/src/runtime/subscription-entitlement.ts` and
`cloud-protocol.ts`. Grace uses the native host billing routes and the
`OrganizationSubscriptionFundingOperation` and native subscription
command types at its own pin. This spec covers the Alpha entitlement
source decision and one credential-bound billing read. Grace's native
billing mutations have their own operation and confirmation contracts.

## Story: Read my plan without substituting a different account or source

### An entitlement is accepted only for the expected signed identity and time

The token verifier admits supported ES256 tokens of the entitlement type
without an unrecognized critical extension. The issuer and configured
audience must match. Subject and organization IDs compare ignoring UUID
letter case. Canonical values represent that comparison. Validity cannot
exceed one hour. The issued and not-before checks allow up to one minute
of clock skew. Expiry is strict. Signature, JWKS selection and shape
validation are boundary evidence supplied by the verifier.

```quint
type TokenEvidence = { supportedHeader: bool, issuerMatches: bool, audienceMatches: bool, subjectMatches: bool, organizationMatches: bool, validSignature: bool, validClaims: bool, issuedAt: int, notBefore: int, expiresAt: int }
pure def acceptsToken(token: TokenEvidence, now: int): bool = token.supportedHeader and token.issuerMatches and token.audienceMatches and token.subjectMatches and token.organizationMatches and token.validSignature and token.validClaims and token.expiresAt > token.issuedAt and token.expiresAt - token.issuedAt <= 3600000 and token.notBefore - 60000 <= now and token.issuedAt - 60000 <= now and token.expiresAt > now
pure val tokenValues = Set(
  { supportedHeader: true, issuerMatches: true, audienceMatches: true, subjectMatches: true, organizationMatches: true, validSignature: true, validClaims: true, issuedAt: 0, notBefore: 0, expiresAt: 3600000 },
  { supportedHeader: true, issuerMatches: true, audienceMatches: true, subjectMatches: true, organizationMatches: false, validSignature: true, validClaims: true, issuedAt: 0, notBefore: 0, expiresAt: 3600000 },
  { supportedHeader: true, issuerMatches: true, audienceMatches: true, subjectMatches: true, organizationMatches: true, validSignature: false, validClaims: true, issuedAt: 0, notBefore: 0, expiresAt: 3600000 })
pure val nowValues = Set(-60001, -60000, 0, 3599999, 3600000)
pure def lawExpiredTokenRefused(token: TokenEvidence, now: int): bool = token.expiresAt <= now implies not(acceptsToken(token, now))
pure def lawForeignAccountCannotUseEntitlement(token: TokenEvidence, now: int): bool = (not(token.subjectMatches) or not(token.organizationMatches)) implies not(acceptsToken(token, now))
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

The billing SDK captures a nonempty, unexpired credential identity. It
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
