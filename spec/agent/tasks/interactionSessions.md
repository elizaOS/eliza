# Interaction sessions on the agent host

The agent host runs an interaction's external effect. The
[core interaction session](../../core/sessions.md) owns claim tokens,
digests, leases and expiry; this spec takes those as already checked and
owns what the host adds: a process lock over the session row, a durable
commitment written before the effect, and reconciliation after a crash.
A crash after the commitment never leads to running the effect again
blindly. The [interactive task runtime](./index.md) uses these sessions.

## Story: Run a committed interaction once, even across a crash

> As a user, when the agent has committed to an action for me, a crash or a
> failed write afterwards never makes it act twice. The interaction is either
> completed with its receipt or left uncertain until someone reconciles it.

### One live process holds the session, and a crash leaves a marker to reconcile

A process acquires the session's lock under its owner identity when no one
holds it and no crash marker is outstanding. A crash drops the lock and leaves
a marker. The marker is cleared only by reconciling the lock while no one
holds it and no committed effect is left in doubt, and no process acquires
the session before that.

```quint
import sessions as S from "../../core/sessions"
type HostPhase = HostPending | HostClaimed | HostCommitted | HostEffected | HostCompleted | HostUncertain
type InteractionHost = { phase: HostPhase, holder: S::SessionOwner, authorized: bool, commitment: bool, receipt: bool, effects: int, crashMarker: bool }
pure val nobody: S::SessionOwner = { agentId: "", actorId: "", connector: "" }
pure val initial: InteractionHost = { phase: HostPending, holder: nobody, authorized: true, commitment: false, receipt: false, effects: 0, crashMarker: false }
pure def held(h: InteractionHost): bool = h.holder != nobody
pure def canAcquire(h: InteractionHost, by: S::SessionOwner): bool = not(held(h)) and not(h.crashMarker) and by != nobody
pure def acquire(h: InteractionHost, by: S::SessionOwner): InteractionHost = { ...h, holder: by }
pure def canRelease(h: InteractionHost): bool = held(h)
pure def release(h: InteractionHost): InteractionHost = { ...h, holder: nobody }
pure def canCrash(h: InteractionHost): bool = held(h)
pure def crash(h: InteractionHost): InteractionHost = { ...h, holder: nobody, crashMarker: true }
pure def canReconcileLock(h: InteractionHost): bool = h.crashMarker and not(held(h)) and h.phase != HostCommitted
pure def reconcileLock(h: InteractionHost): InteractionHost = { ...h, crashMarker: false }
pure def alwaysCrashMarkerHasNoHolder(h: InteractionHost): bool = h.crashMarker implies not(held(h))
```

### The holder claims and commits while authorized, before any effect

Claiming and committing need the lock and current authorization. The
commitment is durable: it is set exactly when the interaction has reached
committed or any later phase. Revocation stops further claims and commits.

```quint
pure def canClaim(h: InteractionHost): bool = h.phase == HostPending and held(h) and h.authorized
pure def claim(h: InteractionHost): InteractionHost = { ...h, phase: HostClaimed }
pure def canCommit(h: InteractionHost): bool = h.phase == HostClaimed and held(h) and h.authorized
pure def commit(h: InteractionHost): InteractionHost = { ...h, phase: HostCommitted, commitment: true }
pure def canRevoke(h: InteractionHost): bool = h.authorized
pure def revoke(h: InteractionHost): InteractionHost = { ...h, authorized: false }
pure def pastCommitment(phase: HostPhase): bool = phase == HostCommitted or phase == HostEffected or phase == HostCompleted or phase == HostUncertain
pure def alwaysCommitmentMatchesPhase(h: InteractionHost): bool = h.commitment == pastCommitment(h.phase)
```

### The external effect runs at most once and only after the commitment

The effect runs from the committed phase, once, by the process that holds the
lock while no crash marker is outstanding. Completion writes the receipt;
if that write fails the interaction is uncertain, and the effect is not undone.

```quint
pure def canPerformEffect(h: InteractionHost): bool = h.phase == HostCommitted and h.effects == 0 and held(h) and not(h.crashMarker)
pure def performEffect(h: InteractionHost): InteractionHost = { ...h, effects: 1, phase: HostEffected }
pure def canCompleteReceipt(h: InteractionHost): bool = h.phase == HostEffected
pure def completeReceipt(h: InteractionHost): InteractionHost = { ...h, phase: HostCompleted, receipt: true }
pure def canFailCompletionWrite(h: InteractionHost): bool = h.phase == HostEffected
pure def failCompletionWrite(h: InteractionHost): InteractionHost = { ...h, phase: HostUncertain }
pure def alwaysEffectFollowsCommitment(h: InteractionHost): bool = (h.effects > 0 implies h.commitment) and h.effects >= 0 and h.effects <= 1
pure def stepEffectNeedsALiveHolder(before: InteractionHost, after: InteractionHost): bool = after.effects > before.effects implies (held(before) and not(before.crashMarker))
pure def alwaysReceiptMeansCompleted(h: InteractionHost): bool = h.receipt implies h.phase == HostCompleted
pure def sometimesCompletedWithReceipt(h: InteractionHost): bool = h.receipt and h.effects == 1
pure def sometimesEffectWithoutReceipt(h: InteractionHost): bool = h.phase == HostUncertain and h.effects == 1
```

### A committed interaction whose effect is in doubt becomes uncertain, never re-run

After a crash, a committed interaction whose effect has not been observed is
reconciled to uncertain. Nothing moves an uncertain interaction back to a
phase that could run the effect.

```quint
pure def canReconcileEffect(h: InteractionHost): bool = h.phase == HostCommitted and h.commitment and not(held(h))
pure def reconcileEffect(h: InteractionHost): InteractionHost = { ...h, phase: HostUncertain }
pure def stepUncertainIsFinal(before: InteractionHost, after: InteractionHost): bool = before.phase == HostUncertain implies (after.phase == HostUncertain and after.effects == before.effects)
pure def sometimesCrashAfterCommitIsUncertain(h: InteractionHost): bool = h.phase == HostUncertain and h.effects == 0 and h.commitment
```
