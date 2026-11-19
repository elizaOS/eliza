# Subscription commands

Cancel, undo a cancellation, upgrade and downgrade: the four changes a
subscriber makes to a live subscription. One `Command` is one row: its
review, its one provider change (`spec/cloud/shared/dispatchOnce.md`) and its
outcome. A command holds the organization's one command slot
(`spec/cloud/billing/subscriptions.md`) from its confirmation until it ends;
the shell applies each `ClaimSlot`, `ScheduleDowngrade` and `ReleaseSlot`
effect to the subscription, and each `AdjustAllowance` to the open renewal
period (`spec/cloud/billing/allowance.md`), in the same transaction as the
step. Sources are develop `organization-{upgrade,downgrade}-*` and
`subscription-cancellation.ts` (rules only).

Provider calls, the answers' shapes and the person's session stay in the
shell. Every review, confirm and payment route is for an owner with a fresh
session (sign-in or step-up at most 60 minutes old), otherwise `428
fresh_session_required`; a guard that refuses because the subscription moved
is `409 stale_revision`, and one for any other subscription state is `409
billing_state_conflict`. After a provider reply the shell reconciles the live
subscription first (`reconcile` of `subscriptions.md`) and passes the
revision it leaves as `resultRevision`.

## Story: Review a plan change before I confirm it

> As a subscriber, I want to see what a plan change or an undo costs now and
> each month before I confirm it, so that I am never charged a price I did
> not see.

### A review quotes an upgrade, a downgrade or an undo of a live, active subscription with no command running

The upgrade answers `{quoteId, review: {kind: "upgrade_estimate",
targetPlanKey, dueNow: {amountDueCents}, recurringEstimate:
{amountDueCents}, effectiveAt, expiresAt}}`; a downgrade is
`downgrade_estimate`; an undo reads the next renewal. `dueNow` is the
provider's prorated invoice preview at the pinned proration instant, which
is the review time for an upgrade and the period end otherwise. A cancel
needs no review: it confirms against the cancel control of the billing
snapshot. A new review replaces an unconfirmed one.

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
import allowance as A from "./allowance"
import subscriptions as Sub from "./subscriptions"
import dispatchOnce as D from "../shared/dispatchOnce"
import sessions as S from "../../core/sessions"
type CommandPhase = NoCommand | Quoted | Running | AwaitingPayment | Applied | Failed
type QuoteTerms = { quoteId: str, sourcePlanKey: PlanKey, targetPlanKey: PlanKey, dueNowCents: int, recurringCents: int, reviewedAt: Millis, effectiveAt: Millis, expiresAt: Millis, periodStart: Millis, periodEnd: Millis, adjustment: Micros }
type Command = { phase: CommandPhase, kind: Sub::CommandKind, commandId: str, subscriptionId: str, expectedRevision: int, resultRevision: int, createdAt: Millis, quote: QuoteTerms, receipt: D::Receipt }
pure val noQuote: QuoteTerms = { quoteId: "", sourcePlanKey: Free, targetPlanKey: Free, dueNowCents: 0, recurringCents: 0, reviewedAt: 0, effectiveAt: 0, expiresAt: 0, periodStart: 0, periodEnd: 0, adjustment: 0 }
pure val initial: Command = { phase: NoCommand, kind: Sub::CancelCommand, commandId: "", subscriptionId: "", expectedRevision: 0, resultRevision: 0, createdAt: 0, quote: noQuote, receipt: D::initial }
pure val quoteLifetime: Millis = millisPerMinute
pure def nowOf(c: Command): Millis = c.receipt.session.now
pure def reviewFits(sub: Sub::Subscription, kind: Sub::CommandKind, targetPlanKey: PlanKey, dueNowCents: int): bool =
  if (kind == Sub::UpgradeCommand) isUpgrade(sub.planKey, targetPlanKey) and dueNowCents >= 0
  else if (kind == Sub::DowngradeCommand) isDowngrade(sub.planKey, targetPlanKey) and dueNowCents == 0
  else kind == Sub::UndoCommand and targetPlanKey == sub.planKey and dueNowCents == 0
pure def quoteOf(sub: Sub::Subscription, kind: Sub::CommandKind, targetPlanKey: PlanKey, quoteId: str, dueNowCents: int, now: Millis): QuoteTerms = {
  val effectiveAt = if (kind == Sub::UpgradeCommand) now else sub.periodEnd
  { quoteId: quoteId, sourcePlanKey: sub.planKey, targetPlanKey: targetPlanKey, dueNowCents: dueNowCents, recurringCents: amountCentsOf(targetPlanKey),
    reviewedAt: now, effectiveAt: effectiveAt, expiresAt: if (now + quoteLifetime < sub.periodEnd) now + quoteLifetime else sub.periodEnd,
    periodStart: sub.periodStart, periodEnd: sub.periodEnd, adjustment: A::upgradeAdjustment(sub.planKey, targetPlanKey, sub.periodStart, sub.periodEnd, effectiveAt) }
}
pure def canReview(c: Command, sub: Sub::Subscription, kind: Sub::CommandKind, targetPlanKey: PlanKey, quoteId: str, dueNowCents: int, freshOwner: bool): bool =
  freshOwner and (c.phase == NoCommand or c.phase == Quoted) and quoteId != "" and Sub::alwaysSubscriptionHasIdPlanAndCustomer(sub)
  and sub.liveCommand == Sub::NoLiveCommand and Sub::commandEligible(sub, kind, sub.revision) and reviewFits(sub, kind, targetPlanKey, dueNowCents)
  and nowOf(c) >= sub.periodStart and nowOf(c) < sub.periodEnd
pure def review(c: Command, sub: Sub::Subscription, kind: Sub::CommandKind, targetPlanKey: PlanKey, quoteId: str, dueNowCents: int, freshOwner: bool): Command =
  { ...c, phase: Quoted, kind: kind, subscriptionId: sub.subscriptionId, expectedRevision: sub.revision, quote: quoteOf(sub, kind, targetPlanKey, quoteId, dueNowCents, nowOf(c)) }
pure val subValues = Set({ ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: PlusMonthly, periodStart: 0, periodEnd: 2592000000, revision: 1 })
  .union(Set({ ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: ProMonthly, periodStart: 0, periodEnd: 2592000000, revision: 2 }))
  .union(Set({ ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: PlusMonthly, periodStart: 0, periodEnd: 2592000000, cancelAtPeriodEnd: true, revision: 3 }))
pure val kindValues = Set(Sub::CancelCommand, Sub::UndoCommand, Sub::UpgradeCommand, Sub::DowngradeCommand)
pure val quoteIdValues = Set("", "q1")
pure val dueNowCentsValues = Set(0, 4667)
pure def sometimesQuoteExpiredUnconfirmed(c: Command): bool = c.phase == Quoted and nowOf(c) >= c.quote.expiresAt
```

### An upgrade quote moves up a plan and adds exactly the allowance difference left in the period; a downgrade or undo takes effect at the period end

The quote is good for 60 seconds, and never past the period end. Its
allowance adjustment is `upgradeAdjustment` of `allowance.md` at the
proration instant, and zero for a downgrade or an undo.

```quint
pure def quoteFits(kind: Sub::CommandKind, q: QuoteTerms): bool =
  q.expiresAt <= q.reviewedAt + quoteLifetime and q.recurringCents == amountCentsOf(q.targetPlanKey)
  and q.adjustment == A::upgradeAdjustment(q.sourcePlanKey, q.targetPlanKey, q.periodStart, q.periodEnd, q.effectiveAt)
  and (if (kind == Sub::UpgradeCommand) isUpgrade(q.sourcePlanKey, q.targetPlanKey) and q.effectiveAt == q.reviewedAt and q.dueNowCents >= 0
       else if (kind == Sub::DowngradeCommand) isDowngrade(q.sourcePlanKey, q.targetPlanKey) and q.effectiveAt == q.periodEnd and q.dueNowCents == 0
       else kind == Sub::UndoCommand and q.targetPlanKey == q.sourcePlanKey and q.effectiveAt == q.periodEnd and q.dueNowCents == 0)
pure def alwaysQuoteIsTheReviewedEstimate(c: Command): bool = c.quote.quoteId != "" implies quoteFits(c.kind, c.quote)
```

## Story: Change or cancel my plan without paying twice

> As a subscriber, I want each confirmed change sent to the payment provider
> once, and only while what I reviewed still holds, so that two screens or a
> lost reply never charge me twice.

### A command starts only while its quote holds, the subscription is at the reviewed revision and no other command is live

Confirming claims the subscription's command slot and prepares and claims
one receipt in one transaction, before the provider is asked. Cancel, undo
and upgrade are one subscription update, a downgrade one subscription
schedule; each is keyed by the command id and found stale five minutes after
its claim. An upgrade update is sent with `payment_behavior:
pending_if_incomplete`, `proration_behavior: always_invoice` and the quote's
proration instant.

```quint
type CommandEffect = ClaimSlot({ kind: Sub::CommandKind, commandId: str, expectedRevision: int }) | ReleaseSlot({ commandId: str })
  | ScheduleDowngrade({ commandId: str, planKey: PlanKey }) | AdjustAllowance({ planKey: PlanKey, effectiveAt: Millis, reviewed: Micros })
type CommandStep = { state: Command, out: List[CommandEffect] }
pure val commandStaleAfter: Millis = 5 * millisPerMinute
pure val commandLifetime: Millis = millisPerDay
pure def isChange(kind: Sub::CommandKind): bool = kind != Sub::CheckoutCommand
pure def providerKeyOf(kind: Sub::CommandKind, commandId: str): ProviderKey =
  { providerKind: if (kind == Sub::DowngradeCommand) SubscriptionSchedule else SubscriptionUpdate, providerId: commandId }
pure def preparedFor(c: Command, by: S::SessionOwner, kind: Sub::CommandKind, commandId: str, digest: str): D::Receipt =
  D::prepare(c.receipt, by, digest, providerKeyOf(kind, commandId), commandStaleAfter, nowOf(c) + commandLifetime)
pure def startsFromReview(c: Command, sub: Sub::Subscription, kind: Sub::CommandKind, quoteId: str, expectedRevision: int): bool =
  if (kind == Sub::CancelCommand) c.phase == NoCommand and quoteId == ""
  else c.phase == Quoted and c.kind == kind and c.quote.quoteId == quoteId and c.expectedRevision == expectedRevision and nowOf(c) < c.quote.expiresAt
    and sub.subscriptionId == c.subscriptionId and sub.planKey == c.quote.sourcePlanKey and sub.periodStart == c.quote.periodStart and sub.periodEnd == c.quote.periodEnd
pure def canConfirm(c: Command, by: S::SessionOwner, sub: Sub::Subscription, kind: Sub::CommandKind, commandId: str, quoteId: str, expectedRevision: int, digest: str, freshOwner: bool): bool =
  freshOwner and isChange(kind) and expectedRevision >= 1 and Sub::alwaysSubscriptionHasIdPlanAndCustomer(sub)
  and startsFromReview(c, sub, kind, quoteId, expectedRevision) and Sub::canClaimCommand(sub, kind, commandId, expectedRevision)
  and D::canPrepare(c.receipt, by, digest, providerKeyOf(kind, commandId), commandStaleAfter, nowOf(c) + commandLifetime)
  and D::canClaim(preparedFor(c, by, kind, commandId, digest), by)
pure def confirm(c: Command, by: S::SessionOwner, sub: Sub::Subscription, kind: Sub::CommandKind, commandId: str, quoteId: str, expectedRevision: int, digest: str, freshOwner: bool): CommandStep =
  { state: { ...c, phase: Running, kind: kind, commandId: commandId, subscriptionId: sub.subscriptionId, expectedRevision: expectedRevision, createdAt: nowOf(c),
      receipt: D::claim(preparedFor(c, by, kind, commandId, digest), by) },
    out: List(ClaimSlot({ kind: kind, commandId: commandId, expectedRevision: expectedRevision })) }
pure val byValues = Set({ agentId: "org1", actorId: "user1", connector: "subscription_update" }, { agentId: "org1", actorId: "user1", connector: "subscription_schedule" })
pure val commandIdValues = Set("cmd1")
pure val expectedRevisionValues = Set(1, 2, 3)
pure def stepConfirmedWithinAMinuteOfTheReview(before: Command, via: str, after: Command): bool =
  (via == "confirm" and after.kind != Sub::CancelCommand) implies (nowOf(before) < after.quote.expiresAt and after.quote.expiresAt <= after.quote.reviewedAt + quoteLifetime)
```

### A started command keeps its kind, subscription, revision and quote, and only a confirmed cancel has no quote

```quint
pure def isStarted(c: Command): bool = c.phase != NoCommand and c.phase != Quoted
pure def isFinished(c: Command): bool = c.phase == Applied or c.phase == Failed
pure def alwaysCommandIsWellFormed(c: Command): bool =
  (c.phase == NoCommand implies (c.quote == noQuote and c.commandId == ""))
  and (c.phase == Quoted implies (c.commandId == "" and c.subscriptionId != "" and c.quote.quoteId != ""))
  and (isStarted(c) implies (c.commandId != "" and c.subscriptionId != "" and c.expectedRevision >= 1 and isChange(c.kind)
    and (if (c.kind == Sub::CancelCommand) c.quote == noQuote else c.quote.quoteId != "")))
pure def stepStartedCommandIsFixed(before: Command, after: Command): bool =
  isStarted(before) implies (after.kind == before.kind and after.commandId == before.commandId and after.subscriptionId == before.subscriptionId
    and after.expectedRevision == before.expectedRevision and after.createdAt == before.createdAt and after.quote == before.quote
    and (isFinished(before) implies (after.phase == before.phase and after.resultRevision == before.resultRevision)))
```

### The provider is asked once, by the claim holder, and a lost reply is recovered by a lookup, never by sending again

The receipt keeps every rule of `dispatchOnce.md`. The shell's sweep looks
up an unknown outcome by the command id.

```quint
pure def canSend(c: Command, by: S::SessionOwner, claimToken: int): bool = c.phase == Running and D::canSend(c.receipt, by, claimToken)
pure def send(c: Command, by: S::SessionOwner, claimToken: int): Command = { ...c, receipt: D::send(c.receipt, by, claimToken) }
pure def canReceiveReply(c: Command, reply: D::ProviderReply): bool = c.phase == Running and D::canReceiveReply(c.receipt, reply)
pure def receiveReply(c: Command, reply: D::ProviderReply): Command = { ...c, receipt: D::receiveReply(c.receipt, reply) }
pure def canLoseExecutor(c: Command): bool = c.phase == Running and D::canLoseExecutor(c.receipt)
pure def loseExecutor(c: Command): Command = { ...c, receipt: D::loseExecutor(c.receipt) }
pure def canResolve(c: Command, lookup: D::LookupResult): bool = c.phase == Running and D::canResolve(c.receipt, lookup)
pure def resolve(c: Command, lookup: D::LookupResult): Command = { ...c, receipt: D::resolve(c.receipt, lookup) }
pure def canElapse(c: Command, elapsed: Millis): bool = D::canElapse(c.receipt, elapsed)
pure def elapse(c: Command, elapsed: Millis): Command = { ...c, receipt: D::elapse(c.receipt, elapsed) }
pure val elapsedValues = Set(1000, 60000, 300000)
pure def alwaysReceiptIsSound(c: Command): bool =
  D::alwaysPreparedIsBound(c.receipt) and D::alwaysSessionIsSound(c.receipt) and D::alwaysSentBeforeStale(c.receipt) and D::alwaysOutcomeFollowsTheSession(c.receipt)
  and ((c.receipt.session.phase == S::Absent) iff not(isStarted(c)))
  and (isStarted(c) implies c.receipt.providerKey == providerKeyOf(c.kind, c.commandId))
pure def stepReceiptKeepsItsRules(before: Command, via: str, after: Command): bool =
  D::stepBindingIsFixed(before.receipt, after.receipt) and D::stepCommitNeverReopens(before.receipt, after.receipt) and D::stepStaleTimeIsFixed(before.receipt, after.receipt)
  and D::stepSettledIsFinal(before.receipt, after.receipt) and D::stepUnknownSettlesOnlyByLookup(before.receipt, via, after.receipt)
pure def sometimesOutcomeUnknown(c: Command): bool = c.phase == Running and D::isUnknown(c.receipt)
```

## Story: Get the plan I paid for

> As a subscriber, I want an upgrade applied as soon as its invoice is paid,
> a downgrade at my next renewal and a cancel or undo at once, so that my
> plan and allowance match what I paid.

### A settled command applies only what the provider did, and an upgrade applies only once its invoice is paid

A refused or not applied change fails. An upgrade's invoice is paid (the
command applies now), open (the command awaits payment and keeps the slot)
or voided (it fails). An applied upgrade adds the quoted allowance
difference; an applied downgrade schedules the lower plan for the next paid
renewal while the command still holds the slot. The shell finishes a settled
command in the transaction that settles it.

```quint
type UpgradeInvoice = NoUpgradeInvoice | UpgradeInvoicePaid | UpgradeInvoiceOpen | UpgradeInvoiceVoided
pure def awaitsInvoice(c: Command): bool = c.kind == Sub::UpgradeCommand and c.receipt.settlement == D::Succeeded
pure def outcomeOf(c: Command, invoice: UpgradeInvoice): CommandPhase =
  if (c.receipt.settlement != D::Succeeded) Failed
  else if (c.kind != Sub::UpgradeCommand or invoice == UpgradeInvoicePaid) Applied
  else if (invoice == UpgradeInvoiceOpen) AwaitingPayment
  else Failed
pure def canFinish(c: Command, invoice: UpgradeInvoice, resultRevision: int): bool =
  ((c.phase == Running and c.receipt.settlement != D::Unsettled and ((invoice == NoUpgradeInvoice) iff not(awaitsInvoice(c))))
    or (c.phase == AwaitingPayment and (invoice == UpgradeInvoicePaid or invoice == UpgradeInvoiceVoided)))
  and (if (outcomeOf(c, invoice) == Applied) resultRevision >= c.expectedRevision else resultRevision == 0)
pure def finish(c: Command, invoice: UpgradeInvoice, resultRevision: int): CommandStep = {
  val ending = outcomeOf(c, invoice)
  { state: { ...c, phase: ending, resultRevision: resultRevision },
    out: (if (ending == Applied and c.kind == Sub::UpgradeCommand) List(AdjustAllowance({ planKey: c.quote.targetPlanKey, effectiveAt: c.quote.effectiveAt, reviewed: c.quote.adjustment })) else List())
      .concat(if (ending == Applied and c.kind == Sub::DowngradeCommand) List(ScheduleDowngrade({ commandId: c.commandId, planKey: c.quote.targetPlanKey })) else List())
      .concat(if (ending != AwaitingPayment) List(ReleaseSlot({ commandId: c.commandId })) else List()) }
}
pure val resultRevisionValues = Set(0, 1, 2, 3, 4)
pure def alwaysOutcomeFollowsTheReceipt(c: Command): bool =
  ((c.phase == Applied or c.phase == AwaitingPayment) implies c.receipt.settlement == D::Succeeded)
  and (c.phase == Failed implies c.receipt.settlement != D::Unsettled)
  and ((c.phase == AwaitingPayment or (c.phase == Failed and c.receipt.settlement == D::Succeeded)) implies c.kind == Sub::UpgradeCommand)
  and (if (c.phase == Applied) c.resultRevision >= c.expectedRevision else c.resultRevision == 0)
pure def sometimesCancelApplied(c: Command): bool = c.kind == Sub::CancelCommand and c.phase == Applied
pure def sometimesUndoApplied(c: Command): bool = c.kind == Sub::UndoCommand and c.phase == Applied
pure def sometimesUpgradeAwaitingPayment(c: Command): bool = c.phase == AwaitingPayment
pure def sometimesUpgradePaidAfterWaiting(c: Command): bool = c.kind == Sub::UpgradeCommand and c.phase == Applied and c.receipt.session.now > c.receipt.settledAt
pure def sometimesUpgradeInvoiceVoided(c: Command): bool = c.phase == Failed and c.receipt.settlement == D::Succeeded
pure def sometimesDowngradeScheduled(c: Command): bool = c.kind == Sub::DowngradeCommand and c.phase == Applied
pure def sometimesRefusedByTheProvider(c: Command): bool = c.phase == Failed and c.receipt.settlement == D::Refused
```

### A command holds the slot from its confirmation until it ends, and every effect names it

```quint
pure def holdsSlot(c: Command): bool = c.phase == Running or c.phase == AwaitingPayment
pure def isSlotClaim(e: CommandEffect): bool = match e { | ClaimSlot(x) => true | _ => false }
pure def isSlotRelease(e: CommandEffect): bool = match e { | ReleaseSlot(x) => true | _ => false }
pure def namesCommand(c: Command, e: CommandEffect): bool = match e {
  | ClaimSlot(x) => x.commandId == c.commandId and x.kind == c.kind and x.expectedRevision == c.expectedRevision
  | ReleaseSlot(x) => x.commandId == c.commandId
  | ScheduleDowngrade(x) => x.commandId == c.commandId
  | AdjustAllowance(x) => true
}
pure def stepSlotFollowsTheCommand(before: Command, after: Command, out: List[CommandEffect]): bool =
  ((not(holdsSlot(before)) and holdsSlot(after)) iff out.some(e => isSlotClaim(e)))
  and ((holdsSlot(before) and not(holdsSlot(after))) iff out.some(e => isSlotRelease(e)))
  and out.every(e => namesCommand(after, e))
```

### The allowance grows once, by the quoted amount, when a paid upgrade applies

```quint
pure def isAdjustment(e: CommandEffect): bool = match e { | AdjustAllowance(x) => true | _ => false }
pure def adjustsAsQuoted(c: Command, e: CommandEffect): bool = match e {
  | AdjustAllowance(x) => x.planKey == c.quote.targetPlanKey and x.effectiveAt == c.quote.effectiveAt
      and x.reviewed == A::upgradeAdjustment(c.quote.sourcePlanKey, c.quote.targetPlanKey, c.quote.periodStart, c.quote.periodEnd, c.quote.effectiveAt)
  | _ => true
}
pure def stepAllowanceAdjustedOnceByAPaidUpgrade(before: Command, after: Command, out: List[CommandEffect]): bool =
  (out.some(e => isAdjustment(e)) iff (after.kind == Sub::UpgradeCommand and before.phase != Applied and after.phase == Applied))
  and out.every(e => adjustsAsQuoted(after, e))
```

### A downgrade is scheduled once, for the quoted plan, before the command frees the slot

```quint
pure def isSchedule(e: CommandEffect): bool = match e { | ScheduleDowngrade(x) => true | _ => false }
pure def schedulesAsQuoted(c: Command, e: CommandEffect): bool = match e { | ScheduleDowngrade(x) => x.planKey == c.quote.targetPlanKey | _ => true }
pure def stepDowngradeScheduledOnApply(before: Command, after: Command, out: List[CommandEffect]): bool =
  (out.some(e => isSchedule(e)) iff (after.kind == Sub::DowngradeCommand and before.phase != Applied and after.phase == Applied))
  and out.every(e => schedulesAsQuoted(after, e))
  and (out.some(e => isSchedule(e)) implies isSchedule(out.nthOr(0, ReleaseSlot({ commandId: "" }))))
```

### An upgrade awaiting payment offers the provider's hosted invoice, to a fresh owner only

`POST /upgrade/:commandId/payment` answers `{url}`, the open invoice's
hosted page on the provider's host.

```quint
pure def mayContinuePayment(c: Command, freshOwner: bool): bool = freshOwner and c.phase == AwaitingPayment
```

## Story: See my commands

> As a subscriber, I want to see each change I confirmed and how it ended,
> so that I know whether my plan changed.

### A command's status is read from its phase and its receipt, and an unconfirmed review is not listed

`GET /api/v1/subscriptions/commands?limit&cursor` answers `{observedAt,
items: [{commandId, kind, subscriptionId, status, expectedRevision,
resultRevision, createdAt}], nextCursor}`, newest first, with the statuses
`dispatched`, `unknown`, `awaiting_payment`, `succeeded` and `rejected`; a
`resultRevision` of 0 is `null`. `GET /{upgrade,downgrade}/:commandId`
answers one item, and a command of another organization is `404 not_found`.

```quint
type CommandStatus = NotListed | ShowDispatched | ShowUnknown | ShowAwaitingPayment | ShowSucceeded | ShowRejected
pure def commandStatus(c: Command): CommandStatus =
  if (not(isStarted(c))) NotListed
  else if (c.phase == Applied) ShowSucceeded
  else if (c.phase == Failed) ShowRejected
  else if (c.phase == AwaitingPayment) ShowAwaitingPayment
  else if (D::isUnknown(c.receipt)) ShowUnknown
  else ShowDispatched
```
