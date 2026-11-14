# Notification payload ownership

The owner is `copyNotification` and the serialized mutation, read and
broadcast paths in `packages/core/src/services/notification.ts`. This
projection follows one admitted notification identity through the
[inbox protocol](./notifications.md). Strings stand for arbitrary cloneable
payload values. The runtime boundary must take detached structured clones
of nested data and report a clone failure to the caller before admission.

## Story: Keep notification data independent of the producer and observers

As a producer, I can change my input after queuing a notification. The
stored notification keeps its admitted value. Observers can edit returned
and broadcast copies without changing the inbox or its durable payload.

### Admission and exposure capture separate values

An ordinary inbox read can see the provisional memory row. Durable native
reads require reconciled durable data. A live broadcast requires an
acknowledged write.
A write may fail after changing the store. Only reconciliation can use
that committed value to restore the readable memory row. Restart reads
the durable copy and does not publish an earlier write again.

```quint
type Payload = AbsentPayload | PresentPayload({ value: str })
pure val absentPayload: Payload = AbsentPayload
pure def payloadOf(value: str): Payload = PresentPayload({ value: value })
type PayloadPhase = AwaitAdmission | QueuedPayload | ProvisionalPayload | UncertainPayload | SettledPayload | StoppedPayload
type PayloadWrite = PayloadAcknowledged | PayloadRejectedBefore | PayloadLostAcknowledgement
type PayloadOwnership = { phase: PayloadPhase, producer: str, admitted: Payload, memory: Payload, disk: Payload, exposed: Payload, acknowledged: bool }
pure val initial: PayloadOwnership = {
  phase: AwaitAdmission,
  producer: "original",
  admitted: absentPayload,
  memory: absentPayload,
  disk: absentPayload,
  exposed: absentPayload,
  acknowledged: false
}
pure def canCapturePayload(s: PayloadOwnership): bool = s.phase == AwaitAdmission
pure def capturePayload(s: PayloadOwnership): PayloadOwnership =
  { ...s, admitted: payloadOf(s.producer), phase: QueuedPayload }
pure def changeProducer(s: PayloadOwnership, value: str): PayloadOwnership = { ...s, producer: value }
pure def canMaterializePayload(s: PayloadOwnership): bool = s.phase == QueuedPayload
pure def materializePayload(s: PayloadOwnership): PayloadOwnership =
  { ...s, phase: ProvisionalPayload, memory: s.admitted }
pure def canPersistPayload(s: PayloadOwnership, write: PayloadWrite): bool = s.phase == ProvisionalPayload
pure def persistPayload(s: PayloadOwnership, write: PayloadWrite): PayloadOwnership = {
  ...s,
  disk: if (write == PayloadRejectedBefore) s.disk else s.memory,
  phase: if (write == PayloadAcknowledged) SettledPayload else UncertainPayload,
  acknowledged: write == PayloadAcknowledged
}
pure def canReconcilePayload(s: PayloadOwnership): bool = s.phase == UncertainPayload
pure def reconcilePayload(s: PayloadOwnership): PayloadOwnership =
  { ...s, phase: SettledPayload, memory: s.disk }
pure def canExposeOrdinaryCopy(s: PayloadOwnership): bool = s.memory != absentPayload
pure def exposeOrdinaryCopy(s: PayloadOwnership): PayloadOwnership = { ...s, exposed: s.memory }
pure def canExposeDurableCopy(s: PayloadOwnership): bool = s.phase == SettledPayload and s.disk != absentPayload
pure def exposeDurableCopy(s: PayloadOwnership): PayloadOwnership = { ...s, exposed: s.disk }
pure def canBroadcastPayload(s: PayloadOwnership): bool = s.phase == SettledPayload and s.acknowledged and s.disk != absentPayload
pure def broadcastPayload(s: PayloadOwnership): PayloadOwnership = exposeDurableCopy(s)
pure def canEditObserver(s: PayloadOwnership, value: str): bool = s.exposed != absentPayload
pure def editObserver(s: PayloadOwnership, value: str): PayloadOwnership = { ...s, exposed: payloadOf(value) }
pure def canStopPayload(s: PayloadOwnership): bool = s.phase == SettledPayload
pure def stopPayload(s: PayloadOwnership): PayloadOwnership = { ...s, phase: StoppedPayload, memory: absentPayload, acknowledged: false }
pure def canRestorePayload(s: PayloadOwnership): bool = s.phase == StoppedPayload
pure def restorePayload(s: PayloadOwnership): PayloadOwnership = { ...s, phase: SettledPayload, memory: s.disk }
pure val valueValues = Set("original", "edited")
pure def alwaysOwnedPayloadMatchesAdmission(s: PayloadOwnership): bool =
  (s.memory == absentPayload or s.memory == s.admitted) and (s.disk == absentPayload or s.disk == s.admitted)
pure def alwaysStoppedMemoryIsEmpty(s: PayloadOwnership): bool = s.phase == StoppedPayload implies s.memory == absentPayload and not(s.acknowledged)
pure def alwaysAcknowledgedPayloadIsDurable(s: PayloadOwnership): bool =
  s.acknowledged implies s.phase == SettledPayload and s.disk == s.admitted and s.disk != absentPayload
pure def alwaysQueueHasCapturedPayload(s: PayloadOwnership): bool =
  (s.phase == QueuedPayload or s.phase == ProvisionalPayload) implies s.admitted != absentPayload and not(s.acknowledged)
pure def alwaysProvisionalMatchesAdmission(s: PayloadOwnership): bool = s.phase == ProvisionalPayload implies s.memory == s.admitted
pure def stepAdmissionCapturesProducer(before: PayloadOwnership, via: str, after: PayloadOwnership): bool =
  if (via == "capturePayload") after.admitted == payloadOf(before.producer) else after.admitted == before.admitted
pure def stepEditsDoNotChangeOwnedCopies(before: PayloadOwnership, via: str, after: PayloadOwnership): bool =
  (via == "changeProducer" or via == "editObserver") implies after.memory == before.memory and after.disk == before.disk
pure def sometimesEditedCopyLeavesDurablePayload(s: PayloadOwnership): bool =
  s.exposed == payloadOf("edited") and s.disk == payloadOf("original")
pure def sometimesLostAcknowledgementRetainsPayload(s: PayloadOwnership): bool =
  s.phase == UncertainPayload and s.disk != absentPayload
```

### An admitted payload reaches its result when the cache responds

The admitted write can be rejected, acknowledged or committed with a
lost acknowledgement. Progress assumes the queue reaches its admitted
work and the cache completes the write and any reconciliation read.

```quint
pure val fair_materializePayload = "weak"
pure val fair_persistPayload = "weak"
pure val fair_reconcilePayload = "weak"
pure def leadsToAdmittedPayloadSettles(s: PayloadOwnership, later: PayloadOwnership): bool =
  (s.phase == QueuedPayload or s.phase == ProvisionalPayload or s.phase == UncertainPayload) implies
    later.phase == SettledPayload or later.phase == StoppedPayload
```

### An unused submission has no owned copy

Discovered by the proof: constructing a fresh submission cannot inherit a
memory or disk payload from a prior write. Only admission introduces that
submission's captured value.

```quint
pure def alwaysUnadmittedHasNoOwnedPayload(s: PayloadOwnership): bool =
  s.phase == AwaitAdmission implies s.admitted == absentPayload and s.memory == absentPayload and s.disk == absentPayload
```
