# Inference timing observations

The source is `packages/core/src/inference-timing.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. Time values in this model are
integer clock units. The public API's fractional milliseconds, clock reads,
trace-ID validation and decimal formatting retain their explicit numeric
adapter contracts in the baseline. Missing observations remain missing.

## Story: Measure a turn without changing its execution

As an operator, I collect spans and first-occurrence marks, retain the first
provider attribution, and close a timer idempotently. A span closer can run
once. Recording remains allowed after the timer's first close, matching the
source's snapshot behavior. Closing again retains the original close time.

### A timer starts with no invented marks or provider attribution

```quint
type Metric = MissingMetric | Measured({ amount: int })
type Span = { name: str, startedAt: int, endedAt: int, duration: int }
type SpanCloser = { id: str, name: str, startedAt: int, closed: bool }
type TimingMark = { name: str, at: int }
type Timer = { started: bool, now: int, t0: int, closed: bool, closedAt: int, maxSpans: int, spans: List[Span], closers: List[SpanCloser], marks: List[TimingMark], provider: str, capReached: bool, duplicateMarks: int }
pure val initial: Timer = { started: false, now: 0, t0: 0, closed: false, closedAt: 0, maxSpans: 512, spans: List(), closers: List(), marks: List(), provider: "", capReached: false, duplicateMarks: 0 }
pure def canStartTimer(t: Timer, t0: int, maxSpans: int): bool = not(t.started)
pure def startTimer(t: Timer, t0: int, maxSpans: int): Timer = { ...t, started: true, t0: t0, maxSpans: if (maxSpans < 1) 1 else maxSpans }
pure def setClock(t: Timer, now: int): Timer = { ...t, now: now }
pure def elapsed(t: Timer): Metric = if (t.closed) Measured({ amount: t.closedAt - t.t0 }) else MissingMetric
pure def measuredMark(t: Timer, name: str): Metric = {
  val matching = t.marks.select(mark => mark.name == name)
  if (matching.length() == 0) MissingMetric else Measured({ amount: matching.nthOr(0, { name: name, at: t.t0 }).at - t.t0 })
}
pure def canCloseTimer(t: Timer): bool = t.started
pure def closeTimer(t: Timer): Timer = if (t.closed) t else { ...t, closed: true, closedAt: t.now }
pure def canAttributeProvider(t: Timer, provider: str): bool = t.started
pure def attributeProvider(t: Timer, provider: str): Timer = if (t.provider == "" and provider != "") { ...t, provider: provider } else t
pure def stepCloseTimeIsStable(before: Timer, after: Timer): bool = before.closed implies after.closedAt == before.closedAt
pure def stepFirstProviderWins(before: Timer, after: Timer): bool = before.provider != "" implies after.provider == before.provider
pure def metricMissing(metric: Metric): bool = match metric { | MissingMetric => true | _ => false }
pure def alwaysOpenTimerHasNoDuration(t: Timer): bool = not(t.closed) implies metricMissing(elapsed(t))
```

### Span capacity records an anomaly and each closer appends at most once

The default 512-span capacity belongs to diagnostics. It does not limit
model context, effect receipts or trajectory data. A negative or nonfinite
explicit duration is ignored by the source instrumentation boundary.

```quint
pure def appendSpan(span: Span, t: Timer): Timer = if (t.spans.length() >= t.maxSpans) { ...t, capReached: true } else { ...t, spans: t.spans.append(span) }
pure def canOpenSpan(t: Timer, id: str, name: str): bool = t.started and not(t.closers.some(closer => closer.id == id))
pure def openSpan(t: Timer, id: str, name: str): Timer = { ...t, closers: t.closers.append({ id: id, name: name, startedAt: t.now, closed: false }) }
pure def canCloseSpan(t: Timer, id: str): bool = t.closers.some(closer => closer.id == id)
pure def closeSpan(t: Timer, id: str): Timer = {
  val closer = t.closers.select(candidate => candidate.id == id).nthOr(0, { id: id, name: "", startedAt: t.now, closed: true })
  val marked = { ...t, closers: t.closers.listMap(candidate => if (candidate.id == id) { ...candidate, closed: true } else candidate) }
  if (closer.closed) t else appendSpan({ name: closer.name, startedAt: closer.startedAt, endedAt: t.now, duration: if (t.now >= closer.startedAt) t.now - closer.startedAt else 0 }, marked)
}
pure def canRecordDuration(t: Timer, name: str, duration: int): bool = t.started
pure def recordDuration(t: Timer, name: str, duration: int): Timer = if (duration < 0) t else appendSpan({ name: name, startedAt: t.now - duration, endedAt: t.now, duration: duration }, t)
pure def alwaysSpanCapacity(t: Timer): bool = t.maxSpans >= 1 and t.spans.length() <= t.maxSpans and t.spans.every(span => span.duration >= 0)
pure def alwaysCloserIdentityUnique(t: Timer): bool = t.closers.every(closer => t.closers.select(other => other.id == closer.id).length() == 1)
pure def sometimesSpanCapReported(t: Timer): bool = t.capReached
pure def sometimesRecordedAfterClose(t: Timer): bool = t.closed and t.spans.some(span => span.endedAt > t.closedAt)
pure val maxSpansValues = Set(0, 1, 2, 512)
pure val idValues = Set("a", "b", "c")
```

### Duplicate marks keep their first measurement and remain observable

```quint
pure def canMarkTime(t: Timer, name: str, at: int): bool = t.started
pure def markTime(t: Timer, name: str, at: int): Timer = if (t.marks.some(mark => mark.name == name)) { ...t, duplicateMarks: t.duplicateMarks + 1 } else { ...t, marks: t.marks.append({ name: name, at: at }) }
pure def alwaysMarksAreUnique(t: Timer): bool = t.marks.every(mark => t.marks.select(other => other.name == mark.name).length() == 1) and t.duplicateMarks >= 0
pure def stepMarksRetainFirstValue(before: Timer, after: Timer): bool = before.marks.every(mark => after.marks.includes(mark))
pure def sometimesDuplicateMarkObserved(t: Timer): bool = t.duplicateMarks > 0
```

### An unstarted timer contains no prior instrumentation

Discovered by the proof: starting a smaller-capacity timer from a fabricated
unstarted state with retained spans could exceed the new limit. A newly
constructed timer has no spans, closers, marks, provider or close timestamp.

```quint
pure def alwaysUnstartedTimerIsEmpty(t: Timer): bool = not(t.started) implies t.spans.length() == 0 and t.closers.length() == 0 and t.marks.length() == 0 and t.provider == "" and not(t.closed)
```
