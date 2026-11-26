# Workflows

`@elizaos/plugin-workflow` lets an owner author a typed
workflow, review it, activate it on a schedule, run it, approve its steps and
remove it. Every run is bound to the exact version the owner reviewed.

| Area | Specifications |
| --- | --- |
| Authoring and review | [Typed authoring](./authoring.md), [generated code](./generated.md), [source publication](./sourcePublication.md), [worker provenance](./worker.md) |
| Admission | [Reviewed admission](./admission.md), [request archive](./intents.md), [lifecycle](./lifecycle.md) |
| Running | [Schedule occurrences](./schedule.md), [execution and wakeups](./execution.md), [budgets, compaction and routing](./budget.md), [approvals](./approvals.md), [run scope](./runScope.md) |
| Hosted digests | [Offers and delivery](./hostedDigest.md) |
| Notices | [Run notices](./notices.md) |
| Updating | [Workflows saved by the earlier version](./earlierStore.md) |

The client and agent keep separate records. The [request archive](./intents.md)
owns the local revision. The [workflow definition](./admission.md) owns
remote admission and execution identity. The journey below composes them by
importing their transitions. The client still needs independent transport
and publication fences around real requests.

## Story: Recover one reviewed run across an interrupted reply

> As the owner, I want a run I submitted to be found again after its reply was
> lost, without a second run and without losing the action I saved.

### A saved request and an admitted execution preserve their separate identities

An owner reviews a definition, commits the exact local intent, and sends
one version-bound submission. The server may commit and the reply may be
lost. A later receipt lookup for the same submission recovers the existing
run, including when the owner has since edited the workflow. Only the
matching local revision is removed. Losing the reply neither rolls back the
remote run nor unlocks the local action. This scenario uses an exact reviewed
request, with one account tuple and one selected definition. Separate models
cover edits racing the first admission, terminal execution, and owner switch.

```quint
import admission as W from "./admission"
import intents as I from "./intents"
type JourneyPhase = NewWorkflowJourney | WorkflowReviewed | IntentStored | RequestCommitted | RequestLost | RunRecovered | IntentSettled
type WorkflowJourney = { phase: JourneyPhase, remote: W::Workflow, archive: I::Intents, reviewedVersion: int, intentRevision: int, runId: int }
pure val initial: WorkflowJourney = { phase: NewWorkflowJourney, remote: W::initial, archive: I::initial, reviewedVersion: 0, intentRevision: 0, runId: 0 }
pure def canReviewDefinition(j: WorkflowJourney): bool = j.phase == NewWorkflowJourney
pure def reviewDefinition(j: WorkflowJourney): WorkflowJourney = {
  val remote = W::defineWorkflow(j.remote, "owner", false, false, false)
  { ...j, phase: WorkflowReviewed, remote: remote, archive: I::openOwner(j.archive, "owner"), reviewedVersion: remote.version }
}
pure def canRetainIntent(j: WorkflowJourney): bool = j.phase == WorkflowReviewed
pure def retainIntent(j: WorkflowJourney): WorkflowJourney = {
  val archive = I::editArchive(j.archive, "owner", 0, true, true, true)
  { ...j, phase: IntentStored, archive: archive, intentRevision: archive.stored }
}
pure def canDispatchReviewed(j: WorkflowJourney): bool = j.phase == IntentStored
pure def dispatchReviewed(j: WorkflowJourney): WorkflowJourney = {
  val remote = W::submitWorkflow(j.remote, "owner", W::ExactRequest, "submission", j.reviewedVersion, "{}")
  { ...j, phase: RequestCommitted, remote: remote, runId: remote.replyRun }
}
pure def canLoseReceipt(j: WorkflowJourney): bool = j.phase == RequestCommitted
pure def loseReceipt(j: WorkflowJourney): WorkflowJourney = { ...j, phase: RequestLost, remote: W::loseRunReply(j.remote) }
pure def canUpdateAfterDispatch(j: WorkflowJourney): bool = j.phase == RequestLost
pure def updateAfterDispatch(j: WorkflowJourney): WorkflowJourney = { ...j, remote: W::editWorkflow(j.remote, "owner") }
pure def canRecoverReceipt(j: WorkflowJourney): bool = j.phase == RequestLost
pure def recoverReceipt(j: WorkflowJourney): WorkflowJourney = { ...j, phase: RunRecovered, remote: W::readSubmission(j.remote, "owner", "submission") }
pure def canAcknowledgeIntent(j: WorkflowJourney): bool = j.phase == RunRecovered
pure def acknowledgeIntent(j: WorkflowJourney): WorkflowJourney = { ...j, phase: IntentSettled, archive: I::editArchive(j.archive, "owner", j.intentRevision, true, true, true) }
pure def alwaysArchiveCoordinates(j: WorkflowJourney): bool = I::alwaysIntentCoordinates(j.archive) and I::alwaysStoredNeedsOwner(j.archive)
pure def alwaysDefinitionCoordinates(j: WorkflowJourney): bool = W::alwaysDefinitionVersion(j.remote) and W::alwaysSubmittedRunHasIdentity(j.remote) and W::alwaysRunReplyIsExplicit(j.remote) and W::alwaysTypedActiveUsesReviewedSchedule(j.remote)
pure def alwaysLocalIntentTracksPhase(j: WorkflowJourney): bool =
  (j.phase == NewWorkflowJourney implies j.archive.owner == "" and j.remote.owner == "" and j.runId == 0) and
  (j.phase != NewWorkflowJourney implies j.archive.owner == "owner" and j.remote.owner == "owner" and j.reviewedVersion > 0 and j.reviewedVersion <= j.remote.version) and
  ((j.phase == IntentStored or j.phase == RequestCommitted or j.phase == RequestLost or j.phase == RunRecovered) implies j.intentRevision > 0 and j.archive.stored == j.intentRevision) and
  ((j.phase == WorkflowReviewed or j.phase == IntentSettled) implies j.archive.stored == 0)
pure def alwaysServerAdmissionTracksPhase(j: WorkflowJourney): bool =
  ((j.phase == WorkflowReviewed or j.phase == IntentStored) implies not(j.remote.submissionIds.contains("submission")) and j.reviewedVersion == j.remote.version) and
  ((j.phase == RequestCommitted or j.phase == RequestLost or j.phase == RunRecovered or j.phase == IntentSettled) implies
    j.runId > 0 and j.remote.submissionIds.contains("submission") and W::entry(j.remote, "submission").runId == j.runId and W::entry(j.remote, "submission").owner == "owner") and
  (j.phase == RequestCommitted implies j.remote.reply == W::QueuedRun and j.remote.replyRun == j.runId) and
  ((j.phase == RunRecovered or j.phase == IntentSettled) implies j.remote.reply == W::ExistingRun and j.remote.replyRun == j.runId)
pure def sometimesLostReceiptRetainsIntent(j: WorkflowJourney): bool = j.phase == RequestLost and j.archive.stored > 0
pure def sometimesSettledAfterDefinitionChanged(j: WorkflowJourney): bool = j.phase == IntentSettled and j.remote.version > j.reviewedVersion
```

## Story: Change only the workflow I named in chat

> As the owner, I want "rename workflow Morning digest to Daily brief" to
> rename Morning digest, and never to remove, pause or rename some other
> workflow because the agent proposed it.

### A chat change follows the owner's own command and refuses a different operation

A chat request that changes workflows reads the words the owner typed in
the request the host bound to the turn, or the message's own text when none
is bound. When those words are a whole command to create a workflow by
name, rename one or remove one, or to list them, the change runs only if it
is that command's operation, and then on the names those words give,
whatever workflow or names the agent proposed. A change of another operation
is refused and nothing changes. Reading workflows, and a change the owner's
words do not spell out as such a command, keep the agent's proposal.

```quint
type ChatChange = { reads: bool, ownerCommand: bool, sameOperation: bool }
type ChatBinding = ProposedChange | OwnerCommandChange | ConflictingChange
pure def chatBinding(c: ChatChange): ChatBinding =
  if (c.reads or not(c.ownerCommand)) ProposedChange else if (c.sameOperation) OwnerCommandChange else ConflictingChange
pure val cValues = Set({ reads: true, ownerCommand: true, sameOperation: false }, { reads: false, ownerCommand: false, sameOperation: false },
  { reads: false, ownerCommand: true, sameOperation: true }, { reads: false, ownerCommand: true, sameOperation: false })
pure def lawADifferentOperationChangesNothing(c: ChatChange): bool =
  (not(c.reads) and c.ownerCommand and not(c.sameOperation)) implies chatBinding(c) == ConflictingChange
pure def lawTheOwnersCommandNamesTheTarget(c: ChatChange): bool =
  (not(c.reads) and c.ownerCommand and c.sameOperation) implies chatBinding(c) == OwnerCommandChange
pure def lawReadingIsNeverRefused(c: ChatChange): bool = c.reads implies chatBinding(c) == ProposedChange
```
