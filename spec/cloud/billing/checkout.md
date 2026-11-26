# Subscription checkout

One `Checkout` is one person's purchase of a paid plan: one provider checkout
session, created once (`spec/cloud/shared/dispatchOnce.md`) and finished by
whichever path sees its payment first: the provider's event
(`spec/cloud/billing/providerEvents.md`), the app's confirm, or the shell's
read-back sweep. A checkout holds the organization's one command slot
(`spec/cloud/billing/subscriptions.md`) from its start until it ends; the
shell applies each `ClaimSlot` and `ReleaseSlot` effect to the subscription,
and each `CheckoutPaid` as `checkoutPaid` and then `reconcile` of the
subscription, in the same transaction as the step. Sources are develop
`packages/cloud/shared/src/lib/services/subscription-checkout.ts`,
`subscription-checkout-contract.ts` and the Quint models
`SubscriptionCheckoutReadBack` and `checkout_retry_clock`; downstream readers
are the products' plan payment screens.

`POST /api/v1/subscriptions/checkout` takes `{planKey, idempotencyKey,
presentation}` and `POST /api/v1/subscriptions/checkout/confirm` takes
`{sessionId}`; both admit a device key or a session of the organization's
owner. Provider calls, the session's secret and the answers' shapes stay in
the shell. Credit purchase does not exist: accounts are funded by the
operator or by plan allowance.

## Story: Subscribe once, whichever screen or payer finishes it

> As a person choosing a paid plan, I want to pay for it once, on the
> provider's page, inside the app or through a link someone else pays, so
> that I get the plan I paid for and am never charged twice.

### A checkout buys one paid plan in one presentation, and returns only where that presentation allows

`mobile` is the provider's hosted page; it returns to the billing return of
the caller's registration (`spec/cloud/nativeClients/registry.md`), with
`session_id` and `result=success` on success and `result=cancel` on cancel. `embedded` is the
provider's form inside the app and never redirects. `shared` is a link
another person pays; it returns to the CheckoutOutcome page
(`spec/cloud/returnPages.md`). The request names no URL, and `hosted` is
refused as `400 invalid_request`. Every session is card only, quantity one,
in US dollars, without promotion codes or tax, and carries the command id as
its reference.

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
import registry.* from "../nativeClients/registry"
import subscriptions as Sub from "./subscriptions"
import dispatchOnce as D from "../shared/dispatchOnce"
import sessions as S from "../../core/sessions"
type Presentation = Mobile | Embedded | Shared
type CheckoutReturn = ToApp({ url: ReturnUrl }) | ToPayerPage | StaysInApp
type CheckoutPhase = NotStarted | Opening | Open | Completed | Expired
type Checkout = { phase: CheckoutPhase, commandId: str, planKey: PlanKey, presentation: Presentation, returns: CheckoutReturn, sessionId: str, sessionExpiresAt: Millis, subscriptionId: str, readBacks: int, nextReadBackAt: Millis, receipt: D::Receipt }
pure val initial: Checkout = { phase: NotStarted, commandId: "", planKey: Free, presentation: Mobile, returns: StaysInApp, sessionId: "", sessionExpiresAt: 0, subscriptionId: "", readBacks: 0, nextReadBackAt: 0, receipt: D::initial }
pure def returnFor(presentation: Presentation, billingReturn: ReturnUrl): CheckoutReturn =
  if (presentation == Mobile) ToApp({ url: billingReturn }) else if (presentation == Shared) ToPayerPage else StaysInApp
pure def returnFits(presentation: Presentation, returns: CheckoutReturn): bool = match returns {
  | ToApp(x) => presentation == Mobile
  | ToPayerPage => presentation == Shared
  | StaysInApp => presentation == Embedded
}
pure def lawEachPresentationHasItsOwnReturn(presentation: Presentation, billingReturn: ReturnUrl): bool = returnFits(presentation, returnFor(presentation, billingReturn))
pure val billingReturnValues = Set({ origin: "https://www.one", path: "/one/billing" })
```

### A checkout starts only for an active account with a pinned customer, no live subscription and no other live command

Starting claims the command slot and prepares and claims the receipt in one
transaction, before the provider is asked; the shell pins the provider
customer first when the organization has none. The session is created
keyed by the command id, found stale five minutes after the claim, and
expires 23 hours 55 minutes after it, below the provider's 24-hour limit. An
account that is not Active is `403 access_denied` with reason
`account_inactive`; a live subscription or command is `409
billing_state_conflict`.

```quint
type CheckoutEffect = ClaimSlot({ commandId: str }) | ReleaseSlot({ commandId: str }) | CheckoutPaid({ commandId: str, subscriptionId: str, planKey: PlanKey })
type CheckoutStep = { state: Checkout, out: List[CheckoutEffect] }
pure val sessionLifetime: Millis = 23 * millisPerHour + 55 * millisPerMinute
pure val checkoutStaleAfter: Millis = 5 * millisPerMinute
pure val firstReadBack: Millis = 2 * millisPerMinute
pure def nowOf(c: Checkout): Millis = c.receipt.session.now
pure def providerKeyOf(commandId: str): ProviderKey = { providerKind: CheckoutSession, providerId: commandId }
pure def preparedFor(c: Checkout, by: S::SessionOwner, commandId: str, digest: str): D::Receipt =
  D::prepare(c.receipt, by, digest, providerKeyOf(commandId), checkoutStaleAfter, nowOf(c) + sessionLifetime)
pure def canStart(c: Checkout, by: S::SessionOwner, sub: Sub::Subscription, commandId: str, planKey: PlanKey, presentation: Presentation, billingReturn: ReturnUrl, digest: str, accountActive: bool): bool =
  accountActive and c.phase == NotStarted and isPaid(planKey) and Sub::canClaimCommand(sub, Sub::CheckoutCommand, commandId, sub.revision)
  and D::canPrepare(c.receipt, by, digest, providerKeyOf(commandId), checkoutStaleAfter, nowOf(c) + sessionLifetime)
  and D::canClaim(preparedFor(c, by, commandId, digest), by)
pure def start(c: Checkout, by: S::SessionOwner, sub: Sub::Subscription, commandId: str, planKey: PlanKey, presentation: Presentation, billingReturn: ReturnUrl, digest: str, accountActive: bool): CheckoutStep =
  { state: { ...c, phase: Opening, commandId: commandId, planKey: planKey, presentation: presentation, returns: returnFor(presentation, billingReturn),
      sessionExpiresAt: nowOf(c) + sessionLifetime, nextReadBackAt: nowOf(c) + firstReadBack, receipt: D::claim(preparedFor(c, by, commandId, digest), by) },
    out: List(ClaimSlot({ commandId: commandId })) }
pure val byValues = Set({ agentId: "org1", actorId: "user1", connector: "checkout_session" }, { agentId: "org1", actorId: "user1", connector: "subscription_update" })
pure val subValues = Set({ ...Sub::initial, customer: Sub::PinnedCustomer({ customerId: "cus1" }) }, Sub::initial,
  { ...Sub::initial, status: Sub::Active, subscriptionId: "sub0", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: PlusMonthly, periodStart: 0, periodEnd: 2592000000, revision: 1 })
pure val commandIdValues = Set("cmd1")
pure val digestValues = Set("d1", "d2")
pure def alwaysContractIsBound(c: Checkout): bool =
  ((c.phase == NotStarted) iff (c.receipt.session.phase == S::Absent))
  and (c.phase != NotStarted implies (c.commandId != "" and isPaid(c.planKey) and returnFits(c.presentation, c.returns)
    and D::usesProviderKey(c.receipt, providerKeyOf(c.commandId)) and c.sessionExpiresAt == c.receipt.claimedAt + sessionLifetime
    and c.nextReadBackAt >= c.receipt.claimedAt + firstReadBack))
pure def stepContractIsFixed(before: Checkout, after: Checkout): bool =
  before.phase != NotStarted implies (after.commandId == before.commandId and after.planKey == before.planKey and after.presentation == before.presentation
    and after.returns == before.returns and after.sessionExpiresAt == before.sessionExpiresAt and (before.sessionId != "" implies after.sessionId == before.sessionId))
```

### A repeated start with the same key and request answers the checkout as it stands, and any other request under that key is idempotency_conflict

The client's idempotency key is unique within the organization. The request
digest covers the organization, the user, the plan, the catalog version, the
presentation and the return, so another plan, presentation or client under
the same key is `409 idempotency_conflict`.

```quint
pure def replayAnswers(c: Checkout, by: S::SessionOwner, digest: str): bool = c.phase != NotStarted and not(D::isConflict(c.receipt, by, digest))
```

### A start while another checkout is live resumes it for the same plan, presentation and return, and otherwise waits for its session to end

The shell answers a resumed checkout as it stands, on any device and under
any key. For another plan, presentation or return it asks the provider to
expire the live session and starts once a read-back shows it expired; a
read-back that shows it paid refuses the start as `409
billing_state_conflict`, and one that cannot tell answers `503
service_unavailable`. So a shared link and an in-app form never both charge
an organization.

```quint
pure def resumes(c: Checkout, planKey: PlanKey, presentation: Presentation, billingReturn: ReturnUrl): bool =
  (c.phase == Opening or c.phase == Open) and c.planKey == planKey and c.presentation == presentation and c.returns == returnFor(presentation, billingReturn)
```

### The provider session is created once, and a lost reply is found again by a lookup of the command id, never by creating it again

The receipt keeps every rule of `dispatchOnce.md`. A reply or lookup that
shows the session records its id and opens the checkout; a refusal, or a
session never created, ends it as expired and frees the slot, and the client
starts again with a new key.

```quint
pure def afterReceipt(receipt: D::Receipt, c: Checkout, sessionId: str): CheckoutStep =
  if (receipt.settlement == D::Succeeded) { state: { ...c, phase: Open, sessionId: sessionId, receipt: receipt }, out: List() }
  else if (receipt.settlement != D::Unsettled) { state: { ...c, phase: Expired, receipt: receipt }, out: List(ReleaseSlot({ commandId: c.commandId })) }
  else { state: { ...c, receipt: receipt }, out: List() }
pure def canSend(c: Checkout, by: S::SessionOwner, claimToken: int): bool = c.phase == Opening and D::canSend(c.receipt, by, claimToken)
pure def send(c: Checkout, by: S::SessionOwner, claimToken: int): Checkout = { ...c, receipt: D::send(c.receipt, by, claimToken) }
pure def canReceiveReply(c: Checkout, reply: D::ProviderReply, sessionId: str): bool =
  c.phase == Opening and D::canReceiveReply(c.receipt, reply) and ((reply == D::ShowsEffect) iff (sessionId != ""))
pure def receiveReply(c: Checkout, reply: D::ProviderReply, sessionId: str): CheckoutStep = afterReceipt(D::receiveReply(c.receipt, reply), c, sessionId)
pure def canLoseExecutor(c: Checkout): bool = c.phase == Opening and D::canLoseExecutor(c.receipt)
pure def loseExecutor(c: Checkout): Checkout = { ...c, receipt: D::loseExecutor(c.receipt) }
pure def canResolve(c: Checkout, lookup: D::LookupResult, sessionId: str): bool =
  c.phase == Opening and D::canResolve(c.receipt, lookup) and ((lookup == D::EffectSeen) iff (sessionId != ""))
pure def resolve(c: Checkout, lookup: D::LookupResult, sessionId: str): CheckoutStep = afterReceipt(D::resolve(c.receipt, lookup), c, sessionId)
pure def canElapse(c: Checkout, elapsed: Millis): bool = D::canElapse(c.receipt, elapsed)
pure def elapse(c: Checkout, elapsed: Millis): Checkout = { ...c, receipt: D::elapse(c.receipt, elapsed) }
pure val replyValues = Set(D::ShowsEffect, D::DefiniteRefusal({ cause: D::OtherRefusal }), D::Unclear)
pure val lookupValues = Set(D::EffectSeen, D::NothingSeen)
pure val sessionIdValues = Set("", "cs_1", "cs_2")
pure val elapsedValues = Set(60000, 120000, 600000)
pure def alwaysPhaseFollowsTheReceipt(c: Checkout): bool =
  D::alwaysPreparedIsBound(c.receipt) and D::alwaysSessionIsSound(c.receipt) and D::alwaysSentBeforeStale(c.receipt) and D::alwaysOutcomeFollowsTheSession(c.receipt)
  and ((c.phase == NotStarted or c.phase == Opening) iff (c.receipt.settlement == D::Unsettled))
  and ((c.phase == Open or c.phase == Completed) implies c.receipt.settlement == D::Succeeded)
  and ((c.sessionId != "") iff (c.receipt.settlement == D::Succeeded))
pure def stepReceiptKeepsItsRules(before: Checkout, via: str, after: Checkout): bool =
  D::stepBindingIsFixed(before.receipt, after.receipt) and D::stepCommitNeverReopens(before.receipt, after.receipt) and D::stepStaleTimeIsFixed(before.receipt, after.receipt)
  and D::stepSettledIsFinal(before.receipt, after.receipt) and D::stepUnknownSettlesOnlyByLookup(before.receipt, via, after.receipt)
pure def sometimesOutcomeUnknown(c: Checkout): bool = c.phase == Opening and D::isUnknown(c.receipt)
pure def sometimesOpenedByLookup(c: Checkout): bool = c.phase == Open and not(c.receipt.session.executorAlive)
pure def sometimesNeverCreated(c: Checkout): bool = c.phase == Expired and c.receipt.settlement == D::NotApplied
```

### Only the provider's report that the session was paid completes a checkout, and a completed checkout is never ended

The report is the `checkout.session.completed` event, or a read of the
session by the confirm route or the sweep, which all find the checkout by
the session's reference and the organization in its metadata; a session of
another organization is `404 not_found`. Completing hands the provider's new
subscription to the subscription once.

```quint
pure def canObservePaid(c: Checkout, sessionId: str, subscriptionId: str): bool = c.phase == Open and sessionId == c.sessionId and subscriptionId != ""
pure def observePaid(c: Checkout, sessionId: str, subscriptionId: str): CheckoutStep =
  { state: { ...c, phase: Completed, subscriptionId: subscriptionId }, out: List(CheckoutPaid({ commandId: c.commandId, subscriptionId: subscriptionId, planKey: c.planKey })) }
pure val subscriptionIdValues = Set("", "sub1")
pure def alwaysOnlyACompletedCheckoutHasASubscription(c: Checkout): bool = (c.phase == Completed) iff (c.subscriptionId != "")
pure def stepEndsAreFinal(before: Checkout, after: Checkout): bool =
  (before.phase == Completed or before.phase == Expired) implies (after.phase == before.phase and after.subscriptionId == before.subscriptionId)
pure def sometimesCompleted(c: Checkout): bool = c.phase == Completed
pure def sometimesCompletedAfterALostReply(c: Checkout): bool = c.phase == Completed and not(c.receipt.session.executorAlive)
```

### Only the provider's report that the session expired ends an open checkout

The report is the `checkout.session.expired` event or a read-back. To
replace a checkout, the shell asks the provider to expire its recorded
session. For an inactive account, the shell first checks the provider
session's binding and that no other account holds the billing. The shell
reads the result back before closing the checkout. Ending frees the slot.

```quint
pure def canObserveExpired(c: Checkout, sessionId: str): bool = c.phase == Open and sessionId == c.sessionId
pure def observeExpired(c: Checkout, sessionId: str): CheckoutStep = { state: { ...c, phase: Expired }, out: List(ReleaseSlot({ commandId: c.commandId })) }
pure def sometimesExpiredUnpaid(c: Checkout): bool = c.phase == Expired and c.receipt.settlement == D::Succeeded
```

### The sweep reads an open checkout back two minutes after its start, then waits as long as the checkout's age, at most thirty minutes

So a paid checkout whose event is late or lost completes within minutes, at
ages of about 2, 4, 8, 16 and 32 minutes and then every 30. A read-back that
shows the session paid or expired is `observePaid` or `observeExpired`; one
that shows it still open only moves the next read-back.

```quint
pure val longestReadBackWait: Millis = 30 * millisPerMinute
pure def readBackWait(age: Millis): Millis = if (age < firstReadBack) firstReadBack else if (age > longestReadBackWait) longestReadBackWait else age
pure def canReadBackOpen(c: Checkout): bool = c.phase == Open and nowOf(c) >= c.nextReadBackAt
pure def readBackOpen(c: Checkout): Checkout = { ...c, readBacks: c.readBacks + 1, nextReadBackAt: nowOf(c) + readBackWait(nowOf(c) - c.receipt.claimedAt) }
pure def stepReadBacksWaitTheirTurn(before: Checkout, via: str, after: Checkout): bool =
  (via == "readBackOpen" implies (nowOf(before) >= before.nextReadBackAt and after.nextReadBackAt >= nowOf(before) + firstReadBack and after.nextReadBackAt <= nowOf(before) + longestReadBackWait))
  and (via != "readBackOpen" implies (after.readBacks == before.readBacks and (before.phase != NotStarted implies after.nextReadBackAt == before.nextReadBackAt)))
pure def sometimesReadBackWaitsLonger(c: Checkout): bool = c.phase == Open and c.readBacks >= 2 and c.nextReadBackAt - nowOf(c) > firstReadBack
```

### A checkout holds the command slot from its start until it ends, and every effect names it

Completing frees the slot through `checkoutPaid` of the subscription.

```quint
pure def holdsSlot(c: Checkout): bool = c.phase == Opening or c.phase == Open
pure def isSlotClaim(e: CheckoutEffect): bool = match e { | ClaimSlot(x) => true | _ => false }
pure def isSlotFreed(e: CheckoutEffect): bool = match e { | ClaimSlot(x) => false | _ => true }
pure def isPayment(e: CheckoutEffect): bool = match e { | CheckoutPaid(x) => true | _ => false }
pure def namesCheckout(c: Checkout, e: CheckoutEffect): bool = match e {
  | ClaimSlot(x) => x.commandId == c.commandId
  | ReleaseSlot(x) => x.commandId == c.commandId
  | CheckoutPaid(x) => x.commandId == c.commandId and x.subscriptionId == c.subscriptionId and x.planKey == c.planKey
}
pure def stepSlotFollowsTheCheckout(before: Checkout, after: Checkout, out: List[CheckoutEffect]): bool =
  ((not(holdsSlot(before)) and holdsSlot(after)) iff out.some(e => isSlotClaim(e)))
  and ((holdsSlot(before) and not(holdsSlot(after))) iff out.some(e => isSlotFreed(e)))
  and ((before.phase != Completed and after.phase == Completed) iff out.some(e => isPayment(e)))
  and out.length() <= 1 and out.every(e => namesCheckout(after, e))
```

### A checkout answers open with its session, completed only while the subscription it bought is live, and otherwise its end

An open `mobile` or `shared` checkout answers `{status: "open", commandId,
checkoutUrl, sessionId, expiresAt}`, the URL on the provider's checkout
host; an open `embedded` one answers `{status: "open", commandId, uiMode:
"embedded", sessionId, clientSecret, publishableKey, amountDueCents,
currency: "usd", interval: "month", expiresAt}`, the amount being the
session's own. Otherwise it answers `{status, commandId}`: `completed`,
`stale_intent` when the subscription it bought has ended, or `expired`; for
either of the last two the client starts again with a new key. A checkout
whose session is not yet known answers `503 service_unavailable`, retryable.

```quint
type CheckoutAnswer = AnswerUnavailable | AnswerOpen | AnswerCompleted | AnswerStaleIntent | AnswerExpired
pure def answerOf(c: Checkout, subscriptionLive: bool): CheckoutAnswer =
  if (c.phase == Open) AnswerOpen
  else if (c.phase == Completed) (if (subscriptionLive) AnswerCompleted else AnswerStaleIntent)
  else if (c.phase == Expired) AnswerExpired
  else AnswerUnavailable
```
