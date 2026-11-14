# Grace browser payment controls

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` uses `bill-review-extractor.ts`, `stop-and-ask-rule.ts` and `website-guide-helper.ts` over the Eliza `7743504b7c936a764b3938a44cad918808b621df` guided website workflow. Guidance decides whether to ask about a selected control. The payment-step store owns history matching and write-ahead persistence. The guided browser runtime owns observation binding, fresh authority and effects. None of the following classifications proves that a site actually charged anything.

## Story: Distinguish a control that may pay from entry, navigation and other sends

### The pinned structural classifier gives the control's own evidence precedence

A missing or disabled element, a field, or a string-valued sensitive classification cannot be a payment control. The raw element name is the nonblank label, title and image text joined and trimmed. The exact preparation captions, such as “Continue to Payment Information” or “Review payment,” return false unless the name includes an explicit amount. A raw `a` or `link` needs both an amount in its own name and payment words outside the pinned section phrase list. Another control with either piece of evidence may pay. Nonpayment actions such as sign-in, lookup, verification, help or cancel, and a control that does not send its form, stop the remaining structural check. A send is explicit `submits`, case-insensitive `submit` or `image` type, or a raw `button` with no type and a form.

Structural checking uses other elements with the same integer form index. A sensitive card, bank, account or routing field suffices. Adding selected items to a cart with only same-form radio or checkbox fields and no qualifying page total does not suffice, even with row prices. Otherwise, visible money in nearby or row text, an editable amount or payment field, or a qualifying total suffices. The English total phrase excludes totals still due, owed, or outstanding. Lexical matchers, field detection and rendered form membership supply these facts. These are distinct from a model's description of the page.

```quint
type PaymentEvidence = { elementPresent: bool, disabled: bool, sensitive: bool, fieldElement: bool, explicitPreparation: bool, ownMoney: bool, payWords: bool, sectionWords: bool, linkElement: bool, nonCommitName: bool, sendsForm: bool, formFunding: bool, addToCart: bool, allSelectionFields: bool, formMoney: bool, editableAmount: bool, pageTotal: bool }
pure def positiveMoneyWords(paymentFacts: PaymentEvidence): bool = paymentFacts.payWords and not(paymentFacts.sectionWords)
pure def paymentCommit(paymentFacts: PaymentEvidence): bool =
  if (not(paymentFacts.elementPresent) or paymentFacts.disabled or paymentFacts.sensitive or paymentFacts.fieldElement) false
  else if (not(paymentFacts.ownMoney) and paymentFacts.explicitPreparation) false
  else if (paymentFacts.linkElement) paymentFacts.ownMoney and positiveMoneyWords(paymentFacts)
  else if (paymentFacts.ownMoney or positiveMoneyWords(paymentFacts)) true
  else if (paymentFacts.nonCommitName or not(paymentFacts.sendsForm)) false
  else if (paymentFacts.formFunding) true
  else if (paymentFacts.addToCart and paymentFacts.allSelectionFields and not(paymentFacts.pageTotal)) false
  else paymentFacts.formMoney or paymentFacts.editableAmount or paymentFacts.pageTotal
pure def lawFieldsCannotCommit(paymentFacts: PaymentEvidence): bool =
  paymentFacts.fieldElement or paymentFacts.disabled or paymentFacts.sensitive or not(paymentFacts.elementPresent) implies not(paymentCommit(paymentFacts))
pure def lawLinkNeedsOwnAmountAndPayWords(paymentFacts: PaymentEvidence): bool =
  paymentFacts.linkElement and paymentCommit(paymentFacts) implies paymentFacts.ownMoney and positiveMoneyWords(paymentFacts)
pure def lawPreparationWithoutAmountDoesNotCommit(paymentFacts: PaymentEvidence): bool =
  paymentFacts.explicitPreparation and not(paymentFacts.ownMoney) implies not(paymentCommit(paymentFacts))
pure def lawCartPricesAloneDoNotCommit(paymentFacts: PaymentEvidence): bool =
  paymentFacts.addToCart and paymentFacts.allSelectionFields and not(paymentFacts.pageTotal or paymentFacts.formFunding or paymentFacts.ownMoney or positiveMoneyWords(paymentFacts)) implies not(paymentCommit(paymentFacts))
pure val bareSubmit: PaymentEvidence = { elementPresent: true, disabled: false, sensitive: false, fieldElement: false, explicitPreparation: false, ownMoney: false, payWords: false, sectionWords: false, linkElement: false, nonCommitName: false, sendsForm: true, formFunding: false, addToCart: false, allSelectionFields: false, formMoney: false, editableAmount: false, pageTotal: false }
pure val paymentFactsValues = Set(bareSubmit, { ...bareSubmit, ownMoney: true }, { ...bareSubmit, pageTotal: true }, { ...bareSubmit, pageTotal: true, nonCommitName: true }, { ...bareSubmit, formFunding: true }, { ...bareSubmit, editableAmount: true }, { ...bareSubmit, addToCart: true, allSelectionFields: true, formMoney: true }, { ...bareSubmit, linkElement: true, ownMoney: true, payWords: true }, { ...bareSubmit, explicitPreparation: true, formFunding: true }, { ...bareSubmit, ownMoney: true, disabled: true })
```

### Direct guidance and an agent handoff have distinct pinned inputs

The direct person path first checks the control's own views. All named views must be onward-only before that exception applies, and a link or field bypasses this rule. D9's narrow consequence vocabulary says money if its own words match and either it submits or it is outside the section phrase list. An explicit send unless it is an own-code send, or a nameless submit, yields `send`. A readable raw nonlink, nonfield control can raise either result to money through the structural classifier. When the raw observation cannot be obtained, a consequence the words do establish remains. Otherwise the guide asks about an unclear step.

The optional agent planning floor uses broader English and Spanish vocabulary. For a converted person step, a non-fill, non-select agent plan with a money floor records the exact handed control reference. A fresh reference match makes the resulting person step money even if its direct D9 path did not. The floor's personal-money refusal applies before any dispatch authorization. A pointer for the person is separate from a press by the agent. Control references and page evidence in this model belong to the surrounding workflow observation.

```quint
type GuideControlKind = GuideButton | GuideLink | GuideField | GuideChoice
type GuideConsequence = GuideNone | GuideMoney | GuideSend | GuideUnclear
type GuidanceEvidence = { controlPresent: bool, controlKind: GuideControlKind, ownViewsOnlyOnward: bool, d9MoneyWords: bool, d9SectionWords: bool, d9Submits: bool, d9SendWords: bool, d9OwnCode: bool, ownNamePresent: bool, rawReadable: bool, handedMoneyForRef: bool }
pure def d9Eligible(guide: GuidanceEvidence): bool = guide.controlPresent and guide.controlKind != GuideLink and guide.controlKind != GuideField
pure def d9Consequence(guide: GuidanceEvidence): GuideConsequence =
  if (not(d9Eligible(guide))) GuideNone
  else if (guide.d9MoneyWords and (guide.d9Submits or not(guide.d9SectionWords))) GuideMoney
  else if ((guide.d9SendWords and not(guide.d9OwnCode)) or (guide.d9Submits and not(guide.ownNamePresent))) GuideSend
  else GuideNone
pure def renderedConsequence(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): GuideConsequence =
  if (d9Eligible(guide) and guide.ownViewsOnlyOnward) GuideNone
  else if (guide.rawReadable and guide.controlKind != GuideLink and guide.controlKind != GuideField and paymentCommit(paymentFacts)) GuideMoney
  else d9Consequence(guide)
pure def pinnedPersonConsequence(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): GuideConsequence = {
  val observed = renderedConsequence(guide, paymentFacts)
  if (guide.handedMoneyForRef) GuideMoney
  else if (not(guide.rawReadable) and observed == GuideNone) GuideUnclear
  else observed
}
pure def hasMoneyHandoff(fromAgent: bool, convertedToPerson: bool, pressOrFollow: bool, floorMoney: bool, sameControlRef: bool): bool =
  fromAgent and convertedToPerson and pressOrFollow and floorMoney and sameControlRef
pure def lawHandoffStaysMoney(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): bool = guide.handedMoneyForRef implies pinnedPersonConsequence(guide, paymentFacts) == GuideMoney
pure def lawAbsentSnapshotWithoutPositiveWordsIsUnclear(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): bool =
  not(guide.rawReadable or guide.handedMoneyForRef) and renderedConsequence(guide, paymentFacts) == GuideNone implies pinnedPersonConsequence(guide, paymentFacts) == GuideUnclear
pure def lawDocumentedHandoffRequiresExactControl(fromAgent: bool, convertedToPerson: bool, pressOrFollow: bool, floorMoney: bool, sameControlRef: bool): bool =
  hasMoneyHandoff(fromAgent, convertedToPerson, pressOrFollow, floorMoney, sameControlRef) implies sameControlRef and fromAgent and convertedToPerson
pure val directSpanish: GuidanceEvidence = { controlPresent: true, controlKind: GuideButton, ownViewsOnlyOnward: false, d9MoneyWords: false, d9SectionWords: false, d9Submits: true, d9SendWords: false, d9OwnCode: false, ownNamePresent: true, rawReadable: true, handedMoneyForRef: false }
pure val guideValues = Set(directSpanish, { ...directSpanish, handedMoneyForRef: true }, { ...directSpanish, rawReadable: false }, { ...directSpanish, ownNamePresent: false }, { ...directSpanish, d9MoneyWords: true }, { ...directSpanish, d9SendWords: true }, { ...directSpanish, ownViewsOnlyOnward: true }, { ...directSpanish, controlKind: GuideLink }, { ...directSpanish, controlKind: GuideField })
```

## Story: Ask before guiding the person to a payment control in either shipped language

### The replacement treats independently established payment evidence as money in both paths

The direct-guidance test at `apps/app/test/website-guide-prior-payment.test.mjs:237` remains a TODO at the Grace pin. Its named Spanish `Pagar ahora` submit control has no numeric label, no raw funding or amount field and no qualifying English total phrase. Direct pinned D9 does not raise it to money. The separate hostile-checkout browser scenario enables agent actions, proposes an agent click and exercises the `handedMoney` path. That scenario establishes a different path. The replacement admits a fresh deterministic payment classification for a selected person control even without agent planning. The classification input means evidence of a possible payment on this exact control. It is supplied by reviewed multilingual lexical and rendered-structure policy, independent of the planner's recommendation. Merely being on a bill site or mentioning a balance does not establish it. The exact lexical acceptance suite includes the pinned TODO's `Pagar ahora` and pure navigation/entry without a money consequence.

```quint
pure def replacementPersonConsequence(guide: GuidanceEvidence, paymentFacts: PaymentEvidence, freshPaymentControl: bool): GuideConsequence =
  if (freshPaymentControl and guide.controlPresent and guide.controlKind != GuideField) GuideMoney
  else pinnedPersonConsequence(guide, paymentFacts)
pure def lawDirectClassifiedPaymentRemainsMoney(guide: GuidanceEvidence, paymentFacts: PaymentEvidence, freshPaymentControl: bool): bool =
  freshPaymentControl and guide.controlPresent and guide.controlKind != GuideField implies replacementPersonConsequence(guide, paymentFacts, freshPaymentControl) == GuideMoney
pure def lawReplacementPreservesClassificationWithoutFreshEvidence(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): bool =
  replacementPersonConsequence(guide, paymentFacts, false) == pinnedPersonConsequence(guide, paymentFacts)
pure def lawPinnedSpanishWitnessRemainsExplicit(isHanded: bool): bool =
  pinnedPersonConsequence({ ...directSpanish, handedMoneyForRef: isHanded }, bareSubmit) == (if (isHanded) GuideMoney else GuideNone) and
  replacementPersonConsequence({ ...directSpanish, handedMoneyForRef: isHanded }, bareSubmit, true) == GuideMoney
```

### A recognized payment leads to questions and a durable person pointer, never an agent press

At the release setting the guide checks prior payment before the payment question. A known difference or outstanding form opt-in can require its own question before the ordinary money question. When the control's form is known, only enabled opt-in boxes in that form count. Without form identity, all enabled opt-in boxes on the read page count. Explicit false is clear. True is ticked, and a missing or other checked observation is unclear. Both ticked and unclear count and are never silently called clear. The guide can name the observed boxes without changing them. Exact approval-key generation belongs to the form and task observation. A matching money answer, or an acknowledged amount or unreadable-page reason the source explicitly covers, may satisfy the money question. The owner-fenced store must then atomically recheck prior payment and commit the payment-step row before showing the control. A newly matching prior row makes the pointer wait again. Store failure suppresses the pointer. The browser press belongs to the person regardless of the answers.

```quint
type CheckedState = BoxChecked | BoxClear | BoxUnknown
type OptInBox = { choice: bool, enabledBox: bool, optInWords: bool, sameForm: bool, observedState: CheckedState }
pure def reportsOptIn(boundForm: bool, box: OptInBox): bool = box.choice and box.enabledBox and box.optInWords and (not(boundForm) or box.sameForm) and box.observedState != BoxClear
pure def lawUnknownBoxIsNotClear(boundForm: bool, box: OptInBox): bool =
  box.choice and box.enabledBox and box.optInWords and (not(boundForm) or box.sameForm) and box.observedState == BoxUnknown implies reportsOptIn(boundForm, box)
pure def lawKnownFormExcludesOtherForm(box: OptInBox): bool = not(box.sameForm) implies not(reportsOptIn(true, box))
pure val uncertainBox: OptInBox = { choice: true, enabledBox: true, optInWords: true, sameForm: true, observedState: BoxUnknown }
pure val boxValues = Set(uncertainBox, { ...uncertainBox, observedState: BoxClear }, { ...uncertainBox, observedState: BoxChecked }, { ...uncertainBox, sameForm: false }, { ...uncertainBox, enabledBox: false })
type PaymentReady = { currentObservation: bool, historyReadable: bool, priorNeedsAnswer: bool, siteOrBillDifference: bool, optInNeedsAnswer: bool, moneyAnswerCurrent: bool, atomicPriorNeedsAnswer: bool, rowCommitted: bool }
type PaymentHandoff = NoPayPointer | AskPriorPayment | AskChangedFacts | AskAboutOptIns | AskMoney | PointForPerson
pure def moneyPointer(ready: PaymentReady): PaymentHandoff =
  if (not(ready.currentObservation and ready.historyReadable)) NoPayPointer
  else if (ready.priorNeedsAnswer) AskPriorPayment
  else if (ready.siteOrBillDifference) AskChangedFacts
  else if (ready.optInNeedsAnswer) AskAboutOptIns
  else if (not(ready.moneyAnswerCurrent)) AskMoney
  else if (ready.atomicPriorNeedsAnswer) AskPriorPayment
  else if (not(ready.rowCommitted)) NoPayPointer
  else PointForPerson
pure def agentMayPressMoney(consequence: GuideConsequence): bool = consequence != GuideMoney
pure def lawPayPointerNeedsMatchingConsentAndRow(ready: PaymentReady): bool =
  moneyPointer(ready) == PointForPerson implies ready.currentObservation and ready.historyReadable and ready.moneyAnswerCurrent and ready.rowCommitted and not(ready.priorNeedsAnswer or ready.atomicPriorNeedsAnswer or ready.siteOrBillDifference or ready.optInNeedsAnswer)
pure def lawRaceCanReopenPriorQuestion(ready: PaymentReady): bool =
  ready.currentObservation and ready.historyReadable and ready.moneyAnswerCurrent and not(ready.siteOrBillDifference or ready.optInNeedsAnswer) and ready.atomicPriorNeedsAnswer implies moneyPointer(ready) == AskPriorPayment
pure def lawNoMoneyClassificationAuthorizesAgentPress(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): bool =
  replacementPersonConsequence(guide, paymentFacts, true) == GuideMoney implies not(agentMayPressMoney(replacementPersonConsequence(guide, paymentFacts, true)))
pure val consentedHandoff: PaymentReady = { currentObservation: true, historyReadable: true, priorNeedsAnswer: false, siteOrBillDifference: false, optInNeedsAnswer: false, moneyAnswerCurrent: true, atomicPriorNeedsAnswer: false, rowCommitted: true }
pure val readyValues = Set(consentedHandoff, { ...consentedHandoff, priorNeedsAnswer: true }, { ...consentedHandoff, atomicPriorNeedsAnswer: true }, { ...consentedHandoff, moneyAnswerCurrent: false }, { ...consentedHandoff, siteOrBillDifference: true }, { ...consentedHandoff, optInNeedsAnswer: true }, { ...consentedHandoff, rowCommitted: false }, { ...consentedHandoff, historyReadable: false })
```
