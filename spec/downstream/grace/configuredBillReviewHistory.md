# Configured bill review records and history

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` binds the configured helper to `plugins/plugin-personal-assistant/native-host/bill-outcome-store.mjs` and `bill-workflow.mjs` at Eliza `7743504b7c936a764b3938a44cad918808b621df`. This contract models the configured helper's durable review row and its distinction from evidence of a submission or provider outcome. The optional configured helper and the release website guide use different stores. The latter's payment-step history has its own specification.

## Story: Keep the review attached to the control and account that produced it

### A bound review is saved and read back before the person is shown a payment pointer

The pinned workflow derives a review key from the provider review key, task ID, epoch, browser document ID, and input revision. It rechecks authorization and abort before invoking the store. The store requires the owned task, a `human-submit` decision, a matching task observation, a snapshot document ID, and the task's current epoch. It parses and removes the snapshot URL's query and fragment. The resulting source must be credential-free HTTPS on an allowed origin. These checks precede looking up any earlier row.

The stored record needs a lowercase 64-digit hex key, nonempty document ID of at most 256 UTF-16 units, nonnegative safe epoch and timestamp, a matching cleaned review source, and a nonempty bill source of at most 512 units. Its nonnegative safe integer amount and fee sum to the total. Currency is three uppercase ASCII letters and scale 0–4. Payment date is explicit null or a valid round-tripped calendar day. Company, account label and method are nonempty strings of at most 300 units. The method rejects twelve successive digits separated only by optional spaces or hyphens. The model uses source, key, calendar and display-field validation facts supplied by the codec. The stored source is computed from the snapshot and replaces the candidate's source field.

```quint
type ReviewShape = { lowerHexKey: bool, documentUnits: int, epoch: int, observedAt: int, sourceValid: bool, sourceMatches: bool, billSourceUnits: int, amountMinor: int, feeMinor: int, totalMinor: int, upperCurrency: bool, currencyDigits: int, nullOrCalendarDay: bool, detailsAdmitted: bool, maskedMethod: bool }
type ReviewAdmission = { taskOwned: bool, humanSubmit: bool, observationMatches: bool, hasDocument: bool, epochMatches: bool, epochSafe: bool, snapshotSourceAllowed: bool, previousValidOrAbsent: bool, sameReviewKey: bool, reviewed: ReviewShape, readbackMatches: bool }
type ReviewResult = ReviewTaskRefused | ReviewObservationRefused | ReviewSourceRefused | ExistingReviewUnreadable | ReusedReview | InvalidReviewRecord | ReviewWriteUnconfirmed | ReviewSaved
pure def safeReviewCounter(number: int): bool = number >= 0 and number <= 9007199254740991
pure def reviewMoneyValid(reviewed: ReviewShape): bool =
  safeReviewCounter(reviewed.amountMinor) and safeReviewCounter(reviewed.feeMinor) and safeReviewCounter(reviewed.totalMinor) and reviewed.amountMinor <= reviewed.totalMinor and reviewed.feeMinor == reviewed.totalMinor - reviewed.amountMinor
pure def storedReviewValid(reviewed: ReviewShape): bool =
  reviewed.lowerHexKey and reviewed.documentUnits >= 1 and reviewed.documentUnits <= 256 and safeReviewCounter(reviewed.epoch) and safeReviewCounter(reviewed.observedAt) and reviewed.sourceValid and reviewed.sourceMatches and reviewed.billSourceUnits >= 1 and reviewed.billSourceUnits <= 512 and reviewMoneyValid(reviewed) and reviewed.upperCurrency and reviewed.currencyDigits >= 0 and reviewed.currencyDigits <= 4 and reviewed.nullOrCalendarDay and reviewed.detailsAdmitted and reviewed.maskedMethod
pure def currentReviewObservation(admission: ReviewAdmission): bool =
  admission.humanSubmit and admission.observationMatches and admission.hasDocument and admission.epochMatches and admission.epochSafe
pure def reviewAdmission(admission: ReviewAdmission): ReviewResult =
  if (not(admission.taskOwned)) ReviewTaskRefused
  else if (not(currentReviewObservation(admission))) ReviewObservationRefused
  else if (not(admission.snapshotSourceAllowed)) ReviewSourceRefused
  else if (not(admission.previousValidOrAbsent)) ExistingReviewUnreadable
  else if (admission.sameReviewKey) ReusedReview
  else if (not(storedReviewValid(admission.reviewed))) InvalidReviewRecord
  else if (not(admission.readbackMatches)) ReviewWriteUnconfirmed
  else ReviewSaved
pure def reviewAllowsPointer(admission: ReviewAdmission, authorizedNow: bool, aborted: bool): bool =
  authorizedNow and not(aborted) and (reviewAdmission(admission) == ReviewSaved or reviewAdmission(admission) == ReusedReview)
pure def lawNewReviewPointerRequiresReadback(admission: ReviewAdmission, authorizedNow: bool, aborted: bool): bool =
  reviewAllowsPointer(admission, authorizedNow, aborted) and not(admission.sameReviewKey) implies storedReviewValid(admission.reviewed) and admission.readbackMatches
pure def lawReviewPointerRequiresCurrentFence(admission: ReviewAdmission, authorizedNow: bool, aborted: bool): bool =
  reviewAllowsPointer(admission, authorizedNow, aborted) implies admission.taskOwned and authorizedNow and not(aborted) and currentReviewObservation(admission) and admission.snapshotSourceAllowed and admission.previousValidOrAbsent
pure def lawCorruptOwnReviewCannotBeReplacedSilently(admission: ReviewAdmission): bool =
  not(admission.previousValidOrAbsent) implies reviewAdmission(admission) != ReviewSaved and reviewAdmission(admission) != ReusedReview
pure val checkedReview: ReviewShape = { lowerHexKey: true, documentUnits: 12, epoch: 1, observedAt: 1000, sourceValid: true, sourceMatches: true, billSourceUnits: 40, amountMinor: 8400, feeMinor: 20, totalMinor: 8420, upperCurrency: true, currencyDigits: 2, nullOrCalendarDay: true, detailsAdmitted: true, maskedMethod: true }
pure val reviewReady: ReviewAdmission = { taskOwned: true, humanSubmit: true, observationMatches: true, hasDocument: true, epochMatches: true, epochSafe: true, snapshotSourceAllowed: true, previousValidOrAbsent: true, sameReviewKey: false, reviewed: checkedReview, readbackMatches: true }
pure val admissionValues = Set(reviewReady, { ...reviewReady, taskOwned: false }, { ...reviewReady, epochMatches: false }, { ...reviewReady, observationMatches: false }, { ...reviewReady, snapshotSourceAllowed: false }, { ...reviewReady, readbackMatches: false }, { ...reviewReady, previousValidOrAbsent: false }, { ...reviewReady, sameReviewKey: true, reviewed: { ...checkedReview, totalMinor: 0 } }, { ...reviewReady, reviewed: { ...checkedReview, maskedMethod: false } })
```

### A task retains one owned review and has no pending review journal

`bill_reviews_v1` has one row per task ID. A repeat of the stored key, after checking the current observation and validating the previous row, returns immediately. It retains the stored document, values and timestamp even when the proposed values changed. A different key for the same owner replaces the row. An existing row belonging to another owner is never replaced. The current owner cannot read it. The source performs an exact document readback after a new write. A missing or different readback fails; the outcome of any write is then checked independently of whether guidance was delivered. No outcome journal or pending map owns these review rows. After reopening, the stored row is read and validated against the task's allowed origins; current observation and epoch equality are write checks rather than load checks. A load can fail explicitly on corrupt JSON or invalid stored values instead of becoming no review.

```quint
type ReviewWrite = NoReviewWrite | InsertReviewRow | ReplaceReviewRow | CheckReviewConflict
pure def reviewWrite(previousExists: bool, sameStoredOwner: bool, sameKey: bool): ReviewWrite =
  if (not(previousExists)) InsertReviewRow
  else if (not(sameStoredOwner)) CheckReviewConflict
  else if (sameKey) NoReviewWrite
  else ReplaceReviewRow
pure def lawSameKeyNeverRewrites(previousExists: bool, sameStoredOwner: bool, sameKey: bool): bool =
  previousExists and sameStoredOwner and sameKey implies reviewWrite(previousExists, sameStoredOwner, sameKey) == NoReviewWrite
pure def lawOtherOwnerRowNeverReplaced(previousExists: bool, sameStoredOwner: bool, sameKey: bool): bool =
  previousExists and not(sameStoredOwner) implies reviewWrite(previousExists, sameStoredOwner, sameKey) == CheckReviewConflict
```

## Story: Preserve the distinction between review history and payment history

### The pinned payment lookup never treats a review by itself as a submission

`hasPriorPayment` reads other tasks' attempts and outcomes for the owner, requiring the same checked bill source and origin. It includes pending writes. Each matching pending record must still have its task. The durable query has no corresponding existence filter on the candidate task, but ownership of the requesting task is required. `hasPriorOutcome` ignores attempts. The configured workflow combines `hasPriorPayment` with this task's own attempt. Grace `afterDecline` requires `hasPriorPayment` to return exactly false before it can reconsider a new observed review on the special decline path. A review row must not change that predicate. This rule models matching after record decoding. Malformed history and a missing requesting task fail upstream.

```quint
type HistoryKind = SavedReviewEvidence | PendingAttemptEvidence | StoredAttemptEvidence | PendingOutcomeEvidence | StoredOutcomeEvidence
type HistoryEntry = { kind: HistoryKind, sameOwner: bool, otherTask: bool, sameBillSource: bool, sameOrigin: bool, taskStillExists: bool }
pure def isOutcome(entry: HistoryEntry): bool = entry.kind == PendingOutcomeEvidence or entry.kind == StoredOutcomeEvidence
pure def isPending(entry: HistoryEntry): bool = entry.kind == PendingAttemptEvidence or entry.kind == PendingOutcomeEvidence
pure def countsAsPriorPayment(entry: HistoryEntry, outcomesOnly: bool): bool =
  entry.sameOwner and entry.otherTask and entry.sameBillSource and entry.sameOrigin and entry.kind != SavedReviewEvidence and (not(outcomesOnly) or isOutcome(entry)) and (not(isPending(entry)) or entry.taskStillExists)
pure def lawAReviewDoesNotEstablishPayment(entry: HistoryEntry, outcomesOnly: bool): bool =
  entry.kind == SavedReviewEvidence implies not(countsAsPriorPayment(entry, outcomesOnly))
pure def lawUnknownPendingTaskCannotEstablishPayment(entry: HistoryEntry, outcomesOnly: bool): bool =
  isPending(entry) and not(entry.taskStillExists) implies not(countsAsPriorPayment(entry, outcomesOnly))
pure def lawPriorOutcomeRequiresOutcome(entry: HistoryEntry): bool = countsAsPriorPayment(entry, true) implies isOutcome(entry)
```

### The proposed review lookup is a separate compatibility decision

Grace's targeted TODO in `apps/app/test/website-guide-prior-payment.test.mjs:218` asks for a separate `hasPriorReview` operation. At the pinned Eliza revision the bound store has no such method. The stated cases establish an earlier review of the same bill by a different owned task as a possible warning, with no effect on payment history. The extension model captures that minimum over already validated review rows. The TODO does not specify whether matching additionally requires the original site, whether an orphaned but still stored row counts, how malformed historical rows affect a lookup, or when the configured helper must interrupt presentation. Those remain open compatibility decisions. A proposed warning carries no evidence that the provider received a payment.

```quint
pure def reviewWarningCandidate(entry: HistoryEntry): bool = entry.kind == SavedReviewEvidence and entry.sameOwner and entry.otherTask and entry.sameBillSource
pure def lawReviewCandidateIsNeverPayment(entry: HistoryEntry, outcomesOnly: bool): bool = reviewWarningCandidate(entry) implies not(countsAsPriorPayment(entry, outcomesOnly))
pure def lawReviewCandidateRequiresAnotherOwnedTask(entry: HistoryEntry): bool = reviewWarningCandidate(entry) implies entry.sameOwner and entry.otherTask
pure def lawOtherBillCannotSupplyReviewWarning(entry: HistoryEntry): bool = not(entry.sameBillSource) implies not(reviewWarningCandidate(entry))
pure val observedReview: HistoryEntry = { kind: SavedReviewEvidence, sameOwner: true, otherTask: true, sameBillSource: true, sameOrigin: true, taskStillExists: true }
pure val entryValues = Set(observedReview, { ...observedReview, otherTask: false }, { ...observedReview, sameBillSource: false }, { ...observedReview, sameOwner: false }, { ...observedReview, sameOrigin: false }, { ...observedReview, kind: PendingAttemptEvidence, taskStillExists: false }, { ...observedReview, kind: StoredAttemptEvidence, taskStillExists: false }, { ...observedReview, kind: PendingOutcomeEvidence }, { ...observedReview, kind: StoredOutcomeEvidence })
```
