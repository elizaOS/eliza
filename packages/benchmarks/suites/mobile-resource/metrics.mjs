/**
 * Pure aggregation + budget logic for the Mobile Resource Workbench.
 *
 * The runner collects two streams per workload:
 *   - `generations` — one entry per on-device generation (token counts + ttft),
 *   - `samples`     — one entry per sampled resource snapshot over time.
 *
 * This module differences and aggregates them into a summary that mirrors the
 * runtime-side `DeviceResourceMetrics.summary()` (so on-device and offline
 * numbers line up), and checks that summary against per-tier budgets. Kept as a
 * dependency-free ESM module so it is unit-testable with `node --test`.
 *
 * Every output is `null` when the inputs could not measure it — never a
 * fabricated zero (AGENTS.md §3/§7).
 */

const MS_PER_SECOND = 1000;
const DEFAULT_LEAK_GROWTH_MB = 256;
const THERMAL_RANK = { nominal: 0, fair: 1, serious: 2, critical: 3 };

function isPositive(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}
function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Difference raw generation counters into prefill / decode / combined tok/s. */
export function computeThroughput({
  promptTokens,
  outputTokens,
  durationMs,
  ttftMs,
}) {
  const ttft = isPositive(ttftMs) && ttftMs < durationMs ? ttftMs : null;
  const combined =
    isPositive(durationMs) && isPositive(outputTokens)
      ? outputTokens / (durationMs / MS_PER_SECOND)
      : null;
  const prefill =
    ttft !== null && isPositive(promptTokens)
      ? promptTokens / (ttft / MS_PER_SECOND)
      : null;
  const decodeMs = ttft !== null ? durationMs - ttft : null;
  const decode =
    decodeMs !== null && isPositive(decodeMs) && isPositive(outputTokens)
      ? outputTokens / (decodeMs / MS_PER_SECOND)
      : null;
  return {
    prefillTokensPerSecond: prefill,
    decodeTokensPerSecond: decode,
    combinedTokensPerSecond: combined,
    ttftMs: ttft,
  };
}

function summarizeHistogram(values) {
  const xs = values.filter(isFiniteNum).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0)
    return {
      count: 0,
      p50: null,
      p90: null,
      p99: null,
      min: null,
      max: null,
      mean: null,
    };
  const pct = (p) =>
    xs[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  return {
    count: n,
    p50: pct(50),
    p90: pct(90),
    p99: pct(99),
    min: xs[0],
    max: xs[n - 1],
    mean: xs.reduce((a, b) => a + b, 0) / n,
  };
}

function summarizeRss(rss, threshold) {
  const xs = rss.filter(isFiniteNum);
  const n = xs.length;
  if (n === 0)
    return {
      firstMb: null,
      lastMb: null,
      peakMb: null,
      steadyMb: null,
      samples: 0,
      growthMb: null,
      leakSuspected: false,
    };
  const firstMb = xs[0];
  const lastMb = xs[n - 1];
  const peakMb = Math.max(...xs);
  const backHalf = n >= 2 ? xs.slice(Math.floor(n / 2)) : xs;
  const sorted = [...backHalf].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const steadyMb =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const growthMb = lastMb - firstMb;
  let monotone = n >= 4;
  for (let i = 1; i < n; i++)
    if (xs[i] < xs[i - 1]) {
      monotone = false;
      break;
    }
  return {
    firstMb,
    lastMb,
    peakMb,
    steadyMb,
    samples: n,
    growthMb,
    leakSuspected: monotone && growthMb > threshold,
  };
}

/**
 * Aggregate a workload's generation + sample streams into a summary.
 * @param {{generations?: Array, samples?: Array}} run
 * @param {{leakGrowthMbThreshold?: number}} [opts]
 */
export function summarizeResourceRun(run, opts = {}) {
  const generations = run.generations ?? [];
  const samples = run.samples ?? [];
  const threshold = opts.leakGrowthMbThreshold ?? DEFAULT_LEAK_GROWTH_MB;

  const prefill = [];
  const decode = [];
  const combined = [];
  const ttft = [];
  for (const g of generations) {
    const t = g.throughput ?? computeThroughput(g);
    if (isFiniteNum(t.prefillTokensPerSecond))
      prefill.push(t.prefillTokensPerSecond);
    if (isFiniteNum(t.decodeTokensPerSecond))
      decode.push(t.decodeTokensPerSecond);
    if (isFiniteNum(t.combinedTokensPerSecond))
      combined.push(t.combinedTokensPerSecond);
    if (isFiniteNum(t.ttftMs)) ttft.push(t.ttftMs);
  }

  const rss = [];
  let firstBattery = null;
  let lastBattery = null;
  let firstCharge = null;
  let lastCharge = null;
  let chargingObserved = false;
  let thermalInitial = null;
  let thermalLast = null;
  let thermalMaxRank = -1;
  let thermalMaxState = null;
  let thermalThrottled = 0;
  let thermalKnown = 0;
  let thermalSamples = 0;
  const thermalTransitions = [];
  let lowPowerEver = false;
  let lowPowerLast = null;
  let lowPowerTransitions = 0;

  for (const s of samples) {
    if (isFiniteNum(s.residentMemoryMb)) rss.push(s.residentMemoryMb);
    if (isFiniteNum(s.batteryLevelPct)) {
      const e = { pct: s.batteryLevelPct, atMs: s.atMs };
      if (firstBattery === null) firstBattery = e;
      lastBattery = e;
    }
    if (isFiniteNum(s.batteryChargeMicroAmpHours)) {
      if (firstCharge === null) firstCharge = s.batteryChargeMicroAmpHours;
      lastCharge = s.batteryChargeMicroAmpHours;
    }
    if (s.isCharging === true) chargingObserved = true;
    if (s.thermalState != null) {
      thermalSamples += 1;
      if (thermalInitial === null) thermalInitial = s.thermalState;
      if (s.thermalState !== "unknown") {
        thermalKnown += 1;
        const rank = THERMAL_RANK[s.thermalState];
        if (rank > thermalMaxRank) {
          thermalMaxRank = rank;
          thermalMaxState = s.thermalState;
        }
        if (rank >= THERMAL_RANK.serious) thermalThrottled += 1;
      }
      if (s.thermalState !== thermalLast)
        thermalTransitions.push({ atMs: s.atMs, state: s.thermalState });
      thermalLast = s.thermalState;
    }
    if (typeof s.lowPowerMode === "boolean") {
      if (s.lowPowerMode) lowPowerEver = true;
      if (lowPowerLast !== null && lowPowerLast !== s.lowPowerMode)
        lowPowerTransitions += 1;
      lowPowerLast = s.lowPowerMode;
    }
  }

  return {
    generations: generations.length,
    resourceSamples: samples.length,
    prefillTokensPerSecond: summarizeHistogram(prefill),
    decodeTokensPerSecond: summarizeHistogram(decode),
    combinedTokensPerSecond: summarizeHistogram(combined),
    ttftMs: summarizeHistogram(ttft),
    rss: summarizeRss(rss, threshold),
    battery: {
      firstPct: firstBattery?.pct ?? null,
      lastPct: lastBattery?.pct ?? null,
      drainPct:
        firstBattery && lastBattery ? firstBattery.pct - lastBattery.pct : null,
      energyMicroAmpHoursDelta:
        firstCharge !== null && lastCharge !== null
          ? firstCharge - lastCharge
          : null,
      durationMs:
        firstBattery && lastBattery
          ? lastBattery.atMs - firstBattery.atMs
          : null,
      chargingObserved,
    },
    thermal: {
      samples: thermalSamples,
      initialState: thermalInitial,
      maxState: thermalMaxState,
      transitions: thermalTransitions,
      transitionCount: Math.max(0, thermalTransitions.length - 1),
      fractionThrottled:
        thermalKnown > 0 ? thermalThrottled / thermalKnown : null,
    },
    lowPowerMode: {
      everEnabled: lowPowerEver,
      transitionCount: lowPowerTransitions,
    },
  };
}

/**
 * Check a summary against a tier budget. Each budget key declares a direction:
 *   - `min` budgets (throughput floors): value must be >= budget,
 *   - `max` budgets (latency / memory / battery ceilings): value must be <= budget.
 * A `null` budget means "no baseline yet" — recorded but never fails the gate.
 * A `null` measured value means "not measured" — recorded, and only fails when
 * the budget requires it AND `failOnMissing` is set.
 *
 * `workloadId` selects workload-specific checks: the `idle-reclaim` workload
 * (#11760) is an idle window with no generations, so it checks only the memory
 * budgets — including `maxPostIdleUnloadRssMb` against the tail RSS, which is
 * what proves the idle-unload policy actually reclaimed the resident model.
 */
export function checkBudgets(
  summary,
  budget,
  { failOnMissing = false, workloadId = null } = {},
) {
  if (!budget) return [];
  const checks = [];
  const add = (name, value, target, unit, direction) => {
    if (target == null) {
      checks.push({
        name,
        value,
        budget: null,
        unit,
        direction,
        pass: true,
        note: "no-baseline",
      });
      return;
    }
    if (value == null) {
      checks.push({
        name,
        value: null,
        budget: target,
        unit,
        direction,
        pass: !failOnMissing,
        note: "not-measured",
      });
      return;
    }
    const pass = direction === "min" ? value >= target : value <= target;
    checks.push({ name, value, budget: target, unit, direction, pass });
  };

  if (workloadId === "idle-reclaim") {
    // An idle window has no generations; throughput/TTFT/battery checks would
    // only ever read "not-measured" here. The one signal that matters is that
    // the tail RSS dropped once the idle-unload policy fired (#11760).
    add(
      "postIdleRssMb",
      summary.rss?.lastMb ?? null,
      budget.maxPostIdleUnloadRssMb,
      "MB",
      "max",
    );
    add(
      "peakRssMb",
      summary.rss?.peakMb ?? null,
      budget.maxPeakRssMb,
      "MB",
      "max",
    );
    return checks;
  }

  add(
    "decodeTokensPerSecondP50",
    summary.decodeTokensPerSecond?.p50 ?? null,
    budget.minDecodeTokensPerSecond,
    "tok/s",
    "min",
  );
  add(
    "prefillTokensPerSecondP50",
    summary.prefillTokensPerSecond?.p50 ?? null,
    budget.minPrefillTokensPerSecond,
    "tok/s",
    "min",
  );
  add("ttftMsP90", summary.ttftMs?.p90 ?? null, budget.maxTtftMs, "ms", "max");
  add(
    "peakRssMb",
    summary.rss?.peakMb ?? null,
    budget.maxPeakRssMb,
    "MB",
    "max",
  );
  add(
    "steadyRssMb",
    summary.rss?.steadyMb ?? null,
    budget.maxSteadyRssMb,
    "MB",
    "max",
  );
  add(
    "batteryDrainPct",
    summary.battery?.drainPct ?? null,
    budget.maxBatteryDrainPct,
    "%",
    "max",
  );

  // RSS leak + sustained-throttle are pass/fail honesty gates, not tunables.
  if (summary.rss?.samples >= 4) {
    checks.push({
      name: "rssLeak",
      value: summary.rss.leakSuspected ? 1 : 0,
      budget: 0,
      unit: "bool",
      direction: "max",
      pass: !summary.rss.leakSuspected,
    });
  }
  return checks;
}
