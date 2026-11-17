# Plan catalog

The plans the cloud sells, what each includes and the request rates each
allows. The catalog (`v1`) is fixed in code: an operator changes it only with
a release. Sources are develop
`packages/cloud/shared/src/lib/services/subscription-catalog.ts` (plans,
prices, allowances, billing terms), `org-rate-limits.ts` (rates per class)
and `lib/voice-session/config.ts` (the realtime speech day). Downstream
readers are the products' plan screens, which list the paid plans by price
and choose an upgrade or a downgrade by order.

This library has no state. Develop's resource ceilings (characters,
sandboxes, containers, storage, apps) and API key counts are gone: the cloud
hosts nothing, and the only keys are device keys. The `embeddings` and
`strict` rate classes are gone (no caller). `spec/cloud/deployment.md` checks
at start-up that the payment provider sells each paid plan at these terms.

## Story: Offer the paid plans as the provider sells them

> As a person choosing a plan, I want to see each paid plan with its monthly
> price and what it includes, so that I know what I pay for before I pay.

### A plan is the free plan, Plus or Pro, and only Plus and Pro are sold, monthly in US dollars, one seat each, without trial

Free is what an account has without a subscription or a grant. The shell
renders the keys as `free`, `plus_monthly` and `pro_monthly`; an unknown key
on the wire is refused by the schema before any spec sees it.

```quint
import types.* from "../shared/types"
type PlanKey = Free | PlusMonthly | ProMonthly
type PlanTerms = { name: str, rank: int, priceMicros: Micros, allowanceMicros: Micros, completionsRpm: int, standardRpm: int }
type PaidBilling = { currency: str, interval: str, intervalCount: int, seats: int, trialDays: int }
pure val freePlan: PlanTerms = { name: "Free", rank: 0, priceMicros: 0, allowanceMicros: 0, completionsRpm: 60, standardRpm: 30 }
pure val plusPlan: PlanTerms = { name: "Plus", rank: 1, priceMicros: 30000000, allowanceMicros: 25000000, completionsRpm: 120, standardRpm: 60 }
pure val proPlan: PlanTerms = { name: "Pro", rank: 2, priceMicros: 100000000, allowanceMicros: 90000000, completionsRpm: 300, standardRpm: 120 }
pure val paidPlanBilling: PaidBilling = { currency: "usd", interval: "month", intervalCount: 1, seats: 1, trialDays: 0 }
pure def termsOf(key: PlanKey): PlanTerms = if (key == ProMonthly) proPlan else if (key == PlusMonthly) plusPlan else freePlan
pure def isPaid(key: PlanKey): bool = key != Free
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

The public `GET /api/v1/subscriptions/plans` renders each offer as in section
5 of the plan, with the allowance as `allowance.amountUsd`.

```quint
type PlanOffer = { key: PlanKey, name: str, amountCents: int, currency: str, interval: str, allowanceMicros: Micros }
pure val paidPlanKeys: List[PlanKey] = List(PlusMonthly, ProMonthly)
pure def offerOf(key: PlanKey): PlanOffer = { key: key, name: termsOf(key).name, amountCents: amountCentsOf(key), currency: paidPlanBilling.currency, interval: paidPlanBilling.interval, allowanceMicros: allowanceOf(key) }
pure val planOffers: List[PlanOffer] = paidPlanKeys.listMap(k => offerOf(k))
pure def lawOnlyPaidPlansAreOffered(key: PlanKey): bool = paidPlanKeys.includes(key) iff isPaid(key)
pure def lawOffersAreCheapestFirst(offerIndex: int): bool = (offerIndex >= 0 and offerIndex + 1 < planOffers.length()) implies planOffers.nthOr(offerIndex, offerOf(Free)).amountCents < planOffers.nthOr(offerIndex + 1, offerOf(Free)).amountCents
pure val offerIndexValues = Set(0, 1, 2)
```

## Story: Move between plans in one order

> As a subscriber, I want a plan change called an upgrade only when I get
> more, so that I am never charged more now for a plan that gives me less.

### Plans rank free below Plus below Pro, and a higher rank costs more, includes a larger allowance and never allows fewer requests

```quint
pure def rankOf(key: PlanKey): int = termsOf(key).rank
pure def lawHigherRankIncludesMore(a: PlanKey, b: PlanKey): bool = rankOf(a) < rankOf(b) implies (priceOf(a) < priceOf(b) and allowanceOf(a) < allowanceOf(b) and termsOf(a).completionsRpm <= termsOf(b).completionsRpm and termsOf(a).standardRpm <= termsOf(b).standardRpm)
pure def lawRankIdentifiesThePlan(a: PlanKey, b: PlanKey): bool = rankOf(a) == rankOf(b) implies a == b
```

### Every change from one paid plan to another is an upgrade or a downgrade, by rank

Moving to the free plan is a cancellation and moving from it is a checkout;
neither is a plan change (`spec/cloud/billing/subscriptionCommands.md`,
`spec/cloud/billing/checkout.md`).

```quint
pure def isPlanChange(source: PlanKey, target: PlanKey): bool = isPaid(source) and isPaid(target) and source != target
pure def isUpgrade(source: PlanKey, target: PlanKey): bool = isPlanChange(source, target) and rankOf(target) > rankOf(source)
pure def isDowngrade(source: PlanKey, target: PlanKey): bool = isPlanChange(source, target) and rankOf(target) < rankOf(source)
pure def lawEveryPlanChangeHasADirection(source: PlanKey, target: PlanKey): bool = isPlanChange(source, target) implies (isUpgrade(source, target) or isDowngrade(source, target))
```

## Story: Limit requests by plan

> As the operator, I want each plan to allow a fixed number of requests a
> minute in each class, so that one account cannot crowd out the others.

### Each organization may make a fixed number of requests a minute in each of two classes, set by its plan

Chat completions are one class; batch speech, maps and every other metered
route are the standard class. The plan is the account's effective plan
(`spec/cloud/billing/entitlements.md`). Every applier builds
`perMinute(planRateLimitName(c), requestsPerMinute(plan, c))` of
`spec/cloud/shared/rateLimit.md` with the organization id as the subject.
That limit's row is keyed by its value too, so a plan change counts from an
empty row.

```quint
type RateClass = CompletionsRequests | StandardRequests
pure def requestsPerMinute(key: PlanKey, rateClass: RateClass): int = if (rateClass == CompletionsRequests) termsOf(key).completionsRpm else termsOf(key).standardRpm
pure def planRateLimitName(rateClass: RateClass): str = if (rateClass == CompletionsRequests) "planCompletions" else "planStandard"
pure def lawEveryPlanAllowsSomeRequests(key: PlanKey, rateClass: RateClass): bool = requestsPerMinute(key, rateClass) > 0
pure def lawClassesNeverShareALimit(a: RateClass, b: RateClass): bool = planRateLimitName(a) == planRateLimitName(b) implies a == b
```

## Story: Share realtime speech fairly

> As the operator, I want each account to have a fixed amount of realtime
> speech each day, so that a live session cannot run without end.

### Every account may use at most 120 minutes of realtime speech per UTC day, whatever its plan

The day starts at midnight UTC. A request for more speech is admitted only
when it fits in what is left of the day, counted before it starts; a refused
request answers `402 allowance_exhausted` with `resetsAt`, the next midnight
(`spec/cloud/services/speechSession.md`, which counts the minutes used and
asks for one 60 s window at a time).

```quint
pure val realtimeSpeechPerDay: Millis = 120 * millisPerMinute
pure def utcDayStart(dayNow: Millis): Millis = (dayNow / millisPerDay) * millisPerDay
pure def realtimeSpeechResetsAt(dayNow: Millis): Millis = utcDayStart(dayNow) + millisPerDay
pure def realtimeSpeechAdmits(speechUsed: Millis, speechRequested: Millis): bool = speechRequested >= 1 and speechUsed + speechRequested <= realtimeSpeechPerDay
pure def lawLessUseNeverRefusesMore(speechUsed: Millis, speechUsedBefore: Millis, speechRequested: Millis): bool =
  (speechUsedBefore <= speechUsed and realtimeSpeechAdmits(speechUsed, speechRequested)) implies realtimeSpeechAdmits(speechUsedBefore, speechRequested)
pure def lawResetIsTheNextMidnight(dayNow: Millis): bool = dayNow >= 0 implies (dayNow < realtimeSpeechResetsAt(dayNow) and realtimeSpeechResetsAt(dayNow) <= dayNow + millisPerDay and realtimeSpeechResetsAt(dayNow) % millisPerDay == 0)
pure val dayNowValues = Set(0, 1, 86399999, 86400000, 86400001)
pure val speechUsedValues = Set(0, 7140000, 7199999, 7200000)
pure val speechUsedBeforeValues = Set(0, 7140000, 7200000)
pure val speechRequestedValues = Set(1, 60000)
```
