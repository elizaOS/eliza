# Device requests

The agent asks the owner's device to do what only the device can do: read a
calendar range, create a reminder, send a message. This spec owns one such
request inside the agent process, from the offer to its settled outcome, and
the enrollment of the device it is offered to. The request holds a core
[interaction session](../../core/sessions.md), whose claim, commit, single
invocation and ambiguity it reuses; dispatch to a device that declared the
capability is the core [device bridge](../../core/deviceBridge.md). What the
device does with a claimed request is `execution.md`; the capability
vocabulary and header negotiation are `capabilities.md`; the
operation shapes are `operations.md`.

The routes are `POST /api/client-devices/{register,revoke}`,
`GET /api/client-devices/context`, `GET /api/client-devices/proposals` and
`POST /api/client-devices/proposals/:id/{decide,claim,receipt,reconcile,read-completion,cancel-read-completion}`.
The shell checks the device key in constant time and passes the sender as a
session owner: the agent's id, the owner's user id and the installation id.
A refused event answers 409 and changes nothing; a store failure answers 503.

## Story: Enroll my device and revoke it

> As the owner, I want to enroll my device once under its own key and to
> revoke it for good, so that no other device and no revoked device can see
> or act on what the agent asks.

### A device enrolls under its own key as the agent's installation

The installation id is the agent's own store id (`storage/database.md`),
never a second identity. A first registration records the owner, the key
hash and the workflow protocol, and connects the device to the bridge with
the capabilities it declares. Registering again with the same key changes
only the workflow protocol; another key, another owner or a revoked
enrollment is refused. The workflow protocol's upper bound is the workflow
spec's, checked by the shell.

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
pure def canRegisterDevice(d: DeviceRequest, by: S::SessionOwner, keyHash: str, capabilities: List[str], workflowProtocol: int): bool = keyHash != "" and workflowProtocol >= 0 and by.actorId != "" and by.agentId != "" and by.connector == by.agentId and (if (d.enrollment == Unenrolled) DB::canConnectDevice(d.bridge, { id: by.connector, capabilities: capabilities }) else enrolledOwner(d.enrollment) == by and enrolledKey(d.enrollment) == keyHash)
pure def registerDevice(d: DeviceRequest, by: S::SessionOwner, keyHash: str, capabilities: List[str], workflowProtocol: int): DeviceRequest = { ...d, enrollment: Enrolled({ owner: by, keyHash: keyHash, workflowProtocol: workflowProtocol }), bridge: if (d.enrollment == Unenrolled) DB::connectDevice(d.bridge, { id: by.connector, capabilities: capabilities }) else d.bridge }
pure def alwaysInstallationIsTheAgent(d: DeviceRequest): bool = isEnrolled(d.enrollment) implies (enrolledOwner(d.enrollment).connector == enrolledOwner(d.enrollment).agentId and enrolledKey(d.enrollment) != "")
pure def stepEnrollmentKeepsItsOwnerAndKey(before: DeviceRequest, after: DeviceRequest): bool = isEnrolled(before.enrollment) implies (after.enrollment == Revoked or (enrolledOwner(after.enrollment) == enrolledOwner(before.enrollment) and enrolledKey(after.enrollment) == enrolledKey(before.enrollment)))
```

### A revoked enrollment never returns and retires every open offer

Revocation disconnects the device from the bridge, which fails a call still
waiting on it, and retires an offer not yet claimed. A dispatched request
keeps its record: the device can no longer report on it, and nothing runs
it again.

```quint
pure def openOffer(phase: RequestPhase): bool = phase == Offered or phase == Approved
pure def canRevokeEnrollment(d: DeviceRequest, by: S::SessionOwner): bool = isEnrolled(d.enrollment) and enrolledOwner(d.enrollment) == by and DB::canDisconnectDevice(d.bridge, by.connector)
pure def revokeEnrollment(d: DeviceRequest, by: S::SessionOwner): DeviceRequest = { ...d, enrollment: Revoked, bridge: DB::disconnectDevice(d.bridge, by.connector), phase: if (openOffer(d.phase)) Retired else d.phase, session: if (openOffer(d.phase)) S::revoke(d.session) else d.session }
pure def stepRevokedStaysRevoked(before: DeviceRequest, via: str, after: DeviceRequest): bool = (before.enrollment == Revoked implies after.enrollment == Revoked) and (via == "revokeEnrollment" implies (if (openOffer(before.phase)) after.phase == Retired else after.phase == before.phase))
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
read, the offer also opens a read completion (`readBack`).

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

Time only moves forward. An open offer past its deadline expires; an open
offer whose turn ended retires. Either withdraws the session's authority, so
the offer never reaches the device.

```quint
pure val elapsedValues = Set(0, 300000, 600000)
pure def canElapse(d: DeviceRequest, elapsed: int): bool = S::canElapse(d.session, elapsed)
pure def elapse(d: DeviceRequest, elapsed: int): DeviceRequest = { ...d, session: S::elapse(d.session, elapsed) }
pure def canExpire(d: DeviceRequest): bool = openOffer(d.phase) and not(beforeDeadline(d))
pure def expire(d: DeviceRequest): DeviceRequest = { ...d, phase: Expired, session: S::revoke(d.session) }
pure def canEndTurn(d: DeviceRequest): bool = openOffer(d.phase)
pure def endTurn(d: DeviceRequest): DeviceRequest = { ...d, phase: Retired, session: S::revoke(d.session) }
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
closed without being taken for an effect. The shell refuses an unconfirmed
review. A review never dispatches again; the same review again changes
nothing.

```quint
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
except an uncertain one, which only its review settles.

```quint
pure def requestSettled(phase: RequestPhase): bool = phase == Declined or phase == Expired or phase == Retired or (afterDispatch(phase) and phase != Dispatched and phase != uncertainPhase)
pure def stepSettledRequestNeverChanges(before: DeviceRequest, after: DeviceRequest): bool = requestSettled(before.phase) implies after.phase == before.phase
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
no tool. A prepared or delivered reply is read again without another call. A
failure after the claim ends cancelled when the turn was aborted and unknown
otherwise; neither admits a new inference.

```quint
pure def canFailCompletion(d: DeviceRequest): bool = d.completion == CompletionClaimed
pure def failCompletion(d: DeviceRequest, aborted: bool): DeviceRequest = { ...d, completion: if (aborted) CompletionCancelled else CompletionUnknown }
pure def alwaysOneInferencePerCompletion(d: DeviceRequest): bool = d.inferences >= 0 and d.inferences <= 1 and (completionStarted(d.completion) implies d.inferences == 1) and ((d.completion == NoCompletion or d.completion == CompletionPending) implies d.inferences == 0)
pure def stepInferenceOnlyFromAPendingCompletion(before: DeviceRequest, after: DeviceRequest): bool = after.inferences > before.inferences implies before.completion == CompletionPending
pure def sometimesCompletionDelivered(d: DeviceRequest): bool = d.completion == CompletionDelivered
pure def sometimesLostOutcomeNeverRestarts(d: DeviceRequest): bool = d.completion == CompletionUnknown
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
```
