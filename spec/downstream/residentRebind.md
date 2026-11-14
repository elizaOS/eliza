# Resident provider rebind queue

AlphaPhone defers Cloud rebind behind owner sign-in and other blocking
operations. `apps/app/src/runtime/connection-ui.tsx` installs
`ResidentRebindQueue` from the pinned `cloud-resident-binding.ts`.
[Resident Cloud admission](./residentCloud.md) decides whether the
inference provider should bind, keep, or clear its configuration. The
queue tracks promise ownership and does not start or stop the resident.

## Story: Recheck inference authority after current work releases its slot

### Coalesced callers receive the run serving their shared promise

At most one rebind executes at a time. Requests during a running operation
or host block update one queued callback and share its deferred promise.
A host's flag-only request requires explicit resume. Draining a deferred
request chooses its latest callback. Explicit resume or an immediate
request can service the queued promise with the host's chosen callback.
Success and failure both release the active slot and settle the promise
served by that run. The host supplies its blocker result at each entry.
The sampled callback numbers identify closures, not credential data.

```quint
type Rebind = { serial: int, requested: bool, queued: int, queueCallback: int, running: int, runCallback: int, serving: int, completed: int, served: int, successful: bool }
pure val initial: Rebind = { serial: 0, requested: false, queued: 0, queueCallback: 0, running: 0, runCallback: 0, serving: 0, completed: 0, served: 0, successful: false }
pure def startRebind(callbackId: int, q: Rebind): Rebind = { ...q, serial: q.serial + 1, requested: false, running: q.serial + 1, runCallback: callbackId, serving: q.queued, queued: 0, queueCallback: 0 }
pure def canRequestRebind(q: Rebind, callbackId: int): bool = callbackId > 0
pure def requestRebind(q: Rebind, callbackId: int, blocked: bool): Rebind =
  if (q.running == 0 and not(blocked)) startRebind(callbackId, q)
  else { ...q, serial: if (q.queued == 0) q.serial + 1 else q.serial, queued: if (q.queued == 0) q.serial + 1 else q.queued, queueCallback: callbackId }
pure def markRebindWanted(q: Rebind): Rebind = { ...q, requested: true }
pure def canResumeRebind(q: Rebind, callbackId: int, blocked: bool): bool = q.running == 0 and not(blocked) and (q.requested or q.queued > 0) and callbackId > 0
pure def resumeRebind(q: Rebind, callbackId: int, blocked: bool): Rebind = startRebind(callbackId, q)
pure def canDrainQueued(q: Rebind, blocked: bool): bool = q.running == 0 and q.queued > 0 and not(blocked)
pure def drainQueued(q: Rebind, blocked: bool): Rebind = startRebind(q.queueCallback, q)
pure def canFinishRebind(q: Rebind): bool = q.running > 0
pure def finishRebind(q: Rebind, successful: bool): Rebind = { ...q, completed: q.running, served: q.serving, successful: successful, running: 0, runCallback: 0, serving: 0 }
pure val callbackIdValues = Set(0, 1, 2)
pure def alwaysRebindIdentities(q: Rebind): bool = q.serial >= 0 and q.queued >= 0 and q.queued <= q.serial and q.running >= 0 and q.running <= q.serial and q.serving >= 0 and (q.serving > 0 implies q.serving < q.running) and q.completed >= 0 and q.completed <= q.serial and q.served >= 0 and (q.served > 0 implies q.served < q.completed)
pure def alwaysQueueKeepsLatestCallback(q: Rebind): bool = (q.queued == 0 and q.queueCallback == 0 or q.queued > 0 and q.queueCallback > 0) and (q.running == 0 and q.runCallback == 0 or q.running > 0 and q.runCallback > 0)
pure def stepCoalescingKeepsPromise(before: Rebind, via: str, after: Rebind): bool = (via == "requestRebind" and before.queued > 0 and after.queued > 0) implies before.queued == after.queued
pure def stepFinishServesReservedPromise(before: Rebind, via: str, after: Rebind): bool = via == "finishRebind" implies after.completed == before.running and after.served == before.serving and after.queued == before.queued
pure def sometimesQueuedBehindActive(q: Rebind): bool = q.running > 0 and q.queued > 0
pure def sometimesDeferredFailureReturned(q: Rebind): bool = q.served > 0 and not(q.successful)
```
