# Bill response admission

`readBillDecision` and `readBillSourceOffer` from the pinned
`plugins/plugin-personal-assistant/native-host/bill-client.ts` validate and
detach the decision shown to the person. They do not perform a task,
persist a receipt or prove that a provider made a payment.

## Story: Reject a bill choice or review that does not belong to the panel

### A method choice matches the task and review context

The wire admits source-selection-required, blocked, human-sign-in,
human-verification, human-review, choose-existing-method, choice-pending,
submission-pending, human-submit, outcome, prior-outcome, paused,
unknown-outcome and unavailable. Human Submit and Choose Existing Method
require a validated review and its 64-character lowercase hex key. An
existing-method widget is additionally validated against the requested
task ID and the decision's review key. A conflict belongs only to a
blocked result. A verification-reason token belongs only to a verification
result. Other decision fields retain the source decoder's checked types.

A review's three monetary fields are nonnegative safe integers, its
currency is three uppercase letters and its scale is 0–4. The product
money validator also checks each amount. Review dates must round-trip
as real calendar days. The optional outcome date uses the source's
date-shape check. The source accepts `saved` and `pending` as the only
present save statuses. It checks email and ended flags as booleans and
does not infer them from payment evidence. The model selects which value
may reach the panel after these field checks. The host retains receipt
authority.

```quint
type BillWireKind = WireSourceSelection | WireBlocked | WireSignIn | WireVerification | WireHumanReview | WireChooseMethod | WireChoicePending | WireSubmissionPending | WireHumanSubmit | WireOutcome | WirePriorOutcome | WirePaused | WireUnknown | WireUnavailable | WireUnsupported
type BillSaveStatus = WireSaveAbsent | WireSaved | WireSavePending | WireSaveUnsupported
type BillWire = { wireKind: BillWireKind, valueFieldsValid: bool, sourceLinksValid: bool, reviewPresent: bool, reviewValid: bool, reviewKey: str, choiceValid: bool, choiceTaskId: str, choiceContext: str, conflictPresent: bool, conflictValid: bool, codeReasonPresent: bool, codeReasonKnown: bool, saveKind: BillSaveStatus, detachable: bool }
pure def reviewRequired(wireKind: BillWireKind): bool =
  wireKind == WireChooseMethod or wireKind == WireHumanSubmit
pure def billDecisionAdmitted(wire: BillWire, wantedTaskId: str): bool =
  wire.wireKind != WireUnsupported and wire.valueFieldsValid and wire.sourceLinksValid and
  wire.detachable and wire.saveKind != WireSaveUnsupported and
  (reviewRequired(wire.wireKind) implies wire.reviewPresent) and
  (wire.reviewPresent implies wire.reviewValid) and
  (wire.wireKind == WireChooseMethod implies
    wire.choiceValid and wire.choiceTaskId == wantedTaskId and wire.choiceContext == wire.reviewKey) and
  (wire.conflictPresent implies wire.wireKind == WireBlocked and wire.conflictValid) and
  (wire.codeReasonPresent implies wire.wireKind == WireVerification and wire.codeReasonKnown)
pure def lawChoiceCannotCrossTaskOrReview(wire: BillWire, wantedTaskId: str): bool =
  billDecisionAdmitted(wire, wantedTaskId) and wire.wireKind == WireChooseMethod implies
  wire.choiceTaskId == wantedTaskId and wire.choiceContext == wire.reviewKey and wire.choiceValid
pure def lawSubmitReviewIsRequired(wire: BillWire, wantedTaskId: str): bool =
  billDecisionAdmitted(wire, wantedTaskId) and wire.wireKind == WireHumanSubmit implies wire.reviewPresent and wire.reviewValid
pure def showSavedReceipt(wire: BillWire, wantedTaskId: str): bool =
  billDecisionAdmitted(wire, wantedTaskId) and wire.wireKind == WireOutcome and wire.saveKind == WireSaved
pure def lawPartialReceiptStaysPending(wire: BillWire, wantedTaskId: str): bool =
  wire.saveKind == WireSavePending implies not(showSavedReceipt(wire, wantedTaskId))
pure val checkedWire: BillWire = { wireKind: WireChooseMethod, valueFieldsValid: true, sourceLinksValid: true, reviewPresent: true, reviewValid: true, reviewKey: "review1", choiceValid: true, choiceTaskId: "taskA", choiceContext: "review1", conflictPresent: false, conflictValid: true, codeReasonPresent: false, codeReasonKnown: true, saveKind: WireSaveAbsent, detachable: true }
pure val wireValues = Set(checkedWire, { ...checkedWire, choiceTaskId: "taskB" },
  { ...checkedWire, choiceContext: "review2" }, { ...checkedWire, reviewPresent: false },
  { ...checkedWire, wireKind: WireHumanSubmit, reviewPresent: false },
  { ...checkedWire, wireKind: WireOutcome, saveKind: WireSavePending },
  { ...checkedWire, wireKind: WireOutcome, saveKind: WireSaveUnsupported },
  { ...checkedWire, wireKind: WireBlocked, conflictPresent: true, conflictValid: false })
pure val wantedTaskIdValues = Set("taskA", "taskB")
```

## Story: Present an offered bill source without erasing why the search stopped

### A detached offer preserves its status and recognized reason

The offer ID is a bounded UUID-style string of 36 lowercase hex and
hyphen characters. The revision is a nonnegative safe integer and
expiry is a safe integer. There are at most 100 candidates. Each must
have valid invoice identities, normalized monetary facts, canonical
HTTPS origin and at least one validated source link. An unreadable
count, when present, is positive. Conflict detail is bounded at seven
records with canonical field ordering. The source accepts the two
specific reason/status pairs below. Presence of either reason disables
selection in the panel. Shape, field syntax and cloning success are
supplied by the wire decoder.

```quint
type OfferWireStatus = WireCandidate | WireAmbiguous | WireMissing | WireIncomplete | WireConflict | WireOtherStatus
type OfferWireReason = WireNoReason | WireConflictingInvoice | WireNewerUnreadable | WireOtherReason
type OfferWire = { offerKind: OfferWireStatus, reasonKind: OfferWireReason, headerValid: bool, candidatesValid: bool, candidateCount: int, notesValid: bool, detachable: bool }
pure def matchedReason(offerWire: OfferWire): bool =
  offerWire.reasonKind == WireNoReason or
  (offerWire.reasonKind == WireConflictingInvoice and offerWire.offerKind == WireAmbiguous) or
  (offerWire.reasonKind == WireNewerUnreadable and offerWire.offerKind == WireIncomplete)
pure def billOfferAdmitted(offerWire: OfferWire): bool =
  offerWire.offerKind != WireOtherStatus and matchedReason(offerWire) and offerWire.headerValid and
  offerWire.notesValid and offerWire.candidatesValid and offerWire.candidateCount >= 0 and
  offerWire.candidateCount <= 100 and offerWire.detachable
pure def mayOfferChoice(offerWire: OfferWire, beforeExpiry: bool, candidatePresent: bool): bool =
  billOfferAdmitted(offerWire) and offerWire.reasonKind == WireNoReason and beforeExpiry and candidatePresent and
  (offerWire.offerKind == WireCandidate or offerWire.offerKind == WireAmbiguous)
pure def lawConflictCannotBeSelected(offerWire: OfferWire, beforeExpiry: bool, candidatePresent: bool): bool =
  offerWire.reasonKind == WireConflictingInvoice implies not(mayOfferChoice(offerWire, beforeExpiry, candidatePresent))
pure def lawIncompleteCannotBeSelected(offerWire: OfferWire, beforeExpiry: bool, candidatePresent: bool): bool =
  offerWire.offerKind == WireIncomplete implies not(mayOfferChoice(offerWire, beforeExpiry, candidatePresent))
pure def lawOversizedOfferIsRejected(offerWire: OfferWire): bool =
  offerWire.candidateCount > 100 implies not(billOfferAdmitted(offerWire))
pure val checkedOffer: OfferWire = { offerKind: WireCandidate, reasonKind: WireNoReason, headerValid: true, candidatesValid: true, candidateCount: 1, notesValid: true, detachable: true }
pure val offerWireValues = Set(checkedOffer, { ...checkedOffer, candidateCount: 101 },
  { ...checkedOffer, offerKind: WireIncomplete, reasonKind: WireNewerUnreadable, candidateCount: 0 },
  { ...checkedOffer, offerKind: WireAmbiguous, reasonKind: WireConflictingInvoice, candidateCount: 2 },
  { ...checkedOffer, offerKind: WireIncomplete, reasonKind: WireConflictingInvoice },
  { ...checkedOffer, candidatesValid: false })
```
