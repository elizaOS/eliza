# Grace assisted bill boundary

## Story: Open, review and recover a bill in the same authenticated task

The checked-bill path follows the authenticated account's committed
choice. Generic website guidance without a discovered bill does not
require source selection.
The task gateway owns the live account epoch. Discovery owns the checked
bill candidate. The website guide owns whether it may show an instruction
for a payment control, and the pinned code records a provider result
before releasing the task. This specification imports the existing
decision functions to describe which facts must line up across boundaries.
The payment-pointer condition is the downstream requirement across the
two helper paths. The configured helper's earlier-review warning remains
a known compatibility decision at the pin.

### Every browser pointer is for the account and source of the current task

A complete source selection is required before the payment review may
start. The choice can be newly committed or an exact replay of the
stored selection. A new choice counts here only after the database
acknowledges the selection transaction. At the next boundary the
owner fence and committed selection must refer to the same task.
The current page's own authority, confirmation and history checks
still govern the pointer.

```quint
import taskOwner as O from "./taskOwner"
import billSource as B from "./billSource"
import paymentGuidance as P from "./paymentGuidance"
type PageAuthority = { request: O::RequestFence, observedTaskId: str, currentTask: bool, exactControl: bool }
pure def committedSelection(offer: B::SourceOffer, choice: B::StoredChoice, selection: B::SelectionInput, choiceCommitted: bool): bool =
  choiceCommitted and B::selectBill(offer, choice, selection) != B::StaleChoice
pure def permitsPaymentPointer(
  fence: O::OwnerFence, page: PageAuthority, offer: B::SourceOffer,
  choice: B::StoredChoice, selection: B::SelectionInput, choiceCommitted: bool,
  facts: P::PaymentPointerFacts
): bool =
  O::permitsReply(fence, page.request) and page.currentTask and page.exactControl and
  page.request.owner == selection.owner and page.observedTaskId == selection.taskId and
  committedSelection(offer, choice, selection, choiceCommitted) and
  P::pointerDecision(facts) == P::PointToHumanControl
pure def lawPointerCannotCrossAccount(
  fence: O::OwnerFence, page: PageAuthority, offer: B::SourceOffer,
  choice: B::StoredChoice, selection: B::SelectionInput, choiceCommitted: bool,
  facts: P::PaymentPointerFacts
): bool =
  permitsPaymentPointer(fence, page, offer, choice, selection, choiceCommitted, facts)
  implies fence.owner == offer.owner and fence.owner == selection.owner and page.observedTaskId == offer.taskId
pure def lawStaleTaskCannotShowPointer(
  fence: O::OwnerFence, page: PageAuthority, offer: B::SourceOffer,
  choice: B::StoredChoice, selection: B::SelectionInput, choiceCommitted: bool,
  facts: P::PaymentPointerFacts
): bool =
  page.request.epoch != fence.epoch implies
  not(permitsPaymentPointer(fence, page, offer, choice, selection, choiceCommitted, facts))
pure def lawUnknownPriorPaymentNeedsAnswer(
  fence: O::OwnerFence, page: PageAuthority, offer: B::SourceOffer,
  choice: B::StoredChoice, selection: B::SelectionInput, choiceCommitted: bool,
  facts: P::PaymentPointerFacts
): bool =
  (facts.priorMatch and not(facts.priorAnswerCurrent)) implies
  not(permitsPaymentPointer(fence, page, offer, choice, selection, choiceCommitted, facts))
pure val liveFence: O::OwnerFence = { ...O::initialFence, owner: "ownerA", epoch: 1 }
pure val fenceValues = Set(liveFence, { ...liveFence, owner: "ownerB" }, { ...liveFence, epoch: 2 })
pure val currentPage: PageAuthority = { request: { owner: "ownerA", epoch: 1 }, observedTaskId: "bill", currentTask: true, exactControl: true }
pure val pageValues = Set(currentPage, { ...currentPage, observedTaskId: "other" }, { ...currentPage, exactControl: false })
```

### A receipt is a result of the provider rather than of a pointer

The host does not press the payment control. The provider may return a
receipt after the app closes, may show processing, or may provide no
reliable evidence. The [bill outcome model](./billReview.md) owns the
durable journal, row, and completion handoff. A receipt may be named to
the renderer only in a response for its owning request. A committed
receipt remains recorded even when its response becomes stale.

```quint
type DeliveryFacts = { request: O::RequestFence, recordOwner: str, providerEvidence: bool, persistedRow: bool, releasedTask: bool }
pure def permitsSavedReceipt(fence: O::OwnerFence, delivery: DeliveryFacts): bool =
  O::permitsReply(fence, delivery.request) and delivery.recordOwner == delivery.request.owner and
  delivery.providerEvidence and delivery.persistedRow and delivery.releasedTask
pure def lawSavedReceiptRequiresProviderEvidence(fence: O::OwnerFence, delivery: DeliveryFacts): bool =
  permitsSavedReceipt(fence, delivery) implies delivery.providerEvidence and delivery.persistedRow and delivery.releasedTask
pure def lawReceiptCannotCrossAccount(fence: O::OwnerFence, delivery: DeliveryFacts): bool =
  fence.owner != delivery.recordOwner implies not(permitsSavedReceipt(fence, delivery))
pure val savedReceipt: DeliveryFacts = { request: { owner: "ownerA", epoch: 1 }, recordOwner: "ownerA", providerEvidence: true, persistedRow: true, releasedTask: true }
pure val deliveryValues = Set(savedReceipt, { ...savedReceipt, providerEvidence: false },
  { ...savedReceipt, recordOwner: "ownerB" }, { ...savedReceipt, releasedTask: false })
```
