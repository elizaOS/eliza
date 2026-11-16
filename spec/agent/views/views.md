# View installations and renderer claims

The agent installs views for its owner and lets a renderer claim an
interaction with one. Identity values stand for unforgeable in-process
handles; a string alone never authorizes. [Core views](../../core/views.md)
own view declarations and completed-action handoffs, and
[view navigation](../../core/viewNavigation.md) owns the renderer's
navigation fences. [Native views](./nativeViews.md) own the native renderer
and its turn timing.

## Story: Interact with the view that is installed now

> As a user, an interaction I start with a view is answered by that view,
> and a view that was replaced or closed can no longer answer.

### Replacing an installation revokes the old one, which never becomes active again

An installation is prepared, then committed. Preparing another revokes the
one still pending; committing revokes the one it replaces. Revoking the
active installation leaves none active. A revoked installation can neither
be prepared nor committed again.

```quint
type Views = { closed: bool, pending: int, active: int, revoked: Set[int], waiter: int, claimed: bool, done: bool, resultEntry: int }
pure val initial: Views = { closed: false, pending: 0, active: 0, revoked: Set(), waiter: 0, claimed: false, done: false, resultEntry: 0 }
pure def revokedWith(v: Views, installation: int): Set[int] = if (installation != 0) v.revoked.union(Set(installation)) else v.revoked
pure def canBeginInstall(v: Views, installation: int): bool =
  not(v.closed) and installation > 0 and installation != v.active and installation != v.pending and not(v.revoked.contains(installation))
pure def beginInstall(v: Views, installation: int): Views = { ...v, pending: installation, revoked: revokedWith(v, v.pending) }
pure def canCommitInstall(v: Views): bool = not(v.closed) and v.pending != 0 and not(v.revoked.contains(v.pending))
pure def commitInstall(v: Views): Views = { ...v, active: v.pending, pending: 0, revoked: revokedWith(v, v.active) }
pure def canRevokeInstall(v: Views): bool = v.active != 0
pure def revokeInstall(v: Views): Views = { ...v, active: 0, revoked: revokedWith(v, v.active) }
pure val installationValues = Set(0, 1, 2, 3)
pure def alwaysLiveInstallationsAreUnrevoked(v: Views): bool =
  (v.active != 0 implies not(v.revoked.contains(v.active))) and (v.pending != 0 implies not(v.revoked.contains(v.pending))) and
  (v.pending == 0 or v.pending != v.active)
pure def sometimesReplacedInstallation(v: Views): bool = v.active != 0 and v.revoked.size() > 0
```

### Only the active installation's waiter can be claimed and answered, once

A waiter is opened for the active installation. One renderer claims it, and
only a claimed waiter of the still-active installation produces a result,
which closes the waiter. After a replacement the old waiter can no longer
be claimed or answered; it can only be cancelled.

```quint
pure def canWaitInteraction(v: Views): bool = not(v.closed) and v.active != 0 and v.waiter == 0 and not(v.done)
pure def waitInteraction(v: Views): Views = { ...v, waiter: v.active, claimed: false }
pure def canClaimInteraction(v: Views): bool = not(v.closed) and v.waiter != 0 and v.waiter == v.active and not(v.claimed)
pure def claimInteraction(v: Views): Views = { ...v, claimed: true }
pure def canAnswerInteraction(v: Views): bool = not(v.closed) and v.waiter != 0 and v.waiter == v.active and v.claimed
pure def answerInteraction(v: Views): Views = { ...v, done: true, resultEntry: v.waiter, waiter: 0, claimed: false }
pure def canCancelInteraction(v: Views): bool = v.waiter != 0
pure def cancelInteraction(v: Views): Views = { ...v, waiter: 0, claimed: false }
pure def stepAnswerComesFromActiveInstallation(before: Views, via: str, after: Views): bool =
  via == "answerInteraction" implies (before.waiter == before.active and before.claimed and after.resultEntry == before.active)
pure def sometimesInteractionAnswered(v: Views): bool = v.done and v.resultEntry != 0
pure def sometimesStaleWaiterAfterReplacement(v: Views): bool = v.waiter != 0 and v.waiter != v.active and v.claimed
```

### Closing the agent clears every installation and waiter

Closing revokes the pending and active installations and drops the waiter
and its claim; nothing can be installed afterwards.

```quint
pure def closeViews(v: Views): Views =
  { ...v, closed: true, revoked: revokedWith({ ...v, revoked: revokedWith(v, v.active) }, v.pending), pending: 0, active: 0, waiter: 0, claimed: false }
pure def alwaysClosedHoldsNothing(v: Views): bool = v.closed implies (v.pending == 0 and v.active == 0 and v.waiter == 0 and not(v.claimed))
pure def alwaysResultHasAnEntry(v: Views): bool = v.done implies v.resultEntry != 0
pure def sometimesClosedAfterWaiting(v: Views): bool = v.closed and v.revoked.size() > 0
```
