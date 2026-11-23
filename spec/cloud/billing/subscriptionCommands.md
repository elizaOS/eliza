# Subscription commands

Cancel, undo a cancellation, upgrade and downgrade of a live subscription.
One `Command` is one row with its review, required provider operations
(`spec/cloud/shared/dispatchOnce.md`) and outcome. In the step's
transaction the shell applies `ClaimSlot`, `ScheduleDowngrade` and
`ReleaseSlot` to the subscription (`spec/cloud/billing/subscriptions.md`) and
`AdjustAllowance` to the open renewal period
(`spec/cloud/billing/allowance.md`). Sources are develop
`organization-{upgrade,downgrade}-*` and `subscription-cancellation.ts`.

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
snapshot. A new review replaces an unconfirmed one. A downgrade review
records whether the provider subscription already has an exact compatible
schedule. The shell checks the subscription, customer, mode and current
phase before admitting that schedule.

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
import allowance as A from "./allowance"
import subscriptions as Sub from "./subscriptions"
import dispatchOnce as D from "../shared/dispatchOnce"
import sessions as S from "../../core/sessions"
type CommandPhase = NoCommand | Quoted | Running | AwaitingPayment | Applied | Failed
type QuoteTerms = { quoteId: str, sourcePlanKey: PlanKey, targetPlanKey: PlanKey, dueNowCents: int, recurringCents: int, reviewedAt: Millis, effectiveAt: Millis, expiresAt: Millis, periodStart: Millis, periodEnd: Millis, adjustment: Micros }
type AttachmentEvidence = OriginalAttachment | CompatibleSchedule
type ScheduleReview = NoAttachedSchedule | ExistingSchedule({ scheduleId: str })
type ScheduleWork = NoScheduleWork | ScheduleReviewPending | ReviewedUnscheduled | ReviewedExisting({ scheduleId: str })
  | Attaching({ receipt: D::Receipt }) | ScheduleVerified({ receipt: D::Receipt, scheduleId: str, evidence: AttachmentEvidence })
type Command = { phase: CommandPhase, kind: Sub::CommandKind, commandId: str, subscriptionId: str, expectedRevision: int, resultRevision: int, createdAt: Millis, quote: QuoteTerms, receipt: D::Receipt, schedule: ScheduleWork }
pure val noQuote: QuoteTerms = { quoteId: "", sourcePlanKey: Free, targetPlanKey: Free, dueNowCents: 0, recurringCents: 0, reviewedAt: 0, effectiveAt: 0, expiresAt: 0, periodStart: 0, periodEnd: 0, adjustment: 0 }
pure val initial: Command = { phase: NoCommand, kind: Sub::CancelCommand, commandId: "", subscriptionId: "", expectedRevision: 0, resultRevision: 0, createdAt: 0, quote: noQuote, receipt: D::initial, schedule: NoScheduleWork }
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
  { ...c, phase: Quoted, kind: kind, subscriptionId: sub.subscriptionId, expectedRevision: sub.revision, quote: quoteOf(sub, kind, targetPlanKey, quoteId, dueNowCents, nowOf(c)),
    schedule: if (kind == Sub::DowngradeCommand) ScheduleReviewPending else NoScheduleWork }
pure def canRecordScheduleReview(c: Command, observed: ScheduleReview): bool =
  c.phase == Quoted and c.schedule == ScheduleReviewPending and (match observed {
    | NoAttachedSchedule => true
    | ExistingSchedule(x) => x.scheduleId != ""
  })
pure def recordScheduleReview(c: Command, observed: ScheduleReview): Command =
  { ...c, schedule: match observed {
    | NoAttachedSchedule => ReviewedUnscheduled
    | ExistingSchedule(x) => ReviewedExisting({ scheduleId: x.scheduleId })
  } }
pure val observedValues = Set(NoAttachedSchedule, ExistingSchedule({ scheduleId: "sched1" }))
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

Confirming claims the subscription's command slot and the first required
provider operation in one transaction. Cancel, undo and upgrade each need
one subscription update. A downgrade with a verified schedule prepares
configuration directly. Stripe requires an unscheduled subscription to
attach a schedule first and configure it separately. Each operation has
its own key and becomes stale five minutes after its own claim. An upgrade
uses `payment_behavior=pending_if_incomplete`, `proration_behavior=always_invoice`
and the quote's proration instant.

```quint
type CommandEffect = ClaimSlot({ kind: Sub::CommandKind, commandId: str, expectedRevision: int }) | ReleaseSlot({ commandId: str })
  | ScheduleDowngrade({ commandId: str, planKey: PlanKey }) | AdjustAllowance({ planKey: PlanKey, effectiveAt: Millis, reviewed: Micros })
type CommandStep = { state: Command, out: List[CommandEffect] }
pure val commandStaleAfter: Millis = 5 * millisPerMinute
pure val commandLifetime: Millis = millisPerDay
pure def isChange(kind: Sub::CommandKind): bool = kind != Sub::CheckoutCommand
pure def providerKeyOf(kind: Sub::CommandKind, commandId: str): ProviderKey =
  { providerKind: if (kind == Sub::DowngradeCommand) SubscriptionSchedule else SubscriptionUpdate, providerId: commandId }
pure def attachmentKeyOf(attachmentProviderId: str): ProviderKey =
  { providerKind: SubscriptionSchedule, providerId: attachmentProviderId }
pure def needsAttachment(c: Command, kind: Sub::CommandKind): bool =
  kind == Sub::DowngradeCommand and c.schedule == ReviewedUnscheduled
pure def scheduleReady(c: Command): bool = {
  val work = c.schedule
  match work {
    | ReviewedExisting(_) => true
    | ScheduleVerified(_) => true
    | _ => false
  }
}
pure def firstKeyOf(c: Command, kind: Sub::CommandKind, commandId: str, attachmentProviderId: str): ProviderKey =
  if (needsAttachment(c, kind)) attachmentKeyOf(attachmentProviderId) else providerKeyOf(kind, commandId)
pure def preparedFor(c: Command, by: S::SessionOwner, kind: Sub::CommandKind, commandId: str, attachmentProviderId: str, digest: str): D::Receipt =
  D::prepare(c.receipt, by, digest, firstKeyOf(c, kind, commandId, attachmentProviderId), commandStaleAfter, nowOf(c) + commandLifetime)
pure def startsFromReview(c: Command, sub: Sub::Subscription, kind: Sub::CommandKind, quoteId: str, expectedRevision: int): bool =
  if (kind == Sub::CancelCommand) c.phase == NoCommand and quoteId == ""
  else c.phase == Quoted and c.kind == kind and c.quote.quoteId == quoteId and c.expectedRevision == expectedRevision and nowOf(c) < c.quote.expiresAt
    and sub.subscriptionId == c.subscriptionId and sub.planKey == c.quote.sourcePlanKey and sub.periodStart == c.quote.periodStart and sub.periodEnd == c.quote.periodEnd
    and (kind != Sub::DowngradeCommand or needsAttachment(c, kind) or scheduleReady(c))
pure def canConfirm(c: Command, by: S::SessionOwner, sub: Sub::Subscription, kind: Sub::CommandKind, commandId: str, quoteId: str, expectedRevision: int, attachmentProviderId: str, digest: str, freshOwner: bool): bool =
  freshOwner and isChange(kind) and expectedRevision >= 1 and Sub::alwaysSubscriptionHasIdPlanAndCustomer(sub)
  and startsFromReview(c, sub, kind, quoteId, expectedRevision) and Sub::canClaimCommand(sub, kind, commandId, expectedRevision)
  and (if (needsAttachment(c, kind)) attachmentProviderId != "" and attachmentProviderId != commandId else attachmentProviderId == "")
  and D::canPrepare(c.receipt, by, digest, firstKeyOf(c, kind, commandId, attachmentProviderId), commandStaleAfter, nowOf(c) + commandLifetime)
  and D::canClaim(preparedFor(c, by, kind, commandId, attachmentProviderId, digest), by)
pure def confirm(c: Command, by: S::SessionOwner, sub: Sub::Subscription, kind: Sub::CommandKind, commandId: str, quoteId: str, expectedRevision: int, attachmentProviderId: str, digest: str, freshOwner: bool): CommandStep =
  {
    val first = D::claim(preparedFor(c, by, kind, commandId, attachmentProviderId, digest), by)
    val attach = needsAttachment(c, kind)
    { state: { ...c, phase: Running, kind: kind, commandId: commandId, subscriptionId: sub.subscriptionId, expectedRevision: expectedRevision, createdAt: nowOf(c),
        receipt: if (attach) c.receipt else first,
        schedule: if (attach) Attaching({ receipt: first }) else c.schedule },
      out: List(ClaimSlot({ kind: kind, commandId: commandId, expectedRevision: expectedRevision })) }
  }
pure val byValues = Set({ agentId: "org1", actorId: "user1", connector: "subscription_update" }, { agentId: "org1", actorId: "user1", connector: "subscription_schedule" })
pure val commandIdValues = Set("cmd1")
pure val attachmentProviderIdValues = Set("", "cmd1", "cmd1:attach")
pure val expectedRevisionValues = Set(1, 2, 3)
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

### Downgrade configuration needs the verified schedule and its own claim

An attachment alone does not schedule or bill the lower plan. The shell
looks up the exact original attachment when its reply is lost. A compatible
schedule found on the same reviewed subscription can be used after its
subscription, customer, mode and current phase are verified. Its existence
does not prove who created it. Configuration keeps the current phase and
sets the reviewed lower plan at the paid period boundary. The same command
keeps the slot between operations.

```quint
pure def attachmentReceipt(c: Command): D::Receipt = {
  val work = c.schedule
  match work {
    | Attaching(x) => x.receipt
    | ScheduleVerified(x) => x.receipt
    | _ => D::initial
  }
}
pure def attaching(c: Command): bool = {
  val work = c.schedule
  match work {
    | Attaching(_) => c.phase == Running
    | _ => false
  }
}
pure def withAttachment(receipt: D::Receipt, c: Command): Command = { ...c, schedule: Attaching({ receipt: receipt }) }
pure def canSendAttachment(c: Command, by: S::SessionOwner, claimToken: int): bool =
  attaching(c) and D::canSend(attachmentReceipt(c), by, claimToken)
pure def sendAttachment(c: Command, by: S::SessionOwner, claimToken: int): Command =
  withAttachment(D::send(attachmentReceipt(c), by, claimToken), c)
pure def canReceiveAttachmentReply(c: Command, reply: D::ProviderReply): bool =
  attaching(c) and D::canReceiveReply(attachmentReceipt(c), reply)
pure def receiveAttachmentReply(c: Command, reply: D::ProviderReply): Command =
  withAttachment(D::receiveReply(attachmentReceipt(c), reply), c)
pure def canResolveAttachment(c: Command, lookup: D::LookupResult): bool =
  attaching(c) and D::canResolve(attachmentReceipt(c), lookup)
pure def resolveAttachment(c: Command, lookup: D::LookupResult): Command =
  withAttachment(D::resolve(attachmentReceipt(c), lookup), c)
pure def canVerifySchedule(c: Command, scheduleId: str, evidence: AttachmentEvidence): bool =
  attaching(c) and scheduleId != "" and attachmentReceipt(c).session.effects == 1 and
  (if (evidence == OriginalAttachment) attachmentReceipt(c).settlement == D::Succeeded
   else D::isUnknown(attachmentReceipt(c)))
pure def verifySchedule(c: Command, scheduleId: str, evidence: AttachmentEvidence): Command =
  { ...c, schedule: ScheduleVerified({ receipt: attachmentReceipt(c), scheduleId: scheduleId, evidence: evidence }) }
pure def configurationFor(c: Command, by: S::SessionOwner, digest: str): D::Receipt =
  D::prepare(c.receipt, by, digest, providerKeyOf(c.kind, c.commandId), commandStaleAfter, nowOf(c) + commandLifetime)
pure def waitingForConfiguration(c: Command): bool = {
  val work = c.schedule
  match work {
    | ScheduleVerified(_) => c.receipt.session.phase == S::Absent
    | _ => false
  }
}
pure def canClaimConfiguration(c: Command, by: S::SessionOwner, digest: str): bool =
  c.phase == Running and waitingForConfiguration(c) and attachmentReceipt(c).session.owner == by
  and nowOf(c) < c.quote.periodEnd
  and D::canPrepare(c.receipt, by, digest, providerKeyOf(c.kind, c.commandId), commandStaleAfter, nowOf(c) + commandLifetime)
  and D::canClaim(configurationFor(c, by, digest), by)
pure def claimConfiguration(c: Command, by: S::SessionOwner, digest: str): Command =
  { ...c, receipt: D::claim(configurationFor(c, by, digest), by) }
pure def expiredConfiguration(c: Command): bool = waitingForConfiguration(c) and nowOf(c) >= c.quote.periodEnd
pure def canExpireConfiguration(c: Command): bool = c.phase == Running and expiredConfiguration(c)
pure def expireConfiguration(c: Command): CommandStep =
  { state: { ...c, phase: Failed }, out: List(ReleaseSlot({ commandId: c.commandId })) }
pure val scheduleIdValues = Set("", "sched1")
pure val evidenceValues = Set(OriginalAttachment, CompatibleSchedule)
pure def alwaysConfigurationWaitsForItsSchedule(c: Command): bool =
  c.kind == Sub::DowngradeCommand and c.receipt.session.phase != S::Absent implies scheduleReady(c)
pure def alwaysVerifiedAttachmentKeepsItsOrigin(c: Command): bool = {
  val work = c.schedule
  match work {
    | ScheduleVerified(x) => x.scheduleId != "" and x.receipt.session.effects == 1 and
      (if (x.evidence == OriginalAttachment) x.receipt.settlement == D::Succeeded else x.receipt.settlement == D::Unsettled)
    | _ => true
  }
}
pure def sometimesAttachmentRecovered(c: Command): bool = {
  val work = c.schedule
  match work {
    | ScheduleVerified(x) => x.evidence == OriginalAttachment and x.receipt.settlement == D::Succeeded
    | _ => false
  }
}
pure def sometimesCompatibleScheduleUsed(c: Command): bool = {
  val work = c.schedule
  match work {
    | ScheduleVerified(x) => x.evidence == CompatibleSchedule
    | _ => false
  }
}
```

### The provider is asked once, by the claim holder, and a lost reply is recovered by a lookup, never by sending again

Each required operation keeps its own receipt under `dispatchOnce.md`.
The shell records an operation's send before contacting the provider and
looks up an unknown result by that operation's key. A committed attachment
or configuration is never sent again.

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
pure val eval_refuse_canElapse = { elapsed: -1 }
pure def elapse(c: Command, elapsed: Millis): Command = {
  val work = c.schedule
  { ...c, receipt: D::elapse(c.receipt, elapsed), schedule: match work {
    | Attaching(x) => Attaching({ receipt: D::elapse(x.receipt, elapsed) })
    | ScheduleVerified(x) => ScheduleVerified({ ...x, receipt: D::elapse(x.receipt, elapsed) })
    | _ => work
  } }
}
pure val elapsedValues = Set(1000, 60000, 300000, 30 * millisPerDay)
pure def soundReceipt(r: D::Receipt): bool =
  D::alwaysPreparedIsBound(r) and D::alwaysSessionIsSound(r) and D::alwaysSentBeforeStale(r) and D::alwaysOutcomeFollowsTheSession(r)
pure def alwaysReceiptIsSound(c: Command): bool =
  soundReceipt(c.receipt) and soundReceipt(attachmentReceipt(c))
  and ((c.receipt.session.phase != S::Absent or attachmentReceipt(c).session.phase != S::Absent) iff isStarted(c))
  and (c.receipt.session.phase != S::Absent implies D::usesProviderKey(c.receipt, providerKeyOf(c.kind, c.commandId)))
  and (attachmentReceipt(c).session.phase != S::Absent implies
    (c.kind == Sub::DowngradeCommand and attachmentReceipt(c).providerKey.providerKind == SubscriptionSchedule
      and attachmentReceipt(c).providerKey.providerId != "" and attachmentReceipt(c).providerKey.providerId != c.commandId))
pure def keepsReceipt(before: D::Receipt, via: str, after: D::Receipt): bool =
  D::stepBindingIsFixed(before, after) and D::stepCommitNeverReopens(before, after) and D::stepStaleTimeIsFixed(before, after)
  and D::stepSettledIsFinal(before, after) and D::stepUnknownSettlesOnlyByLookup(before, via, after)
pure def stepReceiptKeepsItsRules(before: Command, via: str, after: Command): bool =
  keepsReceipt(before.receipt, via, after.receipt)
  and keepsReceipt(attachmentReceipt(before), if (via == "resolveAttachment") "resolve" else "attachment", attachmentReceipt(after))
pure def sometimesOutcomeUnknown(c: Command): bool = c.phase == Running and (D::isUnknown(c.receipt) or D::isUnknown(attachmentReceipt(c)))
```

## Story: Get the plan I paid for

> As a subscriber, I want an upgrade applied as soon as its invoice is paid,
> a downgrade at my next renewal and a cancel or undo at once, so that my
> plan and allowance match what I paid.

### A settled command applies only what the provider did, and an upgrade applies only once its invoice is paid

A refused or not applied change fails. An attachment refusal releases the
slot without scheduling a change. If the period ends before configuration
is claimed, the command can end without a configuration send. An upgrade's invoice is paid (the
command applies now), open (the command awaits payment and keeps the slot)
or voided (it fails); while it awaits payment, a fresh owner's `POST
/upgrade/:commandId/payment` answers `{url}`, the open invoice's hosted page
on the provider's host. An applied upgrade adds the quoted allowance
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
pure def attachmentFailed(c: Command): bool =
  attachmentReceipt(c).settlement == D::Refused or attachmentReceipt(c).settlement == D::NotApplied
pure def canFinish(c: Command, invoice: UpgradeInvoice, resultRevision: int): bool =
  ((c.phase == Running and (c.receipt.settlement != D::Unsettled or (attaching(c) and attachmentFailed(c)))
    and ((invoice == NoUpgradeInvoice) iff not(awaitsInvoice(c))))
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
pure def mayContinuePayment(c: Command, freshOwner: bool): bool = freshOwner and c.phase == AwaitingPayment
pure def alwaysOutcomeFollowsTheReceipt(c: Command): bool =
  ((c.phase == Applied or c.phase == AwaitingPayment) implies c.receipt.settlement == D::Succeeded)
  and (c.phase == Failed implies (c.receipt.settlement != D::Unsettled or attachmentFailed(c) or expiredConfiguration(c)))
  and ((c.phase == AwaitingPayment or (c.phase == Failed and c.receipt.settlement == D::Succeeded)) implies c.kind == Sub::UpgradeCommand)
  and (if (c.phase == Applied) c.resultRevision >= c.expectedRevision else c.resultRevision == 0)
pure def sometimesCancelApplied(c: Command): bool = c.kind == Sub::CancelCommand and c.phase == Applied
pure def sometimesUndoApplied(c: Command): bool = c.kind == Sub::UndoCommand and c.phase == Applied
pure def sometimesUpgradeAwaitingPayment(c: Command): bool = c.phase == AwaitingPayment
pure def sometimesUpgradePaidAfterWaiting(c: Command): bool = c.kind == Sub::UpgradeCommand and c.phase == Applied and c.receipt.session.now > c.receipt.settledAt
pure def sometimesUpgradeInvoiceVoided(c: Command): bool = c.phase == Failed and c.receipt.settlement == D::Succeeded
pure def sometimesDowngradeScheduled(c: Command): bool = c.kind == Sub::DowngradeCommand and c.phase == Applied
pure def sometimesRefusedByTheProvider(c: Command): bool = c.phase == Failed and c.receipt.settlement == D::Refused

pure val eval_witness_sometimesUpgradeAwaitingPayment = (
  ("review", { ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: PlusMonthly, periodStart: 0, periodEnd: 2592000000, revision: 1 }, Sub::UpgradeCommand, ProMonthly, "q1", 4667, true, { actorId: "user1", agentId: "org1", connector: "subscription_schedule" }),
  ("confirm", { actorId: "user1", agentId: "org1", connector: "subscription_update" }, { ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: PlusMonthly, periodStart: 0, periodEnd: 2592000000, revision: 1 }, Sub::UpgradeCommand, "cmd1", "q1", 1, "", "d1", true),
  ("send", { actorId: "user1", agentId: "org1", connector: "subscription_update" }, 1),
  ("elapse", 2592000000, { actorId: "user1", agentId: "org1", connector: "subscription_update" }),
  ("resolve", D::EffectSeen, { actorId: "user1", agentId: "org1", connector: "subscription_update" }),
  ("finish", UpgradeInvoiceOpen, 0, { actorId: "user1", agentId: "org1", connector: "subscription_schedule" })
)

pure val eval_witness_sometimesDowngradeScheduled = (
  ("review", { ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: ProMonthly, periodStart: 0, periodEnd: 2592000000, revision: 2 }, Sub::DowngradeCommand, PlusMonthly, "q1", 0, true, { actorId: "user1", agentId: "org1", connector: "subscription_update" }),
  ("recordScheduleReview", ExistingSchedule({ scheduleId: "sched1" }), { actorId: "user1", agentId: "org1", connector: "subscription_schedule" }),
  ("confirm", { actorId: "user1", agentId: "org1", connector: "subscription_schedule" }, { ...Sub::initial, status: Sub::Active, subscriptionId: "sub1", customer: Sub::PinnedCustomer({ customerId: "cus1" }), planKey: ProMonthly, periodStart: 0, periodEnd: 2592000000, revision: 2 }, Sub::DowngradeCommand, "cmd1", "q1", 2, "", "d2", true),
  ("send", { actorId: "user1", agentId: "org1", connector: "subscription_schedule" }, 1),
  ("loseExecutor", { actorId: "user1", agentId: "org1", connector: "subscription_schedule" }),
  ("resolve", D::EffectSeen, { actorId: "user1", agentId: "org1", connector: "subscription_update" }),
  ("finish", NoUpgradeInvoice, 4, { actorId: "user1", agentId: "org1", connector: "subscription_update" })
)
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
  else if (D::isUnknown(c.receipt) or (attaching(c) and D::isUnknown(attachmentReceipt(c)))) ShowUnknown
  else ShowDispatched
```
