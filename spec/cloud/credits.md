# Credits

An organization buys credits through a hosted checkout and spends them by
reserving an amount before metered work and settling the actual cost after
it. One immutable quote leads to at most one provider checkout session and
at most one credit grant, whichever of the signed provider event or the
buyer's return verifies the payment first. A refund claws credits back as
far as the balance allows and records the rest as a shortfall. Ported from
the develop models `CreditCheckoutQuote`, `CreditCheckoutOrder`,
`checkout_credit_settlement`, `checkout_retry_clock`, `billing_reservations`,
`billing_sweep`, `auto_topup_lock_order`, `StripeDeliveryOutbox` and
`payment_delivery`. Money is in whole abstract units; a quote grants two.

## Story: Buy credits and spend them without overdraft

> As an organization admin, I buy a credit pack and my agents spend it; a
> retried purchase never charges or grants twice, a refund takes back what
> it can, and no metered call spends credits I do not have.

### A quote request is replayed only by the same user with the same request

The first valid request creates the organization's quote for this
idempotency key. The same user repeating the same request receives that
quote; a different user or different request bytes is refused and the
quote is unchanged. Invalid input creates nothing.

```quint
type OrderPhase = NoOrder | Quoted | ProviderStarted | ProviderAmbiguous | Delivered | Settled
type Lookup = LookupIdle | LookupScanning | LookupEmpty | LookupFound | LookupFailed
type ReservationStatus = ReservationHeld | ReservationSettled
type Reservation = { id: int, reserved: int, collected: int, cost: int, status: ReservationStatus }
type Credits = {
  now: int, order: OrderPhase, quoteUser: int, quoteDigest: int, customer: int, organizationCustomer: int,
  firstStart: int, lastDispatch: int, lookup: Lookup, retryHadLookup: bool,
  providerSession: bool, bound: bool, paid: bool, expired: bool, foreignIntent: bool, cacheDirty: bool,
  grants: int, balance: int, spent: int, clawed: int, shortfall: int, refundTarget: int, reservations: List[Reservation]
}
pure val quoteUnits = 2
pure val retryWindow = 3
pure val initial: Credits = {
  now: 0, order: NoOrder, quoteUser: 0, quoteDigest: 0, customer: 0, organizationCustomer: 1,
  firstStart: -1, lastDispatch: -1, lookup: LookupIdle, retryHadLookup: true,
  providerSession: false, bound: false, paid: false, expired: false, foreignIntent: false, cacheDirty: false,
  grants: 0, balance: 0, spent: 0, clawed: 0, shortfall: 0, refundTarget: 0, reservations: List()
}
pure val userValues = Set(1, 2)
pure val digestValues = Set(1, 2)
pure def canRequestQuote(c: Credits, user: int, digest: int, valid: bool): bool = valid and user > 0 and digest > 0 and (c.order == NoOrder or (user == c.quoteUser and digest == c.quoteDigest))
pure def requestQuote(c: Credits, user: int, digest: int, valid: bool): Credits = if (c.order == NoOrder) { ...c, order: Quoted, quoteUser: user, quoteDigest: digest } else c
pure def stepQuoteIsImmutable(before: Credits, after: Credits): bool = before.order != NoOrder implies (after.quoteUser == before.quoteUser and after.quoteDigest == before.quoteDigest)
```

### A checkout is dispatched only with the organization's customer pinned to the quote

The organization's provider customer is pinned on the quote before the
first dispatch and never changes after; a customer rotated in the meantime
does not move the quote.

```quint
pure val candidateValues = Set(1, 2)
pure def canPinCustomer(c: Credits, candidate: int): bool = c.order == Quoted and c.customer == 0 and candidate == c.organizationCustomer
pure def pinCustomer(c: Credits, candidate: int): Credits = { ...c, customer: candidate }
pure def canRotateCustomer(c: Credits): bool = true
pure def rotateCustomer(c: Credits): Credits = { ...c, organizationCustomer: 3 - c.organizationCustomer }
pure def alwaysDispatchHasPinnedCustomer(c: Credits): bool = (c.order != NoOrder and c.order != Quoted) implies c.customer != 0
pure def stepPinnedCustomerNeverChanges(before: Credits, after: Credits): bool = before.customer != 0 implies after.customer == before.customer
```

### A checkout is retried only inside the first dispatch's window and only after a complete lookup found nothing

The first dispatch time, read from the primary database clock, is
immutable; a later dispatch with the same provider key is allowed only
within the provider's idempotency window counted from it, and only after
listing the provider's sessions for this quote completed and found none.
A lost provider reply leaves the outcome unknown.

```quint
pure def retryAllowed(c: Credits): bool = (c.order == ProviderStarted or c.order == ProviderAmbiguous) and c.firstStart >= 0 and c.now < c.firstStart + retryWindow and c.lookup == LookupEmpty
pure def canDispatch(c: Credits): bool = c.customer != 0 and (c.order == Quoted or retryAllowed(c))
pure def dispatch(c: Credits): Credits =
  { ...c, order: ProviderStarted, firstStart: if (c.firstStart == -1) c.now else c.firstStart, lastDispatch: c.now, retryHadLookup: c.order == Quoted or c.lookup == LookupEmpty, lookup: LookupIdle }
pure def canTick(c: Credits): bool = true
pure def tick(c: Credits): Credits = { ...c, now: c.now + 1 }
pure def canLoseResponse(c: Credits): bool = c.order == ProviderStarted
pure def loseResponse(c: Credits): Credits = { ...c, order: ProviderAmbiguous }
pure def canProviderCreates(c: Credits): bool = (c.order == ProviderStarted or c.order == ProviderAmbiguous) and c.firstStart >= 0 and not(c.providerSession)
pure def providerCreates(c: Credits): Credits = { ...c, providerSession: true }
pure def canLookUpSessions(c: Credits, failed: bool): bool = c.order == ProviderStarted or c.order == ProviderAmbiguous
pure def lookUpSessions(c: Credits, failed: bool): Credits = { ...c, lookup: if (failed) LookupFailed else if (c.providerSession) LookupFound else LookupEmpty }
pure def canBindSession(c: Credits): bool = (c.order == ProviderStarted or c.order == ProviderAmbiguous) and c.providerSession
pure def bindSession(c: Credits): Credits = { ...c, order: Delivered, bound: true }
pure def alwaysRetryInsideOriginalWindow(c: Credits): bool = c.lastDispatch == -1 or (c.firstStart >= 0 and c.lastDispatch < c.firstStart + retryWindow)
pure def alwaysRetryFollowsCompletedLookup(c: Credits): bool = c.retryHadLookup
pure def stepFirstDispatchIsImmutable(before: Credits, after: Credits): bool = before.firstStart >= 0 implies after.firstStart == before.firstStart
pure def sometimesRetriedAfterLostReply(c: Credits): bool = c.order == ProviderStarted and c.lastDispatch > c.firstStart
```

### A paid checkout grants its credits exactly once, from either confirmation path

The signed provider event and the buyer's verified return both lock the
order, compare the whole receipt (quote, organization, amount, currency,
customer, session and payment) and use one grant key. A payment intent
already claimed by something else rolls the grant back. Following the
cancel link or an expired session grants nothing. The balance cache is
invalidated after the grant; a failed invalidation does not undo it.

```quint
pure def canPay(c: Credits): bool = c.providerSession and not(c.paid) and not(c.expired)
pure def pay(c: Credits): Credits = { ...c, paid: true }
pure def canExpireSession(c: Credits): bool = c.providerSession and not(c.paid) and not(c.expired)
pure def expireSession(c: Credits): Credits = { ...c, expired: true }
pure def canClaimIntentElsewhere(c: Credits): bool = c.grants == 0 and not(c.foreignIntent)
pure def claimIntentElsewhere(c: Credits): Credits = { ...c, foreignIntent: true }
pure def canSettleCheckout(c: Credits): bool = c.paid and not(c.foreignIntent) and (c.order == ProviderStarted or c.order == ProviderAmbiguous or c.order == Delivered)
pure def settleCheckout(c: Credits): Credits = { ...c, order: Settled, bound: true, grants: 1, balance: c.balance + quoteUnits, cacheDirty: true }
pure def canInvalidateCache(c: Credits): bool = c.cacheDirty
pure def invalidateCache(c: Credits): Credits = { ...c, cacheDirty: false }
pure def alwaysCreditGrantedOnce(c: Credits): bool = c.grants >= 0 and c.grants <= 1 and ((c.grants == 1) == (c.order == Settled))
pure def alwaysGrantIsPaymentBacked(c: Credits): bool = c.grants == 1 implies (c.paid and c.bound and c.providerSession and not(c.foreignIntent))
pure def sometimesCreditsGranted(c: Credits): bool = c.order == Settled and not(c.cacheDirty)
pure def sometimesForeignIntentRefused(c: Credits): bool = c.paid and c.foreignIntent and c.grants == 0
```

### A metered call reserves before it runs and settles once, never below zero

A reservation holds an amount no larger than the balance. Settling it,
by the request itself or by the recovery sweep, whichever commits first,
refunds what the actual cost did not use and collects an overage only when
the balance covers it; the second writer finds it settled.

```quint
pure val idValues = Set(1, 2)
pure val amountValues = Set(1, 2, 3)
pure val costValues = Set(0, 1, 2, 3)
pure def held(c: Credits): int = c.reservations.foldl(0, (sum, r) => if (r.status == ReservationHeld) sum + r.reserved else sum)
pure def canReserve(c: Credits, id: int, amount: int): bool = amount > 0 and amount <= c.balance and not(c.reservations.some(r => r.id == id))
pure def reserve(c: Credits, id: int, amount: int): Credits = { ...c, balance: c.balance - amount, reservations: c.reservations.append({ id: id, reserved: amount, collected: amount, cost: -1, status: ReservationHeld }) }
pure def canSettleReservation(c: Credits, id: int, cost: int): bool = cost >= 0 and c.reservations.some(r => r.id == id and r.status == ReservationHeld)
pure def settleReservation(c: Credits, id: int, cost: int): Credits = {
  val r = c.reservations.select(x => x.id == id).nthOr(0, { id: 0, reserved: 0, collected: 0, cost: 0, status: ReservationSettled })
  val refund = if (cost < r.reserved) r.reserved - cost else 0
  val overage = if (cost > r.reserved and c.balance >= cost - r.reserved) cost - r.reserved else 0
  { ...c, balance: c.balance + refund - overage, spent: c.spent + r.reserved - refund + overage,
    reservations: c.reservations.listMap(x => if (x.id == id) { ...x, collected: r.reserved - refund + overage, cost: cost, status: ReservationSettled } else x) }
}
pure def alwaysSettledChargeIsAtMostCost(c: Credits): bool = c.reservations.every(r => r.status == ReservationSettled implies (r.collected >= 0 and r.collected <= r.cost))
pure def sometimesOverageCollected(c: Credits): bool = c.reservations.some(r => r.status == ReservationSettled and r.collected > r.reserved)
```

### A refund claws back credits up to the balance and records the rest as a shortfall

Provider refund events can arrive in any order and repeat; each carries the
cumulative refunded amount, and only an increase is applied. Before the
grant exists the refund is retained for retry.

```quint
pure val targetValues = Set(1, 2)
pure def canApplyRefund(c: Credits, target: int): bool = c.grants == 1 and target > c.refundTarget and target <= quoteUnits
pure def applyRefund(c: Credits, target: int): Credits = {
  val delta = target - c.refundTarget
  val taken = if (delta < c.balance) delta else c.balance
  { ...c, balance: c.balance - taken, clawed: c.clawed + taken, shortfall: c.shortfall + delta - taken, refundTarget: target }
}
pure def alwaysCreditsConserved(c: Credits): bool = c.balance + held(c) + c.spent + c.clawed == quoteUnits * c.grants
pure def alwaysBalancesNonNegative(c: Credits): bool = c.balance >= 0 and c.spent >= 0 and c.clawed >= 0 and c.shortfall >= 0 and c.reservations.every(r => r.reserved > 0)
pure def alwaysReversalBounded(c: Credits): bool = c.clawed + c.shortfall == c.refundTarget and c.refundTarget <= quoteUnits
pure def sometimesRefundShortfall(c: Credits): bool = c.shortfall > 0
```

### The stale-reservation sweep visits every row once per run and a failing row never blocks later rows

The sweep orders rows by database time and key and keeps a cursor past
each row it visits, so a row that fails to settle is retried in the next
run instead of being selected again in this one.

```quint
type SweepRow = { row: int, failing: bool }
pure def sweepVisits(rows: List[SweepRow]): List[int] = rows.listMap(r => r.row)
pure def sweepSettles(rows: List[SweepRow]): List[int] = rows.select(r => not(r.failing)).listMap(r => r.row)
pure val rowsValues = Set(List({ row: 1, failing: true }, { row: 2, failing: true }, { row: 3, failing: false }), List({ row: 1, failing: false }))
pure def lawFailingRowDoesNotBlockLaterRows(rows: List[SweepRow]): bool = rows.every(r => not(r.failing) implies sweepSettles(rows).includes(r.row))
pure def lawSweepVisitsEachRowOnce(rows: List[SweepRow]): bool = rows.every(r => sweepVisits(rows).select(x => x == r.row).length() == rows.select(x => x.row == r.row).length())
```

### Automatic top-up locks the organization before its attempt in every transaction

Provider authorization and the terminal update of a top-up attempt take
the same row locks in the same order, so neither waits on the other in a
cycle.

```quint
type RowLock = OrganizationLock | AttemptLock
type TopUpTransaction = AuthorizeTopUp | FinishTopUp
pure def topUpLocks(t: TopUpTransaction): List[RowLock] = List(OrganizationLock, AttemptLock)
pure def lawTopUpTransactionsShareOneOrder(a: TopUpTransaction, b: TopUpTransaction): bool = topUpLocks(a) == topUpLocks(b)
```

### A provider event is settled only by the drain whose lease token is current

Each claim of a stored provider event installs a fresh token and spends an
attempt. A drain whose lease expired may still finish; its settlement is
accepted only if the row still carries its token, so it never overwrites a
successor. Acknowledging erases the payload; releasing an unhandled claim
returns its attempt; a retry after the last attempt, or an explicit
dead-letter, ends the row until a verified resend revives it.

```quint
type OutboxStatus = OutboxPending | OutboxComplete | OutboxDead
type OutboxResult = AckDelivery | RetryDelivery | DeadLetter | ReleaseDelivery
type OutboxRow = { status: OutboxStatus, token: int, attempts: int, payload: bool }
pure val maxDeliveryAttempts = 3
pure def settleDelivery(row: OutboxRow, claimToken: int, result: OutboxResult): OutboxRow =
  if (row.token != claimToken or row.status != OutboxPending) row
  else if (result == AckDelivery) { ...row, status: OutboxComplete, token: 0, payload: false }
  else if (result == ReleaseDelivery) { ...row, token: 0, attempts: row.attempts - 1 }
  else if (result == DeadLetter or row.attempts >= maxDeliveryAttempts) { ...row, status: OutboxDead, token: 0 }
  else { ...row, token: 0 }
pure val rowValues = Set({ status: OutboxPending, token: 1, attempts: 1, payload: true }, { status: OutboxPending, token: 2, attempts: 3, payload: true }, { status: OutboxComplete, token: 0, attempts: 1, payload: false })
pure val claimTokenValues = Set(0, 1, 2)
pure def lawStaleSettlementChangesNothing(row: OutboxRow, claimToken: int, result: OutboxResult): bool = row.token != claimToken implies settleDelivery(row, claimToken, result) == row
pure def lawAcknowledgedEventDropsPayload(row: OutboxRow, claimToken: int): bool = settleDelivery(row, claimToken, AckDelivery).status == OutboxComplete implies not(settleDelivery(row, claimToken, AckDelivery).payload)
pure def lawLastRetryDeadLetters(row: OutboxRow): bool = (row.status == OutboxPending and row.token > 0 and row.attempts >= maxDeliveryAttempts) implies settleDelivery(row, row.token, RetryDelivery).status == OutboxDead
```

### A payment callback is sent only under its live claim, and a success supersedes an unsent failure

Each callback attempt is claimed with a deadline; a worker sends only while
it still owns that claim and the deadline is ahead, and only the exact
claim may record the outcome. Once the payment succeeds, the success is
the outcome callers see; a failure callback not yet dispatched is
superseded.

```quint
type CallbackClaim = { owner: int, deadline: int }
pure def maySend(live: CallbackClaim, mine: CallbackClaim, now: int, eligible: bool): bool = eligible and live == mine and mine.deadline > now
pure def mayRecordOutcome(live: CallbackClaim, mine: CallbackClaim, eligible: bool): bool = eligible and live == mine
pure val liveValues = Set({ owner: 1, deadline: 2 }, { owner: 2, deadline: 3 })
pure val mineValues = Set({ owner: 1, deadline: 2 }, { owner: 2, deadline: 2 })
pure val nowValues = Set(1, 2, 3)
pure def lawExpiredClaimNeverSends(live: CallbackClaim, mine: CallbackClaim, now: int, eligible: bool): bool = mine.deadline <= now implies not(maySend(live, mine, now, eligible))
pure def lawStaleClaimNeverRecords(live: CallbackClaim, mine: CallbackClaim, eligible: bool): bool = live != mine implies not(mayRecordOutcome(live, mine, eligible))
pure def failureCallbackAfter(paymentSucceeded: bool, failureDispatched: bool): bool = not(paymentSucceeded) or failureDispatched
pure def lawSuccessSupersedesUnsentFailure(failureDispatched: bool): bool = not(failureDispatched) implies not(failureCallbackAfter(true, failureDispatched))
```
