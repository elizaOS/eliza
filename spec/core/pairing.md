# Pairing approval ownership

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/services/pairing.ts` and `types/pairing.ts`. Approval composes the [pending requests](./pairingAdmission.md) and [stored grants](./pairingGrants.md) already owned by those contracts. The [reply throttle](./pairingReplies.md) offers no authorization.

## Story: Approve a pairing code without losing a failed request

### Each request lookup selects the exact oldest live row for the normalized code

Each approval captures its own agent, channel and trim-and-uppercase code. A blank normalized code returns no match without a storage read. A read that throws fails the approval; a successful read chooses the first matching live row in stable creation-time order. This lookup also schedules the same best-effort expired-row cleanup as admission. Concurrent approvals can capture the same row before either grants or consumes it. JavaScript normalization and persistence codecs remain conformance boundaries.

```quint
import pairingAdmission as R from "./pairingAdmission"
import pairingGrants as G from "./pairingGrants"
type Sender = { agentId: str, channel: str, senderId: str }
pure def sameSender(left: Sender, right: Sender): bool = left == right
pure def lawDifferentAgentsStayIndependent(left: Sender, right: Sender): bool = left.agentId != right.agentId implies not(sameSender(left, right))
pure def lawDifferentChannelsStayIndependent(left: Sender, right: Sender): bool = left.channel != right.channel implies not(sameSender(left, right))
pure def lawDifferentSendersStayIndependent(left: Sender, right: Sender): bool = left.senderId != right.senderId implies not(sameSender(left, right))
type ApprovalKey = { agent: str, channel: str, codeQuery: str }
type ApprovalPhase = ApprovalAbsent | ApprovalReading | ApprovalGranting | ApprovalConsuming | ApprovalNoMatch | ApprovalReadFailed | ApprovalGrantFailed | ApprovalConsumeFailed | ApprovalAccepted
type Approval = { id: int, lookup: ApprovalKey, phase: ApprovalPhase, captured: R::PendingRow, retained: G::GrantRow }
type GrantAttempt = { grantKey: str, grantedAt: int, acknowledgement: G::GrantStatus }
type ApprovalState = { requests: R::PairingAdmission, grants: G::PairingGrants, attempts: List[Approval], nextAttempt: int }
pure val emptyLookup: ApprovalKey = { agent: "", channel: "", codeQuery: "" }
pure val noAttempt: Approval = { id: 0, lookup: emptyLookup, phase: ApprovalAbsent, captured: R::emptyRow, retained: G::emptyGrant }
pure val initial: ApprovalState = { requests: R::initial, grants: G::initial, attempts: List(), nextAttempt: 1 }
pure def requestChannel(lookup: ApprovalKey): R::PairingScope = { agent: lookup.agent, channel: lookup.channel, sender: "" }
pure def lookupPending(s: ApprovalState, lookup: ApprovalKey, readAt: int): R::PendingRow =
  R::oldestPending(R::liveInChannel(s.requests.rows, requestChannel(lookup), readAt, s.requests.ttl).select(row => row.normalizedCode == lookup.codeQuery))
pure def getAttempt(s: ApprovalState, id: int): Approval = s.attempts.select(attempt => attempt.id == id).nthOr(0, noAttempt)
pure def replaceAttempt(attempt: Approval, s: ApprovalState): ApprovalState = { ...s, attempts: s.attempts.listMap(row => if (row.id == attempt.id) attempt else row) }
pure def canApprove(s: ApprovalState, lookup: ApprovalKey): bool = s.requests.configured
pure def approve(s: ApprovalState, lookup: ApprovalKey): ApprovalState = {
  val phase = if (lookup.codeQuery == "") ApprovalNoMatch else ApprovalReading
  { ...s, attempts: s.attempts.append({ ...noAttempt, id: s.nextAttempt, lookup: lookup, phase: phase }), nextAttempt: s.nextAttempt + 1 }
}
pure def canReadApproval(s: ApprovalState, id: int): bool = getAttempt(s, id).phase == ApprovalReading
pure def readApproval(s: ApprovalState, id: int, readAt: int, success: bool): ApprovalState = {
  val attempt = getAttempt(s, id)
  val captured = if (success) lookupPending(s, attempt.lookup, readAt) else R::emptyRow
  val phase = if (not(success)) ApprovalReadFailed else if (captured.id == "") ApprovalNoMatch else ApprovalGranting
  val expired = s.requests.rows.select(row => R::sameChannel(row.scope, requestChannel(attempt.lookup)) and not(R::liveAt(readAt, s.requests.ttl, row)))
  val requests = if (success) { ...s.requests, cleanupIds: expired.foldl(s.requests.cleanupIds, (ids, row) => R::rememberCleanup(ids, row)) } else s.requests
  replaceAttempt({ ...attempt, phase: phase, captured: captured }, { ...s, requests: requests })
}
```

### A retained grant is captured before deletion of that request's ID

Each granting attempt proposes the deterministic key for its captured owner with that row’s metadata. It snapshots the authoritative grant returned by the canonical grant owner, even when a concurrent insert retained older data. A grant write failure, thrown read or missing readback does not issue request deletion. After successful grant acquisition, deletion targets only the captured request ID, which can never name a later request. Acknowledged deletion is idempotent when another approval or expiry cleanup already removed that ID. Success exposes the captured request and grant independently of subsequent changes to either table. A storage acknowledgement classified as failed does not remove the row in this model; ambiguous commit transport and confirmation are adapter refinement boundaries.

```quint
pure def writeFor(attempt: Approval, grantInput: GrantAttempt): G::GrantWrite = {
  candidate: G::candidateFor(attempt.captured.scope, grantInput.grantKey, grantInput.grantedAt, attempt.captured.metadata),
  ack: grantInput.acknowledgement
}
pure def canGrant(s: ApprovalState, id: int, grantInput: GrantAttempt): bool = {
  val attempt = getAttempt(s, id)
  attempt.phase == ApprovalGranting and G::canWriteGrant(s.grants, writeFor(attempt, grantInput))
}
pure def grant(s: ApprovalState, id: int, grantInput: GrantAttempt): ApprovalState = {
  val attempt = getAttempt(s, id)
  val grants = G::writeGrant(s.grants, writeFor(attempt, grantInput))
  val succeeded = grants.status == G::GrantRetained
  replaceAttempt({ ...attempt, phase: if (succeeded) ApprovalConsuming else ApprovalGrantFailed, retained: grants.reported }, { ...s, grants: grants })
}
pure def canConsume(s: ApprovalState, id: int): bool = getAttempt(s, id).phase == ApprovalConsuming
pure def consume(s: ApprovalState, id: int, success: bool): ApprovalState = {
  val attempt = getAttempt(s, id)
  val requests = if (success) R::dropPending(attempt.captured.id, s.requests) else s.requests
  replaceAttempt({ ...attempt, phase: if (success) ApprovalAccepted else ApprovalConsumeFailed }, { ...s, requests: requests })
}
pure def canRestoreRequest(s: ApprovalState, row: R::PendingRow): bool = R::canRestorePending(s.requests, row)
pure def restoreRequest(s: ApprovalState, row: R::PendingRow): ApprovalState = { ...s, requests: R::restorePending(s.requests, row) }
pure def canConfigure(s: ApprovalState): bool = R::canConfigure(s.requests)
pure def configure(s: ApprovalState, maximum: int, ttl: int): ApprovalState = { ...s, requests: R::configure(s.requests, maximum, ttl) }
pure def canEnqueueAdmission(s: ApprovalState, input: R::AdmissionInput): bool = R::canEnqueueAdmission(s.requests, input)
pure def enqueueAdmission(s: ApprovalState, input: R::AdmissionInput): ApprovalState = { ...s, requests: R::enqueueAdmission(s.requests, input) }
pure def canEnterAdmission(s: ApprovalState): bool = R::canEnterAdmission(s.requests)
pure def enterAdmission(s: ApprovalState, enteredAt: int): ApprovalState = { ...s, requests: R::enterAdmission(s.requests, enteredAt) }
pure def canReadPending(s: ApprovalState): bool = R::canReadPending(s.requests)
pure def readPending(s: ApprovalState, readAt: int): ApprovalState = { ...s, requests: R::readPending(s.requests, readAt) }
pure def canWritePending(s: ApprovalState, writeResult: R::WriteOutcome): bool = R::canWritePending(s.requests, writeResult)
pure def writePending(s: ApprovalState, writeResult: R::WriteOutcome): ApprovalState = { ...s, requests: R::writePending(s.requests, writeResult) }
pure def canRejectFull(s: ApprovalState): bool = R::canRejectFull(s.requests)
pure def rejectFull(s: ApprovalState): ApprovalState = { ...s, requests: R::rejectFull(s.requests) }
pure def canFailPendingRead(s: ApprovalState): bool = R::canReadFailed(s.requests)
pure def failPendingRead(s: ApprovalState): ApprovalState = { ...s, requests: R::readFailed(s.requests) }
pure def canSettleCleanup(s: ApprovalState, requestId: str): bool = R::canSettleCleanup(s.requests, requestId)
pure def settleCleanup(s: ApprovalState, requestId: str, success: bool): ApprovalState = { ...s, requests: R::settleCleanup(s.requests, requestId, success) }
pure def canWriteDirectGrant(s: ApprovalState, request: G::GrantWrite): bool = G::canWriteGrant(s.grants, request)
pure def writeDirectGrant(s: ApprovalState, request: G::GrantWrite): ApprovalState = { ...s, grants: G::writeGrant(s.grants, request) }
pure def removeGrant(s: ApprovalState, key: str): ApprovalState = { ...s, grants: G::removeGrant(s.grants, key) }
pure def ownsCapturedRequest(phase: ApprovalPhase): bool = phase == ApprovalGranting or phase == ApprovalConsuming or phase == ApprovalGrantFailed or phase == ApprovalConsumeFailed or phase == ApprovalAccepted
pure def ownsRetainedGrant(phase: ApprovalPhase): bool = phase == ApprovalConsuming or phase == ApprovalConsumeFailed or phase == ApprovalAccepted
pure def alwaysStoredRequestHasIssuedId(s: ApprovalState): bool = s.requests.rows.every(row => s.requests.issuedIds.contains(row.id))
pure def alwaysRequestOwnerIsStable(s: ApprovalState): bool = s.attempts.every(attempt => ownsCapturedRequest(attempt.phase) implies attempt.captured.id != "" and s.requests.issuedIds.contains(attempt.captured.id) and R::sameChannel(attempt.captured.scope, requestChannel(attempt.lookup)) and attempt.captured.normalizedCode == attempt.lookup.codeQuery)
pure def alwaysGrantMatchesRequest(s: ApprovalState): bool = s.attempts.every(attempt => ownsRetainedGrant(attempt.phase) implies attempt.retained.key != "" and attempt.retained.owner == attempt.captured.scope)
pure def alwaysConsumedExactRequest(s: ApprovalState): bool = s.attempts.every(attempt => attempt.phase == ApprovalAccepted implies not(s.requests.rows.some(row => row.id == attempt.captured.id)))
pure def stepExistingGrantIdentityIsStable(before: ApprovalState, via: str, after: ApprovalState): bool = via != "removeGrant" implies before.grants.rows.every(row => after.grants.rows.includes(row))
pure def sometimesPairingComplete(s: ApprovalState): bool = s.attempts.some(attempt => attempt.phase == ApprovalAccepted)
pure def sometimesConsumptionCanRetry(s: ApprovalState): bool = s.attempts.some(attempt => attempt.phase == ApprovalConsumeFailed and s.requests.rows.some(row => row.id == attempt.captured.id) and s.grants.rows.includes(attempt.retained))
pure def sometimesConcurrentApprovalsShareCapture(s: ApprovalState): bool = s.attempts.some(left => s.attempts.some(right => left.id != right.id and left.captured.id != "" and left.captured.id == right.captured.id))
pure val leftValues = Set({ agentId: "a1", channel: "chat", senderId: "one" }, { agentId: "a2", channel: "mail", senderId: "two" })
pure val rightValues = leftValues
pure val rowValues = R::rowValues
pure val maximumValues = R::maximumValues
pure val ttlValues = R::ttlValues
pure val readAtValues = R::readAtValues
pure val inputValues = R::inputValues
pure val enteredAtValues = R::enteredAtValues
pure val writeResultValues = R::writeResultValues
pure val requestIdValues = R::idValues
pure val requestValues = G::requestValues
pure val keyValues = G::keyValues
pure val idValues = Set(1, 2, 3, 4, 5, 6)
pure val lookupValues = Set({ agent: "a1", channel: "chat", codeQuery: "MNPQRTUV" }, { agent: "a1", channel: "chat", codeQuery: "NPQRTUVM" }, { agent: "a1", channel: "chat", codeQuery: "" })
pure val grantInputValues: Set[GrantAttempt] = Set({ grantKey: "grant1", grantedAt: 1, acknowledgement: G::GrantRetained }, { grantKey: "grant1", grantedAt: 2, acknowledgement: G::GrantWriteFailed }, { grantKey: "grant2", grantedAt: 2, acknowledgement: G::GrantRetained })
pure val weight_approve = 4
pure val weight_readApproval = 4
pure val weight_grant = 4
pure val weight_consume = 4
```

### Fair I/O settlement releases each captured approval

Oldest unfinished selection is a fair service abstraction: each actual approval may advance independently, and the selected action is a witness that an older unresolved await is not starved by later calls. A settled lookup, grant or delete may fail. Successful retry remains conditional on the caller making a new matching request while the code remains eligible and storage eventually accepting both operations; the service does not retry by itself.

```quint
pure def approvalPending(phase: ApprovalPhase): bool = phase == ApprovalReading or phase == ApprovalGranting or phase == ApprovalConsuming
pure def oldestApproval(s: ApprovalState): Approval = s.attempts.select(attempt => approvalPending(attempt.phase)).nthOr(0, noAttempt)
pure def canAdvanceApproval(s: ApprovalState, grantInput: GrantAttempt): bool = {
  val id = oldestApproval(s).id
  canReadApproval(s, id) or canGrant(s, id, grantInput) or canConsume(s, id)
}
pure def advanceApproval(s: ApprovalState, grantInput: GrantAttempt, readAt: int, success: bool): ApprovalState = {
  val id = oldestApproval(s).id
  if (canReadApproval(s, id)) readApproval(s, id, readAt, success)
  else if (canGrant(s, id, grantInput)) grant(s, id, grantInput)
  else consume(s, id, success)
}
pure val fair_advanceApproval = "weak"
pure val fair_enterAdmission = "weak"
pure val fair_readPending = "weak"
pure val fair_writePending = "weak"
pure val fair_rejectFull = "weak"
pure def leadsToQueuedAdmissionsSettle(s: ApprovalState, later: ApprovalState): bool = R::leadsToQueuedAdmissionsSettle(s.requests, later.requests) and R::leadsToAdmissionReleased(s.requests, later.requests)
pure def leadsToOwnedApprovalsSettle(s: ApprovalState, later: ApprovalState): bool = s.attempts.every(attempt => not(approvalPending(attempt.phase)) or not(approvalPending(getAttempt(later, attempt.id).phase)))
```
