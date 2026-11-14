# Provider capability dispatch authority

The baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`, `packages/core/src/types/provider-integrations.ts`. Policy and confirmation authority are consumed atomically against the exact request and current account snapshot. An authorized request is an immutable in-process object registered in a private WeakSet. Its symbol and serialized fields alone cannot recreate that identity. `TrustedAuthority` represents possession of the host-installed authority and is supplied independently of decoded event payloads. Opaque digest inputs are computed by the canonical hashing boundary. This machine owns their exact binding and consumption.

## Story: Dispatch only after current policy authority is consumed once

As a provider adapter, I receive an exact account-bound request whose policy and optional confirmation were consumed together. A competing caller, stale account snapshot, expired policy or changed request cannot create another authorized object. A policy which expires during consumption remains consumed and reports failure.

### Policy registration binds every request field and its issue time

```quint
type AuthorityCaller = TrustedAuthority | ExternalCaller
type CapabilityRequest = { requestDigest: str, accountId: str, capabilityId: str, operation: str, inputDigest: str, risk: int, boundAt: int }
type CapabilityPolicy = { decisionId: str, decisionDigest: str, requestDigest: str, risk: int, issuedAt: int, expiresAt: int, confirmationRequired: bool, confirmationId: str }
type CapabilityGrant = { confirmationId: str, grantDigest: str, decisionId: str, requestDigest: str, confirmedAt: int, expiresAt: int }
type CapabilityBindings = { authorizationId: str, policyDecisionId: str, policyDecisionDigest: str, confirmationId: str, confirmationGrantDigest: str, requestDigest: str, accountId: str, capabilityId: str, operation: str, inputDigest: str }
type CapabilityEffectKind = AppliedEffect | PreviewEffect | NoopEffect | FailedEffect | RollbackEffect
type CapabilityReceipt = { bindings: CapabilityBindings, effectOperation: str, idempotencyKey: str, kind: CapabilityEffectKind, observedAt: int, committedAt: int, rolledBackAt: int }
type AuthorityPhase = Empty | Registered | Confirmed | Consuming | Consumed | Authorized | Rejected
pure val emptyRequest: CapabilityRequest = { requestDigest: "", accountId: "", capabilityId: "", operation: "", inputDigest: "", risk: 0, boundAt: 0 }
pure val emptyPolicy: CapabilityPolicy = { decisionId: "", decisionDigest: "", requestDigest: "", risk: 0, issuedAt: 0, expiresAt: 0, confirmationRequired: false, confirmationId: "" }
pure val emptyGrant: CapabilityGrant = { confirmationId: "", grantDigest: "", decisionId: "", requestDigest: "", confirmedAt: 0, expiresAt: 0 }
pure val emptyBindings: CapabilityBindings = { authorizationId: "", policyDecisionId: "", policyDecisionDigest: "", confirmationId: "", confirmationGrantDigest: "", requestDigest: "", accountId: "", capabilityId: "", operation: "", inputDigest: "" }
pure val emptyReceipt: CapabilityReceipt = { bindings: emptyBindings, effectOperation: "", idempotencyKey: "", kind: NoopEffect, observedAt: 0, committedAt: 0, rolledBackAt: 0 }
type Authority = { phase: AuthorityPhase, request: CapabilityRequest, policy: CapabilityPolicy, grant: CapabilityGrant, grantPresent: bool, authorizationId: str, authorizedAt: int, now: int, startedAt: int, accountRevision: int, boundRevision: int, decisionConsumed: bool, nextObject: int, originalObject: int, candidateObject: int, authenticObjects: Set[int], lastReceipt: CapabilityReceipt, validatedAt: int, receiptAccepted: bool }
pure val initial: Authority = { phase: Empty, request: emptyRequest, policy: emptyPolicy, grant: emptyGrant, grantPresent: false, authorizationId: "", authorizedAt: 0, now: 0, startedAt: 0, accountRevision: 0, boundRevision: 0, decisionConsumed: false, nextObject: 1, originalObject: 0, candidateObject: 0, authenticObjects: Set(), lastReceipt: emptyReceipt, validatedAt: 0, receiptAccepted: false }
pure val byValues = Set(TrustedAuthority, ExternalCaller)
pure val requestValues = Set({ requestDigest: "digestA", accountId: "account1", capabilityId: "send", operation: "send", inputDigest: "inputA", risk: 1, boundAt: 0 }, { requestDigest: "digestB", accountId: "account2", capabilityId: "read", operation: "read", inputDigest: "inputB", risk: 0, boundAt: 0 })
pure val policyValues = Set({ decisionId: "decision1", decisionDigest: "decisionDigest1", requestDigest: "digestA", risk: 1, issuedAt: 0, expiresAt: 10, confirmationRequired: false, confirmationId: "" }, { decisionId: "decision2", decisionDigest: "decisionDigest2", requestDigest: "digestA", risk: 1, issuedAt: 0, expiresAt: 10, confirmationRequired: true, confirmationId: "confirmation1" })
pure val grantValues = Set(emptyGrant, { confirmationId: "confirmation1", grantDigest: "grantDigest1", decisionId: "decision2", requestDigest: "digestA", confirmedAt: 0, expiresAt: 10 }, { confirmationId: "confirmation1", grantDigest: "grantDigest1", decisionId: "decision2", requestDigest: "digestA", confirmedAt: 6, expiresAt: 10 })
pure val authorizationIdValues = Set("authorization1", "authorization2")
pure val nowValues = Set(0, 1, 6, 11)
pure def wellFormedRequest(request: CapabilityRequest): bool = request.requestDigest != "" and request.accountId != "" and request.capabilityId != "" and request.operation != "" and request.inputDigest != "" and request.risk >= 0 and request.risk <= 3 and request.boundAt >= 0
pure def policyMatches(request: CapabilityRequest, policy: CapabilityPolicy, now: int): bool = policy.decisionId != "" and policy.decisionDigest != "" and policy.requestDigest == request.requestDigest and policy.risk == request.risk and policy.issuedAt >= request.boundAt and policy.issuedAt <= now and policy.expiresAt > now and (if (policy.confirmationRequired) policy.confirmationId != "" else policy.confirmationId == "")
pure def canRegister(s: Authority, by: AuthorityCaller, request: CapabilityRequest, policy: CapabilityPolicy): bool = by == TrustedAuthority and s.phase == Empty and wellFormedRequest(request) and policyMatches(request, policy, s.now)
pure def register(s: Authority, by: AuthorityCaller, request: CapabilityRequest, policy: CapabilityPolicy): Authority = { ...s, phase: Registered, request: request, policy: policy, boundRevision: s.accountRevision }
pure def canAccountChanges(s: Authority, by: AuthorityCaller): bool = by == TrustedAuthority
pure def accountChanges(s: Authority, by: AuthorityCaller): Authority = { ...s, accountRevision: s.accountRevision + 1 }
pure def canSetClock(s: Authority, by: AuthorityCaller, now: int): bool = by == TrustedAuthority and now >= 0
pure def setClock(s: Authority, by: AuthorityCaller, now: int): Authority = { ...s, now: now }
```

### Confirmation and consumption compare their full immutable records

Discovered by the proof: every consuming, consumed, authorized or rejected dispatch already owns a consumed policy decision. This records the transition fact needed to prove that later object minting cannot precede consumption.

The confirmation grant names this decision, request and confirmation ID. At issue time, its confirmation time lies between the decision and the current clock. Later consumption checks expiry and the stored grant without rechecking that upper bound: a wall-clock rewind can leave a previously issued confirmation in the apparent future. Consumption compares the complete request, policy and stored grant, then removes the current authority in one operation. Account freshness is checked in the same operation.

```quint
pure def grantMatches(request: CapabilityRequest, policy: CapabilityPolicy, grant: CapabilityGrant, now: int): bool = grant.confirmationId == policy.confirmationId and grant.decisionId == policy.decisionId and grant.requestDigest == request.requestDigest and grant.grantDigest != "" and grant.confirmedAt >= policy.issuedAt and grant.expiresAt == policy.expiresAt and grant.expiresAt > now
pure def canConfirm(s: Authority, by: AuthorityCaller, grant: CapabilityGrant): bool = by == TrustedAuthority and s.phase == Registered and s.policy.confirmationRequired and grantMatches(s.request, s.policy, grant, s.now) and grant.confirmedAt <= s.now
pure def confirm(s: Authority, by: AuthorityCaller, grant: CapabilityGrant): Authority = { ...s, phase: Confirmed, grantPresent: true, grant: grant }
pure def canConsume(s: Authority, by: AuthorityCaller, request: CapabilityRequest, policy: CapabilityPolicy, grant: CapabilityGrant): bool = by == TrustedAuthority and (s.phase == Registered or s.phase == Confirmed) and not(s.decisionConsumed) and request == s.request and policy == s.policy and s.boundRevision == s.accountRevision and policyMatches(request, policy, s.now) and (if (policy.confirmationRequired) s.grantPresent and grant == s.grant and grantMatches(request, policy, grant, s.now) else grant == emptyGrant)
pure def consume(s: Authority, by: AuthorityCaller, request: CapabilityRequest, policy: CapabilityPolicy, grant: CapabilityGrant): Authority = { ...s, phase: Consuming, decisionConsumed: true, startedAt: s.now }
pure def canRejectStaleSnapshot(s: Authority, by: AuthorityCaller): bool = s.boundRevision != s.accountRevision and canConsume({ ...s, accountRevision: s.boundRevision }, by, s.request, s.policy, if (s.grantPresent) s.grant else emptyGrant)
pure def rejectStaleSnapshot(s: Authority, by: AuthorityCaller): Authority = { ...s, phase: Rejected, decisionConsumed: true }
pure def canFinishAuthorization(s: Authority, by: AuthorityCaller, authorizationId: str): bool = by == TrustedAuthority and s.phase == Consuming and authorizationId != ""
pure def finishAuthorization(s: Authority, by: AuthorityCaller, authorizationId: str): Authority =
  if (s.now >= s.startedAt and s.now < s.policy.expiresAt and (not(s.grantPresent) or s.now < s.grant.expiresAt)) { ...s, phase: Authorized, authorizationId: authorizationId, authorizedAt: s.now, originalObject: s.nextObject, candidateObject: s.nextObject, authenticObjects: s.authenticObjects.union(Set(s.nextObject)), nextObject: s.nextObject + 1 }
  else { ...s, phase: Consumed }
pure def alwaysObjectNumbersAreValid(s: Authority): bool = s.nextObject >= 1 and s.originalObject >= 0 and s.candidateObject >= 0 and s.originalObject < s.nextObject and s.candidateObject < s.nextObject
pure def alwaysAuthenticObjectIsOriginal(s: Authority): bool = s.authenticObjects.forall(reference => reference == s.originalObject and reference > 0)
pure def alwaysOnlyAuthorizedPhaseHoldsObjects(s: Authority): bool = (s.phase == Authorized) == (s.authenticObjects.size() > 0)
pure def alwaysDispatchPhasesHaveConsumedPolicy(s: Authority): bool = (s.phase == Consuming or s.phase == Consumed or s.phase == Authorized or s.phase == Rejected) implies s.decisionConsumed
pure def alwaysMintRequiresConsumedPolicy(s: Authority): bool = s.authenticObjects.size() == 0 or s.decisionConsumed
pure def alwaysAtMostOneAuthorizedObject(s: Authority): bool = s.authenticObjects.size() <= 1
pure def sometimesExpiryAfterConsume(s: Authority): bool = s.phase == Consumed and s.decisionConsumed and s.authenticObjects.size() == 0
pure def sometimesConsumeAfterClockRewind(s: Authority): bool = s.grantPresent and (s.phase == Consuming or s.phase == Consumed or s.phase == Authorized) and s.startedAt < s.grant.confirmedAt
```

## Story: Reject copied authority while checking an exact effect receipt

As a caller, I can normalize multiple receipts against the original authorized object. Serialized or spread copies lack its WeakSet identity. Each receipt binds authorization ID, policy ID and digest, optional confirmation ID and digest, request digest, account, capability, operation and input digest. The effect's operation and idempotency key must independently match. Observed, commit and rollback times are checked against the actual post-consumption authorization time.

### Every receipt field equals the recorded authorization field

```quint
pure def boundFields(s: Authority): CapabilityBindings = { authorizationId: s.authorizationId, policyDecisionId: s.policy.decisionId, policyDecisionDigest: s.policy.decisionDigest, confirmationId: if (s.grantPresent) s.grant.confirmationId else "", confirmationGrantDigest: if (s.grantPresent) s.grant.grantDigest else "", requestDigest: s.request.requestDigest, accountId: s.request.accountId, capabilityId: s.request.capabilityId, operation: s.request.operation, inputDigest: s.request.inputDigest }
pure def receiptMatches(s: Authority, receipt: CapabilityReceipt, checkedAt: int): bool = receipt.bindings == boundFields(s) and receipt.effectOperation == s.request.operation and receipt.idempotencyKey == s.request.requestDigest and receipt.observedAt >= s.authorizedAt and receipt.observedAt <= checkedAt and (receipt.kind != AppliedEffect or (receipt.committedAt >= s.authorizedAt and receipt.committedAt <= receipt.observedAt)) and (receipt.kind != RollbackEffect or (receipt.rolledBackAt >= s.authorizedAt and receipt.rolledBackAt <= receipt.observedAt))
pure val receiptValues = Set(emptyReceipt, { bindings: { authorizationId: "authorization1", policyDecisionId: "decision1", policyDecisionDigest: "decisionDigest1", confirmationId: "", confirmationGrantDigest: "", requestDigest: "digestA", accountId: "account1", capabilityId: "send", operation: "send", inputDigest: "inputA" }, effectOperation: "send", idempotencyKey: "digestA", kind: AppliedEffect, observedAt: 1, committedAt: 1, rolledBackAt: 0 }, { bindings: { authorizationId: "authorization1", policyDecisionId: "decision1", policyDecisionDigest: "decisionDigest1", confirmationId: "", confirmationGrantDigest: "", requestDigest: "digestA", accountId: "wrong-account", capabilityId: "send", operation: "send", inputDigest: "inputA" }, effectOperation: "send", idempotencyKey: "digestA", kind: AppliedEffect, observedAt: 1, committedAt: 1, rolledBackAt: 0 })
pure def canCloneFields(s: Authority): bool = s.originalObject > 0
pure def cloneFields(s: Authority): Authority = { ...s, candidateObject: s.nextObject, nextObject: s.nextObject + 1, receiptAccepted: false }
pure def canUseOriginal(s: Authority, by: AuthorityCaller): bool = by == TrustedAuthority and s.originalObject > 0
pure def useOriginal(s: Authority, by: AuthorityCaller): Authority = { ...s, candidateObject: s.originalObject, receiptAccepted: false }
pure def validateReceipt(s: Authority, receipt: CapabilityReceipt): Authority = { ...s, lastReceipt: receipt, validatedAt: s.now, receiptAccepted: s.authenticObjects.contains(s.candidateObject) and receiptMatches(s, receipt, s.now) }
pure def alwaysReceiptUsesAuthenticIdentity(s: Authority): bool = s.receiptAccepted implies s.authenticObjects.contains(s.candidateObject)
pure def alwaysAcceptedReceiptHasExactBindings(s: Authority): bool = s.receiptAccepted implies receiptMatches(s, s.lastReceipt, s.validatedAt)
pure def sometimesOriginalReceiptAccepted(s: Authority): bool = s.receiptAccepted
pure def sometimesCopiedFieldsRejected(s: Authority): bool = s.originalObject > 0 and s.candidateObject != s.originalObject and not(s.receiptAccepted)
```

### External event payloads cannot issue or consume host authority

```quint
pure def lawExternalCannotIssue(s: Authority, request: CapabilityRequest, policy: CapabilityPolicy): bool = not(canRegister(s, ExternalCaller, request, policy))
pure def lawExternalCannotConsume(s: Authority, request: CapabilityRequest, policy: CapabilityPolicy, grant: CapabilityGrant): bool = not(canConsume(s, ExternalCaller, request, policy, grant))
```
