#!/usr/bin/env node
/**
 * Multi-tier LifeOpsBench driver.
 *
 * Runs the LifeOpsBench Python harness once per (tier, harness) cell, then
 * aggregates per-cell ``report.json`` + ``report.md`` and computes pairwise
 * deltas between adjacent tiers. Produces a single ``SUMMARY.md`` at the run
 * root with side-by-side pass-rate / cache-hit / latency / cost.
 *
 * Usage:
 *
 *   node scripts/lifeops-multi-tier-bench.mjs \
 *     --suite smoke \
 *     --tiers large,frontier \
 *     [--harnesses hermes,openclaw,eliza] \
 *     [--run-dir <dir>] \
 *     [--dry-run]
 *
 * Behaviour:
 *
 * - ``small`` / ``mid`` tiers SKIP-NOT-FAIL when the dflash llama-cpp fork
 *   binary is absent. Skipped cells are recorded in ``SUMMARY.md`` with a
 *   ``SKIPPED`` note explaining why.
 * - ``large`` requires ``CEREBRAS_API_KEY``; ``frontier`` requires
 *   ``ANTHROPIC_API_KEY``. Missing keys → SKIPPED (never failed).
 * - On ``--dry-run`` no subprocess is spawned. The script plans the cells +
 *   resolved env, writes ``<runDir>/dry-run-plan.json``, and exits 0.
 * - Per-cell directory layout: ``<runDir>/<tier>/<harness>/`` matches what
 *   ``aggregate-lifeops-run.mjs`` expects.
 *
 * Exit codes:
 *   0  — every non-skipped cell finished and aggregation succeeded.
 *   1  — at least one cell failed at run-time.
 *   2  — argument parsing failure.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const VALID_TIERS = new Set(["small", "mid", "large", "frontier"]);
const VALID_HARNESSES = new Set(["hermes", "openclaw", "eliza"]);
const VALID_SUITES = new Set(["smoke", "core", "full"]);

// Mirrors `DFLASH_BINARY_PATH` in `packages/benchmarks/lib/src/local-llama-cpp.ts`.
// Duplicated here so the script stays runnable under plain Node without the
// TS toolchain in the path.
const DFLASH_BINARY_PATH = join(
  homedir(),
  ".cache",
  "eliza-dflash",
  "milady-llama-cpp",
  "build",
  "bin",
  "llama-server",
);

function probeDflashBinary() {
  return existsSync(DFLASH_BINARY_PATH) ? DFLASH_BINARY_PATH : null;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function parseList(raw, valid, label) {
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    console.error(`[multi-tier] --${label} must list at least one value`);
    process.exit(2);
  }
  for (const it of items) {
    if (!valid.has(it)) {
      console.error(
        `[multi-tier] --${label} invalid value: ${it} (valid: ${[...valid].join("|")})`,
      );
      process.exit(2);
    }
  }
  return items;
}

const suite = arg("--suite", "smoke");
if (!VALID_SUITES.has(suite)) {
  console.error(`[multi-tier] --suite invalid: ${suite}`);
  process.exit(2);
}

const tiers = parseList(arg("--tiers", "large,frontier"), VALID_TIERS, "tiers");
const harnesses = parseList(
  arg("--harnesses", "hermes,openclaw,eliza"),
  VALID_HARNESSES,
  "harnesses",
);
const dryRun = hasFlag("--dry-run");

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const runId = `lifeops-multi-tier-${ts}`;
const runDir = resolve(
  arg("--run-dir", join(homedir(), ".milady", "runs", "lifeops", runId)),
);

// ---------------------------------------------------------------------------
// Cell planning
// ---------------------------------------------------------------------------

const BENCH_DIR = join(
  REPO_ROOT,
  "packages",
  "benchmarks",
  "lifeops-bench",
);

const AGGREGATOR = join(REPO_ROOT, "scripts", "aggregate-lifeops-run.mjs");
const DELTA = join(REPO_ROOT, "scripts", "lifeops-bench-delta.mjs");

const dflashPath = probeDflashBinary();

/**
 * @typedef {Object} CellPlan
 * @property {string} tier
 * @property {string} harness
 * @property {string} dir
 * @property {string} pythonArgs[]
 * @property {Record<string,string>} env
 * @property {string|null} skipReason
 */

/** @returns {CellPlan} */
function planCell(tier, harness) {
  const dir = join(runDir, tier, harness);

  const env = {
    MODEL_TIER: tier,
    PYTHONUNBUFFERED: "1",
  };

  // skip-not-fail logic — surfaces stay legible in the final SUMMARY.md
  let skipReason = null;
  if ((tier === "small" || tier === "mid") && !dflashPath) {
    skipReason = `dflash llama-cpp fork missing (${DFLASH_BINARY_PATH})`;
  } else if (tier === "large" && !process.env.CEREBRAS_API_KEY) {
    skipReason = "CEREBRAS_API_KEY not in env";
  } else if (tier === "frontier" && !process.env.ANTHROPIC_API_KEY) {
    skipReason = "ANTHROPIC_API_KEY not in env";
  }

  const pythonArgs = [
    "-m",
    "eliza_lifeops_bench",
    "--suite",
    suite,
    "--agent",
    harness,
    "--mode",
    "static",
    "--model-tier",
    tier,
    "--output-dir",
    dir,
  ];

  return { tier, harness, dir, pythonArgs, env, skipReason };
}

const plans = [];
for (const tier of tiers) {
  for (const harness of harnesses) {
    plans.push(planCell(tier, harness));
  }
}

// ---------------------------------------------------------------------------
// Dry-run path
// ---------------------------------------------------------------------------

mkdirSync(runDir, { recursive: true });

if (dryRun) {
  const planFile = join(runDir, "dry-run-plan.json");
  writeFileSync(
    planFile,
    JSON.stringify(
      {
        schemaVersion: "lifeops-multi-tier-plan-v1",
        suite,
        tiers,
        harnesses,
        runDir,
        dflashBinary: dflashPath,
        cells: plans.map((c) => ({
          tier: c.tier,
          harness: c.harness,
          dir: c.dir,
          skipReason: c.skipReason,
          command: ["python3", ...c.pythonArgs],
          env: c.env,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`[multi-tier] dry-run plan written to ${planFile}`);
  console.log(`[multi-tier] suite=${suite} tiers=${tiers.join(",")} harnesses=${harnesses.join(",")}`);
  console.log(`[multi-tier] dflash binary: ${dflashPath ?? "(absent)"}`);
  for (const c of plans) {
    const tag = c.skipReason ? `SKIP (${c.skipReason})` : "RUN";
    console.log(`[multi-tier]  - ${c.tier}/${c.harness}: ${tag}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const results = [];

for (const cell of plans) {
  mkdirSync(cell.dir, { recursive: true });

  if (cell.skipReason) {
    console.log(`[multi-tier] SKIP ${cell.tier}/${cell.harness}: ${cell.skipReason}`);
    results.push({ ...cell, status: "skipped" });
    continue;
  }

  console.log(`[multi-tier] RUN ${cell.tier}/${cell.harness}`);
  const proc = spawnSync("python3", cell.pythonArgs, {
    cwd: BENCH_DIR,
    env: { ...process.env, ...cell.env },
    stdio: "inherit",
  });

  if (proc.status !== 0) {
    console.error(
      `[multi-tier] FAIL ${cell.tier}/${cell.harness}: exit=${proc.status}`,
    );
    results.push({ ...cell, status: "failed", exitCode: proc.status });
    continue;
  }

  // Aggregate per-cell. The aggregator infers the trajectory dir from
  // `<runDir>/trajectories` by default; pass an explicit `--run-dir` so the
  // per-cell directory becomes the aggregator's root.
  const agg = spawnSync(
    "bun",
    [
      AGGREGATOR,
      "--run-dir",
      cell.dir,
      "--harness",
      cell.harness,
      "--model-tier",
      cell.tier,
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (agg.status !== 0) {
    console.error(
      `[multi-tier] AGGREGATE FAIL ${cell.tier}/${cell.harness}: exit=${agg.status}`,
    );
    results.push({ ...cell, status: "aggregate-failed", exitCode: agg.status });
    continue;
  }

  results.push({ ...cell, status: "ok" });
}

// ---------------------------------------------------------------------------
// Pairwise deltas
//
// We compute small→mid, mid→large, large→frontier (whichever pairs are both
// present and OK). The delta tool needs `report.json` on each side. We pin
// the same harness for both sides of the pair so the comparison is apples
// to apples.
// ---------------------------------------------------------------------------

function indexByTier(results) {
  /** @type {Record<string, Record<string, typeof results[0]>>} */
  const idx = {};
  for (const r of results) {
    idx[r.tier] ??= {};
    idx[r.tier][r.harness] = r;
  }
  return idx;
}

const TIER_ORDER = ["small", "mid", "large", "frontier"];
const orderedTiers = TIER_ORDER.filter((t) => tiers.includes(t));
const pairs = [];
for (let i = 0; i < orderedTiers.length - 1; i++) {
  pairs.push([orderedTiers[i], orderedTiers[i + 1]]);
}

const byTier = indexByTier(results);
const deltas = [];
for (const [base, cand] of pairs) {
  for (const harness of harnesses) {
    const lhs = byTier[base]?.[harness];
    const rhs = byTier[cand]?.[harness];
    if (!lhs || !rhs || lhs.status !== "ok" || rhs.status !== "ok") {
      deltas.push({
        baseline: base,
        candidate: cand,
        harness,
        status: "skipped",
        reason: "one side missing/failed",
      });
      continue;
    }
    const baselineReport = join(lhs.dir, "report.json");
    const candidateReport = join(rhs.dir, "report.json");
    const outDir = join(runDir, "deltas", `${harness}__${base}_vs_${cand}`);
    mkdirSync(outDir, { recursive: true });
    const d = spawnSync(
      "bun",
      [
        DELTA,
        "--baseline",
        baselineReport,
        "--candidate",
        candidateReport,
        "--out",
        outDir,
        "--baseline-label",
        `${harness}@${base}`,
        "--candidate-label",
        `${harness}@${cand}`,
      ],
      { cwd: REPO_ROOT, stdio: "inherit" },
    );
    deltas.push({
      baseline: base,
      candidate: cand,
      harness,
      status: d.status === 0 ? "ok" : "failed",
      outDir,
      exitCode: d.status,
    });
  }
}

// ---------------------------------------------------------------------------
// SUMMARY.md
//
// Side-by-side per-(tier, harness): pass-rate, cache-hit %, latency, cost.
// All numbers are pulled straight from `report.json`. Skipped/failed cells
// are surfaced as a row with the reason.
// ---------------------------------------------------------------------------

function safeLoadReport(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const rows = results.map((r) => {
  if (r.status !== "ok") {
    return {
      tier: r.tier,
      harness: r.harness,
      pass: "—",
      cacheHit: "—",
      latencyMs: "—",
      costUsd: "—",
      status: r.status === "skipped" ? `SKIPPED (${r.skipReason})` : `FAILED (${r.status})`,
    };
  }
  const report = safeLoadReport(join(r.dir, "report.json"));
  if (!report) {
    return {
      tier: r.tier,
      harness: r.harness,
      pass: "—",
      cacheHit: "—",
      latencyMs: "—",
      costUsd: "—",
      status: "NO REPORT",
    };
  }
  const passCount = report.passCount ?? 0;
  const scenarioCount = report.scenarioCount ?? report.scenarios?.length ?? 0;
  const passPct = scenarioCount > 0 ? (100 * passCount) / scenarioCount : 0;
  const cacheHit = typeof report.cacheHitPct === "number"
    ? `${(report.cacheHitPct * 100).toFixed(1)}%`
    : "n/a";
  const latency = report.meanLatencyMs ?? report.medianLatencyMs ?? null;
  const cost = report.totalCostUsd ?? null;
  return {
    tier: r.tier,
    harness: r.harness,
    pass: `${passCount}/${scenarioCount} (${passPct.toFixed(1)}%)`,
    cacheHit,
    latencyMs: latency != null ? `${Math.round(latency)}` : "n/a",
    costUsd: cost != null ? `$${cost.toFixed(4)}` : "n/a",
    status: "ok",
  };
});

const lines = [];
lines.push(`# LifeOps Multi-Tier Benchmark — ${runId}`);
lines.push("");
lines.push(`Suite: \`${suite}\``);
lines.push(`Tiers: ${tiers.map((t) => `\`${t}\``).join(", ")}`);
lines.push(`Harnesses: ${harnesses.map((h) => `\`${h}\``).join(", ")}`);
lines.push(`dflash llama-cpp fork: ${dflashPath ? `present at \`${dflashPath}\`` : "absent (small/mid tiers will skip)"}`);
lines.push("");
lines.push("## Per-cell results");
lines.push("");
lines.push("| tier | harness | pass | cache-hit | latency (ms) | cost (USD) | status |");
lines.push("|------|---------|------|-----------|--------------|------------|--------|");
for (const row of rows) {
  lines.push(
    `| \`${row.tier}\` | \`${row.harness}\` | ${row.pass} | ${row.cacheHit} | ${row.latencyMs} | ${row.costUsd} | ${row.status} |`,
  );
}
lines.push("");
if (deltas.length > 0) {
  lines.push("## Pairwise deltas");
  lines.push("");
  lines.push("| baseline → candidate | harness | status | path |");
  lines.push("|---|---|---|---|");
  for (const d of deltas) {
    const lbl = `\`${d.baseline}\` → \`${d.candidate}\``;
    const path = d.outDir ? `\`${d.outDir}\`` : "—";
    const status = d.status === "ok" ? "ok" : `${d.status}${d.reason ? ` (${d.reason})` : ""}`;
    lines.push(`| ${lbl} | \`${d.harness}\` | ${status} | ${path} |`);
  }
  lines.push("");
}
lines.push("## Cells");
lines.push("");
for (const cell of plans) {
  lines.push(`- \`${cell.tier}/${cell.harness}\` → \`${cell.dir}\``);
}
lines.push("");

const summaryPath = join(runDir, "SUMMARY.md");
writeFileSync(summaryPath, lines.join("\n"));
console.log(`[multi-tier] summary written to ${summaryPath}`);
console.log(`RUN_DIR=${runDir}`);

const anyFailed = results.some(
  (r) => r.status !== "ok" && r.status !== "skipped",
);
process.exit(anyFailed ? 1 : 0);
