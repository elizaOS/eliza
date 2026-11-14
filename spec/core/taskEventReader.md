# Paged task event observation

`messaging/task-events.ts` owns a reusable read-only polling reader. It never dispatches or replays task actions. Events enter this model after the exact schema decoder has checked field names, opaque reference grammar and canonical HTTPS origins. That decoder remains an explicit lexical boundary; event kind/status/operation relationships, history merging, cursors and reader state are modeled here.

The immutable polling interval defaults to 2,000 ms and must be a safe integer from 1 through 2,147,483,647 inclusive. Invalid intervals reject construction before a reader exists.

## Story: Observe complete task history without stale page replacement

### Replay is idempotent and histories reject conflicting duplicates or gaps

The initial event is create at sequence/epoch zero with active status, or a checkpoint. Further distinct events increment sequence by one and never decrease epoch. An identical sequence replay is ignored only when every event field agrees. A page contains at most 128 incoming events, but retained history has no truncation. Task head revision/epoch never decrease; a nonterminal page must advance the cursor, while the last page must reach the head revision.

```quint
type TaskStatus = ActiveTask | PausedTask | BlockedTask | WaitingTask | CompletedTask | CancelledTask
type EventKind = CreateEvent | CheckpointEvent | ObserveEvent | ResumeEvent | RebindEvent | PauseEvent | CancelEvent | RecoverEvent | RevokeEvent | CompleteEvent | PrepareEvent | DispatchEvent | ResultEvent | ReconcileEvent | ExtendOriginEvent | RetractOriginEvent
type OperationStatus = NoOperation | PreparedOperation | DispatchedOperation | SucceededOperation | FailedOperation | CancelledOperation | UnknownOperation
type TaskEvent = { task: str, sequence: int, epoch: int, at: int, status: TaskStatus, kind: EventKind, operationId: str, operationStatus: OperationStatus, origin: str }
type TaskPage = { events: List[TaskEvent], cursor: int, hasMore: bool, task: str, revision: int, epoch: int, status: TaskStatus, unknownOutcome: bool }
type MergeState = { events: List[TaskEvent], valid: bool }
pure val noEvent: TaskEvent = { task: "", sequence: -1, epoch: 0, at: 0, status: ActiveTask, kind: CheckpointEvent, operationId: "", operationStatus: NoOperation, origin: "" }
pure val noPage: TaskPage = { events: List(), cursor: -1, hasMore: false, task: "", revision: 0, epoch: 0, status: ActiveTask, unknownOutcome: false }
pure def safeCounter(value: int): bool = value >= 0 and value <= 9007199254740991
pure def validPollingInterval(value: int): bool = value >= 1 and value <= 2147483647
pure def lawInvalidPollingIntervalRejected(value: int): bool = (value < 1 or value > 2147483647) implies not(validPollingInterval(value))
pure def validEvent(activity: TaskEvent): bool = activity.task != "" and safeCounter(activity.sequence) and safeCounter(activity.epoch) and safeCounter(activity.at) and (activity.kind != CreateEvent or (activity.sequence == 0 and activity.epoch == 0 and activity.status == ActiveTask)) and (if (activity.kind == PrepareEvent) activity.operationId != "" and activity.operationStatus == PreparedOperation else if (activity.kind == DispatchEvent) activity.operationId != "" and activity.operationStatus == DispatchedOperation else if (activity.kind == ResultEvent or activity.kind == ReconcileEvent) activity.operationId != "" and (activity.operationStatus == SucceededOperation or activity.operationStatus == FailedOperation or activity.operationStatus == UnknownOperation) else activity.operationId == "" and activity.operationStatus == NoOperation) and (if (activity.kind == ExtendOriginEvent or activity.kind == RetractOriginEvent) activity.origin != "" else if (activity.kind == ObserveEvent or activity.kind == ResumeEvent) true else activity.origin == "")
pure def appendEvent(s: MergeState, task: str, activity: TaskEvent): MergeState = {
  val duplicates = s.events.select(prior => prior.sequence == activity.sequence)
  val previous = s.events.nthOr(s.events.length() - 1, noEvent)
  val acceptable = validEvent(activity) and activity.task == task and (if (duplicates.length() > 0) duplicates.every(prior => prior == activity) else if (s.events.length() == 0) activity.kind == CheckpointEvent or (activity.kind == CreateEvent and activity.sequence == 0) else activity.sequence == previous.sequence + 1 and activity.epoch >= previous.epoch)
  { events: if (s.valid and acceptable and duplicates.length() == 0) s.events.append(activity) else s.events, valid: s.valid and acceptable }
}
pure def mergedEvents(task: str, previousEvents: List[TaskEvent], newEvents: List[TaskEvent]): MergeState = previousEvents.concat(newEvents).foldl({ events: List(), valid: true }, (merged, activity) => appendEvent(merged, task, activity))
pure def acceptsPage(task: str, previous: TaskPage, incoming: TaskPage): bool = {
  val merged = mergedEvents(task, previous.events, incoming.events)
  val cursor = merged.events.nthOr(merged.events.length() - 1, noEvent).sequence
  incoming.task == task and incoming.events.length() <= 128 and incoming.cursor >= -1 and incoming.cursor <= 9007199254740991 and safeCounter(incoming.revision) and safeCounter(incoming.epoch) and incoming.revision >= previous.revision and incoming.epoch >= previous.epoch and merged.valid and incoming.cursor == cursor and cursor <= incoming.revision and (if (incoming.hasMore) cursor > previous.cursor else cursor == incoming.revision)
}
pure def combinePage(task: str, previous: TaskPage, incoming: TaskPage): TaskPage = { ...incoming, events: mergedEvents(task, previous.events, incoming.events).events }
```

### A generation owns its pending read and every publish boundary rechecks it

Start detaches the old generation and clears its page; stop increments generation, clears the timer and pending flag, retains the last page, and publishes nothing. Refresh while pending or detached is a no-op. Accepted pages publish immediately and continue synchronously while hasMore. Read/merge failure retains the last page and does not schedule retries. Polling rearms only after a successful complete page whose task is nonterminal or has unknown effects. Observer callbacks receive clones. Observer failures are typed as `TASK_EVENT_OBSERVER_FAILED`, release pending ownership, preserve the admitted page, and never schedule an automatic retry. Explicit `refresh`, `start` or `stop` remains available after failure. This intentionally repairs the baseline's first-publish throw, which occurs before its try/finally and leaves pending stuck; no consumer contract depends on that leaked latch. A regression scenario is start → first observer throws → pending false/observer failure → explicit refresh succeeds. Read or validation failures also remain explicitly retryable through `refresh` rather than an unbounded automatic network loop.
Discovered by the proof: pending belongs exactly to start publication, reading
and page publication. Every non-idle stage retains the same attached task and
generation; only an idle reader owns a timer. A finishing page can request
another poll only while its preceding publication has succeeded.

```quint
type ReaderPhase = ReaderIdle | PublishStart | ReadingPage | PublishPage | PublishFinish
type ReaderError = NoReaderError | ReadOrMergeFailure | ObserverFailure
type TaskReader = { task: str, generation: int, ticket: int, phase: ReaderPhase, page: TaskPage, pending: bool, failed: bool, timer: bool, again: bool, publishes: int, error: ReaderError }
pure val initial: TaskReader = { task: "", generation: 0, ticket: 0, phase: ReaderIdle, page: noPage, pending: false, failed: false, timer: false, again: false, publishes: 0, error: NoReaderError }
pure def stop(s: TaskReader): TaskReader = { ...s, task: "", generation: s.generation + 1, pending: false, timer: false, phase: ReaderIdle }
pure def canStart(s: TaskReader, task: str): bool = task != ""
pure def start(s: TaskReader, task: str): TaskReader = { ...initial, task: task, generation: s.generation + 2, ticket: s.generation + 2, pending: true, phase: PublishStart, publishes: s.publishes }
pure def refresh(s: TaskReader): TaskReader = if (s.task == "" or s.pending) s else { ...s, generation: s.generation + 1, ticket: s.generation + 1, phase: PublishStart, pending: true, failed: false, timer: false, again: false, error: NoReaderError }
pure def canPublishedStart(s: TaskReader): bool = s.phase == PublishStart
pure def publishedStart(s: TaskReader, success: bool): TaskReader = { ...s, publishes: s.publishes + 1, phase: if (success) ReadingPage else ReaderIdle, pending: success, failed: not(success), error: if (success) NoReaderError else ObserverFailure }
pure def canReceivePage(s: TaskReader, ticket: int): bool = s.phase == ReadingPage and s.ticket == ticket and s.generation == ticket
pure def receivePage(s: TaskReader, ticket: int, incoming: TaskPage, readSucceeded: bool): TaskReader = {
  val valid = readSucceeded and acceptsPage(s.task, s.page, incoming)
  { ...s, page: if (valid) combinePage(s.task, s.page, incoming) else s.page, failed: not(valid), error: if (valid) NoReaderError else ReadOrMergeFailure, phase: if (valid) PublishPage else PublishFinish, pending: valid, again: false }
}
pure def canPublishedPage(s: TaskReader): bool = s.phase == PublishPage
pure def publishedPage(s: TaskReader, success: bool): TaskReader = { ...s, publishes: s.publishes + 1, failed: not(success), error: if (success) NoReaderError else ObserverFailure, pending: success and s.page.hasMore, phase: if (success and s.page.hasMore) ReadingPage else PublishFinish, again: success and not(s.page.hasMore) and ((s.page.status != CompletedTask and s.page.status != CancelledTask) or s.page.unknownOutcome) }
pure def canPublishedFinish(s: TaskReader): bool = s.phase == PublishFinish
pure def publishedFinish(s: TaskReader, success: bool): TaskReader = { ...s, publishes: s.publishes + 1, pending: false, failed: s.failed or not(success), error: if (success) s.error else ObserverFailure, phase: ReaderIdle, timer: success and s.again }
pure def stalePage(s: TaskReader, ticket: int, incoming: TaskPage): TaskReader = s
pure def alwaysTimerOwnsLiveReader(s: TaskReader): bool = s.timer implies s.task != "" and not(s.pending) and not(s.failed)
pure def alwaysPendingHasOwner(s: TaskReader): bool = s.pending implies s.task != "" and s.ticket == s.generation
pure def alwaysReaderPhaseOwnsPending(s: TaskReader): bool = (s.pending iff (s.phase == PublishStart or s.phase == ReadingPage or s.phase == PublishPage)) and (s.phase != ReaderIdle implies s.task != "" and s.ticket == s.generation) and (s.timer implies s.phase == ReaderIdle)
pure def alwaysFinishRearmIsValid(s: TaskReader): bool = s.phase == PublishFinish and s.again implies not(s.failed) and s.task != ""
pure def alwaysRetainedHistoryValid(s: TaskReader): bool = mergedEvents(s.page.task, List(), s.page.events).valid
pure def sometimesObserverFailureReleasesPending(s: TaskReader): bool = s.error == ObserverFailure and s.phase == ReaderIdle and not(s.pending)
pure def sometimesPollingContinues(s: TaskReader): bool = s.timer
pure def sometimesMergeFailureRetainsHistory(s: TaskReader): bool = s.failed and s.page.events.length() > 0
pure val taskValues = Set("task1", "task2")
pure val ticketValues = Set(1, 2, 3, 4)
pure val incomingValues = Set({ events: List({ task: "task1", sequence: 0, epoch: 0, at: 0, status: ActiveTask, kind: CreateEvent, operationId: "", operationStatus: NoOperation, origin: "" }), cursor: 0, hasMore: false, task: "task1", revision: 0, epoch: 0, status: ActiveTask, unknownOutcome: false }, { events: List({ task: "task1", sequence: 1, epoch: 0, at: 1, status: ActiveTask, kind: ObserveEvent, operationId: "", operationStatus: NoOperation, origin: "" }), cursor: 1, hasMore: false, task: "task1", revision: 1, epoch: 0, status: ActiveTask, unknownOutcome: false })
```
