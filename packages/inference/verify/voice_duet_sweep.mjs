#!/usr/bin/env bun
/*
 * voice_duet_sweep.mjs — the scientific latency grind for the two-agents-
 * talking-endlessly path.
 *
 * Runs `packages/app-core/scripts/voice-duet.mjs --turns N --report …` across
 * a grid of the latency knobs (DFlash `--parallel` / `--draft-max` /
 * `--ctx-size-draft`, the phrase-chunker word threshold, `--prewarm-lead-ms`,
 * the cross-ring size `--ring-ms`, the KV-cache type, the backend), collects
 * the headline percentiles + the DFlash accept-rate + the structured-decode
 * token-savings % + tok/s + RSS-over-N into one CSV, and emits a before/after
 * table. The grind methodology:
 *
 *   1. baseline run → profile the dominant per-stage span from the tracer
 *      histogram (the report's `latency.histograms`).
 *   2. sweep that stage's knob (smaller chunks → lower first-audio, worse RTF;
 *      bigger draft window → higher accept-rate but more verify cost; …).
 *   3. pick the config that minimizes `ttftFromUtteranceEndMs.p50` /
 *      `firstAudioIntoPeerRingFromUtteranceEndMs.p50` without regressing
 *      accept-rate.
 *   4. re-run, repeat until the round-trip plateaus.
 *
 * On a CPU build TTS dominates (~6–10× RTF — `e2e-loop-benchmark.md`), so the
 * CPU sweep is a methodology/harness baseline; the headline grind needs a
 * GPU-fused build (WS-2) + the W7 streaming decoders (WS-4). This script runs
 * the CPU baseline now and the GPU sweep when those land — same harness.
 *
 * Honesty: a knob combo whose `voice-duet.mjs` invocation exits non-zero
 * (missing bundle / fused lib / kernels) is recorded as a failed cell with the
 * exit code and stderr tail — never a fabricated row. `--dry-run` prints the
 * grid + the commands it would run, then exits.
 *
 *   bun packages/inference/verify/voice_duet_sweep.mjs \
 *     --model eliza-1-0_8b --turns 20 \
 *     --parallel 1,2 --draft-max 8,16 --ring-ms 160,200,240 \
 *     --out reports/porting/<date>/voice-duet-sweep-0_8b.csv
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const VOICE_DUET = path.join(
  REPO_ROOT,
  "packages",
  "app-core",
  "scripts",
  "voice-duet.mjs",
);

function executableForBunHarness() {
  if (process.versions?.bun) return process.execPath;
  return process.env.BUN_EXE || "bun";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    model: "eliza-1-0_8b",
    turns: 20,
    out: null,
    dryRun: false,
    twoProcess: false,
    timeoutMs: 600_000, // per-cell hard cap
    // Grid axes — comma-separated lists; a single value = a fixed axis.
    parallel: [null],
    draftMax: [null],
    ctxSizeDraft: [null],
    chunkWords: [null],
    prewarmLeadMs: [null],
    ringMs: [200],
    kvCacheType: [null],
    backend: [null],
  };
  const list = (s) =>
    String(s)
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i] ?? out.model;
    else if (a === "--turns") out.turns = Number(argv[++i]) || out.turns;
    else if (a === "--out") out.out = argv[++i] ?? null;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--two-process") out.twoProcess = true;
    else if (a === "--cell-timeout-ms")
      out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (a === "--parallel") out.parallel = list(argv[++i]);
    else if (a === "--draft-max") out.draftMax = list(argv[++i]);
    else if (a === "--ctx-size-draft") out.ctxSizeDraft = list(argv[++i]);
    else if (a === "--chunk-words") out.chunkWords = list(argv[++i]);
    else if (a === "--prewarm-lead-ms") out.prewarmLeadMs = list(argv[++i]);
    else if (a === "--ring-ms") out.ringMs = list(argv[++i]);
    else if (a === "--kv-cache-type") out.kvCacheType = list(argv[++i]);
    else if (a === "--backend") out.backend = list(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`[voice-duet-sweep] unknown arg: ${a}`);
      out.help = true;
    }
  }
  return out;
}

const USAGE = `Usage: bun packages/inference/verify/voice_duet_sweep.mjs [options]

  --model <id>            tier bundle (default eliza-1-0_8b)
  --turns <N>             round-trips per cell (default 20)
  --out <path>            CSV output (default reports/porting/<date>/voice-duet-sweep-<model>.csv)
  --two-process           pass --two-process to voice-duet.mjs (2b RSS split)
  --dry-run               print the grid + the commands, then exit
  --cell-timeout-ms <ms>  per-cell hard cap (default 600000)

Grid axes (comma-separated; one value = a fixed axis):
  --parallel 1,2          DFlash llama-server slots
  --draft-max 8,16        DFlash draft window
  --ctx-size-draft 1024   drafter context size
  --chunk-words 6,12      phrase-chunker words per phrase
  --prewarm-lead-ms 0,80  prewarm-ahead lead
  --ring-ms 160,200,240   cross-ring size
  --kv-cache-type turbo3,turbo3_tcq,f16
  --backend cuda,vulkan,cpu
`;

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

function cartesian(axes) {
  // axes: { name: [values...] } → [{name: value, ...}, ...]
  let acc = [{}];
  for (const [name, values] of Object.entries(axes)) {
    const next = [];
    for (const partial of acc) {
      for (const v of values) next.push({ ...partial, [name]: v });
    }
    acc = next;
  }
  return acc;
}

function cellToDuetArgs(cell, opts) {
  const a = [VOICE_DUET, "--model", opts.model, "--turns", String(opts.turns)];
  if (opts.twoProcess) a.push("--two-process");
  if (cell.parallel != null) a.push("--parallel", String(cell.parallel));
  if (cell.draftMax != null) a.push("--draft-max", String(cell.draftMax));
  if (cell.ctxSizeDraft != null)
    a.push("--ctx-size-draft", String(cell.ctxSizeDraft));
  if (cell.chunkWords != null) a.push("--chunk-words", String(cell.chunkWords));
  if (cell.prewarmLeadMs != null)
    a.push("--prewarm-lead-ms", String(cell.prewarmLeadMs));
  if (cell.ringMs != null) a.push("--ring-ms", String(cell.ringMs));
  if (cell.kvCacheType != null)
    a.push("--kv-cache-type", String(cell.kvCacheType));
  if (cell.backend != null) a.push("--backend", String(cell.backend));
  return a;
}

// ---------------------------------------------------------------------------
// Run one cell
// ---------------------------------------------------------------------------

function runCell(cell, opts, reportPath) {
  return new Promise((resolve) => {
    const args = [...cellToDuetArgs(cell, opts), "--report", reportPath];
    const started = Date.now();
    let stderrTail = "";
    const child = spawn(executableForBunHarness(), args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    child.stderr.on("data", (b) => {
      stderrTail = (stderrTail + b.toString("utf8")).slice(-2000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const wallMs = Date.now() - started;
      let report = null;
      try {
        if (fs.existsSync(reportPath)) {
          report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        }
      } catch {
        /* partial report */
      }
      resolve({ code, signal, wallMs, report, stderrTail });
    });
  });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_HEADER = [
  "cell",
  "parallel",
  "draftMax",
  "ctxSizeDraft",
  "chunkWords",
  "prewarmLeadMs",
  "ringMs",
  "kvCacheType",
  "backend",
  "exitCode",
  "wallMs",
  "completedTurns",
  "ttftFromUtteranceEndMs_p50",
  "ttftFromUtteranceEndMs_p90",
  "ttftFromUtteranceEndMs_p99",
  "duetRoundTripMs_p50",
  "duetRoundTripMs_p90",
  "ttftMs_p50",
  "ttfaMs_p50",
  "envelopeToReplyTextMs_p50",
  "ttsFirstChunkMs_p50",
  "dflashAcceptRate",
  "structuredDecodeTokenSavingsPct_p50",
  "tokensPerSecond_p50",
  "rssFirstMb",
  "rssLastMb",
  "rssMaxMb",
  "leakSuspected",
  "emotionFidelityAccuracy",
  "emotionPerceiver",
  "note",
];

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowFor(cellIdx, cell, result) {
  const r = result.report ?? {};
  const h = r.latency?.histograms ?? {};
  const m = r.runMetrics ?? {};
  const pick = (k, p) => h?.[k]?.[p] ?? null;
  const note =
    result.code === 0
      ? r.notes
        ? "ok"
        : "ok"
      : `EXIT ${result.code}${result.signal ? `/${result.signal}` : ""}${result.stderrTail ? `: ${result.stderrTail.split("\n").pop()}` : ""}`;
  return [
    cellIdx,
    cell.parallel,
    cell.draftMax,
    cell.ctxSizeDraft,
    cell.chunkWords,
    cell.prewarmLeadMs,
    cell.ringMs,
    cell.kvCacheType,
    cell.backend,
    result.code,
    result.wallMs,
    r.completedTurns ?? null,
    pick("ttftFromUtteranceEndMs", "p50"),
    pick("ttftFromUtteranceEndMs", "p90"),
    pick("ttftFromUtteranceEndMs", "p99"),
    pick("firstAudioIntoPeerRingFromUtteranceEndMs", "p50"),
    pick("firstAudioIntoPeerRingFromUtteranceEndMs", "p90"),
    pick("ttftMs", "p50"),
    pick("ttfaMs", "p50"),
    pick("envelopeToReplyTextMs", "p50"),
    pick("ttsFirstChunkMs", "p50"),
    m?.dflashAcceptRate ?? null,
    m?.structuredDecodeTokenSavingsPct?.p50 ?? null,
    m?.tokensPerSecond?.p50 ?? null,
    m?.rss?.firstMb ?? null,
    m?.rss?.lastMb ?? null,
    m?.rss?.maxMb ?? null,
    m?.rss?.leakSuspected ?? null,
    r.emotionFidelity?.accuracy ?? null,
    r.emotionFidelity?.perceiver ?? null,
    note,
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const date = new Date().toISOString().slice(0, 10);
  const outCsv =
    opts.out ??
    path.join(
      REPO_ROOT,
      "packages",
      "inference",
      "reports",
      "porting",
      date,
      `voice-duet-sweep-${opts.model}.csv`,
    );
  const reportsDir = path.join(
    path.dirname(outCsv),
    `voice-duet-sweep-cells-${opts.model}`,
  );

  const axes = {
    backend: opts.backend,
    kvCacheType: opts.kvCacheType,
    parallel: opts.parallel,
    draftMax: opts.draftMax,
    ctxSizeDraft: opts.ctxSizeDraft,
    chunkWords: opts.chunkWords,
    prewarmLeadMs: opts.prewarmLeadMs,
    ringMs: opts.ringMs,
  };
  const cells = cartesian(axes);

  if (opts.dryRun) {
    process.stdout.write(
      `[voice-duet-sweep] ${cells.length} cells for ${opts.model} (turns=${opts.turns}):\n`,
    );
    cells.forEach((cell, i) => {
      const args = cellToDuetArgs(cell, opts);
      process.stdout.write(`  cell ${i}: bun ${args.join(" ")}\n`);
    });
    process.stdout.write(`[voice-duet-sweep] CSV → ${outCsv}\n`);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(outCsv), { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  const rows = [CSV_HEADER];
  fs.writeFileSync(outCsv, `${CSV_HEADER.map(csvCell).join(",")}\n`);

  process.stdout.write(
    `[voice-duet-sweep] ${cells.length} cells × ${opts.turns} turns — ${opts.model}\n`,
  );
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const reportPath = path.join(reportsDir, `cell-${i}.json`);
    process.stdout.write(
      `[voice-duet-sweep] cell ${i + 1}/${cells.length}: ${JSON.stringify(cell)} … `,
    );
    const result = await runCell(cell, opts, reportPath);
    const row = rowFor(i, cell, result);
    rows.push(row);
    fs.appendFileSync(outCsv, `${row.map(csvCell).join(",")}\n`);
    const ttft =
      result.report?.latency?.histograms?.ttftFromUtteranceEndMs?.p50;
    const rt =
      result.report?.latency?.histograms
        ?.firstAudioIntoPeerRingFromUtteranceEndMs?.p50;
    process.stdout.write(
      result.code === 0
        ? `done (ttft-from-utterance-end p50=${ttft == null ? "—" : `${Math.round(ttft)}ms`}, round-trip p50=${rt == null ? "—" : `${Math.round(rt)}ms`}, ${Math.round(result.wallMs / 1000)}s)\n`
        : `FAILED (exit ${result.code}${result.signal ? `/${result.signal}` : ""})\n`,
    );
  }

  // Before/after table — the baseline cell (the first one) vs the best cell by
  // ttftFromUtteranceEndMs.p50 among the successful ones.
  const ok = rows
    .slice(1)
    .filter((r) => r[CSV_HEADER.indexOf("exitCode")] === 0);
  const idxTtft = CSV_HEADER.indexOf("ttftFromUtteranceEndMs_p50");
  const withTtft = ok.filter(
    (r) => r[idxTtft] != null && Number.isFinite(Number(r[idxTtft])),
  );
  const baseline = rows[1] ?? null;
  const best = withTtft.length
    ? withTtft.reduce((a, b) =>
        Number(a[idxTtft]) <= Number(b[idxTtft]) ? a : b,
      )
    : null;
  const mdPath = outCsv.replace(/\.csv$/i, "") + ".md";
  const fmt = (r, k) => {
    if (!r) return "—";
    const v = r[CSV_HEADER.indexOf(k)];
    return v == null || v === "" ? "—" : String(v);
  };
  const md = [
    `# voice-duet sweep — ${opts.model}`,
    "",
    `- date: ${date}`,
    `- cells: ${cells.length} (${ok.length} succeeded), ${opts.turns} round-trips each`,
    `- CSV: ${path.relative(REPO_ROOT, outCsv)}`,
    "",
    "## Before / after",
    "",
    "| | baseline (cell 0) | best by ttft-from-utterance-end |",
    "|---|---|---|",
    `| config | parallel=${fmt(baseline, "parallel")} draftMax=${fmt(baseline, "draftMax")} ringMs=${fmt(baseline, "ringMs")} chunkWords=${fmt(baseline, "chunkWords")} backend=${fmt(baseline, "backend")} | parallel=${fmt(best, "parallel")} draftMax=${fmt(best, "draftMax")} ringMs=${fmt(best, "ringMs")} chunkWords=${fmt(best, "chunkWords")} backend=${fmt(best, "backend")} |`,
    `| ttftFromUtteranceEndMs.p50 | ${fmt(baseline, "ttftFromUtteranceEndMs_p50")} | ${fmt(best, "ttftFromUtteranceEndMs_p50")} |`,
    `| duetRoundTripMs.p50 | ${fmt(baseline, "duetRoundTripMs_p50")} | ${fmt(best, "duetRoundTripMs_p50")} |`,
    `| dflashAcceptRate | ${fmt(baseline, "dflashAcceptRate")} | ${fmt(best, "dflashAcceptRate")} |`,
    `| structuredDecodeTokenSavingsPct.p50 | ${fmt(baseline, "structuredDecodeTokenSavingsPct_p50")} | ${fmt(best, "structuredDecodeTokenSavingsPct_p50")} |`,
    `| tokensPerSecond.p50 | ${fmt(baseline, "tokensPerSecond_p50")} | ${fmt(best, "tokensPerSecond_p50")} |`,
    `| rssMaxMb | ${fmt(baseline, "rssMaxMb")} | ${fmt(best, "rssMaxMb")} |`,
    "",
    ok.length === 0
      ? "_No cell completed — every `voice-duet.mjs` invocation exited non-zero (missing bundle / fused lib / kernels). See the CSV `note` column for the exit code + stderr tail of each cell. This is recorded, not faked._"
      : "Methodology: profile the dominant per-stage span from each cell's tracer histogram (`latency.histograms`), sweep that stage's knob, pick the config minimising `ttftFromUtteranceEndMs.p50` without regressing `dflashAcceptRate`, re-run, repeat until the round-trip plateaus. On a CPU build TTS dominates (~6–10× RTF) so this is the harness/methodology baseline; the headline grind needs a GPU-fused build (WS-2) + the W7 streaming decoders (WS-4).",
  ];
  fs.writeFileSync(mdPath, `${md.join("\n")}\n`);
  process.stdout.write(
    `[voice-duet-sweep] CSV → ${outCsv}\n[voice-duet-sweep] before/after → ${mdPath}\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `[voice-duet-sweep] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
