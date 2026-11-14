# Answer from the approved read without running new tools

Pinned Eliza `c518127a025ab173874af9c7d304f26b25213b0d` supplies
`synthesizeDeviceReadReply` in
`plugins/plugin-assistant/src/services/device-actions/read-completion.ts`.
[Original read completion](./readCompletion.md) owns the claim and
canonical memory write for AlphaPhone's approved result.

## Story: Answer the approved read with its exact sources

### Deterministic answers use no model call and model-backed answers allow at most one model call

A request bound to original Calendar availability takes precedence
when its after-read intent is Calendar availability. Otherwise, a Notes
no-match reply, Calendar agenda range, or Calendar next-event reply
takes its deterministic route in that order. Their formatters receive the typed
reviewed result. Current authority is checked before formatting.
Other synthesis uses the original prompt segments and the typed approved
result. The planner runtime refuses a second model call and tool
execution. A valid bound planner terminal output can be used without a
provider call. An abort after the awaited result suppresses delivery.
The enclosing completion service rechecks host authority before delivery.
A separate proposed change requires its own review. The first model
call rechecks authority after consuming its single call allowance. An
unsuccessful recheck cannot be used to retry the model in that synthesis.

```quint
type AnswerKind = ReviewedAvailabilityAnswer | NotesNoMatchAnswer | CalendarRangeAnswer | CalendarNextAnswer | PlannerAnswer
type ReadAnswerMode = DeterministicAnswer | OneModelAnswer
type ApprovedReadKind = NotesQueryResult | CalendarResult | CalendarNextResult | OtherReadResult
type AnswerRouteFacts = { availabilityPurpose: bool, availabilityIntent: bool, resultKind: ApprovedReadKind,
  noteNoMatch: bool, requestedCalendarRange: bool }
pure def routeApprovedRead(routeFacts: AnswerRouteFacts): AnswerKind =
  if (routeFacts.availabilityPurpose and routeFacts.availabilityIntent) ReviewedAvailabilityAnswer
  else if (routeFacts.resultKind == NotesQueryResult and routeFacts.noteNoMatch) NotesNoMatchAnswer
  else if (routeFacts.resultKind == CalendarResult and routeFacts.requestedCalendarRange) CalendarRangeAnswer
  else if (routeFacts.resultKind == CalendarNextResult) CalendarNextAnswer
  else PlannerAnswer
pure val defaultRoute: AnswerRouteFacts = { availabilityPurpose: false, availabilityIntent: false,
  resultKind: OtherReadResult, noteNoMatch: false, requestedCalendarRange: false }
pure val routeFactsValues = Set(defaultRoute,
  { ...defaultRoute, availabilityPurpose: true, availabilityIntent: true, resultKind: CalendarNextResult },
  { ...defaultRoute, resultKind: NotesQueryResult, noteNoMatch: true },
  { ...defaultRoute, resultKind: CalendarResult, requestedCalendarRange: true },
  { ...defaultRoute, resultKind: CalendarNextResult })
pure def lawAvailabilityIntentTakesPrecedence(routeFacts: AnswerRouteFacts): bool =
  (routeFacts.availabilityPurpose and routeFacts.availabilityIntent) implies routeApprovedRead(routeFacts) == ReviewedAvailabilityAnswer
pure def lawAgendaNeedsReviewedRange(routeFacts: AnswerRouteFacts): bool =
  (routeApprovedRead(routeFacts) == CalendarRangeAnswer) implies
    (routeFacts.resultKind == CalendarResult and routeFacts.requestedCalendarRange)
pure def answerMode(kind: AnswerKind): ReadAnswerMode =
  if (kind == PlannerAnswer) OneModelAnswer else DeterministicAnswer
pure def permitsAnswerModelCall(kind: AnswerKind, calls: int, authorityCurrent: bool, aborted: bool): bool =
  answerMode(kind) == OneModelAnswer and calls == 0 and authorityCurrent and not(aborted)
pure val callsValues = Set(0, 1, 2)
type AnswerOperation = RequestModel | RunNewTool
pure def permitsAnswerOperation(kind: AnswerKind, operation: AnswerOperation, calls: int,
  authorityCurrent: bool, aborted: bool): bool =
  operation == RequestModel and permitsAnswerModelCall(kind,calls,authorityCurrent,aborted)
pure def lawModelAnswerCanCallOnlyOnce(kind: AnswerKind, calls: int, authorityCurrent: bool, aborted: bool): bool =
  permitsAnswerModelCall(kind,calls,authorityCurrent,aborted) implies calls == 0 and authorityCurrent and not(aborted)
pure def lawDeterministicAnswerDoesNotCallModel(kind: AnswerKind, calls: int, authorityCurrent: bool, aborted: bool): bool =
  answerMode(kind) == DeterministicAnswer implies not(permitsAnswerModelCall(kind,calls,authorityCurrent,aborted))
pure def lawAnswerNeverRunsTools(kind: AnswerKind, calls: int, authorityCurrent: bool, aborted: bool): bool =
  not(permitsAnswerOperation(kind,RunNewTool,calls,authorityCurrent,aborted))
```

### A model answer needs the exact original source binding and authorized egress

Source fields are data. Notes exposes exact title and body strings as
named sources. Other selected records expose available exact body, title,
description, label or location strings. The reply renderer validates
source parts against the original agent, room and message identity.
The prepared answer text must match the rendered binding exactly. The
terminal planner result must succeed with nonblank text and its prose
must pass egress. The source renderer owns exact quotation expansion
and the transfer limit. The predicate receives its observations and the
egress verdict from those ports.

```quint
type AnswerProof = { aborted: bool, terminalFailure: bool, textNonblank: bool, sameOriginalScope: bool,
  hasRenderedSourceBinding: bool, exactRenderedText: bool, egressAllowed: bool }
pure def acceptsReadAnswer(facts: AnswerProof): bool =
  not(facts.aborted or facts.terminalFailure) and facts.textNonblank and facts.sameOriginalScope and
    facts.hasRenderedSourceBinding and facts.exactRenderedText and facts.egressAllowed
pure val goodAnswer: AnswerProof = { aborted: false, terminalFailure: false, textNonblank: true,
  sameOriginalScope: true, hasRenderedSourceBinding: true, exactRenderedText: true, egressAllowed: true }
pure val factsValues = Set(goodAnswer, { ...goodAnswer, aborted: true }, { ...goodAnswer, exactRenderedText: false },
  { ...goodAnswer, sameOriginalScope: false }, { ...goodAnswer, egressAllowed: false })
pure def lawReplyPreservesSourceBinding(facts: AnswerProof): bool =
  acceptsReadAnswer(facts) implies facts.sameOriginalScope and facts.hasRenderedSourceBinding and facts.exactRenderedText
pure def lawReplyDoesNotOutliveAbort(facts: AnswerProof): bool =
  facts.aborted implies not(acceptsReadAnswer(facts))
```
