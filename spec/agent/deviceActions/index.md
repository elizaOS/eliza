# Device requests

The agent asks the owner's device to do what only the device can do: read a
calendar range, create a reminder, send a message. This spec owns one such
request inside the agent process, from the offer to its settled outcome, and
the enrollment of the device it is offered to. The request holds a core
[interaction session](../../core/sessions.md), whose claim, commit, single
invocation and ambiguity it reuses; dispatch to a device that declared the
capability is the core [device bridge](../../core/deviceBridge.md). What the
device does with a claimed request and its execution journal are
[device execution](./execution.md); the reviewed wire shapes are
[device operations](./operations.md). Native executors belong to the
[Android device](../../os/index.md). The capability vocabulary and header negotiation are
[capabilities](./capabilities.md). The agent's own proposal families are
[telephony](./telephony.md) and the [device surfaces](./surfaces.md); the
other families belong to the packages that own their records.

The routes are `POST /api/client-devices/{register,revoke}`,
`GET /api/client-devices/context`, `GET /api/client-devices/proposals` and
`POST /api/client-devices/proposals/:id/{decision,claim,receipt,reconciliation,read-completion,cancel-read-completion}`.
The shell checks the device key in constant time and passes the sender as a
session owner: the agent's id, the owner's user id and the installation id.
A refused event answers 409 and changes nothing; a store failure answers 503.

## Story: Enroll my device and revoke it

> As the owner, I want to enroll my device under its own key, to enroll it
> again when its key is lost or the phone is replaced, and to revoke an
> enrollment for good, so that only the device I enrolled last can see or
> act on what the agent asks, and nothing asked under an earlier enrollment
> is ever served again.

### A device enrolls under its own key as the agent's installation

The installation id is the agent's own store id (`storage/database.md`),
never a second identity. A first registration records the owner, the key
hash and the workflow protocol, and connects the device to the bridge with
the capabilities it declares; a registration that names none declares the
whole vocabulary. Registering again with the same key changes only the
workflow protocol. The agent keeps one enrollment. When its owner
registers under another key, as a reinstalled or replaced phone does, the
shell computes the revocation and new enrollment together and commits them
with the retirement of earlier requests in one transaction. A failed
registration leaves the earlier enrollment and requests as they were. Once
replacement is committed, the earlier key stops working, and every request
offered under it ends as revocation ends it. A store whose enrollment was
revoked enrolls again the same way, as a
new enrollment. Another owner is refused. The workflow protocol's upper
bound is the workflow spec's, checked by the shell.

```quint
import sessions as S from "../../core/sessions"
import deviceBridge as DB from "../../core/deviceBridge"
type Enrollment = Unenrolled | Enrolled({ owner: S::SessionOwner, keyHash: str, workflowProtocol: int }) | Revoked
type ReceiptOutcome = ReportedApplied | ReportedNothingRan | ReportedUnknown
type ReviewOutcome = ReviewedApplied | ReviewedNotApplied | ReviewedUnresolved
type RequestPhase = Unoffered | Offered | Approved | Declined | Expired | Retired | Dispatched | Receipted({ reported: ReceiptOutcome }) | Reviewed({ reviewed: ReviewOutcome })
type Completion = NoCompletion | CompletionPending | CompletionClaimed | CompletionPrepared | CompletionDelivered | CompletionCancelled | CompletionUnknown
type ReadOrigin = { requestId: str, conversationId: str, inReplyTo: str }
type DeviceRequest = { enrollment: Enrollment, bridge: DB::DeviceBridge, session: S::Session, phase: RequestPhase, proposalId: str, digest: str, capability: str, createdAt: int, claimedAt: int, origin: ReadOrigin, completion: Completion, inferences: int }
pure val noOwner: S::SessionOwner = { agentId: "", actorId: "", connector: "" }
pure val initial: DeviceRequest = { enrollment: Unenrolled, bridge: DB::initial, session: S::initial, phase: Unoffered, proposalId: "", digest: "", capability: "", createdAt: 0, claimedAt: 0, origin: { requestId: "", conversationId: "", inReplyTo: "" }, completion: NoCompletion, inferences: 0 }
pure def isEnrolled(e: Enrollment): bool = match e { | Enrolled(x) => true | _ => false }
pure def enrolledOwner(e: Enrollment): S::SessionOwner = match e { | Enrolled(x) => x.owner | _ => noOwner }
pure def enrolledKey(e: Enrollment): str = match e { | Enrolled(x) => x.keyHash | _ => "" }
pure val byValues = Set({ agentId: "agent1", actorId: "owner1", connector: "agent1" }, { agentId: "agent1", actorId: "owner2", connector: "agent1" })
pure val keyHashValues = Set("key1", "key2")
pure val capabilitiesValues = Set(List("calendar.create.v1"), List("calendar.create.v1", "sms.send.v1"))
pure val workflowProtocolValues = Set(-1, 0, 3)
pure def canRegisterDevice(d: DeviceRequest, by: S::SessionOwner, keyHash: str, capabilities: List[str], workflowProtocol: int): bool = keyHash != "" and workflowProtocol >= 0 and by.actorId != "" and by.agentId != "" and by.connector == by.agentId and (if (isEnrolled(d.enrollment)) (enrolledOwner(d.enrollment) == by and enrolledKey(d.enrollment) == keyHash) else ((d.enrollment == Unenrolled or d.phase == Unoffered) and DB::canConnectDevice(d.bridge, { id: by.connector, capabilities: capabilities })))
pure def registerDevice(d: DeviceRequest, by: S::SessionOwner, keyHash: str, capabilities: List[str], workflowProtocol: int): DeviceRequest = { ...d, enrollment: Enrolled({ owner: by, keyHash: keyHash, workflowProtocol: workflowProtocol }), bridge: if (isEnrolled(d.enrollment)) d.bridge else DB::connectDevice(d.bridge, { id: by.connector, capabilities: capabilities }) }
pure def replacesEnrollment(d: DeviceRequest, by: S::SessionOwner, keyHash: str): bool = keyHash != "" and isEnrolled(d.enrollment) and enrolledOwner(d.enrollment) == by and enrolledKey(d.enrollment) != keyHash
pure def alwaysInstallationIsTheAgent(d: DeviceRequest): bool = isEnrolled(d.enrollment) implies (enrolledOwner(d.enrollment).connector == enrolledOwner(d.enrollment).agentId and enrolledKey(d.enrollment) != "")
pure def stepEnrollmentKeepsItsOwnerAndKey(before: DeviceRequest, after: DeviceRequest): bool = isEnrolled(before.enrollment) implies (after.enrollment == Revoked or (enrolledOwner(after.enrollment) == enrolledOwner(before.enrollment) and enrolledKey(after.enrollment) == enrolledKey(before.enrollment)))
```

### A revoked enrollment retires every open offer, and nothing offered under it is served again

Revocation disconnects the device from the bridge, which fails a call still
waiting on it, and retires an offer not yet claimed. A dispatched request
keeps its record: the device can no longer report on it, and nothing runs
it again. That holds for good: a request offered under a revoked enrollment
stays revoked when the device enrolls again, so only a store with no
request of its own, the agent's enrollment record, ever leaves revocation,
and only by a registration. Explicit revocation checks the presented key and
owner against the same enrollment revision it changes.

```quint
pure def openOffer(phase: RequestPhase): bool = phase == Offered or phase == Approved
pure def enrollmentKeyMatches(d: DeviceRequest, by: S::SessionOwner, keyHash: str): bool = keyHash != "" and isEnrolled(d.enrollment) and enrolledOwner(d.enrollment) == by and enrolledKey(d.enrollment) == keyHash
pure def canRevokeEnrollment(d: DeviceRequest, by: S::SessionOwner): bool = isEnrolled(d.enrollment) and enrolledOwner(d.enrollment) == by and DB::canDisconnectDevice(d.bridge, by.connector)
pure def revokeEnrollment(d: DeviceRequest, by: S::SessionOwner): DeviceRequest = { ...d, enrollment: Revoked, bridge: DB::disconnectDevice(d.bridge, by.connector), phase: if (openOffer(d.phase)) Retired else d.phase, session: if (openOffer(d.phase)) S::revoke(d.session) else d.session }
pure def stepARevokedRequestStaysRevoked(before: DeviceRequest, via: str, after: DeviceRequest): bool = ((before.enrollment == Revoked and after.enrollment != Revoked) implies (via == "registerDevice" and before.phase == Unoffered)) and (via == "revokeEnrollment" implies (if (openOffer(before.phase)) after.phase == Retired else after.phase == before.phase))
pure def sometimesRevokedRetiredAnOffer(d: DeviceRequest): bool = d.enrollment == Revoked and d.phase == Retired
pure def sometimesRevokedAfterDispatch(d: DeviceRequest): bool = d.enrollment == Revoked and d.phase == Dispatched
```

### The device context is served only for a live enrollment

`GET /api/client-devices/context` reads the enrollment and changes nothing.
The shell adds the enrollment id and the scope, a digest of the identity.

```quint
type ContextReply = ContextRefused | ContextServed({ agentId: str, subjectUserId: str, installationId: str })
pure def deviceContext(d: DeviceRequest): ContextReply = if (isEnrolled(d.enrollment)) ContextServed({ agentId: enrolledOwner(d.enrollment).agentId, subjectUserId: enrolledOwner(d.enrollment).actorId, installationId: enrolledOwner(d.enrollment).connector }) else ContextRefused
```

## Story: Approve a device request once and learn exactly what happened

> As the owner, I want to approve a device request before its deadline and
> have my device receive it once, so that a declined or lapsed request never
> runs, and a lost answer leaves the request uncertain until I confirm what
> happened, never run a second time.

### An offer goes only to the enrolled device, for a capability it declared

The agent offers a request in the turn of the device that asked, on a fresh
session owned by that device, with a proposal digest and a deadline. When
the launch carries `hostContextRevision` and the operation is an original
read, the offer also opens a read completion (`readBack`). A workflow step
is offered outside any turn the same way: to the enrolled device named as
its target, bound to its workflow, version, run, step and spec digest, for a
capability its operation needs that the device declared. The step waits for
the request to settle and answers with the applied result; it is refused
when the request is declined, lapses, runs nothing or is reviewed as not
applied, and its offer retires when the step stops waiting. A step whose
request is still dispatched or uncertain at the deadline is refused as
unknown, and the request keeps waiting for its receipt or review.

```quint
pure val proposalIdValues = Set("p1")
pure val digestValues = Set("d1", "d2")
pure val capabilityValues = Set("calendar.create.v1", "sms.send.v1")
pure val expiresAtValues = Set(600000, 2400000)
pure val originValues = Set({ requestId: "r1", conversationId: "c1", inReplyTo: "m1" })
pure def canOffer(d: DeviceRequest, by: S::SessionOwner, proposalId: str, digest: str, capability: str, expiresAt: int): bool = d.phase == Unoffered and isEnrolled(d.enrollment) and enrolledOwner(d.enrollment) == by and proposalId != "" and digest != "" and DB::declares(d.bridge, by.connector, capability) and S::canCreate(d.session, by, expiresAt)
pure def offer(d: DeviceRequest, by: S::SessionOwner, proposalId: str, digest: str, capability: str, expiresAt: int, readBack: bool, origin: ReadOrigin): DeviceRequest = { ...d, phase: Offered, session: S::create(d.session, by, expiresAt), proposalId: proposalId, digest: digest, capability: capability, createdAt: d.session.now, origin: origin, completion: if (readBack) CompletionPending else NoCompletion }
```

### Only the exact binding decides an open offer before its deadline

The binding is the enrolled device, the request and the proposal digest.
Repeating a decision is accepted and changes nothing. An approval never
claimed ran nothing, so the owner may still decline it after the deadline.
Declining withdraws the session's authority.

```quint
pure def beforeDeadline(d: DeviceRequest): bool = d.session.now < d.session.expiresAt
pure def exactBinding(d: DeviceRequest, by: S::SessionOwner, digest: str): bool = isEnrolled(d.enrollment) and enrolledOwner(d.enrollment) == by and d.session.owner == by and d.phase != Unoffered and digest == d.digest
pure def canDecide(d: DeviceRequest, by: S::SessionOwner, digest: str, approved: bool): bool = exactBinding(d, by, digest) and ((d.phase == Offered and beforeDeadline(d)) or d.phase == Approved or (not(approved) and d.phase == Declined))
pure def decide(d: DeviceRequest, by: S::SessionOwner, digest: str, approved: bool): DeviceRequest = if (approved) { ...d, phase: Approved } else if (d.phase == Declined) d else { ...d, phase: Declined, session: S::revoke(d.session) }
pure def stepOpenOfferDecidedOnlyBeforeDeadline(before: DeviceRequest, after: DeviceRequest): bool = (before.phase == Offered and (after.phase == Approved or after.phase == Declined)) implies beforeDeadline(before)
pure def sometimesLapsedApprovalCanBeDeclined(d: DeviceRequest): bool = d.phase == Approved and not(beforeDeadline(d)) and canDecide(d, d.session.owner, d.digest, false)
```

### An unclaimed offer retires at its deadline or at the end of its turn

Time only moves forward. An open offer past its deadline expires, and never
before it. Its record is written as expired the next time it is read: when
the device lists its proposals, and when a turn of its conversation reads
that conversation's requests. So the list shows a lapsed offer or approval
as expired, never as pending or approved, and the next turn's outcome note
names it as one that never ran. A
standalone agenda read, which the host offers for the displayed day without
the model, retires when its turn ends; a proposal the owner's words asked
for stays open after its turn, until the owner decides it or its deadline
passes. Either withdraws the session's authority, so the offer never
reaches the device.

```quint
pure val elapsedValues = Set(0, 300000, 600000)
pure def canElapse(d: DeviceRequest, elapsed: int): bool = S::canElapse(d.session, elapsed)
pure def elapse(d: DeviceRequest, elapsed: int): DeviceRequest = { ...d, session: S::elapse(d.session, elapsed) }
pure def canExpire(d: DeviceRequest): bool = openOffer(d.phase) and not(beforeDeadline(d))
pure def expire(d: DeviceRequest): DeviceRequest = { ...d, phase: Expired, session: S::revoke(d.session) }
pure def canEndTurn(d: DeviceRequest): bool = openOffer(d.phase)
pure def endTurn(d: DeviceRequest): DeviceRequest = { ...d, phase: Retired, session: S::revoke(d.session) }
pure def stepOnlyALapsedOpenOfferExpires(before: DeviceRequest, after: DeviceRequest): bool = (after.phase == Expired and before.phase != Expired) implies (openOffer(before.phase) and not(beforeDeadline(before)))
pure def sometimesOfferExpired(d: DeviceRequest): bool = d.phase == Expired
pure def sometimesRetiredAtTurnEnd(d: DeviceRequest): bool = d.phase == Retired and isEnrolled(d.enrollment)
```

### The claim commits the dispatch once, before the deadline

The device claims an approved request with the exact binding before the
deadline. Acquiring the session, committing it and starting the bridge call
are one transaction, so a lost reply to the claim cannot cause a second
delivery. The session's claim token is the attempt id; its lease runs to the
deadline. The held session keeps every rule of core sessions.

```quint
pure def afterDispatch(phase: RequestPhase): bool = match phase { | Dispatched => true | Receipted(x) => true | Reviewed(x) => true | _ => false }
pure def sessionPhaseFor(phase: RequestPhase): S::SessionPhase = match phase {
  | Unoffered => S::Absent
  | Dispatched => S::Committed
  | Receipted(x) => if (x.reported == ReportedApplied) S::Completed else S::Committed
  | Reviewed(x) => if (x.reviewed == ReviewedApplied) S::Completed else S::Committed
  | _ => S::Pending }
pure def canClaim(d: DeviceRequest, by: S::SessionOwner, digest: str): bool = exactBinding(d, by, digest) and d.phase == Approved and beforeDeadline(d) and DB::canInvoke(d.bridge, d.session.claimSequence + 1, by.connector, d.capability) and S::canAcquire(d.session, by, digest, d.session.expiresAt - d.session.now)
pure def claim(d: DeviceRequest, by: S::SessionOwner, digest: str): DeviceRequest = {
  val acquired = S::acquire(d.session, by, digest, d.session.expiresAt - d.session.now)
  { ...d, phase: Dispatched, claimedAt: d.session.now, session: S::commit(acquired, by, acquired.currentClaim, digest), bridge: DB::invoke(d.bridge, acquired.currentClaim, by.connector, d.capability) }
}
pure def alwaysSessionFollowsTheRequest(d: DeviceRequest): bool = d.session.phase == sessionPhaseFor(d.phase) and d.session.claimSequence == (if (afterDispatch(d.phase)) 1 else 0) and d.session.currentClaim == d.session.claimSequence
pure def alwaysSessionKeepsItsOwnRules(d: DeviceRequest): bool = S::alwaysEffectHasCommittedOwner(d.session) and S::alwaysAtMostOneInvocation(d.session) and S::alwaysCompletedHasOutcome(d.session) and S::alwaysLiveClaimHasToken(d.session) and S::alwaysClaimSequenceIsValid(d.session) and S::alwaysAmbiguousCommitRemainsDurable(d.session)
pure def stepDispatchOnlyFromAnOpenApproval(before: DeviceRequest, after: DeviceRequest): bool = (not(afterDispatch(before.phase)) and afterDispatch(after.phase)) implies (before.phase == Approved and beforeDeadline(before) and isEnrolled(before.enrollment) and DB::declares(before.bridge, before.session.owner.connector, before.capability))
```

### A receipt from the claimed attempt settles a dispatched request once

A receipt carries the exact binding and the claimed attempt. An applied
receipt invokes and completes the session. A receipt that nothing ran (the
device never dispatched, or trusted evidence shows a refusal) settles the
request without an effect. An unknown receipt leaves the request uncertain
and the session committed: the device may have acted. The same receipt again
is accepted and changes nothing; a different one is refused.

```quint
pure val attemptIdValues = Set(1, 2)
pure def settleApplied(session: S::Session, by: S::SessionOwner, attemptId: int): S::Session = S::complete(S::recordOutcome(S::invoke(session, by, attemptId)))
pure def canReceipt(d: DeviceRequest, by: S::SessionOwner, digest: str, attemptId: int, reportedOutcome: ReceiptOutcome): bool = exactBinding(d, by, digest) and attemptId == d.session.currentClaim and ((d.phase == Dispatched and (reportedOutcome != ReportedApplied or S::canInvoke(d.session, by, attemptId))) or d.phase == Receipted({ reported: reportedOutcome }))
pure def receipt(d: DeviceRequest, by: S::SessionOwner, digest: str, attemptId: int, reportedOutcome: ReceiptOutcome): DeviceRequest = if (d.phase != Dispatched) d else { ...d, phase: Receipted({ reported: reportedOutcome }), session: if (reportedOutcome == ReportedApplied) settleApplied(d.session, by, attemptId) else d.session, bridge: if (DB::canCompleteCall(d.bridge, attemptId, true)) DB::completeCall(d.bridge, attemptId, reportedOutcome == ReportedApplied) else d.bridge }
pure def sometimesAppliedByReceipt(d: DeviceRequest): bool = d.phase == Receipted({ reported: ReportedApplied })
pure def sometimesNothingRan(d: DeviceRequest): bool = d.phase == Receipted({ reported: ReportedNothingRan })
```

### Only a confirmed review settles an uncertain request

The owner reviews the device's own journal for the claimed attempt and
confirms applied, not applied, or unresolved: an outcome nobody can prove,
closed without being taken for an effect. The device posts
`{digest, attemptId, review}` to `reconciliation`, with the claim's attempt
id and `review` one of `applied`, `not_applied` or `unresolved`. The shell
refuses an unconfirmed review. A review never dispatches again; the same
review again changes nothing.

An applied review may carry the device's saved evidence as
`applied: {operationId, result}`, the operation id and typed result its
journal kept for the attempt. The evidence is admitted only as an applied
receipt for the same operation would be (the
[operations' rule](./operations.md)), and only on an applied review: a not
applied or unresolved review that carries evidence, or evidence that would
not settle applied, is refused and records nothing. The agent keeps
admitted evidence as the request's receipt and result, so a read confirmed
applied this way is answered from its own result. A review without
evidence is admitted as before and leaves the uncertain receipt in place.

```quint
type ReviewEvidence = NoReviewEvidence | AppliedReviewEvidence | RefusedReviewEvidence
pure def reviewEvidenceAdmitted(review: ReviewOutcome, evidence: ReviewEvidence): bool =
  evidence == NoReviewEvidence or (review == ReviewedApplied and evidence == AppliedReviewEvidence)
pure def lawOnlyAnAppliedReviewCarriesEvidence(review: ReviewOutcome, evidence: ReviewEvidence): bool =
  (evidence != NoReviewEvidence and reviewEvidenceAdmitted(review, evidence)) implies (review == ReviewedApplied and evidence == AppliedReviewEvidence)
pure def lawAReviewWithoutEvidenceIsAdmitted(review: ReviewOutcome): bool = reviewEvidenceAdmitted(review, NoReviewEvidence)
pure val uncertainPhase: RequestPhase = Receipted({ reported: ReportedUnknown })
pure def canReconcile(d: DeviceRequest, by: S::SessionOwner, digest: str, attemptId: int, review: ReviewOutcome): bool = exactBinding(d, by, digest) and attemptId == d.session.currentClaim and ((d.phase == uncertainPhase and (review != ReviewedApplied or S::canInvoke(d.session, by, attemptId))) or d.phase == Reviewed({ reviewed: review }))
pure def reconcile(d: DeviceRequest, by: S::SessionOwner, digest: str, attemptId: int, review: ReviewOutcome): DeviceRequest = if (d.phase != uncertainPhase) d else { ...d, phase: Reviewed({ reviewed: review }), session: if (review == ReviewedApplied) settleApplied(d.session, by, attemptId) else d.session }
pure def sometimesUncertain(d: DeviceRequest): bool = d.phase == uncertainPhase
pure def sometimesReviewedApplied(d: DeviceRequest): bool = d.phase == Reviewed({ reviewed: ReviewedApplied })
pure def sometimesReviewedNotApplied(d: DeviceRequest): bool = d.phase == Reviewed({ reviewed: ReviewedNotApplied })
pure def sometimesReviewedUnresolved(d: DeviceRequest): bool = d.phase == Reviewed({ reviewed: ReviewedUnresolved })
```

### A settled request never changes again

Declined, expired, retired, receipted and reviewed requests are final,
except an uncertain one, which only its review settles. A request settled
applied when its receipt or its confirmed review says so; nothing else is
taken for an effect.

```quint
pure def requestSettled(phase: RequestPhase): bool = phase == Declined or phase == Expired or phase == Retired or (afterDispatch(phase) and phase != Dispatched and phase != uncertainPhase)
pure def settledApplied(phase: RequestPhase): bool = phase == Receipted({ reported: ReportedApplied }) or phase == Reviewed({ reviewed: ReviewedApplied })
pure def stepSettledRequestNeverChanges(before: DeviceRequest, after: DeviceRequest): bool = requestSettled(before.phase) implies after.phase == before.phase
pure val requestPhaseValues = Set(Offered, Approved, Declined, Expired, Retired, Dispatched, Receipted({ reported: ReportedApplied }), Receipted({ reported: ReportedNothingRan }), Receipted({ reported: ReportedUnknown }), Reviewed({ reviewed: ReviewedApplied }), Reviewed({ reviewed: ReviewedUnresolved }))
pure def lawAnAppliedRequestIsSettled(requestPhase: RequestPhase): bool = settledApplied(requestPhase) implies (requestSettled(requestPhase) and afterDispatch(requestPhase))
```

## Story: Complete the original request with the result I shared

> As the owner, I want a device read I approved and shared to answer the
> request that asked for it, in the original conversation, only once, so that
> a lost answer never costs a second model call.

### The proposal shows its read reply origin only while the offer is open

`GET /api/client-devices/proposals` adds `readReplyOrigin` to a proposal
only while it is offered, before its deadline, with a pending completion.

```quint
pure def showsReadReplyOrigin(d: DeviceRequest): bool = d.phase == Offered and beforeDeadline(d) and d.completion == CompletionPending
pure def sometimesReadReplyOriginShown(d: DeviceRequest): bool = showsReadReplyOrigin(d)
```

### Only the original applied read with the retained hint opens a completion before its deadline

The hint `{proposalId, digest, attemptId, requestId, conversationId,
inReplyTo}` must equal, field by field, the one retained with the offer and
the claim. The deadline is the earlier of ten minutes after the claim and
thirty minutes after the offer; preparing and delivering the reply need it
open too. A started completion always answers an applied read, and a request
not yet offered has no completion.

```quint
type CompletionHint = { proposalId: str, digest: str, attemptId: int, requestId: str, conversationId: str, inReplyTo: str }
pure val completionAfterClaimMs = 600000
pure val completionAfterOfferMs = 1800000
pure def retainedHint(d: DeviceRequest): CompletionHint = { proposalId: d.proposalId, digest: d.digest, attemptId: d.session.currentClaim, requestId: d.origin.requestId, conversationId: d.origin.conversationId, inReplyTo: d.origin.inReplyTo }
pure def completionDeadline(d: DeviceRequest): int = if (d.claimedAt + completionAfterClaimMs < d.createdAt + completionAfterOfferMs) d.claimedAt + completionAfterClaimMs else d.createdAt + completionAfterOfferMs
pure def completionOpen(d: DeviceRequest): bool = d.session.now < completionDeadline(d)
pure val hintValues = Set({ proposalId: "p1", digest: "d1", attemptId: 1, requestId: "r1", conversationId: "c1", inReplyTo: "m1" }, { proposalId: "p1", digest: "d1", attemptId: 1, requestId: "r1", conversationId: "c2", inReplyTo: "m1" }, { proposalId: "p1", digest: "d1", attemptId: 2, requestId: "r1", conversationId: "c1", inReplyTo: "m1" })
pure val weight_claimCompletion = 6
pure def canClaimCompletion(d: DeviceRequest, by: S::SessionOwner, hint: CompletionHint): bool = exactBinding(d, by, hint.digest) and hint == retainedHint(d) and d.phase == Receipted({ reported: ReportedApplied }) and completionOpen(d) and (d.completion == CompletionPending or d.completion == CompletionPrepared or d.completion == CompletionDelivered)
pure def claimCompletion(d: DeviceRequest, by: S::SessionOwner, hint: CompletionHint): DeviceRequest = if (d.completion == CompletionPending) { ...d, completion: CompletionClaimed, inferences: d.inferences + 1 } else d
pure def canPrepareCompletion(d: DeviceRequest): bool = d.completion == CompletionClaimed and completionOpen(d)
pure def prepareCompletion(d: DeviceRequest): DeviceRequest = { ...d, completion: CompletionPrepared }
pure def canDeliverCompletion(d: DeviceRequest): bool = d.completion == CompletionPrepared and completionOpen(d)
pure def deliverCompletion(d: DeviceRequest): DeviceRequest = { ...d, completion: CompletionDelivered }
pure def completionStarted(c: Completion): bool = c == CompletionClaimed or c == CompletionPrepared or c == CompletionDelivered or c == CompletionUnknown
pure def alwaysStartedCompletionAnswersAnAppliedRead(d: DeviceRequest): bool = (completionStarted(d.completion) implies d.phase == Receipted({ reported: ReportedApplied })) and (d.phase == Unoffered implies d.completion == NoCompletion)
pure def stepCompletionMovesOnlyBeforeItsDeadline(before: DeviceRequest, via: str, after: DeviceRequest): bool = ((via == "claimCompletion" or via == "prepareCompletion" or via == "deliverCompletion") and after.completion != before.completion) implies (completionOpen(before) and before.phase == Receipted({ reported: ReportedApplied }))
```

### A durable claim allows at most one inference, even after a lost outcome

Claiming the completion fixes the attempt and authorizes one model call with
no tool. When the read's family continues the original request from the
shared result, as with an edit or a deletion it prepares for its own
review, that family's answer is the reply in place of the model's, and its
follow-up is kept with the reply and offered once the reply is delivered,
bound to the original message. A prepared or delivered reply is read again
without another call. A failure after the claim ends cancelled when the turn
was aborted and unknown otherwise; neither admits a new inference.

```quint
pure val weight_failCompletion = 2
pure def canFailCompletion(d: DeviceRequest): bool = d.completion == CompletionClaimed
pure def failCompletion(d: DeviceRequest, aborted: bool): DeviceRequest = { ...d, completion: if (aborted) CompletionCancelled else CompletionUnknown }
pure def alwaysOneInferencePerCompletion(d: DeviceRequest): bool = d.inferences >= 0 and d.inferences <= 1 and (completionStarted(d.completion) implies d.inferences == 1) and ((d.completion == NoCompletion or d.completion == CompletionPending) implies d.inferences == 0)
pure def stepInferenceOnlyFromAPendingCompletion(before: DeviceRequest, after: DeviceRequest): bool = after.inferences > before.inferences implies before.completion == CompletionPending
pure def sometimesCompletionDelivered(d: DeviceRequest): bool = d.completion == CompletionDelivered
pure def sometimesLostOutcomeNeverRestarts(d: DeviceRequest): bool = d.completion == CompletionUnknown
pure val eval_witness_sometimesCompletionDelivered = (("registerDevice", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "key1", List("calendar.create.v1"), 0), ("offer", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "p1", "d1", "calendar.create.v1", 600000, true, { requestId: "r1", conversationId: "c1", inReplyTo: "m1" }), ("decide", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1", true), ("claim", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1"), ("receipt", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1", 1, ReportedApplied), ("claimCompletion", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, { proposalId: "p1", digest: "d1", attemptId: 1, requestId: "r1", conversationId: "c1", inReplyTo: "m1" }), ("prepareCompletion", { agentId: "agent1", actorId: "owner1", connector: "agent1" }), ("deliverCompletion", { agentId: "agent1", actorId: "owner1", connector: "agent1" }))
pure val eval_witness_sometimesLostOutcomeNeverRestarts = (("registerDevice", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "key1", List("calendar.create.v1"), 0), ("offer", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "p1", "d1", "calendar.create.v1", 600000, true, { requestId: "r1", conversationId: "c1", inReplyTo: "m1" }), ("decide", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1", true), ("claim", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1"), ("receipt", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1", 1, ReportedApplied), ("claimCompletion", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, { proposalId: "p1", digest: "d1", attemptId: 1, requestId: "r1", conversationId: "c1", inReplyTo: "m1" }), ("failCompletion", false, { agentId: "agent1", actorId: "owner1", connector: "agent1" }))
```

### Cancelling never undoes a delivered reply

The device cancels with the exact binding. A pending, claimed or prepared
completion becomes cancelled; a delivered, cancelled or unknown one stays as
it is.

```quint
pure def canCancelCompletion(d: DeviceRequest, by: S::SessionOwner, digest: str): bool = exactBinding(d, by, digest) and d.completion != NoCompletion
pure def cancelCompletion(d: DeviceRequest, by: S::SessionOwner, digest: str): DeviceRequest = if (d.completion == CompletionPending or d.completion == CompletionClaimed or d.completion == CompletionPrepared) { ...d, completion: CompletionCancelled } else d
pure def stepClosedCompletionNeverReopens(before: DeviceRequest, after: DeviceRequest): bool = (before.completion == CompletionDelivered or before.completion == CompletionCancelled or before.completion == CompletionUnknown or (before.completion == NoCompletion and before.phase != Unoffered)) implies after.completion == before.completion
pure def sometimesCancelledAfterClaim(d: DeviceRequest): bool = d.completion == CompletionCancelled and d.inferences == 1
pure val eval_witness_sometimesCancelledAfterClaim = (("registerDevice", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "key1", List("calendar.create.v1"), 0), ("offer", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "p1", "d1", "calendar.create.v1", 600000, true, { requestId: "r1", conversationId: "c1", inReplyTo: "m1" }), ("decide", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1", true), ("claim", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1"), ("receipt", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1", 1, ReportedApplied), ("claimCompletion", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, { proposalId: "p1", digest: "d1", attemptId: 1, requestId: "r1", conversationId: "c1", inReplyTo: "m1" }), ("cancelCompletion", { agentId: "agent1", actorId: "owner1", connector: "agent1" }, "d1"))
```

## Story: Propose what I asked for on my phone, in my own words

> As the owner, I want the agent to turn what I ask in chat, such as "call
> mom" or "text Sam I'm late", into one request my phone reviews, with its
> target taken from my own words, so that the agent never acts on a number,
> an address or a record it invented, and a retry never asks my phone twice.

### A proposal is offered only on an owner turn of the enrolled device, as its family grounded it, and re-admitted under the turn's negotiation

`PROPOSE_DEVICE_ACTION` is offered to the model only on an owner turn the
enrolled device sent, with a negotiation that was not refused, and with
every form the operation families registered that the negotiation offers,
in a fixed order: the families as they registered, each with its forms in
its own order, where forms that take the same calls share one branch
(below). Its description is the tool's own guidance, including how to read
the device outcomes of earlier requests and that ordinary navigation needs
no phone approval on a message whose views open with `VIEWS`, then the
guidance of each of those forms and of each family that offers one, each
rule stated once (below), as the negotiation and the installation's
enabled views decide it. So the tool is the same on every message of a
device conversation while the negotiation and the installation's views hold
([planning](../conversation/planning.md)), and nothing a message carries
changes it. What depends on the message reaches the model after it, in
the tool's note for the message, sent only while the tool is offered
([planning](../conversation/planning.md)): how views open on it, and the offered
forms the message does not allow, each reason said once with the forms it
holds back. The note says what applies, never that a proposal was made. A form may be offered and yet not available on a message: a family
says which of its forms depend on what the message shows, as a new phone
note depends on the Notes screen ([surfaces](./surfaces.md)).
The turn is live
from the owner's message until its reply ends and only while it is not
aborted: work that still holds it afterwards has no device turn, and the
offer checks it again just before the request is kept. The model may write
the operation as an object or as a JSON string of one. The family of its
wire type may first prepare it, as telephony restores the digits of a
number the owner wrote with separators and Notes sets aside the intent the
model gave a lookup, which stays with the agent, and the operation must then match
one of the offered forms exactly, not only by its type, and be available
on this message. One that matches no offered form is refused before the
family grounds it as coaching for the planner
([planning](../conversation/planning.md)): the model reads that nothing
was created, so it may correct it or answer without it, and it is no step
of the turn, so a corrected proposal is reported alone and the owner hears
no failure for the attempt the model corrected. One whose form this
message does not allow is a call the message serves in
another place: the planner refuses it before dispatch
([planning](../conversation/planning.md)), the model reads which it was
and that nothing was created, so it may ask the owner or take that other
way, and it is no step of the turn, so the owner hears no failure for a
form the tool offers only because the tool is the same on every message.
The handler refuses it the same way if it is ever called otherwise, and
the owner then hears that it could not be prepared, never a reason taken
from the screen. Its family grounds
it in the owner's words: the host-persisted text of the message, without
its document wrapper, and none at all when that text carries an external
envelope, so words inside a page, an email or a connector's payload never
count as the owner's, and in the model's call as the model wrote it, so a
field its preparation set aside still informs it. The family may offer another operation of its own
types in its place: a recipient restored from what the owner said, a send
turned into a draft, an update turned into the read before it. The
grounded operation is then validated again against the turn's negotiation
with no binding, and only then offered, on the turn's request,
conversation and message, for ten minutes. Each operation of a compound
request is its own proposal: a photo kept for its review card never holds
back the text the same message asked for. Every proposal is one the model
made: no family proposes an operation from the owner's words before the
model's choice, and none answers or refuses the request for how it was
worded before the model has seen it.

```quint
type GroundingVerdict = FamilyGrounded | FamilyRefused
type ProposalReply = ProposalOffered | RefusedBeforeDispatch
type FormAvailability = FormNotOffered | FormNotAvailableNow | FormAvailable
pure def formAvailability(offeredForm: bool, availableNow: bool): FormAvailability =
  if (not(offeredForm)) FormNotOffered else if (not(availableNow)) FormNotAvailableNow else FormAvailable
pure def proposalReply(deviceTurn: bool, availability: FormAvailability, verdict: GroundingVerdict, admitted: bool): ProposalReply =
  if (deviceTurn and availability == FormAvailable and verdict == FamilyGrounded and admitted) ProposalOffered else RefusedBeforeDispatch
pure def lawOnlyAnOwnerTurnOfTheEnrolledDeviceProposes(availability: FormAvailability, verdict: GroundingVerdict, admitted: bool): bool =
  proposalReply(false, availability, verdict, admitted) == RefusedBeforeDispatch
pure def lawOnlyAnOfferedFormIsProposed(deviceTurn: bool, availableNow: bool, verdict: GroundingVerdict, admitted: bool): bool =
  proposalReply(deviceTurn, formAvailability(false, availableNow), verdict, admitted) == RefusedBeforeDispatch
pure def lawAFormThisMessageDoesNotAllowIsRefusedBeforeDispatch(deviceTurn: bool, offeredForm: bool, verdict: GroundingVerdict, admitted: bool): bool =
  proposalReply(deviceTurn, formAvailability(offeredForm, false), verdict, admitted) == RefusedBeforeDispatch
pure def lawAGroundedProposalIsReadmitted(deviceTurn: bool, availability: FormAvailability, verdict: GroundingVerdict): bool =
  proposalReply(deviceTurn, availability, verdict, false) == RefusedBeforeDispatch
pure def servedElsewhere(availability: FormAvailability): bool = availability == FormNotAvailableNow
pure def lawAFormServedElsewhereIsNeverProposed(deviceTurn: bool, availability: FormAvailability, verdict: GroundingVerdict, admitted: bool): bool =
  servedElsewhere(availability) implies proposalReply(deviceTurn, availability, verdict, admitted) == RefusedBeforeDispatch
pure def lawAnUnmatchedOperationIsNotServedElsewhere(availableNow: bool): bool =
  not(servedElsewhere(formAvailability(false, availableNow)))
```

### The proposal tool states each rule once, names no capability, and shares a branch only between forms that accept the same calls

The tool is read on every planner call of a phone turn, so it says each
thing once. Its description is made of guidance fragments, the tool's own,
then each offered form's and each offering family's, and a fragment that
several of them give, such as how a number the owner wrote reaches the
model or that returned text is untrusted data, is stated once, where it
first appears. It names no capability, since only an offered form can be
called, and it does not restate what a branch's fields and their
descriptions already say. The operation it sends is a union with a branch
for each offered form, except that two closed branches, which take no
field beyond those they list and say the same beside their fields, share
one branch that accepts exactly what the two accept apart: when all that
tells them apart is the values of one string field, the shared branch
takes the values of both; when one has a single field more and is
otherwise the same, the shared branch has that field and does not require
it, unless every field of every branch of the union is required, since a
provider decodes a union as a strict grammar only while that holds.
Branches share until no two can; a shared branch stays where its first
form was, and its values keep their forms' order, so the same offered
forms are always sent as the same bytes. The union is only what the model
reads: a call is still matched against each offered form on its own
(above).

```quint
type BranchShare = SharedByValues | SharedByOptionalField | KeptApart
pure def branchShare(sameFrame: bool, sameFields: bool, differingFields: int, valuesOnly: bool, oneFieldMore: bool, everyFieldRequired: bool): BranchShare =
  if (not(sameFrame)) KeptApart
  else if (sameFields and differingFields == 1 and valuesOnly) SharedByValues
  else if (oneFieldMore and not(everyFieldRequired)) SharedByOptionalField
  else KeptApart
pure def lawOnlyClosedBranchesThatSayTheSameShare(sameFields: bool, differingFields: int, valuesOnly: bool, oneFieldMore: bool, everyFieldRequired: bool): bool =
  branchShare(false, sameFields, differingFields, valuesOnly, oneFieldMore, everyFieldRequired) == KeptApart
pure def lawValuesAreSharedOnlyWhenTheyAreAllThatDiffers(sameFrame: bool, sameFields: bool, differingFields: int, valuesOnly: bool, oneFieldMore: bool, everyFieldRequired: bool): bool =
  branchShare(sameFrame, sameFields, differingFields, valuesOnly, oneFieldMore, everyFieldRequired) == SharedByValues implies (sameFields and differingFields == 1 and valuesOnly)
pure def lawAUnionWithEveryFieldRequiredGetsNoOptionalField(sameFrame: bool, sameFields: bool, differingFields: int, valuesOnly: bool, oneFieldMore: bool): bool =
  branchShare(sameFrame, sameFields, differingFields, valuesOnly, oneFieldMore, true) != SharedByOptionalField
pure def lawAFieldIsMadeOptionalOnlyForOneFieldMore(sameFrame: bool, sameFields: bool, differingFields: int, valuesOnly: bool, everyFieldRequired: bool): bool =
  branchShare(sameFrame, sameFields, differingFields, valuesOnly, false, everyFieldRequired) != SharedByOptionalField
```

### Each wire type belongs to at most one proposal family, and a family offers forms only of its own types

The operation families that register with the agent own disjoint sets of
wire types. A registration that claims a type another family already owns,
or that offers a form naming a type outside its own set, is refused whole,
and the module that made it does not start; registering the same family
again changes nothing. A family may also name the app its operations run
in; what that name does is [planning](../conversation/planning.md)'s rule
on a tool's progress, which models it.

```quint
pure def registrationAdmitted(claimedByAnother: bool, formsWithinTypes: bool): bool = not(claimedByAnother) and formsWithinTypes
pure def lawATypeAnotherFamilyOwnsIsRefused(formsWithinTypes: bool): bool = not(registrationAdmitted(true, formsWithinTypes))
pure def lawAFormOutsideTheFamilysTypesIsRefused(claimedByAnother: bool): bool = not(registrationAdmitted(claimedByAnother, false))
```

### A proposal carries the owner's message only for a live turn that asked for it directly, so otherwise the phone shows its card

A family grounds an operation as the owner asked for it, for review, or as
a step on what the owner has open: the thread or voicemail on the screen,
or the Calendar day a standalone agenda read shows. The proposal carries the
owner's message as `requestMessageId` only while its turn is live, and then
only for a step on the open selection, or for an operation grounded as
asked on a turn whose message is a direct request for its family
(`voiceUi.agentActionMode` is `direct-request-v1` for every family, or
`direct-files-v1` for the Files family alone, so a phone that runs only
Files directly keeps every other family's card). Any other proposal carries none, so the phone
never runs it without its card, whatever the operation and the owner's
[direct-request preference](./execution.md); its origin is still the
owner's message, so its identity, its read completion and the outcomes a
later turn learns are the same. The choice is kept with the request, and
the review routes serve the key only where it was kept. An open request of
the same operation is returned for a repeat in another message only when
neither carries a message: one that carries its message runs without its
card only for that message, so a later message that asks again, such as
"take a picture" said twice, is a request of its own.

The reply follows the choice. A pending request that carries the message
tells the model that it is a handoff that has not run yet, so the model
never claims what it found or shows; where the family gives the owner a
sentence for it ("Opening example.com."), the model gets that sentence as
what the phone shows and words the reply itself, so the owner never hears
the family's sentence beside the model's. One kept for review asks the
owner to review it on the phone, in the family's words and in the turn's
time zone, since the review is the owner's own step. An approved or
running one only tells the model its state. The emergency keypad's safety
copy is delivered in the family's words.

```quint
type ProposalGrounding = GroundedAsAsked | GroundedForReview | GroundedOnScreen
type DirectScope = NoDirectRequest | DirectForEveryFamily | DirectForFiles
pure def directRequestFor(scope: DirectScope, filesFamily: bool): bool =
  scope == DirectForEveryFamily or (scope == DirectForFiles and filesFamily)
pure def carriesRequestMessage(grounding: ProposalGrounding, directRequest: bool, turnLive: bool): bool =
  turnLive and (grounding == GroundedOnScreen or (directRequest and grounding == GroundedAsAsked))
pure def lawAFilesOnlyDirectRequestBindsNoOtherFamily(turnLive: bool): bool =
  not(carriesRequestMessage(GroundedAsAsked, directRequestFor(DirectForFiles, false), turnLive))
pure def lawAFilesOnlyDirectRequestBindsFilesAsAsked(turnLive: bool): bool =
  carriesRequestMessage(GroundedAsAsked, directRequestFor(DirectForFiles, true), turnLive) == turnLive
pure def returnsOpenRequest(keptCarries: bool, proposedCarries: bool, sameOperation: bool): bool =
  sameOperation and not(keptCarries) and not(proposedCarries)
pure def lawAProposalForReviewCarriesNoMessage(directRequest: bool, turnLive: bool): bool =
  not(carriesRequestMessage(GroundedForReview, directRequest, turnLive))
pure def lawOnlyADirectRequestCarriesTheMessageAsAsked(turnLive: bool): bool =
  not(carriesRequestMessage(GroundedAsAsked, false, turnLive))
pure def lawAnEndedTurnCarriesNoMessage(grounding: ProposalGrounding, directRequest: bool): bool =
  not(carriesRequestMessage(grounding, directRequest, false))
pure def lawARepeatNeverReturnsADifferentlyBoundRequest(sameOperation: bool): bool =
  not(returnsOpenRequest(true, false, sameOperation)) and not(returnsOpenRequest(false, true, sameOperation))
pure def lawARequestThatCarriesItsMessageIsNeverReturnedToAnother(proposedCarries: bool, sameOperation: bool): bool =
  not(returnsOpenRequest(true, proposedCarries, sameOperation))
pure def lawAReviewedRepeatReturnsTheOpenRequest(sameOperation: bool): bool = returnsOpenRequest(false, false, sameOperation) == sameOperation
```

### A proposal's identity is its request message and its operation, so a repeat returns the same request

The proposal id is derived from the owner's message and a digest of the
grounded operation, never from the model. Proposing it again returns the
request already kept under that id; an open request of the same
conversation for the same operation is returned too when neither carries a
message. A family's refusal is held while a request is kept that way for
the exact operation the model proposed: re-proposing it only retrieves that
request, its stored receipt or the same review, and never creates a new
one. A request that already settled is reported from its stored receipt
and is never dispatched again, in its family's words: what the model may
say of the historical result, which is never a current read, and the
family's sentence for the owner as a fact the model words; otherwise the
model answers from that result.

```quint
type ProposalAnswer = OfferedNew | ReturnedOpen | ReturnedSettled | AnsweredRefused
pure def proposalAnswer(reply: ProposalReply, sameKeyKept: bool, keptSettled: bool, sameOperationOpen: bool): ProposalAnswer =
  if (sameKeyKept) (if (keptSettled) ReturnedSettled else ReturnedOpen)
  else if (sameOperationOpen) ReturnedOpen
  else if (reply == ProposalOffered) OfferedNew
  else AnsweredRefused
pure def lawARepeatNeverOffersASecondRequest(reply: ProposalReply, keptSettled: bool, sameOperationOpen: bool): bool =
  proposalAnswer(reply, true, keptSettled, sameOperationOpen) != OfferedNew
pure def lawASettledRepeatIsReportedNotDispatched(reply: ProposalReply, sameOperationOpen: bool): bool =
  proposalAnswer(reply, true, true, sameOperationOpen) == ReturnedSettled
pure def lawAnOpenRequestOfTheSameOperationIsReturned(reply: ProposalReply, keptSettled: bool): bool =
  proposalAnswer(reply, false, keptSettled, true) == ReturnedOpen
pure def lawAHeldRefusalReturnsTheKeptRequest(keptSettled: bool, sameOperationOpen: bool): bool =
  proposalAnswer(RefusedBeforeDispatch, true, keptSettled, sameOperationOpen) != AnsweredRefused
```

### A grounding refusal offers nothing and is a refusal before dispatch

When the family refuses and no request is kept for the exact operation,
nothing is kept: the model learns why in its own words, and the result
carries the family's own sentence for the owner and is marked
`executionStatus: "not_started"`, which [planning](../conversation/planning.md)
records as `Rejected`. The model can revise its reply after a host note that
quotes that sentence. The family's sentence still reaches the owner when
that failure remains open under the [planning rules](../conversation/planning.md).
A sentence the family marks as safety copy always reaches the owner as written. An operation that is not an offered form, that this
message does not allow, or that the negotiation no longer admits, is
refused the same way. A family may instead hand the proposal back to the
model, when the model can correct it or ask the owner itself (a recipient it
invented, which part of a sender): it offers nothing just the same, but the owner hears no family
sentence; the model alone learns why, as coaching it may correct, and answers
the owner in its own words.

```quint
pure def lawAGroundingRefusalOffersNothing(deviceTurn: bool, availability: FormAvailability, admitted: bool, keptSettled: bool, sameOperationOpen: bool): bool =
  proposalAnswer(proposalReply(deviceTurn, availability, FamilyRefused, admitted), false, keptSettled, sameOperationOpen) != OfferedNew
pure def lawAnUnheldRefusalIsAnswered(deviceTurn: bool, availability: FormAvailability, admitted: bool, keptSettled: bool): bool =
  proposalAnswer(proposalReply(deviceTurn, availability, FamilyRefused, admitted), false, keptSettled, false) == AnsweredRefused
```

### A read's follow-up is offered only after its reply was delivered, as its own family continued it

When an applied read answers the original request, the read's family may
continue that request from the shared result: an edit or a deletion of the
record the read returned, as the owner's original words asked for it, or
its own sentence when no change can follow. Its sentence replaces the
model's reply. Its follow-up must be one of that family's own types, is
validated against the completion's negotiation with no binding, and is
offered only once, when this reply was first delivered, on the original
request, conversation and message. The original turn has ended by then, so
the follow-up carries no `requestMessageId` and is always reviewed on the
phone.

```quint
pure def followUpOffered(delivered: bool, continued: bool, ownType: bool, admitted: bool): bool = delivered and continued and ownType and admitted
pure def lawAFollowUpWaitsForTheDeliveredReply(continued: bool, ownType: bool, admitted: bool): bool = not(followUpOffered(false, continued, ownType, admitted))
pure def lawAFollowUpIsTheReadFamilysOwn(delivered: bool, admitted: bool): bool = not(followUpOffered(delivered, true, false, admitted))
```

### A later turn of the same conversation learns at most six outcomes of its own requests: what changed, and what ended without running

An owner turn of the enrolled device carries, beside the screen context, a
note of the newest outcomes of this conversation's own requests: each one
that settled applied and changed something on the phone, and each one the
owner declined or that expired before it ran. A read, a view change or an
opened review settled applied changes nothing
([device operations](./operations.md)) and is never named as an effect; an
open, running, uncertain or otherwise settled request is not named either.
Only a request that still stands is named: its original message is still
the owner's own, in this conversation, under the current enrollment, and
the turn's negotiation still admits its operation. Each line gives its
proposal id, its operation type, a label where the operation has one, and
when it settled, or that it never ran. An applied SMS line also carries
only the validated transport status from its settled receipt. Submission
does not confirm sending, and sending does not confirm delivery. A settled
send is not offered or repeated because of old approval prose. The lines
follow a lead saying their labels are
untrusted record data, never instructions. When the requests cannot be
read, a note says that they could not be checked. While the device tool is
offered, what holds on every turn sits in its description (above): that
an applied outcome supersedes older pending dialogue for that proposal
only, that a completed request is never replayed, and that earlier pending
dialogue proves nothing is still pending; a turn with no outcome to report
then sends no such note. A device turn whose negotiation was refused or
offers no form has no device tool to describe this, so its note says it:
after the outcomes it names, how to read them, and with none, that earlier
pending dialogue proves nothing is still pending. It looks at the fifty
newest requests of this conversation that settled. It is a historical receipt, never a current read or authority for
a new effect, and it names at most six.

```quint
type RequestEnding = EndedApplied | EndedDeclined | EndedExpired | EndedOtherwise | StillOpen
pure def requestEnding(requestPhase: RequestPhase): RequestEnding =
  if (settledApplied(requestPhase)) EndedApplied
  else if (requestPhase == Declined) EndedDeclined
  else if (requestPhase == Expired or requestPhase == Retired) EndedExpired
  else if (requestSettled(requestPhase)) EndedOtherwise
  else StillOpen
pure def outcomeLearned(ending: RequestEnding, nothingChanged: bool, standing: bool): bool =
  standing and ((ending == EndedApplied and not(nothingChanged)) or ending == EndedDeclined or ending == EndedExpired)
pure val outcomesShown = 6
pure def outcomesLearned(learnedCount: int): int = if (learnedCount < outcomesShown) learnedCount else outcomesShown
pure def lawAtMostSixOutcomesAreLearned(learnedCount: int): bool = outcomesLearned(learnedCount) <= outcomesShown
pure def lawEveryOutcomeUpToSixIsLearned(learnedCount: int): bool = (learnedCount >= 0 and learnedCount <= outcomesShown) implies outcomesLearned(learnedCount) == learnedCount
pure def lawAReadIsNeverLearnedAsAnEffect(standing: bool): bool = not(outcomeLearned(EndedApplied, true, standing))
pure def lawAnOpenOrUncertainRequestIsNotLearned(nothingChanged: bool, standing: bool): bool =
  not(outcomeLearned(StillOpen, nothingChanged, standing)) and not(outcomeLearned(EndedOtherwise, nothingChanged, standing))
pure def lawOnlyAStandingRequestIsLearned(ending: RequestEnding, nothingChanged: bool): bool = not(outcomeLearned(ending, nothingChanged, false))
pure def outcomesNoteSent(learnedCount: int, checked: bool, toolDescribed: bool): bool =
  not(checked) or not(toolDescribed) or outcomesLearned(learnedCount) > 0
pure def lawNoOutcomeSendsNoNote(learnedCount: int): bool = learnedCount <= 0 implies not(outcomesNoteSent(learnedCount, true, true))
pure def lawAnUncheckedHistoryIsAlwaysSaid(learnedCount: int, toolDescribed: bool): bool = outcomesNoteSent(learnedCount, false, toolDescribed)
pure def lawWithoutTheToolTheNoteIsAlwaysSent(learnedCount: int): bool = outcomesNoteSent(learnedCount, true, false)
pure def lawAnEndingThatNeverRanWasNeverDispatched(requestPhase: RequestPhase): bool =
  (requestEnding(requestPhase) == EndedDeclined or requestEnding(requestPhase) == EndedExpired) implies not(afterDispatch(requestPhase))
pure def lawAnUncertainRequestIsStillOpen(requestPhase: RequestPhase): bool = requestPhase == uncertainPhase implies requestEnding(requestPhase) == StillOpen
```
