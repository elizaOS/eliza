# Hosted maps

The cloud answers maps requests for an organization: place lookups, routes
and map tiles. Each request is admitted once against the organization's
request allowance and its credit, its provider cost is observed as it
happens, and it is settled once, conservatively when the provider's answer
was lost. One request is the state machine. The rate buckets, the place
lookup order and tile caching are stated as laws. The device's use of these
services is [the maps cloud connection](../maps/cloudConnection.md).

Develop sources: the cloud `maps_request_receipts`, `maps_credit_funding`,
`maps_request_buckets`, `MapsPlaceLookup` and `MapsTileCache` models.

## Story: Admit and pay for a maps request once

> As an organization, I want each maps request admitted once within my
> allowance and paid for once, by what it actually cost when that is known
> and by its admitted price when it is not.

### A request is admitted once, by a current credential, within its window's allowance

A request carries its own identity. It is admitted only by a currently valid
credential, while the organization's standing is active, within the window's
request allowance, and only if the credit it may cost is available;
a plan that includes maps admits it at no cost. An admitted request holds its
whole price. A second admission of the same identity is a duplicate and
changes nothing. Credit only moves between the balance, the hold and the
charge; none is created or lost.

```quint
type MapsReceipt = ReceiptAbsent | ReceiptUnknown | ReceiptSucceeded | ReceiptFailed | ReceiptCancelled
type FundingPhase = FundingAbsent | FundingAdmitted | FundingDispatched | SettlingKnown | SettlingUnknown | FundingSettled | FundingUnknown
type MapsRequest = { credentialActive: bool, accountActive: bool, plan: bool, includedInPlan: bool, windowUsed: int, windowAllowance: int, receipt: MapsReceipt, admissions: int, funding: FundingPhase, balance: int, quote: int, held: int, observed: int, chosen: int, charged: int, providerCallPending: bool }
pure val initial: MapsRequest = { credentialActive: true, accountActive: true, plan: false, includedInPlan: false, windowUsed: 0, windowAllowance: 2, receipt: ReceiptAbsent, admissions: 0, funding: FundingAbsent, balance: 3, quote: 0, held: 0, observed: 0, chosen: 0, charged: 0, providerCallPending: false }
pure def admissionCost(m: MapsRequest, price: int): int = if (m.plan) 0 else price
pure def canAdmitMaps(m: MapsRequest, price: int): bool =
  m.credentialActive and m.accountActive and m.receipt == ReceiptAbsent and m.windowUsed < m.windowAllowance and price >= 1 and m.balance >= admissionCost(m, price)
pure def admitMaps(m: MapsRequest, price: int): MapsRequest = {
  val cost = admissionCost(m, price)
  { ...m, receipt: ReceiptUnknown, admissions: m.admissions + 1, windowUsed: m.windowUsed + 1, funding: FundingAdmitted, balance: m.balance - cost, quote: cost, held: cost, includedInPlan: m.plan }
}
pure def canRevokeCredential(m: MapsRequest): bool = m.credentialActive
pure def revokeCredential(m: MapsRequest): MapsRequest = { ...m, credentialActive: false }
pure def canChangePlan(m: MapsRequest, plan: bool): bool = m.plan != plan
pure def changePlan(m: MapsRequest, plan: bool): MapsRequest = { ...m, plan: plan }
pure def canSuspendAccount(m: MapsRequest): bool = m.accountActive
pure def suspendAccount(m: MapsRequest): MapsRequest = { ...m, accountActive: false }
pure def canStartNewWindow(m: MapsRequest): bool = m.windowUsed > 0
pure def startNewWindow(m: MapsRequest): MapsRequest = { ...m, windowUsed: 0 }
pure val priceValues = Set(1, 2)
pure def alwaysAdmittedOnce(m: MapsRequest): bool = m.admissions >= 0 and m.admissions <= 1 and ((m.receipt == ReceiptAbsent) == (m.admissions == 0))
pure def alwaysWithinWindowAllowance(m: MapsRequest): bool = m.windowUsed >= 0 and m.windowUsed <= m.windowAllowance
pure def alwaysCreditIsNeverNegative(m: MapsRequest): bool = m.balance >= 0 and m.held >= 0 and m.charged >= 0
pure def stepCreditIsConserved(before: MapsRequest, after: MapsRequest): bool = before.balance + before.held + before.charged == after.balance + after.held + after.charged
pure def sometimesRequestAdmitted(m: MapsRequest): bool = m.funding == FundingAdmitted and m.held > 0
```

### Provider calls run only under the standing that admitted them

A request reaches the provider only while the organization's standing is
active and its plan is the one it was admitted under. Each provider call
reports its cost, which together never exceeds what the request holds; a
call outside an included plan always costs something. Later provider calls
of the same request run one at a time.

```quint
pure def canDispatchMaps(m: MapsRequest): bool = m.funding == FundingAdmitted and m.accountActive and m.plan == m.includedInPlan
pure def dispatchMaps(m: MapsRequest): MapsRequest = { ...m, funding: FundingDispatched, providerCallPending: true }
pure def canObserveCost(m: MapsRequest, cost: int): bool =
  m.funding == FundingDispatched and m.providerCallPending and cost >= 0 and m.observed + cost <= m.held and (m.includedInPlan or cost > 0)
pure def observeCost(m: MapsRequest, cost: int): MapsRequest = { ...m, observed: m.observed + cost, providerCallPending: false }
pure def canRejectCall(m: MapsRequest): bool = m.funding == FundingDispatched and m.providerCallPending
pure def rejectCall(m: MapsRequest): MapsRequest = { ...m, providerCallPending: false }
pure def canNextCall(m: MapsRequest): bool = m.funding == FundingDispatched and not(m.providerCallPending)
pure def nextCall(m: MapsRequest): MapsRequest = { ...m, providerCallPending: true }
pure val costValues = Set(0, 1, 2)
pure def alwaysObservedWithinHold(m: MapsRequest): bool = m.observed >= 0 and ((m.funding == FundingAdmitted or m.funding == FundingDispatched) implies m.observed <= m.held) and m.held <= m.quote
pure def alwaysPendingCallIsDispatched(m: MapsRequest): bool = m.providerCallPending implies m.funding == FundingDispatched
```

### Settlement charges what was observed, or the admitted price when a reply was lost

With no provider call outstanding, settlement charges what the calls
reported and returns the rest of the hold. With a call outstanding, its
reply is given up as lost and the charge is fixed at the admitted price.
The first choice stands through retries and failures; the acknowledgement
returns the unused hold and records the charge once.

```quint
pure def canSettleKnown(m: MapsRequest): bool = (m.funding == FundingAdmitted or m.funding == FundingDispatched) and not(m.providerCallPending)
pure def settleKnown(m: MapsRequest): MapsRequest = { ...m, chosen: m.observed, funding: SettlingKnown }
pure def canSettleUnknown(m: MapsRequest): bool = m.funding == FundingDispatched and m.providerCallPending
pure def settleUnknown(m: MapsRequest): MapsRequest = { ...m, chosen: m.quote, funding: SettlingUnknown, providerCallPending: false }
pure def canAcknowledgeSettlement(m: MapsRequest): bool = m.funding == SettlingKnown or m.funding == SettlingUnknown
pure def acknowledgeSettlement(m: MapsRequest): MapsRequest =
  { ...m, balance: m.balance + m.held - m.chosen, held: 0, charged: m.chosen, funding: if (m.funding == SettlingUnknown) FundingUnknown else FundingSettled, providerCallPending: false }
pure def alwaysChargeWithinTheQuote(m: MapsRequest): bool = m.charged >= 0 and m.charged <= m.quote and m.chosen <= m.quote
pure def alwaysUnknownSettlementChargesTheQuote(m: MapsRequest): bool = (m.funding == SettlingUnknown or m.funding == FundingUnknown) implies m.chosen == m.quote
pure def alwaysSettledRequestHoldsNothing(m: MapsRequest): bool = (m.funding == FundingSettled or m.funding == FundingUnknown) implies (m.held == 0 and m.charged == m.chosen)
pure def stepSettlementChoiceStands(before: MapsRequest, after: MapsRequest): bool =
  (before.funding == SettlingKnown or before.funding == SettlingUnknown or before.funding == FundingSettled or before.funding == FundingUnknown) implies after.chosen == before.chosen
pure def sometimesKnownCostSettled(m: MapsRequest): bool = m.funding == FundingSettled and m.charged > 0 and m.charged < m.quote
pure def sometimesLostReplyChargedAtQuote(m: MapsRequest): bool = m.funding == FundingUnknown and m.charged == m.quote and m.quote > 0
```

### A usage report records the request's outcome once, under a current credential

A usage report needs a currently valid credential and an admitted request.
The first terminal outcome is recorded and later reports must agree with
it; a report never releases the admission.

```quint
type UsageOutcome = UsageSucceeded | UsageFailed | UsageCancelled
pure def receiptFor(usageOutcome: UsageOutcome): MapsReceipt =
  if (usageOutcome == UsageSucceeded) ReceiptSucceeded else if (usageOutcome == UsageFailed) ReceiptFailed else ReceiptCancelled
pure def canRecordUsage(m: MapsRequest, usageOutcome: UsageOutcome): bool = m.credentialActive and m.receipt == ReceiptUnknown
pure def recordUsage(m: MapsRequest, usageOutcome: UsageOutcome): MapsRequest = { ...m, receipt: receiptFor(usageOutcome) }
pure def stepRecordedOutcomeStands(before: MapsRequest, after: MapsRequest): bool =
  (before.receipt != ReceiptAbsent and before.receipt != ReceiptUnknown) implies (after.receipt == before.receipt and after.admissions == before.admissions)
pure def sometimesOutcomeRecorded(m: MapsRequest): bool = m.receipt == ReceiptSucceeded and m.funding == FundingSettled
```

## Story: Keep maps requests within the provider's rate and terms

> As an operator, I want maps traffic to stay within a burst and a sustained
> rate, lookups to try the cheapest useful provider call, and tiles never
> kept where the provider forbids it.

### A request needs a full token in both the burst and the sustained bucket

Each bucket refills at its own rate up to its capacity. A request is
admitted only when both buckets hold a full token of four units, and then
takes one from each; a refused request is told a retry time no earlier than
the bucket's own time.

```quint
pure def refill(tokens: int, elapsed: int, rate: int, capacity: int): int = if (tokens + elapsed * rate > capacity) capacity else tokens + elapsed * rate
pure def bucketsAdmit(burst: int, sustained: int): bool = burst >= 4 and sustained >= 4
pure def lawRefillNeverExceedsCapacity(tokens: int, elapsed: int, rate: int, capacity: int): bool =
  (tokens <= capacity and elapsed >= 0 and rate >= 0) implies refill(tokens, elapsed, rate, capacity) <= capacity
pure def lawAdmissionLeavesNoNegativeBucket(burst: int, sustained: int): bool = bucketsAdmit(burst, sustained) implies (burst - 4 >= 0 and sustained - 4 >= 0)
```

### A place lookup asks for nearby places first only when preferred

An admitted reverse lookup that was cancelled makes no provider call. One
that prefers a place asks for nearby places and falls back to the address
lookup only when there are none; otherwise it asks for the address. Its
result is what the last call returned.

```quint
type LookupAnswer = AnswerPlace | AnswerAddress | AnswerEmpty | AnswerInvalid | AnswerOutage | AnswerCancelled
type PlaceLookup = { nearbyCalls: int, geocodeCalls: int, answer: LookupAnswer }
pure def placeLookup(prefer: bool, cancelled: bool, nearby: LookupAnswer, fallback: LookupAnswer): PlaceLookup =
  if (cancelled) { nearbyCalls: 0, geocodeCalls: 0, answer: AnswerCancelled }
  else if (prefer and nearby != AnswerEmpty) { nearbyCalls: 1, geocodeCalls: 0, answer: nearby }
  else if (prefer) { nearbyCalls: 1, geocodeCalls: 1, answer: fallback }
  else { nearbyCalls: 0, geocodeCalls: 1, answer: fallback }
pure def lawCancelledLookupCallsNothing(prefer: bool, nearby: LookupAnswer, fallback: LookupAnswer): bool =
  placeLookup(prefer, true, nearby, fallback).nearbyCalls + placeLookup(prefer, true, nearby, fallback).geocodeCalls == 0
pure def lawGeocodeOnlyAsFallback(prefer: bool, nearby: LookupAnswer, fallback: LookupAnswer): bool =
  placeLookup(prefer, false, nearby, fallback).geocodeCalls == 1 implies (not(prefer) or nearby == AnswerEmpty)
```

### A tile marked no-store is never kept to serve later

The provider's tiles are no-store. A tile response is cached only when
caching is allowed and the request was admitted, so with no-store nothing is
kept and an unadmitted request finds nothing to be served.

```quint
pure def tileCachedAfter(cachedBefore: bool, admitted: bool, noStore: bool): bool = cachedBefore or (admitted and not(noStore))
pure def servedWithoutAdmission(cachedBefore: bool, admitted: bool): bool = cachedBefore and not(admitted)
pure def lawNoStoreTileIsNeverKept(admitted: bool): bool = not(tileCachedAfter(false, admitted, true))
pure def lawNothingServedWithoutAdmission(admitted: bool): bool = not(servedWithoutAdmission(tileCachedAfter(false, true, true), admitted))
```
