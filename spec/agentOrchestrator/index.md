# Agent orchestration

## Story: Direct an authorized task to the intended subagent and evaluate its result

> As an owner, I can dispatch work to an available subagent. I can direct messages to that subagent, stop its current turn, and review the result against the task's acceptance criteria.

### A named target receives the directive without affecting other subagents

The shell selects the already-authorized workspace, adapter and child session. It resolves the labels and @-mentions in the message to the child identities of the room's subagents and submits the routing decision with the current child state. A message names one or more subagents, or none. A message that names no subagent reaches a subagent only when it is alone in its room. A stop request can end an active targeted turn, and a subagent the message does not name is left untouched whatever it asks.

```quint
type PeerDirective = AmbientMessage | DirectMessage | StopTurn
type PeerAddress = Unaddressed | NamedChildren({ namedIds: Set[str] }) | MentionedChildren({ mentionedIds: Set[str] }) | UnmappedMention
type PeerDisposition = NoPeerAction | DeliverDirective | CancelTurn
pure def peerDirected(address: PeerAddress, childId: str, peerCount: int): bool = match address {
  | NamedChildren(peer) => peer.namedIds.contains(childId)
  | MentionedChildren(peer) => peer.mentionedIds.contains(childId)
  | UnmappedMention => true
  | Unaddressed => peerCount == 1
}
pure def routeDirective(address: PeerAddress, directive: PeerDirective, childId: str, peerCount: int, running: bool): PeerDisposition =
  if (not(peerDirected(address, childId, peerCount)) or directive == AmbientMessage) NoPeerAction
  else if (directive == StopTurn) (if (running) CancelTurn else NoPeerAction)
  else DeliverDirective
pure def lawNamedDirectiveLeavesOtherChildrenUntouched(namedIds: Set[str], childId: str, directive: PeerDirective, peerCount: int, running: bool): bool =
  not(namedIds.contains(childId)) implies routeDirective(NamedChildren({ namedIds: namedIds }), directive, childId, peerCount, running) == NoPeerAction
pure def lawNamedStopCancelsOnlyRunningChild(namedIds: Set[str], childId: str, peerCount: int, running: bool): bool =
  namedIds.contains(childId) implies (routeDirective(NamedChildren({ namedIds: namedIds }), StopTurn, childId, peerCount, running) == CancelTurn) == running
pure val namedIdsValues = Set(Set(), Set("ada"), Set("ada", "bob"))
pure val childIdValues = Set("ada", "bob", "cy")
```

### An @-mention of a subagent addresses only the subagents it mentions

The shell reads a subagent's label in a message with a word edge when the label is plain ASCII, so "Adam" does not name Ada, and as a keyword otherwise, so a label such as "민수" is found inside a word. An @-mention is an "@" directly followed by the label: "@Ada" mentions Ada, "@Adam" does not. A message that @-mentions some of the room's subagents addresses exactly those, so "@Ada @Bob stop" stops both and "@Ada stop, Bob can keep working" leaves Bob alone. A message with an "@" that mentions none of them, such as a connector mention ("<@123> stop") or the agent's own handle ("@eliza stop"), still addresses every subagent in the room. Otherwise the message addresses the subagents it names by label. An @-mention and a plain label route the same way.

```quint
pure def peerAddress(mentionedIds: Set[str], namedIds: Set[str], otherMention: bool): PeerAddress =
  if (mentionedIds.size() > 0) MentionedChildren({ mentionedIds: mentionedIds })
  else if (otherMention) UnmappedMention
  else if (namedIds.size() > 0) NamedChildren({ namedIds: namedIds })
  else Unaddressed
pure val mentionedIdsValues = Set(Set(), Set("ada"), Set("ada", "bob"))
pure def lawPeerMentionLeavesOtherChildrenUntouched(mentionedIds: Set[str], namedIds: Set[str], otherMention: bool, childId: str, directive: PeerDirective, peerCount: int, running: bool): bool =
  (mentionedIds.size() > 0 and not(mentionedIds.contains(childId))) implies routeDirective(peerAddress(mentionedIds, namedIds, otherMention), directive, childId, peerCount, running) == NoPeerAction
pure def lawEveryMentionedChildIsDirected(mentionedIds: Set[str], namedIds: Set[str], otherMention: bool, childId: str, peerCount: int): bool =
  mentionedIds.contains(childId) implies peerDirected(peerAddress(mentionedIds, namedIds, otherMention), childId, peerCount)
pure def lawUnmappedMentionReachesEveryChild(namedIds: Set[str], childId: str, peerCount: int): bool =
  peerDirected(peerAddress(Set(), namedIds, true), childId, peerCount)
pure def lawMentionRoutesLikeLabel(ids: Set[str], directive: PeerDirective, childId: str, peerCount: int, running: bool): bool =
  routeDirective(MentionedChildren({ mentionedIds: ids }), directive, childId, peerCount, running) == routeDirective(NamedChildren({ namedIds: ids }), directive, childId, peerCount, running)
pure val idsValues = Set(Set(), Set("ada"), Set("ada", "bob"))
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
