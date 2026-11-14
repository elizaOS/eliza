# Action result settlement

Callbacks are buffered until the action result settles. This model preserves emission order, transport completion, canonical receipt binding and failure separation. The delivered counter counts callbacks passed through the delivery chain; successfulDeliveries counts callbacks whose transport completed successfully. Sources include [action-handler-settlement.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/action-handler-settlement.ts), [effects.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/types/effects.ts) and [ActionSettlement.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/ActionSettlement.qnt).

## Story: Settle an action before publishing its callback

As a caller I observe only a settled authorized result, with callbacks in emission order.

### Callbacks wait for a valid admitted result

A denied action never invokes its handler. Invalid, thrown and reply-failure results suppress callback delivery.

Discovered by the proof: a settled or returned settlement already has a valid
handler result. A transport in flight owns one delivered callback that has yet
to count toward successful deliveries.

```quint
type SettlementPhase = Admission | HandlerRunning | HandlerReturned | Settled | HandlerFailed | SettlementDone
type HandlerOutcome = NoOutcome | ValidResult | InvalidResult | ThrownResult | ReplyFailure
type Settlement = { phase: SettlementPhase, resultKind: HandlerOutcome, emitted: int, delivered: int, busy: bool, snapshotTarget: int, returnedToCaller: bool, mutation: bool, receiptApplied: bool, canonicalMatch: bool, deliveryFailed: bool, callbacksClosed: bool, successfulDeliveries: int }
pure val initial: Settlement = { phase: Admission, resultKind: NoOutcome, emitted: 0, delivered: 0, busy: false, snapshotTarget: 0, returnedToCaller: false, mutation: false, receiptApplied: false, canonicalMatch: false, deliveryFailed: false, callbacksClosed: false, successfulDeliveries: 0 }
pure def canAdmitAction(s: Settlement, allowed: bool, mutation: bool): bool = s.phase == Admission
pure def admitAction(s: Settlement, allowed: bool, mutation: bool): Settlement = { ...s, phase: if (allowed) HandlerRunning else HandlerFailed, mutation: mutation }
pure def canEmitCallback(s: Settlement): bool = (s.phase == HandlerRunning or s.phase == HandlerReturned or s.phase == Settled or s.phase == SettlementDone) and not(s.callbacksClosed)
pure def emitCallback(s: Settlement): Settlement = { ...s, emitted: s.emitted + 1 }
pure def canReturnHandler(s: Settlement, resultKind: HandlerOutcome, applied: bool, matches: bool): bool = s.phase == HandlerRunning and resultKind != NoOutcome
pure def returnHandler(s: Settlement, resultKind: HandlerOutcome, applied: bool, matches: bool): Settlement = { ...s, phase: HandlerReturned, resultKind: resultKind, receiptApplied: applied, canonicalMatch: matches }
pure def canSettleHandler(s: Settlement): bool = s.phase == HandlerReturned
pure def settleHandler(s: Settlement): Settlement = { ...s, phase: if (s.resultKind == ValidResult) Settled else HandlerFailed, snapshotTarget: s.emitted }
pure def alwaysSettledResultValid(s: Settlement): bool = s.phase == Settled or s.phase == SettlementDone implies s.resultKind == ValidResult
pure def alwaysNoDeliveryBeforeSettlement(s: Settlement): bool = s.delivered > 0 implies (s.phase == Settled or s.phase == SettlementDone)
pure def alwaysFailureSuppressesCallbacks(s: Settlement): bool = s.resultKind == InvalidResult or s.resultKind == ThrownResult or s.resultKind == ReplyFailure or s.phase == HandlerFailed implies s.delivered == 0
pure def sometimesDeniedBeforeInvocation(s: Settlement): bool = s.phase == HandlerFailed and s.resultKind == NoOutcome and s.emitted == 0
pure def sometimesInvalidResultSuppressed(s: Settlement): bool = s.phase == HandlerFailed and s.resultKind == InvalidResult and s.emitted > 0
```

### Mutation delivery requires bound receipts and matching canonical text

Canonical matching includes a core-owned binding to normalized receipt IDs. Bound preview or failure receipts may deliver informational text; only committed receipts can justify an applied confirmation, as specified by the receipt composition. An action-owned claim cannot create commit authority.

```quint
pure def canDeliverCallback(s: Settlement): bool = (s.phase == Settled or s.phase == SettlementDone) and not(s.busy) and s.delivered < s.emitted and (not(s.mutation) or s.canonicalMatch)
pure def deliverCallback(s: Settlement): Settlement = { ...s, delivered: s.delivered + 1, busy: true }
pure def canSettleTransport(s: Settlement, ok: bool): bool = s.busy
pure def settleTransport(s: Settlement, ok: bool): Settlement = { ...s, busy: false, deliveryFailed: s.deliveryFailed or not(ok), successfulDeliveries: s.successfulDeliveries + (if (ok) 1 else 0) }
pure def canReturnSettlement(s: Settlement): bool = s.phase == Settled and not(s.busy) and (s.delivered >= s.snapshotTarget or (s.mutation and not(s.canonicalMatch)))
pure def returnSettlement(s: Settlement): Settlement = { ...s, phase: SettlementDone, returnedToCaller: true }
pure def alwaysDeliveryBoundedByEmission(s: Settlement): bool = s.delivered >= 0 and s.delivered <= s.emitted and s.snapshotTarget >= 0 and s.snapshotTarget <= s.emitted
pure def alwaysMutationCallbackGrounded(s: Settlement): bool = s.mutation and s.delivered > 0 implies s.canonicalMatch
pure def stepEmissionOrder(before: Settlement, after: Settlement): bool = after.delivered >= before.delivered and after.delivered <= before.delivered + 1
pure def sometimesDeliveryFailureKeepsReceipt(s: Settlement): bool = s.deliveryFailed and s.receiptApplied and s.returnedToCaller
pure def sometimesUnboundMutationRefused(s: Settlement): bool = s.phase == Settled and s.mutation and not(s.canonicalMatch) and not(canDeliverCallback(s))
pure def sometimesLateCallbackDelivered(s: Settlement): bool = s.returnedToCaller and s.delivered > s.snapshotTarget
```

### An invoked handler eventually settles under fair completion

The environment eventually returns the handler and settles transport delivery. The settlement owner then returns or records the handler failure.

```quint
pure val fair_returnHandler = "weak"
pure val fair_settleHandler = "weak"
pure val fair_deliverCallback = "weak"
pure val fair_settleTransport = "weak"
pure val fair_returnSettlement = "weak"
pure def leadsToSettlementReturned(s: Settlement, later: Settlement): bool = (s.phase == HandlerRunning or s.phase == HandlerReturned or s.phase == Settled) implies (later.phase == HandlerFailed or later.phase == SettlementDone)
```

### Every callback from a finished source reaches delivery settlement

The callback producer explicitly closes its source after its final callback. For a valid result with authorized receipt binding, fair delivery drains every callback in order, including callbacks emitted after the settlement method returned. Transport failures remain recorded and later callbacks still run.

```quint
pure def canFinishCallbackSource(s: Settlement): bool = s.phase != Admission and not(s.callbacksClosed)
pure def finishCallbackSource(s: Settlement): Settlement = { ...s, callbacksClosed: true }
pure def alwaysDeliveryAccounting(s: Settlement): bool = s.successfulDeliveries >= 0 and s.successfulDeliveries <= s.delivered and (s.busy implies s.successfulDeliveries < s.delivered)
pure def stepCallbackSourceStaysClosed(before: Settlement, after: Settlement): bool = before.callbacksClosed implies after.callbacksClosed and after.emitted == before.emitted
pure val fair_finishCallbackSource = "weak"
pure def leadsToAllCallbacksSettled(s: Settlement, later: Settlement): bool = s.callbacksClosed and s.resultKind == ValidResult and (not(s.mutation) or s.canonicalMatch) implies later.delivered == s.emitted and not(later.busy)
pure def sometimesLaterCallbackAfterTransportFailure(s: Settlement): bool = s.deliveryFailed and s.delivered > 1 and s.successfulDeliveries > 0
```

### Every unsettled action has an enabled settlement step

The accepted terminal states are a failed handler with a closed callback source, or a returned settlement with a closed source and every admitted callback settled. Authorized mutation callbacks follow the receipt gate.

```quint
pure def settlementTerminal(s: Settlement): bool = s.callbacksClosed and (s.phase == HandlerFailed or (s.phase == SettlementDone and not(s.busy) and (s.delivered == s.emitted or (s.mutation and not(s.canonicalMatch)))))
pure def settlementProgressEnabled(s: Settlement): bool = canAdmitAction(s, false, false) or canReturnHandler(s, ValidResult, false, false) or canSettleHandler(s) or canSettleTransport(s, true) or canDeliverCallback(s) or canReturnSettlement(s) or canFinishCallbackSource(s)
pure def alwaysSettlementDeadlockFree(s: Settlement): bool = settlementTerminal(s) or settlementProgressEnabled(s)
```
