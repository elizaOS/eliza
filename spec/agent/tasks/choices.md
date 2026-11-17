# Task choices on the chat wire

## Story: Render only the choices belonging to the task that requested them

> As a user, the choices I am shown in chat belong to the task that asked
> me, and a batch with any foreign or malformed choice shows nothing.

The client admits a chat response's task choices, and the task panels
validate them too; [interaction sessions](../../core/sessions.md) own claim,
commit and replay.

### A batch is shown only when every choice is valid and belongs to the requested task and epoch

The wire is `TaskChoiceWidget` with schema version one, task ID, nonnegative
safe-integer epoch, a 64-character lowercase hex context key, an
`is1:` callback with 32 lowercase hex digits, canonical ISO expiry, choice
state, and a `ChoiceInteraction` block. The four states are pending, claimed,
committed and completed. There are between one and 25 unique option values,
each with a nonempty label of at most 80 UTF-8 bytes and optional description
of at most 1,000 code units. Scope and block IDs are bounded tokens, prompt
is optional and bounded at 1,000 code units, and custom input is disallowed.
Unknown keys are invalid. The decoder supplies structural validation and
clone results for each call. Response admission checks that every widget
matches the request scope, and an accepted widget conveys presentation
only.

```quint
import numbers as Num from "../../core/numbers"
type ChoiceEnvelope = { taskId: str, taskEpoch: int, widgetValid: bool }
type ChoiceBatch = { listShape: bool, canDetach: bool, requestedTask: bool, expectedId: str, expectedEpoch: int, maxWidgets: int, widgets: List[ChoiceEnvelope] }
type ChoiceAdmission = ShowChoices | BadChoiceResponse | BadChoiceWidget | ChoiceScopeMismatch

pure def batchHeadersValid(batch: ChoiceBatch): bool =
  batch.listShape and batch.canDetach and batch.maxWidgets >= 0 and
  batch.maxWidgets <= Num::maxSafeInteger and batch.widgets.length() <= batch.maxWidgets
pure def choiceMatches(batch: ChoiceBatch, widget: ChoiceEnvelope): bool =
  batch.requestedTask and widget.taskId == batch.expectedId and widget.taskEpoch == batch.expectedEpoch
pure def firstAdmission(batch: ChoiceBatch, prior: ChoiceAdmission, widget: ChoiceEnvelope): ChoiceAdmission =
  if (prior != ShowChoices) prior
  else if (not(widget.widgetValid)) BadChoiceWidget
  else if (not(choiceMatches(batch, widget))) ChoiceScopeMismatch
  else ShowChoices
pure def admitChoices(batch: ChoiceBatch): ChoiceAdmission =
  if (not(batchHeadersValid(batch))) BadChoiceResponse
  else if (batch.widgets.length() == 0) ShowChoices
  else if (batch.widgets.length() == 1)
    firstAdmission(batch, ShowChoices, batch.widgets.nthOr(0, ownedWidget))
  else batch.widgets.foldl(ShowChoices, (prior, widget) => firstAdmission(batch, prior, widget))
pure def lawOversizedResponseIsRejected(batch: ChoiceBatch): bool =
  batch.widgets.length() > batch.maxWidgets implies admitChoices(batch) == BadChoiceResponse
pure def lawEmptyResponseDoesNotRequireTask(batch: ChoiceBatch): bool =
  not(batch.requestedTask) and batch.widgets.length() == 0 and batchHeadersValid(batch)
  implies admitChoices(batch) == ShowChoices
pure def lawEachShownWidgetMatches(batch: ChoiceBatch): bool =
  admitChoices(batch) == ShowChoices implies
  batch.widgets.every(widget => widget.widgetValid and choiceMatches(batch, widget))
pure def lawSingleWidgetMustMatchEpoch(batch: ChoiceBatch, widget: ChoiceEnvelope): bool =
  admitChoices({ ...batch, widgets: List(widget) }) == ShowChoices implies
  widget.taskEpoch == batch.expectedEpoch and widget.taskId == batch.expectedId and batch.requestedTask and widget.widgetValid
pure val ownedWidget: ChoiceEnvelope = { taskId: "taskA", taskEpoch: 1, widgetValid: true }
pure val acceptedBatch: ChoiceBatch = { listShape: true, canDetach: true, requestedTask: true, expectedId: "taskA", expectedEpoch: 1, maxWidgets: 2, widgets: List(ownedWidget) }
pure val batchValues = Set(acceptedBatch, { ...acceptedBatch, maxWidgets: 0 },
  { ...acceptedBatch, canDetach: false }, { ...acceptedBatch, requestedTask: false },
  { ...acceptedBatch, widgets: List() },
  { ...acceptedBatch, widgets: List(ownedWidget, { ...ownedWidget, taskEpoch: 2 }) })
pure val widgetValues = Set(ownedWidget, { ...ownedWidget, taskEpoch: 2 }, { ...ownedWidget, widgetValid: false })
```
