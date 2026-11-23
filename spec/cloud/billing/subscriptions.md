# Subscriptions

The organization's subscription as the payment provider holds it, and the one
billing command that may run for it at a time; one row per organization.
Checkout (`spec/cloud/billing/checkout.md`), the commands
(`spec/cloud/billing/subscriptionCommands.md`) and the event drain
(`spec/cloud/billing/providerEvents.md`) all end in `reconcile`, which applies
the provider's live subscription and latest invoice in one transaction.
Sources are develop `packages/cloud/shared/src/lib/services/subscription-*.ts`,
`stripe-paid-renewal.ts`, `stripe-customer-authority.ts` and the Quint model
`SubscriptionTerminalReceipt`. Provider calls, identity checks against the
provider and answer shapes stay in the shell; a lost reply is recovered by
reading the live subscription again. Wire statuses are `pending`,
`incomplete`, `active`, `dunning`, `past_due`, `unpaid`, `canceled` and
`incomplete_expired`; no subscription is `null`.

## Story: Keep my plan as the provider says it is

> As a subscriber, I want my plan, period and status to follow what the
> payment provider says about my subscription, so that I get what I paid for
> and nothing I did not.

### A subscription is live or ended, and only an active or dunning one is entitled

Pending is a paid checkout not yet reconciled; it gives neither paid limits
nor an entitlement, and neither does an incomplete first payment. An ended
subscription leaves the organization on the free plan or its grant
(`spec/cloud/billing/entitlements.md`).

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
import allowance as A from "./allowance"
type SubscriptionStatus = NoSubscription | Pending | Incomplete | Active | Dunning | PastDue | Unpaid | Canceled | IncompleteExpired
pure def isLive(status: SubscriptionStatus): bool = Set(Pending, Incomplete, Active, Dunning, PastDue, Unpaid).contains(status)
pure def isEnded(status: SubscriptionStatus): bool = status == Canceled or status == IncompleteExpired
pure def inDunning(status: SubscriptionStatus): bool = Set(Dunning, PastDue, Unpaid).contains(status)
pure def hasPaidLimits(status: SubscriptionStatus): bool = status == Active or inDunning(status)
pure def isEntitled(status: SubscriptionStatus): bool = status == Active or status == Dunning
pure def lawEntitledHasPaidLimitsAndIsLive(status: SubscriptionStatus): bool =
  (isEntitled(status) implies hasPaidLimits(status)) and (hasPaidLimits(status) implies isLive(status)) and not(isLive(status) and isEnded(status))
```

### A subscription exists only with a provider id, a paid plan and the organization's pinned customer

The organization's provider customer is pinned once, before its first
checkout, and never replaced. A subscription that is not pending carries the
period the provider last reported.

```quint
type CustomerPin = NoCustomer | PinnedCustomer({ customerId: str })
type DunningWindow = NotDunning | DunningSince({ startedAt: Millis, endsAt: Millis })
type PlannedChange = NoPlannedChange | DowngradeAtRenewal({ planKey: PlanKey })
type CommandKind = CheckoutCommand | CancelCommand | UndoCommand | UpgradeCommand | DowngradeCommand
type CommandSlot = NoLiveCommand | Live({ kind: CommandKind, commandId: str })
type Subscription = { status: SubscriptionStatus, subscriptionId: str, customer: CustomerPin, planKey: PlanKey, periodStart: Millis, periodEnd: Millis, cancelAtPeriodEnd: bool, planned: PlannedChange, dunning: DunningWindow, lastRenewalInvoice: str, revision: int, liveCommand: CommandSlot }
type SubscriptionEffect = OpenRenewalPeriod({ invoiceId: str, planKey: PlanKey, startsAt: Millis, endsAt: Millis }) | CloseRenewalPeriods | PolicyChanged
type SubscriptionStep = { state: Subscription, out: List[SubscriptionEffect] }
pure val initial: Subscription = { status: NoSubscription, subscriptionId: "", customer: NoCustomer, planKey: Free, periodStart: 0, periodEnd: 0, cancelAtPeriodEnd: false, planned: NoPlannedChange, dunning: NotDunning, lastRenewalInvoice: "", revision: 0, liveCommand: NoLiveCommand }
pure def customerIdOf(s: Subscription): str = { val c = s.customer
  match c { | PinnedCustomer(x) => x.customerId | NoCustomer => "" } }
pure def canPinCustomer(s: Subscription, customerId: str): bool = s.customer == NoCustomer and customerId != ""
pure def pinCustomer(s: Subscription, customerId: str): Subscription = { ...s, customer: PinnedCustomer({ customerId: customerId }) }
pure val customerIdValues = Set("cus1", "cus2")
pure def alwaysSubscriptionHasIdPlanAndCustomer(s: Subscription): bool =
  ((s.status == NoSubscription) iff (s.subscriptionId == "")) and (s.status != NoSubscription implies (isPaid(s.planKey) and s.customer != NoCustomer))
  and ((s.status != NoSubscription and s.status != Pending) implies A::validWindow(s.periodStart, s.periodEnd))
pure def stepCustomerPinnedOnce(before: Subscription, after: Subscription): bool = before.customer != NoCustomer implies after.customer == before.customer
```

### A paid checkout makes a new pending subscription for the checkout's plan, under the pinned customer

Only the live checkout can report its payment, and it frees the command slot
as it does. The provider's subscription id is new: an ended subscription is
never revived.

```quint
pure def canCheckoutPaid(s: Subscription, commandId: str, subscriptionId: str, planKey: PlanKey, customerId: str): bool =
  commandId != "" and s.liveCommand == Live({ kind: CheckoutCommand, commandId: commandId }) and not(isLive(s.status))
  and subscriptionId != "" and subscriptionId != s.subscriptionId and isPaid(planKey) and s.customer != NoCustomer and customerIdOf(s) == customerId
pure def checkoutPaid(s: Subscription, commandId: str, subscriptionId: str, planKey: PlanKey, customerId: str): SubscriptionStep =
  { state: { ...s, status: Pending, subscriptionId: subscriptionId, planKey: planKey, periodStart: 0, periodEnd: 0, cancelAtPeriodEnd: false, planned: NoPlannedChange, dunning: NotDunning, lastRenewalInvoice: "", liveCommand: NoLiveCommand, revision: s.revision + 1 },
    out: List(PolicyChanged) }
pure val subscriptionIdValues = Set("sub1", "sub2")
pure def sometimesAwaitingReconciliation(s: Subscription): bool = s.status == Pending
```

### Reconciling sets the status, plan, period and cancellation the provider reports for the subscription the organization holds

The provider's `incomplete` is Incomplete; `active` is Active unless the
latest period invoice failed; `past_due`, or `active` with a failed period
invoice, is Dunning until the dunning window ends and PastDue after;
`unpaid` is Unpaid; `canceled` (the subscription was deleted) is Canceled and
`incomplete_expired` is IncompleteExpired. A period invoice is one the
provider bills for a period (billing reason `subscription_create` or
`subscription_cycle`); a plan change invoice (`subscription_update`) never
moves the status, since the provider keeps an unpaid upgrade pending. An
observation of another subscription id, or of one that has ended, changes
nothing; the drain retries or drops it
(`spec/cloud/billing/providerEvents.md`).

```quint
type ProviderStatus = ProviderIncomplete | ProviderActive | ProviderPastDue | ProviderUnpaid | ProviderCanceled | ProviderIncompleteExpired
type LatestInvoice = PeriodInvoicePaid | PeriodInvoiceOpen | PeriodInvoiceFailed | PlanChangeInvoice
pure val dunningGrace: Millis = 3 * millisPerDay
pure def dunningEndsAt(w: DunningWindow): Millis = match w { | DunningSince(x) => x.endsAt | NotDunning => 0 }
pure def dunningStart(s: Subscription, now: Millis): Millis = if (s.periodEnd > 0 and s.periodEnd <= now) s.periodEnd else now
pure def windowFrom(s: Subscription, now: Millis): DunningWindow =
  if (s.dunning == NotDunning) DunningSince({ startedAt: dunningStart(s, now), endsAt: dunningStart(s, now) + dunningGrace }) else s.dunning
pure def observedStatus(s: Subscription, providerStatus: ProviderStatus, latestInvoice: LatestInvoice, now: Millis): SubscriptionStatus =
  if (providerStatus == ProviderIncomplete) Incomplete
  else if (providerStatus == ProviderCanceled) Canceled
  else if (providerStatus == ProviderIncompleteExpired) IncompleteExpired
  else if (providerStatus == ProviderUnpaid) Unpaid
  else if (providerStatus == ProviderActive and (latestInvoice == PeriodInvoicePaid or (latestInvoice != PeriodInvoiceFailed and not(inDunning(s.status))))) Active
  else if (s.status == PastDue or s.status == Unpaid or now >= dunningEndsAt(windowFrom(s, now))) PastDue
  else Dunning
pure def keepPlanned(planned: PlannedChange, status: SubscriptionStatus, planKey: PlanKey): PlannedChange = match planned {
  | DowngradeAtRenewal(x) => if (isLive(status) and isDowngrade(planKey, x.planKey)) planned else NoPlannedChange
  | NoPlannedChange => NoPlannedChange
}
pure def canReconcile(s: Subscription, subscriptionId: str, planKey: PlanKey, periodStart: Millis, periodEnd: Millis, now: Millis): bool =
  isLive(s.status) and subscriptionId == s.subscriptionId and isPaid(planKey) and A::validWindow(periodStart, periodEnd) and now >= 0
pure def reconcile(s: Subscription, subscriptionId: str, providerStatus: ProviderStatus, latestInvoice: LatestInvoice, invoiceId: str, planKey: PlanKey, periodStart: Millis, periodEnd: Millis, cancelAtPeriodEnd: bool, now: Millis): SubscriptionStep = {
  val status = observedStatus(s, providerStatus, latestInvoice, now)
  val renewal = status == Active and latestInvoice == PeriodInvoicePaid and invoiceId != "" and invoiceId != s.lastRenewalInvoice
  val observed = { ...s, status: status, planKey: planKey, periodStart: periodStart, periodEnd: periodEnd, cancelAtPeriodEnd: cancelAtPeriodEnd,
    planned: keepPlanned(s.planned, status, planKey), dunning: if (inDunning(status)) windowFrom(s, now) else NotDunning,
    lastRenewalInvoice: if (renewal) invoiceId else s.lastRenewalInvoice }
  val changed = observed != s
  { state: if (changed) { ...observed, revision: s.revision + 1 } else s,
    out: (if (renewal) List(OpenRenewalPeriod({ invoiceId: invoiceId, planKey: planKey, startsAt: periodStart, endsAt: periodEnd })) else List())
      .concat(if (isEnded(status)) List(CloseRenewalPeriods) else List())
      .concat(if (changed) List(PolicyChanged) else List()) }
}
pure val invoiceIdValues = Set("in_1", "in_2")
pure val periodStartValues = Set(0, 600000)
pure val periodEndValues = Set(600000, 1200000)
pure val nowValues = Set(0, 600000, 259800000)
pure def sometimesIncomplete(s: Subscription): bool = s.status == Incomplete
pure def sometimesUnpaid(s: Subscription): bool = s.status == Unpaid
pure def sometimesSetToCancelAtPeriodEnd(s: Subscription): bool = s.status == Active and s.cancelAtPeriodEnd
```

### A failed payment opens one dunning window of three days, set once, after which the subscription is past due

The window starts at the period end when that has passed, else at the
observation. A verified, paid period invoice can return the subscription to
Active and clear the window. A plan-change invoice or an open period invoice
cannot restore Active. A past due or unpaid subscription never returns to
dunning. The shell's schedule expires ended windows.

```quint
pure def canExpireDunning(s: Subscription, now: Millis): bool = s.status == Dunning and now >= dunningEndsAt(s.dunning)
pure def expireDunning(s: Subscription, now: Millis): SubscriptionStep = { state: { ...s, status: PastDue, revision: s.revision + 1 }, out: List(PolicyChanged) }
pure def windowIsThreeDays(w: DunningWindow): bool = match w { | DunningSince(x) => x.startedAt >= 0 and x.endsAt == x.startedAt + dunningGrace | NotDunning => true }
pure def alwaysDunningWindowOnlyWhileDunning(s: Subscription): bool = ((s.dunning != NotDunning) iff inDunning(s.status)) and windowIsThreeDays(s.dunning)
pure def stepDunningWindowSetOnce(before: Subscription, after: Subscription): bool = (before.dunning != NotDunning and after.dunning != NotDunning) implies after.dunning == before.dunning
pure def stepLapsedNeverReturnsToDunning(before: Subscription, after: Subscription): bool = (before.status == PastDue or before.status == Unpaid) implies after.status != Dunning
pure def lawOnlyPaidPeriodRestoresActive(s: Subscription, providerStatus: ProviderStatus, latestInvoice: LatestInvoice, now: Millis): bool =
  (inDunning(s.status) and observedStatus(s, providerStatus, latestInvoice, now) == Active) implies latestInvoice == PeriodInvoicePaid
pure def sometimesDunning(s: Subscription): bool = s.status == Dunning
pure def sometimesPastDue(s: Subscription): bool = s.status == PastDue
```

### An ended subscription is never rewritten, and ending it closes its allowance periods

```quint
pure def stepEndedNeverRewritten(before: Subscription, after: Subscription): bool =
  (isEnded(before.status) and after.subscriptionId == before.subscriptionId) implies { ...after, liveCommand: before.liveCommand } == before
pure def stepEndingClosesPeriods(before: Subscription, after: Subscription, out: List[SubscriptionEffect]): bool =
  (isLive(before.status) and isEnded(after.status)) implies out.includes(CloseRenewalPeriods)
pure def sometimesCanceled(s: Subscription): bool = s.status == Canceled
pure def sometimesExpiredBeforePayment(s: Subscription): bool = s.status == IncompleteExpired
```

### A paid period invoice opens its period's allowance once, by invoice id

The first paid invoice and each paid renewal open one; so does a renewal
paid late, after dunning. The period is keyed by the environment and the
invoice id (`spec/cloud/billing/allowance.md`), so a second reconcile of the
same invoice opens nothing. A paid plan change invoice keeps the period and
adjusts its allowance instead (`spec/cloud/billing/subscriptionCommands.md`).

```quint
pure def renewalOpens(before: Subscription, after: Subscription, e: SubscriptionEffect): bool = match e {
  | OpenRenewalPeriod(x) => x.invoiceId != before.lastRenewalInvoice and after.lastRenewalInvoice == x.invoiceId and after.status == Active
      and A::canOpenRenewal(A::initial, x.invoiceId, x.planKey, x.startsAt, x.endsAt)
  | _ => true
}
pure def isRenewalOpening(e: SubscriptionEffect): bool = match e { | OpenRenewalPeriod(x) => true | _ => false }
pure def stepRenewalOpensOncePerInvoice(before: Subscription, after: Subscription, out: List[SubscriptionEffect]): bool =
  out.every(e => renewalOpens(before, after, e))
  and ((after.lastRenewalInvoice != before.lastRenewalInvoice and after.lastRenewalInvoice != "") implies out.some(e => isRenewalOpening(e)))
pure def sometimesRenewalAllowanceOpened(s: Subscription): bool = s.status == Active and s.lastRenewalInvoice != "" and s.periodStart > 0
```

### A pending downgrade waits for the provider to bill the lower plan, and is dropped when the subscription ends

The downgrade command records it once its schedule exists; the reconcile
that shows the provider billing the lower plan clears it.

```quint
pure def holdsCommand(s: Subscription, kind: CommandKind, commandId: str): bool = commandId != "" and s.liveCommand == Live({ kind: kind, commandId: commandId })
pure def canScheduleDowngrade(s: Subscription, commandId: str, planKey: PlanKey): bool =
  holdsCommand(s, DowngradeCommand, commandId) and s.status == Active and s.planned == NoPlannedChange and isDowngrade(s.planKey, planKey)
pure def scheduleDowngrade(s: Subscription, commandId: str, planKey: PlanKey): Subscription = { ...s, planned: DowngradeAtRenewal({ planKey: planKey }), revision: s.revision + 1 }
pure def alwaysPlannedDowngradeIsLower(s: Subscription): bool = { val p = s.planned
  match p { | DowngradeAtRenewal(x) => isLive(s.status) and isDowngrade(s.planKey, x.planKey) | NoPlannedChange => true } }
pure def sometimesDowngradeScheduled(s: Subscription): bool = s.planned != NoPlannedChange
pure val eval_witness_sometimesDowngradeScheduled = (
  ("pinCustomer", "cus1"),
  ("claimCommand", CheckoutCommand, "cmd1", 1),
  ("checkoutPaid", "cmd1", "sub1", ProMonthly, "cus1"),
  ("reconcile", "sub1", ProviderActive, PeriodInvoicePaid, "in_1", ProMonthly, 0, 600000, false, 0),
  ("claimCommand", DowngradeCommand, "cmd2", 2),
  ("scheduleDowngrade", "cmd2", PlusMonthly)
)
```

### The revision grows by one with every change to the subscription, and limits change only with a policy change

Commands confirm against the revision. `PolicyChanged` advances the
organization's policy generation in the same transaction.

```quint
type ProviderView = { status: SubscriptionStatus, subscriptionId: str, planKey: PlanKey, periodStart: Millis, periodEnd: Millis, cancelAtPeriodEnd: bool, planned: PlannedChange, dunning: DunningWindow, lastRenewalInvoice: str }
pure def viewOf(s: Subscription): ProviderView = { status: s.status, subscriptionId: s.subscriptionId, planKey: s.planKey, periodStart: s.periodStart, periodEnd: s.periodEnd,
  cancelAtPeriodEnd: s.cancelAtPeriodEnd, planned: s.planned, dunning: s.dunning, lastRenewalInvoice: s.lastRenewalInvoice }
pure def stepRevisionCountsChanges(before: Subscription, after: Subscription): bool =
  after.revision == (if (viewOf(after) != viewOf(before)) before.revision + 1 else before.revision)
pure def stepPolicyFollowsTheSubscription(before: Subscription, after: Subscription, out: List[SubscriptionEffect]): bool =
  (hasPaidLimits(before.status) != hasPaidLimits(after.status) or isEntitled(before.status) != isEntitled(after.status) or before.planKey != after.planKey) implies out.includes(PolicyChanged)
```

## Story: Change my plan one command at a time

> As a subscriber, I want only one checkout, cancellation, undo or plan
> change running for my organization at a time, so that two screens never
> charge me twice or undo each other.

### A command starts only when no other command is live and the subscription allows it

A checkout needs the pinned customer and no live subscription. Every other command needs an Active
subscription at the revision its review read, with no pending downgrade; a
cancel needs one not already set to cancel, an undo one that is, and an
upgrade or a downgrade one that is not. The command's own spec adds its
remaining checks and frees the slot when it finishes.

```quint
pure def commandEligible(s: Subscription, kind: CommandKind, expectedRevision: int): bool =
  if (kind == CheckoutCommand) not(isLive(s.status)) and s.customer != NoCustomer
  else s.status == Active and s.revision == expectedRevision and s.planned == NoPlannedChange and (if (kind == UndoCommand) s.cancelAtPeriodEnd else not(s.cancelAtPeriodEnd))
pure def canClaimCommand(s: Subscription, kind: CommandKind, commandId: str, expectedRevision: int): bool = s.liveCommand == NoLiveCommand and commandId != "" and commandEligible(s, kind, expectedRevision)
pure def claimCommand(s: Subscription, kind: CommandKind, commandId: str, expectedRevision: int): Subscription = { ...s, liveCommand: Live({ kind: kind, commandId: commandId }) }
pure def canReleaseCommand(s: Subscription, commandId: str): bool = { val c = s.liveCommand
  match c { | Live(x) => commandId != "" and x.commandId == commandId | NoLiveCommand => false } }
pure def releaseCommand(s: Subscription, commandId: str): Subscription = { ...s, liveCommand: NoLiveCommand }
pure val commandIdValues = Set("cmd1", "cmd2")
pure val expectedRevisionValues = Set(1, 2, 3)
pure def alwaysLiveCommandFitsTheSubscription(s: Subscription): bool = { val c = s.liveCommand
  match c { | Live(x) => x.commandId != "" and (if (x.kind == CheckoutCommand) not(isLive(s.status)) and s.customer != NoCustomer else s.status != NoSubscription) | NoLiveCommand => true } }
pure def sometimesCancelRunning(s: Subscription): bool = holdsCommand(s, CancelCommand, "cmd1")
```

### The cancel control is eligible exactly when the cancel or undo it offers could start now

The billing snapshot's `subscription.control`
(`spec/cloud/billing/entitlements.md`) is this value: `offer` is rendered as
`action` (`cancel`, `undo` or `none`) and `expectedRevision` as
`expectedSubscriptionRevision`.

```quint
type ControlAction = CancelAction | UndoAction | NoAction
type CancelControl = { offer: ControlAction, eligible: bool, expectedRevision: int }
pure def controlOf(s: Subscription): CancelControl = {
  val offer = if (s.status != Active or s.planned != NoPlannedChange) NoAction else if (s.cancelAtPeriodEnd) UndoAction else CancelAction
  { offer: offer, eligible: offer != NoAction and s.liveCommand == NoLiveCommand, expectedRevision: s.revision }
}
pure def offeredKind(c: CancelControl): CommandKind = if (c.offer == UndoAction) UndoCommand else CancelCommand
pure def alwaysControlMatchesTheCommand(s: Subscription): bool = { val c = controlOf(s)
  c.eligible iff (c.offer != NoAction and canClaimCommand(s, offeredKind(c), "control", c.expectedRevision)) }
pure def sometimesUndoOffered(s: Subscription): bool = controlOf(s).offer == UndoAction and controlOf(s).eligible
```

## Story: Read my invoices and open the billing portal

> As a subscriber, I want to read my invoices and manage my payment method
> at the provider, so that I can check what I paid and keep my card current.

### Invoices are shown only when they belong to the organization's pinned customer

The list answers `{invoices: [{id, number, date, status, amountDueCents,
amountPaidCents, currency, hostedInvoiceUrl}], nextCursor}`; the detail adds
`lines`, `periodStart`, `periodEnd` and `pdfUrl`. An invoice of any other
customer, or any invoice before a customer is pinned, is `404 not_found`.

```quint
pure def invoiceVisible(s: Subscription, invoiceCustomerId: str): bool = s.customer != NoCustomer and customerIdOf(s) == invoiceCustomerId
```

### The billing portal opens only for the pinned customer and an owner with a fresh session

Fresh means sign-in or step-up at most 60 minutes ago, else `428
fresh_session_required`. Each call answers a new portal session's `{url}`.

```quint
pure def portalAllowed(s: Subscription, freshOwner: bool): bool = freshOwner and s.customer != NoCustomer
```
