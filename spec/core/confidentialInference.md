# Confidential inference transport admission

The source is `packages/core/src/security/confidential-inference.ts` at `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. A runtime call owns one ConfidentialInferenceOperation across SDK retries and provider failover. The authority pins trusted handler identities and current host policy. Each actual HTTP attempt matches an exact endpoint, wire model and model type, disables redirects, and persists its dispatch audit before egress. Audit records contain metadata rather than request payloads.

## Story: Use only an approved route with durable dispatch evidence

As an operator, I can require confidential inference to use exact host-approved handlers, routes and connection evidence. The policy is checked before and after audit persistence. An authorization consumed under deny-after-authorization remains consumed across failures and retries.

### An attempt captures approved route and handler identity

```quint
type ConfidentialPhase = Idle | Checking | Auditing | Rechecking | Admitted | Transporting | RecordingOutcome | Succeeded | Failed
type Confidential = { phase: ConfidentialPhase, policyRevision: int, capturedRevision: int, approvedHandlers: Set[int], operationConsumed: bool, denyRedispatch: bool, callbackEntered: bool, dispatchAudit: bool, outcomeAudit: bool, dispatched: bool, dispatches: int, redirect: bool, successfulResponse: bool }
pure val initial: Confidential = { phase: Idle, policyRevision: 0, capturedRevision: 0, approvedHandlers: Set(), operationConsumed: false, denyRedispatch: false, callbackEntered: false, dispatchAudit: false, outcomeAudit: false, dispatched: false, dispatches: 0, redirect: false, successfulResponse: false }
pure val handlersValues = Set(Set(1), Set(1, 2))
pure val handlerValues = Set(0, 1, 2)
pure def canConfigure(s: Confidential, handlers: Set[int], denyRedispatch: bool): bool = s.phase == Idle and s.dispatches == 0 and not(s.operationConsumed) and not(s.callbackEntered)
pure def configure(s: Confidential, handlers: Set[int], denyRedispatch: bool): Confidential = { ...s, approvedHandlers: handlers, denyRedispatch: denyRedispatch }
pure def canBegin(s: Confidential, handler: int, routeMatches: bool, profileCurrent: bool, requestValid: bool): bool = (s.phase == Idle or s.phase == Failed or s.phase == Succeeded) and s.approvedHandlers.contains(handler) and routeMatches and profileCurrent and requestValid
pure def begin(s: Confidential, handler: int, routeMatches: bool, profileCurrent: bool, requestValid: bool): Confidential = { ...s, phase: Checking, capturedRevision: s.policyRevision, callbackEntered: false, dispatchAudit: false, outcomeAudit: false, dispatched: false, redirect: false, successfulResponse: false }
pure def policyChanges(s: Confidential): Confidential = { ...s, policyRevision: s.policyRevision + 1 }
```

### A transport callback can authorize its attempt only once

Connection evidence is validated by the trusted transport. The consumed operation latch is set before the policy and audit awaits, preserving the source's retry behavior when either later check fails.
Discovered by the proof: the dispatch stage retains both the consumed authorization and the acknowledged dispatch audit. No transport outcome can be recorded before dispatch, and a redirected response cannot count as successful.

```quint
pure def canBeforeDispatch(s: Confidential, evidenceValid: bool): bool = s.phase == Checking and not(s.callbackEntered)
pure def beforeDispatch(s: Confidential, evidenceValid: bool): Confidential =
  if (not(evidenceValid) or (s.denyRedispatch and s.operationConsumed)) { ...s, callbackEntered: true, phase: Failed }
  else { ...s, callbackEntered: true, operationConsumed: s.operationConsumed or s.denyRedispatch, phase: if (s.policyRevision == s.capturedRevision) Auditing else Failed }
pure def canRecordDispatchAudit(s: Confidential, acknowledged: bool): bool = s.phase == Auditing
pure def recordDispatchAudit(s: Confidential, acknowledged: bool): Confidential = { ...s, dispatchAudit: acknowledged, phase: if (acknowledged) Rechecking else Failed }
pure def canRecheckPolicy(s: Confidential): bool = s.phase == Rechecking
pure def recheckPolicy(s: Confidential): Confidential = { ...s, phase: if (s.policyRevision == s.capturedRevision) Admitted else Failed }
pure def canDispatch(s: Confidential): bool = s.phase == Admitted and s.dispatchAudit
pure def dispatch(s: Confidential): Confidential = { ...s, phase: Transporting, dispatched: true, dispatches: s.dispatches + 1 }
pure def alwaysConfidentialCountersAreValid(s: Confidential): bool = s.policyRevision >= 0 and s.capturedRevision >= 0 and s.capturedRevision <= s.policyRevision and s.dispatches >= 0
pure def alwaysDispatchHasIntentAudit(s: Confidential): bool = s.dispatched implies s.dispatchAudit
pure def alwaysDenyRedispatchOwnsAtMostOne(s: Confidential): bool = not(s.denyRedispatch) or s.dispatches <= 1
pure def alwaysDispatchStageRemembersAuthorization(s: Confidential): bool = (s.dispatched implies s.dispatches > 0) and ((s.phase == Checking or s.phase == Auditing or s.phase == Rechecking or s.phase == Admitted) implies not(s.dispatched)) and (s.denyRedispatch and (s.phase == Auditing or s.phase == Rechecking or s.phase == Admitted or s.dispatches > 0) implies s.operationConsumed) and (s.denyRedispatch and (s.phase == Auditing or s.phase == Rechecking or s.phase == Admitted) implies s.dispatches == 0)
```

### A response escapes only after its outcome audit and redirects fail closed

Response headers do not certify completion of a streaming body. A mandatory outcome-audit failure disposes the response body and reports a sanitized error. This state models release of headers, with subsequent body streaming owned by the stream model.

```quint
pure def canReceiveTransport(s: Confidential, success: bool, redirected: bool): bool = s.phase == Transporting
pure def receiveTransport(s: Confidential, success: bool, redirected: bool): Confidential = { ...s, redirect: redirected, successfulResponse: success and not(redirected), phase: RecordingOutcome }
pure def canRecordOutcome(s: Confidential, acknowledged: bool): bool = s.phase == RecordingOutcome
pure def recordOutcome(s: Confidential, acknowledged: bool): Confidential = { ...s, outcomeAudit: acknowledged, phase: if (acknowledged and s.successfulResponse) Succeeded else Failed }
pure def alwaysSuccessfulResponseHasBothAudits(s: Confidential): bool = s.phase != Succeeded or (s.dispatchAudit and s.outcomeAudit and s.dispatched and not(s.redirect))
pure def alwaysOutcomeTracksTransport(s: Confidential): bool = ((s.phase == Transporting or s.phase == RecordingOutcome) implies s.dispatched) and (s.successfulResponse implies not(s.redirect))
pure def stepOperationLatchNeverResets(before: Confidential, after: Confidential): bool = not(before.operationConsumed) or after.operationConsumed
pure def sometimesConfidentialResponse(s: Confidential): bool = s.phase == Succeeded
pure def sometimesAuditFailureRetainsConsumption(s: Confidential): bool = s.phase == Failed and s.operationConsumed and not(s.dispatchAudit)
pure val fair_beforeDispatch = "weak"
pure val fair_recordDispatchAudit = "weak"
pure val fair_recheckPolicy = "weak"
pure val fair_dispatch = "weak"
pure val fair_receiveTransport = "weak"
pure val fair_recordOutcome = "weak"
pure def leadsToAttemptFinishes(s: Confidential, later: Confidential): bool = (s.phase != Idle and s.phase != Succeeded and s.phase != Failed) implies (later.phase == Succeeded or later.phase == Failed)
```
