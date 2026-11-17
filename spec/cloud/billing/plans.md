# Plan catalog

The plans the cloud sells, what each includes and the request rates each
allows. The catalog is fixed in code (version `v1`): an operator changes it
only with a release. Sources are develop
`packages/cloud/shared/src/lib/services/subscription-catalog.ts` (plans,
prices, allowances), `org-rate-limits.ts` (rates per class) and
`lib/voice-session/config.ts` (the realtime speech day). Downstream readers are
the products' plan screens, which list the paid plans by price and choose an
upgrade or a downgrade by order.

This library has no state. Develop's resource ceilings (characters,
sandboxes, containers, storage, apps) and API key counts are gone: the cloud
hosts nothing, and the only keys are device keys. The `embeddings` and
`strict` rate classes are gone (no caller). Whether the payment provider's
prices match this catalog is checked at start-up by `spec/cloud/deployment.md`
from the amounts here.

## Story: Offer the paid plans as the provider sells them

> As a person choosing a plan, I want to see each paid plan with its monthly
> price and what it includes, so that I know what I pay for before I pay.

### The catalog is version v1 and holds exactly the free plan, Plus and Pro

Free is what an account has without a subscription or a grant; it is never
sold. Plus and Pro are billed monthly in US dollars, one seat each, with no
trial. A stored plan key is always one of these three; an unknown key on the
wire is refused by the schema before any spec sees it.

```quint
import types.* from "../shared/types"
type PlanKey = Free | PlusMonthly | ProMonthly
type PlanTerms = { key: PlanKey, name: str, rank: int, priceMicros: Micros, allowanceMicros: Micros, completionsRpm: int, standardRpm: int }
pure val catalogVersion = "v1"
pure val freePlan: PlanTerms = { key: Free, name: "Free", rank: 0, priceMicros: 0, allowanceMicros: 0, completionsRpm: 60, standardRpm: 30 }
pure val plusPlan: PlanTerms = { key: PlusMonthly, name: "Plus", rank: 1, priceMicros: 30000000, allowanceMicros: 25000000, completionsRpm: 120, standardRpm: 60 }
pure val proPlan: PlanTerms = { key: ProMonthly, name: "Pro", rank: 2, priceMicros: 100000000, allowanceMicros: 90000000, completionsRpm: 300, standardRpm: 120 }
pure def termsOf(key: PlanKey): PlanTerms = if (key == ProMonthly) proPlan else if (key == PlusMonthly) plusPlan else freePlan
pure def isPaid(key: PlanKey): bool = key != Free
pure def lawTermsNameTheirOwnPlan(key: PlanKey): bool = termsOf(key).key == key
```

### Only the free plan is free, and a paid plan costs whole cents each month

The wire carries the price as `amountCents`, so a price that is not a whole
number of cents could not be sold as written.

```quint
pure def priceOf(key: PlanKey): Micros = termsOf(key).priceMicros
pure def amountCentsOf(key: PlanKey): int = centsOf(priceOf(key))
pure def lawOnlyTheFreePlanIsFree(key: PlanKey): bool = (priceOf(key) == 0) iff not(isPaid(key))
pure def lawPriceIsWholeCents(key: PlanKey): bool = microsOfCents(amountCentsOf(key)) == priceOf(key)
```

### Every paid plan includes a monthly allowance smaller than its price, and the free plan includes none

The allowance is spent before credits and expires at the end of its period
(`spec/cloud/billing/allowance.md`); it is never carried over. Keeping it
below the price means a plan never gives away more than it earns.

```quint
pure def allowanceOf(key: PlanKey): Micros = termsOf(key).allowanceMicros
pure def hasAllowance(key: PlanKey): bool = allowanceOf(key) > 0
pure def lawAllowanceOnlyWithAPaidPlan(key: PlanKey): bool = hasAllowance(key) iff isPaid(key)
pure def lawAllowanceBelowPrice(key: PlanKey): bool = allowanceOf(key) >= 0 and (isPaid(key) implies allowanceOf(key) < priceOf(key))
```

### The plan list shows the paid plans only, cheapest first

`GET /api/v1/subscriptions/plans` is public and answers
`{plans: [{key, name, amountCents, currency: "usd", interval: "month",
allowance: {amountUsd}}]}`; the shell renders `amountUsd` from the allowance
in µUSD with six decimals, and the key as `plus_monthly` or `pro_monthly`.

```quint
type PlanOffer = { key: PlanKey, name: str, amountCents: int, allowanceMicros: Micros }
pure val paidPlanKeys: List[PlanKey] = List(PlusMonthly, ProMonthly)
pure def offerOf(key: PlanKey): PlanOffer = { key: key, name: termsOf(key).name, amountCents: amountCentsOf(key), allowanceMicros: allowanceOf(key) }
pure val planOffers: List[PlanOffer] = paidPlanKeys.listMap(k => offerOf(k))
pure def lawOnlyPaidPlansAreOffered(key: PlanKey): bool = paidPlanKeys.includes(key) iff isPaid(key)
pure def lawOffersAreCheapestFirst(i: int): bool = (i >= 0 and i + 1 < planOffers.length()) implies planOffers.nthOr(i, offerOf(Free)).amountCents < planOffers.nthOr(i + 1, offerOf(Free)).amountCents
pure val iValues = Set(-1, 0, 1, 2)
```

## Story: Move between plans in one order

> As a subscriber, I want a plan change called an upgrade only when I get
> more, so that I am never charged more now for a plan that gives me less.

### Plans rank free below Plus below Pro, and a higher rank never costs less or includes less

```quint
pure def rankOf(key: PlanKey): int = termsOf(key).rank
pure def lawHigherRankIncludesMore(a: PlanKey, b: PlanKey): bool = rankOf(a) < rankOf(b) implies (priceOf(a) < priceOf(b) and allowanceOf(a) < allowanceOf(b) and termsOf(a).completionsRpm <= termsOf(b).completionsRpm and termsOf(a).standardRpm <= termsOf(b).standardRpm)
pure def lawRankIdentifiesThePlan(a: PlanKey, b: PlanKey): bool = rankOf(a) == rankOf(b) implies a == b
```

### An upgrade or a downgrade is a change from one paid plan to another, in rank order

Moving to the free plan is a cancellation and moving from it is a checkout;
neither is a plan change (`spec/cloud/billing/subscriptionCommands.md`,
`spec/cloud/billing/checkout.md`).

```quint
pure def isUpgrade(source: PlanKey, target: PlanKey): bool = isPaid(source) and rankOf(target) > rankOf(source)
pure def isDowngrade(source: PlanKey, target: PlanKey): bool = isPaid(target) and rankOf(target) < rankOf(source)
pure def lawAChangeIsOneDirection(source: PlanKey, target: PlanKey): bool = not(isUpgrade(source, target) and isDowngrade(source, target)) and ((isUpgrade(source, target) or isDowngrade(source, target)) implies source != target)
pure def lawChangesStayAmongPaidPlans(source: PlanKey, target: PlanKey): bool = (isUpgrade(source, target) or isDowngrade(source, target)) implies (isPaid(source) and isPaid(target))
pure def lawDowngradeUndoesUpgrade(source: PlanKey, target: PlanKey): bool = isUpgrade(source, target) iff isDowngrade(target, source)
```

## Story: Limit requests by plan

> As the operator, I want each plan to allow a fixed number of requests a
> minute in each class, so that one account cannot crowd out the others.

### Each plan allows a fixed number of requests a minute in each of two classes

Chat completions are one class; batch speech, maps and every other metered
route are the standard class. The plan that applies is the account's
effective plan (`spec/cloud/billing/entitlements.md`); the window and its
refusal are `spec/cloud/shared/rateLimit.md`'s.

```quint
type RateClass = CompletionsRequests | StandardRequests
pure val planRateWindow: Millis = millisPerMinute
pure def requestsPerMinute(key: PlanKey, rateClass: RateClass): int = if (rateClass == CompletionsRequests) termsOf(key).completionsRpm else termsOf(key).standardRpm
pure def lawEveryPlanAllowsSomeRequests(key: PlanKey, rateClass: RateClass): bool = requestsPerMinute(key, rateClass) > 0
```

## Story: Share realtime speech fairly

> As the operator, I want each account to have a fixed amount of realtime
> speech each day, so that a live session cannot run without end.

### Every account may use 120 minutes of realtime speech per UTC day, whatever its plan

The day starts at midnight UTC. A spent day is refused with
`402 allowance_exhausted` and `resetsAt`, the next midnight
(`spec/cloud/services/speechSession.md`); the minutes used are counted there.

```quint
pure val realtimeSpeechPerDay: Millis = 120 * millisPerMinute
pure def utcDayStart(now: Millis): Millis = if (now < 0) 0 else now - now % millisPerDay
pure def realtimeSpeechResetsAt(now: Millis): Millis = utcDayStart(now) + millisPerDay
pure def realtimeSpeechAvailable(usedToday: Millis): bool = usedToday < realtimeSpeechPerDay
pure def lawResetIsTheNextMidnight(now: Millis): bool = now >= 0 implies (now < realtimeSpeechResetsAt(now) and realtimeSpeechResetsAt(now) <= now + millisPerDay and realtimeSpeechResetsAt(now) % millisPerDay == 0)
pure val nowValues = Set(-1, 0, 1, 86399999, 86400000, 86400001)
```
