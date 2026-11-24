# Account deletion

An account is deleted only by the operator, through `elizaos-cloud account
delete --user <user> --confirmed-with-owner`, after the operator has confirmed the request with the person
(no app has a deletion route; the person asks support). There is no recovery
window and no cancel. Sources are develop
`lib/services/account-deletion-saga.ts`,
`db/repositories/account-deletion-requests.ts` and the Quint models
`AccountDeletionOrder` and `AccountDeletionPhase`, reduced to three steps.

One machine instance is one deletion request row, keyed by the user. The
request fences the account; a sweep then runs the steps in order: cancel
billing at the payment provider, revoke each Google connection at Google, and
erase the account's data. Each provider call is one receipt of
`shared/dispatchOnce`, embedded here; the shell writes each transition in one
store transaction and keeps every receipt row it replaces. Ledger rows and
provider invoices are never erased: they stay keyed by the organization id.

## Story: Delete an account once the person asked support

> As the operator, I want an account deleted only after its owner asked me,
> with every session and device key ended at once and every provider change
> made exactly once, so that nothing of the person stays usable or is
> charged after they asked.

### Only an active account is fenced, and the fence ends every session and device key in the same transaction

The request takes the person's current session and device epochs, read under
the account lock. In the transaction that records it, the shell applies
`beginDeletion` of `identity/accounts` to the account (so first sight and
request authentication refuse it) and the two revocations of `Fence` to the
person's epochs. The attempt budget is the profile's per-step budget,
`defaultAttemptBudget`. A request for an account already being deleted shows
the deletion as it stands.

```quint
import types.* from "../shared/types"
import accounts as A from "./accounts"
import sessions as Iss from "./sessions"
import deviceKeys as DK from "../nativeClients/deviceKeys"
import sessions as S from "../../core/sessions"
import dispatchOnce as D from "../shared/dispatchOnce"
type SagaStep = CancelBilling | RevokeGoogle | EraseData
type DeletionPhase = NotRequested | Running({ at: SagaStep }) | ActionNeeded({ at: SagaStep }) | Erased
type StepResult = Open | NothingToDo | Applied
type BillingBoundary = BillingUnsettled | BillingCheckoutSettled | BillingSettled
type Deletion = { phase: DeletionPhase, userId: str, organizationId: str, attemptBudget: int, attempts: int, receipt: D::Receipt, usedKeys: List[ProviderKey], billing: StepResult, google: StepResult }
type DeletionEffect = Fence({ sessions: Iss::SessionEffect, deviceKeys: DK::DeviceKeysRevoked }) | EraseAccount({ userId: str, organizationId: str })
type DeletionStep = { state: Deletion, out: List[DeletionEffect] }
pure val defaultAttemptBudget = 12
pure val initial: Deletion = { phase: NotRequested, userId: "", organizationId: "", attemptBudget: 0, attempts: 0, receipt: D::initial, usedKeys: List(), billing: Open, google: Open }
pure def canRequest(d: Deletion, userId: str, organizationId: str, accountStatus: A::AccountStatus, personEpoch: int, deviceEpoch: int, attemptBudget: int): bool =
  d.phase == NotRequested and userId != "" and organizationId != "" and accountStatus == A::Active and attemptBudget >= 1
pure def request(d: Deletion, userId: str, organizationId: str, accountStatus: A::AccountStatus, personEpoch: int, deviceEpoch: int, attemptBudget: int): DeletionStep =
  { state: { ...d, phase: Running({ at: CancelBilling }), userId: userId, organizationId: organizationId, attemptBudget: attemptBudget },
    out: List(Fence({ sessions: Iss::revokeAll(personEpoch), deviceKeys: DK::revokeAll(deviceEpoch) })) }
pure val attemptBudgetValues = Set(1, 2)
pure def isFence(e: DeletionEffect): bool = match e { | Fence(f) => true | _ => false }
pure def stepEffectsOnlyAtFenceAndErasure(before: Deletion, via: str, after: Deletion, out: List[DeletionEffect]): bool =
  (via == "request" implies (out.length() == 1 and out.every(e => isFence(e))))
  and (via == "eraseData" implies out == List(EraseAccount({ userId: before.userId, organizationId: before.organizationId })))
  and ((via != "request" and via != "eraseData") implies out == List())
```

### The steps run in order, and a step is finished only once every step before it is

Resolving the person's billing comes first; each account has its own
organization, so its billing is the person's alone. An issued
checkout can still charge until the provider confirms an end. Before the
shell chooses which subscription to cancel, it resolves an opening checkout
or obtains a terminal result for an issued session. It reuses the checkout's
stable expiry key and reads back an uncertain result. An already paid
checkout identifies the exact subscription for cancellation.
Revoking Google comes next. Erasing comes last, so a provider is never left
holding a grant or a subscription for an account that no longer exists here.

```quint
pure def rankOf(s: SagaStep): int = if (s == CancelBilling) 1 else if (s == RevokeGoogle) 2 else 3
pure def progress(p: DeletionPhase): int = match p { | NotRequested => 0 | Running(r) => rankOf(r.at) | ActionNeeded(a) => rankOf(a.at) | Erased => 4 }
pure def currentStep(p: DeletionPhase): SagaStep = match p { | Running(r) => r.at | ActionNeeded(a) => a.at | NotRequested => CancelBilling | Erased => EraseData }
pure def isRunning(d: Deletion, s: SagaStep): bool = d.phase == Running({ at: s })
pure def alwaysEarlierStepsAreFinished(d: Deletion): bool =
  (progress(d.phase) <= 1 implies (d.billing == Open and d.google == Open))
  and (progress(d.phase) >= 2 implies d.billing != Open)
  and (progress(d.phase) >= 3 implies d.google != Open)
pure def stepStepsAdvanceOneAtATime(before: Deletion, after: Deletion): bool =
  progress(after.phase) >= progress(before.phase) and progress(after.phase) <= progress(before.phase) + 1
```

### Each provider call of a step is one receipt of that step's kind, owned by the account, under a provider key never used before

Cancelling billing is a `SubscriptionUpdate` (cancel now, no proration);
revoking Google is a `GoogleGrant` per connection. The shell derives each
provider key from the request, the step, the connection and a call number.
Before sending, the shell records the exact Stripe subscription and its
customer or the exact Google connection and its storage format. Stripe
lookup and retry use that recorded subscription. An unresolved older receipt
holding only an organization id needs operator diagnosis because it does
not identify what was sent. A completed older receipt can finish its step.
Claiming, sending, a reply, a lost sender and a lookup are those of
`shared/dispatchOnce`, so each call reaches the provider at most once and an
unknown outcome is settled only by a lookup.

```quint
pure def kindFor(s: SagaStep): ProviderKind = if (s == CancelBilling) SubscriptionUpdate else GoogleGrant
pure def isCalling(d: Deletion): bool = isRunning(d, CancelBilling) or isRunning(d, RevokeGoogle)
pure def onProviderStep(p: DeletionPhase): bool = match p { | Running(r) => r.at != EraseData | ActionNeeded(a) => a.at != EraseData | _ => false }
pure def noCall(r: D::Receipt): bool = D::receiptStatus(r) == D::StatusAbsent
pure def fresh(r: D::Receipt): D::Receipt = { ...D::initial, session: { ...D::initial.session, now: r.session.now } }
pure def ownerFor(d: Deletion, kind: ProviderKind): S::SessionOwner = { agentId: d.organizationId, actorId: d.userId, connector: D::connectorOf(kind) }
pure def callBase(d: Deletion): D::Receipt = if (noCall(d.receipt)) d.receipt else fresh(d.receipt)
pure def checkoutSettled(billingBoundary: BillingBoundary): bool =
  billingBoundary == BillingCheckoutSettled or billingBoundary == BillingSettled
pure def billingSettled(billingBoundary: BillingBoundary): bool = billingBoundary == BillingSettled
pure val billingBoundaryValues = Set(BillingUnsettled, BillingCheckoutSettled, BillingSettled)
pure def canPrepareCall(d: Deletion, digest: str, providerKey: ProviderKey, staleAfter: Millis, expiresAt: Millis, billingBoundary: BillingBoundary): bool =
  isCalling(d) and (if (isRunning(d, CancelBilling)) checkoutSettled(billingBoundary) else billingSettled(billingBoundary))
  and providerKey.providerKind == kindFor(currentStep(d.phase)) and d.attempts < d.attemptBudget and not(d.usedKeys.includes(providerKey))
  and (noCall(d.receipt) or (callFailed(currentStep(d.phase), d.receipt) and D::mayFollowWith(d.receipt, providerKey)))
  and D::canPrepare(callBase(d), ownerFor(d, providerKey.providerKind), digest, providerKey, staleAfter, expiresAt)
pure def prepareCall(d: Deletion, digest: str, providerKey: ProviderKey, staleAfter: Millis, expiresAt: Millis, billingBoundary: BillingBoundary): Deletion =
  { ...d, attempts: d.attempts + 1, usedKeys: d.usedKeys.append(providerKey), receipt: D::prepare(callBase(d), ownerFor(d, providerKey.providerKind), digest, providerKey, staleAfter, expiresAt) }
pure def canClaimCall(d: Deletion): bool = isCalling(d) and D::canClaim(d.receipt, d.receipt.session.owner)
pure def claimCall(d: Deletion): Deletion = { ...d, receipt: D::claim(d.receipt, d.receipt.session.owner) }
pure def canSendCall(d: Deletion, claimToken: int): bool = isCalling(d) and D::canSend(d.receipt, d.receipt.session.owner, claimToken)
pure def sendCall(d: Deletion, claimToken: int): Deletion = { ...d, receipt: D::send(d.receipt, d.receipt.session.owner, claimToken) }
pure def canReplyToCall(d: Deletion, reply: D::ProviderReply): bool = isCalling(d) and D::canReceiveReply(d.receipt, reply)
pure def replyToCall(d: Deletion, reply: D::ProviderReply): Deletion = { ...d, receipt: D::receiveReply(d.receipt, reply) }
pure def canLoseCaller(d: Deletion): bool = isCalling(d) and D::canLoseExecutor(d.receipt)
pure def loseCaller(d: Deletion): Deletion = { ...d, receipt: D::loseExecutor(d.receipt) }
pure def canLookUpCall(d: Deletion, lookup: D::LookupResult): bool = isCalling(d) and D::canResolve(d.receipt, lookup)
pure def lookUpCall(d: Deletion, lookup: D::LookupResult): Deletion = { ...d, receipt: D::resolve(d.receipt, lookup) }
pure def canPassTime(d: Deletion, elapsed: Millis): bool = isCalling(d) and D::canElapse(d.receipt, elapsed)
pure def passTime(d: Deletion, elapsed: Millis): Deletion = { ...d, receipt: D::elapse(d.receipt, elapsed) }
pure val providerKeyValues = Set({ providerKind: SubscriptionUpdate, providerId: "sub1" }, { providerKind: SubscriptionUpdate, providerId: "sub2" }, { providerKind: GoogleGrant, providerId: "g1" }, { providerKind: GoogleGrant, providerId: "g2" })
pure val replyValues = Set(D::ShowsEffect, D::DefiniteRefusal({ cause: D::NotFoundAtProvider }), D::DefiniteRefusal({ cause: D::OtherRefusal }), D::Unclear)
pure val lookupValues = Set(D::EffectSeen, D::RefusalSeen({ cause: D::OtherRefusal }), D::NothingSeen)
pure val expiresAtValues = Set(100)
pure def alwaysReceiptBelongsToItsStep(d: Deletion): bool =
  D::alwaysPreparedIsBound(d.receipt) and D::alwaysSessionIsSound(d.receipt) and D::alwaysSentBeforeStale(d.receipt) and D::alwaysOutcomeFollowsTheSession(d.receipt)
  and (noCall(d.receipt) or (
    onProviderStep(d.phase) and D::kindOf(d.receipt) == kindFor(currentStep(d.phase)) and d.usedKeys.some(key => D::usesProviderKey(d.receipt, key))
    and d.receipt.session.owner.agentId == d.organizationId and d.receipt.session.owner.actorId == d.userId))
pure def alwaysNoProviderKeyIsUsedTwice(d: Deletion): bool = d.usedKeys.every(k => d.usedKeys.select(j => j == k).length() == 1)
```

### A step is finished when its call took effect, the provider no longer holds the thing, or nothing was left to do

A refusal because the subscription or grant is already gone at the provider
counts as done, and for Google so does a token Google already treats as
revoked. Before a step finishes, the shell confirms that no owned checkout
or its linked subscription can still charge.
After a connection is revoked, the shell erases its sealed tokens in the
same transaction. If another connection remains, it starts with a fresh
budget. The shell checks both server and legacy Worker token
custody with their original keys and OAuth client configuration. A missing
required credential leaves the cleanup unresolved and preserves the sealed
record for recovery.

```quint
pure def alreadyGone(s: SagaStep, cause: D::RefusalCause): bool = cause == D::NotFoundAtProvider or (s == RevokeGoogle and cause == D::AuthorizationLost)
pure def callSucceeded(s: SagaStep, r: D::Receipt): bool = r.settlement == D::Succeeded or (r.settlement == D::Refused and alreadyGone(s, r.refusal))
pure def callFailed(s: SagaStep, r: D::Receipt): bool = r.settlement == D::NotApplied or (r.settlement == D::Refused and not(alreadyGone(s, r.refusal)))
pure def resultFor(s: SagaStep, d: Deletion): StepResult = if (s == CancelBilling) d.billing else d.google
pure def recordResult(s: SagaStep, result: StepResult, d: Deletion): Deletion = if (s == CancelBilling) { ...d, billing: result } else { ...d, google: result }
pure def canCompleteStep(d: Deletion, workLeft: bool, billingBoundary: BillingBoundary): bool =
  isCalling(d) and billingSettled(billingBoundary) and (if (workLeft) (isRunning(d, RevokeGoogle) and callSucceeded(RevokeGoogle, d.receipt)) else (noCall(d.receipt) or callSucceeded(currentStep(d.phase), d.receipt)))
pure def completeStep(d: Deletion, workLeft: bool, billingBoundary: BillingBoundary): Deletion = {
  val s = currentStep(d.phase)
  val result = if (callSucceeded(s, d.receipt) or resultFor(s, d) == Applied) Applied else NothingToDo
  val recorded = recordResult(s, result, d)
  { ...recorded, phase: if (workLeft) d.phase else Running({ at: if (s == CancelBilling) RevokeGoogle else EraseData }), attempts: 0, receipt: fresh(d.receipt) }
}
pure def sometimesErasedAfterCancellingAndRevoking(d: Deletion): bool = d.phase == Erased and d.billing == Applied and d.google == Applied
pure def sometimesErasedWithNothingAtProviders(d: Deletion): bool = d.phase == Erased and d.billing == NothingToDo and d.google == NothingToDo
pure def sometimesNextConnectionRevoked(d: Deletion): bool = isRunning(d, RevokeGoogle) and d.google == Applied and d.attempts >= 1
```

### A failed call is tried again under a new provider key until the budget is spent, and then the step needs the operator

A call fails when the provider refused it for another cause or when it was
settled as not applied. Each prepared call spends one attempt of the step,
and an erasure whose transaction failed spends one too. The shell waits
between attempts on its sweep schedule.

```quint
pure def isActionNeeded(p: DeletionPhase): bool = match p { | ActionNeeded(a) => true | _ => false }
pure def needsAction(d: Deletion): bool = isActionNeeded(d.phase)
pure def canEraseFailed(d: Deletion): bool = isRunning(d, EraseData) and d.attempts < d.attemptBudget
pure def eraseFailed(d: Deletion): Deletion = { ...d, attempts: d.attempts + 1 }
pure def canRequireAction(d: Deletion): bool =
  d.attempts >= d.attemptBudget and (isRunning(d, EraseData) or (isCalling(d) and callFailed(currentStep(d.phase), d.receipt)))
pure def requireAction(d: Deletion): Deletion = { ...d, phase: ActionNeeded({ at: currentStep(d.phase) }) }
pure def alwaysAttemptsWithinBudget(d: Deletion): bool =
  d.attempts >= 0 and d.attempts <= d.attemptBudget and (d.phase == NotRequested implies (d.attempts == 0 and d.attemptBudget == 0)) and (d.phase != NotRequested implies d.attemptBudget >= 1)
pure def sometimesRetriedUnderANewKey(d: Deletion): bool = isCalling(d) and d.attempts >= 2
pure def sometimesActionNeeded(d: Deletion): bool = needsAction(d)
pure def sometimesErasureRetried(d: Deletion): bool = isRunning(d, EraseData) and d.attempts >= 1
```

### Requesting deletion again of an account that needs action resumes its step with a fresh budget

The operator runs `account delete` again once the cause is fixed. The step
starts from a fresh receipt; the failed one stays in its row.

```quint
pure def canResume(d: Deletion, attemptBudget: int): bool = attemptBudget >= 1 and needsAction(d)
pure def resume(d: Deletion, attemptBudget: int): Deletion =
  { ...d, phase: Running({ at: currentStep(d.phase) }), attempts: 0, attemptBudget: attemptBudget, receipt: fresh(d.receipt) }
```

### The account's data is erased once, last, and the erased deletion never changes again

Erasure needs a settled billing result. The same check
applies to a retained deletion that had already advanced under an earlier
version. Unresolved billing keeps its recorded phase and receipts.
In the erasing transaction the shell applies `erase` of `identity/accounts`
to the account (identities and referral code removed, user and organization
ids kept) and deletes the person's personal data and sealed secrets: device
grants and their sealed copies, session families, second factors, Google
connections and their sealed tokens, mail and calendar receipts. It keeps
the ledger and invoices, keyed by the organization id.

```quint
pure def canEraseData(d: Deletion, billingBoundary: BillingBoundary): bool = isRunning(d, EraseData) and billingSettled(billingBoundary)
pure def eraseData(d: Deletion, billingBoundary: BillingBoundary): DeletionStep =
  { state: { ...d, phase: Erased }, out: List(EraseAccount({ userId: d.userId, organizationId: d.organizationId })) }
pure def stepErasedIsFinal(before: Deletion, after: Deletion): bool = before.phase == Erased implies after == before
pure def lawUnsettledBillingBlocksProgress(d: Deletion): bool =
  not(canCompleteStep(d, false, BillingUnsettled)) and not(canCompleteStep(d, true, BillingUnsettled)) and not(canEraseData(d, BillingUnsettled))
```
