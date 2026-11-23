# Guided bill evidence

## Story: Keep the evidence of an owner-submitted bill payment

> As the owner, I can guide the agent to the biller, submit the reviewed action myself, and recover and inspect what happened after a reload.

### Submissions and outcomes belong to the exact selected bill and owner

The browser and the owner supply observations; the assistant records evidence. A page that already showed a paid or scheduled bill produces a prior outcome. An uncertain submission is reconciled without asking the owner to submit it again.

```quint
type BillProgress = SelectedBill | ReviewedBill | SubmissionUnknown | PriorOutcome | SavedOutcome
type BillEvidence = { billKey: str, billOwner: str, sourceRef: str, progress: BillProgress, outcomeRef: str }
type BillObservation = { observedBill: str, observedOwner: str, observedSource: str, observedReference: str }
pure def sameBill(evidence: BillEvidence, observation: BillObservation): bool =
  evidence.billKey != "" and evidence.billOwner != "" and evidence.sourceRef != "" and
  evidence.billKey == observation.observedBill and evidence.billOwner == observation.observedOwner and
  evidence.sourceRef == observation.observedSource
pure def submissionMayBePrepared(evidence: BillEvidence, observation: BillObservation): bool =
  sameBill(evidence, observation) and evidence.progress == ReviewedBill
pure def reconcileBillOutcome(evidence: BillEvidence, observation: BillObservation): BillEvidence =
  if (sameBill(evidence, observation) and evidence.progress == SubmissionUnknown)
    { ...evidence, progress: SavedOutcome, outcomeRef: observation.observedReference }
  else evidence
pure def lawUnknownSubmissionCannotBePreparedAgain(evidence: BillEvidence, observation: BillObservation): bool =
  evidence.progress == SubmissionUnknown implies not(submissionMayBePrepared(evidence, observation))
pure def lawReconciliationCannotChangeAnotherBill(evidence: BillEvidence, observation: BillObservation): bool =
  not(sameBill(evidence, observation)) implies reconcileBillOutcome(evidence, observation) == evidence
pure def lawPriorOutcomeIsNeverAttributedToThisSubmission(evidence: BillEvidence, observation: BillObservation): bool =
  evidence.progress == PriorOutcome implies reconcileBillOutcome(evidence, observation) == evidence
```

### Only a saved outcome with a reference can look up a receipt within the attempt budget

The shell reserves each read attempt durably before performing it. Failed attempts share the same budget and cooldown. The receipt result supplies corroboration only when one email names the exact biller's reference.

```quint
pure val receiptAttemptLimit = 3
pure val receiptCooldownMs = 60000
pure def mayLookUpBillReceipt(evidence: BillEvidence, attempts: int, lastAttemptAt: int, now: int): bool =
  evidence.progress == SavedOutcome and evidence.outcomeRef != "" and attempts >= 0 and attempts < receiptAttemptLimit and now >= 0 and
  (attempts == 0 or (lastAttemptAt >= 0 and now >= lastAttemptAt + receiptCooldownMs))
pure def lawBillReceiptBudgetIsBounded(evidence: BillEvidence, attempts: int, lastAttemptAt: int, now: int): bool =
  attempts >= receiptAttemptLimit implies not(mayLookUpBillReceipt(evidence, attempts, lastAttemptAt, now))
pure val evidenceValues = Set({ billKey: "invoice-1", billOwner: "owner", sourceRef: "mail-1", progress: SubmissionUnknown, outcomeRef: "" }, { billKey: "invoice-1", billOwner: "owner", sourceRef: "mail-1", progress: SavedOutcome, outcomeRef: "receipt-1" })
pure val observationValues = Set({ observedBill: "invoice-1", observedOwner: "owner", observedSource: "mail-1", observedReference: "receipt-1" }, { observedBill: "invoice-1", observedOwner: "other", observedSource: "mail-1", observedReference: "" })
```
