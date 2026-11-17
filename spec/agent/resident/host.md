# Resident agent host on Android

`plugin-native-agent` hosts the resident agent runtime in the consumer's
Android app: the embedded runtime service, its single provider slot, the
credential shutdown lease, the owner-route gate for renderer requests and
the renderer's pending requests (`plugins/plugin-native-agent/android`,
`runtime/` and `connection/`). The agent's [resident](./index.md)
specs own which resident runs and when it adopts a credential; this spec
owns the Android host's custody around them.

## Story: Change the agent's provider credential without two runtimes using it

> As the owner, I want a provider key I choose stored in one place, and
> the old runtime stopped before the new key is written, so no runtime
> runs on a credential that changed under it.

### A credential change stops the runtime under its own shutdown lease, and nothing restarts while a stop is pending

Each credential mutation acquires its own shutdown request, newer than
every earlier one. While a stop is pending the runtime cannot start. The
service acknowledges the stop only after its process and socket inventory
finished; an acknowledgement for an older request is ignored, and an
acknowledgement alone does not admit another launch. Only the current,
confirmed request releases the lease, after the mutation committed or was
cancelled before committing.

```quint
type HostRequest = { id: int, browser: bool, launched: bool, paused: bool, cancelled: bool, settled: bool, resolved: bool }
type ResidentHost = { sequence: int, stopPending: bool, stopConfirmed: bool, runtimeRunning: bool,
  provider: str, providerWrites: int, requests: List[HostRequest] }
pure val initial: ResidentHost = { sequence: 0, stopPending: false, stopConfirmed: false, runtimeRunning: true,
  provider: "", providerWrites: 0, requests: List() }
pure def acquireShutdown(s: ResidentHost): ResidentHost = { ...s, sequence: s.sequence + 1, stopPending: true, stopConfirmed: false }
pure def canAcknowledgeShutdown(s: ResidentHost, request: int, stopped: bool): bool = s.stopPending and request == s.sequence and not(s.stopConfirmed)
pure def acknowledgeShutdown(s: ResidentHost, request: int, stopped: bool): ResidentHost =
  { ...s, stopConfirmed: stopped, runtimeRunning: s.runtimeRunning and not(stopped) }
pure def canReleaseShutdown(s: ResidentHost, request: int): bool = s.stopPending and request == s.sequence and s.stopConfirmed
pure def releaseShutdown(s: ResidentHost, request: int): ResidentHost = { ...s, stopPending: false, stopConfirmed: false }
pure def canStartRuntime(s: ResidentHost): bool = not(s.stopPending) and not(s.runtimeRunning)
pure def startRuntime(s: ResidentHost): ResidentHost = { ...s, runtimeRunning: true }
pure val requestValues = Set(0, 1, 2, 3)
pure def alwaysRuntimeNeverRunsUnderPendingStop(s: ResidentHost): bool = s.stopConfirmed implies s.stopPending and not(s.runtimeRunning)
pure def stepNoStartWhileStopPending(before: ResidentHost, after: ResidentHost): bool =
  after.runtimeRunning and not(before.runtimeRunning) implies not(before.stopPending)
pure def sometimesRestartAfterRelease(s: ResidentHost): bool = s.sequence > 0 and not(s.stopPending) and s.runtimeRunning
```

### The provider slot changes only by a confirmed compare-and-exchange while the runtime is stopped

The resident agent's provider credential lives in one encrypted slot. A
write names the value it read just before and the selection; it commits
only when the slot still holds that value, the caller's credential intent
is still current under the store's lock, and the read-back returns the
selection. Otherwise the slot is unchanged and the write fails, never a
silent success. A write happens only while the credential's shutdown lease
is confirmed, so no runtime reads the slot as it changes. The slot's key
is never returned to the renderer.

```quint
pure def canWriteProvider(s: ResidentHost, expected: str, selection: str, intentCurrent: bool, readbackMatches: bool): bool =
  s.stopPending and s.stopConfirmed
pure def writeProvider(s: ResidentHost, expected: str, selection: str, intentCurrent: bool, readbackMatches: bool): ResidentHost =
  if (intentCurrent and expected == s.provider and readbackMatches) { ...s, provider: selection, providerWrites: s.providerWrites + 1 } else s
pure val expectedValues = Set("", "key1")
pure val selectionValues = Set("key1", "key2")
pure def stepProviderChangesOnlyStopped(before: ResidentHost, via: str, after: ResidentHost): bool =
  after.provider != before.provider implies via == "writeProvider" and before.stopConfirmed and not(before.runtimeRunning)
pure def sometimesProviderReplaced(s: ResidentHost): bool = s.providerWrites > 1
```

## Story: Let my app's screens reach only the agent routes they are meant to

> As the owner, I want the app's renderer to reach the agent only through
> the routes the consumer declared, so a page cannot ask the agent for
> something else.

### A renderer request is admitted only by the longest claiming prefix's own routes

The consumer ships one owner-route table, read by both the native gate and
the renderer. A group claims every path equal to one of its prefixes or
under it; the longest claiming prefix wins, and a path that group claims
but none of its routes match is refused. Before any route is consulted,
a request is refused when its path is longer than 2,048 characters, does
not start with one slash or starts with two, contains a refused
character, a malformed escape or a dot segment, or repeats or adds an
undeclared query key. A table that cannot be loaded refuses every
request, and a later request loads it again.

```quint
type RoutePath = { length: int, singleLeadingSlash: bool, unsafeCharacter: bool, malformedEscape: bool, dotSegment: bool, queryKeysDeclared: bool }
type RouteClaim = { claimed: bool, routeMatches: bool }
pure val ownerRoutePathLimit = 2048
pure def wellFormedRoute(path: RoutePath): bool =
  path.length > 0 and path.length <= ownerRoutePathLimit and path.singleLeadingSlash and not(path.unsafeCharacter) and
    not(path.malformedEscape) and not(path.dotSegment) and path.queryKeysDeclared
pure def ownerRouteAllowed(tableLoaded: bool, path: RoutePath, longestClaim: RouteClaim): bool =
  tableLoaded and wellFormedRoute(path) and longestClaim.claimed and longestClaim.routeMatches
pure val goodRoute: RoutePath = { length: 24, singleLeadingSlash: true, unsafeCharacter: false, malformedEscape: false, dotSegment: false, queryKeysDeclared: true }
pure val longestClaimValues = Set({ claimed: true, routeMatches: true }, { claimed: true, routeMatches: false }, { claimed: false, routeMatches: false })
pure val pathValues = Set(goodRoute, { ...goodRoute, length: 2049 }, { ...goodRoute, dotSegment: true }, { ...goodRoute, singleLeadingSlash: false }, { ...goodRoute, queryKeysDeclared: false })
pure def lawUnloadedTableRefuses(path: RoutePath, longestClaim: RouteClaim): bool = not(ownerRouteAllowed(false, path, longestClaim))
pure def lawClaimedButUnmatchedIsRefused(tableLoaded: bool, path: RoutePath): bool =
  not(ownerRouteAllowed(tableLoaded, path, { claimed: true, routeMatches: false }))
pure def lawMalformedPathRefusedFirst(tableLoaded: bool, path: RoutePath, longestClaim: RouteClaim): bool =
  not(wellFormedRoute(path)) implies not(ownerRouteAllowed(tableLoaded, path, longestClaim))
```

## Story: Finish a sign-in in the browser and come back to the same request

> As the owner, I want a sign-in that opens the browser to finish once
> when I come back, and to stay pending while the app is paused.

### Each pending request has its own id, and a browser handoff settles once, only after the browser opened and I returned

A renderer request registers under an id no active request uses.
Cancelling a request disconnects its open connection and settles it. A
browser handoff is launched once unless already cancelled; pausing the
app keeps every pending request, and returning to the foreground resolves
a handoff only when its browser was actually launched and paused the app,
and a resolved handoff is settled and never cancelled. A settled request
never settles again.

```quint
pure def activeRequest(s: ResidentHost, id: int): bool = s.requests.some(r => r.id == id and not(r.settled))
pure def canRegisterRequest(s: ResidentHost, id: int, browser: bool): bool = id > 0 and not(activeRequest(s, id))
pure def registerRequest(s: ResidentHost, id: int, browser: bool): ResidentHost =
  { ...s, requests: s.requests.select(r => r.id != id).append({ id: id, browser: browser, launched: false, paused: false, cancelled: false, settled: false, resolved: false }) }
pure def canLaunchBrowser(s: ResidentHost, id: int): bool = s.requests.some(r => r.id == id and r.browser and not(r.launched) and not(r.settled))
pure def launchBrowser(s: ResidentHost, id: int): ResidentHost =
  { ...s, requests: s.requests.listMap(r => if (r.id == id) { ...r, launched: true } else r) }
pure def pauseApp(s: ResidentHost): ResidentHost =
  { ...s, requests: s.requests.listMap(r => if (r.browser and r.launched and not(r.settled)) { ...r, paused: true } else r) }
pure def returnToApp(s: ResidentHost): ResidentHost =
  { ...s, requests: s.requests.listMap(r => if (r.browser and r.launched and r.paused and not(r.cancelled) and not(r.settled)) { ...r, settled: true, resolved: true } else r) }
pure def canCancelRequest(s: ResidentHost, id: int): bool = activeRequest(s, id)
pure def cancelRequest(s: ResidentHost, id: int): ResidentHost =
  { ...s, requests: s.requests.listMap(r => if (r.id == id and not(r.settled)) { ...r, cancelled: true, settled: true } else r) }
pure val idValues = Set(1, 2)
pure def alwaysRequestIdsUnique(s: ResidentHost): bool = s.requests.every(r => s.requests.select(q => q.id == r.id).length() == 1)
pure def alwaysResolvedHandoffWasLaunchedAndPaused(s: ResidentHost): bool =
  s.requests.every(r => r.resolved implies r.browser and r.launched and r.paused and not(r.cancelled) and r.settled)
pure def stepSettledStaysSettled(before: ResidentHost, via: str, after: ResidentHost): bool =
  via != "registerRequest" implies before.requests.every(r => not(r.settled) or after.requests.includes(r))
pure def stepPauseKeepsPendingRequests(before: ResidentHost, via: str, after: ResidentHost): bool =
  via == "pauseApp" implies before.requests.every(r => r.settled or after.requests.some(q => q.id == r.id and not(q.settled)))
pure def sometimesHandoffResolved(s: ResidentHost): bool = s.requests.some(r => r.resolved)
pure def sometimesCancelledHandoff(s: ResidentHost): bool = s.requests.some(r => r.browser and r.cancelled)
```
