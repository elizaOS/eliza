# Bill review, provider evidence, and record recovery

Sources at Grace's pin are `bill-workflow.mjs`, `bill-controls.mjs`, and
`bill-outcome-store.mjs` under `plugins/plugin-personal-assistant/native-host`.
Grace adapts them in `apps/app/host/bill-helper-host.ts`. This machine is
one task's review and outcome projection. The interactive-task kernel owns
its browser dispatch and authorization. The provider owns actual payment.

## Story: Review a bill before pressing the provider's payment control

### A fresh owned observation and a durable review precede a payment pointer

A review binds the bill and task to the observation's epoch, document and
input revision. A prior payment or possibly sent submission stops guidance
toward another payment. The browser may show a receipt that was already
there. When no task history supports attribution, the host records a prior
outcome instead. This projection binds earlier outcomes that have already
been retained by the owner store. Failure to save a prior-outcome record
leaves the source task open and calls for a fresh check. A form event is not a receipt.

The observation boundary supplies the checked domain, account, bill identity
and provenance. It validates the input's task ownership and checks an exact
reviewed control. The pointer asks the person to press the provider control.
The host has no transition that presses Pay.

```quint
type ProviderEvidence = ReviewReady | FormEvidence | PaidEvidence | ScheduledEvidence | UnreadableEvidence
type ProviderRead = { observationEpoch: int, documentId: int, inputRevision: int, ownedBill: bool, exactControl: bool, earlierOutcome: bool, evidence: ProviderEvidence }
type BillView = NoBillView | ReviewOnly | PayPointer | CheckProvider | PriorOutcome | EvidencePending | OutcomeStored
type BillOutcome = NoOutcome | PaidOutcome | ScheduledOutcome
type ReviewLedger = { epoch: int, authorized: bool, review: bool, reviewDocument: int, reviewInput: int, attemptObserved: bool, attemptJournaled: bool, attemptStored: bool, priorRecorded: bool, evidenceValue: BillOutcome, journalValue: BillOutcome, rowValue: BillOutcome, taskReleased: bool, billView: BillView }

pure val noBillOutcome: BillOutcome = NoOutcome
pure val paidBillOutcome: BillOutcome = PaidOutcome
pure val scheduledBillOutcome: BillOutcome = ScheduledOutcome
pure val noBillView: BillView = NoBillView
pure val reviewOnlyView: BillView = ReviewOnly
pure val payPointerView: BillView = PayPointer
pure val checkProviderView: BillView = CheckProvider
pure val priorOutcomeView: BillView = PriorOutcome
pure val evidencePendingView: BillView = EvidencePending
pure val outcomeStoredView: BillView = OutcomeStored
pure val initial: ReviewLedger = { epoch: 1, authorized: true, review: false, reviewDocument: 0, reviewInput: 0, attemptObserved: false, attemptJournaled: false, attemptStored: false, priorRecorded: false, evidenceValue: noBillOutcome, journalValue: noBillOutcome, rowValue: noBillOutcome, taskReleased: false, billView: noBillView }

pure def freshOwnedRead(g: ReviewLedger, read: ProviderRead): bool =
  g.authorized and read.ownedBill and read.observationEpoch == g.epoch
pure def paymentHistory(g: ReviewLedger): bool =
  g.attemptObserved or g.priorRecorded or g.evidenceValue != noBillOutcome or g.journalValue != noBillOutcome or g.rowValue != noBillOutcome
pure def canOfferReview(g: ReviewLedger, read: ProviderRead): bool =
  freshOwnedRead(g, read) and read.evidence == ReviewReady and not(read.earlierOutcome) and not(paymentHistory(g))
pure def offerReview(g: ReviewLedger, read: ProviderRead, recordSucceeded: bool): ReviewLedger =
  if (recordSucceeded) {
    ...g, review: true, reviewDocument: read.documentId, reviewInput: read.inputRevision,
    billView: if (read.exactControl) payPointerView else reviewOnlyView
  } else { ...g, billView: reviewOnlyView }

pure def canObserveEarlierPayment(g: ReviewLedger, read: ProviderRead): bool =
  freshOwnedRead(g, read) and read.earlierOutcome and not(g.priorRecorded) and g.rowValue == noBillOutcome
pure def observeEarlierPayment(g: ReviewLedger, read: ProviderRead): ReviewLedger =
  { ...g, priorRecorded: true, billView: checkProviderView }
pure def canObserveForm(g: ReviewLedger, read: ProviderRead): bool =
  freshOwnedRead(g, read) and read.evidence == FormEvidence and g.rowValue == noBillOutcome
pure def observeForm(g: ReviewLedger, read: ProviderRead): ReviewLedger =
  { ...g, attemptObserved: true, billView: checkProviderView }
pure def canObserveReceipt(g: ReviewLedger, read: ProviderRead): bool =
  freshOwnedRead(g, read) and (read.evidence == PaidEvidence or read.evidence == ScheduledEvidence) and g.evidenceValue == noBillOutcome and g.rowValue == noBillOutcome and g.journalValue == noBillOutcome
pure def observeReceipt(g: ReviewLedger, read: ProviderRead): ReviewLedger =
  if (not(g.review or g.attemptObserved)) { ...g, priorRecorded: true, billView: priorOutcomeView }
  else { ...g, evidenceValue: if (read.evidence == PaidEvidence) paidBillOutcome else scheduledBillOutcome, billView: evidencePendingView }
pure def canLoseStatus(g: ReviewLedger, read: ProviderRead): bool =
  freshOwnedRead(g, read) and paymentHistory(g) and read.evidence == UnreadableEvidence
pure def loseStatus(g: ReviewLedger, read: ProviderRead): ReviewLedger = { ...g, billView: checkProviderView }
pure def canStopReview(g: ReviewLedger): bool = g.authorized
pure def stopReview(g: ReviewLedger): ReviewLedger =
  { ...g, authorized: false, billView: if (paymentHistory(g)) checkProviderView else noBillView }
pure def canResumeReview(g: ReviewLedger): bool = not(g.authorized)
pure def resumeReview(g: ReviewLedger): ReviewLedger = { ...g, authorized: true, epoch: g.epoch + 1 }

pure def alwaysPayPointerIsSafe(g: ReviewLedger): bool =
  g.billView == payPointerView implies g.authorized and g.review and not(paymentHistory(g))
pure def stepObservedAttemptPreventsPointer(before: ReviewLedger, via: str, after: ReviewLedger): bool =
  before.attemptObserved and via != "restartReceipt" implies after.attemptObserved and after.billView != payPointerView
pure def stepDurableAttemptPreventsPointer(before: ReviewLedger, after: ReviewLedger): bool =
  (before.attemptJournaled or before.attemptStored) implies
  (after.attemptJournaled or after.attemptStored) and after.billView != payPointerView
pure def stepKnownPriorPaymentPreventsPointer(before: ReviewLedger, after: ReviewLedger): bool =
  before.priorRecorded implies after.priorRecorded and after.billView != payPointerView
pure def sometimesHumanPayPointer(g: ReviewLedger): bool = g.billView == payPointerView
pure def sometimesUncertainPayment(g: ReviewLedger): bool =
  g.attemptObserved and g.evidenceValue == noBillOutcome and g.billView == checkProviderView
pure def sometimesPriorPayment(g: ReviewLedger): bool = g.billView == priorOutcomeView
```

## Story: Recover a known outcome without repeating payment

### The provider receipt, journal, and row distinguish observed from stored

A failed journal append keeps the observation pending in process. The configured
persistent journal writes and syncs before row insertion. Restart may recover
a journaled result whose insertion did not finish. After row insertion the
host completes the task before returning a saved result. A crash between
those two writes permits retry of completion and never a new payment.
Recovery compacts rows already stored. The first observed submission has its own append and row. A failed attempt
append still permits trying its row. If both writes fail, the browser
activity may be known only in process. Restart recovers a journaled attempt,
and can compact it once a row exists. Recovery of unrecorded form activity
after a process loss depends on fresh native evidence. A provider or person
can independently make a new payment; this ledger proves the host's pointer
behavior after known activity.

```quint
pure def canWriteAttemptJournal(g: ReviewLedger): bool =
  g.attemptObserved and not(g.attemptJournaled) and not(g.attemptStored)
pure def writeAttemptJournal(g: ReviewLedger, writeSucceeded: bool): ReviewLedger =
  { ...g, attemptJournaled: writeSucceeded }
pure def canWriteAttemptRow(g: ReviewLedger): bool = g.attemptObserved and not(g.attemptStored)
pure def writeAttemptRow(g: ReviewLedger, writeSucceeded: bool): ReviewLedger =
  { ...g, attemptStored: writeSucceeded }
pure def alwaysDurableAttemptIsKnown(g: ReviewLedger): bool =
  (g.attemptJournaled or g.attemptStored) implies g.attemptObserved
pure def canAppendReceiptJournal(g: ReviewLedger): bool =
  g.evidenceValue != noBillOutcome and g.journalValue == noBillOutcome and g.rowValue == noBillOutcome
pure def appendReceiptJournal(g: ReviewLedger, writeSucceeded: bool): ReviewLedger =
  { ...g, journalValue: if (writeSucceeded) g.evidenceValue else g.journalValue, billView: evidencePendingView }
pure def canInsertReceipt(g: ReviewLedger): bool =
  g.journalValue != noBillOutcome and g.rowValue == noBillOutcome
pure def insertReceipt(g: ReviewLedger, writeSucceeded: bool): ReviewLedger =
  { ...g, rowValue: if (writeSucceeded) g.journalValue else g.rowValue,
    billView: evidencePendingView }
pure def canFinishReceipt(g: ReviewLedger): bool = g.rowValue != noBillOutcome and not(g.taskReleased)
pure def finishReceipt(g: ReviewLedger, closeSucceeded: bool): ReviewLedger =
  { ...g, taskReleased: closeSucceeded, billView: if (closeSucceeded) outcomeStoredView else evidencePendingView }
pure def restartReceipt(g: ReviewLedger): ReviewLedger =
  { ...g, authorized: false, epoch: g.epoch + 1,
    evidenceValue: if (g.journalValue == noBillOutcome) g.rowValue else g.journalValue,
    attemptObserved: g.attemptJournaled or g.attemptStored,
    attemptJournaled: g.attemptJournaled and not(g.attemptStored),
    journalValue: if (g.rowValue != noBillOutcome) noBillOutcome else g.journalValue,
    billView: if (g.taskReleased) outcomeStoredView
      else if (g.rowValue != noBillOutcome) evidencePendingView
      else if (g.journalValue != noBillOutcome) evidencePendingView
      else if (g.attemptJournaled or g.attemptStored or g.priorRecorded) checkProviderView
      else noBillView }
pure def alwaysJournalKeepsProviderEvidence(g: ReviewLedger): bool =
  g.journalValue != noBillOutcome implies g.journalValue == g.evidenceValue
pure def alwaysReceiptRowRetainsJournalEvidence(g: ReviewLedger): bool =
  g.rowValue != noBillOutcome implies g.rowValue == g.evidenceValue
pure def alwaysReleasedTaskHasDurableRow(g: ReviewLedger): bool =
  g.taskReleased implies g.rowValue != noBillOutcome
pure def alwaysStoredViewHasDurableRow(g: ReviewLedger): bool =
  g.billView == outcomeStoredView implies g.taskReleased
pure def stepRecordedOutcomeIsImmutable(before: ReviewLedger, after: ReviewLedger): bool =
  before.rowValue != noBillOutcome implies before.rowValue == after.rowValue
pure def sometimesDurableAttemptSurvivesRestart(g: ReviewLedger): bool =
  not(g.authorized) and g.attemptObserved and (g.attemptJournaled or g.attemptStored)
pure def sometimesPendingDurableReceipt(g: ReviewLedger): bool =
  g.journalValue != noBillOutcome and g.rowValue == noBillOutcome
pure def sometimesRecoveredReceipt(g: ReviewLedger): bool =
  not(g.authorized) and g.billView == outcomeStoredView
pure val readValues = Set(
  { observationEpoch: 1, documentId: 1, inputRevision: 1, ownedBill: true, exactControl: true, earlierOutcome: false, evidence: ReviewReady },
  { observationEpoch: 1, documentId: 1, inputRevision: 1, ownedBill: true, exactControl: false, earlierOutcome: false, evidence: ReviewReady },
  { observationEpoch: 1, documentId: 1, inputRevision: 1, ownedBill: true, exactControl: false, earlierOutcome: false, evidence: FormEvidence },
  { observationEpoch: 1, documentId: 1, inputRevision: 2, ownedBill: true, exactControl: false, earlierOutcome: false, evidence: PaidEvidence },
  { observationEpoch: 1, documentId: 1, inputRevision: 2, ownedBill: true, exactControl: false, earlierOutcome: true, evidence: ScheduledEvidence },
  { observationEpoch: 1, documentId: 1, inputRevision: 1, ownedBill: true, exactControl: false, earlierOutcome: false, evidence: UnreadableEvidence },
  { observationEpoch: 2, documentId: 2, inputRevision: 1, ownedBill: true, exactControl: true, earlierOutcome: false, evidence: ReviewReady },
  { observationEpoch: 1, documentId: 1, inputRevision: 2, ownedBill: false, exactControl: false, earlierOutcome: false, evidence: PaidEvidence })
pure val weight_offerReview = 4
pure val weight_observeReceipt = 4
pure val weight_appendReceiptJournal = 5
pure val weight_insertReceipt = 5
pure val weight_finishReceipt = 5
```
