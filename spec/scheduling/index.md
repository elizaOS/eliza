# Scheduled task delivery

The [agent's scheduled-task model](../agent/schedule/scheduledTasks.md) owns the task state, recurrence, revision and delivery result. This package owns the admission record that protects the host anchor before the agent task runner applies that policy, together with the [dispatch policy and execution lifecycle](dispatch.md).

## Story: Automatically run an eligible task without consuming its anchor during a manual run

> As the owner, I can let a host activity anchor admit my next scheduled task. If another runner already claimed that occurrence, the losing runner does not dispatch it.

### An automatic claim must match both revisions and the waiting occurrence

```quint
import scheduledTasks as TaskPolicy from "../agent/schedule/scheduledTasks"
type AnchorState = { anchorTask: str, anchorRevision: int, anchorOccurrence: int, eligible: bool, consumed: bool }
type ClaimDecision = RunManually | ClaimAnchor | AnchorIneligible | ClaimRaced
pure def classifyManualRun(task: TaskPolicy::ScheduledTask, seenTaskRevision: int, now: int): ClaimDecision =
  if (task.revision != seenTaskRevision) ClaimRaced
  else if (TaskPolicy::fireable(task, true, now)) RunManually else AnchorIneligible
pure def classifyAnchor(task: TaskPolicy::ScheduledTask, taskId: str, anchor: AnchorState, seenTaskRevision: int, seenAnchorRevision: int, manual: bool, now: int): ClaimDecision =
  if (manual) classifyManualRun(task, seenTaskRevision, now)
  else if (task.revision != seenTaskRevision or anchor.anchorTask != taskId or anchor.anchorOccurrence != task.pending) ClaimRaced
  else if (not(TaskPolicy::fireable(task, false, now))) AnchorIneligible
  else if (anchor.anchorRevision != seenAnchorRevision or anchor.consumed) ClaimRaced
  else if (anchor.eligible) ClaimAnchor else AnchorIneligible
pure def lawStaleTaskCannotConsumeAnchor(task: TaskPolicy::ScheduledTask, taskId: str, anchor: AnchorState, seenTaskRevision: int, seenAnchorRevision: int, manual: bool, now: int): bool =
  (task.revision != seenTaskRevision) implies classifyAnchor(task, taskId, anchor, seenTaskRevision, seenAnchorRevision, manual, now) == ClaimRaced
pure def lawManualRunNeverConsumesAnchor(task: TaskPolicy::ScheduledTask, taskId: str, anchor: AnchorState, seenTaskRevision: int, seenAnchorRevision: int, now: int): bool =
  classifyAnchor(task, taskId, anchor, seenTaskRevision, seenAnchorRevision, true, now) != ClaimAnchor
```

### A claimed anchor advances its revision without changing task or occurrence

The store reserves the anchor by compare-and-swap. The existing task runner consumes the typed result of the delivery effect. It never treats the reservation alone as evidence that a connector sent anything.

```quint
pure def nextAnchor(anchor: AnchorState, claim: ClaimDecision): AnchorState =
  if (claim == ClaimAnchor and not(anchor.consumed)) { ...anchor, consumed: true, anchorRevision: anchor.anchorRevision + 1 } else anchor
pure def lawAnchorClaimIsIdempotent(anchor: AnchorState, claim: ClaimDecision): bool =
  nextAnchor(nextAnchor(anchor, claim), claim) == nextAnchor(anchor, claim)
pure def lawClaimPreservesOccurrence(anchor: AnchorState, claim: ClaimDecision): bool =
  nextAnchor(anchor, claim).anchorOccurrence == anchor.anchorOccurrence and nextAnchor(anchor, claim).anchorTask == anchor.anchorTask
pure val taskValues = Set(TaskPolicy::initial, { ...TaskPolicy::initial, revision: 2, pending: 2 })
pure val anchorValues = Set({ anchorTask: "dossier", anchorRevision: 1, anchorOccurrence: 1, eligible: true, consumed: false }, { anchorTask: "dossier", anchorRevision: 2, anchorOccurrence: 1, eligible: true, consumed: true })
```
