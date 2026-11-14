# AlphaPhone reviewed workflow journey

The client and agent keep separate records. The [request archive](./workflowIntents.md)
owns the local revision. The [workflow definition](./workflow.md) owns
remote admission and execution identity. A model can compose them by
importing their transitions. The client still needs independent transport
and publication fences around real requests.

## Story: Recover one reviewed run across an interrupted reply

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
import workflow as W from "./workflow"
import workflowIntents as I from "./workflowIntents"
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
