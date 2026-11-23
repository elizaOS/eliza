# Agent orchestration

## Story: Direct an authorized task to the intended subagent and evaluate its result

> As an owner, I can dispatch work to an available subagent. I can direct messages to that subagent, stop its current turn, and review the result against the task's acceptance criteria.

### A named target receives the directive without affecting other subagents

The shell selects the already-authorized workspace, adapter and child session. It resolves a label or mention to a child identity and submits the routing decision with the current child state. A stop request can end an active targeted turn.

```quint
type PeerDirective = AmbientMessage | DirectMessage | StopTurn
type PeerAddress = Unaddressed | NamedChild({ namedId: str }) | MentionedChild({ mentionedId: str })
type PeerDisposition = NoPeerAction | DeliverDirective | CancelTurn
pure def peerDirected(address: PeerAddress, childId: str, peerCount: int): bool = match address {
  | NamedChild(peer) => peer.namedId == childId
  | MentionedChild(peer) => peer.mentionedId == childId
  | Unaddressed => peerCount == 1
}
pure def routeDirective(address: PeerAddress, directive: PeerDirective, childId: str, peerCount: int, running: bool): PeerDisposition =
  if (not(peerDirected(address, childId, peerCount)) or directive == AmbientMessage) NoPeerAction
  else if (directive == StopTurn) (if (running) CancelTurn else NoPeerAction)
  else DeliverDirective
pure def lawNamedDirectiveLeavesOtherChildrenUntouched(targetId: str, childId: str, directive: PeerDirective, peerCount: int, running: bool): bool =
  targetId != childId implies routeDirective(NamedChild({ namedId: targetId }), directive, childId, peerCount, running) == NoPeerAction
pure def lawNamedStopCancelsOnlyRunningChild(childId: str, peerCount: int, running: bool): bool =
  (routeDirective(NamedChild({ namedId: childId }), StopTurn, childId, peerCount, running) == CancelTurn) == running
```

### A task can pass its acceptance gate only with evidence for every required criterion

The task's accepted criteria are bound to its generation. A task state and its review result are persisted by the host. The shell reports reviewed worktree changes, local command evidence, or a returned artifact as observed evidence.

```quint
type AcceptanceDecision = ReadyForReview | MissingEvidence | EvaluationFailed
type TaskEvaluation = { taskKey: str, taskGeneration: int, requiredCriteria: Set[str] }
type Evidence = { taskId: str, evaluatedGeneration: int, provedCriteria: Set[str], executionSucceeded: bool }
pure def evaluateTask(task: TaskEvaluation, evidence: Evidence): AcceptanceDecision =
  if (task.taskKey == "" or task.taskKey != evidence.taskId or task.taskGeneration != evidence.evaluatedGeneration or not(evidence.executionSucceeded)) EvaluationFailed
  else if (task.requiredCriteria.subseteq(evidence.provedCriteria)) ReadyForReview else MissingEvidence
pure def lawAbsentRequiredEvidenceCannotPass(task: TaskEvaluation, evidence: Evidence): bool =
  not(task.requiredCriteria.subseteq(evidence.provedCriteria)) implies evaluateTask(task, evidence) != ReadyForReview
pure def lawStaleTaskEvidenceCannotPass(task: TaskEvaluation, evidence: Evidence): bool =
  task.taskGeneration != evidence.evaluatedGeneration implies evaluateTask(task, evidence) == EvaluationFailed
pure val taskValues = Set({ taskKey: "task-1", taskGeneration: 1, requiredCriteria: Set("tests") })
pure val evidenceValues = Set({ taskId: "task-1", evaluatedGeneration: 1, provedCriteria: Set("tests"), executionSucceeded: true }, { taskId: "task-1", evaluatedGeneration: 2, provedCriteria: Set(), executionSucceeded: false })
```
