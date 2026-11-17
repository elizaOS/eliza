// SPEC.md, "Conformance": spec/core/timingRegistry.md against inferenceTimingRegistry and nextInferenceTurnId of src/inference-timing.vibe, process-wide, observed through its recent turns and histogram summaries
import type { Driver, Options } from "../../gen/core__timingRegistry.conformance.ts";
import type { Measurement, Registry, SpanTotal, TurnSummary } from "../../gen/core__timingRegistry.ts";
import {
  type InferenceHistogramSummary,
  type InferenceTurnSummary,
  inferenceTimingRegistry,
  nextInferenceTurnId,
} from "../../src/inference-timing.vibe";

interface Extent {
  count: number;
  min: number | null;
  max: number | null;
}

interface Observed {
  recent: TurnSummary[];
  spans: Record<string, Extent>;
  derived: Record<string, Extent>;
}

const derivedNames = [
  "timeToFirstTokenMs",
  "timeToFirstVisibleMs",
  "timeToReplyMs",
  "timeToResponseFinalizedMs",
  "totalMs",
] as const;

const milliseconds = (measurement: Measurement): number | null =>
  measurement.tag === "Measured" ? measurement.amount : null;

const measurement = (value: number | null): Measurement =>
  value === null ? { tag: "Missing" } : { tag: "Measured", amount: value };

const sortedSpans = (spans: SpanTotal[]): SpanTotal[] =>
  [...spans].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

const recorded = (summary: TurnSummary): InferenceTurnSummary => ({
  turnId: summary.turnId,
  traceId: summary.hasTraceId ? summary.traceId : null,
  label: summary.completePayload,
  roomId: null,
  modelProvider: null,
  t0EpochMs: 0,
  closedAtEpochMs: null,
  totalMs: milliseconds(summary.total),
  timeToFirstTokenMs: milliseconds(summary.firstToken),
  timeToFirstVisibleMs: milliseconds(summary.firstVisible),
  timeToReplyMs: milliseconds(summary.reply),
  timeToResponseFinalizedMs: milliseconds(summary.finalized),
  spans: [],
  marks: [],
  byName: Object.fromEntries(summary.byName.map((span) => [span.name, { totalMs: span.total, count: span.count }])),
  anomalies: [],
});

const specified = (summary: InferenceTurnSummary): TurnSummary => ({
  turnId: summary.turnId,
  traceId: summary.traceId ?? "",
  hasTraceId: summary.traceId !== null,
  completePayload: summary.label,
  byName: sortedSpans(
    Object.entries(summary.byName).map(([name, span]) => ({ name, total: span.totalMs, count: span.count })),
  ),
  firstToken: measurement(summary.timeToFirstTokenMs),
  firstVisible: measurement(summary.timeToFirstVisibleMs),
  reply: measurement(summary.timeToReplyMs),
  finalized: measurement(summary.timeToResponseFinalizedMs),
  total: measurement(summary.totalMs),
});

const extents = (summaries: Record<string, InferenceHistogramSummary>): Record<string, Extent> =>
  Object.fromEntries(Object.entries(summaries).map(([name, { count, min, max }]) => [name, { count, min, max }]));

const extent = (values: number[]): Extent => ({ count: values.length, min: Math.min(...values), max: Math.max(...values) });

export const driver: Driver<Observed> = {
  reset: () => {
    inferenceTimingRegistry.reset();
  },
  dispatch: (_key, event) => {
    if (event.type === "recordTurn") inferenceTimingRegistry.record(recorded(event.summary));
    else if (event.type === "resetRegistry") inferenceTimingRegistry.reset();
    else nextInferenceTurnId();
    return "accepted";
  },
  observe: () => ({
    recent: inferenceTimingRegistry.recentTurns(64).map(specified),
    spans: extents(inferenceTimingRegistry.spanSummaries()),
    derived: extents(inferenceTimingRegistry.derivedSummaries()),
  }),
};

export const options: Options<Observed> = {
  keys: ["a"],
  view: (state: Registry) => ({
    recent: state.recent.map((summary) => ({
      ...summary,
      traceId: summary.hasTraceId ? summary.traceId : "",
      byName: sortedSpans(summary.byName),
    })),
    spans: Object.fromEntries(
      state.histograms.filter((row) => row.kind === "SpanMetric").map((row) => [row.name, extent(row.values)]),
    ),
    derived: Object.fromEntries(
      derivedNames.map((name) => {
        const row = state.histograms.find((candidate) => candidate.kind === "DerivedMetric" && candidate.name === name);
        return [name, row ? extent(row.values) : { count: 0, min: null, max: null }];
      }),
    ),
  }),
};
