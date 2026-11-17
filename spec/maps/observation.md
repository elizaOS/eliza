# Maps observation

What the agent observes of the Maps screen must be what the screen
shows now. A captured search observation names the exact search source
it saw, and it validates only while that source is unchanged. A
cancelled locate can never restore its old origin or replace a fix that
was accepted later. [Maps navigation](./navigation.md)
owns routes and guidance.

## Story: Let the agent see only what the Maps screen shows now

> As the owner, I want the agent to act on a Maps search only while the
> screen still shows the search it observed.

### A search observation validates only against the source it captured

A search source is its query, area, results, provider and readiness.
Each publication that changes any part of it advances the source
revision; publishing the same source does not. An observation captures
the source and its revision. Validation accepts it only while the screen
is open and the revision is unchanged, so an accepted observation always
matches the current source. Closing the screen retires it.

```quint
type SearchSource = { query: int, area: int, results: int, provider: int, ready: bool }
type SearchObservation = { source: SearchSource, revision: int, live: bool, captured: bool, receiptSource: SearchSource,
  receiptRevision: int, lastAccepted: bool }
type LocatePhase = OldLoading | LocateIdle | NewLoading | FixReady | LocateError
type LocateAttempt = { generation: int, cleanupPending: bool, phase: LocatePhase, accepted: bool, owner: bool }
type MapsObservation = { search: SearchObservation, locate: LocateAttempt }
pure val firstSource: SearchSource = { query: 0, area: 0, results: 0, provider: 0, ready: false }
pure val initial: MapsObservation = {
  search: { source: firstSource, revision: 0, live: true, captured: false, receiptSource: firstSource, receiptRevision: 0, lastAccepted: false },
  locate: { generation: 0, cleanupPending: false, phase: OldLoading, accepted: false, owner: true }
}
pure val nextSourceValues = Set(firstSource, { ...firstSource, area: 1 }, { ...firstSource, results: 1 },
  { ...firstSource, query: 1 }, { ...firstSource, provider: 1 }, { ...firstSource, ready: true })
pure def canPublishSource(s: MapsObservation): bool = s.search.live
pure def publishSource(s: MapsObservation, nextSource: SearchSource): MapsObservation =
  { ...s, search: { ...s.search, source: nextSource, revision: s.search.revision + (if (nextSource == s.search.source) 0 else 1) } }
pure def canCaptureObservation(s: MapsObservation): bool = s.search.live and not(s.search.captured)
pure def captureObservation(s: MapsObservation): MapsObservation =
  { ...s, search: { ...s.search, captured: true, receiptSource: s.search.source, receiptRevision: s.search.revision } }
pure def canValidateObservation(s: MapsObservation): bool = s.search.captured
pure def validateObservation(s: MapsObservation): MapsObservation =
  { ...s, search: { ...s.search, lastAccepted: s.search.live and s.search.receiptRevision == s.search.revision } }
pure def canCloseScreen(s: MapsObservation): bool = s.search.live
pure def closeScreen(s: MapsObservation): MapsObservation = { ...s, search: { ...s.search, live: false } }
pure def alwaysRevisionTracksSource(s: MapsObservation): bool =
  s.search.receiptRevision <= s.search.revision and
  (s.search.receiptRevision == s.search.revision implies s.search.receiptSource == s.search.source or not(s.search.captured))
pure def stepAcceptedObservationMatchesSource(before: MapsObservation, via: str, after: MapsObservation): bool =
  via == "validateObservation" and after.search.lastAccepted implies after.search.receiptSource == after.search.source
pure def sometimesObservationAccepted(s: MapsObservation): bool = s.search.lastAccepted and s.search.revision == 0
pure def sometimesChangedSourceRefused(s: MapsObservation): bool = s.search.captured and not(s.search.lastAccepted) and s.search.revision > s.search.receiptRevision
```

## Story: Locate me without an old locate getting in the way

> As the owner, I want a locate I cancelled to stay cancelled, and a fix
> I accepted to stay, whatever the old locate's cleanup reports later.

### A cancelled locate cannot restore its origin or replace a later fix

Cancelling the first locate retires it and starts its native cleanup.
The owner may then locate again or type an origin. A fix accepted by
the new locate stays accepted, and only the new locate's fix is ever
ready. A late fix from the cancelled locate changes nothing, and a failed
cleanup shows an error only while the cancelled locate is still the
latest thing the owner did.

```quint
pure def canCancelLocate(s: MapsObservation): bool = s.locate.owner and s.locate.phase == OldLoading
pure def cancelLocate(s: MapsObservation): MapsObservation =
  { ...s, locate: { ...s.locate, generation: 1, cleanupPending: true, phase: LocateIdle } }
pure def canLocateAgain(s: MapsObservation): bool = s.locate.owner and s.locate.generation == 1
pure def locateAgain(s: MapsObservation): MapsObservation = { ...s, locate: { ...s.locate, generation: 2, phase: NewLoading } }
pure def canTypeOrigin(s: MapsObservation): bool = s.locate.owner and s.locate.generation == 1
pure def typeOrigin(s: MapsObservation): MapsObservation = { ...s, locate: { ...s.locate, generation: 2, phase: LocateIdle } }
pure def canAcceptFix(s: MapsObservation): bool = s.locate.owner and s.locate.phase == NewLoading
pure def acceptFix(s: MapsObservation): MapsObservation =
  { ...s, locate: { ...s.locate, generation: 3, phase: FixReady, accepted: true } }
pure def canCleanupDone(s: MapsObservation): bool = s.locate.cleanupPending
pure def cleanupDone(s: MapsObservation): MapsObservation = { ...s, locate: { ...s.locate, cleanupPending: false } }
pure def canCleanupFailed(s: MapsObservation): bool = s.locate.cleanupPending
pure def cleanupFailed(s: MapsObservation): MapsObservation =
  { ...s, locate: { ...s.locate, cleanupPending: false,
    phase: if (s.locate.owner and s.locate.generation == 1) LocateError else s.locate.phase } }
pure def canLeaveMaps(s: MapsObservation): bool = s.locate.owner
pure def leaveMaps(s: MapsObservation): MapsObservation = { ...s, locate: { ...s.locate, owner: false } }
pure def alwaysAcceptedFixIsPreserved(s: MapsObservation): bool = (s.locate.accepted implies s.locate.phase == FixReady) and (s.locate.phase == FixReady implies s.locate.generation == 3)
pure def alwaysCleanupErrorBelongsToCancelledLocate(s: MapsObservation): bool = s.locate.phase == LocateError implies s.locate.generation == 1
pure def stepReadyStaysReady(before: MapsObservation, after: MapsObservation): bool =
  before.locate.phase == FixReady implies after.locate.phase == FixReady
pure def sometimesFixSurvivesCleanup(s: MapsObservation): bool = s.locate.accepted and not(s.locate.cleanupPending) and s.locate.generation == 3
pure def sometimesCleanupError(s: MapsObservation): bool = s.locate.phase == LocateError
pure val fair_cleanupDone = "weak"
pure def leadsToCleanupSettles(s: MapsObservation, later: MapsObservation): bool =
  s.locate.cleanupPending implies not(later.locate.cleanupPending)
```
