# A later task remembers an earlier payment step

Grace's release website guide adds an owner-scoped payment-step store in
`apps/app/host/payment-steps.ts` above Eliza's pinned guidance engine. The
generic guide scans the newest 50 rows of other tasks of this owner.
The scan's physical limit is part of the observed behavior. The pure
policy below decides over the rows the store supplies.

## Story: Ask about the earlier payment before pointing again

### Keep a payment step before showing its pointer

An earlier step within 25 days counts when it is the same checked bill,
or it shares a site/origin and the known account endings agree. An
unknown account ending does not establish a mismatch. A clock rewind
does not discard a step that appears to be in the future. A guide asks
the person to check provider status if an earlier step matches. That step
is evidence of a pointer, and carries no claim that payment was sent.
For each new pointer, checking the earlier step and keeping the new row
runs in one transaction. If a row appeared in that interval, the new
pointer waits for the matching answer.

```quint
type PaymentQuery = { owner: str, taskId: str, billSource: str, site: str, origins: List[str], accountLast4: str, nowMillis: int }
type PriorStep = { owner: str, taskId: str, billSource: str, site: str, origins: List[str], accountLast4: str, shownAt: int }
type PaymentPointerFacts = { currentTask: bool, readableHistory: bool, writeCommitted: bool, priorMatch: bool, priorAnswerCurrent: bool }
type PointerDecision = PointerRefused | AskAboutPrior | PointToHumanControl

pure def samePaymentPlace(row: PriorStep, query: PaymentQuery): bool =
  row.site == query.site or query.origins.includes(row.site) or
  row.origins.some(origin => origin == query.site or query.origins.includes(origin))
pure def earlierStepMatches(row: PriorStep, query: PaymentQuery): bool =
  row.owner == query.owner and row.taskId != query.taskId and row.shownAt >= query.nowMillis - 2160000000 and
  ((query.billSource != "" and row.billSource == query.billSource) or
    (samePaymentPlace(row, query) and
     (row.accountLast4 == "" or query.accountLast4 == "" or row.accountLast4 == query.accountLast4)))
pure def pointerDecision(facts: PaymentPointerFacts): PointerDecision =
  if (not(facts.currentTask and facts.readableHistory)) PointerRefused
  else if (facts.priorMatch and not(facts.priorAnswerCurrent)) AskAboutPrior
  else if (not(facts.writeCommitted)) PointerRefused
  else PointToHumanControl
pure def lawForeignStepCannotMatch(row: PriorStep, query: PaymentQuery): bool =
  row.owner != query.owner or row.taskId == query.taskId implies not(earlierStepMatches(row, query))
pure def lawClockRewindRetainsMatchingStep(row: PriorStep, query: PaymentQuery, earlierMillis: int): bool =
  earlierMillis <= query.nowMillis and earlierStepMatches(row, query)
  implies earlierStepMatches(row, { ...query, nowMillis: earlierMillis })
pure def lawPayPointerRequiresCurrentStoredStep(facts: PaymentPointerFacts): bool =
  pointerDecision(facts) == PointToHumanControl implies
  facts.currentTask and facts.readableHistory and facts.writeCommitted and (not(facts.priorMatch) or facts.priorAnswerCurrent)
pure val previousStep: PriorStep = { owner: "ownerA", taskId: "oldTask", billSource: "", site: "power", origins: List("power", "processor"), accountLast4: "1234", shownAt: 10000 }
pure val currentQuery: PaymentQuery = { owner: "ownerA", taskId: "newTask", billSource: "", site: "processor", origins: List("processor"), accountLast4: "1234", nowMillis: 20000 }
pure val pointerReady: PaymentPointerFacts = { currentTask: true, readableHistory: true, writeCommitted: true, priorMatch: false, priorAnswerCurrent: false }
pure val factsValues = Set(pointerReady, { ...pointerReady, priorMatch: true },
  { ...pointerReady, priorMatch: true, priorAnswerCurrent: true },
  { ...pointerReady, writeCommitted: false }, { ...pointerReady, readableHistory: false })
pure val rowValues = Set(previousStep, { ...previousStep, owner: "ownerB" }, { ...previousStep, taskId: "newTask" })
pure val queryValues = Set(currentQuery, { ...currentQuery, accountLast4: "4321" },
  { ...currentQuery, nowMillis: 3000000000 })
pure val earlierMillisValues = Set(0, 10000, 20000, 3000000000)
```
