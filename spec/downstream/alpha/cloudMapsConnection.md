# AlphaPhone Cloud Maps connection ownership

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` composes the
Eliza `c518127a025ab173874af9c7d304f26b25213b0d` Maps client through
`apps/app/src/maps/cloud-maps.ts` and
`apps/app/src/prototype/maps-adapter.ts`. The upstream producer is
`plugins/plugin-maps/src/client/{cloud-provider,cloud-session,runtime}.ts`.
[Maps planning](./maps.md) owns routes, live location, and guidance.
The pinned `MapsConnection.qnt` and its refinement drive the actual
connection and guarded coverage reader with controlled Cloud replies.

## Story: Keep Cloud Maps on the account that requested it

### The newest qualifying coverage read can install the Cloud provider

The launch reader remembers whether coverage is due when the resident
becomes ready. First opening Maps and explicit search can ask the same
guarded reader. An attempted, error-free connection, including a pending
read, keeps its current generation on a guarded read. A failed read can
retry. The explicit map-plane retry can call the initializer directly.

Initializing increments the generation, clears coverage, and releases
the previous Cloud install if this Cloud instance published one. A read
that starts signed out records unauthorized without a Cloud request.
During a read, an account change retires the generation when the Cloud
instance has already attempted configuration. A late result from a
superseded generation cannot publish coverage or change the current
diagnostics. Only a matching success with valid capabilities publishes.
The account comprises both the session and credential identities.
Changing either invalidates coverage. Replacing the client object for
the same binding keeps any current read and installed provider.

Discovered in the pinned source: the request closure checks its
generation after the Cloud reply, then returns through two asynchronous
callers. The initializer reads the response and installs it without
another generation check. A generation that changes after the request
check still requires a publication check in the replacement. The model
checks at publication so stale data cannot cross that asynchronous gap.

The machine receives guarded read requests after the host's readiness
check. It tracks only the pending generation eligible to publish.
Older requests may finish and are fenced when they report. The product
selects one provider at composition. The Cloud implementation tracks
whether its own prior install occurred, and clearing that install uses
the shared provider slot. The model assumes that composition ownership.

```quint
type MapsBinding = { session: int, credential: int, client: int }
type CoveragePhase = NeverRead | PendingCoverage | PublishedCoverage | FailedCoverage | RetiredCoverage
type CoverageReply = ValidCoverage | InvalidCoverage | CoverageUnavailable | CoverageCancelled
type MapsConnection = { binding: MapsBinding, generation: int, phase: CoveragePhase, publisher: MapsBinding }
pure val signedOut: MapsBinding = { session: 0, credential: 0, client: 0 }
pure val baselineBinding: MapsBinding = { session: 1, credential: 1, client: 1 }
pure val initial: MapsConnection = { binding: signedOut, generation: 0, phase: NeverRead, publisher: signedOut }
pure def bound(binding: MapsBinding): bool = binding.session > 0 and binding.credential > 0 and binding.client > 0
pure def sameMapsAccount(a: MapsBinding, b: MapsBinding): bool =
  bound(a) and bound(b) and a.session == b.session and a.credential == b.credential
pure def canBindMaps(s: MapsConnection, binding: MapsBinding): bool =
  binding != s.binding and (bound(binding) or binding == signedOut)
pure def bindMaps(s: MapsConnection, binding: MapsBinding): MapsConnection =
  if (sameMapsAccount(s.binding,binding) or s.phase == NeverRead) { ...s, binding: binding }
  else { ...s, binding: binding, generation: s.generation + 1, phase: RetiredCoverage, publisher: signedOut }
pure def canReadCoverage(s: MapsConnection, force: bool): bool =
  force or s.phase == NeverRead or s.phase == FailedCoverage or s.phase == RetiredCoverage
pure def readCoverage(s: MapsConnection, force: bool): MapsConnection =
  { ...s, generation: s.generation + 1, phase: if (bound(s.binding)) PendingCoverage else FailedCoverage, publisher: signedOut }
pure def canCoverageSettles(s: MapsConnection, attempt: int, reply: CoverageReply): bool =
  attempt == s.generation and s.phase == PendingCoverage
pure def coverageSettles(s: MapsConnection, attempt: int, reply: CoverageReply): MapsConnection =
  if (reply == ValidCoverage) { ...s, phase: PublishedCoverage, publisher: s.binding }
  else { ...s, phase: FailedCoverage }
pure def alwaysCoverageHasItsBinding(s: MapsConnection): bool =
  (s.phase == PendingCoverage implies bound(s.binding)) and
  (s.phase == PublishedCoverage implies sameMapsAccount(s.binding,s.publisher))
pure def lawSignedOutNeverStartsCloud(s: MapsConnection, force: bool): bool =
  not(bound(s.binding)) implies readCoverage(s,force).phase == FailedCoverage
pure def stepProviderRemovalWithBindingChange(before: MapsConnection, after: MapsConnection): bool =
  (before.phase == PublishedCoverage and not(sameMapsAccount(before.binding,after.binding))) implies after.phase != PublishedCoverage
pure def lawOlderCoverageCannotSettle(s: MapsConnection, attempt: int, reply: CoverageReply): bool =
  attempt != s.generation implies not(canCoverageSettles(s,attempt,reply))
pure def sometimesCoveragePublished(s: MapsConnection): bool = s.phase == PublishedCoverage
pure def sometimesSignedOutRead(s: MapsConnection): bool = s.phase == FailedCoverage and not(bound(s.binding))
pure def sometimesCoverageFailedAfterSignIn(s: MapsConnection): bool =
  s.phase == FailedCoverage and bound(s.binding)
pure val bindingValues = Set(signedOut, baselineBinding, { ...baselineBinding, client: 2 },
  { ...baselineBinding, credential: 2 }, { ...baselineBinding, session: 2 }, { ...baselineBinding, client: 0 })
pure val attemptValues = Set(0,1,2,3,4,5,6,7,8)
pure val replyValues = Set(ValidCoverage, InvalidCoverage, CoverageUnavailable, CoverageCancelled)
```

### Maps requests and tiles retain the captured account through completion

A provider carries a captured session and credential, and the stable
Alpha account adapter resolves the currently bound client for each
request. Refuse a missing or different binding at dispatch and again
before returning a successful result. For search, detail, routes, and
viewport copyright data, also check cancellation and the captured Cloud
generation before and after the asynchronous request.

A raster tile carries the binding captured for its coverage plane.
Its coordinates and generation must pass admission when the call begins.
The Alpha tile callback uses the active client for that same binding,
checks the binding again after the reply, then checks cancellation.
The pinned tile wrapper does not check generation again on return. A
same-account coverage refresh can therefore leave an older tile promise
eligible to resolve to its original caller. Selection of the current
plane belongs to the renderer. Coverage, tile coordinate validation,
provider response decoding, HTTP failures, and cancellation are port
observations for this rule.

```quint
type CloudReadKind = ProviderOperation | RasterTileOperation
pure def cloudReadMayStart(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, admitted: bool, aborted: bool): bool =
  sameMapsAccount(activeBinding,owner) and currentGeneration == capturedGeneration and admitted and
  (kind == RasterTileOperation or not(aborted))
pure def cloudReadMayReturn(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, loaded: bool, aborted: bool): bool =
  sameMapsAccount(activeBinding,owner) and loaded and not(aborted) and
  (kind == RasterTileOperation or currentGeneration == capturedGeneration)
pure def lawChangedAccountCannotReceiveMapData(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, loaded: bool, aborted: bool): bool =
  not(sameMapsAccount(activeBinding,owner)) implies not(cloudReadMayReturn(kind,activeBinding,owner,currentGeneration,capturedGeneration,loaded,aborted))
pure def lawRetiredProviderCannotReturn(activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, loaded: bool, aborted: bool): bool =
  currentGeneration != capturedGeneration implies not(cloudReadMayReturn(ProviderOperation,activeBinding,owner,currentGeneration,capturedGeneration,loaded,aborted))
pure def lawCancelledReadCannotReturn(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, loaded: bool): bool =
  not(cloudReadMayReturn(kind,activeBinding,owner,currentGeneration,capturedGeneration,loaded,true))
pure val activeBindingValues = bindingValues
pure val ownerValues = bindingValues
pure val currentGenerationValues = Set(0,1,2)
pure val capturedGenerationValues = currentGenerationValues
```
