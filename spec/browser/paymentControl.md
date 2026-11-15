# Browser payment controls

A host's website guide decides whether to ask the person before pointing to
a selected control. The guided browser runtime owns observation binding,
fresh authority and effects; [manual activity](./manualActivity.md) owns
evidence of what the person did on the page. None of the following
classifications proves that a site actually charged anything.

## Story: Distinguish a control that may pay from entry, navigation and other sends

> As the person, I want the guide to tell a control that may pay apart from one
> that only enters details, navigates or sends something else.

### The structural classifier gives the control's own evidence precedence

A missing or disabled element, a field, or a string-valued sensitive classification cannot be a payment control. The raw element name is the nonblank label, title and image text joined and trimmed. Preparation captions, such as “Continue to Payment Information” or “Review payment,” return false unless the name includes an explicit amount. A raw `a` or `link` needs both an amount in its own name and payment words outside the section phrase list. Another control with either piece of evidence may pay. Nonpayment actions such as sign-in, lookup, verification, help or cancel, and a control that does not send its form, stop the remaining structural check. A send is explicit `submits`, case-insensitive `submit` or `image` type, or a raw `button` with no type and a form.

Structural checking uses other elements with the same integer form index. A sensitive card, bank, account or routing field suffices. Adding selected items to a cart with only same-form radio or checkbox fields and no qualifying page total does not suffice, even with row prices. Otherwise, visible money in nearby or row text, an editable amount or payment field, or a qualifying total suffices. The total phrase excludes totals still due, owed, or outstanding. Lexical matchers, field detection and rendered form membership supply these facts. These are distinct from a model's description of the page.

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

### Direct guidance and an agent handoff have distinct inputs

The direct person path first checks the control's own views. All named views must be onward-only before that exception applies, and a link or field bypasses this rule. The narrow consequence vocabulary says money if its own words match and either it submits or it is outside the section phrase list. An explicit send unless it is an own-code send, or a nameless submit, yields `send`. A readable raw nonlink, nonfield control can raise either result to money through the structural classifier. When the raw observation cannot be obtained, a consequence the words do establish remains. Otherwise the guide asks about an unclear step.

The optional agent planning floor uses a broader vocabulary. For a converted person step, a non-fill, non-select agent plan with a money floor records the exact handed control reference. A fresh reference match makes the resulting person step money even if its direct narrow path did not. The floor's personal-money refusal applies before any dispatch authorization. A pointer for the person is separate from a press by the agent. Control references and page evidence in this model belong to the surrounding workflow observation.

```quint
type GuideControlKind = GuideButton | GuideLink | GuideField | GuideChoice
type GuideConsequence = GuideNone | GuideMoney | GuideSend | GuideUnclear
type GuidanceEvidence = { controlPresent: bool, controlKind: GuideControlKind, ownViewsOnlyOnward: bool, narrowMoneyWords: bool, narrowSectionWords: bool, narrowSubmits: bool, narrowSendWords: bool, narrowOwnCode: bool, ownNamePresent: bool, rawReadable: bool, handedMoneyForRef: bool }
pure def narrowEligible(guide: GuidanceEvidence): bool = guide.controlPresent and guide.controlKind != GuideLink and guide.controlKind != GuideField
pure def narrowConsequence(guide: GuidanceEvidence): GuideConsequence =
  if (not(narrowEligible(guide))) GuideNone
  else if (guide.narrowMoneyWords and (guide.narrowSubmits or not(guide.narrowSectionWords))) GuideMoney
  else if ((guide.narrowSendWords and not(guide.narrowOwnCode)) or (guide.narrowSubmits and not(guide.ownNamePresent))) GuideSend
  else GuideNone
pure def renderedConsequence(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): GuideConsequence =
  if (narrowEligible(guide) and guide.ownViewsOnlyOnward) GuideNone
  else if (guide.rawReadable and guide.controlKind != GuideLink and guide.controlKind != GuideField and paymentCommit(paymentFacts)) GuideMoney
  else narrowConsequence(guide)
pure def personConsequence(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): GuideConsequence = {
  val observed = renderedConsequence(guide, paymentFacts)
  if (guide.handedMoneyForRef) GuideMoney
  else if (not(guide.rawReadable) and observed == GuideNone) GuideUnclear
  else observed
}
pure def hasMoneyHandoff(fromAgent: bool, convertedToPerson: bool, pressOrFollow: bool, floorMoney: bool, sameControlRef: bool): bool =
  fromAgent and convertedToPerson and pressOrFollow and floorMoney and sameControlRef
pure def lawHandoffStaysMoney(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): bool = guide.handedMoneyForRef implies personConsequence(guide, paymentFacts) == GuideMoney
pure def lawAbsentSnapshotWithoutPositiveWordsIsUnclear(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): bool =
  not(guide.rawReadable or guide.handedMoneyForRef) and renderedConsequence(guide, paymentFacts) == GuideNone implies personConsequence(guide, paymentFacts) == GuideUnclear
pure def lawDocumentedHandoffRequiresExactControl(fromAgent: bool, convertedToPerson: bool, pressOrFollow: bool, floorMoney: bool, sameControlRef: bool): bool =
  hasMoneyHandoff(fromAgent, convertedToPerson, pressOrFollow, floorMoney, sameControlRef) implies sameControlRef and fromAgent and convertedToPerson
pure val directSubmit: GuidanceEvidence = { controlPresent: true, controlKind: GuideButton, ownViewsOnlyOnward: false, narrowMoneyWords: false, narrowSectionWords: false, narrowSubmits: true, narrowSendWords: false, narrowOwnCode: false, ownNamePresent: true, rawReadable: true, handedMoneyForRef: false }
pure val guideValues = Set(directSubmit, { ...directSubmit, handedMoneyForRef: true }, { ...directSubmit, rawReadable: false }, { ...directSubmit, ownNamePresent: false }, { ...directSubmit, narrowMoneyWords: true }, { ...directSubmit, narrowSendWords: true }, { ...directSubmit, ownViewsOnlyOnward: true }, { ...directSubmit, controlKind: GuideLink }, { ...directSubmit, controlKind: GuideField })
```

## Story: Ask before guiding the person to a payment control

> As the person, I want to be asked before I am pointed at anything that may
> pay, in whatever language the site uses, and I want to press it myself.

### Independently established payment evidence is money in both paths

A fresh deterministic payment classification for a selected person control
makes the step money even without agent planning. The classification means
evidence of a possible payment on this exact control, supplied by reviewed
multilingual lexical and rendered-structure policy, independent of the
planner's recommendation. Merely being on a site that takes payments or
mentioning a balance does not establish it. Without that evidence the
classification above is unchanged.

```quint
pure def replacementPersonConsequence(guide: GuidanceEvidence, paymentFacts: PaymentEvidence, freshPaymentControl: bool): GuideConsequence =
  if (freshPaymentControl and guide.controlPresent and guide.controlKind != GuideField) GuideMoney
  else personConsequence(guide, paymentFacts)
pure def lawDirectClassifiedPaymentRemainsMoney(guide: GuidanceEvidence, paymentFacts: PaymentEvidence, freshPaymentControl: bool): bool =
  freshPaymentControl and guide.controlPresent and guide.controlKind != GuideField implies replacementPersonConsequence(guide, paymentFacts, freshPaymentControl) == GuideMoney
pure def lawReplacementPreservesClassificationWithoutFreshEvidence(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): bool =
  replacementPersonConsequence(guide, paymentFacts, false) == personConsequence(guide, paymentFacts)
```

### Opt-in boxes that are ticked or unclear are named, never called clear

When the control's form is known, only enabled opt-in boxes in that form count. Without form identity, all enabled opt-in boxes on the read page count. Explicit false is clear. True is ticked, and a missing or other checked observation is unclear. Both ticked and unclear count and are never silently called clear. The guide can name the observed boxes without changing them.

```quint
type CheckedState = BoxChecked | BoxClear | BoxUnknown
type OptInBox = { choice: bool, enabledBox: bool, optInWords: bool, sameForm: bool, observedState: CheckedState }
pure def reportsOptIn(boundForm: bool, box: OptInBox): bool = box.choice and box.enabledBox and box.optInWords and (not(boundForm) or box.sameForm) and box.observedState != BoxClear
pure def lawUnknownBoxIsNotClear(boundForm: bool, box: OptInBox): bool =
  box.choice and box.enabledBox and box.optInWords and (not(boundForm) or box.sameForm) and box.observedState == BoxUnknown implies reportsOptIn(boundForm, box)
pure def lawKnownFormExcludesOtherForm(box: OptInBox): bool = not(box.sameForm) implies not(reportsOptIn(true, box))
pure val uncertainBox: OptInBox = { choice: true, enabledBox: true, optInWords: true, sameForm: true, observedState: BoxUnknown }
pure val boxValues = Set(uncertainBox, { ...uncertainBox, observedState: BoxClear }, { ...uncertainBox, observedState: BoxChecked }, { ...uncertainBox, sameForm: false }, { ...uncertainBox, enabledBox: false })
```

### A payment control gets a pointer for the person only after the money question, and never an agent press

On a current observation, an opt-in that needs an answer is asked about
before the ordinary money question. A matching money answer, or an
acknowledged amount or unreadable-page reason the guide explicitly covers,
satisfies the money question. Only then does the guide point the person at
the control. The press belongs to the person whatever the answers; a control
classified as money is never pressed by the agent.

```quint
type PaymentReady = { currentObservation: bool, optInNeedsAnswer: bool, moneyAnswerCurrent: bool }
type PaymentHandoff = NoPayPointer | AskAboutOptIns | AskMoney | PointForPerson
pure def moneyPointer(ready: PaymentReady): PaymentHandoff =
  if (not(ready.currentObservation)) NoPayPointer
  else if (ready.optInNeedsAnswer) AskAboutOptIns
  else if (not(ready.moneyAnswerCurrent)) AskMoney
  else PointForPerson
pure def agentMayPressMoney(consequence: GuideConsequence): bool = consequence != GuideMoney
pure def lawPayPointerNeedsCurrentConsent(ready: PaymentReady): bool =
  moneyPointer(ready) == PointForPerson implies ready.currentObservation and ready.moneyAnswerCurrent and not(ready.optInNeedsAnswer)
pure def lawNoMoneyClassificationAuthorizesAgentPress(guide: GuidanceEvidence, paymentFacts: PaymentEvidence): bool =
  replacementPersonConsequence(guide, paymentFacts, true) == GuideMoney implies not(agentMayPressMoney(replacementPersonConsequence(guide, paymentFacts, true)))
pure val consentedHandoff: PaymentReady = { currentObservation: true, optInNeedsAnswer: false, moneyAnswerCurrent: true }
pure val readyValues = Set(consentedHandoff, { ...consentedHandoff, moneyAnswerCurrent: false }, { ...consentedHandoff, optInNeedsAnswer: true }, { ...consentedHandoff, currentObservation: false })
```
