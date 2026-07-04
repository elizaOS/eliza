#!/usr/bin/env node
// Append a real-model LifeOps/PA benchmark run to the durable score-history
// series and regenerate HISTORY.md. This is the retention mechanism #11789 asks
// for: one committed, append-only, harness-keyed series so the *trend* — not a
// single point — stays reviewer-visible over time.
//
// It ingests either supported report format and normalizes to one row schema:
//   - the TS prompt-benchmark report (plugins/plugin-personal-assistant/scripts/
//     lifeops-prompt-benchmark.ts) — top-level `accuracy` + `byTask`/`byVariant`
//   - the Python lifeops_bench report (packages/benchmarks/lifeops-bench) —
//     top-level `pass_at_1` + `mean_score_per_domain` + `scenarios[]`
//
// Usage:
//   node append-score-history.mjs --report <run.json> \
//     --harness lifeops-prompt-benchmark|lifeops_bench \
//     --provider cerebras --slice "<human description>" \
//     [--commit <sha>] [--notes "<free text>"]
//
// The run date/model are read from the report itself (deterministic). The row
// is appended to ../score-history.jsonl and ../HISTORY.md is fully regenerated
// from that jsonl so the two never drift.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, "..");
const JSONL = path.join(DIR, "score-history.jsonl");
const HISTORY_MD = path.join(DIR, "HISTORY.md");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected arg: ${a}`);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = val;
      i += 1;
    }
  }
  return out;
}

function round(n, d = 4) {
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// --- format detectors + normalizers -------------------------------------------------

function normalizeTsPromptBenchmark(report) {
  const model = report.model ?? report.modelName ?? report.model_name ?? null;
  return {
    date: report.generatedAt ?? null,
    model,
    provider: report.providerName ?? null,
    n: report.total ?? null,
    passed: report.passed ?? null,
    accuracy: round(report.accuracy),
    metrics: {
      weightedAccuracy: round(report.weightedAccuracy),
      falsePositiveRate: round(report.falsePositiveRate),
      trajectoryCaptureRate: round(report.trajectoryCaptureRate),
      latencyMsAvg: report.latency?.avg ?? null,
      latencyMsP95: report.latency?.p95 ?? null,
    },
    breakdown: {
      byTask: Object.fromEntries(
        Object.entries(report.byTask ?? {}).map(([k, v]) => [
          k,
          `${v.passed ?? v.pass ?? 0}/${v.total ?? 0}`,
        ]),
      ),
      byVariant: Object.keys(report.byVariant ?? {}),
    },
  };
}

function normalizePythonLifeopsBench(report) {
  const scenarios = report.scenarios ?? [];
  const passed = scenarios.filter((s) => {
    const mx = s.max_score || 1;
    return (s.total_score ?? 0) / mx >= 0.999;
  }).length;
  return {
    date: report.timestamp ?? null,
    model: report.model_name ?? null,
    provider: "cerebras",
    n: scenarios.length,
    passed,
    accuracy: round(report.pass_at_1),
    metrics: {
      meanScorePerDomain: Object.fromEntries(
        Object.entries(report.mean_score_per_domain ?? {}).map(([k, v]) => [
          k,
          round(v, 3),
        ]),
      ),
      latencyMsTotal: report.total_latency_ms ?? null,
    },
    breakdown: {
      byDomain: Object.fromEntries(
        Object.entries(report.mean_score_per_domain ?? {}).map(([k, v]) => [
          k,
          round(v, 3),
        ]),
      ),
    },
  };
}

// Map a scenario id to its domain, layout-independently: `calendar.foo` →
// `calendar`, and smoke ids like `smoke_static_calendar_01` → `calendar`. This
// avoids relying on folder names (which are wrong for a flat directory).
function domainOf(scenarioId) {
  const smoke = /^smoke_(?:static|live)_([a-z]+)_/.exec(scenarioId);
  if (smoke) return smoke[1];
  return scenarioId.split(".")[0];
}

// Merge a directory of per-domain lifeops_bench reports (one JSON per domain,
// flat or nested one level) into a single lifeops_bench-shaped report. Skips any
// JSON whose `scenarios` is not an array (e.g. a committed scorecard.summary.json
// whose `scenarios` is a count), so the tool is robust to being pointed at an
// evidence directory that also holds derived artifacts.
function mergeLifeopsBenchDir(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json") && !entry.name.startsWith("_"))
        files.push(full);
    }
  };
  walk(dir);
  const scenarios = [];
  const domScores = {};
  let model = null;
  let ts = null;
  let latency = 0;
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, "utf8"));
    if (!Array.isArray(d.scenarios)) continue; // not a run report (e.g. scorecard)
    for (const s of d.scenarios) {
      scenarios.push(s);
      const domain = domainOf(s.scenario_id);
      if (!domScores[domain]) domScores[domain] = [];
      domScores[domain].push((s.total_score ?? 0) / (s.max_score || 1));
    }
    model = model ?? d.model_name ?? null;
    ts = ts ?? d.timestamp ?? null;
    latency += d.total_latency_ms ?? 0;
  }
  if (scenarios.length === 0) {
    throw new Error(`No lifeops_bench scenarios found under ${dir}`);
  }
  const passed = scenarios.filter(
    (s) => (s.total_score ?? 0) / (s.max_score || 1) >= 0.999,
  ).length;
  return {
    scenarios,
    model_name: model,
    timestamp: ts,
    pass_at_1: passed / scenarios.length,
    mean_score_per_domain: Object.fromEntries(
      Object.entries(domScores).map(([k, v]) => [
        k,
        v.reduce((a, b) => a + b, 0) / v.length,
      ]),
    ),
    total_latency_ms: latency,
  };
}

function normalize(report, harness) {
  if (harness === "lifeops-prompt-benchmark") {
    if (report.accuracy === undefined || report.byTask === undefined) {
      throw new Error(
        "Report does not look like a TS prompt-benchmark report.",
      );
    }
    return normalizeTsPromptBenchmark(report);
  }
  if (harness === "lifeops_bench") {
    if (report.pass_at_1 === undefined || report.scenarios === undefined) {
      throw new Error(
        "Report does not look like a Python lifeops_bench report.",
      );
    }
    return normalizePythonLifeopsBench(report);
  }
  throw new Error(`Unknown --harness: ${harness}`);
}

// --- HISTORY.md renderer ------------------------------------------------------------

function readRows() {
  if (!existsSync(JSONL)) return [];
  return readFileSync(JSONL, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function renderHistory(rows) {
  const byHarness = new Map();
  for (const r of rows) {
    if (!byHarness.has(r.harness)) byHarness.set(r.harness, []);
    byHarness.get(r.harness).push(r);
  }
  const lines = [];
  lines.push("# LifeOps/PA real-model benchmark — score history\n");
  lines.push(
    "Durable, append-only series backing #11789. Every row is a **live-model** run",
  );
  lines.push(
    "(no proxy, no mock judge) against `develop`, keyed by harness so points stay",
  );
  lines.push(
    "comparable within a series. Add a row with `scripts/append-score-history.mjs`",
  );
  lines.push(
    "(never hand-edit this file — it is regenerated from `score-history.jsonl`).\n",
  );
  for (const [harness, hrows] of byHarness) {
    hrows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    lines.push(`## Series: \`${harness}\`\n`);
    lines.push(
      "| date (UTC) | model | slice | n | pass | accuracy | commit | notes |",
    );
    lines.push("|---|---|---|---:|---:|---:|---|---|");
    for (const r of hrows) {
      const date = String(r.date ?? "")
        .replace("T", " ")
        .replace(/\..*/, "");
      const acc =
        r.accuracy == null ? "—" : `${(r.accuracy * 100).toFixed(1)}%`;
      const commit = r.commit ? `\`${String(r.commit).slice(0, 9)}\`` : "—";
      lines.push(
        `| ${date} | ${r.model ?? "—"} | ${r.slice ?? "—"} | ${r.n ?? "—"} | ${r.passed ?? "—"} | ${acc} | ${commit} | ${r.notes ?? ""} |`,
      );
    }
    lines.push("");
  }
  lines.push("---\n");
  lines.push(
    "Per-run breakdowns (per-task / per-domain) and raw artifacts live in the",
  );
  lines.push(
    "committed run files referenced by each row's `source`, and in `score-history.jsonl`.\n",
  );
  return `${lines.join("\n")}`;
}

// --- main ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.harness || (!args.report && !args["report-dir"])) {
    throw new Error(
      "Required: --harness <name> and one of --report <file> | --report-dir <dir>",
    );
  }
  const report = args["report-dir"]
    ? mergeLifeopsBenchDir(args["report-dir"])
    : JSON.parse(readFileSync(args.report, "utf8"));
  const norm = normalize(report, args.harness);

  const row = {
    date: norm.date,
    harness: args.harness,
    model: args.model ?? norm.model,
    provider: args.provider ?? norm.provider,
    slice: args.slice ?? null,
    n: norm.n,
    passed: norm.passed,
    accuracy: norm.accuracy,
    metrics: norm.metrics,
    breakdown: norm.breakdown,
    commit: args.commit ?? null,
    source:
      args.source ??
      (args.report
        ? path.basename(args.report)
        : path.basename(args["report-dir"] ?? "")),
    notes: args.notes ?? null,
  };
  if (!row.date) throw new Error("Could not read a run date from the report.");

  const rows = readRows();
  const dup = rows.find(
    (r) =>
      r.date === row.date && r.harness === row.harness && r.slice === row.slice,
  );
  if (dup) {
    console.error(
      `[append-score-history] a row for (${row.date}, ${row.harness}, ${row.slice}) already exists — skipping.`,
    );
    return;
  }
  rows.push(row);
  writeFileSync(
    JSONL,
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(HISTORY_MD, renderHistory(rows), "utf8");
  console.log(
    `[append-score-history] +1 row (${row.harness} / ${row.model} / ${row.slice}) acc=${row.accuracy} → ${path.relative(process.cwd(), JSONL)}`,
  );
}

main();
