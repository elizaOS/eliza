# Android sign-in requests

The renderer's request broker owns one open sign-in request at a time and
the native return for it, so a result reaches only the sign-in that asked
for it. The native screens and their code worker are
[Android sign-in](./signIn.md).

## Story: Return a native result only to the renderer request that asked for it

> As a person signing in, I want the result of the native screens to reach
> the sign-in I started, even if the app view was re-created meanwhile,
> and never a sign-in I abandoned.

### One renderer request is open at a time, and a retired request cannot settle

A request takes a fresh id and names its deployment and port. A second
request for the same deployment and port joins the open one; another pair
is refused as busy without taking an id. Settling or abandoning closes the
request. An activation callback that finishes after its request was
retired, or after it was aborted, settles nothing: the caller retries with
a fresh signal on the same request.

```quint
type BrokerOutcome = RequestPending | RequestResolved | RequestRejected
type CallbackState = CallbackIdle | CallbackRunning | CallbackAborted
type BrokerRequest = { id: int, key: str, verdict: BrokerOutcome, callback: CallbackState }
type RouteKind = NoRoute | JoinRoute | BusyRoute | ColdRoute | ViewRoute | RetainRoute
type Route = { kind: RouteKind, source: str, ownerKey: str }
type SignInRequests = { issued: int, owner: int, ownerKey: str, requests: List[BrokerRequest], subscribed: bool, retained: bool, route: Route, staleSettled: bool }
pure val noRoute: Route = { kind: NoRoute, source: "", ownerKey: "" }
pure val initial: SignInRequests = { issued: 0, owner: 0, ownerKey: "", requests: List(), subscribed: false, retained: false, route: noRoute, staleSettled: false }
pure val keyValues = Set("production:A", "staging:A", "production:B", "production:default")
pure val idValues = Set(1, 2, 3)
pure def requestAt(b: SignInRequests, id: int): BrokerRequest =
  b.requests.select(r => r.id == id).nthOr(0, { id: 0, key: "", verdict: RequestRejected, callback: CallbackIdle })
pure def withRequest(id: int, update: BrokerRequest, b: SignInRequests): SignInRequests =
  { ...b, requests: b.requests.listMap(r => if (r.id == id) update else r) }
pure def closedRequest(id: int, verdict: BrokerOutcome, b: SignInRequests): SignInRequests =
  if (b.owner == id) { ...withRequest(id, { ...requestAt(b, id), verdict: verdict }, b), owner: 0, ownerKey: "", subscribed: false, retained: false }
  else b
pure def canOpenRequest(s: SignInRequests, key: str): bool = s.owner == 0 and key != ""
pure def openRequest(s: SignInRequests, key: str): SignInRequests = { ...s, issued: s.issued + 1, owner: s.issued + 1, ownerKey: key,
  requests: s.requests.append({ id: s.issued + 1, key: key, verdict: RequestPending, callback: CallbackIdle }) }
pure def canRequestWhileOpen(s: SignInRequests): bool = s.owner != 0
pure def requestWhileOpen(s: SignInRequests, key: str): SignInRequests =
  { ...s, route: { kind: if (key == s.ownerKey) JoinRoute else BusyRoute, source: key, ownerKey: s.ownerKey } }
pure def canResolve(s: SignInRequests, id: int, resolved: bool): bool = s.owner == id
pure def resolve(s: SignInRequests, id: int, resolved: bool): SignInRequests =
  closedRequest(id, if (resolved) RequestResolved else RequestRejected, s)
pure def canBeginActivation(s: SignInRequests, id: int): bool = s.owner == id and requestAt(s, id).callback == CallbackIdle
pure def beginActivation(s: SignInRequests, id: int): SignInRequests = withRequest(id, { ...requestAt(s, id), callback: CallbackRunning }, s)
pure def canCancelActivation(s: SignInRequests, id: int): bool = requestAt(s, id).callback == CallbackRunning
pure def cancelActivation(s: SignInRequests, id: int): SignInRequests = withRequest(id, { ...requestAt(s, id), callback: CallbackAborted }, s)
pure def canFinishActivation(s: SignInRequests, id: int): bool = requestAt(s, id).id == id and requestAt(s, id).callback != CallbackIdle
pure def finishActivation(s: SignInRequests, id: int, accepted: bool): SignInRequests = {
  val retiredRequest = s.owner != id or requestAt(s, id).callback == CallbackAborted
  val finished = withRequest(id, { ...requestAt(s, id), callback: CallbackIdle }, s)
  val updated = if (accepted and not(retiredRequest)) closedRequest(id, RequestResolved, finished) else finished
  { ...updated, staleSettled: s.staleSettled or (retiredRequest and requestAt(updated, id).verdict != requestAt(s, id).verdict) }
}
pure def alwaysOneOpenRequest(s: SignInRequests): bool =
  s.requests.every(r => (r.verdict == RequestPending) == (r.id == s.owner)) and s.requests.length() == s.issued and
    s.requests.every(r => r.id >= 1 and r.id <= s.issued and s.requests.select(o => o.id == r.id).length() == 1) and
    ((s.owner == 0 and s.ownerKey == "") or (s.owner >= 1 and s.owner <= s.issued and s.ownerKey != ""))
pure def alwaysRetiredRequestCannotSettle(s: SignInRequests): bool = not(s.staleSettled)
pure def sometimesRetiredCallbackFinished(s: SignInRequests): bool = s.issued == 2 and requestAt(s, 1).verdict == RequestRejected and s.owner == 2
```

### A native return reaches only the open request with the matching deployment and port

The native event arrives already parsed for the listener's deployment and
always names one; an omitted port joins only another omitted port and its
events arrive on the default port. A matching return goes to the subscribed view, or is
held until the view subscribes; a return for another deployment or port is
a cold return and never reaches the open request.

```quint
pure val sourceValues = Set("production:A", "staging:A", "production:B")
pure def eventKey(key: str): str = if (key == "production:default") "production:A" else key
pure def canNativeReturn(s: SignInRequests, source: str): bool = source != ""
pure def nativeReturn(s: SignInRequests, source: str): SignInRequests = {
  val expected = eventKey(s.ownerKey)
  val kind = if (not(s.owner != 0 and source == expected)) ColdRoute else if (s.subscribed) ViewRoute else RetainRoute
  { ...s, retained: s.retained or kind == RetainRoute, route: { kind: kind, source: source, ownerKey: expected } }
}
pure def canSubscribe(s: SignInRequests, id: int): bool = s.owner == id
pure def subscribe(s: SignInRequests, id: int): SignInRequests = { ...s, subscribed: true, retained: false,
  route: if (s.retained) { kind: ViewRoute, source: eventKey(s.ownerKey), ownerKey: eventKey(s.ownerKey) } else s.route }
pure def canUnsubscribe(s: SignInRequests, id: int): bool = s.owner == id
pure def unsubscribe(s: SignInRequests, id: int): SignInRequests = { ...s, subscribed: false }
pure def alwaysReturnUsesMatchingOwner(s: SignInRequests): bool =
  ((s.route.kind == ViewRoute or s.route.kind == RetainRoute or s.route.kind == JoinRoute) implies s.route.source == s.route.ownerKey) and
    ((s.route.kind == ColdRoute or s.route.kind == BusyRoute) implies s.route.source != s.route.ownerKey) and
    (s.retained implies (s.owner != 0 and not(s.subscribed)))
pure def sometimesRetainedReturnDelivered(s: SignInRequests): bool = s.route.kind == ViewRoute and s.subscribed
```
