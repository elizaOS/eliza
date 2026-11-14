# Native Cloud host operations

Grace imports host routes from Eliza's
`packages/cloud/sdk/native-host/cloud-services.mjs` with its own policy.
The pinned producer also contains `subscription-review.mjs`,
`managed-google-read-port.mjs`, `mailbox-read-port.mjs`,
`document-runtime.mjs`, `document-image-describer.mjs`, and
`clef-decisions.mjs`. AlphaPhone consumes related logical operations
through its Cloud SDK and resident bridge. The product environment and
registered authority are inputs to these contracts. The host owns its
transport credentials and exposes only projected data and receipts.

## Story: Review an account operation before allowing its effect

### Subscription mutations retain their review and idempotency scope

A native cancel or undo requires verified interactive billing authority.
An eligible current control must match subscription, revision and action.
Undo includes the reviewed renewal terms digest. Only an exactly matching
prior command in FAILED status permits a new retry ID. The stable command
key's exact preimage joins subscription ID, positive revision, action,
undo terms when applicable, and optional confirmed failed command ID.
Cloud owns transaction admission, execution, and reconciliation. The
SDK checks returned identity and revision and then checks that the host's
authority generation is current. An unknown outcome needs status recovery.
Grace's `SubscriptionCommand.tla` and `PlanCheckout.tla` cover provider
settlement under retries and outages. They concern distinct Cloud mutations.
The facts record represents validated inputs and the projected review.

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
Open embedded checkout requires the embedded mode and validated Stripe
session, client and publisher fields plus a nonnegative USD monthly amount.
The shared link requires HTTPS on `checkout.stripe.com` and no URL credentials.
Expiry or stale intent retires the local operation. The host never infers
entitlement from the form. A renewal review retains its exact identity,
revision, public terms digest, price and dates. The snapshot validity
checks use millisecond wall time and exact integer cents.

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

### Each result is fenced by the captured host and provider authority

Managed Google and mailbox task reads bind the actor, Cloud credential,
Google generation and selected owner grant. They use GET and do not
fall back to a different grant. Only a timeout, 429, or 5xx permits a
bounded read retry. Refusal and an over-size response are explicit
failures. Gmail effect preparation checks the current grant, necessary
scope and proposal. Dispatch checks the exact reviewed request ID,
kind and digest on the receipt. Loss after dispatch reports an unknown
outcome. Document vision requires the configured account authority and
no ambient application attribution. It checks owner and cancellation
before and after inference. Its trusted artifact verifies the source
commit, canvas version, and bundle SHA-256 before import. Expected
exports are PdfService, handleImageDescription,
resolveCloudSdkAuthorityTuple, getNativeApplicationSlot, and getAppId.

```quint
type HostAuthority = { hostEpoch: int, googleEpoch: int, actor: str, grant: str }
pure def sameHost(captured: HostAuthority, observed: HostAuthority): bool = captured.hostEpoch == observed.hostEpoch and captured.actor != "" and captured.actor == observed.actor
pure def sameGoogleGrant(captured: HostAuthority, observed: HostAuthority): bool = sameHost(captured, observed) and captured.googleEpoch == observed.googleEpoch and captured.grant != "" and captured.grant == observed.grant
pure def canPublishVision(captured: HostAuthority, observed: HostAuthority, cancelled: bool, outboundAllowed: bool, exactAuthority: bool, ambientAttribution: bool): bool = sameHost(captured, observed) and not(cancelled) and outboundAllowed and exactAuthority and not(ambientAttribution)
pure val capturedValues = Set({ hostEpoch: 1, googleEpoch: 1, actor: "owner", grant: "grant" })
pure val observedValues = Set({ hostEpoch: 1, googleEpoch: 1, actor: "owner", grant: "grant" }, { hostEpoch: 1, googleEpoch: 2, actor: "owner", grant: "replacement" }, { hostEpoch: 2, googleEpoch: 1, actor: "another", grant: "grant" })
pure def lawGoogleReadCannotFollowGrantChange(captured: HostAuthority, observed: HostAuthority): bool = captured.grant != observed.grant implies not(sameGoogleGrant(captured, observed))
pure def lawVisionDoesNotPublishAfterAccountChange(captured: HostAuthority, observed: HostAuthority, cancelled: bool, outboundAllowed: bool, exactAuthority: bool, ambientAttribution: bool): bool = canPublishVision(captured, observed, cancelled, outboundAllowed, exactAuthority, ambientAttribution) implies sameHost(captured, observed) and not(cancelled) and exactAuthority and not(ambientAttribution)
```

### A Clef suggestion can increase the need for review

Grace's stop-and-ask rule combines its product floor with Clef from
`createClefDecisionsClient`. Unavailable or timed-out Cloud returns the
floor. Explicit caller cancellation propagates. A suggestion can raise
Tell to Ask. It cannot lower Ask. Clef evaluates bounded requests and
returns a typed decision for the same requested kind.

```quint
type ReviewMode = Ask | Tell
type ReviewSuggestion = SuggestAsk | SuggestTell | SuggestUnavailable
pure def resolveReviewMode(floor: ReviewMode, suggestion: ReviewSuggestion): ReviewMode = if (floor == Ask or suggestion == SuggestAsk) Ask else Tell
pure def lawAskFloorCannotBeLowered(suggestion: ReviewSuggestion): bool = resolveReviewMode(Ask, suggestion) == Ask
pure def lawUnavailableClefKeepsFloor(floor: ReviewMode): bool = resolveReviewMode(floor, SuggestUnavailable) == floor
```
