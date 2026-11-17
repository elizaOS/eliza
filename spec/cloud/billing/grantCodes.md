# Grant codes

A grant code gives an organization a paid plan for a fixed time, or for
life, without a payment. The operator mints codes with
`elizaos-cloud grants mint` (`spec/cloud/operator.md`); a person redeems one
with `POST /api/v1/subscription/redeem` `{code, idempotencyKey}` and gets
`{replayed, grant, entitlement}`. One `Code` is one row of `grant_codes`,
found by the keyed digest of the normalized code; text that matches no row
is redeemed against `initial`, so an unknown code and an unusable code get
the same answer. The grants a code issued are kept in its row, one per
organization.

Sources are develop `packages/cloud/shared/src/db/repositories/subscription-grants.ts`
(redeem order, normalization, grant end, revocation), the route
`packages/cloud/api/v1/subscription/redeem/route.ts` and
`packages/cloud/scripts/admin/mint-subscription-grant-codes.ts`. Downstream,
one product redeems codes from its plan screen and reads the grant in the
billing snapshot; another vendors the call and keeps it switched off.

The shell redeems in one store transaction: it locks the organization, then
the code row, reads `now` from the store's clock, and passes in what other
rows say (account status, idempotency keys of the organization's other
grants, the family index, an open or unknown paid subscription). The plan the
grant gives, and its precedence below a paid plan, are
`spec/cloud/billing/entitlements.md`; the allowance months it opens are
`spec/cloud/billing/allowance.md`.

## Story: Redeem a membership code once

> As a person given a membership code, I want to redeem it once for my
> account and get the same answer if I try again, so that I get the plan it
> promises without being charged and without using it up twice.

### A code is 16 Crockford base32 characters, read without case, spaces or hyphens, with I and L read as 1 and O as 0

The spec never sees the code text. Normalization and the format check are
the `//@` function `normalizeSubscriptionCode` of `src/billing/grant-code.ts`,
shared with `@elizaos/cloud/client`: its result uses only the alphabet below
and is accepted exactly when it is 16 characters long. Text that fails it is
refused as `400 grant_code_invalid` before any row is read. The code is a
`SecretCode`: only its keyed digest is stored, and the operator sees it once,
at minting.

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
import rateLimit as R from "../shared/rateLimit"
pure val grantCodeLength: int = 16
pure val crockfordAlphabet: str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
```

### A minted code names a family, a paid plan, a term of whole days or life, a redemption limit and an optional expiry

The term is 183 days unless the operator chooses another number of days or
life; at most 36,500 days keeps every end time a safe integer.

```quint
type CodeStatus = Unminted | Redeemable | Disabled
type Term = TermDays({ days: int }) | TermLifetime
type CodeExpiry = NeverExpires | ExpiresAt({ at: Millis })
type GrantEnd = EndsAt({ endsAtMs: Millis }) | NeverEnds
type GrantStanding = InForce | RevokedAt({ revokedAtMs: Millis })
type Grant = { grantId: str, organizationId: str, idempotencyKey: str, startsAt: Millis, ends: GrantEnd, standing: GrantStanding }
type RedeemAnswer = NoAnswer | Answered({ organizationId: str, grantId: str, replayed: bool }) | RedeemRefused({ refusal: Refusal })
type Code = { status: CodeStatus, family: str, planKey: PlanKey, term: Term, requiresNoPaidPlan: bool, maxRedemptions: int, expiry: CodeExpiry, grants: List[Grant], last: RedeemAnswer }
pure val initial: Code = { status: Unminted, family: "", planKey: Free, term: TermLifetime, requiresNoPaidPlan: false, maxRedemptions: 0, expiry: NeverExpires, grants: List(), last: NoAnswer }
pure val defaultTerm: Term = TermDays({ days: 183 })
pure val maxTermDays: int = 36500
pure def validTerm(term: Term): bool = match term { | TermDays(x) => x.days >= 1 and x.days <= maxTermDays | TermLifetime => true }
pure def validExpiry(expiry: CodeExpiry): bool = match expiry { | ExpiresAt(x) => x.at >= 0 | NeverExpires => true }
pure def canMint(c: Code, family: str, planKey: PlanKey, term: Term, requiresNoPaidPlan: bool, maxRedemptions: int, expiry: CodeExpiry): bool =
  c.status == Unminted and family != "" and isPaid(planKey) and validTerm(term) and maxRedemptions >= 1 and validExpiry(expiry)
pure def mint(c: Code, family: str, planKey: PlanKey, term: Term, requiresNoPaidPlan: bool, maxRedemptions: int, expiry: CodeExpiry): Code =
  { ...c, status: Redeemable, family: family, planKey: planKey, term: term, requiresNoPaidPlan: requiresNoPaidPlan, maxRedemptions: maxRedemptions, expiry: expiry }
pure val familyValues = Set("founders")
pure val termValues = Set(TermDays({ days: 183 }), TermLifetime)
pure val maxRedemptionsValues = Set(1, 2)
pure val expiryValues = Set(NeverExpires, ExpiresAt({ at: 1 }))
pure def alwaysAMintedCodeIsWellFormed(c: Code): bool =
  if (c.status == Unminted) c.maxRedemptions == 0 and c.grants.length() == 0
  else c.family != "" and isPaid(c.planKey) and validTerm(c.term) and c.maxRedemptions >= 1 and validExpiry(c.expiry)
pure def stepTermsNeverChangeOnceMinted(before: Code, after: Code): bool =
  before.status != Unminted implies (after.family == before.family and after.planKey == before.planKey and after.term == before.term
    and after.requiresNoPaidPlan == before.requiresNoPaidPlan and after.maxRedemptions == before.maxRedemptions and after.expiry == before.expiry)
```

### A grant starts when it is redeemed and ends after the code's term, or never for a lifetime code

```quint
pure def grantEndOf(term: Term, startsAt: Millis): GrantEnd = match term { | TermDays(x) => EndsAt({ endsAtMs: startsAt + x.days * millisPerDay }) | TermLifetime => NeverEnds }
pure val noGrant: Grant = { grantId: "", organizationId: "", idempotencyKey: "", startsAt: 0, ends: NeverEnds, standing: InForce }
pure def hasRedeemed(c: Code, organizationId: str): bool = c.grants.some(g => g.organizationId == organizationId)
pure def grantOf(c: Code, organizationId: str): Grant = c.grants.select(g => g.organizationId == organizationId).nthOr(0, noGrant)
pure def grantFits(c: Code, g: Grant): bool = g.grantId != "" and g.organizationId != "" and g.idempotencyKey != "" and g.startsAt >= 0 and g.ends == grantEndOf(c.term, g.startsAt)
pure def alwaysEveryGrantFitsItsCode(c: Code): bool = c.grants.every(g => grantFits(c, g))
pure def sometimesLifetimeGrant(c: Code): bool = c.grants.some(g => g.ends == NeverEnds)
```

### Redeeming checks, in order, the account, the code, a replay, the code's use, the idempotency key, the family and a paid plan

An account that is not Active is refused `403 access_denied` with reason
`account_inactive`. An unknown code is `400 grant_code_invalid`. An
organization that already redeemed this code gets its original grant back
with `replayed: true`, even after the code was disabled, expired, used up or
its grant revoked. A disabled, expired or used-up code is then
`400 grant_code_invalid`, before the checks below, so their answers never
confirm that such a code exists. An idempotency key the organization used
for another code is `409 idempotency_conflict`; a family the organization
already holds through another code, revoked or not, is
`409 subscription_grant_already_redeemed`; a code that requires no paid plan,
offered while the organization has an open or unknown paid subscription, is
`409 subscription_grant_paid_plan_active`. Otherwise the grant is issued
and the code counts one more redemption.

```quint
pure def redeemableAt(c: Code, now: Millis): bool = {
  val e = c.expiry
  c.status == Redeemable and c.grants.length() < c.maxRedemptions and match e { | ExpiresAt(x) => now < x.at | NeverExpires => true }
}
pure def redeemAnswer(c: Code, organizationId: str, accountActive: bool, idempotencyKey: str, keyUsedForAnotherCode: bool, familyHeld: bool, paidPlanOpen: bool, grantId: str, now: Millis): RedeemAnswer =
  if (not(accountActive)) RedeemRefused({ refusal: refuseFor(AccessDenied, AccountInactive) })
  else if (c.status == Unminted) RedeemRefused({ refusal: refuse(GrantCodeInvalid) })
  else if (hasRedeemed(c, organizationId)) Answered({ organizationId: organizationId, grantId: grantOf(c, organizationId).grantId, replayed: true })
  else if (not(redeemableAt(c, now))) RedeemRefused({ refusal: refuse(GrantCodeInvalid) })
  else if (keyUsedForAnotherCode) RedeemRefused({ refusal: refuse(IdempotencyConflict) })
  else if (familyHeld) RedeemRefused({ refusal: refuse(SubscriptionGrantAlreadyRedeemed) })
  else if (c.requiresNoPaidPlan and paidPlanOpen) RedeemRefused({ refusal: refuse(SubscriptionGrantPaidPlanActive) })
  else Answered({ organizationId: organizationId, grantId: grantId, replayed: false })
type CodeEffect = OpenGrantMonths({ grantId: str, planKey: PlanKey, startsAt: Millis, ends: GrantEnd }) | RetireGrantMonths({ grantId: str })
type CodeStep = { state: Code, out: List[CodeEffect] }
pure def canRedeem(c: Code, organizationId: str, idempotencyKey: str, grantId: str, now: Millis): bool =
  organizationId != "" and idempotencyKey != "" and grantId != "" and now >= 0
pure def redeem(c: Code, organizationId: str, accountActive: bool, idempotencyKey: str, keyUsedForAnotherCode: bool, familyHeld: bool, paidPlanOpen: bool, grantId: str, now: Millis): CodeStep = {
  val answer = redeemAnswer(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now)
  val issued = answer == Answered({ organizationId: organizationId, grantId: grantId, replayed: false })
  val g = { grantId: grantId, organizationId: organizationId, idempotencyKey: idempotencyKey, startsAt: now, ends: grantEndOf(c.term, now), standing: InForce }
  if (issued) { state: { ...c, grants: c.grants.append(g), last: answer }, out: List(OpenGrantMonths({ grantId: grantId, planKey: c.planKey, startsAt: now, ends: g.ends })) }
  else { state: { ...c, last: answer }, out: List() }
}
pure val organizationIdValues = Set("org1", "org2")
pure val idempotencyKeyValues = Set("key1", "key2")
pure val grantIdValues = Set("grant1")
pure val nowValues = Set(0, 1, 2)
pure val weight_redeem = 6
pure def isFreshAnswer(a: RedeemAnswer): bool = match a { | Answered(x) => not(x.replayed) | _ => false }
pure def isReplayAnswer(a: RedeemAnswer): bool = match a { | Answered(x) => x.replayed | _ => false }
pure def refusedWith(a: RedeemAnswer, code: RefusalCode): bool = match a { | RedeemRefused(x) => x.refusal.code == code | _ => false }
pure def sometimesGranted(c: Code): bool = isFreshAnswer(c.last)
pure def sometimesRefusedForAPaidPlan(c: Code): bool = refusedWith(c.last, SubscriptionGrantPaidPlanActive)
pure def sometimesRefusedForAHeldFamily(c: Code): bool = refusedWith(c.last, SubscriptionGrantAlreadyRedeemed)
pure def sometimesRefusedForAReusedKey(c: Code): bool = refusedWith(c.last, IdempotencyConflict)
```

### Every answer names a grant this code issued to that organization, or is a well-formed refusal

```quint
pure def alwaysAnswerIsHeldOrWellFormed(c: Code): bool = {
  val a = c.last
  match a {
    | Answered(x) => hasRedeemed(c, x.organizationId) and grantOf(c, x.organizationId).grantId == x.grantId
    | RedeemRefused(x) => wellFormed(x.refusal)
    | NoAnswer => true
  }
}
pure def sometimesReplayed(c: Code): bool = isReplayAnswer(c.last)
```

### A code never issues more grants than its limit, and only a fresh redemption issues one, opening its allowance months

The shell inserts the grant row and opens each month of the grant with
`openGrantMonth` of `spec/cloud/billing/allowance.md`, bounded by UTC
calendar months from `startsAt`; a lifetime grant opens the current month and
the next two, and the allowance sweep opens later months as they come.

```quint
pure def alwaysWithinTheRedemptionLimit(c: Code): bool = c.grants.length() <= c.maxRedemptions
pure def stepOnlyAFreshRedemptionIssuesAGrant(before: Code, via: str, after: Code, out: List[CodeEffect]): bool =
  (after.grants.length() > before.grants.length()) iff (via == "redeem" and isFreshAnswer(after.last) and after.grants.length() == before.grants.length() + 1
    and out == List(OpenGrantMonths({ grantId: grantOf(after, after.grants.nthOr(before.grants.length(), noGrant).organizationId).grantId, planKey: after.planKey,
      startsAt: after.grants.nthOr(before.grants.length(), noGrant).startsAt, ends: after.grants.nthOr(before.grants.length(), noGrant).ends })))
pure def stepGrantsAreNeverTakenBack(before: Code, after: Code): bool =
  after.grants.length() >= before.grants.length() and before.grants.every(g => after.grants.some(h => h.grantId == g.grantId and h.organizationId == g.organizationId and h.startsAt == g.startsAt and h.ends == g.ends))
pure def sometimesUsedUp(c: Code): bool = c.status == Redeemable and c.grants.length() == c.maxRedemptions and refusedWith(c.last, GrantCodeInvalid)
```

### A disabled, expired or used-up code answers as an unknown one

```quint
pure def stepUnusableCodeLooksUnknown(before: Code, via: str, after: Code): bool =
  (via == "redeem" and (before.status == Disabled or before.grants.length() >= before.maxRedemptions))
    implies (refusedWith(after.last, GrantCodeInvalid) or refusedWith(after.last, AccessDenied) or isReplayAnswer(after.last))
```

### A credential may try 5 codes and a client address 60 codes in 15 minutes

Both limits apply to every redeem request, through `requestAll` of
`spec/cloud/shared/rateLimit.md`, before the code is read.

```quint
pure val redeemPerCredential: R::RateLimit = R::perWindow("grantRedeemPerCredential", 5, 15 * millisPerMinute)
pure val redeemPerAddress: R::RateLimit = R::perWindow("grantRedeemPerAddress", 60, 15 * millisPerMinute)
```

## Story: Stop a code or a grant

> As the operator, I want to disable a code that leaked and end a grant that
> was given in error, so that nobody keeps a plan they should not have.

### A disabled code stays disabled and issues no new grant, but its grants stand

```quint
pure def canDisable(c: Code): bool = c.status == Redeemable
pure def disable(c: Code): Code = { ...c, status: Disabled }
pure def stepDisabledStaysDisabled(before: Code, after: Code): bool = before.status == Disabled implies after.status == Disabled
pure def sometimesDisabledCodeStillReplays(c: Code): bool = c.status == Disabled and isReplayAnswer(c.last)
```

### Revoking a grant ends it at once and retires its open allowance months, and the organization keeps its place in the family

Revoking twice is refused. The organization's effective plan falls back to
its next grant or the free plan (`spec/cloud/billing/entitlements.md`); each
open month closes with `GrantRevoked`.

```quint
pure def isInForce(g: Grant): bool = g.standing == InForce
pure def canRevokeGrant(c: Code, organizationId: str, now: Millis): bool =
  hasRedeemed(c, organizationId) and isInForce(grantOf(c, organizationId)) and now >= grantOf(c, organizationId).startsAt
pure def revokeGrant(c: Code, organizationId: str, now: Millis): CodeStep =
  { state: { ...c, grants: c.grants.listMap(g => if (g.organizationId == organizationId) { ...g, standing: RevokedAt({ revokedAtMs: now }) } else g) },
    out: List(RetireGrantMonths({ grantId: grantOf(c, organizationId).grantId })) }
pure def stepRevocationIsFinal(before: Code, after: Code): bool =
  before.grants.every(g => isInForce(g) or after.grants.some(h => h.grantId == g.grantId and h.organizationId == g.organizationId and h.standing == g.standing))
pure def sometimesGrantRevoked(c: Code): bool = c.grants.some(g => not(isInForce(g)))
```
