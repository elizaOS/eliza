# Renderer handoff deduplication and navigation fences

Source `views/completed-action-navigation.ts` owns per-renderer pending and handled handoff indexes, a navigation epoch and its observed window. Each index retains at most 256 identities. This is a separate lifecycle from the interaction request in `views.md`.

The renderer's navigate-view requests, from `events/index.ts` of the user interface package at the pinned baseline, wait in a bounded queue until a mounted view listener claims one. Their claims are kept in the same renderer state, in its `views` field.

## Story: Respect navigation made while a completed-action handoff is pending

> As a user, I want a late response to preserve navigation I made after the
> original request.

### Pending handoffs capture the pre-dispatch epoch and path

A handled id is suppressed. A pending id whose epoch or path changed is retired without redispatch. Otherwise the renderer emits the cancelable navigation event. If a shell handles it, the id enters the handled index. If unhandled and new, the pending index retains the pre-dispatch snapshot. An absent normalized id is dispatched without tracking. A handler can navigate synchronously during dispatch; its new epoch does not replace the captured snapshot.

```quint
type PendingHandoff = { id: str, epoch: int, path: str }
type Navigation = { windowId: str, epoch: int, path: str, handled: List[str], pending: List[PendingHandoff], lastEmitted: bool, lastId: str, views: ViewClaims }
pure val emptyPending: PendingHandoff = { id: "", epoch: 0, path: "" }
pure val initial: Navigation = { windowId: "", epoch: 0, path: "", handled: List(), pending: List(), lastEmitted: false, lastId: "", views: noViewClaims }
pure def observeWindow(s: Navigation, windowId: str, path: str): Navigation = { ...s, windowId: windowId, path: path }
pure def navigate(s: Navigation, path: str): Navigation = { ...s, path: path, epoch: s.epoch + 1 }
pure def pendingAt(s: Navigation, id: str): PendingHandoff = s.pending.select(entry => entry.id == id).nthOr(0, emptyPending)
pure def rememberHandled(id: str, s: Navigation): Navigation = {
  val entries = s.handled.select(entry => entry != id).append(id)
  { ...s, pending: s.pending.select(entry => entry.id != id), handled: if (entries.length() > 256) entries.tail() else entries }
}
pure def rememberPending(entry: PendingHandoff, s: Navigation): Navigation = {
  val entries = s.pending.select(previous => previous.id != entry.id).append(entry)
  { ...s, pending: if (entries.length() > 256) entries.tail() else entries }
}
pure def dispatchHandoff(s: Navigation, id: str, handledByShell: bool, handlerNavigates: bool, pathAfterHandler: str): Navigation = {
  val pending = pendingAt(s, id)
  val stale = id != "" and pending.id == id and (pending.epoch != s.epoch or pending.path != s.path)
  val refused = s.windowId == "" or (id != "" and s.handled.includes(id)) or stale
  val observed = { ...s, lastId: id, lastEmitted: not(refused) }
  val delivered = if (handlerNavigates and not(refused)) { ...observed, epoch: s.epoch + 1, path: pathAfterHandler } else observed
  if (stale) rememberHandled(id, observed)
  else if (refused or id == "") delivered
  else if (handledByShell) rememberHandled(id, delivered)
  else if (pending.id == "") rememberPending({ id: id, epoch: s.epoch, path: s.path }, delivered)
  else delivered
}
pure def resetNavigation(s: Navigation): Navigation = { ...initial, views: s.views }
pure def fenceValid(s: Navigation, windowId: str, epoch: int, path: str): bool = s.windowId == windowId and s.epoch == epoch and s.path == path
pure def alwaysBoundedNavigationIndexes(s: Navigation): bool = s.handled.length() <= 256 and s.pending.length() <= 256 and s.epoch >= 0
pure def alwaysUniqueNavigationIndexes(s: Navigation): bool = s.handled.every(id => s.handled.select(other => other == id).length() == 1) and s.pending.every(entry => s.pending.select(other => other.id == entry.id).length() == 1 and not(s.handled.includes(entry.id)))
pure def sometimesPendingNavigation(s: Navigation): bool = s.pending.length() > 0
pure def sometimesHandledNavigation(s: Navigation): bool = s.handled.length() > 0
pure val entryValues = Set({ id: "first", epoch: 0, path: "/chat" }, { id: "second", epoch: 1, path: "/files" })
```

## Story: Hand a navigate-view request to one mounted listener

> As a user, I want a request to open a view, made before any view listener
> is mounted or while one is busy, to be applied once by a listener that can
> apply it, and not to be lost to a listener that declined it.

A request carries no payload here; its number is its identity. Delivery to a
listener is split into invoking it, the listener returning, and a promise it
returned settling, so that a listener can unmount between them.

### Each request is numbered once and queued in arrival order

The renderer numbers requests from one. Every claim has its own number, no
number is queued twice, and every queued number was admitted.

```quint
type ClaimResolution = ClaimPending | ClaimApplied | ClaimRejected | ClaimDropped
type ViewClaim = { request: int, live: bool, claimed: bool, applying: bool, declined: Set[int], resolution: ClaimResolution, resolutions: int, effects: int }
type AttemptPhase = Invoking | Awaiting | Settled
type ListenerAttempt = { attempt: int, request: int, listener: int, admittedAt: int, phase: AttemptPhase, effected: bool }
type ViewClaims = { admitted: int, queue: List[int], mounted: Set[int], active: Set[int], requests: List[ViewClaim], attempts: List[ListenerAttempt] }
pure val noViewClaims: ViewClaims = { admitted: 0, queue: List(), mounted: Set(), active: Set(), requests: List(), attempts: List() }
pure val emptyClaim: ViewClaim = { request: 0, live: false, claimed: false, applying: false, declined: Set(), resolution: ClaimDropped, resolutions: 1, effects: 0 }
pure def claimAt(v: ViewClaims, request: int): ViewClaim = v.requests.select(c => c.request == request).nthOr(0, emptyClaim)
pure def withClaim(v: ViewClaims, claim: ViewClaim): ViewClaims = { ...v, requests: v.requests.listMap(c => if (c.request == claim.request) claim else c) }
pure def alwaysViewClaimsNumbered(s: Navigation): bool =
  s.views.requests.every(c => c.request >= 1 and c.request <= s.views.admitted and s.views.requests.select(other => other.request == c.request).length() == 1)
    and s.views.queue.every(request => request >= 1 and request <= s.views.admitted)
pure def alwaysViewQueueDistinct(s: Navigation): bool = s.views.queue.every(request => s.views.queue.select(other => other == request).length() == 1)
```

### A full queue drops its oldest request to admit a new one

The queue holds at most sixteen requests. Admitting a request to a full queue
drops the oldest, which is resolved as dropped and is no longer live. A new
request clears the declines recorded on every queued request, so a listener
that declined an earlier request may be offered it again.

```quint
pure val viewQueueCapacity = 16
pure def admitToQueue(queue: List[int], request: int): List[int] =
  if (queue.length() >= viewQueueCapacity) queue.tail().append(request) else queue.append(request)
pure def requestView(s: Navigation): Navigation = {
  val v = s.views
  val request = v.admitted + 1
  val full = v.queue.length() >= viewQueueCapacity
  val oldest = v.queue.nthOr(0, 0)
  val cleared = v.requests.listMap(c => if (v.queue.includes(c.request)) { ...c, declined: Set() } else c)
  val added = cleared.append({ ...emptyClaim, request: request, live: true, resolution: ClaimPending, resolutions: 0 })
  val requests = if (full) added.listMap(c => if (c.request == oldest) { ...resolveClaim(c, ClaimDropped), live: false } else c) else added
  { ...s, views: { ...v, admitted: request, queue: admitToQueue(v.queue, request), requests: requests } }
}
pure def alwaysViewQueueBounded(s: Navigation): bool = s.views.queue.length() <= viewQueueCapacity
pure def lawFullQueueDropsOldest(queue: List[int], request: int): bool =
  queue.length() >= viewQueueCapacity implies admitToQueue(queue, request) == queue.tail().append(request)
pure def lawQueueWithRoomKeepsEveryRequest(queue: List[int], request: int): bool =
  queue.length() < viewQueueCapacity implies admitToQueue(queue, request) == queue.append(request)
```

### A request is resolved at most once

Applying, rejecting or dropping resolves a request. A pending request has no
resolution; a resolved one has exactly one, and resolving it again changes
nothing. Committing a request also takes it out of the queue.

```quint
pure def resolveClaim(c: ViewClaim, result: ClaimResolution): ViewClaim =
  if (c.resolution == ClaimPending) { ...c, resolution: result, resolutions: c.resolutions + 1 } else c
pure def commitClaim(v: ViewClaims, request: int, result: ClaimResolution): ViewClaims =
  { ...withClaim(v, { ...resolveClaim(claimAt(v, request), result), claimed: true }), queue: v.queue.select(other => other != request) }
pure def alwaysViewClaimResolvedOnce(s: Navigation): bool =
  s.views.requests.every(c => c.resolutions == (if (c.resolution == ClaimPending) 0 else 1))
```

### Only a mounted listener that has not declined the head request is offered it

Each listener mounts once and can unmount. The head of the queue is offered
to an active listener only while the request is live, unclaimed, not being
applied and not declined by that listener. Each offer is a numbered attempt
that remembers the admission count at which it was made.

```quint
pure val emptyAttempt: ListenerAttempt = { attempt: 0, request: 0, listener: 0, admittedAt: 0, phase: Settled, effected: true }
pure val listenerValues = Set(1, 2)
pure val attemptValues = Set(1, 2, 3)
pure def attemptAt(v: ViewClaims, attempt: int): ListenerAttempt = v.attempts.select(a => a.attempt == attempt).nthOr(0, emptyAttempt)
pure def withAttempt(v: ViewClaims, changed: ListenerAttempt): ViewClaims = { ...v, attempts: v.attempts.listMap(a => if (a.attempt == changed.attempt) changed else a) }
pure def canMountListener(s: Navigation, listener: int): bool = not(s.views.mounted.contains(listener))
pure def mountListener(s: Navigation, listener: int): Navigation =
  { ...s, views: { ...s.views, mounted: s.views.mounted.union(Set(listener)), active: s.views.active.union(Set(listener)) } }
pure def canUnmountListener(s: Navigation, listener: int): bool = s.views.active.contains(listener)
pure def unmountListener(s: Navigation, listener: int): Navigation = { ...s, views: { ...s.views, active: s.views.active.exclude(Set(listener)) } }
pure def canInvokeListener(s: Navigation, listener: int): bool = {
  val first = claimAt(s.views, s.views.queue.nthOr(0, 0))
  s.views.queue.length() > 0 and s.views.active.contains(listener) and first.live and not(first.claimed) and not(first.applying) and not(first.declined.contains(listener))
}
pure def invokeListener(s: Navigation, listener: int): Navigation = {
  val v = s.views
  val offered = { attempt: v.attempts.length() + 1, request: v.queue.nthOr(0, 0), listener: listener, admittedAt: v.admitted, phase: Invoking, effected: false }
  { ...s, views: { ...v, attempts: v.attempts.append(offered) } }
}
```

### A listener's answer applies the request, declines it or holds it while a promise settles

A listener that returns "applied" commits the request. One that declines or
throws leaves it for another listener. One that returns a promise marks the
request as being applied until the promise settles. A settled promise
commits the request only if its listener is still mounted and it applied;
otherwise the request is released, and a listener that is still mounted and
was offered the request since the last admission is recorded as having
declined it.

```quint
type ListenerOutcome = ListenerApplied | ListenerDeclined | ListenerThrew | ListenerPromised
pure def canReturnFromListener(s: Navigation, attempt: int): bool = {
  val a = attemptAt(s.views, attempt)
  a.attempt == attempt and a.phase == Invoking
}
pure def returnFromListener(s: Navigation, attempt: int, verdict: ListenerOutcome): Navigation = {
  val a = attemptAt(s.views, attempt)
  val returned = withAttempt(s.views, { ...a, phase: if (verdict == ListenerPromised) Awaiting else Settled })
  val updated =
    if (verdict == ListenerPromised) withClaim(returned, { ...claimAt(returned, a.request), applying: true })
    else if (verdict == ListenerApplied) commitClaim(returned, a.request, ClaimApplied)
    else returned
  { ...s, views: updated }
}
pure def canSettleListener(s: Navigation, attempt: int, verdict: ListenerOutcome): bool = {
  val a = attemptAt(s.views, attempt)
  a.attempt == attempt and a.phase == Awaiting and verdict != ListenerPromised
}
pure def settleListener(s: Navigation, attempt: int, verdict: ListenerOutcome): Navigation = {
  val v = s.views
  val a = attemptAt(v, attempt)
  val c = claimAt(v, a.request)
  val stillActive = v.active.contains(a.listener)
  val declinedNow = stillActive and verdict != ListenerApplied and a.admittedAt == v.admitted
  val completed = withClaim(withAttempt(v, { ...a, phase: Settled }), { ...c, applying: false, declined: if (declinedNow) c.declined.union(Set(a.listener)) else c.declined })
  { ...s, views: if (stillActive and verdict == ListenerApplied) commitClaim(completed, a.request, ClaimApplied) else completed }
}
pure def sometimesViewRequestApplied(s: Navigation): bool = s.views.requests.some(c => c.resolution == ClaimApplied)
pure def sometimesViewRequestDeclined(s: Navigation): bool = s.views.requests.some(c => c.declined.size() > 0 and c.live)
```

### A request whose promise is still pending can be rejected

While a listener's promise holds a live, unclaimed request, the request can
be rejected. Rejecting commits it as rejected and takes it out of the queue.

```quint
pure val requestValues = Set(1, 2)
pure def canRejectView(s: Navigation, request: int): bool = {
  val c = claimAt(s.views, request)
  c.live and not(c.claimed) and c.applying
}
pure def rejectView(s: Navigation, request: int): Navigation = { ...s, views: commitClaim(s.views, request, ClaimRejected) }
pure def sometimesViewRequestRejected(s: Navigation): bool = s.views.requests.some(c => c.resolution == ClaimRejected)
```

### Every queued request is live, unclaimed and unresolved

A request leaves the queue when it is committed or dropped, so a request
still in the queue is live, has not been claimed and has no resolution.

```quint
pure def waiting(c: ViewClaim): bool = c.live and not(c.claimed) and c.resolution == ClaimPending
pure def alwaysQueuedViewRequestsWait(s: Navigation): bool = s.views.queue.every(request => waiting(claimAt(s.views, request)))
```

### A listener's partial effect counts against the request it was offered

A mounted listener can apply part of a request, once per attempt, while the
request is live and unclaimed, before its callback or its promise reports
back.

```quint
pure def canApplyViewEffect(s: Navigation, attempt: int): bool = {
  val a = attemptAt(s.views, attempt)
  val c = claimAt(s.views, a.request)
  a.attempt == attempt and (a.phase == Invoking or a.phase == Awaiting) and s.views.active.contains(a.listener) and c.live and not(c.claimed) and not(a.effected)
}
pure def applyViewEffect(s: Navigation, attempt: int): Navigation = {
  val a = attemptAt(s.views, attempt)
  val c = claimAt(s.views, a.request)
  { ...s, views: withClaim(withAttempt(s.views, { ...a, effected: true }), { ...c, effects: c.effects + 1 }) }
}
```

### A listener that unmounts while applying can leave its partial effect to be repeated

Nothing makes an arbitrary listener's effect happen exactly once: a listener
can apply part of a request and unmount before its promise settles, and the
request then stays available to the next listener, which applies it again.

```quint
pure def sometimesViewEffectRepeated(s: Navigation): bool = s.views.requests.some(c => c.effects >= 2)
```

### A promise left by an unmounted listener keeps holding its request

No settlement is assumed of a promise whose listener has unmounted: until it
settles, the request stays marked as being applied and no other listener is
offered it.

```quint
pure def sometimesUnmountedPromiseHoldsRequest(s: Navigation): bool =
  s.views.attempts.some(a => a.phase == Awaiting and not(s.views.active.contains(a.listener)) and claimAt(s.views, a.request).applying)
```
