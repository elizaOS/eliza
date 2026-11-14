# Workflow approval and device operation receipts

AlphaPhone uses `WorkflowClient.approvals` and `decideApproval` from
`packages/contracts/src/workflow-client.ts` and phone-step review from
`packages/contracts/src/workflow-device.ts`. The pinned
`EmbeddedWorkflowService.decideReviewedApproval` reads the canonical
Smithers receipt under the execution lock. AlphaPhone
`WorkflowEngineAdmission.qnt` covers the decision/readback race. The
upstream `WorkflowCalendarRunScope.qnt` covers exact Calendar scope.

## Story: Decide one reviewed approval and confirm the native result

### The current request digest and canonical receipt determine the decision

A transaction selects the run in its tenant, then checks the captured
version and approval node/iteration/request digest. A decided receipt is
replayable only for the same decision and actor. Pending approval is
refused for a finished or cancelling run. An unsupported review may be
denied but cannot be approved. The control process may commit and lose
its reply. Recovery requires canonical readback for the same decision,
digest and actor. A missing result is unknown, and no successful response
is inferred from a submitted control command. Shell validation handles
bounded strings, approval arrays, numbers, and wire schema.

```quint
type ApprovalState = PendingApproval | ApprovedRequest | DeniedRequest
type ApprovalCheck = SendControl | ReadCanonical | ApprovalIdentityChanged | DecisionAlreadyDifferent | ExecutionUnavailable | ReviewUnsupported
type ApprovalFacts = { identitiesMatch: bool, digestMatches: bool, prior: ApprovalState, actorMatches: bool, finished: bool, cancelRequested: bool, supported: bool }
pure val pendingApproval: ApprovalState = PendingApproval
pure val approvedRequest: ApprovalState = ApprovedRequest
pure def decideApproval(facts: ApprovalFacts, approved: bool): ApprovalCheck =
  if (not(facts.identitiesMatch) or not(facts.digestMatches)) ApprovalIdentityChanged
  else if (facts.prior != PendingApproval) (if (facts.actorMatches and facts.prior == (if (approved) ApprovedRequest else DeniedRequest)) ReadCanonical else DecisionAlreadyDifferent)
  else if (facts.finished or facts.cancelRequested) ExecutionUnavailable
  else if (approved and not(facts.supported)) ReviewUnsupported
  else SendControl
pure val factsValues = Set(
  { identitiesMatch: true, digestMatches: true, prior: pendingApproval, actorMatches: true, finished: false, cancelRequested: false, supported: true },
  { identitiesMatch: true, digestMatches: true, prior: pendingApproval, actorMatches: true, finished: false, cancelRequested: false, supported: false },
  { identitiesMatch: true, digestMatches: true, prior: approvedRequest, actorMatches: true, finished: true, cancelRequested: false, supported: true },
  { identitiesMatch: true, digestMatches: false, prior: pendingApproval, actorMatches: true, finished: false, cancelRequested: false, supported: true })
pure def lawDecidedRequestNeverSendsControl(facts: ApprovalFacts, approved: bool): bool = facts.prior != PendingApproval implies decideApproval(facts, approved) != SendControl
pure def lawStaleReviewCannotSend(facts: ApprovalFacts, approved: bool): bool = (not(facts.identitiesMatch) or not(facts.digestMatches)) implies decideApproval(facts, approved) == ApprovalIdentityChanged
pure def lawUnsupportedReviewCannotApprove(facts: ApprovalFacts): bool = not(facts.supported) implies decideApproval(facts, true) != SendControl
pure def receiptConfirmed(matchingRun: bool, matchingNode: bool, matchingDigest: bool, matchingDecision: bool, matchingActor: bool, controlFailed: bool): bool = matchingRun and matchingNode and matchingDigest and matchingDecision and (not(controlFailed) or matchingActor)
pure def lawFailedControlRequiresExactActor(matchingRun: bool, matchingNode: bool, matchingDigest: bool, matchingDecision: bool, matchingActor: bool): bool = receiptConfirmed(matchingRun, matchingNode, matchingDigest, matchingDecision, matchingActor, true) implies matchingActor and matchingDigest and matchingDecision
```

### Device steps require the exact reviewed scope and enrolled phone

The phone read/write command must name the still-running run, workflow,
version, spec digest, and step. Its installation and enrollment must
match the reviewed phone. The concrete requested operation, including
its resource or calendar range, must match that step and kind. For stored
runs with a calendar anchor, relative dates are resolved against that
exact persisted instant. Older rows take the legacy current-clock
comparison. The approval notice is a read-only route and does not
provide authority for a device operation.

```quint
type StepFacts = { runMatches: bool, definitionMatches: bool, versionMatches: bool, digestMatches: bool, installationMatches: bool, enrollmentMatches: bool, stepMatches: bool, operationMatches: bool, finished: bool, cancelRequested: bool }
pure def admitsReviewedDeviceStep(scope: StepFacts): bool = scope.runMatches and scope.definitionMatches and scope.versionMatches and scope.digestMatches and scope.installationMatches and scope.enrollmentMatches and scope.stepMatches and scope.operationMatches and not(scope.finished) and not(scope.cancelRequested)
pure val scopeValues = Set(
  { runMatches: true, definitionMatches: true, versionMatches: true, digestMatches: true, installationMatches: true, enrollmentMatches: true, stepMatches: true, operationMatches: true, finished: false, cancelRequested: false },
  { runMatches: true, definitionMatches: true, versionMatches: true, digestMatches: true, installationMatches: true, enrollmentMatches: false, stepMatches: true, operationMatches: true, finished: false, cancelRequested: false })
pure def lawForeignPhoneCannotUseReview(scope: StepFacts): bool = (not(scope.installationMatches) or not(scope.enrollmentMatches)) implies not(admitsReviewedDeviceStep(scope))
pure def lawTerminalRunCannotUsePhone(scope: StepFacts): bool = (scope.finished or scope.cancelRequested) implies not(admitsReviewedDeviceStep(scope))
```
