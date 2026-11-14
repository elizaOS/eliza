# Grace generic bill receipts and duplicate payment review

The generic bill policy in Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154`
uses `apps/app/host/bill-outcomes.ts`, `website-bill-policy.ts` and
`shared/verified/prior-payment.ts` beside its Eliza bill workflow at
`7743504b7c936a764b3938a44cad918808b621df`. This contract covers the
generic receipt table and its use before another payment.
[Bill review](./billReview.md) owns the configured outcome.
[Payment controls](./paymentControl.md) owns current website actions.

## Story: Keep one exact verified receipt for the task and bill

### A sealed, owned outcome may be recorded and an exact retry returns its original receipt

The host loads the task through its current runtime and admits either
paid or scheduled evidence sealed by the generic receipt verifier.
The bill source must match the checked source, the payee must match,
and currency and minor-unit scale must match the bill. The amount
is a nonnegative safe integer. An optional visible provider reference
needs nonblank text of at most 128 UTF-16 units with no controls.
The source must be HTTPS with no credentials, query or fragment.
The row keeps the checked company, masked account ending, timestamp,
amount, status, optional reference and date. It uses schema version 1.

SQLite keys records by task and bill source. A read is scoped to
the owner key. An exact retry compares canonical JSON with timestamps
neutralized and returns the existing receipt with the original time.
Malformed or different evidence at that key refuses. The generic
policy can keep an observed result pending when this write fails,
with payment blocked while it is rechecked. The model receives
the task and verifier results, reference and URL codec results,
and storage evidence from ports.

```quint
type ReceiptAdmission = { ownedTask: bool, verifiedSeal: bool, exactBill: bool, payeeMatch: bool,
  payableStatus: bool, amountMinor: int, exactCurrency: bool, exactScale: bool,
  referenceAdmitted: bool, canonicalHttps: bool }
type StoredReceipt = NoRecordedReceipt | ExactRecordedReceipt | DifferentRecordedReceipt | InvalidRecordedReceipt
type ReceiptWrite = InsertVerifiedReceipt | ReturnRecordedReceipt | RefuseReceiptWrite
pure def admissibleGenericReceipt(receipt: ReceiptAdmission): bool =
  receipt.ownedTask and receipt.verifiedSeal and receipt.exactBill and receipt.payeeMatch and
  receipt.payableStatus and receipt.amountMinor >= 0 and receipt.amountMinor <= 9007199254740991 and
  receipt.exactCurrency and receipt.exactScale and receipt.referenceAdmitted and receipt.canonicalHttps
pure def genericReceiptWrite(receipt: ReceiptAdmission, stored: StoredReceipt): ReceiptWrite =
  if (not(admissibleGenericReceipt(receipt))) RefuseReceiptWrite
  else if (stored == NoRecordedReceipt) InsertVerifiedReceipt
  else if (stored == ExactRecordedReceipt) ReturnRecordedReceipt else RefuseReceiptWrite
pure def lawUnsealedGenericReceiptCannotWrite(receipt: ReceiptAdmission, stored: StoredReceipt): bool =
  not(receipt.verifiedSeal) implies genericReceiptWrite(receipt,stored) == RefuseReceiptWrite
pure def lawExistingGenericReceiptCannotBeOverwritten(receipt: ReceiptAdmission, stored: StoredReceipt): bool =
  stored != NoRecordedReceipt implies genericReceiptWrite(receipt,stored) != InsertVerifiedReceipt
pure val cleanReceipt: ReceiptAdmission = { ownedTask: true, verifiedSeal: true, exactBill: true, payeeMatch: true,
  payableStatus: true, amountMinor: 8420, exactCurrency: true, exactScale: true, referenceAdmitted: true, canonicalHttps: true }
pure val receiptValues = Set(cleanReceipt, { ...cleanReceipt, ownedTask: false }, { ...cleanReceipt, verifiedSeal: false },
  { ...cleanReceipt, exactBill: false }, { ...cleanReceipt, exactScale: false }, { ...cleanReceipt, amountMinor: -1 },
  { ...cleanReceipt, amountMinor: 50000 }, { ...cleanReceipt, canonicalHttps: false })
```

## Story: Stop a repeat payment and ask once about a separate bill

### Another task's exact receipt wins before this task's own result or a recent account match

Load this owner's newest 50 rows indexed by bill source when a
source is present, then the owner's newest 50 overall, each ordered
by decreasing row ID. Decode readable version-1 records with safe
integer totals and a string company. Skip unreadable rows inside the
two pinned queries. Within the combined ordered candidates, choose
the first exact nonempty bill-source match from another task, then
the first match from this task, then the first other task's receipt
for the same company and nonempty identical account ending in the
recent window. A timestamp in the future counts as recent. For the
same bill, age and account-ending availability are immaterial.
The existing candidate limits are part of these pinned SQLite
observations. The selection retains every candidate supplied by that
port. An older same-company match can fall outside the global query.

```quint
type PriorQuery = { billSource: str, accountLast4: str, hasTask: bool, taskId: str }
type PriorRow = { taskId: str, billSource: str, accountLast4: str, sameCompany: bool, recent: bool }
type PriorObservation = { index: int, sameBill: bool, ownTask: bool }
type PriorWalk = { index: int, exactOther: int, exactOwn: int, recentOther: int, query: PriorQuery }
pure def ownPriorRow(q: PriorQuery, row: PriorRow): bool = q.hasTask and row.taskId == q.taskId
pure def exactPriorRow(q: PriorQuery, row: PriorRow): bool = q.billSource != "" and q.billSource == row.billSource
pure def exactOtherPriorRow(q: PriorQuery, row: PriorRow): bool = exactPriorRow(q,row) and not(ownPriorRow(q,row))
pure def recentPriorRow(q: PriorQuery, row: PriorRow): bool =
  not(ownPriorRow(q,row)) and q.accountLast4 != "" and q.accountLast4 == row.accountLast4 and row.sameCompany and row.recent
pure def takePriorRow(walk: PriorWalk, row: PriorRow): PriorWalk = {
  val owned = ownPriorRow(walk.query,row)
  val exact = exactPriorRow(walk.query,row)
  { ...walk, index: walk.index + 1,
    exactOther: if (walk.exactOther == -1 and exact and not(owned)) walk.index else walk.exactOther,
    exactOwn: if (walk.exactOwn == -1 and exact and owned) walk.index else walk.exactOwn,
    recentOther: if (walk.recentOther == -1 and recentPriorRow(walk.query,row)) walk.index else walk.recentOther }
}
pure def selectPriorObservation(walk: PriorWalk): PriorObservation =
  if (walk.exactOther >= 0) { index: walk.exactOther, sameBill: true, ownTask: false }
  else if (walk.exactOwn >= 0) { index: walk.exactOwn, sameBill: true, ownTask: true }
  else { index: walk.recentOther, sameBill: false, ownTask: false }
pure def chooseGenericPrior(rows: List[PriorRow], q: PriorQuery): PriorObservation =
  selectPriorObservation(rows.foldl({ index: 0, exactOther: -1, exactOwn: -1, recentOther: -1, query: q }, takePriorRow))
pure def lawExactOtherWinsAcrossAllCandidates(rows: List[PriorRow], q: PriorQuery): bool = {
  val selected = chooseGenericPrior(rows,q)
  rows.some(row => exactOtherPriorRow(q,row)) implies selected.index >= 0 and selected.sameBill and not(selected.ownTask)
}
pure def lawExactOtherWinsForAnyRecentChoice(walk: PriorWalk): bool =
  walk.exactOther >= 0 implies selectPriorObservation(walk) == { index: walk.exactOther, sameBill: true, ownTask: false }
pure def lawFirstExactOtherIsKept(walk: PriorWalk, row: PriorRow): bool =
  walk.exactOther >= 0 implies takePriorRow(walk,row).exactOther == walk.exactOther
pure val paidBill: PriorQuery = { billSource: "october", accountLast4: "1234", hasTask: true, taskId: "here" }
pure val october: PriorRow = { taskId: "there", billSource: "october", accountLast4: "1234", sameCompany: true, recent: false }
pure val november: PriorRow = { ...october, billSource: "november", recent: true }
pure val rowValues = Set(october, november, { ...october, taskId: "here" }, { ...november, accountLast4: "9876" })
pure val qValues = Set(paidBill, { ...paidBill, billSource: "" }, { ...paidBill, accountLast4: "" }, { ...paidBill, hasTask: false })
pure val rowsValues = Set(List(), List(november), List(november, { ...october, taskId: "here" }, october), List(october, november))
pure val walkValues = Set(
  { index: 1, exactOther: -1, exactOwn: -1, recentOther: 0, query: paidBill },
  { index: 3, exactOther: 0, exactOwn: 1, recentOther: 2, query: paidBill })
```

### A same-bill receipt blocks payment and recent other bills use their own answer

Another task's receipt for the same bill blocks the payment path
regardless of any earlier answer. This task's own receipt keeps
its result readable and blocks its own later payment review for the
same bill at the payment gate. For a recent other bill, resolve the
answer against the current fee key built from the checked bill,
prior task ID and receipt total. Accepted permits further review.
Without acceptance, an interactive panel asks about the new bill.
Without the panel, stop for the recent amount. These decisions do
not authorize a payment themselves.

```quint
type PriorDisposition = ContinueBillReview | StopAlreadyPaid | StopPaidRecently | AskAboutNewBill
pure def genericPriorDisposition(prior: PriorObservation, accepted: bool, canAsk: bool): PriorDisposition =
  if (prior.index < 0 or prior.ownTask) ContinueBillReview
  else if (prior.sameBill) StopAlreadyPaid
  else if (accepted) ContinueBillReview
  else if (canAsk) AskAboutNewBill else StopPaidRecently
pure def lawExactOtherPaymentAlwaysStops(prior: PriorObservation, accepted: bool, canAsk: bool): bool =
  prior.index >= 0 and prior.sameBill and not(prior.ownTask) implies genericPriorDisposition(prior,accepted,canAsk) == StopAlreadyPaid
pure def mayReviewOwnPayment(prior: PriorObservation): bool =
  not(prior.index >= 0 and prior.sameBill and prior.ownTask)
pure def lawOwnReceiptAllowsResultAndBlocksPaymentReview(prior: PriorObservation, accepted: bool, canAsk: bool): bool =
  prior.index >= 0 and prior.sameBill and prior.ownTask implies
    genericPriorDisposition(prior,accepted,canAsk) == ContinueBillReview and not(mayReviewOwnPayment(prior))
pure val priorValues = Set({ index: -1, sameBill: false, ownTask: false }, { index: 0, sameBill: true, ownTask: false },
  { index: 0, sameBill: true, ownTask: true }, { index: 0, sameBill: false, ownTask: false })
```

The pinned `prior-payment.test.mjs`, `bill-anchoring-outcomes.test.mjs`
and `bill-generic-recovery.test.mjs` exercise exact receipt precedence,
same-owner and foreign-account boundaries, and recovery.
