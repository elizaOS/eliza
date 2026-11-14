# Effect receipts and delivery settlement

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/types/effects.ts`, `runtime/effect-delivery.ts`, `runtime/action-handler-settlement.ts`, and `quint/ActionSettlement.qnt`. Receipts retain stable IDs, operation, resource and child references, idempotency identity, observation times, outcome-specific proof, and rollback links. Boundary decoding checks these shapes and rejects conflicting duplicate IDs. The state model follows one receipt and its exact reply through settlement.

## Story: Confirm only a committed requested effect

As a user, I receive a confirmation only when the current turn binds exact action-owned text to active committed receipt IDs. A preview, ordinary no-op, failure or rollback cannot prove application. A replayed no-op qualifies after the handler re-observes the earlier committed result under a nonempty idempotency key.

### ReceiptOutcome evidence determines which receipts prove a committed result

```quint
type ReceiptOutcome = Pending | Applied | Preview | Noop | Failed | RolledBack
type Receipt = { receiptKind: ReceiptOutcome, durable: bool, providerAccepted: bool, hasKey: bool, replayed: bool, reverted: bool }
pure def committedReceipt(receipt: Receipt): bool =
  not(receipt.reverted) and ((receipt.receiptKind == Applied and (receipt.durable or receipt.providerAccepted)) or (receipt.receiptKind == Noop and receipt.hasKey and receipt.replayed))
pure def lawPreviewNeverProvesApplication(hasKey: bool, replayed: bool): bool =
  not(committedReceipt({ receiptKind: Preview, durable: false, providerAccepted: false, hasKey: hasKey, replayed: replayed, reverted: false }))
pure val receiptValues = Set(
  { receiptKind: Pending, durable: false, providerAccepted: false, hasKey: false, replayed: false, reverted: false },
  { receiptKind: Applied, durable: true, providerAccepted: false, hasKey: true, replayed: false, reverted: false },
  { receiptKind: Noop, durable: false, providerAccepted: false, hasKey: true, replayed: true, reverted: false }
)
pure def lawRollbackRemovesProof(receipt: Receipt): bool = not(committedReceipt({ ...receipt, reverted: true }))
pure def lawOrdinaryNoopNeverProvesApplication(hasKey: bool): bool =
  not(committedReceipt({ receiptKind: Noop, durable: false, providerAccepted: false, hasKey: hasKey, replayed: false, reverted: false }))
```

### A settled handler supplies outcome evidence before any callback is delivered

The model permits both local durable commits and authoritative provider acceptance. Unknown provider acceptance follows failure. Serialized or model-authored fields cannot mint the core-owned binding.

```quint
type Delivery = { receipt: Receipt, handlerSettled: bool, bound: bool, exactText: bool, exactIds: bool, delivered: bool, confirmsApplied: bool, callbacks: int, attempted: bool, inFlight: bool, transportFailed: bool }
pure val initial: Delivery = { receipt: { receiptKind: Pending, durable: false, providerAccepted: false, hasKey: false, replayed: false, reverted: false }, handlerSettled: false, bound: false, exactText: false, exactIds: false, delivered: false, confirmsApplied: false, callbacks: 0, attempted: false, inFlight: false, transportFailed: false }
pure def canRecordOutcome(s: Delivery, receiptOutcome: ReceiptOutcome, durable: bool, providerAccepted: bool, hasKey: bool, replayed: bool): bool =
  not(s.handlerSettled) and receiptOutcome != Pending and receiptOutcome != RolledBack and (receiptOutcome != Applied or durable or providerAccepted) and (not(replayed) or hasKey) and (receiptOutcome == Applied or (not(durable) and not(providerAccepted)))
pure def recordOutcome(s: Delivery, receiptOutcome: ReceiptOutcome, durable: bool, providerAccepted: bool, hasKey: bool, replayed: bool): Delivery =
  { ...s, handlerSettled: true, receipt: { receiptKind: receiptOutcome, durable: durable, providerAccepted: providerAccepted, hasKey: hasKey, replayed: replayed, reverted: false } }
pure val receiptOutcomeValues = Set(Applied, Preview, Noop, Failed)
```

### Delivery rechecks the exact text and receipt IDs after hooks have run

Discovered by the proof: an attempted callback already has a settled handler and a core-owned binding. This invariant lets transport settlement preserve the confirmation evidence.

Callback invocation is separate from acknowledged transport settlement. A transport failure leaves the effect receipt intact and produces no delivered confirmation. A hook may invalidate the binding. Such a response can still deliver a non-confirming failure or informational result. It cannot retain a claim that the effect was applied.

```quint
pure def canBind(s: Delivery): bool = s.handlerSettled and not(s.attempted) and not(s.bound)
pure def bind(s: Delivery): Delivery = { ...s, bound: true, exactText: true, exactIds: true }
pure def canTransform(s: Delivery): bool = s.bound and not(s.attempted) and s.exactText
pure def transform(s: Delivery): Delivery = { ...s, exactText: false }
pure def canChangeIds(s: Delivery): bool = s.bound and not(s.attempted) and s.exactIds
pure def changeIds(s: Delivery): Delivery = { ...s, exactIds: false }
pure def canRollback(s: Delivery): bool = s.handlerSettled and not(s.delivered) and committedReceipt(s.receipt)
pure def rollback(s: Delivery): Delivery = { ...s, receipt: { ...s.receipt, reverted: true } }
pure def canDeliver(s: Delivery): bool = s.handlerSettled and s.bound and not(s.attempted)
pure def deliver(s: Delivery): Delivery = { ...s, attempted: true, inFlight: true, callbacks: s.callbacks + 1 }
pure def canSettleDelivery(s: Delivery, accepted: bool): bool = s.inFlight
pure def settleDelivery(s: Delivery, accepted: bool): Delivery = { ...s, inFlight: false, delivered: accepted, transportFailed: not(accepted), confirmsApplied: accepted and s.exactText and s.exactIds and committedReceipt(s.receipt) }
pure def alwaysConfirmationHasProof(s: Delivery): bool = s.confirmsApplied implies (s.delivered and s.handlerSettled and s.bound and s.exactText and s.exactIds and committedReceipt(s.receipt))
pure def alwaysAttemptHasSettledBoundHandler(s: Delivery): bool = s.attempted implies (s.handlerSettled and s.bound)
pure def alwaysCallbackAccounting(s: Delivery): bool = s.callbacks == (if (s.attempted) 1 else 0) and (s.inFlight implies (s.attempted and not(s.delivered))) and (s.delivered implies (s.attempted and not(s.inFlight)))
pure def alwaysOneDelivery(s: Delivery): bool = s.callbacks >= 0 and s.callbacks <= 1
pure def sometimesTransportFailure(s: Delivery): bool = s.attempted and s.transportFailed and not(s.delivered) and not(s.confirmsApplied)
pure def sometimesDurableConfirmation(s: Delivery): bool = s.confirmsApplied and s.receipt.durable
pure def sometimesReplayedConfirmation(s: Delivery): bool = s.confirmsApplied and s.receipt.receiptKind == Noop
pure def sometimesTransformedReplyWithholdsConfirmation(s: Delivery): bool = s.delivered and not(s.exactText) and not(s.confirmsApplied)
pure def sometimesRollbackWithholdsConfirmation(s: Delivery): bool = s.delivered and s.receipt.reverted and not(s.confirmsApplied)
```

### Automatic retries require an idempotency contract for mutating actions

```quint
pure def automaticRetryAllowed(mutating: bool, explicitlyIdempotent: bool): bool = not(mutating) or explicitlyIdempotent
pure def lawMutationsRequireIdempotency(explicitlyIdempotent: bool): bool = automaticRetryAllowed(true, explicitlyIdempotent) == explicitlyIdempotent
```
