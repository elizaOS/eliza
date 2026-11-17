# Task lifecycle requests in the renderer

The renderer's requests to start, pause, close, resume and cancel a task,
and which replies it may show. The host owns task authorization, revision
and epoch; replies are [task views](../tasks/http.md).

## Story: Stop a task even if its creation reply has not arrived

> As a user, I can pause or close a task I just started, even before the
> reply that created it comes back.

### The first pause runs immediately and the second waits for creation to settle

Pause and Close request a pause of the current task under a ten-second timeout.
Close sends the close reason. The first request can return before the
pending creation finishes. The same current intent sends a second pause
after the creation settles, even when its reply failed. Background
refresh cannot replace either a user control or the outstanding
follow-up. Reset or a newer user command supersedes the previous intent.

The active creation is tracked separately from the current request ticket. Start validates its bounded goal token, reads the current
task, and posts creation only if still current. On failure it may show the
valid task from that first read while retaining a start error. A reply to a superseded request can still release its own
creation slot. Only the current request can publish a visible task. A
invalid reply stands for a lost, timed-out or malformed one.

```quint
type ClientCommand = NoClientCommand | StartClient | RefreshClient | PauseClient | CloseClient | ResumeClient | CancelClient
import http.* from "../tasks/http"
type Client = { generation: int, pending: bool, problem: bool, command: ClientCommand, creating: int, followUp: int, confirmed: TaskViewResult }
pure val noView: TaskView = { schemaVersion: 1, id: "", revision: 0, epoch: 0, status: TaskActive, hasUnknownOutcome: false }
pure def presentTask(reply: TaskViewResult): bool = match reply { | TaskViewPresent(view) => true | _ => false }
pure def shownTask(reply: TaskViewResult): TaskView = match reply { | TaskViewPresent(view) => { schemaVersion: view.schemaVersion, id: view.id, revision: view.revision, epoch: view.epoch, status: view.status, hasUnknownOutcome: view.hasUnknownOutcome } | _ => noView }
pure val initial: Client = { generation: 0, pending: false, problem: false, command: NoClientCommand, creating: 0, followUp: 0, confirmed: TaskViewAbsent }
pure def canBeginCreate(c: Client, validGoal: bool): bool = validGoal and c.creating == 0 and not(c.pending) and c.followUp == 0
pure def beginCreate(c: Client, validGoal: bool): Client =
  { ...c, generation: c.generation + 1, creating: c.generation + 1, followUp: 0, pending: true, problem: false, command: StartClient }
pure def canFinishCreate(c: Client, ticket: int): bool = c.creating > 0 and c.creating == ticket
pure def finishCreate(c: Client, ticket: int, reply: TaskViewResult, foundBeforeCreate: TaskViewResult): Client =
  if (ticket != c.generation) { ...c, creating: 0 }
  else if (presentTask(reply)) { ...c, creating: 0, pending: false, confirmed: reply, problem: false }
  else { ...c, creating: 0, pending: false, problem: true,
    confirmed: if (presentTask(foundBeforeCreate)) foundBeforeCreate else c.confirmed }
pure def beginPause(c: Client, closing: bool): Client =
  { ...c, generation: c.generation + 1, pending: true, problem: false,
    command: if (closing) CloseClient else PauseClient,
    followUp: if (c.creating > 0) c.generation + 1 else 0 }
pure def isPause(c: Client): bool = c.command == PauseClient or c.command == CloseClient
pure def allowsPauseReply(reply: TaskViewResult): bool =
  val status = shownTask(reply).status
  reply == TaskViewAbsent or (presentTask(reply) and (status == TaskPaused or status == TaskCompleted or status == TaskCancelled))
pure def canFinishPause(c: Client, ticket: int): bool =
  c.pending and isPause(c) and c.generation == ticket
pure def finishPause(c: Client, ticket: int, reply: TaskViewResult): Client =
  { ...c, pending: false, problem: not(allowsPauseReply(reply)),
    confirmed: if (allowsPauseReply(reply)) reply else c.confirmed }
pure def canFinishFollowUp(c: Client): bool =
  not(c.pending) and c.creating == 0 and c.followUp > 0 and c.followUp == c.generation and isPause(c)
pure def finishFollowUp(c: Client, reply: TaskViewResult): Client =
  { ...c, followUp: 0, problem: not(allowsPauseReply(reply)),
    confirmed: if (allowsPauseReply(reply)) reply else c.confirmed }
pure def canReadCurrentTask(c: Client): bool =
  not(c.pending) and c.creating == 0 and c.followUp == 0
pure def readCurrentTask(c: Client): Client =
  { ...c, generation: c.generation + 1, command: RefreshClient }
pure def canFinishCurrentTask(c: Client, ticket: int): bool =
  c.command == RefreshClient and c.generation == ticket and c.creating == 0 and c.followUp == 0 and not(c.pending)
pure def finishCurrentTask(c: Client, ticket: int, reply: TaskViewResult): Client =
  if (reply != TaskViewInvalid) { ...c, confirmed: reply, command: NoClientCommand } else { ...c, command: NoClientCommand }
pure def clearClient(c: Client): Client = { ...initial, generation: c.generation + 1 }
pure def alwaysFollowUpBelongsToPause(c: Client): bool =
  c.followUp != 0 implies c.followUp == c.generation and isPause(c)
pure def stepUncertainCreationKeepsPause(before: Client, via: str, after: Client): bool =
  via == "finishCreate" and before.followUp != 0 implies before.followUp == after.followUp and before.confirmed == after.confirmed
pure def sometimesFollowUpReconcilesCreation(c: Client): bool =
  c.followUp > 0 and not(c.pending) and c.creating == 0
```

## Story: Confirm Resume and Cancel using the current host task

> As a user, Resume and Cancel act on the task as the device host knows it
> now, never on an older copy of it.

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
task is a separate successful empty projection.

```quint
pure def canBeginControl(c: Client, cancelling: bool): bool = cancelling or not(c.pending)
pure def beginControl(c: Client, cancelling: bool): Client =
  { ...c, generation: c.generation + 1, pending: true, problem: false, followUp: 0,
    command: if (cancelling) CancelClient else ResumeClient }
pure def controlAdmitted(command: ClientCommand, base: TaskViewResult, reply: TaskViewResult): bool =
  val prior = shownTask(base)
  val replied = shownTask(reply)
  base == TaskViewAbsent or
    (presentTask(base) and presentTask(reply) and replied.id == prior.id and replied.revision > prior.revision and
    ((command == ResumeClient and replied.status == TaskActive and replied.epoch >= prior.epoch) or
     (command == CancelClient and replied.status == TaskCancelled and replied.epoch > prior.epoch)))
pure def canFinishControl(c: Client, ticket: int): bool =
  c.pending and c.generation == ticket and c.creating == 0 and
  (c.command == CancelClient or c.command == ResumeClient)
pure def finishControl(c: Client, ticket: int, base: TaskViewResult, reply: TaskViewResult): Client =
  if (controlAdmitted(c.command, base, reply)) {
    ...c, pending: false, problem: false,
    confirmed: if (presentTask(base)) reply else TaskViewAbsent
  } else { ...c, pending: false, problem: true }
pure def lawCancelledReplyRequiresNewEpoch(base: TaskViewResult, reply: TaskViewResult): bool =
  presentTask(base) and controlAdmitted(CancelClient, base, reply)
  implies shownTask(reply).epoch > shownTask(base).epoch
pure def lawControlCannotAdoptAnotherTask(command: ClientCommand, base: TaskViewResult, reply: TaskViewResult): bool =
  presentTask(base) and shownTask(reply).id != shownTask(base).id implies not(controlAdmitted(command, base, reply))
pure def sometimesClientConfirmsPause(c: Client): bool =
  presentTask(c.confirmed) and shownTask(c.confirmed).status == TaskPaused and not(c.pending) and not(c.problem)
pure def sometimesClientReportsFailure(c: Client): bool = c.problem
pure val activeReply: TaskViewResult = TaskViewPresent({ schemaVersion: 1, id: "taskA", revision: 2, epoch: 1, status: TaskActive, hasUnknownOutcome: false })
pure val pausedReply: TaskViewResult = TaskViewPresent({ schemaVersion: 1, id: "taskA", revision: 1, epoch: 1, status: TaskPaused, hasUnknownOutcome: false })
pure val cancelledReply: TaskViewResult = TaskViewPresent({ schemaVersion: 1, id: "taskA", revision: 2, epoch: 2, status: TaskCancelled, hasUnknownOutcome: false })
pure val replyValues = Set(activeReply, pausedReply, cancelledReply, TaskViewAbsent, TaskViewInvalid)
pure val baseValues = Set(pausedReply, activeReply, TaskViewAbsent, TaskViewInvalid)
pure val foundBeforeCreateValues = Set(activeReply, TaskViewAbsent)
pure val ticketValues = Set(1, 2, 3, 4, 5, 6)
pure val weight_beginCreate = 3
pure val weight_beginPause = 3
pure val weight_finishCreate = 4
pure val weight_finishPause = 4
pure val weight_finishFollowUp = 5
```
