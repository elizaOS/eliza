# Checked bill extraction and source selection

## Story: Use an unambiguous bill from the connected account

Reviewed profiles and fields come from trusted product configuration.
`bill-extraction-profile.mjs` requires unique nonoverlapping labels, required
invoice, company, HTTPS canonical origin, account label and amount fields.
Due date and service address may be absent. A service period requires both
valid dates in order. The amount parser uses integer minor units and a
configured currency scale of zero through four. Conflicting duplicates,
oversized text, invalid dates and unsafe integers fail explicitly.
`parseDocument` requires complete, sequential pages and reads every page.

### Complete source, cover message, and rejected extraction are distinct results

The decoder supplies syntax evidence for text, labels, dates, URLs and minor
units. The decision below checks what can be accepted and when an incomplete
message may act as a PDF cover. An unrecognized message can yield no
candidate. An unrecognized document fails, as does a partial message that
specifically contradicts the expected account or biller.

```quint
type SourceKind = MessageSource | DocumentSource
type ExtractionFacts = { sourceKind: SourceKind, validProfile: bool, fullInput: bool, validFields: bool, conflicts: bool, recognized: bool, requiredPresent: bool, pdfAttached: bool, onlyIdentityFields: bool, identitiesMatch: bool }
type ExtractionDecision = Candidate | NoCandidate | InvalidSource
pure def extractBill(facts: ExtractionFacts): ExtractionDecision =
  if (not(facts.validProfile and facts.fullInput and facts.validFields) or facts.conflicts) InvalidSource
  else if (facts.recognized and facts.requiredPresent) Candidate
  else if (facts.sourceKind == MessageSource and
    (not(facts.recognized) or (facts.pdfAttached and facts.onlyIdentityFields and facts.identitiesMatch))) NoCandidate
  else InvalidSource
pure def lawDocumentCannotYieldPartial(facts: ExtractionFacts): bool =
  facts.sourceKind == DocumentSource and not(facts.fullInput and facts.recognized and facts.requiredPresent)
  implies extractBill(facts) == InvalidSource
pure def lawConflictingFieldsCannotYieldCandidate(facts: ExtractionFacts): bool =
  facts.conflicts implies extractBill(facts) == InvalidSource
pure def lawMismatchedPdfCoverIsInvalid(facts: ExtractionFacts): bool =
  facts.sourceKind == MessageSource and facts.recognized and not(facts.requiredPresent) and not(facts.identitiesMatch)
  implies extractBill(facts) == InvalidSource
pure val readyText: ExtractionFacts = { sourceKind: MessageSource, validProfile: true, fullInput: true, validFields: true, conflicts: false, recognized: true, requiredPresent: true, pdfAttached: false, onlyIdentityFields: false, identitiesMatch: true }
pure val factsValues = Set(readyText,
  { ...readyText, sourceKind: DocumentSource, fullInput: false },
  { ...readyText, sourceKind: DocumentSource },
  { ...readyText, conflicts: true },
  { ...readyText, requiredPresent: false, pdfAttached: true, onlyIdentityFields: true },
  { ...readyText, requiredPresent: false, pdfAttached: true, onlyIdentityFields: true, identitiesMatch: false })
```

## Story: Choose exactly one discovered source and replay the same choice safely

### An offer is scoped to the owner, task, epoch, revision and fresh discovery

`createBillSourceStore` offers before observation or operation preparation.
The mutation runs in a database transaction with an owner check. The fresh
result must have the same normalized digest as the stored offer and contain
the wanted candidate. Expiry is exclusive at 300,000 ms after the offer.
A selected candidate is revalidated when loaded. An invalid stored candidate
blocks selection. The same valid stored choice may be replayed even after expiry or task progression. A different candidate
requires a different task. The database, clock, and candidate normalization
supply the evidence captured in the two records below.

```quint
type SourceOffer = { owner: str, taskId: str, epoch: int, revision: int, offerId: str, expiration: int, digest: str, conflict: bool, candidateIds: List[str] }
type SelectionInput = { owner: str, taskId: str, epoch: int, revision: int, offerId: str, timestamp: int, digest: str, candidateId: str, editable: bool, freshValid: bool }
type StoredChoice = { offerId: str, candidateId: str, present: bool, valid: bool }
type SelectionResult = NewChoice | ReplayChoice | StaleChoice

pure def selectBill(offer: SourceOffer, choice: StoredChoice, selection: SelectionInput): SelectionResult =
  if (selection.owner != offer.owner or selection.taskId != offer.taskId) StaleChoice
  else if (choice.present) {
    if (choice.valid and choice.offerId == selection.offerId and choice.candidateId == selection.candidateId) ReplayChoice
    else StaleChoice
  } else if (selection.editable and selection.freshValid and not(offer.conflict) and
    selection.epoch == offer.epoch and selection.revision == offer.revision and
    selection.offerId == offer.offerId and selection.timestamp < offer.expiration and
    selection.digest == offer.digest and offer.candidateIds.includes(selection.candidateId)) NewChoice
  else StaleChoice
pure def lawForeignOwnerCannotSelect(offer: SourceOffer, choice: StoredChoice, selection: SelectionInput): bool =
  (selection.owner != offer.owner or selection.taskId != offer.taskId) implies selectBill(offer, choice, selection) == StaleChoice
pure def lawExpiredOfferCannotCreateChoice(offer: SourceOffer, choice: StoredChoice, selection: SelectionInput): bool =
  selection.timestamp >= offer.expiration implies selectBill(offer, choice, selection) != NewChoice
pure def lawFreshDiscoveryCannotChange(offer: SourceOffer, choice: StoredChoice, selection: SelectionInput): bool =
  (not(selection.freshValid) or selection.digest != offer.digest or offer.conflict)
  implies selectBill(offer, choice, selection) != NewChoice
pure def lawChosenCandidateIsStable(offer: SourceOffer, choice: StoredChoice, selection: SelectionInput): bool =
  choice.present implies (selectBill(offer, choice, selection) != NewChoice and
  (selectBill(offer, choice, selection) == ReplayChoice implies choice.valid and choice.offerId == selection.offerId and choice.candidateId == selection.candidateId))
pure val ownedOffer: SourceOffer = { owner: "ownerA", taskId: "bill", epoch: 1, revision: 2, offerId: "offer", expiration: 300000, digest: "fresh", conflict: false, candidateIds: List("invoice") }
pure val matchingSelection: SelectionInput = { owner: "ownerA", taskId: "bill", epoch: 1, revision: 2, offerId: "offer", timestamp: 0, digest: "fresh", candidateId: "invoice", editable: true, freshValid: true }
pure val offerValues = Set(ownedOffer, { ...ownedOffer, conflict: true })
pure val choiceValues = Set(
  { offerId: "", candidateId: "", present: false, valid: false },
  { offerId: "offer", candidateId: "invoice", present: true, valid: true },
  { offerId: "offer", candidateId: "invoice", present: true, valid: false })
pure val selectionValues = Set(matchingSelection, { ...matchingSelection, owner: "ownerB" },
  { ...matchingSelection, timestamp: 300000 }, { ...matchingSelection, digest: "changed" },
  { ...matchingSelection, candidateId: "missing" })
```

## Story: Finish discovery before reporting a current bill

### A partial mailbox or document read cannot select an older bill

The pinned `BillSourceDiscovery.discover` checks connected-account
authorization before and after each I/O step and before publishing. It
validates sender, recipient, time window and detail identity. It follows
all unique pagination tokens, merges identical invoice versions and
marks conflicting versions as ambiguous. Candidate display is newest
first. A newer unreadable item blocks an older candidate. A repeated
pagination token or incomplete eligible attachment hides all partial
candidates. Malformed pages, superseded authority and mailbox transport
failure return a typed unavailable error. The returned facts below
represent the completed collector, with no guessed bill from a partial
scan.

```quint
type DiscoveryFacts = { currentOwner: bool, validPages: bool, fullScan: bool, completeAttachments: bool, candidateCount: int, newerUnreadable: bool, invoiceConflict: bool, scopeConflict: bool, unreadable: bool }
type DiscoveryStatus = DiscoverUnavailable | DiscoverIncomplete | DiscoverAmbiguous | DiscoverCandidate | DiscoverSourceConflict | DiscoverMissing
pure def discoveryResult(found: DiscoveryFacts): DiscoveryStatus =
  if (not(found.currentOwner and found.validPages) or found.candidateCount < 0) DiscoverUnavailable
  else if (not(found.fullScan and found.completeAttachments) or (found.candidateCount > 0 and found.newerUnreadable)) DiscoverIncomplete
  else if (found.invoiceConflict or found.candidateCount > 1) DiscoverAmbiguous
  else if (found.candidateCount == 1) DiscoverCandidate
  else if (found.scopeConflict) DiscoverSourceConflict
  else if (found.unreadable) DiscoverIncomplete
  else DiscoverMissing
pure def lawOnlyCompleteCurrentSearchOffersOne(found: DiscoveryFacts): bool =
  discoveryResult(found) == DiscoverCandidate implies found.currentOwner and found.validPages and found.fullScan and
  found.completeAttachments and not(found.newerUnreadable) and not(found.invoiceConflict) and found.candidateCount == 1
pure def lawConflictingInvoiceIsNeverUnique(found: DiscoveryFacts): bool =
  found.invoiceConflict implies discoveryResult(found) != DiscoverCandidate
pure def lawSearchFailureCannotLookMissing(found: DiscoveryFacts): bool =
  not(found.currentOwner and found.validPages and found.fullScan and found.completeAttachments) implies discoveryResult(found) != DiscoverMissing
pure val uniqueDiscovery: DiscoveryFacts = { currentOwner: true, validPages: true, fullScan: true, completeAttachments: true, candidateCount: 1, newerUnreadable: false, invoiceConflict: false, scopeConflict: false, unreadable: false }
pure val foundValues = Set(uniqueDiscovery, { ...uniqueDiscovery, newerUnreadable: true },
  { ...uniqueDiscovery, fullScan: false }, { ...uniqueDiscovery, currentOwner: false },
  { ...uniqueDiscovery, candidateCount: 2, invoiceConflict: true },
  { ...uniqueDiscovery, candidateCount: 0, scopeConflict: true })
```
