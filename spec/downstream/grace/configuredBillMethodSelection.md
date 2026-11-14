# Grace configured saved-card selection

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` uses the configured bill helper when a reviewed provider configuration is installed. The default release path uses the generic website guide. This boundary covers a person's choice of an existing saved card. The operation prepares the site for a human payment decision and has no authority to add a card or submit a payment. Payment review and submission evidence have their own records. The exact Eliza dependency is `7743504b7c936a764b3938a44cad918808b621df`.

## Story: Ask about only the saved cards the page identifies

### A controlled decline and its offered alternatives preserve the original card slots

The policy proceeds from a reported decline only when the page explicitly says `Amount charged: None` and supplies a masked declined method. An unpaid status can proceed through normal preparation. Other payment statuses are handled before this decision. A page with no saved method gives the person the next step. An unknown or unavailable method, a malformed selection status, or malformed saved-card facts cannot generate a choice.

A multiple-card list scans slots 1–5 up to the first missing line. It requires at least two distinct masked values and a missing slot 6. In the model the line parser supplies this contiguous prefix, the sixth-line condition and the masking predicate for each value. The source rejects repeated or blank fact lines, method text over 120 UTF-16 units, controls in the text and runs of at least twelve digits with optional spaces or hyphens. A reported selected card must be one of the listed cards. If a decline leaves no selected alternative, the rejected card is dropped from the question without renumbering any other card. If there is no other saved card, offer call or end. If there are alternatives, an interactive question requires configuration for the whole list and room for up to three alternative cards plus stop. A single alternative has a friendlier display label but its answer still carries the original slot. An ordinary multiple-card question uses the same size and configuration bounds.

`beforeDeclinePreparation` represents the date, amount, total and other decisions before decline routing. `feeOrAmountQuestion` represents the subsequent fee and amount confirmation branches, and `optInInterruption` represents the later opt-in check after any multiple-card question. A selected different card can proceed through later preparation to review. A single admitted but unselected card can offer the separate explicit existing-method review. Grace source `apps/app/host/bill-policy.ts:454–485,540–588`.

```quint
type DisplayedCard = { label: str, masked: bool }
type SelectionPage = { paymentStatus: str, noCharge: bool, declined: DisplayedCard, existing: str, single: DisplayedCard, selected: str, chosen: str, cards: List[DisplayedCard], sixthAbsent: bool, selectionInteractive: bool, reviewedSlots: int, beforeDeclinePreparation: bool, feeOrAmountQuestion: bool, optInInterruption: bool }
pure def selectedCard(page: SelectionPage): str =
  if (page.existing == "multiple") (if (page.selected == "Yes") page.chosen else "") else page.single.label
pure def cardChoicesValid(page: SelectionPage): bool =
  page.cards.length() >= 2 and page.cards.length() <= 5 and page.sixthAbsent and page.cards.every(card => card.masked and card.label != "") and page.cards.foldl(Set(), (labels, card) => labels.union(Set(card.label))).size() == page.cards.length() and
  (page.selected != "Yes" or page.cards.some(card => card.label == page.chosen))
pure def validExisting(page: SelectionPage): bool =
  (page.selected == "Yes" or page.selected == "No") and
  (if (page.existing == "multiple") cardChoicesValid(page) else page.existing == "single" and page.single.masked and page.single.label != "")
pure def alternatives(page: SelectionPage): List[DisplayedCard] =
  if (page.existing == "multiple") page.cards.select(card => card.label != page.declined.label) else List()
pure def needsDeclineChoice(page: SelectionPage): bool =
  page.paymentStatus == "Declined" and (selectedCard(page) == "" or selectedCard(page) == page.declined.label)
pure def fullReviewedConfiguration(page: SelectionPage): bool = page.selectionInteractive and page.cards.length() <= page.reviewedSlots
pure def cardRoute(page: SelectionPage): str =
  if (page.paymentStatus == "Declined" and not(page.noCharge and page.declined.masked and page.declined.label != "")) "result-unclear"
  else if (page.paymentStatus != "Declined" and page.paymentStatus != "Unpaid") "earlier-status"
  else if (page.existing == "none") "new-method-required"
  else if (not(validExisting(page))) "method-unclear"
  else if (page.beforeDeclinePreparation) "prepare-first"
  else if (needsDeclineChoice(page))
    if (alternatives(page).length() == 0) "call-or-end"
    else if (not(fullReviewedConfiguration(page)) or alternatives(page).length() > 3) "decline-manual"
    else "decline-question"
  else if (page.feeOrAmountQuestion) "prepare-first"
  else if (page.existing == "multiple" and page.selected == "No")
    if (fullReviewedConfiguration(page) and page.cards.length() <= 3) "ordinary-question" else "ordinary-manual"
  else if (page.optInInterruption) "prepare-first"
  else if (page.selected == "Yes") "human-submit"
  else "choose-existing-method"
type SlotAnswer = { slot: int, label: str }
pure def slotMatches(page: SelectionPage, answer: SlotAnswer): bool =
  if (answer.slot < 1 or answer.slot > page.cards.length()) false
  else page.cards.nth(answer.slot - 1).label == answer.label
pure def cardOffered(page: SelectionPage, answer: SlotAnswer): bool =
  slotMatches(page, answer) and (cardRoute(page) == "ordinary-question" or (cardRoute(page) == "decline-question" and answer.label != page.declined.label))
pure def lawDeclineNeedsExplicitNoCharge(page: SelectionPage): bool =
  page.paymentStatus == "Declined" and not(page.noCharge and page.declined.masked and page.declined.label != "") implies cardRoute(page) == "result-unclear"
pure def lawOfferedAnswerKeepsItsOriginalSlot(page: SelectionPage, answer: SlotAnswer): bool =
  cardOffered(page, answer) implies slotMatches(page, answer) and fullReviewedConfiguration(page)
pure def lawDeclinedCardCannotBeOffered(page: SelectionPage, answer: SlotAnswer): bool =
  cardRoute(page) == "decline-question" and answer.label == page.declined.label implies not(cardOffered(page, answer))
pure val firstCard: DisplayedCard = { label: "Visa ending 1111", masked: true }
pure val secondCard: DisplayedCard = { label: "Visa ending 2222", masked: true }
pure val thirdCard: DisplayedCard = { label: "Visa ending 3333", masked: true }
pure val listed: SelectionPage = { paymentStatus: "Unpaid", noCharge: true, declined: firstCard, existing: "multiple", single: firstCard, selected: "No", chosen: "", cards: List(firstCard, secondCard, thirdCard), sixthAbsent: true, selectionInteractive: true, reviewedSlots: 3, beforeDeclinePreparation: false, feeOrAmountQuestion: false, optInInterruption: false }
pure val pageValues = Set(listed, { ...listed, paymentStatus: "Declined" }, { ...listed, paymentStatus: "Declined", noCharge: false }, { ...listed, paymentStatus: "Declined", selected: "Yes", chosen: secondCard.label }, { ...listed, cards: List(firstCard, firstCard) }, { ...listed, selected: "Yes", chosen: "missing" }, { ...listed, reviewedSlots: 2 }, { ...listed, sixthAbsent: false }, { ...listed, existing: "none" }, { ...listed, existing: "single" }, { ...listed, beforeDeclinePreparation: true }, { ...listed, paymentStatus: "Declined", feeOrAmountQuestion: true }, { ...listed, existing: "single", optInInterruption: true })
pure val answerValues = Set({ slot: 1, label: firstCard.label }, { slot: 1, label: secondCard.label }, { slot: 2, label: secondCard.label }, { slot: 3, label: thirdCard.label }, { slot: 6, label: secondCard.label })
```

## Story: Bind the person's choice to an exact authorized click

### Store the reviewed method before dispatch and keep its operation identity immutable

For the single-card route, the shared workflow obtains a fresh observation and compares the offered review key. It derives that key from the provider review key, task ID, epoch, document ID and input revision. A changed review surfaces the updated decision. If an earlier selection pointer has become an unavailable human-review pointer, the workflow may pause and settle an active task after checking currency, authorization and abort. This consumes the offered epoch without a click. For a multiple or declined choice, Grace reobserves the same question and requires the fresh ask key and an offered `method-1` through `method-5`. It uses the masked card, review, label and selector at that slot. That record uses the hash of its candidate review rather than the single-route key extension. Grace drops a queued step if the account changes and checks the connected account around the shared single-card workflow. A changed account at the post-click look can block the updated review even though the click already happened.

The shared single-card route resolves exactly one observed element with the configured label. Grace's multiple-card route resolves its exact proposed selector when present or exactly one element with the offered label. Both carry the configured selector separately for the actuator to check against the observed target. The click requires current authority and one exact reviewed control. The store requires an owned active task, active authorization, the choice decision, a click capability, the current task, authorization, epoch, observation ID, observation version and input revision, and a snapshot document. The operation ID starts with an ASCII alphanumeric and has at most 256 units, with later ASCII alphanumerics or `_.:@-`. The target reference has 1–512 UTF-16 units. Shared review validation checks the key, calendar, money, method and other review fields and uses the observed credential-free HTTPS address after dropping query and fragment. The origin must be allowed. The durable record also holds the task ID, authorization ID, epoch, observation ID, document ID, target, operation ID, cleaned origin and path, timestamp and detached review. The same cleaned URL replaces the review source.

The primary key of `bill_method_selections_v1` is task ID and operation ID. Insertion is immutable even for a repeat by the same owner with the same document. Confirmation is a fresh owned load with exact serialized equality. A failed readback may leave the inserted row and does not allow dispatch. An owned historical load validates schema and review and matches operation and task IDs and nonempty observation, target and authorization IDs. It does not require those historical values to equal the current observation or authorization. The role of the current authorization in recovery is a separate rule. Grace source `apps/app/host/bill-helper-host.ts:448–529,607–655`. Eliza source `plugins/plugin-personal-assistant/native-host/bill-workflow.mjs:463–474,495–621` and `bill-outcome-store.mjs:147,195–249,586–661`.

```quint
type StoreChoice = { taskOwned: bool, activeTask: bool, activeAuthorization: bool, choiceDecision: bool, sameTask: bool, sameAuthorization: bool, sameEpoch: bool, click: bool, sameObservation: bool, sameVersion: bool, sameInputRevision: bool, operationSyntax: bool, targetUnits: int, hasDocument: bool, allowedCleanSource: bool, validReview: bool, storageAvailable: bool, existingKey: bool, insertWorked: bool, exactReadback: bool }
pure def storeChoiceCurrent(write: StoreChoice): bool =
  write.taskOwned and write.activeTask and write.activeAuthorization and write.choiceDecision and write.sameTask and write.sameAuthorization and write.sameEpoch and write.click and write.sameObservation and write.sameVersion and write.sameInputRevision
pure def storeChoiceValid(write: StoreChoice): bool =
  storeChoiceCurrent(write) and write.operationSyntax and write.targetUnits >= 1 and write.targetUnits <= 512 and write.hasDocument and write.allowedCleanSource and write.validReview
pure def writeMethodRow(write: StoreChoice): str =
  if (not(write.storageAvailable)) "unavailable"
  else if (not(storeChoiceValid(write))) "invalid"
  else if (write.existingKey) "duplicate"
  else if (not(write.insertWorked)) "insert-failed"
  else if (not(write.exactReadback)) "readback-failed"
  else "confirmed"
pure def lawConfirmedMethodRowRequiresExactCurrentEvidence(write: StoreChoice): bool =
  writeMethodRow(write) == "confirmed" implies storeChoiceValid(write) and write.storageAvailable and not(write.existingKey) and write.insertWorked and write.exactReadback
pure def lawExistingOperationCannotBeRebound(write: StoreChoice): bool =
  write.existingKey implies writeMethodRow(write) != "confirmed" and writeMethodRow(write) != "readback-failed"
pure val admissibleWrite: StoreChoice = { taskOwned: true, activeTask: true, activeAuthorization: true, choiceDecision: true, sameTask: true, sameAuthorization: true, sameEpoch: true, click: true, sameObservation: true, sameVersion: true, sameInputRevision: true, operationSyntax: true, targetUnits: 10, hasDocument: true, allowedCleanSource: true, validReview: true, storageAvailable: true, existingKey: false, insertWorked: true, exactReadback: true }
pure val writeValues = Set(admissibleWrite, { ...admissibleWrite, existingKey: true }, { ...admissibleWrite, storageAvailable: false }, { ...admissibleWrite, insertWorked: false }, { ...admissibleWrite, exactReadback: false }, { ...admissibleWrite, taskOwned: false }, { ...admissibleWrite, sameEpoch: false }, { ...admissibleWrite, sameVersion: false }, { ...admissibleWrite, sameInputRevision: false }, { ...admissibleWrite, allowedCleanSource: false }, { ...admissibleWrite, targetUnits: 513 }, { ...admissibleWrite, validReview: false })
```

### A grant covers the reviewed click once and relocation requires proof it never dispatched

The host submits a proposal expiring in 10 seconds with the exact browser observation, target reference and configured selector. The commit grant names the same task, epoch, origin, target, reviewed selector and expiry and permits one `click`. It is withdrawn in the execution finally path, including when dispatch throws. The operation lookup uses its exact proposal ID. A successful selection refreshes the site. A missing result or an unverified effect cannot issue an automatic retry. Only `failed` with affirmative `not-dispatched` evidence allows one fresh lookup against the same review or ask key under `<operationId>.relocated`. A changed review or question is surfaced without a retry. A second pre-effect refusal stops. This machine tracks one answered choice and at most its one relocated attempt. `sameOffer` and `currentSpendScope` are facts supplied by the fresh key, account and authority checks. The two row flags track confirmed readback; an insertion without confirmation remains durable only at the store boundary. A qualifying first refusal closes the grant and requests the relocated look together. Issuing the relocated click still needs a fresh confirmed row.

```quint
type DispatchEvidence = { exactOperation: bool, status: str }
type ChoiceEvidence = { sameOffer: bool, currentSpendScope: bool, exactControl: bool, write: StoreChoice }
type SavedCardChoice = { phase: str, firstSaved: bool, relocatedSaved: bool, relocated: bool, grantOpen: bool, clicks: int }
pure val initial: SavedCardChoice = { phase: "offered", firstSaved: false, relocatedSaved: false, relocated: false, grantOpen: false, clicks: 0 }
pure def canRecordChoice(choice: SavedCardChoice): bool = choice.phase == "offered" or choice.phase == "retry-offered"
pure def recordChoice(choice: SavedCardChoice, evidence: ChoiceEvidence): SavedCardChoice =
  if (not(evidence.sameOffer and evidence.currentSpendScope and evidence.exactControl) or writeMethodRow(evidence.write) != "confirmed") { ...choice, phase: "stopped" }
  else if (choice.relocated) { ...choice, phase: "recorded", relocatedSaved: true }
  else { ...choice, phase: "recorded", firstSaved: true }
pure def canOpenGrant(choice: SavedCardChoice): bool = choice.phase == "recorded"
pure def openGrant(choice: SavedCardChoice): SavedCardChoice = { ...choice, phase: "dispatching", grantOpen: true }
pure def canObserveDispatch(choice: SavedCardChoice): bool = choice.phase == "dispatching"
pure def observeDispatch(choice: SavedCardChoice, receipt: DispatchEvidence): SavedCardChoice =
  if (receipt.exactOperation and receipt.status == "failed-not-dispatched")
    { ...choice, phase: if (choice.relocated) "stopped" else "retry-offered", relocated: true, grantOpen: false }
  else if (receipt.exactOperation and receipt.status == "succeeded")
    { ...choice, phase: "observed", grantOpen: false, clicks: choice.clicks + 1 }
  else { ...choice, phase: "unknown", grantOpen: false, clicks: choice.clicks + 1 }
pure def alwaysGrantRequiresConfirmedRow(choice: SavedCardChoice): bool =
  choice.grantOpen == (choice.phase == "dispatching") and
  ((choice.phase == "recorded" or choice.phase == "dispatching") implies (if (choice.relocated) choice.relocatedSaved else choice.firstSaved))
pure def alwaysRelocationFollowsConfirmedFirstAttempt(choice: SavedCardChoice): bool =
  (choice.relocated or choice.phase == "retry-offered") implies choice.firstSaved
pure def alwaysAtMostOnePotentialClick(choice: SavedCardChoice): bool =
  choice.clicks >= 0 and choice.clicks <= 1 and
  (choice.clicks > 0 implies choice.phase == "observed" or choice.phase == "unknown")
pure def alwaysRelocatedCannotOfferAnotherRetry(choice: SavedCardChoice): bool =
  (choice.relocated implies choice.phase != "offered") and (choice.phase == "retry-offered" implies choice.relocated)
pure def stepConfirmedRecordIsRetained(before: SavedCardChoice, after: SavedCardChoice): bool =
  (before.firstSaved implies after.firstSaved) and (before.relocatedSaved implies after.relocatedSaved)
pure def sometimesRefusedFirstControlRelocatedAndObserved(choice: SavedCardChoice): bool =
  choice.relocated and choice.relocatedSaved and choice.phase == "observed"
pure def sometimesUnknownClosesGrantWithoutRetry(choice: SavedCardChoice): bool = choice.phase == "unknown" and not(choice.grantOpen)
pure def sometimesStaleOfferNeverOpensGrant(choice: SavedCardChoice): bool = choice.phase == "stopped" and not(choice.firstSaved)
pure val readyChoice: ChoiceEvidence = { sameOffer: true, currentSpendScope: true, exactControl: true, write: admissibleWrite }
pure val evidenceValues = Set(readyChoice, { ...readyChoice, sameOffer: false }, { ...readyChoice, currentSpendScope: false }, { ...readyChoice, exactControl: false }, { ...readyChoice, write: { ...admissibleWrite, exactReadback: false } })
pure val receiptValues = Set({ exactOperation: true, status: "failed-not-dispatched" }, { exactOperation: true, status: "succeeded" }, { exactOperation: true, status: "failed" }, { exactOperation: true, status: "unknown" }, { exactOperation: true, status: "threw" }, { exactOperation: false, status: "succeeded" }, { exactOperation: false, status: "failed-not-dispatched" })
```

## Story: Recover a method choice through its own retained evidence

### A read-only look may confirm the exact choice and cannot prove an absent selection failed

An owned task can ask the configured host to reconcile a single unknown operation with current authority. Managed bill discovery requires the retained selection for this task and an allowed source origin. The host readies one detached recovery record and calls the runtime's reconcile port, then clears the record in finally. Recovery does not execute the old click. Historical record load and fresh readback perform different checks.

When the saved method row exists, its schema version, task, current decision, proposal authorization, epoch, clicked operation, observation, target and bill source must match. An exact freshly derived `human-submit` review confirms the saved choice, including all keys and shallow values, with a cleaned credential-free HTTPS review URL equal to the retained source. Another card, absent selection, changed amount, or unavailable page keeps the result unknown. When there is no method row but a stored expectation exists, the product's method expectation can confirm the exact masked `Selected method` under a matching task, epoch and authorization, on the controlled provider page explicitly reporting `Method selected: Yes`. A stored row takes precedence over that expectation, including when the row disagrees. Other operation kinds use different expectation rules. This result describes the card-selection operation; provider submission/outcome still requires its own evidence. Grace source `apps/app/host/bill-reconciliation.ts:31–60,101–117`, `apps/app/shared/verified/reconciliation.ts:109–184`, and Eliza `bill-helper-host.mjs:248–305`.

```quint
type MethodRecovery = { ownerCurrent: bool, recoveryIdle: bool, unknownCount: int, discoveryManaged: bool, savedSourceMatches: bool, hasRecord: bool, hasExpectation: bool, dispatchedForTask: bool, sameExpectationTaskEpoch: bool, recordSchemaOne: bool, sameRecordTaskEpoch: bool, sameRecordAuthorization: bool, operationMatches: bool, observationMatches: bool, targetMatches: bool, click: bool, sameBill: bool, exactHumanSubmitReview: bool, controlled: bool, selected: bool, exactMaskedMethod: bool }
pure def recoveryAdmitted(readback: MethodRecovery): bool =
  readback.ownerCurrent and readback.recoveryIdle and readback.unknownCount == 1 and (not(readback.discoveryManaged) or readback.savedSourceMatches)
pure def methodRecordBound(readback: MethodRecovery): bool =
  readback.dispatchedForTask and readback.recordSchemaOne and readback.sameRecordTaskEpoch and readback.sameRecordAuthorization and readback.operationMatches and readback.observationMatches and readback.targetMatches and readback.click and readback.sameBill
pure def methodRecovery(readback: MethodRecovery): str =
  if (not(recoveryAdmitted(readback))) "refused"
  else if (readback.hasRecord)
    if (methodRecordBound(readback) and readback.exactHumanSubmitReview) "succeeded" else "unknown"
  else if (readback.hasExpectation and readback.dispatchedForTask and readback.sameExpectationTaskEpoch and readback.controlled and readback.selected and readback.exactMaskedMethod) "succeeded"
  else "unknown"
pure def lawRecoveryIsNeverFailedEffect(readback: MethodRecovery): bool = methodRecovery(readback) != "failed"
pure def lawStoredRecordControlsRecovery(readback: MethodRecovery): bool =
  readback.hasRecord and methodRecovery(readback) == "succeeded" implies recoveryAdmitted(readback) and methodRecordBound(readback) and readback.exactHumanSubmitReview
pure def lawExpectationNeverOverridesUnboundRecord(readback: MethodRecovery): bool =
  readback.hasRecord and not(methodRecordBound(readback)) implies methodRecovery(readback) != "succeeded"
pure def lawExpectationNeedsExactControlledSelection(readback: MethodRecovery): bool =
  not(readback.hasRecord) and methodRecovery(readback) == "succeeded" implies readback.hasExpectation and readback.dispatchedForTask and readback.sameExpectationTaskEpoch and readback.controlled and readback.selected and readback.exactMaskedMethod
pure val boundReadback: MethodRecovery = { ownerCurrent: true, recoveryIdle: true, unknownCount: 1, discoveryManaged: true, savedSourceMatches: true, hasRecord: true, hasExpectation: true, dispatchedForTask: true, sameExpectationTaskEpoch: true, recordSchemaOne: true, sameRecordTaskEpoch: true, sameRecordAuthorization: true, operationMatches: true, observationMatches: true, targetMatches: true, click: true, sameBill: true, exactHumanSubmitReview: true, controlled: true, selected: true, exactMaskedMethod: true }
pure val readbackValues = Set(boundReadback, { ...boundReadback, exactHumanSubmitReview: false }, { ...boundReadback, hasRecord: false }, { ...boundReadback, targetMatches: false }, { ...boundReadback, dispatchedForTask: false }, { ...boundReadback, savedSourceMatches: false }, { ...boundReadback, unknownCount: 2 }, { ...boundReadback, hasRecord: false, selected: false }, { ...boundReadback, hasRecord: false, controlled: false }, { ...boundReadback, hasRecord: false, exactMaskedMethod: false })
```
