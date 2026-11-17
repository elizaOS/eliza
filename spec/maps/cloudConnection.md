# Cloud Maps connection ownership

The maps client reaches its provider through the owner's Cloud account.
The Cloud side is [Cloud maps](../cloud/index.md). [Maps planning](./navigation.md)
owns routes, live location, and guidance.
[Request pauses](./requests.md) and [attribution](./attribution.md)
cover what the connected provider returns.

## Story: Keep Cloud Maps on the account that requested it

> As the owner, I want map data I see to come from the account I am signed
> in as, and never to arrive for an account I have left.

### The newest qualifying coverage read can install the Cloud provider

Opening Maps or searching reads the provider's coverage once per
generation; a pending or successful read is kept, a failed one can be
retried, and an explicit retry starts a new read.

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

Coverage is published only after a generation check at publication
itself, so no stale reply crosses an asynchronous gap. Older requests may
finish and are fenced when they report.

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

A provider carries a captured session and credential and resolves the
currently bound client for each request. Refuse a missing or different binding at dispatch and again
before returning a successful result. For search, detail, routes, and
viewport copyright data, also check cancellation and the captured Cloud
generation before and after the asynchronous request.

A raster tile carries the binding and generation captured for its
coverage plane, which must pass admission when the call begins. On
return it checks the binding, the coverage generation and cancellation
again, so a coverage refresh retires every older tile request.

```quint
type CloudReadKind = ProviderOperation | RasterTileOperation
pure def cloudReadMayStart(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, admitted: bool, aborted: bool): bool =
  sameMapsAccount(activeBinding,owner) and currentGeneration == capturedGeneration and admitted and
  (kind == RasterTileOperation or not(aborted))
pure def cloudReadMayReturn(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, loaded: bool, aborted: bool): bool =
  sameMapsAccount(activeBinding,owner) and loaded and not(aborted) and currentGeneration == capturedGeneration
pure def lawChangedAccountCannotReceiveMapData(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, loaded: bool, aborted: bool): bool =
  not(sameMapsAccount(activeBinding,owner)) implies not(cloudReadMayReturn(kind,activeBinding,owner,currentGeneration,capturedGeneration,loaded,aborted))
pure def lawRetiredProviderCannotReturn(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, loaded: bool, aborted: bool): bool =
  currentGeneration != capturedGeneration implies not(cloudReadMayReturn(kind,activeBinding,owner,currentGeneration,capturedGeneration,loaded,aborted))
pure def lawCancelledReadCannotReturn(kind: CloudReadKind, activeBinding: MapsBinding, owner: MapsBinding, currentGeneration: int, capturedGeneration: int, loaded: bool): bool =
  not(cloudReadMayReturn(kind,activeBinding,owner,currentGeneration,capturedGeneration,loaded,true))
pure val activeBindingValues = bindingValues
pure val ownerValues = bindingValues
pure val currentGenerationValues = Set(0,1,2)
pure val capturedGenerationValues = currentGenerationValues
```
