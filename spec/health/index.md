# Health and activity observations

## Story: Review recorded sleep and device activity

> As the owner, I can read my recorded sleep intervals and screen activity and see which connector provided the observations.

### Interval summaries include only valid observations for the owner and requested time range

Observations use UTC milliseconds. The shell decodes provider samples and normalizes device identities and local day boundaries. It orders valid observations by start time before the model counts overlapping time once.

```quint
type ObservationKind = SleepInterval | ScreenInterval | ActivityInterval
type HealthWindow = { fromMs: int, untilMs: int }
type HealthObservation = { subjectId: str, sourceId: str, kind: ObservationKind, span: HealthWindow }
pure def validHealthWindow(window: HealthWindow): bool = window.fromMs >= 0 and window.untilMs > window.fromMs
pure def validObservation(reading: HealthObservation, ownerId: str, window: HealthWindow): bool =
  ownerId != "" and reading.subjectId == ownerId and reading.sourceId != "" and validHealthWindow(reading.span) and
  validHealthWindow(window) and reading.span.fromMs < window.untilMs and reading.span.untilMs > window.fromMs
pure def observationsFor(items: List[HealthObservation], ownerId: str, window: HealthWindow, kind: ObservationKind): List[HealthObservation] =
  items.select(reading => reading.kind == kind and validObservation(reading, ownerId, window))
pure def observedAt(items: List[HealthObservation], instant: int): bool =
  items.some(reading => reading.span.fromMs <= instant and instant < reading.span.untilMs)
pure def lawHealthObservationsBelongToRequestedOwner(items: List[HealthObservation], ownerId: str, window: HealthWindow, kind: ObservationKind): bool =
  observationsFor(items, ownerId, window, kind).every(reading => reading.subjectId == ownerId and reading.kind == kind)

type HealthCoverage = { throughMs: int, coveredMs: int }
pure def laterInstant(a: int, b: int): int = if (a > b) a else b
pure def earlierInstant(a: int, b: int): int = if (a < b) a else b
pure def extendCoverage(window: HealthWindow, totals: HealthCoverage, span: HealthWindow): HealthCoverage = {
  val startMs = laterInstant(totals.throughMs, span.fromMs)
  val endMs = earlierInstant(window.untilMs, span.untilMs)
  if (endMs <= startMs) totals
  else { throughMs: endMs, coveredMs: totals.coveredMs + endMs - startMs }
}
pure def intervalCoverage(ordered: List[HealthWindow], window: HealthWindow): int =
  ordered.foldl({ throughMs: window.fromMs, coveredMs: 0 }, (totals, span) => extendCoverage(window, totals, span)).coveredMs
```

### An inactivity signal does not count as active use

The shell maps platform classifications, explicit foreground observations and system inactivity app IDs to the signal type before deriving screen time.

```quint
type ScreenSignal = ForegroundUse | DeviceLocked | ScreenBlank | InactivityPlaceholder | UnconfirmedUse
pure def countsAsScreenUse(signal: ScreenSignal): bool = signal == ForegroundUse
pure def lawInactivityDoesNotCount(signal: ScreenSignal): bool =
  signal != ForegroundUse implies not(countsAsScreenUse(signal))
pure val itemsValues = Set(List(), List({ subjectId: "owner", sourceId: "watch", kind: SleepInterval, span: { fromMs: 20, untilMs: 90 } }, { subjectId: "other", sourceId: "watch", kind: SleepInterval, span: { fromMs: 25, untilMs: 95 } }))
pure val windowValues = Set({ fromMs: 10, untilMs: 100 }, { fromMs: 100, untilMs: 10 })
```
