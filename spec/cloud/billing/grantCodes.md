# Grant codes

A grant code gives an organization a paid plan for a fixed time, or for
life, without a payment. The operator mints codes with
`elizaos-cloud grants mint` (`spec/cloud/operator.md`); a person redeems one
with `POST /api/v1/subscription/redeem` `{code, idempotencyKey}` and gets
`{replayed, grant, entitlement}`. The grant uses the billing snapshot's
grant fields. The entitlement contains the effective plan summary as
`{plan: {key, source, effectiveUntil}}`. The idempotency key has 8 to 128 ASCII
letters, digits or characters from `._:-`. One `Code` is one row of `grant_codes`,
found by the keyed digest of the normalized code; text that matches no row
is redeemed against `initial`, so an unknown code and an unusable code get
the same answer. The grants a code issued are kept in its row, one per
organization.

The redemption route and store operations live in
`packages/cloud-worker/src/billing/grant-codes.vibe`. The operator commands
live in `packages/cloud-worker/src/operator/grants.vibe`. Downstream, one
product redeems codes from its plan screen and reads the grant in the
billing snapshot, while another vendors the call and keeps it switched off.

The shell redeems in one store transaction. It locks the organization, the
account, and the code row in that order. It reads `now` once the rows are
locked and passes in what the store says about the
account, idempotency keys and families of its grants, and an open or unknown
paid subscription. The
effective plan, where a paid subscription always comes before an unrevoked
grant whose window holds `now`, is `spec/cloud/billing/entitlements.md`; the
allowance months a grant opens are `spec/cloud/billing/allowance.md`.

## Story: Redeem a membership code once

> As a person given a membership code, I want to redeem it once for my
> account and get the same answer if I try again, so that I get the plan it
> promises without being charged and without using it up twice.

### A code is 16 Crockford base32 characters, read without case, spaces or hyphens, with I and L read as 1 and O as 0

Normalization uses the complete UTF-16 input, kept as `SecretCodeUnits`.
The string codec in `src/billing/grant-code.vibe` supplies and reconstructs
those units without applying another normalization policy. The pure rules
use Unicode 18's locale-insensitive uppercase mappings, including expansions
such as sharp-s to SS, then remove ECMAScript whitespace and hyphens and read
O as 0 and I or L as 1. Unpaired surrogates and other non-alphabet input are
invalid. Once the result exceeds 16 units, it stays invalid. The walk stops
retaining units at that point so long invalid input cannot grow the result.
The device client exposes the same normalizer. Invalid input returns `null`.
[UnicodeData](https://www.unicode.org/Public/18.0.0/ucd/UnicodeData.txt) and
[SpecialCasing](https://www.unicode.org/Public/18.0.0/ucd/SpecialCasing.txt)
define the mappings; `core/streamUnits` supplies the whitespace predicate.

Only `declassifyGrantCodeValid` reveals whether the result is exactly 16
Crockford characters. The offered and canonical units remain secret; the
public validity bit supports the `400 grant_code_invalid` refusal before
any code row is read. Only a keyed digest is stored. The operator sees a
new code once, after its mint transaction commits.

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
import rateLimit as R from "../shared/rateLimit"
import streamUnits as TextUnits from "../../core/streamUnits"
pure val grantCodeLength: int = 16
pure val crockfordAlphabetUnits: List[int] = List(48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 65, 66, 67, 68, 69, 70, 71, 72, 74, 75, 77, 78, 80, 81, 82, 83, 84, 86, 87, 88, 89, 90)
type SecretCodeUnit = int
type SecretCodeUnits = List[SecretCodeUnit]
type SecretCodeWalk = { pendingGrantHigh: SecretCodeUnit, normalizedGrantUnits: SecretCodeUnits }
pure def grantUnit(code: SecretCodeUnit): List[SecretCodeUnit] = List(code)
pure def normalizeGrantUnit(code: SecretCodeUnit): List[SecretCodeUnit] =
  if (TextUnits::whitespace(code) or code == 45) List()
  else if (code == 79 or code == 111) List(48)
  else if (code == 73 or code == 76 or code == 105 or code == 108 or code == 305) List(49)
  else if (code >= 97 and code <= 122) grantUnit(code - 32)
  else if (code == 223) List(83, 83)
  else if (code == 383) List(83)
  else if (code == 64256) List(70, 70)
  else if (code == 64257 or code == 64258) List(70, 49)
  else if (code == 64259 or code == 64260) List(70, 70, 49)
  else if (code == 64261 or code == 64262) List(83, 84)
  else if (code >= 0 and code <= 127) grantUnit(code)
  else List(-1)
pure def normalizeGrantStep(walk: SecretCodeWalk, code: SecretCodeUnit): SecretCodeWalk = {
  val prefix = if (walk.pendingGrantHigh == 55351) walk.normalizedGrantUnits.append(-1) else walk.normalizedGrantUnits
  if (walk.normalizedGrantUnits.length() > grantCodeLength) walk
  else if (walk.pendingGrantHigh == 55351 and code == 57237) { pendingGrantHigh: 0, normalizedGrantUnits: walk.normalizedGrantUnits.concat(List(83, 83)) }
  else if (code == 55351) { pendingGrantHigh: 55351, normalizedGrantUnits: prefix }
  else { pendingGrantHigh: 0, normalizedGrantUnits: prefix.concat(normalizeGrantUnit(code)) }
}
pure def normalizeGrantCodeUnits(units: SecretCodeUnits): SecretCodeUnits = {
  val walked = units.foldl({ pendingGrantHigh: 0, normalizedGrantUnits: List() }, (walk, code) => normalizeGrantStep(walk, code))
  if (walked.pendingGrantHigh == 55351) walked.normalizedGrantUnits.append(-1) else walked.normalizedGrantUnits
}
pure def declassifyGrantCodeValid(units: SecretCodeUnits): bool =
  units.length() == grantCodeLength and units.every(code => crockfordAlphabetUnits.includes(code))
pure def appendGrantDraw(units: SecretCodeUnits, code: SecretCodeUnit): List[SecretCodeUnit] =
  units.append(crockfordAlphabetUnits.nthOr(code % 32, -1))
pure def encodeGrantCodeDraws(draws: SecretCodeUnits): SecretCodeUnits =
  if (draws.length() == grantCodeLength and draws.every(code => code >= 0 and code <= 255)) draws.foldl(List(), (units, code) => appendGrantDraw(units, code)) else List()
pure def lawCanonicalCodesSurviveNormalization(units: SecretCodeUnits): bool =
  declassifyGrantCodeValid(units) implies normalizeGrantCodeUnits(units) == units
pure def lawByteDrawsMakeCanonicalCodes(draws: SecretCodeUnits): bool =
  (draws.length() == grantCodeLength and draws.every(code => code >= 0 and code <= 255)) implies declassifyGrantCodeValid(encodeGrantCodeDraws(draws))
pure val unitsValues: Set[SecretCodeUnits] = Set(List(), List(48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 65, 66, 67, 68, 69, 70), List(97, 45, 305, 383, 223, 64259), List(55351, 57237), List(55351, 45, 57237))
pure val drawsValues: Set[SecretCodeUnits] = Set(List(), List(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255))
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
`400 grant_code_invalid`. An idempotency key the organization used
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
pure def redeemAnswer(c: Code, organizationId: str, accountActive: bool, keyUsedForAnotherCode: bool, familyHeld: bool, paidPlanOpen: bool, grantId: str, now: Millis): RedeemAnswer =
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
  organizationId != "" and idempotencyKey != "" and grantId != "" and now >= 0 and not(c.grants.some(g => g.grantId == grantId))
pure def redeem(c: Code, organizationId: str, accountActive: bool, idempotencyKey: str, keyUsedForAnotherCode: bool, familyHeld: bool, paidPlanOpen: bool, grantId: str, now: Millis): CodeStep = {
  val answer = redeemAnswer(c, organizationId, accountActive, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now)
  val issued = answer == Answered({ organizationId: organizationId, grantId: grantId, replayed: false })
  val g = { grantId: grantId, organizationId: organizationId, idempotencyKey: idempotencyKey, startsAt: now, ends: grantEndOf(c.term, now), standing: InForce }
  if (issued) { state: { ...c, grants: c.grants.append(g), last: answer }, out: List(OpenGrantMonths({ grantId: grantId, planKey: c.planKey, startsAt: now, ends: g.ends })) }
  else { state: { ...c, last: answer }, out: List() }
}
pure val organizationIdValues = Set("org1", "org2")
pure val idempotencyKeyValues = Set("key1", "key2")
pure val grantIdValues = Set("grant1", "grant2")
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

### An organization holds at most one grant of a code, and no two grants share an id

The shell draws a fresh grant id for each redemption; the guard refuses one
already used, so the store's unique index is never the first to say so.

```quint
pure def alwaysOneGrantPerOrganizationAndId(c: Code): bool =
  c.grants.every(g => c.grants.select(h => h.organizationId == g.organizationId or h.grantId == g.grantId).length() == 1)
pure def sometimesTwoOrganizationsHold(c: Code): bool = c.grants.length() == 2
```

### A code never issues more grants than its limit, and only a fresh redemption issues one, opening its allowance months

The shell inserts the grant row and opens each month of the grant with
`openGrantMonth` of `spec/cloud/billing/allowance.md`, bounded by UTC
calendar months from `startsAt`; a lifetime grant opens the current month and
the next two, and the allowance sweep opens later months as they come.

```quint
pure def alwaysWithinTheRedemptionLimit(c: Code): bool = c.grants.length() <= c.maxRedemptions
pure def stepOnlyAFreshRedemptionIssuesAGrant(before: Code, via: str, after: Code, out: List[CodeEffect]): bool = {
  val n = before.grants.length()
  val g = after.grants.nthOr(n, noGrant)
  (after.grants.length() > n) iff (via == "redeem" and isFreshAnswer(after.last) and after.grants.length() == n + 1
    and out == List(OpenGrantMonths({ grantId: g.grantId, planKey: after.planKey, startsAt: g.startsAt, ends: g.ends })))
}
pure def stepGrantsAreNeverTakenBack(before: Code, after: Code): bool =
  after.grants.length() >= before.grants.length() and before.grants.every(g => after.grants.some(h => h.grantId == g.grantId and h.organizationId == g.organizationId and h.startsAt == g.startsAt and h.ends == g.ends))
pure def sometimesUsedUp(c: Code): bool = c.status == Redeemable and c.grants.length() == c.maxRedemptions and refusedWith(c.last, GrantCodeInvalid)
```

### A disabled, expired or used-up code answers as an unknown one, unless the organization already holds its grant

The check of the code's use comes before the idempotency, family and
paid-plan checks, so none of their answers, and no fresh grant, can come
from a code nobody may redeem now.

```quint
pure def lawUnusableCodeLooksUnknown(offered: Code, organizationId: str, accountActive: bool, keyUsedForAnotherCode: bool, familyHeld: bool, paidPlanOpen: bool, grantId: str, now: Millis): bool = {
  val a = redeemAnswer(offered, organizationId, accountActive, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now)
  (not(hasRedeemed(offered, organizationId)) and not(redeemableAt(offered, now))) implies (refusedWith(a, GrantCodeInvalid) or refusedWith(a, AccessDenied))
}
pure val mintedForTwo: Code = mint(initial, "founders", PlusMonthly, defaultTerm, true, 2, ExpiresAt({ at: 1 }))
pure val heldByOrg1: Grant = { grantId: "grant1", organizationId: "org1", idempotencyKey: "key1", startsAt: 0, ends: grantEndOf(defaultTerm, 0), standing: InForce }
pure val offeredValues: Set[Code] = Set(initial, mintedForTwo, disable(mintedForTwo),
  { ...mintedForTwo, maxRedemptions: 1, grants: List(heldByOrg1) }, { ...mintedForTwo, expiry: NeverExpires })
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

### Revoking a grant ends it at once, never before it began, and a revoked grant stays revoked

Revoking a revoked grant changes nothing. The revoked grant stays in the
code's row, so the organization keeps its place in the family and a replay
still answers it. The organization's effective plan falls back to another
grant in force or the free plan (`spec/cloud/billing/entitlements.md`). The
operator's `grants revoke --code` revokes each grant and disables the code.
The command locks organizations in id order before locking the code. If a
redemption added an organization to the code while those locks were being
taken, the command retries the transaction with the new list.

```quint
pure def isInForce(g: Grant): bool = g.standing == InForce
pure def revokedInTime(g: Grant): bool = {
  val standing = g.standing
  match standing { | RevokedAt(x) => x.revokedAtMs >= g.startsAt | InForce => true }
}
pure def canRevokeGrant(c: Code, organizationId: str, now: Millis): bool =
  hasRedeemed(c, organizationId) and isInForce(grantOf(c, organizationId)) and now >= grantOf(c, organizationId).startsAt
pure def revokeGrant(c: Code, organizationId: str, now: Millis): CodeStep =
  { state: { ...c, grants: c.grants.listMap(g => if (g.organizationId == organizationId) { ...g, standing: RevokedAt({ revokedAtMs: now }) } else g) },
    out: List(RetireGrantMonths({ grantId: grantOf(c, organizationId).grantId })) }
pure def alwaysRevokedNoEarlierThanItBegan(c: Code): bool = c.grants.every(g => revokedInTime(g))
pure def stepRevocationIsFinal(before: Code, after: Code): bool =
  before.grants.every(g => isInForce(g) or after.grants.some(h => h.grantId == g.grantId and h.organizationId == g.organizationId and h.standing == g.standing))
pure def sometimesGrantRevoked(c: Code): bool = c.grants.some(g => not(isInForce(g)))
```

### Only revoking a grant in force retires its allowance months

Each open month of the grant closes with `GrantRevoked`
(`spec/cloud/billing/allowance.md`).

```quint
pure def retiredGrantId(e: CodeEffect): str = match e { | RetireGrantMonths(x) => x.grantId | OpenGrantMonths(_) => "" }
pure def stepOnlyRevocationRetiresMonths(before: Code, via: str, after: Code, out: List[CodeEffect]): bool =
  out.every(e => retiredGrantId(e) == "" or (via == "revokeGrant"
    and before.grants.some(g => g.grantId == retiredGrantId(e) and isInForce(g))
    and after.grants.some(g => g.grantId == retiredGrantId(e) and not(isInForce(g)))))
```
