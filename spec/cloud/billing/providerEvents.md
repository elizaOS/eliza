# Payment provider events

The payment provider reports what happened to a checkout, a subscription or
an invoice by signed events posted to `POST /api/stripe/webhook`. One
`ProviderEvent` is one stored event, keyed by the provider's event id: the
intake stores it once, and a drain on a ten-second schedule hands it to the
spec that owns its type, at least once, until it is done or dead-lettered.
The owners are idempotent, so handling an event twice changes nothing twice:
a checkout completes once (`spec/cloud/billing/checkout.md`), `reconcile`
reads the provider's live subscription and opens a period once per invoice
(`spec/cloud/billing/subscriptions.md`), and a clawback or restore moves a
period once (`spec/cloud/billing/allowance.md`).

Sources are develop `packages/cloud/api/stripe/webhook/route.ts`,
`api/src/queue/stripe-event.ts`, `shared/src/lib/services/stripe-delivery-outbox.ts`
and the Quint models `StripeDeliveryOutbox` and `subscription_event_receipts`.
Signature checking, payload parsing, the provider reads a handler makes and
the store stay in the shell; the spec receives their verdicts. Each lease is
the kernel's claim (`spec/core/sessions.md`): a fresh token per claim and a
lease that only its current holder may settle under.

## Story: Apply each payment event once, whatever the delivery order

> As a subscriber, I want each payment the provider reports applied to my
> plan exactly once, even when its reports arrive late, twice or out of
> order, so that I never pay without getting my plan and never get a plan I
> did not pay for.

### An event is stored only when its signature verifies, its signing time is within five minutes of the server clock and its mode is the environment's

The shell checks the signature over the exact body against the configured
secrets and parses the signed time and `livemode`; production takes live
events only and staging test events only. Any other delivery is `400
invalid_request` and stores nothing. A stored event is answered `200
{received: true, queued: true}` only once its row is durable. A stored
event's phase follows its lease: pending or leased while it waits or runs,
committed exactly when it is done.

```quint
import types.* from "../shared/types"
import sessions as S from "../../core/sessions"
type ProviderEventType = CheckoutSessionCompleted | CheckoutSessionExpired | InvoicePaid | InvoicePaymentFailed | SubscriptionUpdated | SubscriptionDeleted | ChargeRefunded | DisputeFundsWithdrawn | DisputeFundsReinstated | OtherEventType
type DeadLetterCause = AttemptsSpent | PayloadUnreadable
type EventPhase = NotStored | Pending | Leased | Done | DeadLettered({ cause: DeadLetterCause })
type ProviderEvent = { phase: EventPhase, eventId: str, eventType: ProviderEventType, payloadDigest: str, attempts: int, dueAt: Millis, revivals: int, lease: S::Session }
pure val initial: ProviderEvent = { phase: NotStored, eventId: "", eventType: OtherEventType, payloadDigest: "", attempts: 0, dueAt: 0, revivals: 0, lease: S::initial }
pure val signatureTolerance: Millis = 300 * millisPerSecond
pure val drainOwner: S::SessionOwner = { agentId: "cloud", actorId: "providerEvents", connector: "payment_provider" }
pure val noExpiry: Millis = 9007199254740991
pure def nowOf(e: ProviderEvent): Millis = e.lease.now
pure def verifiedDelivery(e: ProviderEvent, signatureValid: bool, signedAt: Millis, livemode: bool, liveEnvironment: bool): bool =
  signatureValid and nowOf(e) - signedAt <= signatureTolerance and signedAt - nowOf(e) <= signatureTolerance and livemode == liveEnvironment
pure def canReceive(e: ProviderEvent, eventId: str, eventType: ProviderEventType, payloadDigest: str, signatureValid: bool, signedAt: Millis, livemode: bool, liveEnvironment: bool): bool =
  eventId != "" and payloadDigest != "" and S::canCreate(e.lease, drainOwner, noExpiry)
  and intakeAnswer(e, payloadDigest, verifiedDelivery(e, signatureValid, signedAt, livemode, liveEnvironment)) == StoredNew
pure def receive(e: ProviderEvent, eventId: str, eventType: ProviderEventType, payloadDigest: str, signatureValid: bool, signedAt: Millis, livemode: bool, liveEnvironment: bool): ProviderEvent =
  { ...e, phase: Pending, eventId: eventId, eventType: eventType, payloadDigest: payloadDigest, attempts: 0, dueAt: nowOf(e), lease: S::create(e.lease, drainOwner, noExpiry) }
pure def alwaysStoredEventIsBound(e: ProviderEvent): bool =
  ((e.phase == NotStored) iff (e.lease.phase == S::Absent))
  and (e.phase == NotStored implies (e.eventId == "" and e.payloadDigest == "" and e.revivals == 0))
  and (e.phase != NotStored implies (e.eventId != "" and e.payloadDigest != ""))
  and ((e.phase == Done) iff (e.lease.phase == S::Committed))
  and ((e.phase == Leased or isDeadLettered(e)) implies e.lease.phase == S::Claimed)
  and (e.phase == Pending implies (e.lease.phase == S::Pending or e.lease.phase == S::Claimed))
pure val signedAtValues = Set(-400000, 0, 400000)
pure val eventIdValues = Set("evt_1")
pure val payloadDigestValues = Set("p1", "p2")
```

### A repeated delivery is a duplicate, a resend of a dead-lettered event revives it, and another payload under the same id is refused

A duplicate is answered `200 {received: true, duplicate: true}` and changes
nothing; a done event is never revived. Another payload under a stored id is
`409 idempotency_conflict`. A revived event is due at once with a fresh
budget of attempts.

```quint
type IntakeAnswer = StoredNew | RevivedResend | DuplicateDelivery | RefusedUnverified | RefusedOtherPayload
pure def isDeadLettered(e: ProviderEvent): bool = { val p = e.phase
  match p { | DeadLettered(x) => true | _ => false } }
pure def intakeAnswer(e: ProviderEvent, payloadDigest: str, verified: bool): IntakeAnswer =
  if (not(verified)) RefusedUnverified
  else if (e.phase == NotStored) StoredNew
  else if (payloadDigest != e.payloadDigest) RefusedOtherPayload
  else if (isDeadLettered(e)) RevivedResend
  else DuplicateDelivery
pure def intakeStatus(a: IntakeAnswer): int =
  if (a == RefusedUnverified) statusOf(InvalidRequest) else if (a == RefusedOtherPayload) statusOf(IdempotencyConflict) else 200
pure def canRevive(e: ProviderEvent, payloadDigest: str, signatureValid: bool, signedAt: Millis, livemode: bool, liveEnvironment: bool): bool =
  intakeAnswer(e, payloadDigest, verifiedDelivery(e, signatureValid, signedAt, livemode, liveEnvironment)) == RevivedResend
pure def revive(e: ProviderEvent, payloadDigest: str, signatureValid: bool, signedAt: Millis, livemode: bool, liveEnvironment: bool): ProviderEvent =
  { ...e, phase: Pending, attempts: 0, dueAt: nowOf(e), revivals: e.revivals + 1 }
pure def stepIdentityIsFixed(before: ProviderEvent, after: ProviderEvent): bool =
  before.phase != NotStored implies (after.eventId == before.eventId and after.eventType == before.eventType and after.payloadDigest == before.payloadDigest)
pure def stepRevivalCountsResends(before: ProviderEvent, via: str, after: ProviderEvent): bool =
  after.revivals == (if (via == "revive") before.revivals + 1 else before.revivals)
pure def sometimesRevived(e: ProviderEvent): bool = e.phase == Pending and e.revivals >= 1
```

### Each event type has one owner, and an event of any other type is done at its first handling

Checkout events go to the checkout found by the session's reference; invoice
and subscription events to `reconcile` of the subscription they name; a
refund or a dispute of a subscription invoice to that invoice's allowance
period. A charge outside a subscription invoice, and every other type, has
no owner: credit purchase does not exist.

The Worker reconciles shared Stripe deliveries only for a locally bound
customer. When a refund or dispute names a charge, the Worker looks up
that charge's recorded local customer before making any provider request.
An owned subscription's verified invoice payments establish the charge
ownership. A later observation cannot move a charge to a different customer.
The Worker acknowledges an event for an unknown charge without reconciling.
Ordinary customer-scoped invoice reconciliation observes the current payment
state once the charge appears on a verified invoice.

```quint
import allowance as A from "./allowance"
type AllowanceChange = ClawBack({ cause: A::ClawbackCause }) | RestoreAllowance
type EventRoute = ToCheckoutPaid | ToCheckoutExpired | ToReconcile | ToAllowance({ change: AllowanceChange }) | Unrouted
pure def routeOf(eventType: ProviderEventType, onSubscriptionInvoice: bool): EventRoute =
  if (eventType == CheckoutSessionCompleted) ToCheckoutPaid
  else if (eventType == CheckoutSessionExpired) ToCheckoutExpired
  else if (Set(InvoicePaid, InvoicePaymentFailed, SubscriptionUpdated, SubscriptionDeleted).contains(eventType)) ToReconcile
  else if (not(onSubscriptionInvoice)) Unrouted
  else if (eventType == ChargeRefunded) ToAllowance({ change: ClawBack({ cause: A::RefundClawback }) })
  else if (eventType == DisputeFundsWithdrawn) ToAllowance({ change: ClawBack({ cause: A::DisputeClawback }) })
  else if (eventType == DisputeFundsReinstated) ToAllowance({ change: RestoreAllowance })
  else Unrouted
type HandlerError = ProviderDown | ProviderThrottled | StoreBusy | UnclassifiedError | PayloadParseFailed
type HandlerResult = Applied | NothingToApply | Failed({ error: HandlerError })
pure def stepUnownedTypeDoneAtFirstHandling(before: ProviderEvent, via: str, after: ProviderEvent): bool =
  (via == "finish" and before.eventType == OtherEventType) implies after.phase == Done
pure def sometimesUnownedTypeDone(e: ProviderEvent): bool = e.phase == Done and e.eventType == OtherEventType
```

### An owner that cannot apply a report applies nothing, and the event is done

Reports may arrive in any order, so a report its owner's guard refuses is
stale, not lost: a checkout already completed by its confirm or its
read-back, a subscription that is another or has ended, a period already
clawed back or past its end. The handler answers `NothingToApply`; the owner
moves nothing and the event is done. A subscription that is not yet known
is reconciled by the checkout that makes it.

```quint
import checkout as C from "./checkout"
import subscriptions as Sub from "./subscriptions"
pure def checkoutApplies(c: C::Checkout, route: EventRoute, sessionId: str, subscriptionId: str): bool =
  if (route == ToCheckoutPaid) C::canObservePaid(c, sessionId, subscriptionId) else if (route == ToCheckoutExpired) C::canObserveExpired(c, sessionId) else false
pure def subscriptionApplies(s: Sub::Subscription, route: EventRoute, subscriptionId: str): bool =
  route == ToReconcile and Sub::isLive(s.status) and subscriptionId == s.subscriptionId
pure def changeApplies(p: A::Period, change: AllowanceChange, now: Millis): bool = match change {
  | ClawBack(x) => A::canClawBack(p, x.cause)
  | RestoreAllowance => A::canRestore(p, now)
}
pure def periodApplies(p: A::Period, route: EventRoute, now: Millis): bool = match route {
  | ToAllowance(x) => changeApplies(p, x.change, now)
  | _ => false
}
```

### The drain claims a due event with a fresh token and a lease, spending one attempt

Every ten seconds the drain claims at most 25 due events in order of
storage time and id, and stops handling after 25 seconds; a lease lasts that
budget plus a minute. An event's claim depends on its own row only, so a
failing event never blocks a later one. An event whose drain was lost is
claimed again once its lease ends; if that drain had spent the last attempt,
the claim dead-letters it instead of running it a ninth time.

```quint
pure val drainEvery: Millis = 10 * millisPerSecond
pure val drainBatch = 25
pure val drainBudget: Millis = 25 * millisPerSecond
pure val leaseDuration: Millis = drainBudget + millisPerMinute
pure val maxAttempts = 8
pure def canClaim(e: ProviderEvent): bool =
  ((e.phase == Pending and nowOf(e) >= e.dueAt) or e.phase == Leased) and S::canAcquire(e.lease, drainOwner, e.payloadDigest, leaseDuration)
pure def claim(e: ProviderEvent): ProviderEvent =
  if (e.phase == Leased and e.attempts >= maxAttempts) { ...e, phase: DeadLettered({ cause: AttemptsSpent }) }
  else { ...e, phase: Leased, attempts: e.attempts + 1, lease: S::acquire(e.lease, drainOwner, e.payloadDigest, leaseDuration) }
pure def canElapse(e: ProviderEvent, elapsed: Millis): bool = S::canElapse(e.lease, elapsed)
pure def elapse(e: ProviderEvent, elapsed: Millis): ProviderEvent = { ...e, lease: S::elapse(e.lease, elapsed) }
pure val elapsedValues = Set(1000, 3600000)
pure def alwaysClaimTokensAreSound(e: ProviderEvent): bool = S::alwaysClaimSequenceIsValid(e.lease) and S::alwaysLiveClaimHasToken(e.lease)
pure def stepClaimTakesAFreshToken(before: ProviderEvent, via: str, after: ProviderEvent): bool =
  (after.lease.currentClaim != before.lease.currentClaim) implies (via == "claim" and after.lease.currentClaim > before.lease.claimSequence)
pure def sometimesClaimedAgain(e: ProviderEvent): bool = e.phase == Leased and e.lease.currentClaim >= 2
```

### Only the holder of the current, unexpired lease settles or releases an event

A drain whose lease ran out changes nothing; the event is handled again
under the next claim. The drain releases the events it did not reach within
its budget, returning their attempt; a released event is claimed again once
its lease ends.

```quint
pure val claimTokenValues = Set(0, 1, 2, 3)
pure def holdsLease(e: ProviderEvent, claimToken: int): bool = e.phase == Leased and S::canCommit(e.lease, drainOwner, claimToken, e.payloadDigest)
pure def canRelease(e: ProviderEvent, claimToken: int): bool = holdsLease(e, claimToken)
pure def release(e: ProviderEvent, claimToken: int): ProviderEvent = { ...e, phase: Pending, attempts: e.attempts - 1 }
pure def stepFinishedOnlyUnderTheLiveLease(before: ProviderEvent, via: str, after: ProviderEvent): bool =
  (via == "finish" or via == "release") implies (before.phase == Leased and nowOf(before) < before.lease.leaseUntil)
pure def sometimesReleasedUnreached(e: ProviderEvent): bool = e.phase == Pending and e.attempts == 0 and e.lease.currentClaim >= 1 and e.revivals == 0
```

### A handled event is done, and a failure is retried after 1, 2, 4, 8, 16, 32 and 60 minutes

The outcome is classified by the typed error the handler raised, never by
its message: an unavailable or throttling provider, a busy store and any
error not classified are retried; an unreadable payload is dead-lettered at
once. Done drops the payload and keeps the id, type and digest, so a later
duplicate is still recognised.

```quint
pure val retryDelays: List[Millis] = List(1, 2, 4, 8, 16, 32, 60, 60).listMap(m => m * millisPerMinute)
pure def retryDelayOf(attempts: int): Millis = retryDelays.nthOr(attempts - 1, 60 * millisPerMinute)
pure def lawRetryDelaysGrowUpToAnHour(attempts: int): bool =
  attempts >= 1 implies (retryDelayOf(attempts) >= millisPerMinute and retryDelayOf(attempts) <= retryDelayOf(attempts + 1) and retryDelayOf(attempts + 1) <= millisPerHour)
pure def keepsPayload(e: ProviderEvent): bool = e.phase != Done
pure def canFinish(e: ProviderEvent, claimToken: int, result: HandlerResult): bool =
  holdsLease(e, claimToken) and (e.eventType == OtherEventType implies result == NothingToApply)
pure def finish(e: ProviderEvent, claimToken: int, result: HandlerResult): ProviderEvent = match result {
  | Failed(x) =>
      if (x.error == PayloadParseFailed) { ...e, phase: DeadLettered({ cause: PayloadUnreadable }) }
      else if (e.attempts >= maxAttempts) { ...e, phase: DeadLettered({ cause: AttemptsSpent }) }
      else { ...e, phase: Pending, dueAt: nowOf(e) + retryDelayOf(e.attempts) }
  | _ => { ...e, phase: Done, lease: S::commit(e.lease, drainOwner, claimToken, e.payloadDigest) }
}
pure val resultValues = Set(Applied, NothingToApply, Failed({ error: StoreBusy }), Failed({ error: PayloadParseFailed }))
pure def stepDoneIsFinal(before: ProviderEvent, after: ProviderEvent): bool = before.phase == Done implies { ...after, lease: before.lease } == before
pure def stepDoneOnlyWhenHandled(before: ProviderEvent, via: str, after: ProviderEvent): bool = (before.phase != Done and after.phase == Done) implies via == "finish"
pure def sometimesDone(e: ProviderEvent): bool = e.phase == Done and e.eventType != OtherEventType
pure def sometimesWaitingForRetry(e: ProviderEvent): bool = e.phase == Pending and e.attempts >= 1 and e.dueAt > nowOf(e)
pure def sometimesDoneAfterRetry(e: ProviderEvent): bool = e.phase == Done and e.attempts >= 2
```

## Story: Keep an event that cannot be applied until the provider sends it again

> As the operator, I want an event that failed every attempt, or that the
> cloud could not read, kept and logged rather than dropped, so that after a
> fix a resend from the provider applies it without anyone re-creating it
> by hand.

### An event is dead-lettered only after its eighth attempt or with an unreadable payload, and keeps its payload

Each dead letter is logged with the event id, type and attempts. A
retryable event waits with an attempt left.

```quint
pure def alwaysAttemptsWithinBudget(e: ProviderEvent): bool = {
  val p = e.phase
  e.attempts >= 0 and e.attempts <= maxAttempts
  and (e.phase == NotStored implies e.attempts == 0)
  and (e.phase == Pending implies e.attempts < maxAttempts)
  and ((e.phase == Leased or e.phase == Done) implies e.attempts >= 1)
  and match p {
    | DeadLettered(x) => if (x.cause == AttemptsSpent) e.attempts == maxAttempts else e.attempts >= 1
    | _ => true
  }
}
pure def sometimesDeadLettered(e: ProviderEvent): bool = isDeadLettered(e)
```
