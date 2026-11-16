# Host operations

A native host on the device reaches the cloud through host routes that keep
the cloud credential on the host and expose only projected data and
receipts. The deployment's environment and the registered authority are
inputs to these contracts. Billing mutations are reviewed before they are
sent, checkout and renewal results keep their declared presentation, task
reads are fenced by the authority captured when they began, and the host's
paid-access check is a coalesced, generation-fenced cache. Moved from the
native cloud host contract; the paid-access cache is ported from the
develop models `NativePaidAccessCache` and `native_access_coalescing`.

## Story: Review an account operation before allowing its effect

> As a person managing my subscription from a device, I review a cancel or
> undo before it is sent, it is sent once, and the device never shows a
> payment or a plan the cloud did not confirm.

### Subscription mutations retain their review and idempotency scope

A native cancel or undo requires verified interactive billing authority.
An eligible current control must match subscription, revision and action.
Undo includes the reviewed renewal terms digest. Only an exactly matching
prior command in FAILED status permits a new retry ID. The stable command
key's exact preimage joins subscription ID, positive revision, action,
undo terms when applicable, and optional confirmed failed command ID.
The cloud owns transaction admission, execution, and reconciliation
([subscriptions](./subscriptions.md)). The client checks returned identity
and revision and then checks that the host's authority generation is
current. An unknown outcome needs status recovery. The facts record
represents validated inputs and the projected review.

```quint
type SubscriptionAction = CancelSubscription | UndoSubscription
type CommandStatus = CommandPrepared | CommandUncertain | CommandApplied | CommandFailed | CommandSuperseded
type SubscriptionFacts = { validInput: bool, authenticated: bool, authorityCurrent: bool, controlEligible: bool, reviewMatches: bool, undoTermsValid: bool, retryRequested: bool, retryMatches: bool, retryStatus: CommandStatus }
type CommandDecision = CommandAdmitted | CommandInvalidInput | CommandNeedsVerification | CommandRetired | CommandReviewChanged | CommandRetryUnconfirmed
pure val failedStatus: CommandStatus = CommandFailed
pure val uncertainStatus: CommandStatus = CommandUncertain
pure def subscriptionDecision(operation: SubscriptionAction, facts: SubscriptionFacts): CommandDecision =
  if (not(facts.validInput) or (operation == UndoSubscription and not(facts.undoTermsValid))) CommandInvalidInput
  else if (not(facts.authenticated)) CommandNeedsVerification
  else if (not(facts.authorityCurrent)) CommandRetired
  else if (not(facts.controlEligible) or not(facts.reviewMatches)) CommandReviewChanged
  else if (facts.retryRequested and (not(facts.retryMatches) or facts.retryStatus != CommandFailed)) CommandRetryUnconfirmed
  else CommandAdmitted
pure val factsValues = Set(
  { validInput: true, authenticated: true, authorityCurrent: true, controlEligible: true, reviewMatches: true, undoTermsValid: true, retryRequested: true, retryMatches: true, retryStatus: failedStatus },
  { validInput: true, authenticated: true, authorityCurrent: true, controlEligible: true, reviewMatches: true, undoTermsValid: false, retryRequested: false, retryMatches: false, retryStatus: uncertainStatus },
  { validInput: true, authenticated: true, authorityCurrent: true, controlEligible: true, reviewMatches: true, undoTermsValid: true, retryRequested: true, retryMatches: true, retryStatus: uncertainStatus },
  { validInput: true, authenticated: false, authorityCurrent: true, controlEligible: true, reviewMatches: true, undoTermsValid: true, retryRequested: false, retryMatches: false, retryStatus: failedStatus })
pure def lawUndoRequiresTerms(facts: SubscriptionFacts): bool = subscriptionDecision(UndoSubscription, facts) == CommandAdmitted implies facts.undoTermsValid
pure def lawRetryNeedsFailedCommand(operation: SubscriptionAction, facts: SubscriptionFacts): bool = (facts.retryRequested and subscriptionDecision(operation, facts) == CommandAdmitted) implies facts.retryMatches and facts.retryStatus == CommandFailed
pure def lawAdmissionKeepsReviewAndAuthority(operation: SubscriptionAction, facts: SubscriptionFacts): bool = subscriptionDecision(operation, facts) == CommandAdmitted implies facts.authenticated and facts.authorityCurrent and facts.controlEligible and facts.reviewMatches
```

### Checkout and renewal responses preserve the declared presentation

Checkout projects open, completed, expired, and stale intent independently.
An open embedded checkout requires the embedded mode and validated
provider session, client and publisher fields plus a nonnegative USD
monthly amount. The shared link requires HTTPS on the payment provider's
checkout host and no URL credentials. Expiry or stale intent retires the
local operation. The host never infers entitlement from the form. A
renewal review retains its exact identity, revision, public terms digest,
price and dates. The snapshot validity checks use millisecond wall time and
exact integer cents.

```quint
type CheckoutStatus = CheckoutOpen | CheckoutComplete | CheckoutExpired | CheckoutStale | CheckoutUnknown
type CheckoutView = ShowEmbedded | ShowPaymentLink | PaymentConfirmed | ForgetExpired | ForgetStale | InvalidCheckout
pure def checkoutProjection(status: CheckoutStatus, embedded: bool, validEmbedded: bool, validSharedLink: bool): CheckoutView =
  if (status == CheckoutComplete) PaymentConfirmed
  else if (status == CheckoutExpired) ForgetExpired
  else if (status == CheckoutStale) ForgetStale
  else if (status != CheckoutOpen) InvalidCheckout
  else if (embedded) (if (validEmbedded) ShowEmbedded else InvalidCheckout)
  else if (validSharedLink) ShowPaymentLink
  else InvalidCheckout
pure def lawOpenPaymentIsNeverConfirmed(embedded: bool, validEmbedded: bool, validSharedLink: bool): bool = checkoutProjection(CheckoutOpen, embedded, validEmbedded, validSharedLink) != PaymentConfirmed
pure def lawSharedCheckoutNeedsVerifiedLink(status: CheckoutStatus, validEmbedded: bool, validSharedLink: bool): bool = checkoutProjection(status, false, validEmbedded, validSharedLink) == ShowPaymentLink implies validSharedLink
```

## Story: Run a task against its selected Google grant or document account

> As a person whose agent reads my mail or describes my documents, each
> result comes from the account and grant I selected when the task began,
> or the task fails; it never silently switches to another one.

### Each result is fenced by the captured host and provider authority

Managed Google and mailbox task reads bind the actor, cloud credential,
Google generation and selected owner grant. They use GET and do not
fall back to a different grant. Only a timeout, 429, or 5xx permits a
bounded read retry. Refusal and an over-size response are explicit
failures. Gmail effect preparation checks the current grant, necessary
scope and proposal. Dispatch checks the exact reviewed request ID,
kind and digest on the receipt. Loss after dispatch reports an unknown
outcome. Document vision requires the configured account authority and
no ambient application attribution. It checks owner and cancellation
before and after inference. Its trusted artifact verifies the source
commit, canvas version, and bundle SHA-256 before import.

```quint
type HostAuthority = { hostEpoch: int, googleEpoch: int, actor: str, grant: str }
pure def sameHost(captured: HostAuthority, observed: HostAuthority): bool = captured.hostEpoch == observed.hostEpoch and captured.actor != "" and captured.actor == observed.actor
pure def sameGoogleGrant(captured: HostAuthority, observed: HostAuthority): bool = sameHost(captured, observed) and captured.googleEpoch == observed.googleEpoch and captured.grant != "" and captured.grant == observed.grant
pure def visionPublishable(captured: HostAuthority, observed: HostAuthority, cancelled: bool, outboundAllowed: bool, exactAuthority: bool, ambientAttribution: bool): bool = sameHost(captured, observed) and not(cancelled) and outboundAllowed and exactAuthority and not(ambientAttribution)
pure val capturedValues = Set({ hostEpoch: 1, googleEpoch: 1, actor: "owner", grant: "grant" })
pure val observedValues = Set({ hostEpoch: 1, googleEpoch: 1, actor: "owner", grant: "grant" }, { hostEpoch: 1, googleEpoch: 2, actor: "owner", grant: "replacement" }, { hostEpoch: 2, googleEpoch: 1, actor: "another", grant: "grant" })
pure def lawGoogleReadCannotFollowGrantChange(captured: HostAuthority, observed: HostAuthority): bool = captured.grant != observed.grant implies not(sameGoogleGrant(captured, observed))
pure def lawVisionDoesNotPublishAfterAccountChange(captured: HostAuthority, observed: HostAuthority, cancelled: bool, outboundAllowed: bool, exactAuthority: bool, ambientAttribution: bool): bool = visionPublishable(captured, observed, cancelled, outboundAllowed, exactAuthority, ambientAttribution) implies sameHost(captured, observed) and not(cancelled) and exactAuthority and not(ambientAttribution)
```

## Story: Check paid access quickly without granting it to the wrong account

> As a person using paid features on a device, the host answers from a
> recent check when it can and asks the cloud once for everyone waiting,
> but never admits me on an answer that belonged to an earlier account,
> key or plan revision.

### A cached answer is used only for the current account, key, revision and refusal epoch

The host's paid-access check is a funding gate for the interface, never
charge authority. It keeps the last definite answer (active or refused)
together with the key, account generation, plan revision and refusal epoch
it was read under, and answers from it only while all four are current; a
warm answer also schedules a background revalidation. Unavailable answers
are never cached. Changing the account, a paid refusal, or an identity
refusal clears the cache.

```quint
type ReadPhase = ReadPending | ReadRevoking | ReadResolved | ReadDone
type AccessOutcome = NoOutcome | AccessActive | AccessRefused | AccessUnavailable | AccessStale | AccessRevoked
type CallPhase = CallWaiting | CallAdmitted | CallFailed | CallStale
type AccessTuple = { key: str, generation: int, revision: int, epoch: int }
type AccessRead = { read: int, phase: ReadPhase, tuple: AccessTuple, outcome: AccessOutcome }
type AccessCall = { caller: int, phase: CallPhase, read: int, tuple: AccessTuple, admitted: AccessTuple }
type PaidAccess = { tuple: AccessTuple, refusedKeys: List[str], reads: List[AccessRead], calls: List[AccessCall], cache: int, flight: int, background: bool, wrongOwnerCleared: bool }
pure val noTuple: AccessTuple = { key: "", generation: -1, revision: -1, epoch: -1 }
pure val noRead: AccessRead = { read: 0, phase: ReadDone, tuple: noTuple, outcome: NoOutcome }
pure val initial: PaidAccess = { tuple: { key: "k1", generation: 0, revision: 0, epoch: 0 }, refusedKeys: List(), reads: List(), calls: List(), cache: 0, flight: 0, background: false, wrongOwnerCleared: false }
pure def readOf(a: PaidAccess, r: int): AccessRead = a.reads.select(x => x.read == r).nthOr(0, noRead)
pure def putRead(a: PaidAccess, x: AccessRead): List[AccessRead] = a.reads.listMap(y => if (y.read == x.read) x else y)
pure def readCurrent(a: PaidAccess, r: int): bool = r > 0 and readOf(a, r).tuple == a.tuple
pure def sameOwner(a: PaidAccess, t: AccessTuple): bool = t.key == a.tuple.key and t.generation == a.tuple.generation
pure def warm(a: PaidAccess): bool = readCurrent(a, a.cache) and readOf(a, a.cache).outcome == AccessActive
pure def matchingFlight(a: PaidAccess): bool = readCurrent(a, a.flight) and readOf(a, a.flight).phase == ReadPending
pure def withNewRead(t: AccessTuple, a: PaidAccess): PaidAccess = { ...a, flight: a.reads.length() + 1, reads: a.reads.append({ read: a.reads.length() + 1, phase: ReadPending, tuple: t, outcome: NoOutcome }) }
pure val callerValues = Set(1, 2)
pure val rValues = Set(1, 2, 3)
pure def canBeginCheck(a: PaidAccess, caller: int): bool = not(a.calls.some(c => c.caller == caller and c.phase == CallWaiting)) and a.tuple.key != ""
pure def joinFlight(a: PaidAccess, caller: int): PaidAccess = {
  val others = a.calls.select(c => c.caller != caller)
  val started = if (matchingFlight(a)) a else withNewRead(a.tuple, a)
  { ...started, calls: others.append({ caller: caller, phase: CallWaiting, read: started.flight, tuple: a.tuple, admitted: noTuple }) }
}
pure def beginCheck(a: PaidAccess, caller: int): PaidAccess = {
  val others = a.calls.select(c => c.caller != caller)
  if (warm(a)) { ...a, background: true, calls: others.append({ caller: caller, phase: CallAdmitted, read: 0, tuple: a.tuple, admitted: a.tuple }) }
  else joinFlight(a, caller)
}
pure def canRevalidate(a: PaidAccess): bool = a.background and not(matchingFlight(a))
pure def revalidate(a: PaidAccess): PaidAccess = { ...withNewRead(a.tuple, a), background: false }
pure def alwaysDefiniteCacheOnly(a: PaidAccess): bool = a.cache == 0 or readOf(a, a.cache).outcome == AccessActive or readOf(a, a.cache).outcome == AccessRefused
pure def alwaysOneFlightPerTuple(a: PaidAccess): bool = a.reads.every(x => x.phase != ReadPending or a.reads.select(y => y.phase == ReadPending and y.tuple == x.tuple).length() == 1)
pure def alwaysNoStaleAdmission(a: PaidAccess): bool = a.calls.every(c => c.phase == CallAdmitted implies c.admitted == c.tuple)
pure def sometimesWarmAnswer(a: PaidAccess): bool = a.calls.some(c => c.phase == CallAdmitted and c.read == 0)
pure def sometimesCallersShareOneRead(a: PaidAccess): bool = a.calls.some(c => a.calls.some(d => d.caller != c.caller and d.read == c.read and c.read > 0))
```

### A reply admits a waiting caller only if it was read for that caller's account and key

A read resolves as stale if the account or key changed while it was in
flight. An identity refusal for the current account advances the revision
and refusal epoch and clears the cache; it clears the stored key only after
the host's revocation work, and only if the key it was read for is still
the one stored, so an old refusal never erases a replacement key. A
finished read stops being the shared flight only if it still is one,
never clearing a successor's.

```quint
pure def canResolveRead(a: PaidAccess, r: int, unavailable: bool): bool = readOf(a, r).read == r and readOf(a, r).phase == ReadPending
pure def resolveRead(a: PaidAccess, r: int, unavailable: bool): PaidAccess = {
  val x = readOf(a, r)
  val answer = if (not(sameOwner(a, x.tuple))) AccessStale else if (unavailable) AccessUnavailable else if (a.refusedKeys.includes(x.tuple.key)) AccessRefused else AccessActive
  { ...a, reads: putRead(a, { ...x, phase: ReadResolved, outcome: answer }), cache: if (readCurrent(a, r) and (answer == AccessActive or answer == AccessRefused)) r else a.cache }
}
pure def canIdentityRefused(a: PaidAccess, r: int): bool = readOf(a, r).read == r and readOf(a, r).phase == ReadPending
pure def identityRefused(a: PaidAccess, r: int): PaidAccess = {
  val x = readOf(a, r)
  if (x.tuple.generation == a.tuple.generation)
    { ...a, tuple: { ...a.tuple, revision: a.tuple.revision + 1, epoch: a.tuple.epoch + 1 }, cache: 0,
      reads: putRead(a, if (x.tuple.key == a.tuple.key) { ...x, phase: ReadRevoking } else { ...x, phase: ReadResolved, outcome: AccessStale }) }
  else { ...a, reads: putRead(a, { ...x, phase: ReadResolved, outcome: AccessStale }) }
}
pure def canFinishRevocation(a: PaidAccess, r: int): bool = readOf(a, r).read == r and readOf(a, r).phase == ReadRevoking
pure def finishRevocation(a: PaidAccess, r: int): PaidAccess = {
  val x = readOf(a, r)
  if (sameOwner(a, x.tuple)) { ...a, tuple: { ...a.tuple, key: "" }, wrongOwnerCleared: a.wrongOwnerCleared or not(sameOwner(a, x.tuple)), reads: putRead(a, { ...x, phase: ReadResolved, outcome: AccessRevoked }) }
  else { ...a, reads: putRead(a, { ...x, phase: ReadResolved, outcome: AccessStale }) }
}
pure def canFinishRead(a: PaidAccess, r: int): bool = readOf(a, r).read == r and readOf(a, r).phase == ReadResolved
pure def finishRead(a: PaidAccess, r: int): PaidAccess = { ...a, flight: if (a.flight == r) 0 else a.flight, reads: putRead(a, { ...readOf(a, r), phase: ReadDone }) }
pure def canObserveCheck(a: PaidAccess, caller: int): bool = a.calls.some(c => c.caller == caller and c.phase == CallWaiting and readOf(a, c.read).phase == ReadDone)
pure val noCall: AccessCall = { caller: 0, phase: CallStale, read: 0, tuple: noTuple, admitted: noTuple }
pure def callOf(a: PaidAccess, caller: int): AccessCall = a.calls.select(c => c.caller == caller).nthOr(0, noCall)
pure def observeCheck(a: PaidAccess, caller: int): PaidAccess = {
  val c = callOf(a, caller)
  val x = readOf(a, c.read)
  val valid = x.tuple.key == c.tuple.key and c.tuple.key == a.tuple.key and x.tuple.generation == c.tuple.generation and c.tuple.generation == a.tuple.generation
  val phase = if (valid and x.outcome == AccessActive) CallAdmitted else if (valid or x.outcome == AccessRevoked) CallFailed else CallStale
  { ...a, calls: a.calls.listMap(d => if (d.caller == caller) { ...d, phase: phase, admitted: if (phase == CallAdmitted) a.tuple else noTuple, tuple: if (phase == CallAdmitted) a.tuple else d.tuple } else d) }
}
pure def stepFinishedReadKeepsSuccessorFlight(before: PaidAccess, via: str, after: PaidAccess): bool = via == "finishRead" implies (after.flight == before.flight or after.flight == 0) and (before.flight != 0 and after.flight == 0 implies readOf(after, before.flight).phase == ReadDone)
pure def alwaysNoWrongOwnerCleared(a: PaidAccess): bool = not(a.wrongOwnerCleared)
pure def sometimesReplacementKeySurvivesOldRefusal(a: PaidAccess): bool = a.tuple.key == "k2" and a.reads.some(x => x.tuple.key == "k1" and x.outcome == AccessStale)
```

### The account, key, plan revision or remote answer may change at any time

```quint
pure def canChangeKey(a: PaidAccess): bool = a.tuple.key == "k1"
pure def changeKey(a: PaidAccess): PaidAccess = { ...a, tuple: { ...a.tuple, key: "k2" } }
pure def canChangeAccount(a: PaidAccess): bool = true
pure def changeAccount(a: PaidAccess): PaidAccess = { ...a, tuple: { ...a.tuple, key: "k2", generation: a.tuple.generation + 1, epoch: a.tuple.epoch + 1 }, cache: 0 }
pure def canChangeRevision(a: PaidAccess): bool = true
pure def changeRevision(a: PaidAccess): PaidAccess = { ...a, tuple: { ...a.tuple, revision: a.tuple.revision + 1 } }
pure def canPaidRefused(a: PaidAccess): bool = true
pure def paidRefused(a: PaidAccess): PaidAccess = { ...a, tuple: { ...a.tuple, epoch: a.tuple.epoch + 1 }, cache: 0, background: true }
pure val keyValues = Set("k1", "k2")
pure def canRemoteChange(a: PaidAccess, key: str): bool = true
pure def remoteChange(a: PaidAccess, key: str): PaidAccess = { ...a, refusedKeys: if (a.refusedKeys.includes(key)) a.refusedKeys.select(k => k != key) else a.refusedKeys.append(key) }
pure def stepDeliveredAnswerMatchesAccount(before: PaidAccess, after: PaidAccess): bool =
  after.calls.every(c => (c.phase == CallAdmitted and not(before.calls.some(d => d.caller == c.caller and d.phase == CallAdmitted and d.admitted == c.admitted))) implies c.admitted.generation == after.tuple.generation)
```
