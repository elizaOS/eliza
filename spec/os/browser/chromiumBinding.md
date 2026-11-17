# Chromium binding and trust lifecycle

The consumer's resident runtime service binds and warms the owned Chromium
browser it guides websites in, only from the expected package and signer.
The service pins the binding for its lifetime and each browser task holds
it, so a binding nobody pins or holds is released once idle. A consumer
whose browser runs only in the native tab host's WebView surfaces does not
use this binding.

## Story: Keep the trusted browser available while the resident runtime serves

> As a consumer's resident runtime, I want the trusted browser bound and
> warmed only from the expected package and signer, so that website
> guidance never drives an impostor browser.

### Android binds and warms only the expected package and signer

Unsupported or untrusted bind evidence leaves the connection
unavailable. A refused bind, null binding or binding death schedules
retry with delay doubling from one second to a 30-second maximum.
A security denial leaves no retry. A normal service disconnect
retains Android's binding for reconnect. A connected callback
rechecks package and certificate. A mismatched callback closes the
owner, as closing the binding does, dropping every waiting ready
callback and any pending idle release. A trusted warmup result resets
retry delay even if warmup was not accepted. Warmup never opens an
activity, debugging port or URL. A bind is attempted only while
something pins or holds the binding, and a trusted connection fires
every ready callback waiting for it (below).

```quint
type BindResult = BindAccepted | BindRefused | BindDenied | BindUntrusted
type BindingDemand = { pinned: bool, acquired: Set[int], open: Set[int], registered: Set[int], fired: Set[int], waiting: List[int], idle: bool }
type BrowserBinding = { bound: bool, connected: bool, closed: bool, retryPending: bool, retryDelay: int, warmed: bool, demand: BindingDemand }
pure val noDemand: BindingDemand = { pinned: true, acquired: Set(), open: Set(), registered: Set(), fired: Set(), waiting: List(), idle: false }
pure val initial: BrowserBinding = {bound: false, connected: false, closed: false, retryPending: false, retryDelay: 1000, warmed: false, demand: noDemand}
pure def increaseDelay(millis: int): int = if (millis >= 15000) 30000 else millis * 2
pure def canTryBinding(b: BrowserBinding): bool = not(b.bound) and not(b.closed) and wanted(b)
pure def tryBinding(b: BrowserBinding, bindResult: BindResult): BrowserBinding =
  if (bindResult == BindAccepted) {...b, bound: true, retryPending: false}
  else if (bindResult == BindRefused) {...b, retryPending: true, retryDelay: increaseDelay(b.retryDelay)}
  else {...b, retryPending: false}
pure def canConnected(b: BrowserBinding): bool = b.bound and not(b.closed)
pure def connected(b: BrowserBinding, identityMatches: bool, acceptedWarmup: bool): BrowserBinding =
  if (identityMatches) {...b, connected: true, retryDelay: 1000, warmed: acceptedWarmup, demand: { ...b.demand, fired: b.demand.fired.union(b.demand.waiting.foldl(Set(), (ids, id) => ids.union(Set(id)))), waiting: List() }}
  else closeBinding(b)
pure def canDisconnected(b: BrowserBinding): bool = b.bound and not(b.closed)
pure def disconnected(b: BrowserBinding): BrowserBinding = {...b, connected: false, warmed: false}
pure def canLostBinding(b: BrowserBinding): bool = b.bound and not(b.closed)
pure def lostBinding(b: BrowserBinding): BrowserBinding =
  {...b, bound: false, connected: false, warmed: false, retryPending: true, retryDelay: increaseDelay(b.retryDelay)}
pure def canCloseBinding(b: BrowserBinding): bool = not(b.closed)
pure def closeBinding(b: BrowserBinding): BrowserBinding =
  {...b, closed: true, bound: false, connected: false, warmed: false, retryPending: false, demand: { ...b.demand, waiting: List(), idle: false }}
pure def alwaysBrowserClosedReleases(b: BrowserBinding): bool =
  b.closed implies not(b.bound) and not(b.connected) and not(b.retryPending) and not(b.warmed)
pure def alwaysBrowserReadinessHasBinding(b: BrowserBinding): bool =
  (b.connected implies b.bound and not(b.closed)) and (b.warmed implies b.connected)
pure def alwaysRetryDelayBounded(b: BrowserBinding): bool = b.retryDelay >= 1000 and b.retryDelay <= 30000
pure def stepClosedBindingStaysClosed(before: BrowserBinding, after: BrowserBinding): bool = before.closed implies after.closed
pure def sometimesTrustedBrowserWarmed(b: BrowserBinding): bool = b.warmed
pure def sometimesBindRetryScheduled(b: BrowserBinding): bool = b.retryPending and b.retryDelay > 1000
```

## Story: Bind the trusted browser only while something holds it

> As the person, I want the browser binding held while the resident
> runtime or a browser task needs it, and released once nothing does, so
> that an idle phone does not keep a browser service alive.

### Each ready callback fires at most once, and only for an open hold that registered it

Holds are acquired once each and counted. A hold registers one ready
callback; registered before the connection is ready, it waits, and the
trusted connection fires every waiting callback once. Closing a hold drops
its waiting callback, and closing the binding drops them all.

```quint
pure def wanted(b: BrowserBinding): bool = b.demand.pinned or b.demand.open.size() > 0
pure def canAcquireHold(b: BrowserBinding, holdId: int): bool = holdId > 0 and not(b.demand.acquired.contains(holdId))
pure def acquireHold(b: BrowserBinding, holdId: int): BrowserBinding =
  if (b.closed) { ...b, demand: { ...b.demand, acquired: b.demand.acquired.union(Set(holdId)) } }
  else { ...b, demand: { ...b.demand, acquired: b.demand.acquired.union(Set(holdId)), open: b.demand.open.union(Set(holdId)), idle: false } }
pure def canRegisterReady(b: BrowserBinding, holdId: int): bool = b.demand.acquired.contains(holdId) and not(b.demand.registered.contains(holdId))
pure def registerReady(b: BrowserBinding, holdId: int): BrowserBinding = {
  val marked = { ...b.demand, registered: b.demand.registered.union(Set(holdId)) }
  if (b.closed or not(b.demand.open.contains(holdId))) { ...b, demand: marked }
  else if (b.connected) { ...b, demand: { ...marked, fired: marked.fired.union(Set(holdId)) } }
  else { ...b, demand: { ...marked, waiting: marked.waiting.append(holdId) } }
}
pure def canReleaseHold(b: BrowserBinding, holdId: int): bool = b.demand.open.contains(holdId)
pure def releaseHold(b: BrowserBinding, holdId: int): BrowserBinding = {
  val remaining = b.demand.open.exclude(Set(holdId))
  { ...b, demand: { ...b.demand, open: remaining, waiting: b.demand.waiting.select(id => id != holdId), idle: b.demand.idle or (not(b.closed) and not(b.demand.pinned) and remaining.size() == 0) } }
}
pure def alwaysCallbackCustody(b: BrowserBinding): bool =
  b.demand.fired.subseteq(b.demand.registered) and b.demand.registered.subseteq(b.demand.acquired) and
  b.demand.open.subseteq(b.demand.acquired) and b.demand.waiting.every(id => b.demand.open.contains(id) and b.demand.registered.contains(id) and not(b.demand.fired.contains(id))) and
  b.demand.waiting.every(id => b.demand.waiting.select(other => other == id).length() == 1)
pure def alwaysClosedBindingHasNoWaiters(b: BrowserBinding): bool = b.closed implies b.demand.waiting.length() == 0 and not(b.demand.idle)
pure def stepCallbackFiresOnce(before: BrowserBinding, after: BrowserBinding): bool = before.demand.fired.subseteq(after.demand.fired)
pure def sometimesWaitingCallbackFired(b: BrowserBinding): bool = b.demand.fired.size() > 0 and b.demand.open.size() > 0
pure val holdIdValues = Set(1, 2)
```

### A binding nobody pins or holds is released once idle

The resident service pins the binding for its lifetime and unpins it on
shutdown. When the last hold closes and nothing pins the binding, it
becomes idle; the idle release unbinds it and cancels any retry unless a
new hold or pin arrived first. A connection reported after that release
is ignored, because nothing is bound.

```quint
pure def canUnpin(b: BrowserBinding): bool = b.demand.pinned and not(b.closed)
pure def unpin(b: BrowserBinding): BrowserBinding = { ...b, demand: { ...b.demand, pinned: false, idle: b.demand.idle or b.demand.open.size() == 0 } }
pure def canPin(b: BrowserBinding): bool = not(b.demand.pinned) and not(b.closed)
pure def pin(b: BrowserBinding): BrowserBinding = { ...b, demand: { ...b.demand, pinned: true, idle: false } }
pure def canIdleRelease(b: BrowserBinding): bool = b.demand.idle
pure def idleRelease(b: BrowserBinding): BrowserBinding =
  if (b.closed or wanted(b)) { ...b, demand: { ...b.demand, idle: false } }
  else { ...b, bound: false, connected: false, warmed: false, retryPending: false, retryDelay: 1000, demand: { ...b.demand, idle: false } }
pure def stepIdleReleaseUnbindsUnwanted(before: BrowserBinding, via: str, after: BrowserBinding): bool =
  via == "idleRelease" and not(wanted(before)) and not(before.closed) implies not(after.bound) and not(after.retryPending)
pure def sometimesIdleReleased(b: BrowserBinding): bool = not(b.demand.pinned) and b.demand.acquired.size() > 0 and not(b.bound) and not(b.closed)
```
