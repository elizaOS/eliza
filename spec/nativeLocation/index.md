# Native location

The bridge reads an immediate fix or subscribes to updates from Android's location provider.

## Story: Use a fresh device location and stop updates when I close the view

> As the person, I want location fixes to respect the selected accuracy, age and permission, and a removed watch to stop publishing.

### A fix is usable only when coordinates, accuracy and age fall within the request

The adapter parses coordinates to millionths of a degree with nonnegative horizontal accuracy. Optional altitude, speed and heading stay in the provider observation. A current fix allows zero age. A cached fix needs explicit positive age allowance.

```quint
type LocationGrant = NoLocation | ApproximateLocation | PreciseLocation
type LocationFix = {
  latitudeMillionths: int, longitudeMillionths: int, accuracyMm: int, measuredAtMs: int, fromCache: bool
}
pure def validLocationFix(fix: LocationFix): bool =
  fix.latitudeMillionths >= -90000000 and fix.latitudeMillionths <= 90000000 and
  fix.longitudeMillionths >= -180000000 and fix.longitudeMillionths <= 180000000 and
  fix.accuracyMm >= 0 and fix.measuredAtMs >= 0
pure def mayUseLocation(grant: LocationGrant, fix: LocationFix, nowMs: int, maxAgeMs: int): bool =
  grant != NoLocation and validLocationFix(fix) and nowMs >= fix.measuredAtMs and
  (not(fix.fromCache) or (maxAgeMs > 0 and nowMs - fix.measuredAtMs <= maxAgeMs))
pure def lawCachedFixNeedsAgeAllowance(grant: LocationGrant, fix: LocationFix, nowMs: int, maxAgeMs: int): bool =
  (fix.fromCache and maxAgeMs <= 0) implies not(mayUseLocation(grant, fix, nowMs, maxAgeMs))
```

### A watch reports under the identifier it acquired until that watch is cleared

```quint
type LocationWatch = { watchId: str, watching: bool }
pure val initial: LocationWatch = { watchId: "", watching: false }
pure def canRegisterWatch(s: LocationWatch, watchId: str, grant: LocationGrant): bool =
  not(s.watching) and watchId != "" and grant != NoLocation
pure def registerWatch(s: LocationWatch, watchId: str, grant: LocationGrant): LocationWatch =
  { watchId: watchId, watching: true }
pure def canClearWatch(s: LocationWatch, watchId: str): bool = s.watching and s.watchId == watchId
pure def clearWatch(s: LocationWatch, watchId: str): LocationWatch = { ...s, watching: false }
pure def mayPublishWatch(s: LocationWatch, watchId: str, grant: LocationGrant): bool =
  s.watching and s.watchId == watchId and grant != NoLocation
pure def alwaysWatchHasIdentity(s: LocationWatch): bool = s.watching implies s.watchId != ""
pure def sometimesLocationWatchRuns(s: LocationWatch): bool = s.watching
pure val watchIdValues = Set("", "first", "second")
pure val fixValues = Set(
  { latitudeMillionths: 40712800, longitudeMillionths: -74006000, accuracyMm: 12000, measuredAtMs: 1000, fromCache: true },
  { latitudeMillionths: 40712800, longitudeMillionths: -74006000, accuracyMm: 12000, measuredAtMs: 2000, fromCache: false },
  { latitudeMillionths: 90000001, longitudeMillionths: 0, accuracyMm: 12000, measuredAtMs: 2000, fromCache: false })
pure val nowMsValues = Set(0, 1000, 2000)
pure val maxAgeMsValues = Set(-1, 0, 999, 1000)
```
