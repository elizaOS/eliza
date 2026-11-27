# Conversational forms

## Story: Complete a form across several turns

> As a participant, I can save validated answers, confirm suggestions, and submit the current form when every active required field is ready.

### Each captured answer belongs to one field in the participant's current form

The shell resolves the form definition, normalizes composite controls to stable paths, checks the dependency graph, and decodes external control callbacks. An unstarted form carries no answers yet. A change to an earlier answer recomputes the visible fields and removes answers that became hidden. Suggestions and externally observed values need confirmation when the control requires it.

```quint
type AnswerState = SuggestedAnswer | ConfirmedAnswer
type FormAnswer = { question: str, answerText: str, certainty: AnswerState }
type FormPhase = UnstartedForm | WorkingForm | StashedForm | SubmittedForm | CancelledForm | ExpiredForm
type FormSession = { formPhase: FormPhase, ownerId: str, formId: str, revision: int, expiresAt: int, visibleFields: Set[str], requiredFields: Set[str], answers: List[FormAnswer] }
pure val initial: FormSession = { formPhase: UnstartedForm, ownerId: "", formId: "", revision: 0, expiresAt: 0, visibleFields: Set(), requiredFields: Set(), answers: List() }
pure val ownerIdValues = Set("person")
pure val formIdValues = Set("intake")
pure val questionValues = Set("name", "email")
pure val visibleValues = Set(Set("name", "email"), Set("name"))
pure val requiredValues = Set(Set("name"), Set("name", "email"))
pure val deadlineValues = Set(20, 30)
pure val atValues = Set(10, 20, 30)
pure val versionValues = Set(1, 2, 3, 4)
pure val answerTextValues = Set("Ada", "ada@example.com", "")
pure def canStartForm(s: FormSession, ownerId: str, formId: str, visible: Set[str], required: Set[str], deadline: int): bool =
  s.formPhase == UnstartedForm and ownerId != "" and formId != "" and deadline > 0 and required.subseteq(visible)
pure def startForm(s: FormSession, ownerId: str, formId: str, visible: Set[str], required: Set[str], deadline: int): FormSession =
  { ...s, formPhase: WorkingForm, ownerId: ownerId, formId: formId, revision: 1, expiresAt: deadline, visibleFields: visible, requiredFields: required }
pure def currentEditor(s: FormSession, ownerId: str, version: int, at: int): bool =
  s.ownerId == ownerId and s.revision == version and at >= 0 and at < s.expiresAt
pure def canRecordAnswer(s: FormSession, ownerId: str, version: int, at: int, question: str, answerText: str, visible: Set[str], required: Set[str]): bool =
  currentEditor(s, ownerId, version, at) and s.formPhase == WorkingForm and answerText != "" and
  s.visibleFields.contains(question) and visible.contains(question) and required.subseteq(visible)
pure def recordAnswer(s: FormSession, ownerId: str, version: int, at: int, question: str, answerText: str, confirmed: bool, visible: Set[str], required: Set[str]): FormSession =
  { ...s, revision: s.revision + 1, visibleFields: visible, requiredFields: required,
    answers: s.answers.select(a => a.question != question and visible.contains(a.question)).append(
      { question: question, answerText: answerText, certainty: if (confirmed) ConfirmedAnswer else SuggestedAnswer }) }
pure def canConfirmAnswer(s: FormSession, ownerId: str, version: int, at: int, question: str): bool =
  currentEditor(s, ownerId, version, at) and s.formPhase == WorkingForm and s.answers.some(a => a.question == question and a.certainty == SuggestedAnswer)
pure def confirmAnswer(s: FormSession, ownerId: str, version: int, at: int, question: str): FormSession =
  { ...s, revision: s.revision + 1, answers: s.answers.foldl(List(), (entries, a) =>
    entries.append(if (a.question == question) { ...a, certainty: ConfirmedAnswer } else a)) }
pure def alwaysAnswersVisible(s: FormSession): bool =
  (s.formPhase == UnstartedForm implies s.answers.length() == 0) and s.requiredFields.subseteq(s.visibleFields) and s.answers.every(a => s.visibleFields.contains(a.question) and a.answerText != "")
pure def alwaysOneAnswerPerField(s: FormSession): bool =
  s.answers.every(a => s.answers.select(b => a.question == b.question).length() == 1)
```

### Only a complete, current form can be submitted, and its result is frozen

```quint
pure def requiredAnswersConfirmed(s: FormSession): bool =
  s.requiredFields.forall(q => s.answers.some(a => a.question == q and a.certainty == ConfirmedAnswer))
pure def canSubmitForm(s: FormSession, ownerId: str, version: int, at: int): bool =
  currentEditor(s, ownerId, version, at) and s.formPhase == WorkingForm and requiredAnswersConfirmed(s)
pure def submitForm(s: FormSession, ownerId: str, version: int, at: int): FormSession =
  { ...s, formPhase: SubmittedForm, revision: s.revision + 1 }
pure def alwaysSubmittedFormHasRequiredAnswers(s: FormSession): bool = s.formPhase == SubmittedForm implies requiredAnswersConfirmed(s)
pure def stepSubmittedAnswersDoNotChange(before: FormSession, after: FormSession): bool = before.formPhase == SubmittedForm implies (after.formPhase == SubmittedForm and before.revision == after.revision and before.answers == after.answers)
pure def sometimesFormSubmitted(s: FormSession): bool = s.formPhase == SubmittedForm and s.answers.length() > 0
pure val eval_witness_sometimesFormSubmitted = (("startForm", "person", "intake", Set("name"), Set("name"), 20), ("recordAnswer", "person", 1, 10, "name", "Ada", false, Set("name"), Set("name")), ("confirmAnswer", "person", 2, 10, "name"), ("submitForm", "person", 3, 10))
```

### The participant can shelve and resume an unexpired form, cancel it, or let it expire

```quint
pure def canStashForm(s: FormSession, ownerId: str, version: int, at: int): bool =
  currentEditor(s, ownerId, version, at) and s.formPhase == WorkingForm
pure def stashForm(s: FormSession, ownerId: str, version: int, at: int): FormSession =
  { ...s, formPhase: StashedForm, revision: s.revision + 1 }
pure def canResumeForm(s: FormSession, ownerId: str, version: int, at: int): bool =
  currentEditor(s, ownerId, version, at) and s.formPhase == StashedForm
pure def resumeForm(s: FormSession, ownerId: str, version: int, at: int): FormSession =
  { ...s, formPhase: WorkingForm, revision: s.revision + 1 }
pure def canCancelForm(s: FormSession, ownerId: str, version: int, at: int): bool =
  currentEditor(s, ownerId, version, at) and (s.formPhase == WorkingForm or s.formPhase == StashedForm)
pure def cancelForm(s: FormSession, ownerId: str, version: int, at: int): FormSession =
  { ...s, formPhase: CancelledForm, revision: s.revision + 1 }
pure def canExpireForm(s: FormSession, at: int): bool =
  (s.formPhase == WorkingForm or s.formPhase == StashedForm) and at >= s.expiresAt
pure def expireForm(s: FormSession, at: int): FormSession = { ...s, formPhase: ExpiredForm, revision: s.revision + 1 }
pure def stepStashAndResumeKeepAnswers(before: FormSession, via: str, after: FormSession): bool =
  (via == "stashForm" or via == "resumeForm") implies before.answers == after.answers
```
