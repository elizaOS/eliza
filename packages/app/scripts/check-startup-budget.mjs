#!/usr/bin/env node
/**
 * Cold-boot TTI + build-time regression gate for the mobile app (issue #14414).
 *
 * Consumes the boot-timing artifacts the repo already produces — the renderer
 * startup trace from `capture-startup-trace.mjs` (per-phase `timeline` marks)
 * and the build-time JSON from `run-mobile-build.mjs` — turns them into named
 * metrics, and checks each against `packages/app/perf-budgets.json`. A metric
 * fails the gate two ways: it exceeds its hard `budgetMs` ceiling, or it
 * regresses past the last recorded `baselineMs` by more than `tolerancePct`.
 * This is the measurement instrument the "defer eager work + shrink cold TTI"
 * work drives against: it makes a build-time / cold-TTI regression a red gate
 * instead of an unnoticed drift.
 *
 * The pure functions (selectColdRun, extractTtiMark, computeRegressionPct,
 * evaluateMetric, evaluateAll) carry no I/O and are unit-tested in
 * check-startup-budget.test.ts; main() is the CLI boundary that reads files,
 * prints the table, and sets the exit code.
 *
 * Usage:
 *   node scripts/check-startup-budget.mjs \
 *     [--budgets <perf-budgets.json>] \
 *     [--trace <capture-startup-trace artifact> --tti-target <name>] \
 *     [--build-timing <run-mobile-build timing json> --build-target <name>] \
 *     [--metric <category:target=valueMs> ...] \
 *     [--tolerance-pct <n>] [--out <report.json>] \
 *     [--update-baseline] [--json]
 *
 *   --trace          capture-startup-trace.mjs artifact; the cold run's TTI mark
 *                    becomes the `tti/<tti-target>` metric
 *   --tti-target     which tti budget the trace measures (default ci-web)
 *   --build-timing   run-mobile-build.mjs timing json ({ target, buildMs })
 *   --build-target   which build budget the timing measures (default: the json's
 *                    own `target`, else android-apk)
 *   --metric         inject a raw metric, e.g. build:rebuild-loop=42000 (repeatable)
 *   --update-baseline  rewrite matched budgets' baselineMs to the measured value
 *   --out            write the machine report JSON
 *   --json           print the report as JSON instead of a table
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** TTI marks, best → fallback: the usable-shell paint is the "land in chat"
 * moment this budget tracks; first-paint is splash-delay-gated and absent on
 * boots faster than the gate, so `mounted` is the durable default. */
export const DEFAULT_TTI_MARKS = [
  "startup-shell:mounted",
  "startup-shell:first-paint",
  "coordinator:ready",
];

export const METRIC_STATUS = {
  PASS: "pass",
  OVER_BUDGET: "over-budget",
  REGRESSED: "regressed",
  MISSING_METRIC: "missing-metric",
  MISSING_BUDGET: "missing-budget",
};

/**
 * Pick the cold run from a capture-startup-trace artifact. Cold is the metric
 * that matters for a launch budget (warm reloads keep module/asset caches). A
 * run carrying an `error` (no trace on window) is not a usable measurement.
 */
export function selectColdRun(artifact) {
  const runs = Array.isArray(artifact?.runs) ? artifact.runs : [];
  const usable = runs.filter((r) => r && !r.error && Array.isArray(r.timeline));
  return usable.find((r) => r.kind === "cold") ?? usable[0] ?? null;
}

/**
 * Extract the TTI checkpoint from a run's timeline, honoring mark priority.
 * `atMs` is already relative to the run's first mark (module-eval == 0), so it
 * is the cold time-to-usable-shell directly. Returns null when no priority mark
 * is present — the caller treats that as a missing measurement, never as 0.
 */
export function extractTtiMark(run, markPriority = DEFAULT_TTI_MARKS) {
  const timeline = Array.isArray(run?.timeline) ? run.timeline : [];
  for (const name of markPriority) {
    const hit = timeline.find((m) => m?.name === name);
    if (hit && Number.isFinite(hit.atMs)) {
      return { name, atMs: hit.atMs };
    }
  }
  return null;
}

/** Percent a value exceeds a baseline; negative means an improvement. Null when
 * there is no baseline to compare against. */
export function computeRegressionPct(valueMs, baselineMs) {
  if (!Number.isFinite(baselineMs) || baselineMs <= 0) return null;
  return ((valueMs - baselineMs) / baselineMs) * 100;
}

/**
 * Grade one metric against its budget entry. Fails on a missing budget entry,
 * an absent measurement, over-ceiling, or a baseline regression past tolerance.
 * A missing metric is a failure, not a silent pass — an unmeasured budget must
 * not read as green.
 */
export function evaluateMetric({
  category,
  target,
  valueMs,
  budgetEntry,
  tolerancePct,
}) {
  const key = `${category}/${target}`;
  if (!budgetEntry || !Number.isFinite(budgetEntry.budgetMs)) {
    return {
      key,
      category,
      target,
      valueMs,
      status: METRIC_STATUS.MISSING_BUDGET,
    };
  }
  const { budgetMs } = budgetEntry;
  const baselineMs = Number.isFinite(budgetEntry.baselineMs)
    ? budgetEntry.baselineMs
    : null;
  if (!Number.isFinite(valueMs)) {
    return {
      key,
      category,
      target,
      valueMs: null,
      budgetMs,
      baselineMs,
      status: METRIC_STATUS.MISSING_METRIC,
    };
  }
  const regressionPct = computeRegressionPct(valueMs, baselineMs);
  let status = METRIC_STATUS.PASS;
  if (valueMs > budgetMs) {
    status = METRIC_STATUS.OVER_BUDGET;
  } else if (regressionPct !== null && regressionPct > tolerancePct) {
    status = METRIC_STATUS.REGRESSED;
  }
  return {
    key,
    category,
    target,
    valueMs,
    budgetMs,
    baselineMs,
    regressionPct,
    status,
  };
}

const FAILING = new Set([
  METRIC_STATUS.OVER_BUDGET,
  METRIC_STATUS.REGRESSED,
  METRIC_STATUS.MISSING_METRIC,
  METRIC_STATUS.MISSING_BUDGET,
]);

const BASELINE_RECORDING_BLOCKERS = new Set([
  METRIC_STATUS.MISSING_METRIC,
  METRIC_STATUS.MISSING_BUDGET,
]);

/**
 * Grade every requested metric. `metrics` is [{ category, target, valueMs }].
 * `ok` is true only when no row failed — that is the gate's exit signal.
 */
export function evaluateAll({ metrics, budgets, tolerancePct }) {
  const tol = Number.isFinite(tolerancePct)
    ? tolerancePct
    : Number.isFinite(budgets?.tolerancePct)
      ? budgets.tolerancePct
      : 15;
  const rows = metrics.map((m) =>
    evaluateMetric({
      category: m.category,
      target: m.target,
      valueMs: m.valueMs,
      budgetEntry: budgets?.[m.category]?.[m.target],
      tolerancePct: tol,
    }),
  );
  return {
    rows,
    ok: rows.every((r) => !FAILING.has(r.status)),
    tolerancePct: tol,
  };
}

/**
 * A baseline-recording run may be over budget because the measured value is the
 * new baseline, but it must still prove every requested metric mapped to a real
 * budget entry. Otherwise `--update-baseline` would turn a misspelled target
 * into a green no-op.
 */
export function shouldPassAfterBaselineUpdate(rows, updatedCount) {
  return (
    updatedCount === rows.length &&
    rows.every((r) => !BASELINE_RECORDING_BLOCKERS.has(r.status))
  );
}

// ── CLI boundary ────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGETS = path.resolve(HERE, "..", "perf-budgets.json");

function parseArgs(argv) {
  const args = {
    budgets: DEFAULT_BUDGETS,
    trace: null,
    ttiTarget: "ci-web",
    buildTiming: null,
    buildTarget: null,
    metrics: [],
    tolerancePct: null,
    out: null,
    updateBaseline: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--budgets") args.budgets = argv[++i];
    else if (a === "--trace") args.trace = argv[++i];
    else if (a === "--tti-target") args.ttiTarget = argv[++i];
    else if (a === "--build-timing") args.buildTiming = argv[++i];
    else if (a === "--build-target") args.buildTarget = argv[++i];
    else if (a === "--metric") args.metrics.push(argv[++i]);
    else if (a === "--tolerance-pct") args.tolerancePct = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--json") args.json = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Parse a `--metric category:target=valueMs` spec into a metric. Throws on a
 * malformed spec rather than silently dropping it (a dropped metric would read
 * as a passing gate). */
function parseMetricSpec(spec) {
  const match = /^([^:]+):([^=]+)=(-?\d+(?:\.\d+)?)$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Malformed --metric "${spec}"; expected category:target=valueMs`,
    );
  }
  return {
    category: match[1],
    target: match[2],
    valueMs: Number(match[3]),
  };
}

function collectMetrics(args) {
  const metrics = [];
  if (args.trace) {
    const artifact = readJson(args.trace);
    const run = selectColdRun(artifact);
    if (!run) {
      throw new Error(
        `--trace ${args.trace} has no usable cold run (all runs errored or empty)`,
      );
    }
    const mark = extractTtiMark(run);
    if (!mark) {
      throw new Error(
        `--trace ${args.trace} cold run has none of the TTI marks (${DEFAULT_TTI_MARKS.join(", ")}); the boot never reached a usable shell`,
      );
    }
    metrics.push({
      category: "tti",
      target: args.ttiTarget,
      valueMs: mark.atMs,
      source: { kind: "trace", mark: mark.name, file: args.trace },
    });
  }
  if (args.buildTiming) {
    const timing = readJson(args.buildTiming);
    if (!Number.isFinite(timing?.buildMs)) {
      throw new Error(
        `--build-timing ${args.buildTiming} has no numeric buildMs`,
      );
    }
    const target = args.buildTarget ?? timing.target ?? "android-apk";
    metrics.push({
      category: "build",
      target,
      valueMs: timing.buildMs,
      source: { kind: "build-timing", file: args.buildTiming },
    });
  }
  for (const spec of args.metrics) {
    metrics.push({ ...parseMetricSpec(spec), source: { kind: "flag" } });
  }
  return metrics;
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function printTable(rows, tolerancePct) {
  const glyph = {
    [METRIC_STATUS.PASS]: "PASS",
    [METRIC_STATUS.OVER_BUDGET]: "OVER-BUDGET",
    [METRIC_STATUS.REGRESSED]: "REGRESSED",
    [METRIC_STATUS.MISSING_METRIC]: "MISSING",
    [METRIC_STATUS.MISSING_BUDGET]: "NO-BUDGET",
  };
  console.log(
    `\nStartup + build budget gate (regression tolerance ${tolerancePct}%)`,
  );
  console.log(
    "  metric".padEnd(30),
    "value".padStart(9),
    "budget".padStart(9),
    "baseline".padStart(9),
    "  status",
  );
  for (const r of rows) {
    const reg =
      Number.isFinite(r.regressionPct) && r.baselineMs
        ? ` (${r.regressionPct >= 0 ? "+" : ""}${r.regressionPct.toFixed(1)}%)`
        : "";
    console.log(
      `  ${r.key}`.padEnd(30),
      formatMs(r.valueMs).padStart(9),
      formatMs(r.budgetMs).padStart(9),
      formatMs(r.baselineMs).padStart(9),
      `  ${glyph[r.status] ?? r.status}${reg}`,
    );
  }
}

function applyBaselineUpdates(budgets, rows) {
  let updated = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.valueMs)) continue;
    const entry = budgets?.[r.category]?.[r.target];
    if (!entry) continue;
    entry.baselineMs = Math.round(r.valueMs);
    updated += 1;
  }
  return updated;
}

async function main() {
  const args = parseArgs(process.argv);
  const budgets = readJson(args.budgets);
  const metrics = collectMetrics(args);
  if (metrics.length === 0) {
    throw new Error(
      "No metrics supplied — pass --trace, --build-timing, or --metric. An empty gate must not report success.",
    );
  }
  const { rows, ok, tolerancePct } = evaluateAll({
    metrics,
    budgets,
    tolerancePct: args.tolerancePct,
  });

  let updatedBaselines = 0;
  if (args.updateBaseline) {
    if (!shouldPassAfterBaselineUpdate(rows, rows.length)) {
      console.error(
        "[startup-budget] Refusing to update baselines because at least one requested metric is missing or has no budget entry.",
      );
    } else {
      updatedBaselines = applyBaselineUpdates(budgets, rows);
      writeFileSync(args.budgets, `${JSON.stringify(budgets, null, 2)}\n`);
      console.log(
        `Recorded ${updatedBaselines} baseline(s) into ${args.budgets}`,
      );
    }
  }

  const report = {
    capturedAtIso: new Date().toISOString(),
    tolerancePct,
    ok,
    rows: rows.map((r, i) => ({ ...r, source: metrics[i]?.source })),
  };
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(rows, tolerancePct);
    console.log(ok ? "\nBudget gate: PASS" : "\nBudget gate: FAIL");
  }

  // --update-baseline is a recording run: over-budget/regressed values are the
  // new baseline, but missing metrics/budget entries still mean nothing useful
  // was recorded.
  process.exit(
    ok ||
      (args.updateBaseline &&
        shouldPassAfterBaselineUpdate(rows, updatedBaselines))
      ? 0
      : 1,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // error-policy:J1 CLI boundary — surface any failure as a non-zero exit with a
  // legible message instead of an unhandled rejection.
  main().catch((err) => {
    console.error(
      `[startup-budget] ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  });
}
