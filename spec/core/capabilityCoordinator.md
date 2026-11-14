# Shared capability authority reservations

The source is `packages/core/src/types/provider-integrations.ts:915-1101` at `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. This aggregate owns the coordinator's registered decision map and permanent decision and confirmation ID reservations. Each map value composes the per-request policy and grant state from [Capability authority](./capabilityAuthority.md). The component's `Consuming` result is transferred to the dispatch operation; live dispatch records retain the returned operations and their authorized WeakSet identities; a global object counter prevents identity collisions across operations. Each dispatch owns its later authorization-object creation and receipt normalization. Account freshness is supplied by the installed `isSnapshotCurrent` boundary, represented by invalidating every currently registered snapshot for the changed account.

## Story: Reserve identities across concurrent requests and single-use consumption

As the host, I can register independent policy decisions concurrently. A consumed, rejected or expired decision ID remains reserved for the coordinator's lifetime. Confirmation IDs are equally permanent. Two callers cannot both remove and consume the same registered decision. A malformed or expired consume attempt leaves the registered entry in place; a current-shape attempt with a stale account removes it and reports failure.

### A dynamic map composes exact per-request authority

```quint
import capabilityAuthority as A from "./capabilityAuthority"
type CoordinatorResult = NoCoordinatorResult | DecisionRegistered | GrantIssued | DispatchConsumed | SnapshotRejected
type Coordinator = { registered: List[A::Authority], reservedDecisionIds: Set[str], reservedConfirmationIds: Set[str], now: int, lastResult: CoordinatorResult, lastDecisionId: str, dispatches: List[A::Authority], nextObject: int }
pure val initial: Coordinator = { registered: List(), reservedDecisionIds: Set(), reservedConfirmationIds: Set(), now: 0, lastResult: NoCoordinatorResult, lastDecisionId: "", dispatches: List(), nextObject: 1 }
pure val byValues = A::byValues
pure val requestValues = A::requestValues
pure val policyValues = A::policyValues
pure val grantValues = A::grantValues
pure val authorizationIdValues = A::authorizationIdValues
pure val receiptValues = A::receiptValues
pure val nowValues = A::nowValues
pure val decisionIdValues = Set("decision1", "decision2", "unknown")
pure val accountIdValues = Set("account1", "account2", "unknown")
pure def lookup(c: Coordinator, decisionId: str): A::Authority = c.registered.select(authority => authority.policy.decisionId == decisionId).nthOr(0, A::initial)
pure def dispatchAt(c: Coordinator, decisionId: str): A::Authority = c.dispatches.select(authority => authority.policy.decisionId == decisionId).nthOr(0, A::initial)
pure def replaceDispatch(authority: A::Authority, c: Coordinator): Coordinator = { ...c, dispatches: c.dispatches.listMap(existing => if (existing.policy.decisionId == authority.policy.decisionId) authority else existing) }
pure def canRegister(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy): bool = A::canRegister({ ...A::initial, now: c.now }, by, request, policy) and not(c.reservedDecisionIds.contains(policy.decisionId)) and (not(policy.confirmationRequired) or not(c.reservedConfirmationIds.contains(policy.confirmationId)))
pure def register(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy): Coordinator = { ...c, registered: c.registered.append(A::register({ ...A::initial, now: c.now }, by, request, policy)), reservedDecisionIds: c.reservedDecisionIds.union(Set(policy.decisionId)), reservedConfirmationIds: if (policy.confirmationRequired) c.reservedConfirmationIds.union(Set(policy.confirmationId)) else c.reservedConfirmationIds, lastResult: DecisionRegistered, lastDecisionId: policy.decisionId }
pure def canSetClock(c: Coordinator, by: A::AuthorityCaller, now: int): bool = by == A::TrustedAuthority and now >= 0
pure def setClock(c: Coordinator, by: A::AuthorityCaller, now: int): Coordinator = { ...c, now: now, registered: c.registered.listMap(authority => A::setClock(authority, by, now)), dispatches: c.dispatches.listMap(authority => A::setClock(authority, by, now)) }
pure def canInvalidateAccount(c: Coordinator, by: A::AuthorityCaller, accountId: str): bool = by == A::TrustedAuthority
pure def invalidateAccount(c: Coordinator, by: A::AuthorityCaller, accountId: str): Coordinator = { ...c, registered: c.registered.listMap(authority => if (authority.request.accountId == accountId) A::accountChanges(authority, by) else authority) }
pure def canIssueGrant(c: Coordinator, by: A::AuthorityCaller, decisionId: str, grant: A::CapabilityGrant): bool = A::canConfirm(lookup(c, decisionId), by, grant)
pure def issueGrant(c: Coordinator, by: A::AuthorityCaller, decisionId: str, grant: A::CapabilityGrant): Coordinator = { ...c, registered: c.registered.listMap(authority => if (authority.policy.decisionId == decisionId) A::confirm(authority, by, grant) else authority), lastResult: GrantIssued, lastDecisionId: decisionId }
```

### Consumption removes the exact entry before any caller can consume it again

Discovered by the proof: the registered and consumed decision domains are disjoint, and every consumed dispatch retains the embedded authority invariants. The registered components have no allocated authority objects, and the shared counter exceeds every allocated original or clone across live dispatches. These facts make one-shot removal and per-request object minting inductive under the shared registry.

A stale snapshot is checked only after the ordinary request, policy, time and grant validation succeeds. A failed shape or expiry check cannot delete a different or still-recoverable entry. The transferred component preserves its consumed state across the asynchronous dispatch continuation.

```quint
pure def dispatchShapeValid(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy, grant: A::CapabilityGrant): bool = {
  val authority = lookup(c, policy.decisionId)
  A::canConsume({ ...authority, accountRevision: authority.boundRevision }, by, request, policy, grant)
}
pure def canConsumeDecision(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy, grant: A::CapabilityGrant): bool = A::canConsume(lookup(c, policy.decisionId), by, request, policy, grant)
pure def consumeDecision(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy, grant: A::CapabilityGrant): Coordinator = { ...c, registered: c.registered.select(authority => authority.policy.decisionId != policy.decisionId), dispatches: c.dispatches.append(A::consume(lookup(c, policy.decisionId), by, request, policy, grant)), lastResult: DispatchConsumed, lastDecisionId: policy.decisionId }
pure def canRejectSnapshot(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy, grant: A::CapabilityGrant): bool = dispatchShapeValid(c, by, request, policy, grant) and A::canRejectStaleSnapshot(lookup(c, policy.decisionId), by)
pure def rejectSnapshot(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy, grant: A::CapabilityGrant): Coordinator = { ...c, registered: c.registered.select(authority => authority.policy.decisionId != policy.decisionId), dispatches: c.dispatches.append(A::rejectStaleSnapshot(lookup(c, policy.decisionId), by)), lastResult: SnapshotRejected, lastDecisionId: policy.decisionId }
pure def canFinishDispatch(c: Coordinator, by: A::AuthorityCaller, decisionId: str, authorizationId: str): bool = A::canFinishAuthorization(dispatchAt(c, decisionId), by, authorizationId)
pure def finishDispatch(c: Coordinator, by: A::AuthorityCaller, decisionId: str, authorizationId: str): Coordinator = {
  val authority = A::finishAuthorization({ ...dispatchAt(c, decisionId), nextObject: c.nextObject }, by, authorizationId)
  { ...replaceDispatch(authority, c), nextObject: if (authority.phase == A::Authorized) c.nextObject + 1 else c.nextObject }
}
pure def canCloneAuthorizedFields(c: Coordinator, decisionId: str): bool = A::canCloneFields(dispatchAt(c, decisionId))
pure def cloneAuthorizedFields(c: Coordinator, decisionId: str): Coordinator = { ...replaceDispatch(A::cloneFields({ ...dispatchAt(c, decisionId), nextObject: c.nextObject }), c), nextObject: c.nextObject + 1 }
pure def canUseAuthorizedOriginal(c: Coordinator, by: A::AuthorityCaller, decisionId: str): bool = A::canUseOriginal(dispatchAt(c, decisionId), by)
pure def useAuthorizedOriginal(c: Coordinator, by: A::AuthorityCaller, decisionId: str): Coordinator = replaceDispatch(A::useOriginal(dispatchAt(c, decisionId), by), c)
pure def canValidateDispatchReceipt(c: Coordinator, decisionId: str, receipt: A::CapabilityReceipt): bool = dispatchAt(c, decisionId).policy.decisionId != ""
pure def validateDispatchReceipt(c: Coordinator, decisionId: str, receipt: A::CapabilityReceipt): Coordinator = replaceDispatch(A::validateReceipt(dispatchAt(c, decisionId), receipt), c)
pure def alwaysRegisteredAwaitObjectMint(c: Coordinator): bool = c.registered.every(authority => authority.originalObject == 0 and authority.candidateObject == 0 and authority.nextObject == 1 and authority.authenticObjects.size() == 0 and not(authority.receiptAccepted))
pure def alwaysDispatchAllocationsUseGlobalCounter(c: Coordinator): bool = c.nextObject > 0 and c.dispatches.every(authority => authority.originalObject < c.nextObject and authority.candidateObject < c.nextObject and authority.nextObject <= c.nextObject)
pure def alwaysRegisteredAndConsumedAreDisjoint(c: Coordinator): bool = c.registered.every(authority => not(c.dispatches.some(dispatched => dispatched.policy.decisionId == authority.policy.decisionId)))
pure def alwaysDispatchesKeepAuthorityProtocol(c: Coordinator): bool = c.dispatches.every(authority => A::alwaysObjectNumbersAreValid(authority) and A::alwaysAuthenticObjectIsOriginal(authority) and A::alwaysOnlyAuthorizedPhaseHoldsObjects(authority) and A::alwaysMintRequiresConsumedPolicy(authority) and A::alwaysDispatchPhasesHaveConsumedPolicy(authority) and A::alwaysAtMostOneAuthorizedObject(authority))
pure def alwaysDispatchObjectsAreGloballyDistinct(c: Coordinator): bool = c.nextObject > 0 and c.dispatches.every(authority => authority.authenticObjects.forall(reference => reference < c.nextObject and c.dispatches.every(other => other.policy.decisionId == authority.policy.decisionId or not(other.authenticObjects.contains(reference)))))
pure def alwaysDispatchIdentitiesAreUnique(c: Coordinator): bool = c.dispatches.every(authority => authority.decisionConsumed and c.reservedDecisionIds.contains(authority.policy.decisionId) and c.dispatches.select(other => other.policy.decisionId == authority.policy.decisionId).length() == 1 and A::alwaysReceiptUsesAuthenticIdentity(authority) and A::alwaysAcceptedReceiptHasExactBindings(authority))
pure def sometimesSeveralAuthorizedDispatches(c: Coordinator): bool = c.dispatches.select(authority => authority.phase == A::Authorized).length() > 1
pure def alwaysRegisteredIdentitiesAreUnique(c: Coordinator): bool = c.registered.every(authority => authority.policy.decisionId != "" and c.registered.select(other => other.policy.decisionId == authority.policy.decisionId).length() == 1)
pure def alwaysRegisteredIdsRemainReserved(c: Coordinator): bool = c.registered.every(authority => c.reservedDecisionIds.contains(authority.policy.decisionId) and (not(authority.policy.confirmationRequired) or c.reservedConfirmationIds.contains(authority.policy.confirmationId)))
pure def alwaysMapContainsOnlyUnconsumedAuthority(c: Coordinator): bool = c.registered.every(authority => not(authority.decisionConsumed) and (authority.phase == A::Registered or authority.phase == A::Confirmed) and authority.now == c.now)
pure def alwaysTransferredAuthorityIsConsumed(c: Coordinator): bool = (c.lastResult == DispatchConsumed or c.lastResult == SnapshotRejected) implies (dispatchAt(c, c.lastDecisionId).decisionConsumed and dispatchAt(c, c.lastDecisionId).policy.decisionId == c.lastDecisionId and not(c.registered.some(authority => authority.policy.decisionId == c.lastDecisionId)))
pure def stepReservationsArePermanent(before: Coordinator, via: str, after: Coordinator): bool = before.reservedDecisionIds.subseteq(after.reservedDecisionIds) and before.reservedConfirmationIds.subseteq(after.reservedConfirmationIds)
pure def lawReservedDecisionCannotRegister(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy): bool = c.reservedDecisionIds.contains(policy.decisionId) implies not(canRegister(c, by, request, policy))
pure def lawAbsentDecisionCannotConsume(c: Coordinator, by: A::AuthorityCaller, request: A::CapabilityRequest, policy: A::CapabilityPolicy, grant: A::CapabilityGrant): bool = not(c.registered.some(authority => authority.policy.decisionId == policy.decisionId)) implies not(canConsumeDecision(c, by, request, policy, grant))
pure def sometimesConcurrentDecisions(c: Coordinator): bool = c.registered.length() > 1
pure def sometimesConsumedIdentityStaysReserved(c: Coordinator): bool = c.lastResult == DispatchConsumed and c.reservedDecisionIds.contains(c.lastDecisionId)
pure def sometimesStaleSnapshotRemoved(c: Coordinator): bool = c.lastResult == SnapshotRejected
```
