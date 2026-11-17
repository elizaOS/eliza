# Device location reads

`plugin-native-location` (`plugins/plugin-native-location/src/definitions.ts`)
gives the agent and the consumer's renderer the device's position through
`getCurrentPosition`, `watchPosition`, `clearWatch`, `checkPermissions`
and `requestPermissions`. This spec owns when a position may be read and
what a reading may claim. [Maps](../../maps/index.md) uses it for
navigation; [bridge composition](./bridge.md) owns its registration.

## Story: Share my position only while I allow it

> As the person, I want the app to read where I am only while Android
> says I allowed it, and to tell me when it could not.

### A position is read only with a location grant, and a cached position is never older than asked

A read or a watch needs the location permission granted at the time of
the read; without it the call fails with `PERMISSION_DENIED` and reads
nothing. Approximate access yields only approximate positions, and a
read that asked for precise accuracy under approximate access is reported
at the accuracy it actually had. A cached position is returned only when
it is no older than the requested maximum age, and is marked cached; a
maximum age of zero always reads afresh. A read that does not finish
within its timeout fails with `TIMEOUT`.

```quint
type LocationGrant = LocationGranted | LocationPromptable | LocationDenied
type GrantAccuracy = PreciseAccess | ApproximateAccess | NoAccess
type LocationRead = PositionFresh | PositionCached | PermissionDenied | PositionTimeout | PositionUnavailable
type ReadRequest = { maxAgeMs: int, timeoutMs: int, wantsPrecise: bool }
type ReadFacts = { grant: LocationGrant, access: GrantAccuracy, cachedAgeMs: int, hasCached: bool, fixWithinMs: int, fixAvailable: bool }
pure def readLocation(request: ReadRequest, facts: ReadFacts): LocationRead =
  if (facts.grant != LocationGranted or facts.access == NoAccess) PermissionDenied
  else if (request.maxAgeMs > 0 and facts.hasCached and facts.cachedAgeMs <= request.maxAgeMs) PositionCached
  else if (not(facts.fixAvailable)) PositionUnavailable
  else if (facts.fixWithinMs > request.timeoutMs) PositionTimeout
  else PositionFresh
pure def reportedPrecise(request: ReadRequest, facts: ReadFacts): bool = request.wantsPrecise and facts.access == PreciseAccess
pure val requestValues = Set({ maxAgeMs: 0, timeoutMs: 10000, wantsPrecise: true }, { maxAgeMs: 60000, timeoutMs: 10000, wantsPrecise: false })
pure val factsValues = Set(
  { grant: LocationGranted, access: PreciseAccess, cachedAgeMs: 30000, hasCached: true, fixWithinMs: 2000, fixAvailable: true },
  { grant: LocationGranted, access: ApproximateAccess, cachedAgeMs: 90000, hasCached: true, fixWithinMs: 20000, fixAvailable: true },
  { grant: LocationPromptable, access: NoAccess, cachedAgeMs: 0, hasCached: true, fixWithinMs: 0, fixAvailable: true },
  { grant: LocationDenied, access: NoAccess, cachedAgeMs: 0, hasCached: false, fixWithinMs: 0, fixAvailable: false },
  { grant: LocationGranted, access: PreciseAccess, cachedAgeMs: 0, hasCached: false, fixWithinMs: 0, fixAvailable: false }
)
pure def lawNoReadWithoutGrant(request: ReadRequest, facts: ReadFacts): bool =
  facts.grant != LocationGranted implies readLocation(request, facts) == PermissionDenied
pure def lawCachedIsNeverTooOld(request: ReadRequest, facts: ReadFacts): bool =
  readLocation(request, facts) == PositionCached implies request.maxAgeMs > 0 and facts.cachedAgeMs <= request.maxAgeMs
pure def lawApproximateIsNeverReportedPrecise(request: ReadRequest, facts: ReadFacts): bool =
  facts.access != PreciseAccess implies not(reportedPrecise(request, facts))
```
