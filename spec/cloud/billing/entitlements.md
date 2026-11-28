# Entitlements

Which plan an organization has, which money pays for its metered calls, the
signed entitlement a device shows its plan from, and the billing snapshot
(`GET /api/v1/billing/limits`, `schemaVersion: 3`). One policy decides all
four: the services admit calls with it (`spec/cloud/services/inference.md`,
`spec/cloud/services/maps.md`), and the device reads it through
`spec/cloud/client.md`. Sources are develop
`packages/cloud/shared/src/lib/services/organization-quota-policy.ts`
(precedence), `subscription-entitlement-token.ts` (claims and expiry) and
`account-limits-snapshot.ts` (one read); downstream, one product reads the
entitlement and the snapshot on its plan screen and another decides from
the snapshot whether its account needs attention.

This library has no state. The shell reads the subscription row, the
organization's grants, its funds row and its current allowance period in
one read-only transaction and passes them in. Signing, the key material,
JSON and the conversion of times to NumericDate seconds stay in the shell;
signature, issuer, audience and account checks reach the spec as
observations. The entitlement presents the plan only: the cloud decides
every metered call from its own policy.

## Story: Read my plan without substituting another account or source

> As a person signed in on a device, I want to see the plan of my own
> account, from what actually pays for it, so that I am never shown another
> account's plan or a plan nobody pays for.

### A subscription with paid limits gives its plan, before any grant

An Active, Dunning, PastDue or Unpaid subscription gives the organization
its plan, whatever grants it holds. Its plan ends at the period end while
Active and at the dunning end while Dunning; a lapsed subscription has no
known end until the provider reports one.

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
import subscriptions as Sub from "./subscriptions"
import grantCodes as G from "./grantCodes"
import allowance as A from "./allowance"
import funds as F from "./funds"
import metering as M from "../shared/metering"
import accounts as Acc from "../identity/accounts"
import deployment as D from "../deployment"
type PlanSource = FromSubscription | FromGrant | FromFree
type PlanEnd = NoPlanEnd | PlanEndsAt({ endsAtMs: Millis })
type HeldGrant = { grant: G::Grant, planKey: PlanKey }
type Policy = { planKey: PlanKey, source: PlanSource, ends: PlanEnd, subscription: Sub::SubscriptionStatus }
pure def subscriptionEnd(s: Sub::Subscription): PlanEnd =
  if (s.status == Sub::Active) PlanEndsAt({ endsAtMs: s.periodEnd })
  else if (s.status == Sub::Dunning) PlanEndsAt({ endsAtMs: Sub::dunningEndsAt(s.dunning) })
  else NoPlanEnd
pure val subscriptionValues: Set[Sub::Subscription] = {
  val active = { ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: PlusMonthly, periodStart: 0, periodEnd: 2592000000 }
  val late = Sub::DunningSince({ startedAt: 0, endsAt: 259200000 })
  Set(Sub::initial).union(Set(active)).union(Set({ ...active, status: Sub::Dunning, dunning: late }))
    .union(Set({ ...active, status: Sub::PastDue, planKey: ProMonthly, dunning: late })).union(Set({ ...active, status: Sub::Unpaid, dunning: late }))
    .union(Set({ ...active, status: Sub::Canceled })).union(Set({ ...active, status: Sub::Pending, periodEnd: 0 }))
}
```

### Otherwise the highest unrevoked grant whose window holds now gives its plan, and else the plan is free

A grant serves from its start until its end, or for ever when lifetime; a
revoked grant stops serving at once. Of several serving grants the highest
plan wins. A canceled, expired, pending or incomplete subscription leaves
the organization on its grant or on the free plan.

```quint
pure val noHeldGrant: HeldGrant = { grant: G::noGrant, planKey: Free }
pure def grantWindowHolds(ends: G::GrantEnd, now: Millis): bool = match ends { | EndsAt(x) => now < x.endsAtMs | NeverEnds => true }
pure def grantServes(g: HeldGrant, now: Millis): bool =
  g.grant.grantId != "" and isPaid(g.planKey) and g.grant.standing == G::InForce and g.grant.startsAt <= now and grantWindowHolds(g.grant.ends, now)
pure def servingGrant(grants: List[HeldGrant], now: Millis): HeldGrant =
  grants.foldl(noHeldGrant, (best, g) => if (grantServes(g, now) and rankOf(g.planKey) > rankOf(best.planKey)) g else best)
pure def grantEnd(ends: G::GrantEnd): PlanEnd = match ends { | EndsAt(x) => PlanEndsAt({ endsAtMs: x.endsAtMs }) | NeverEnds => NoPlanEnd }
pure def policyFrom(subscription: Sub::Subscription, grants: List[HeldGrant], now: Millis): Policy = {
  val g = servingGrant(grants, now)
  if (Sub::hasPaidLimits(subscription.status)) { planKey: subscription.planKey, source: FromSubscription, ends: subscriptionEnd(subscription), subscription: subscription.status }
  else if (isPaid(g.planKey)) { planKey: g.planKey, source: FromGrant, ends: grantEnd(g.grant.ends), subscription: subscription.status }
  else { planKey: Free, source: FromFree, ends: NoPlanEnd, subscription: subscription.status }
}
pure val grantsValues: Set[List[HeldGrant]] = {
  val pro = { grant: { ...G::noGrant, grantId: "grant1", organizationId: "org1", idempotencyKey: "key1", startsAt: 0, ends: G::EndsAt({ endsAtMs: 1000000 }) }, planKey: ProMonthly }
  val plus = { grant: { ...G::noGrant, grantId: "grant2", organizationId: "org1", idempotencyKey: "key2", startsAt: 0 }, planKey: PlusMonthly }
  val revoked = { ...pro, grant: { ...pro.grant, grantId: "grant3", standing: G::RevokedAt({ revokedAtMs: 1 }) } }
  val later = { ...pro, grant: { ...pro.grant, grantId: "grant4", startsAt: 600000 } }
  Set(List()).union(Set(List(plus))).union(Set(List(plus, pro))).union(Set(List(revoked))).union(Set(List(later, plus)))
}
pure val nowValues = Set(0, 500000, 1000000, 2592000000)
pure def lawAPaidSubscriptionComesBeforeAnyGrant(subscription: Sub::Subscription, grants: List[HeldGrant], now: Millis): bool =
  Sub::hasPaidLimits(subscription.status) implies (policyFrom(subscription, grants, now).source == FromSubscription and policyFrom(subscription, grants, now).planKey == subscription.planKey)
pure def lawOnlyTheHighestServingGrantGivesAPlan(subscription: Sub::Subscription, grants: List[HeldGrant], now: Millis): bool = {
  val p = policyFrom(subscription, grants, now)
  p.source == FromGrant implies (grants.some(g => grantServes(g, now) and g.planKey == p.planKey) and grants.every(g => grantServes(g, now) implies rankOf(g.planKey) <= rankOf(p.planKey)))
}
pure def lawAPlanIsPaidExactlyWhenSomethingPaysForIt(subscription: Sub::Subscription, grants: List[HeldGrant], now: Millis): bool =
  Sub::alwaysSubscriptionHasIdPlanAndCustomer(subscription) implies (isPaid(policyFrom(subscription, grants, now).planKey) iff policyFrom(subscription, grants, now).source != FromFree)
```

### A policy that cannot be read answers 503 and gives no plan

The shell passes `PolicyUnreadable` when any row of the read fails or the
read does not finish; it never falls back to the free plan or to a cached
policy.

```quint
type PolicyRead = PolicyUnreadable | PolicyReadable({ subscription: Sub::Subscription, grants: List[HeldGrant] })
type PolicyAnswer = PolicyUnavailable | PolicyOf({ policy: Policy })
pure def effectivePolicy(read: PolicyRead, now: Millis): PolicyAnswer = match read {
  | PolicyReadable(r) => PolicyOf({ policy: policyFrom(r.subscription, r.grants, now) })
  | PolicyUnreadable => PolicyUnavailable
}
pure val policyRefusal: Refusal = refuse(ServiceUnavailable)
```

### A grant or an entitled subscription spends the allowance before credits, any other policy spends credits only, and an unreadable one funds nothing

The lane is the same for inference, speech and maps, and the snapshot shows
it for each. A past-due or unpaid subscription keeps its plan's request
limits but no longer spends allowance. `meteredAllowance` is what metering
receives as `allowanceAvailable`.

```quint
pure def fundsAllowance(p: Policy): bool = isPaid(p.planKey) and (p.source == FromGrant or (p.source == FromSubscription and Sub::isEntitled(p.subscription)))
pure def laneOf(p: Policy): M::FundingLane = if (fundsAllowance(p)) M::AllowanceThenCredits else M::CreditsOnly
pure def fundingLane(a: PolicyAnswer): M::FundingLane = match a { | PolicyOf(x) => laneOf(x.policy) | PolicyUnavailable => M::Refused }
pure def meteredAllowance(lane: M::FundingLane, period: A::Period, now: Millis): Micros = if (lane == M::AllowanceThenCredits) A::spendableAt(period, now) else 0
pure def isUnreadable(read: PolicyRead): bool = match read { | PolicyUnreadable => true | _ => false }
pure val readValues: Set[PolicyRead] = Set(PolicyUnreadable).union(Set(PolicyReadable({ subscription: Sub::initial, grants: List() })))
  .union(Set(PolicyReadable({ subscription: { ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: ProMonthly, periodEnd: 600000 }, grants: List() })))
pure def lawOnlyAnUnreadablePolicyFundsNothing(read: PolicyRead, now: Millis): bool = (fundingLane(effectivePolicy(read, now)) == M::Refused) iff isUnreadable(read)
pure def lawALapsedSubscriptionKeepsItsPlanButSpendsOnlyCredits(subscription: Sub::Subscription, grants: List[HeldGrant], now: Millis): bool =
  (subscription.status == Sub::PastDue or subscription.status == Sub::Unpaid) implies
    (policyFrom(subscription, grants, now).planKey == subscription.planKey and laneOf(policyFrom(subscription, grants, now)) == M::CreditsOnly)
```

### The entitlement states the plan, services and allowance and expires within 30 minutes

An ES256 JWS with header `typ` `eliza-entitlement+jwt` and the signing
key's `kid`; claims `iss` (the API origin), `aud` (the environment's
entitlement audience, `spec/cloud/deployment.md`), `sub` (user id), `org`
(organization id), a fresh `jti`, `iat`, `exp`, `ver: 3`,
`plan {id, name, status}`, `plan_ends_at`, `services` and, while the
allowance pays first and a period is current, `plan_allowance {unit:
"usd_micros", granted, remaining, periodStart, resetsAt}`. Every time claim
is in whole seconds. The status is `active` for a grant or an Active
subscription, `past_due` for Dunning or PastDue, `canceled` for Unpaid and
`none` for the free plan. `exp` is capped at each stated end in whole
seconds, with a minimum of one second after `iat`. When an end rounds
to that issue second or earlier, the entitlement expires after one second.

```quint
type ClaimedStatus = ClaimActive | ClaimPastDue | ClaimCanceled | ClaimNone
type ClaimTime = NoClaimTime | AtSecond({ second: int })
type AllowanceClaim = NoAllowanceClaim | ClaimsAllowance({ granted: Micros, remaining: Micros, periodStartSec: int, resetsAtSec: int })
type Entitlement = { ver: int, issuedAt: int, expiresAt: int, planKey: PlanKey, status: ClaimedStatus, planEndsAt: ClaimTime, services: List[D::Capability], allowance: AllowanceClaim }
pure val entitlementVersion: int = 3
pure val entitlementLifetimeSec: int = 1800
pure def secondsOf(ms: Millis): int = ms / millisPerSecond
pure def claimedStatusOf(p: Policy): ClaimedStatus =
  if (p.source == FromGrant) ClaimActive else if (p.source == FromFree) ClaimNone
  else if (p.subscription == Sub::Active) ClaimActive else if (p.subscription == Sub::Unpaid) ClaimCanceled else ClaimPastDue
pure def claimTimeOf(end: PlanEnd): ClaimTime = match end { | PlanEndsAt(x) => AtSecond({ second: secondsOf(x.endsAtMs) }) | NoPlanEnd => NoClaimTime }
pure def capAt(exp: int, end: PlanEnd): int = match end { | PlanEndsAt(x) => M::minOf(exp, secondsOf(x.endsAtMs)) | NoPlanEnd => exp }
pure def periodCurrent(period: A::Period, now: Millis): bool = period.phase == A::PeriodOpen and now >= period.startsAt and now < period.endsAt
pure def claimsAllowance(p: Policy, period: A::Period, now: Millis): bool = fundsAllowance(p) and periodCurrent(period, now)
pure def issueEntitlement(p: Policy, period: A::Period, offered: Set[D::Capability], now: Millis): Entitlement = {
  val iat = secondsOf(now)
  val shown = claimsAllowance(p, period, now)
  val reset = if (shown) PlanEndsAt({ endsAtMs: period.endsAt }) else NoPlanEnd
  { ver: entitlementVersion, issuedAt: iat, expiresAt: M::maxOf(capAt(capAt(iat + entitlementLifetimeSec, p.ends), reset), iat + 1),
    planKey: p.planKey, status: claimedStatusOf(p), planEndsAt: claimTimeOf(p.ends), services: D::enabledServices(offered),
    allowance: if (shown) ClaimsAllowance({ granted: period.granted + period.adjustment, remaining: period.available, periodStartSec: secondsOf(period.startsAt), resetsAtSec: secondsOf(period.endsAt) }) else NoAllowanceClaim }
}
pure def endsBy(end: PlanEnd, iat: int, exp: int): bool = match end { | PlanEndsAt(x) => secondsOf(x.endsAtMs) > iat implies exp <= secondsOf(x.endsAtMs) | NoPlanEnd => true }
pure val pValues: Set[Policy] = Set({ planKey: Free, source: FromFree, ends: NoPlanEnd, subscription: Sub::NoSubscription })
  .union(Set({ planKey: PlusMonthly, source: FromSubscription, ends: PlanEndsAt({ endsAtMs: 600000 }), subscription: Sub::Active }))
  .union(Set({ planKey: ProMonthly, source: FromGrant, ends: NoPlanEnd, subscription: Sub::Canceled }))
  .union(Set({ planKey: PlusMonthly, source: FromSubscription, ends: NoPlanEnd, subscription: Sub::Unpaid }))
pure val periodValues: Set[A::Period] = {
  val open = { ...A::initial, phase: A::PeriodOpen, source: A::RenewalInvoice({ invoiceId: "in_1" }), planKey: PlusMonthly, startsAt: 0, endsAt: 1200000, granted: 25000000, available: 20000000, settled: 5000000 }
  Set(A::initial).union(Set(open)).union(Set({ ...open, phase: A::PeriodExpired, available: 0, expired: 20000000 }))
}
pure def lawAnEntitlementNeverOutlivesItsPlanOrItsAllowance(p: Policy, period: A::Period, offered: Set[D::Capability], now: Millis): bool = {
  val t = issueEntitlement(p, period, offered, now)
  t.expiresAt > t.issuedAt and t.expiresAt - t.issuedAt <= entitlementLifetimeSec and endsBy(p.ends, t.issuedAt, t.expiresAt)
    and (claimsAllowance(p, period, now) implies endsBy(PlanEndsAt({ endsAtMs: period.endsAt }), t.issuedAt, t.expiresAt))
}
```

### A device accepts an entitlement only when a published key signed it for its own account and audience, issued at most an hour before it expires and within the device's clock-skew tolerance

The device checks the header type, the signature against the published key
of its `kid`, `iss` against the configured origin, `aud` against the
environment's audience, and `sub` and `org` against the account it signed
in with; each check reaches the spec as an observation. A later `ver` is
accepted, since versions only add claims. `iat` may be up to 60 seconds in
the device's future; expiry is strict.

```quint
type EntitlementEvidence = { signedByPublishedKey: bool, typeMatches: bool, issuerMatches: bool, audienceMatches: bool, subjectMatches: bool, organizationMatches: bool, ver: int, issuedAt: int, expiresAt: int }
pure val maxEntitlementLifetimeSec: int = 3600
pure val entitlementClockSkewSec: int = 60
pure def acceptsEntitlement(e: EntitlementEvidence, nowSec: int): bool =
  e.signedByPublishedKey and e.typeMatches and e.issuerMatches and e.audienceMatches and e.subjectMatches and e.organizationMatches
  and e.ver >= entitlementVersion and e.expiresAt > e.issuedAt and e.expiresAt - e.issuedAt <= maxEntitlementLifetimeSec
  and e.issuedAt <= nowSec + entitlementClockSkewSec and nowSec < e.expiresAt
pure def evidenceOf(t: Entitlement): EntitlementEvidence =
  { signedByPublishedKey: true, typeMatches: true, issuerMatches: true, audienceMatches: true, subjectMatches: true, organizationMatches: true, ver: t.ver, issuedAt: t.issuedAt, expiresAt: t.expiresAt }
pure val eValues: Set[EntitlementEvidence] = {
  val good = { signedByPublishedKey: true, typeMatches: true, issuerMatches: true, audienceMatches: true, subjectMatches: true, organizationMatches: true, ver: 3, issuedAt: 0, expiresAt: 1800 }
  Set(good).union(Set({ ...good, organizationMatches: false })).union(Set({ ...good, expiresAt: 7200 })).union(Set({ ...good, issuedAt: 100 }))
}
pure val nowSecValues = Set(-61, -60, 0, 1799, 1800, 3600)
pure def lawAnIssuedEntitlementIsAcceptedUntilItExpires(p: Policy, period: A::Period, offered: Set[D::Capability], now: Millis, nowSec: int): bool = {
  val t = issueEntitlement(p, period, offered, now)
  (nowSec >= t.issuedAt - entitlementClockSkewSec and nowSec < t.expiresAt) iff acceptsEntitlement(evidenceOf(t), nowSec)
}
pure def lawAnAcceptedEntitlementIsLessThanAnHourOld(e: EntitlementEvidence, nowSec: int): bool =
  acceptsEntitlement(e, nowSec) implies nowSec < e.issuedAt + maxEntitlementLifetimeSec
```

### The cloud signs with one configured key and publishes at most 16 public keys, each id once, the signing key among them

`GET /api/v1/subscription/entitlement-keys` answers the configured public
keys; a profile whose key set breaks this refuses to start. Rotation is the
operator's: publish a new key, sign with it, then drop the old key after
its last token expires.

```quint
type KeySet = { signingKid: str, published: List[str] }
pure val maxPublishedKeys: int = 16
pure def keySetValid(k: KeySet): bool =
  k.published.length() <= maxPublishedKeys and k.published.includes(k.signingKid)
  and k.published.every(kid => kid != "" and k.published.select(other => other == kid).length() == 1)
```

## Story: Read my billing state in one snapshot

> As an account owner, I want my plan, balance, allowance and subscription
> read together, so that what my device shows matches what the cloud will
> charge.

### The snapshot is read whole in one transaction or refused as 503, never in part

The shell renders it as `schemaVersion: 3` (`spec/cloud` plan, section
5.4) with times in milliseconds: `account.status`, `balance.usdMicros`
(`F::availableCredits`), `plan {key, source, effectiveUntil}`, the
subscription with its cancel `control` (`Sub::controlOf`), the grant, the
allowance period and `funding {inference, speech, maps}`. The allowance
shows the latest period of the organization; its `available` is what it can
pay now, 0 when the lane spends credits only.

```quint
type AllowanceView = NoAllowanceView | AllowanceShown({ phase: A::PeriodPhase, granted: Micros, available: Micros, startsAt: Millis, resetsAt: Millis })
type Snapshot = { observedAt: Millis, account: Acc::AccountStatus, balance: Micros, policy: Policy, lane: M::FundingLane, allowance: AllowanceView, control: Sub::CancelControl }
type BillingRead = BillingUnreadable | BillingReadable({ account: Acc::AccountStatus, funds: F::Funds, subscription: Sub::Subscription, grants: List[HeldGrant], period: A::Period })
type SnapshotAnswer = SnapshotRefused({ refusal: Refusal }) | SnapshotOf({ snapshot: Snapshot })
pure def allowanceViewOf(lane: M::FundingLane, period: A::Period, now: Millis): AllowanceView =
  if (period.phase == A::PeriodUnopened) NoAllowanceView
  else AllowanceShown({ phase: period.phase, granted: period.granted + period.adjustment, available: meteredAllowance(lane, period, now), startsAt: period.startsAt, resetsAt: period.endsAt })
pure def snapshotFrom(account: Acc::AccountStatus, funds: F::Funds, subscription: Sub::Subscription, grants: List[HeldGrant], period: A::Period, now: Millis): Snapshot = {
  val p = policyFrom(subscription, grants, now)
  { observedAt: now, account: account, balance: F::availableCredits(funds), policy: p, lane: laneOf(p), allowance: allowanceViewOf(laneOf(p), period, now), control: Sub::controlOf(subscription) }
}
pure def billingSnapshot(billing: BillingRead, now: Millis): SnapshotAnswer = match billing {
  | BillingReadable(r) => SnapshotOf({ snapshot: snapshotFrom(r.account, r.funds, r.subscription, r.grants, r.period, now) })
  | BillingUnreadable => SnapshotRefused({ refusal: policyRefusal })
}
```

### An account is usable exactly when it is active and the cloud would fund a call of one micro-dollar

The device decides from the snapshot whether the account needs attention
(`spec/cloud/client.md`): usable when the account is Active, its inference
lane is not refused and its allowance plus its balance is above zero. That
is the same answer metering gives a 1 µUSD quote from the same rows.

```quint
pure def allowanceAvailable(v: AllowanceView): Micros = match v { | AllowanceShown(x) => x.available | NoAllowanceView => 0 }
pure def accountUsable(s: Snapshot): bool = s.account == Acc::Active and s.lane != M::Refused and allowanceAvailable(s.allowance) + s.balance > 0
pure val fundsValues: Set[F::Funds] = Set({ creditBalance: 0, creditHeld: 0, collected: 0 }).union(Set({ creditBalance: 5, creditHeld: 0, collected: 0 })).union(Set({ creditBalance: 5, creditHeld: 5, collected: 0 }))
pure def lawUsableExactlyWhenACallIsFunded(funds: F::Funds, subscription: Sub::Subscription, grants: List[HeldGrant], period: A::Period, now: Millis): bool = {
  val s = snapshotFrom(Acc::Active, funds, subscription, grants, period, now)
  (F::alwaysNeverOverdrawn(funds) and A::alwaysEveryMicroAccounted(period)) implies
    (accountUsable(s) iff M::fundable(s.lane, 1, allowanceAvailable(s.allowance), s.balance))
}
```
