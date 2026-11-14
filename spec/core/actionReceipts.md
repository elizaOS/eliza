# Action settlement with concrete receipt bindings

Sources are `packages/core/src/runtime/action-handler-settlement.ts:195-260,300-570`, `runtime/effect-delivery.ts` and `types/effects.ts:575-677` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. This composition uses the settlement machine for the serialized callback queue and the receipt module's committed-evidence predicate. Queue processing, actual callback invocation and confirmation are separate facts.


Discovered by the proof: each embedded machine must retain its complete safety
invariant before the composition can rely on that machine's transition lemmas.

## Story: Drain action callbacks with exact receipt evidence

As a caller I receive each eligible canonical callback after result normalization. A preview, failure or ordinary no-op can produce an informational reply without claiming application. Duplicate mutation callbacks share a delivery key, including failed transport attempts, and never invoke the same canonical delivery twice.

### Callback binding resolves every declared ID against retained receipts

The boundary supplies normalized text and receipt records. Normalization rejects conflicting duplicate receipt IDs and malformed evidence before this transition. The result's verified flag is core-normalized provenance, not a model-authored assertion. The queue uses its nonmutation mode because this composition owns the richer per-callback receipt gate.

Once the host closes callback emission, the list of accepted callback identities is fixed. Earlier emissions hand off in order. Transport settlement addresses the exact sending callback. A fair scheduler witness uses the recorded in-flight identity, so an otherwise valid callback ID outside the simulation examples can also finish. The transport may acknowledge success or failure, and the core may suppress a policy-ineligible callback.

```quint
import execution as Q from "./execution"
import receipts as R from "./receipts"
type NamedReceipt = {id: str, receipt: R::Receipt}
type CallbackPhase = CallbackQueued | CallbackSending | CallbackSuppressed | CallbackDelivered | CallbackFailed
type ActionCallback = {id: int, actionName: str, text: str, suppliedIds: List[str], phase: CallbackPhase, boundIds: List[str], coreBound: bool, applied: bool, visibleText: str, visibleIds: List[str], confirms: bool}
type DeliveryKey = {actionName: str, text: str, ids: List[str]}
type ActionReceipts = {queue: Q::Settlement, actionName: str, mutation: bool, verified: bool, canonicalText: str, receipts: List[NamedReceipt], selectedIds: List[str], callbacks: List[ActionCallback], keys: List[DeliveryKey]}
pure val initial: ActionReceipts = {queue: Q::initial, actionName: "", mutation: false, verified: false, canonicalText: "", receipts: List(), selectedIds: List(), callbacks: List(), keys: List()}
pure val actionNameValues = Set("", "WRITE", "OTHER")
pure val textValues = Set("", "complete canonical text", "changed text")
pure val canonicalTextValues = textValues
pure val visibleTextValues = textValues
pure val selectedIdsValues = Set(List(), List("receipt-a"), List("missing"))
pure val suppliedIdsValues = selectedIdsValues
pure val visibleIdsValues = selectedIdsValues
pure val receiptsValues = Set(List(), List({id: "receipt-a", receipt: {receiptKind: R::Applied, durable: true, providerAccepted: false, hasKey: true, replayed: false, reverted: false}}), List({id: "receipt-a", receipt: {receiptKind: R::Preview, durable: false, providerAccepted: false, hasKey: false, replayed: false, reverted: false}}))
pure val callbackIdValues = Set(1, 2, 3)
pure val resultKindValues = Set(Q::ValidResult, Q::InvalidResult, Q::ThrownResult, Q::ReplyFailure)
pure def canAdmitAction(s: ActionReceipts, allowed: bool, mutation: bool, actionName: str): bool = Q::canAdmitAction(s.queue, allowed, false)
pure def admitAction(s: ActionReceipts, allowed: bool, mutation: bool, actionName: str): ActionReceipts = { ...s, queue: Q::admitAction(s.queue, allowed, false), mutation: mutation, actionName: actionName }
pure def canEmitCallback(s: ActionReceipts, callbackId: int, actionName: str, text: str, suppliedIds: List[str]): bool = Q::canEmitCallback(s.queue) and callbackId > 0 and not(s.callbacks.some(c => c.id == callbackId))
pure def emitCallback(s: ActionReceipts, callbackId: int, actionName: str, text: str, suppliedIds: List[str]): ActionReceipts = { ...s, queue: Q::emitCallback(s.queue), callbacks: s.callbacks.append({id: callbackId, actionName: if (actionName == "") s.actionName else actionName, text: text, suppliedIds: suppliedIds, phase: CallbackQueued, boundIds: List(), coreBound: false, applied: false, visibleText: text, visibleIds: List(), confirms: false}) }
pure def normalizedReceipts(receipts: List[NamedReceipt]): bool = receipts.every(r => r.id != "" and receipts.select(other => other.id == r.id).length() == 1)
pure def canReturnAction(s: ActionReceipts, resultKind: Q::HandlerOutcome, verified: bool, canonicalText: str, receipts: List[NamedReceipt], selectedIds: List[str]): bool = Q::canReturnHandler(s.queue, resultKind, false, false) and normalizedReceipts(receipts)
pure def returnAction(s: ActionReceipts, resultKind: Q::HandlerOutcome, verified: bool, canonicalText: str, receipts: List[NamedReceipt], selectedIds: List[str]): ActionReceipts = { ...s, queue: Q::returnHandler(s.queue, resultKind, false, false), verified: verified, canonicalText: canonicalText, receipts: receipts, selectedIds: selectedIds }
pure def canSettleAction(s: ActionReceipts): bool = Q::canSettleHandler(s.queue)
pure def settleAction(s: ActionReceipts): ActionReceipts = { ...s, queue: Q::settleHandler(s.queue) }
pure def bindingResolved(s: ActionReceipts): bool = s.verified and s.canonicalText != "" and s.selectedIds.length() > 0 and s.selectedIds.every(id => s.receipts.some(r => r.id == id))
pure def bindingApplied(s: ActionReceipts): bool = bindingResolved(s) and s.selectedIds.every(id => s.receipts.some(r => r.id == id and R::committedReceipt(r.receipt)))
pure val noCallback: ActionCallback = {id: 0, actionName: "", text: "", suppliedIds: List(), phase: CallbackSuppressed, boundIds: List(), coreBound: false, applied: false, visibleText: "", visibleIds: List(), confirms: false}
pure def nextCallback(s: ActionReceipts): ActionCallback = s.callbacks.nthOr(s.queue.delivered, noCallback)
pure def canProcessCallback(s: ActionReceipts): bool = Q::canDeliverCallback(s.queue) and nextCallback(s).id != 0
pure def processCallback(s: ActionReceipts): ActionReceipts = {
  val c = nextCallback(s)
  val key = {actionName: c.actionName, text: s.canonicalText, ids: s.selectedIds}
  val bound = s.mutation and bindingResolved(s) and c.text == s.canonicalText
  val invoke = not(s.mutation) or (bound and not(s.keys.includes(key)))
  { ...s, queue: Q::deliverCallback(s.queue), keys: if (invoke and s.mutation) s.keys.append(key) else s.keys, callbacks: s.callbacks.listMap(other => if (other.id == c.id) { ...other, phase: if (invoke) CallbackSending else CallbackSuppressed, boundIds: if (bound and invoke) s.selectedIds else List(), coreBound: bound and invoke, applied: bound and invoke and bindingApplied(s), visibleIds: if (bound and invoke) s.selectedIds else List() } else other) }
}
pure def canFinishSuppressed(s: ActionReceipts): bool = s.queue.busy and s.callbacks.some(c => c.phase == CallbackSuppressed and s.callbacks.nthOr(s.queue.delivered - 1, noCallback).id == c.id)
pure def finishSuppressed(s: ActionReceipts): ActionReceipts = { ...s, queue: Q::settleTransport(s.queue, true) }
pure def canTransformCallback(s: ActionReceipts, callbackId: int, visibleText: str, visibleIds: List[str]): bool = s.callbacks.some(c => c.id == callbackId and c.phase == CallbackSending)
pure def transformCallback(s: ActionReceipts, callbackId: int, visibleText: str, visibleIds: List[str]): ActionReceipts = { ...s, callbacks: s.callbacks.listMap(c => if (c.id == callbackId) { ...c, visibleText: visibleText, visibleIds: visibleIds } else c) }
pure def canAcknowledgeCallback(s: ActionReceipts, callbackId: int, accepted: bool): bool = s.queue.busy and s.callbacks.some(c => c.id == callbackId and c.phase == CallbackSending)
pure def acknowledgeCallback(s: ActionReceipts, callbackId: int, accepted: bool): ActionReceipts = { ...s, queue: Q::settleTransport(s.queue, accepted), callbacks: s.callbacks.listMap(c => if (c.id == callbackId) { ...c, phase: if (accepted) CallbackDelivered else CallbackFailed, confirms: accepted and c.coreBound and c.applied and c.visibleText == s.canonicalText and c.visibleIds == c.boundIds } else c) }
pure def canReturnSettlement(s: ActionReceipts): bool = Q::canReturnSettlement(s.queue)
pure def returnSettlement(s: ActionReceipts): ActionReceipts = { ...s, queue: Q::returnSettlement(s.queue) }
pure def canFinishCallbackSource(s: ActionReceipts): bool = Q::canFinishCallbackSource(s.queue)
pure def finishCallbackSource(s: ActionReceipts): ActionReceipts = { ...s, queue: Q::finishCallbackSource(s.queue) }
pure def alwaysSettlementRules(s: ActionReceipts): bool = Q::alwaysSettledResultValid(s.queue) and Q::alwaysNoDeliveryBeforeSettlement(s.queue) and Q::alwaysFailureSuppressesCallbacks(s.queue) and Q::alwaysDeliveryBoundedByEmission(s.queue) and Q::alwaysMutationCallbackGrounded(s.queue) and Q::alwaysDeliveryAccounting(s.queue) and Q::alwaysSettlementDeadlockFree(s.queue)
pure def alwaysCallbackQueueAgrees(s: ActionReceipts): bool = s.callbacks.length() == s.queue.emitted and s.queue.delivered <= s.callbacks.length() and s.callbacks.select(c => c.phase == CallbackSending).length() <= 1
pure def alwaysConfirmationGrounded(s: ActionReceipts): bool = s.callbacks.every(c => c.confirms implies c.phase == CallbackDelivered and c.coreBound and c.applied and c.visibleText == s.canonicalText and c.visibleIds == c.boundIds and bindingApplied(s))
pure def alwaysMutationInvocationBound(s: ActionReceipts): bool = s.mutation implies s.callbacks.every(c => c.phase == CallbackSending or c.phase == CallbackDelivered or c.phase == CallbackFailed implies c.coreBound and c.text == s.canonicalText and c.boundIds == s.selectedIds)
pure def alwaysDeliveryKeysUnique(s: ActionReceipts): bool = s.keys.every(key => s.keys.select(other => other == key).length() == 1)
pure def sometimesPreviewDeliveredWithoutClaim(s: ActionReceipts): bool = s.callbacks.some(c => c.phase == CallbackDelivered and c.coreBound and not(c.applied) and not(c.confirms))
pure def sometimesForgedIdsDiscarded(s: ActionReceipts): bool = s.callbacks.some(c => c.coreBound and c.suppliedIds != c.boundIds)
pure def sometimesDuplicateSuppressed(s: ActionReceipts): bool = s.keys.length() > 0 and s.callbacks.some(c => c.phase == CallbackSuppressed)
pure val fair_processCallback = "weak"
pure val fair_finishSuppressed = "weak"
pure def sendingCallback(s: ActionReceipts): int = s.callbacks.nthOr(s.queue.delivered - 1, noCallback).id
pure def canAcknowledgeNextCallback(s: ActionReceipts, accepted: bool): bool = canAcknowledgeCallback(s, sendingCallback(s), accepted)
pure def acknowledgeNextCallback(s: ActionReceipts, accepted: bool): ActionReceipts = acknowledgeCallback(s, sendingCallback(s), accepted)
pure val fair_acknowledgeNextCallback = "weak"
pure val fair_settleAction = "weak"
pure val fair_returnSettlement = "weak"
pure def callbackTerminal(c: ActionCallback): bool = c.phase == CallbackDelivered or c.phase == CallbackSuppressed or c.phase == CallbackFailed
pure def leadsToEverySealedCallbackSettles(s: ActionReceipts, later: ActionReceipts): bool =
  s.queue.callbacksClosed and s.queue.resultKind == Q::ValidResult implies s.callbacks.every(c => later.callbacks.some(other => other.id == c.id and callbackTerminal(other))) and not(later.queue.busy)
pure def leadsToClosedCallbacksProcessed(s: ActionReceipts, later: ActionReceipts): bool = s.queue.callbacksClosed and s.queue.resultKind == Q::ValidResult implies later.queue.delivered == s.queue.emitted and not(later.queue.busy)
```
