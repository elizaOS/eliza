# Task wire

What the owner's client may send to the [task host](./index.md), what it
gets back, and how a chat turn shows a task's choice. The host keeps the
task; this spec decides which requests reach it, which codes leave it, and
which replies the client may believe.

| Route | Command | Body |
|---|---|---|
| `POST /api/tasks` | start | `{goalRef}` |
| `GET /api/tasks/current` | current | none |
| `GET /api/tasks/current/unreadable` | unreadable records | none |
| `POST /api/tasks/current/pause` | pause the current task | `{}` or `{reason: "close"}` |
| `GET /api/tasks/:id` | view | none |
| `GET /api/tasks/:id/events?after=n` | event page | none |
| `POST /api/tasks/:id/pause` | pause | `{expectedRevision}`, optionally `reason: "close"` |
| `POST /api/tasks/:id/{cancel,resume,acknowledge-unknown}` | cancel, resume, accept an unknown outcome | `{expectedRevision}` |
| `POST /api/tasks/:id/acknowledge-unreadable` | accept unreadable records | `{}` |
| `GET /api/tasks/storage` | storage probe | none |

`:id` matches core's `TASK_ID_PATTERN`; `current` and `storage` are route
names, never ids. A task reply is `{task: view}` or `{task: null}`, where a
view is `{schemaVersion: 1, id, revision, epoch, status, hasUnknownOutcome}`;
accepting an unknown outcome replies `{revision, status}`; the record routes
reply the task store's `{records}`; the event page is core's task event
page. Every reply is `Cache-Control: no-store`.

## Story: Admit only the documented task commands

> As the owner, a task request reaches my task only when it is one of the
> documented commands with exactly the fields it needs, so anything
> malformed or foreign changes nothing and tells me only a safe code.

### Every refusal is one documented code with a fixed status

A coded task failure from the host keeps its `TASK_` code: a code starting
`TASK_STORAGE` answers 503 (`TaskStorageFailure`), any other unlisted code
409 (`TaskStateConflict`). Anything that is not a coded task error becomes
503 `TASK_UNAVAILABLE`; no message, stack or cause crosses.

```quint
import interactiveTask as I from "../../core/interactiveTask"
import index as TH from "./index"
type TaskError = TaskInvalid | TaskUnauthorized | TaskActionDenied | TaskNotFound | TaskMethodNotAllowed | TaskAccountChanged | TaskStateConflict | TaskUnavailable | TaskHelperUnavailable | TaskCleanupUnconfirmed | TaskStorageFailure
pure def httpStatus(e: TaskError): int = if (e == TaskInvalid) 400 else if (e == TaskUnauthorized) 401 else if (e == TaskActionDenied) 403 else if (e == TaskNotFound) 404 else if (e == TaskMethodNotAllowed) 405 else if (e == TaskAccountChanged or e == TaskStateConflict) 409 else 503
```

### Each route names one command, and only a POST changes a task

A path no route matches is `TASK_NOT_FOUND`; a known path with another
method is `TASK_METHOD_NOT_ALLOWED`.

```quint
type TaskCommand = StartCommand | CurrentCommand | UnreadableCommand | PauseCurrentCommand | ViewCommand | EventsCommand | PauseCommand | CancelCommand | ResumeCommand | AcknowledgeUnknownCommand | AcknowledgeUnreadableCommand | StorageCommand
type Method = GetMethod | PostMethod | OtherMethod
type RouteMatch = NoRoute | RouteFor({ command: TaskCommand, method: Method })
pure def methodOf(c: TaskCommand): Method = if (c == CurrentCommand or c == UnreadableCommand or c == ViewCommand or c == EventsCommand or c == StorageCommand) GetMethod else PostMethod
pure def changesTask(c: TaskCommand): bool = c == StartCommand or c == PauseCurrentCommand or c == PauseCommand or c == CancelCommand or c == ResumeCommand or c == AcknowledgeUnknownCommand or c == AcknowledgeUnreadableCommand
pure def lawOnlyAPostChangesATask(c: TaskCommand): bool = changesTask(c) iff methodOf(c) == PostMethod
```

### A command body has exactly the fields its command names

A body is `application/json`, present, at most 2,048 bytes, UTF-8 and an
object, or it is malformed. `goalRef` is valid when it matches
`[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}`; `reason` only when it is `"close"`;
`expectedRevision` only when it is a nonnegative safe integer. A GET ignores
its body.

```quint
type Field = FieldMissing | FieldValid | FieldMalformed
type Body = NoBody | MalformedBody | ObjectBody({ goalRef: Field, reason: Field, expectedRevision: Field, otherKeys: bool })
pure def bodyAdmitted(c: TaskCommand, b: Body): bool = if (methodOf(c) == GetMethod) true else match b {
  | ObjectBody(x) => not(x.otherKeys) and x.reason != FieldMalformed and (if (c == StartCommand) x.goalRef == FieldValid and x.reason == FieldMissing and x.expectedRevision == FieldMissing
      else if (c == PauseCurrentCommand) x.goalRef == FieldMissing and x.expectedRevision == FieldMissing
      else if (c == PauseCommand) x.goalRef == FieldMissing and x.expectedRevision == FieldValid
      else if (c == AcknowledgeUnreadableCommand) x.goalRef == FieldMissing and x.reason == FieldMissing and x.expectedRevision == FieldMissing
      else x.goalRef == FieldMissing and x.reason == FieldMissing and x.expectedRevision == FieldValid)
  | _ => false
}
pure val bValues = Set(NoBody, MalformedBody, ObjectBody({ goalRef: FieldMissing, reason: FieldMissing, expectedRevision: FieldMissing, otherKeys: false }), ObjectBody({ goalRef: FieldValid, reason: FieldMissing, expectedRevision: FieldMissing, otherKeys: false }), ObjectBody({ goalRef: FieldMissing, reason: FieldValid, expectedRevision: FieldMissing, otherKeys: false }), ObjectBody({ goalRef: FieldMissing, reason: FieldValid, expectedRevision: FieldValid, otherKeys: false }), ObjectBody({ goalRef: FieldMissing, reason: FieldMissing, expectedRevision: FieldValid, otherKeys: false }), ObjectBody({ goalRef: FieldMissing, reason: FieldMissing, expectedRevision: FieldMalformed, otherKeys: false }), ObjectBody({ goalRef: FieldMissing, reason: FieldMissing, expectedRevision: FieldValid, otherKeys: true }))
pure def lawCloseIsOnlyAPause(c: TaskCommand, b: Body): bool = (methodOf(c) == PostMethod and bodyAdmitted(c, b) and (match b { | ObjectBody(x) => x.reason == FieldValid | _ => false })) implies (c == PauseCommand or c == PauseCurrentCommand)
pure def lawATaskByIdChangesOnlyAtTheRevisionRead(c: TaskCommand, b: Body): bool = (bodyAdmitted(c, b) and (c == PauseCommand or c == CancelCommand or c == ResumeCommand or c == AcknowledgeUnknownCommand)) implies (match b { | ObjectBody(x) => x.expectedRevision == FieldValid | _ => false })
```

### Only the event page takes a query, and its cursor is canonical

The one entry `after` is `-1`, `0` or a decimal without a leading zero, a
safe integer; a missing cursor starts before the first event, as `-1` does.
A cursor past the task's revision is `TASK_INVALID`.

```quint
type Query = NoQuery | AfterQuery({ canonical: bool, after: int }) | OtherQuery
pure def queryAdmitted(c: TaskCommand, q: Query): bool = match q { | NoQuery => true | AfterQuery(x) => c == EventsCommand and x.canonical and x.after >= -1 | _ => false }
pure def cursorFits(q: Query, revision: int): bool = match q { | AfterQuery(x) => x.after <= revision | _ => true }
pure val qValues = Set(NoQuery, OtherQuery, AfterQuery({ canonical: true, after: -1 }), AfterQuery({ canonical: true, after: 3 }), AfterQuery({ canonical: false, after: 3 }), AfterQuery({ canonical: true, after: -2 }))
```

### Only the launch account reaches a serving host, and the storage probe needs neither

The sender is checked first: a request not from the launch account is
`TASK_UNAUTHORIZED`, and one reaching a host that is not started or is
poisoned is `TASK_UNAVAILABLE`. Then the route, the query, a start without
an actuator or goal authorizer (`TASK_HELPER_UNAVAILABLE`, so no cosmetic
task is made) and the body, in that order. Nothing is read or written for a
refused request. The storage probe answers anyone the agent's own access
gate admitted, even a poisoned host, and changes nothing.

```quint
type Admission = Admitted({ command: TaskCommand }) | Refused({ error: TaskError })
pure def admit(owner: bool, serving: bool, route: RouteMatch, helperReady: bool, b: Body, q: Query): Admission = match route {
  | NoRoute => Refused({ error: if (not(owner)) TaskUnauthorized else if (not(serving)) TaskUnavailable else TaskNotFound })
  | RouteFor(x) => if (x.command == StorageCommand and x.method == GetMethod and q == NoQuery) Admitted({ command: StorageCommand })
      else if (not(owner)) Refused({ error: TaskUnauthorized })
      else if (not(serving)) Refused({ error: TaskUnavailable })
      else if (x.method != methodOf(x.command)) Refused({ error: TaskMethodNotAllowed })
      else if (not(queryAdmitted(x.command, q))) Refused({ error: TaskInvalid })
      else if (x.command == StartCommand and not(helperReady)) Refused({ error: TaskHelperUnavailable })
      else if (not(bodyAdmitted(x.command, b))) Refused({ error: TaskInvalid })
      else Admitted({ command: x.command })
}
pure val routeValues = Set(NoRoute, RouteFor({ command: StartCommand, method: PostMethod }), RouteFor({ command: PauseCommand, method: PostMethod }), RouteFor({ command: PauseCommand, method: GetMethod }), RouteFor({ command: EventsCommand, method: GetMethod }), RouteFor({ command: StorageCommand, method: GetMethod }), RouteFor({ command: AcknowledgeUnreadableCommand, method: PostMethod }))
pure def lawAStrangerReachesOnlyTheStorageProbe(owner: bool, serving: bool, route: RouteMatch, helperReady: bool, b: Body, q: Query): bool = {
  val decision = admit(owner, serving, route, helperReady, b, q)
  (not(owner) or not(serving)) implies (match decision { | Admitted(x) => x.command == StorageCommand | _ => true })
}
pure def lawAnAdmittedCommandIsWellFormed(owner: bool, serving: bool, route: RouteMatch, helperReady: bool, b: Body, q: Query): bool = {
  val decision = admit(owner, serving, route, helperReady, b, q)
  match decision { | Admitted(x) => bodyAdmitted(x.command, b) and queryAdmitted(x.command, q) | _ => true }
}
```

### A repeated start of the running task's goal returns that task

A start whose first reply was lost gets the task already running for the
same goal (200) while its authority stands; otherwise a free slot creates a
task (201) under the host's `canCreate`, with the goal authorizer's origins
and capabilities, never the client's; anything else is a conflict (409,
with the host's own code). The authorizer must return the same `goalRef`, else
`TASK_ACTION_DENIED`.

```quint
type StartReply = ExistingTask | NewTask | StartRefused({ error: TaskError })
pure def runningTask(h: TH::TaskHost): bool = TH::unfinished(h.task) and h.task.authorized
pure def startReply(goalConfirmed: bool, running: bool, sameGoal: bool, slotFree: bool): StartReply = if (not(goalConfirmed)) StartRefused({ error: TaskActionDenied }) else if (running and sameGoal) ExistingTask else if (not(running) and slotFree) NewTask else StartRefused({ error: TaskStateConflict })
```

### A reply after the host stopped serving says whether a change was saved

A request rechecks its sender after it writes. If the host stopped serving
it meanwhile, a request that saved nothing answers `TASK_UNAUTHORIZED` and
one that saved a change answers `TASK_ACCOUNT_CHANGED`, so a 401 always
means nothing happened. A cleanup the actuator has not confirmed answers
`TASK_CLEANUP_UNCONFIRMED` after the change is saved.

```quint
pure def lateRefusal(committed: bool): TaskError = if (committed) TaskAccountChanged else TaskUnauthorized
```

### The storage probe reports unavailable for a poisoned host

It replies `{schemaVersion: 1, taskStorage}`. Otherwise it reports what the
task store's inspector says: `deferred` while the store waits for its key.

```quint
type TaskStorage = StorageOk | StorageUnavailable | StorageDeferred
pure def storageProbe(h: TH::TaskHost, inspected: TaskStorage): TaskStorage = if (h.poisoned) StorageUnavailable else inspected
```

### A view shows six public fields of the held task, or null

`hasUnknownOutcome` is true exactly while the task's operation is unknown.
The client copies the six fields; a reply with no `task` member, or one that
is neither null nor a valid view, is invalid and never read as no task.

```quint
type ViewStatus = ShownActive | ShownPaused | ShownWaiting | ShownBlocked | ShownCompleted | ShownCancelled
type ShownView = { id: str, revision: int, epoch: int, status: ViewStatus, hasUnknownOutcome: bool }
type TaskViewResult = TaskViewInvalid | NoTaskView | TaskViewShown(ShownView)
pure def viewStatus(s: I::TaskStatus): ViewStatus = if (s == I::Paused) ShownPaused else if (s == I::Waiting) ShownWaiting else if (s == I::Blocked) ShownBlocked else if (s == I::Completed) ShownCompleted else if (s == I::Cancelled) ShownCancelled else ShownActive
pure def viewOf(h: TH::TaskHost): TaskViewResult = if (h.task.status == I::Absent) NoTaskView else TaskViewShown({ id: h.task.taskId, revision: h.task.revision, epoch: h.task.epoch, status: viewStatus(h.task.status), hasUnknownOutcome: h.task.operation.status == I::Unknown })
pure def admitView(hasMember: bool, isNull: bool, wellFormed: bool, wireView: ShownView): TaskViewResult = if (not(hasMember)) TaskViewInvalid else if (isNull) NoTaskView else if (wellFormed and wireView.id != "" and wireView.revision >= 0 and wireView.epoch >= 0) TaskViewShown({ id: wireView.id, revision: wireView.revision, epoch: wireView.epoch, status: wireView.status, hasUnknownOutcome: wireView.hasUnknownOutcome }) else TaskViewInvalid
pure val wireViewValues = Set({ id: "task1", revision: 2, epoch: 1, status: ShownPaused, hasUnknownOutcome: true }, { id: "", revision: 0, epoch: 0, status: ShownActive, hasUnknownOutcome: false }, { id: "task1", revision: -1, epoch: 0, status: ShownActive, hasUnknownOutcome: false })
pure def lawMalformedViewIsNeverNoTask(hasMember: bool, isNull: bool, wellFormed: bool, wireView: ShownView): bool = (not(hasMember) or not(isNull)) implies admitView(hasMember, isNull, wellFormed, wireView) != NoTaskView
```

## Story: Show a task's choice in the chat

> As the owner, when I ask about my task in a chat turn I see only a choice
> the task itself offered at the epoch I named, and a turn that outlived
> that epoch shows none.

### A chat turn names a task only while the host presents it at that epoch

A turn body may carry `task {taskId, expectedEpoch}`. Before the turn runs,
the host's `presentationForConversation` for the launch account must
present it: no presenter is 503 `TASK_UNAVAILABLE`, a refusal a conflict
(409), and nothing is stored. The product plugin's
`formatTaskContext(presentation)` is appended to the text. After the reply
the presentation is read again: a different one is 409 and shows nothing;
the same one returns `taskChoices` in the buffered reply and in `done`,
holding the task's offered choice when it belongs to that task and epoch.
Only the host supplies a choice, never the model's output.

```quint
type TaskChoice = { taskId: str, epoch: int, widgetValid: bool }
type OfferedChoice = NoChoice | Offered(TaskChoice)
type ChatTaskStart = ChatTaskAdmitted | ChatTaskRefused({ error: TaskError })
type ChatTaskEnd = ChatTaskChanged | ChatTaskShown({ choices: List[TaskChoice] })
pure def chatTaskStart(presenterReady: bool, presented: TH::Presentation): ChatTaskStart = if (not(presenterReady)) ChatTaskRefused({ error: TaskUnavailable }) else if (presented == TH::PresentationRefused) ChatTaskRefused({ error: TaskStateConflict }) else ChatTaskAdmitted
pure def choiceBelongs(taskId: str, epoch: int, c: TaskChoice): bool = c.widgetValid and taskId != "" and c.taskId == taskId and c.epoch == epoch
pure def chatTaskEnd(taskId: str, expectedEpoch: int, presented: TH::Presentation, presentedAfter: TH::Presentation, offered: OfferedChoice): ChatTaskEnd = if (presentedAfter != presented or presented == TH::PresentationRefused) ChatTaskChanged else match offered {
  | Offered(c) => if (choiceBelongs(taskId, expectedEpoch, { taskId: c.taskId, epoch: c.epoch, widgetValid: c.widgetValid })) ChatTaskShown({ choices: List({ taskId: c.taskId, epoch: c.epoch, widgetValid: c.widgetValid }) }) else ChatTaskShown({ choices: List() })
  | _ => ChatTaskShown({ choices: List() })
}
pure val presentedValues = Set(TH::PresentationRefused, TH::Presented({ taskId: "task1", epoch: 1, revision: 2 }), TH::Presented({ taskId: "task1", epoch: 2, revision: 4 }))
pure val presentedAfterValues = presentedValues
pure val choiceValues = Set({ taskId: "task1", epoch: 1, widgetValid: true }, { taskId: "task1", epoch: 2, widgetValid: true }, { taskId: "task2", epoch: 1, widgetValid: true }, { taskId: "task1", epoch: 1, widgetValid: false })
pure val offeredValues = Set(NoChoice, Offered({ taskId: "task1", epoch: 1, widgetValid: true }), Offered({ taskId: "task2", epoch: 1, widgetValid: true }), Offered({ taskId: "task1", epoch: 2, widgetValid: false }))
```

### A choice batch is shown only when every choice is valid for the task and epoch

The client hides the whole batch when any one choice is malformed or
belongs to another task or epoch.

```quint
pure def showChoices(taskId: str, epoch: int, batch: List[TaskChoice]): bool = batch.every(c => choiceBelongs(taskId, epoch, c))
pure val batchValues = Set(List(), List({ taskId: "task1", epoch: 1, widgetValid: true }), List({ taskId: "task1", epoch: 1, widgetValid: true }, { taskId: "task1", epoch: 2, widgetValid: true }), List({ taskId: "task1", epoch: 1, widgetValid: false }))
pure def lawOneForeignChoiceHidesTheBatch(taskId: str, epoch: int, batch: List[TaskChoice], choice: TaskChoice): bool = not(choiceBelongs(taskId, epoch, choice)) implies not(showChoices(taskId, epoch, batch.append(choice)))
pure def lawChatShowsOnlyTheNamedTasksChoices(taskId: str, expectedEpoch: int, presented: TH::Presentation, presentedAfter: TH::Presentation, offered: OfferedChoice): bool = {
  val ending = chatTaskEnd(taskId, expectedEpoch, presented, presentedAfter, offered)
  match ending { | ChatTaskShown(x) => showChoices(taskId, expectedEpoch, x.choices) | _ => true }
}
```

## Story: Stop a task even before its creation reply arrives

> As the owner, I can pause or close a task I just started before the reply
> that created it comes back, and Resume or Cancel never reports success
> for a task other than the one I acted on.

### The first pause goes out at once and a second follows when creation settles

Pause and Close post to `/api/tasks/current/pause` at once, under a ten
second timeout; the host pauses whatever task it holds. When a start is
still waiting for its reply, the same pause is sent again once that reply
arrives or fails. Each user command takes a new ticket; a reply to an
older ticket changes nothing but may release its own creation slot, and a
background refresh never replaces a user command or the follow-up.

```quint
type ClientCommand = NoCommand | StartCmd | PauseCmd | CloseCmd | ResumeCmd | CancelCmd
type TaskClient = { generation: int, creating: int, command: ClientCommand, pending: bool, followUp: int, base: TaskViewResult, shown: TaskViewResult, problem: bool }
pure val initial: TaskClient = { generation: 0, creating: 0, command: NoCommand, pending: false, followUp: 0, base: NoTaskView, shown: NoTaskView, problem: false }
pure def isShown(v: TaskViewResult): bool = match v { | TaskViewShown(x) => true | _ => false }
pure def shownOr(v: TaskViewResult): ShownView = match v { | TaskViewShown(x) => { id: x.id, revision: x.revision, epoch: x.epoch, status: x.status, hasUnknownOutcome: x.hasUnknownOutcome } | _ => { id: "", revision: -1, epoch: -1, status: ShownActive, hasUnknownOutcome: false } }
pure def isPause(command: ClientCommand): bool = command == PauseCmd or command == CloseCmd
pure def pauseSettled(reply: TaskViewResult): bool = reply == NoTaskView or (isShown(reply) and (shownOr(reply).status == ShownPaused or shownOr(reply).status == ShownCompleted or shownOr(reply).status == ShownCancelled))
pure def canBeginStart(c: TaskClient): bool = c.creating == 0 and not(c.pending) and c.followUp == 0
pure def beginStart(c: TaskClient): TaskClient = { ...c, generation: c.generation + 1, creating: c.generation + 1, command: StartCmd, pending: true, problem: false }
pure def canFinishStart(c: TaskClient, ticket: int): bool = c.creating > 0 and c.creating == ticket
pure def finishStart(c: TaskClient, ticket: int, reply: TaskViewResult): TaskClient = if (ticket != c.generation) { ...c, creating: 0 } else if (isShown(reply)) { ...c, creating: 0, pending: false, shown: reply, problem: false } else { ...c, creating: 0, pending: false, problem: true }
pure def beginPause(c: TaskClient, closing: bool): TaskClient = { ...c, generation: c.generation + 1, command: if (closing) CloseCmd else PauseCmd, pending: true, problem: false, followUp: if (c.creating > 0) c.generation + 1 else 0 }
pure def canFinishPause(c: TaskClient, ticket: int): bool = c.pending and isPause(c.command) and c.generation == ticket
pure def finishPause(c: TaskClient, ticket: int, reply: TaskViewResult): TaskClient = { ...c, pending: false, problem: not(pauseSettled(reply)), shown: if (pauseSettled(reply)) reply else c.shown }
pure def canFinishFollowUp(c: TaskClient): bool = not(c.pending) and c.creating == 0 and c.followUp > 0 and c.followUp == c.generation
pure def finishFollowUp(c: TaskClient, reply: TaskViewResult): TaskClient = { ...c, followUp: 0, problem: not(pauseSettled(reply)), shown: if (pauseSettled(reply)) reply else c.shown }
pure def canRefresh(c: TaskClient): bool = not(c.pending) and c.creating == 0 and c.followUp == 0
pure def refresh(c: TaskClient, reply: TaskViewResult): TaskClient = if (reply == TaskViewInvalid) c else { ...c, shown: reply }
pure val ticketValues = Set(1, 2, 3, 4, 5)
pure val replyValues = Set(TaskViewInvalid, NoTaskView, TaskViewShown({ id: "task1", revision: 1, epoch: 0, status: ShownActive, hasUnknownOutcome: false }), TaskViewShown({ id: "task1", revision: 2, epoch: 1, status: ShownPaused, hasUnknownOutcome: false }), TaskViewShown({ id: "task1", revision: 3, epoch: 1, status: ShownActive, hasUnknownOutcome: false }), TaskViewShown({ id: "task1", revision: 3, epoch: 2, status: ShownCancelled, hasUnknownOutcome: false }), TaskViewShown({ id: "task2", revision: 3, epoch: 2, status: ShownCancelled, hasUnknownOutcome: false }))
pure val weight_beginPause = 3
pure val weight_finishStart = 3
pure def alwaysTicketsAreIssued(c: TaskClient): bool = c.generation >= 0 and c.creating >= 0 and c.creating <= c.generation and c.followUp >= 0 and c.followUp <= c.generation
pure def alwaysFollowUpBelongsToTheCurrentPause(c: TaskClient): bool = c.followUp != 0 implies (c.followUp == c.generation and isPause(c.command) and c.creating < c.followUp)
pure def alwaysShownIsNeverInvalid(c: TaskClient): bool = c.shown != TaskViewInvalid and c.base != TaskViewInvalid
pure def stepALateCreationReplyKeepsTheLaterCommand(before: TaskClient, via: str, after: TaskClient): bool = (via == "finishStart" and before.creating != before.generation) implies (after.shown == before.shown and after.pending == before.pending and after.problem == before.problem and after.followUp == before.followUp)
pure def sometimesPausedBeforeCreationReplied(c: TaskClient): bool = c.creating > 0 and c.followUp > 0
pure def sometimesPauseConfirmedAfterStart(c: TaskClient): bool = c.followUp == 0 and isPause(c.command) and not(c.pending) and not(c.problem) and isShown(c.shown) and shownOr(c.shown).status == ShownPaused and c.generation >= 2
```

### A changed identity or stale revision never becomes a successful Resume or Cancel

Resume and Cancel carry the revision of the task the client shows. The
reply must name the same task at a higher revision: Resume an active task
at the same or a later epoch, Cancel a cancelled one at a later epoch. With
no task shown there is nothing to send, which succeeds with no task.

```quint
pure def controlAdmitted(command: ClientCommand, base: TaskViewResult, reply: TaskViewResult): bool = {
  val b = shownOr(base)
  val r = shownOr(reply)
  base == NoTaskView or (isShown(base) and isShown(reply) and r.id == b.id and r.revision > b.revision and ((command == ResumeCmd and r.status == ShownActive and r.epoch >= b.epoch) or (command == CancelCmd and r.status == ShownCancelled and r.epoch > b.epoch)))
}
pure def canBeginControl(c: TaskClient, cancelling: bool): bool = not(c.pending) and c.creating == 0 and c.followUp == 0
pure def beginControl(c: TaskClient, cancelling: bool): TaskClient = { ...c, generation: c.generation + 1, command: if (cancelling) CancelCmd else ResumeCmd, pending: true, problem: false, base: c.shown }
pure def canFinishControl(c: TaskClient, ticket: int): bool = c.pending and c.generation == ticket and (c.command == ResumeCmd or c.command == CancelCmd)
pure def finishControl(c: TaskClient, ticket: int, reply: TaskViewResult): TaskClient = if (controlAdmitted(c.command, c.base, reply)) { ...c, pending: false, problem: false, shown: if (isShown(c.base)) reply else NoTaskView } else { ...c, pending: false, problem: true }
pure val baseValues = replyValues
pure def lawControlNeverAdoptsAnotherTask(command: ClientCommand, base: TaskViewResult, reply: TaskViewResult): bool = (isShown(base) and shownOr(reply).id != shownOr(base).id) implies not(controlAdmitted(command, base, reply))
pure def lawCancelNeedsANewEpoch(base: TaskViewResult, reply: TaskViewResult): bool = (isShown(base) and controlAdmitted(CancelCmd, base, reply)) implies shownOr(reply).epoch > shownOr(base).epoch
pure def stepControlSuccessShowsTheSameTaskLater(before: TaskClient, via: str, after: TaskClient): bool = (via == "finishControl" and not(after.problem) and isShown(before.base)) implies (shownOr(after.shown).id == shownOr(before.base).id and shownOr(after.shown).revision > shownOr(before.base).revision)
pure def sometimesResumeConfirmed(c: TaskClient): bool = c.command == ResumeCmd and not(c.pending) and not(c.problem) and isShown(c.base) and shownOr(c.shown).status == ShownActive
pure def sometimesStaleCancelReported(c: TaskClient): bool = c.command == CancelCmd and not(c.pending) and c.problem and isShown(c.base)
```
