# Task lifecycle requests in the renderer

Grace's `apps/app/src/task-lifecycle.ts` wraps the pinned
`packages/ui/src/api/task-lifecycle.ts`. The host owns task authorization,
persisted revision and task epoch. This machine projects asynchronous
responses, with two separate observations for Pause or Close racing an
uncertain task creation. The source validates a version-one task projection
with status, ID, revision, epoch and an unknown-outcome flag.

## Story: Stop a task even if its creation reply has not arrived

### The first pause runs immediately and the second waits for creation to settle

Pause and Close POST `/tasks/current/pause` under a ten-second timeout.
Close sends the close reason. The first request can return before the
pending creation finishes. The same current intent sends a second pause
after the creation settles, even when its reply failed. Background
refresh cannot replace either a user control or the outstanding
follow-up. Reset or a newer user command supersedes the previous intent.

This projection tracks the active creation separately from the current
request ticket. Start validates its bounded goal token, reads the current
task, and posts creation only if still current. On failure it may show the
valid task from that first read while retaining a start error. A reply to a superseded request can still release its own
creation slot. Only the current request can publish a visible task. A
reply with `valid: false` represents a lost, timed-out, or malformed reply.

```quint
type ClientCommand = NoClientCommand | StartClient | RefreshClient | PauseClient | CloseClient | ResumeClient | CancelClient
type ClientStatus = NoClientTask | ClientActive | ClientPaused | ClientBlocked | ClientWaiting | ClientCompleted | ClientCancelled
type TaskReply = { id: str, revision: int, taskEpoch: int, status: ClientStatus, unknownOutcome: bool, valid: bool }
type Client = { generation: int, pending: bool, problem: bool, command: ClientCommand, creating: int, followUp: int, confirmed: TaskReply }
pure val noCommand: ClientCommand = NoClientCommand
pure val startingCommand: ClientCommand = StartClient
pure val refreshCommand: ClientCommand = RefreshClient
pure val pauseCommand: ClientCommand = PauseClient
pure val closeCommand: ClientCommand = CloseClient
pure val resumeCommand: ClientCommand = ResumeClient
pure val cancelCommand: ClientCommand = CancelClient
pure val blankTask: TaskReply = { id: "", revision: 0, taskEpoch: 0, status: NoClientTask, unknownOutcome: false, valid: true }
pure val initial: Client = { generation: 0, pending: false, problem: false, command: noCommand, creating: 0, followUp: 0, confirmed: blankTask }
pure def canBeginCreate(c: Client, validGoal: bool): bool = validGoal and c.creating == 0 and not(c.pending) and c.followUp == 0
pure def beginCreate(c: Client, validGoal: bool): Client =
  { ...c, generation: c.generation + 1, creating: c.generation + 1, followUp: 0, pending: true, problem: false, command: startingCommand }
pure def canFinishCreate(c: Client, ticket: int): bool = c.creating > 0 and c.creating == ticket
pure def finishCreate(c: Client, ticket: int, reply: TaskReply, foundBeforeCreate: TaskReply): Client =
  if (ticket != c.generation) { ...c, creating: 0 }
  else if (reply.valid and reply.status != NoClientTask) { ...c, creating: 0, pending: false, confirmed: reply, problem: false }
  else { ...c, creating: 0, pending: false, problem: true,
    confirmed: if (foundBeforeCreate.valid and foundBeforeCreate.status != NoClientTask) foundBeforeCreate else c.confirmed }
pure def beginPause(c: Client, closing: bool): Client =
  { ...c, generation: c.generation + 1, pending: true, problem: false,
    command: if (closing) closeCommand else pauseCommand,
    followUp: if (c.creating > 0) c.generation + 1 else 0 }
pure def isPause(c: Client): bool = c.command == pauseCommand or c.command == closeCommand
pure def allowsPauseReply(reply: TaskReply): bool = reply.valid and
  (reply.status == NoClientTask or reply.status == ClientPaused or
   reply.status == ClientCompleted or reply.status == ClientCancelled)
pure def canFinishPause(c: Client, ticket: int): bool =
  c.pending and isPause(c) and c.generation == ticket
pure def finishPause(c: Client, ticket: int, reply: TaskReply): Client =
  { ...c, pending: false, problem: not(allowsPauseReply(reply)),
    confirmed: if (allowsPauseReply(reply)) reply else c.confirmed }
pure def canFinishFollowUp(c: Client): bool =
  not(c.pending) and c.creating == 0 and c.followUp > 0 and c.followUp == c.generation and isPause(c)
pure def finishFollowUp(c: Client, reply: TaskReply): Client =
  { ...c, followUp: 0, problem: not(allowsPauseReply(reply)),
    confirmed: if (allowsPauseReply(reply)) reply else c.confirmed }
pure def canReadCurrentTask(c: Client): bool =
  not(c.pending) and c.creating == 0 and c.followUp == 0
pure def readCurrentTask(c: Client): Client =
  { ...c, generation: c.generation + 1, command: refreshCommand }
pure def canFinishCurrentTask(c: Client, ticket: int): bool =
  c.command == refreshCommand and c.generation == ticket and c.creating == 0 and c.followUp == 0 and not(c.pending)
pure def finishCurrentTask(c: Client, ticket: int, reply: TaskReply): Client =
  if (reply.valid) { ...c, confirmed: reply, command: noCommand } else { ...c, command: noCommand }
pure def clearClient(c: Client): Client = { ...initial, generation: c.generation + 1 }
pure def alwaysFollowUpBelongsToPause(c: Client): bool =
  c.followUp != 0 implies c.followUp == c.generation and isPause(c)
pure def stepUncertainCreationKeepsPause(before: Client, via: str, after: Client): bool =
  via == "finishCreate" and before.followUp != 0 implies before.followUp == after.followUp and before.confirmed == after.confirmed
pure def sometimesFollowUpReconcilesCreation(c: Client): bool =
  c.followUp > 0 and not(c.pending) and c.creating == 0
```

## Story: Confirm Resume and Cancel using the current host task

### Creation tickets precede any pause follow-up

Discovered by the proof: when a Pause inherits the creation ticket, a
creation reply can overwrite its user's current pause intent. Each request
takes a new generation. A surviving creation slot has an earlier
generation whenever a follow-up for Pause or Close is pending.

```quint
pure def alwaysCreationTicketsAreIssued(c: Client): bool =
  c.generation >= 0 and c.creating >= 0 and c.creating <= c.generation
pure def alwaysPendingPauseUsesLaterTicket(c: Client): bool =
  c.creating > 0 and c.followUp > 0 implies c.creating < c.followUp
```

### A changed identity or stale revision cannot become a successful control reply

Resume reads the host's current task. Cancel waits for uncertain creation
and first pauses the current task. When one exists, the request carries
its returned revision. The host reply must have the same identity and a
higher revision. Resume requires active status and a nondecreasing epoch.
Cancel requires canceled status and a strictly higher epoch. No current
task is a separate successful empty projection. The model represents the
host request sequence through its checked base reply and terminal observation.
It does not reproduce remote effects.

```quint
pure def canBeginControl(c: Client, cancelling: bool): bool = cancelling or not(c.pending)
pure def beginControl(c: Client, cancelling: bool): Client =
  { ...c, generation: c.generation + 1, pending: true, problem: false, followUp: 0,
    command: if (cancelling) cancelCommand else resumeCommand }
pure def controlAdmitted(command: ClientCommand, base: TaskReply, reply: TaskReply): bool =
  base.valid and (base.status == NoClientTask or
    (reply.valid and reply.id == base.id and reply.revision > base.revision and
    ((command == resumeCommand and reply.status == ClientActive and reply.taskEpoch >= base.taskEpoch) or
     (command == cancelCommand and reply.status == ClientCancelled and reply.taskEpoch > base.taskEpoch))))
pure def canFinishControl(c: Client, ticket: int): bool =
  c.pending and c.generation == ticket and c.creating == 0 and
  (c.command == cancelCommand or c.command == resumeCommand)
pure def finishControl(c: Client, ticket: int, base: TaskReply, reply: TaskReply): Client =
  if (controlAdmitted(c.command, base, reply)) {
    ...c, pending: false, problem: false,
    confirmed: if (base.status == NoClientTask) blankTask else reply
  } else { ...c, pending: false, problem: true }
pure def lawCancelledReplyRequiresNewEpoch(base: TaskReply, reply: TaskReply): bool =
  base.status != NoClientTask and controlAdmitted(cancelCommand, base, reply)
  implies reply.taskEpoch > base.taskEpoch
pure def lawControlCannotAdoptAnotherTask(command: ClientCommand, base: TaskReply, reply: TaskReply): bool =
  base.status != NoClientTask and reply.id != base.id implies not(controlAdmitted(command, base, reply))
pure def sometimesClientConfirmsPause(c: Client): bool =
  c.confirmed.status == ClientPaused and not(c.pending) and not(c.problem)
pure def sometimesClientReportsFailure(c: Client): bool = c.problem
pure val activeReply: TaskReply = { id: "taskA", revision: 2, taskEpoch: 1, status: ClientActive, unknownOutcome: false, valid: true }
pure val pausedReply: TaskReply = { id: "taskA", revision: 1, taskEpoch: 1, status: ClientPaused, unknownOutcome: false, valid: true }
pure val cancelledReply: TaskReply = { id: "taskA", revision: 2, taskEpoch: 2, status: ClientCancelled, unknownOutcome: false, valid: true }
pure val badReply: TaskReply = { ...blankTask, valid: false }
pure val replyValues = Set(activeReply, pausedReply, cancelledReply, blankTask, badReply)
pure val baseValues = Set(pausedReply, activeReply, blankTask, badReply)
pure val foundBeforeCreateValues = Set(activeReply, blankTask)
pure val ticketValues = Set(1, 2, 3, 4, 5, 6)
pure val weight_beginCreate = 3
pure val weight_beginPause = 3
pure val weight_finishCreate = 4
pure val weight_finishPause = 4
pure val weight_finishFollowUp = 5
```
