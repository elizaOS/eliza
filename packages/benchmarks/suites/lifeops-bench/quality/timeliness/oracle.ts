/**
 * Reminder-timeliness oracle (#10723) — pure, code-under-test-free.
 *
 * The gate replays the REAL scheduled-task tick over a fixed tick grid and
 * compares what fired against what the trigger CONTRACT says should fire:
 *
 *  - `once` / `cron` cases carry hand-authored expected occurrence instants
 *    (committed in corpus.ts, cross-checked against IANA tzdata — see the
 *    corpus header). The oracle never calls `computeNextCronRunAtMs`, so a
 *    core cron/DST regression cannot silently rewrite the expectation.
 *  - `interval` cases derive expectations from the interval contract itself:
 *    the first fire lands on the first tick at/after `from` (or the first
 *    tick when `from` is unset), and each subsequent ideal instant is the
 *    previous ACTUAL fire + `everyMinutes` (interval re-anchors on fire).
 *
 * Every expected occurrence maps to one ideal instant and one expected fire
 * tick (the first tick at/after the ideal). Metrics:
 *  - deviation (fire tick − ideal instant): max/mean, must stay under the
 *    tick cadence;
 *  - missedFireCount / duplicateFireCount / earlyFireCount: must be 0;
 *  - occurrenceMismatchCount: the tick's own `occurrenceAtIso` must agree
 *    with the oracle's ideal instant — must be 0.
 */

export const MINUTE_MS = 60_000;

export interface TimelinessCase {
  id: string;
  kind: "reminder" | "checkin";
  trigger:
    | { kind: "once"; atIso: string }
    | { kind: "cron"; expression: string; tz: string }
    | { kind: "interval"; everyMinutes: number; from?: string };
  /**
   * Hand-authored expected occurrence instants for `once`/`cron` cases —
   * the independent oracle. MUST be omitted for `interval` cases (their
   * ideals depend on actual fire ticks and are derived by the recursion).
   */
  expectedOccurrences?: string[];
}

export interface TimelinessWindow {
  name: string;
  /** First tick instant (inclusive). */
  startIso: string;
  /** Last tick instant (inclusive). */
  endIso: string;
  cadenceMinutes: number;
  tasks: TimelinessCase[];
}

export interface ActualFire {
  taskId: string;
  tickMs: number;
  status: string;
  occurrenceAtIso?: string;
}

export interface ExpectedFire {
  idealMs: number;
  expectedTickMs: number;
}

export interface CaseScore {
  taskId: string;
  expectedFires: number;
  actualFires: number;
  missedFireCount: number;
  duplicateFireCount: number;
  earlyFireCount: number;
  occurrenceMismatchCount: number;
  deviationsMs: number[];
}

export interface TimelinessScore {
  cases: CaseScore[];
  totalExpectedFires: number;
  totalActualFires: number;
  missedFireCount: number;
  duplicateFireCount: number;
  earlyFireCount: number;
  occurrenceMismatchCount: number;
  maxDeviationMs: number;
  meanDeviationMs: number;
}

export function parseIsoStrict(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`[lifeops-quality] invalid ISO instant: ${iso}`);
  }
  return ms;
}

/** Inclusive [startIso, endIso] tick instants every `cadenceMinutes`. */
export function tickGrid(window: TimelinessWindow): number[] {
  const start = parseIsoStrict(window.startIso);
  const end = parseIsoStrict(window.endIso);
  const step = window.cadenceMinutes * MINUTE_MS;
  if (end < start) {
    throw new Error(
      `[lifeops-quality] window ${window.name} ends before it starts`,
    );
  }
  const ticks: number[] = [];
  for (let t = start; t <= end; t += step) {
    ticks.push(t);
  }
  return ticks;
}

export function firstTickAtOrAfter(ticks: number[], ms: number): number | null {
  // Ticks are strictly increasing — binary search for the first >= ms.
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const tick = ticks[mid];
    if (tick === undefined || tick < ms) lo = mid + 1;
    else hi = mid;
  }
  const found = ticks[lo];
  return found === undefined ? null : found;
}

/**
 * Expected fires for one case over the tick grid.
 *
 * For `once`/`cron`: each committed occurrence instant becomes one expected
 * fire at the first tick at/after it. For `interval`: the contract recursion
 * (ideal₁ = from ?? first tick; idealₖ₊₁ = fireₖ + everyMinutes).
 */
export function expectedFiresForCase(
  benchCase: TimelinessCase,
  ticks: number[],
): ExpectedFire[] {
  if (ticks.length === 0) return [];
  if (benchCase.trigger.kind === "interval") {
    if (benchCase.expectedOccurrences) {
      throw new Error(
        `[lifeops-quality] interval case ${benchCase.id} must not carry expectedOccurrences`,
      );
    }
    const every = benchCase.trigger.everyMinutes * MINUTE_MS;
    const out: ExpectedFire[] = [];
    const firstTick = ticks[0];
    if (firstTick === undefined) return out;
    let ideal = benchCase.trigger.from
      ? parseIsoStrict(benchCase.trigger.from)
      : firstTick;
    for (;;) {
      const tick = firstTickAtOrAfter(ticks, ideal);
      if (tick === null) break;
      out.push({ idealMs: ideal, expectedTickMs: tick });
      ideal = tick + every;
    }
    return out;
  }
  const occurrences = benchCase.expectedOccurrences;
  if (!occurrences || occurrences.length === 0) {
    throw new Error(
      `[lifeops-quality] case ${benchCase.id} has no expectedOccurrences`,
    );
  }
  const out: ExpectedFire[] = [];
  let previousMs = Number.NEGATIVE_INFINITY;
  for (const iso of occurrences) {
    const idealMs = parseIsoStrict(iso);
    if (idealMs <= previousMs) {
      throw new Error(
        `[lifeops-quality] case ${benchCase.id} occurrences not strictly increasing at ${iso}`,
      );
    }
    previousMs = idealMs;
    const tick = firstTickAtOrAfter(ticks, idealMs);
    if (tick === null) {
      throw new Error(
        `[lifeops-quality] case ${benchCase.id} occurrence ${iso} falls after the last tick`,
      );
    }
    out.push({ idealMs, expectedTickMs: tick });
  }
  // Two occurrences collapsing onto the same tick would make single-fire
  // ticks indistinguishable from missed fires — a corpus authoring error.
  const uniqueTicks = new Set(out.map((f) => f.expectedTickMs));
  if (uniqueTicks.size !== out.length) {
    throw new Error(
      `[lifeops-quality] case ${benchCase.id} has two occurrences inside one tick interval`,
    );
  }
  return out;
}

/** Pair the k-th actual fire with the k-th expected fire and score. */
export function scoreCase(
  benchCase: TimelinessCase,
  expected: ExpectedFire[],
  actual: ActualFire[],
): CaseScore {
  const ordered = [...actual].sort((a, b) => a.tickMs - b.tickMs);
  const deviationsMs: number[] = [];
  let earlyFireCount = 0;
  let occurrenceMismatchCount = 0;
  const pairCount = Math.min(expected.length, ordered.length);
  for (let i = 0; i < pairCount; i++) {
    const want = expected[i];
    const got = ordered[i];
    if (!want || !got) break;
    const deviation = got.tickMs - want.idealMs;
    if (deviation < 0) {
      earlyFireCount += 1;
    } else {
      deviationsMs.push(deviation);
    }
    const claimed = got.occurrenceAtIso
      ? Date.parse(got.occurrenceAtIso)
      : Number.NaN;
    if (claimed !== want.idealMs) {
      occurrenceMismatchCount += 1;
    }
  }
  return {
    taskId: benchCase.id,
    expectedFires: expected.length,
    actualFires: ordered.length,
    missedFireCount: Math.max(0, expected.length - ordered.length),
    duplicateFireCount: Math.max(0, ordered.length - expected.length),
    earlyFireCount,
    occurrenceMismatchCount,
    deviationsMs,
  };
}

export function scoreTimeliness(
  window: TimelinessWindow,
  ticks: number[],
  firesByTask: ReadonlyMap<string, ActualFire[]>,
): TimelinessScore {
  const cases = window.tasks.map((benchCase) =>
    scoreCase(
      benchCase,
      expectedFiresForCase(benchCase, ticks),
      firesByTask.get(benchCase.id) ?? [],
    ),
  );
  const allDeviations = cases.flatMap((c) => c.deviationsMs);
  const sum = allDeviations.reduce((acc, d) => acc + d, 0);
  return {
    cases,
    totalExpectedFires: cases.reduce((acc, c) => acc + c.expectedFires, 0),
    totalActualFires: cases.reduce((acc, c) => acc + c.actualFires, 0),
    missedFireCount: cases.reduce((acc, c) => acc + c.missedFireCount, 0),
    duplicateFireCount: cases.reduce((acc, c) => acc + c.duplicateFireCount, 0),
    earlyFireCount: cases.reduce((acc, c) => acc + c.earlyFireCount, 0),
    occurrenceMismatchCount: cases.reduce(
      (acc, c) => acc + c.occurrenceMismatchCount,
      0,
    ),
    maxDeviationMs: allDeviations.length ? Math.max(...allDeviations) : 0,
    meanDeviationMs: allDeviations.length ? sum / allDeviations.length : 0,
  };
}
