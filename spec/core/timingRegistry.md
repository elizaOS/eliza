# Timing registry and histogram retention

The source is `InferenceTimingRegistry`, `BoundedHistogram` and
`nextInferenceTurnId` in `packages/core/src/inference-timing.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`.

## Story: Retain recent telemetry with explicit missing measurements

As an operator, I retain the latest 64 turn summaries and latest 256 finite
measurements per histogram. A process counter differentiates turn IDs
created at the same clock time. Historical summaries keep a missing trace
ID instead of minting replacement evidence.

### Histogram admission keeps finite samples in arrival order

Recording a summary updates its span histograms and all present derived
measurements atomically. A missing measurement supplies no sample.
Span names and derived measurement names have separate namespaces. The
numeric boundary rejects nonfinite samples before this integer model.
Fractional-millisecond representation and nearest-rank arithmetic retain
their explicit numeric contracts in the baseline.

```quint
type MetricNamespace = SpanMetric | DerivedMetric
type Measurement = Missing | Measured({ amount: int })
type SpanTotal = { name: str, total: int, count: int }
type MetricInput = { kind: MetricNamespace, name: str, measurement: Measurement }
type SampleRow = { kind: MetricNamespace, name: str, values: List[int] }
type TurnSummary = { turnId: str, traceId: str, hasTraceId: bool, completePayload: str, byName: List[SpanTotal], firstToken: Measurement, firstVisible: Measurement, reply: Measurement, finalized: Measurement, total: Measurement }
type Registry = { recent: List[TurnSummary], histograms: List[SampleRow], counter: int }
pure val initial: Registry = { recent: List(), histograms: List(), counter: 0 }
pure val emptySummary: TurnSummary = { turnId: "", traceId: "", hasTraceId: false, completePayload: "", byName: List(), firstToken: Missing, firstVisible: Missing, reply: Missing, finalized: Missing, total: Missing }
pure val summaryValues = Set(emptySummary, { ...emptySummary, turnId: "first", completePayload: "complete summary", byName: List({ name: "provider", total: 3, count: 1 }), total: Measured({ amount: 5 }) }, { ...emptySummary, turnId: "second", traceId: "existing", hasTraceId: true, reply: Measured({ amount: 2 }) })
pure def boundedSample(values: List[int], sample: int): List[int] = if (values.length() >= 256) values.removeAt(0).append(sample) else values.append(sample)
pure def appendMeasurement(input: MetricInput, r: Registry): Registry = {
  val measurement = input.measurement
  match measurement {
  | Missing => r
  | Measured(value) => if (r.histograms.some(row => row.kind == input.kind and row.name == input.name))
      { ...r, histograms: r.histograms.listMap(row => if (row.kind == input.kind and row.name == input.name) { ...row, values: boundedSample(row.values, value.amount) } else row) }
    else { ...r, histograms: r.histograms.append({ kind: input.kind, name: input.name, values: List(value.amount) }) }
  }
}
pure def measurementInputs(summary: TurnSummary): List[MetricInput] = summary.byName.listMap(span => { kind: SpanMetric, name: span.name, measurement: Measured({ amount: span.total }) }).concat(List(
  { kind: DerivedMetric, name: "timeToFirstTokenMs", measurement: summary.firstToken },
  { kind: DerivedMetric, name: "timeToFirstVisibleMs", measurement: summary.firstVisible },
  { kind: DerivedMetric, name: "timeToReplyMs", measurement: summary.reply },
  { kind: DerivedMetric, name: "timeToResponseFinalizedMs", measurement: summary.finalized },
  { kind: DerivedMetric, name: "totalMs", measurement: summary.total }
))
pure def allocateTurn(r: Registry): Registry = { ...r, counter: r.counter + 1 }
pure def recordTurn(r: Registry, summary: TurnSummary): Registry = {
  val updated = measurementInputs(summary).foldl(r, (previous, input) => appendMeasurement(input, previous))
  { ...updated, recent: if (r.recent.length() >= 64) r.recent.removeAt(0).append(summary) else r.recent.append(summary) }
}
pure val valuesValues = Set(List(), List(1), List(1, 2, 3))
pure val inputValues = Set({ kind: SpanMetric, name: "provider", measurement: Missing }, { kind: SpanMetric, name: "provider", measurement: Measured({ amount: 3 }) })
pure def resetRegistry(r: Registry): Registry = { ...r, recent: List(), histograms: List() }
pure def alwaysRetentionBounds(r: Registry): bool = r.recent.length() <= 64 and r.histograms.every(row => row.values.length() <= 256)
pure def alwaysHistogramIdentity(r: Registry): bool = r.histograms.every(row => r.histograms.select(other => other.kind == row.kind and other.name == row.name).length() == 1)
pure def alwaysCounterNonnegative(r: Registry): bool = r.counter >= 0
pure def stepCounterNeverRewinds(before: Registry, after: Registry): bool = after.counter >= before.counter
pure def sometimesMissingTraceRetained(r: Registry): bool = r.recent.some(summary => not(summary.hasTraceId))
pure def sometimesTwoTurnIdsAllocated(r: Registry): bool = r.counter >= 2
pure def sometimesSpanAndDerivedRecorded(r: Registry): bool = r.histograms.some(row => row.kind == SpanMetric) and r.histograms.some(row => row.kind == DerivedMetric)
```
