# Push notifications

The agent's push service delivers notices to the user's devices. The
[core notifications](../core/notifications/) own the notice records; this
spec owns the push service's attachment to the runtime's notification bus
and the device token it delivers to. Platform transports are outside the
model.

## Story: Get each notice once on my device, and nothing after the service stops

> As a user, I get a push for each notice once, not once per attachment, and
> the service sends nothing after it stops. My device token is used only after
> it is saved.

### Concurrent lazy attachments keep their startup epoch and publish one listener

The service attaches to the bus at start, or lazily, and two lazy
attachments may be in flight at once. Each remembers the epoch it started in. One that completes in the
current epoch subscribes the single listener, or finds it already there;
one that started before the last stop completes without subscribing.

```quint
type PushService = { subscribed: bool, listeners: int, epoch: int, pendingCurrent: int, pendingStale: int, stopped: bool, committedToken: bool, candidateToken: bool, writing: bool, deliveries: int }
pure val initial: PushService = { subscribed: false, listeners: 0, epoch: 0, pendingCurrent: 0, pendingStale: 0, stopped: false, committedToken: false, candidateToken: false, writing: false, deliveries: 0 }
pure def attach(p: PushService): PushService = { ...p, subscribed: true, listeners: 1, stopped: false }
pure def canBeginLazyAttach(p: PushService): bool = not(p.subscribed)
pure def beginLazyAttach(p: PushService): PushService = { ...p, pendingCurrent: p.pendingCurrent + 1, stopped: false }
pure def canCompleteCurrentAttach(p: PushService): bool = p.pendingCurrent > 0
pure def completeCurrentAttach(p: PushService): PushService = { ...p, pendingCurrent: p.pendingCurrent - 1, subscribed: true, listeners: 1 }
pure def canCompleteStaleAttach(p: PushService): bool = p.pendingStale > 0
pure def completeStaleAttach(p: PushService): PushService = { ...p, pendingStale: p.pendingStale - 1 }
pure def alwaysOneListenerAtMost(p: PushService): bool = (p.listeners == 0 or p.listeners == 1) and p.subscribed == (p.listeners == 1)
pure def stepStaleAttachNeverSubscribes(before: PushService, via: str, after: PushService): bool =
  via == "completeStaleAttach" implies (after.subscribed == before.subscribed and after.listeners == before.listeners)
pure def sometimesConcurrentAttachesShareOneListener(p: PushService): bool = p.listeners == 1 and p.pendingCurrent > 0
```

### Stopping invalidates every attachment

Stopping unsubscribes the listener, advances the epoch and turns every
attachment still in flight into a stale one. A stopped service has no
listener and no current attachment until it is started or attached again.

```quint
pure def stop(p: PushService): PushService = { ...p, subscribed: false, listeners: 0, epoch: p.epoch + 1, stopped: true, pendingStale: p.pendingStale + p.pendingCurrent, pendingCurrent: 0 }
pure def alwaysStoppedServiceHasNoListener(p: PushService): bool = p.stopped implies (p.listeners == 0 and p.pendingCurrent == 0)
pure def sometimesStaleAttachDiscardedAfterStop(p: PushService): bool = p.stopped and p.epoch > 0 and p.pendingStale == 0 and p.pendingCurrent == 0 and p.listeners == 0 and not(p.subscribed)
```

### A device token is persisted before it is acknowledged or used

A new or cleared token is staged and written. Only a successful write makes it
the committed token; a failed write restores the committed one. Delivery
needs a listener and a committed token.

```quint
pure def canStageToken(p: PushService, present: bool): bool = not(p.writing)
pure def stageToken(p: PushService, present: bool): PushService = { ...p, candidateToken: present, writing: true }
pure def canPersistToken(p: PushService, ok: bool): bool = p.writing
pure def persistToken(p: PushService, ok: bool): PushService =
  if (ok) { ...p, committedToken: p.candidateToken, writing: false } else { ...p, candidateToken: p.committedToken, writing: false }
pure def canDeliver(p: PushService): bool = p.subscribed and p.committedToken
pure def deliver(p: PushService): PushService = { ...p, deliveries: p.deliveries + 1 }
pure def alwaysUnwrittenTokenIsNotVisible(p: PushService): bool = not(p.writing) implies p.candidateToken == p.committedToken
pure def stepDeliveryUsesAPersistedToken(before: PushService, via: str, after: PushService): bool =
  via == "deliver" implies (before.committedToken and before.subscribed)
pure def sometimesDelivered(p: PushService): bool = p.deliveries > 0
```
