#!/usr/bin/env bun
/**
 * Retrieval funnel analyzer.
 *
 * Walks `~/.eliza/trajectories/` (or `--input <dir>`), reads every JSON
 * file, and for each `toolSearch` stage that has `perStageScores` plus a
 * `correctActions` ground-truth list, computes:
 *
 *  1. Stage-by-stage recall @ {1, 3, 5, 10}.
 *  2. Which stage first surfaces each correct action, and at what rank.
 *  3. Fused (RRF) top-K recall vs. each individual stage.
 *
 * Emits:
 *  - `docs/audits/lifeops-2026-05-11/retrieval-funnel.md`
 *  - `docs/audits/lifeops-2026-05-11/retrieval-funnel.json`
 *
 * Use:
 *   bun scripts/lifeops-retrieval-funnel.mjs
 *   bun scripts/lifeops-retrieval-funnel.mjs --input /custom/trajectory/dir
 *   bun scripts/lifeops-retrieval-funnel.mjs --out /tmp/funnel.json
 *
 * The script tolerates missing fields — trajectories without
 * `perStageScores` or `correctActions` are counted as "skipped" and never
 * contribute to recall numbers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STAGES = [
  "exact",
  "regex",
  "keyword",
  "bm25",
  "embedding",
  "contextMatch",
];
const KS = [1, 3, 5, 10];

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { input: null, outDir: null, outJson: null, outMd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") out.input = argv[++i];
    else if (arg === "--out-dir") out.outDir = argv[++i];
    else if (arg === "--out-json") out.outJson = argv[++i];
    else if (arg === "--out-md") out.outMd = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const inputRoot =
  args.input ?? path.join(os.homedir(), ".eliza", "trajectories");
const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const defaultOutDir = path.join(
  repoRoot,
  "docs",
  "audits",
  "lifeops-2026-05-11",
);
const outDir = args.outDir ?? defaultOutDir;
const outJson = args.outJson ?? path.join(outDir, "retrieval-funnel.json");
const outMd = args.outMd ?? path.join(outDir, "retrieval-funnel.md");

// ---------------------------------------------------------------------------
// trajectory walk
// ---------------------------------------------------------------------------

function listTrajectoryFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile() && root.endsWith(".json")) {
    out.push(root);
    return out;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTrajectoryFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return { __parseError: String(err) };
  }
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

function normalize(actionName) {
  return String(actionName ?? "")
    .trim()
    .toLowerCase();
}

function buildStageRankIndex(perStageScores) {
  // Returns Map<stage, Map<normalizedActionName, rank>>
  const result = new Map();
  for (const stage of STAGES) {
    const entries = perStageScores?.[stage] ?? [];
    const inner = new Map();
    for (const entry of entries) {
      inner.set(normalize(entry.actionName), entry.rank);
    }
    result.set(stage, inner);
  }
  return result;
}

function buildFusedRankIndex(fusedTopK) {
  const inner = new Map();
  for (const entry of fusedTopK ?? []) {
    inner.set(normalize(entry.actionName), entry.rank);
  }
  return inner;
}

function recallAt(stageRanks, correctActions, k) {
  if (!correctActions.length) return null;
  let hits = 0;
  for (const correct of correctActions) {
    const rank = stageRanks.get(normalize(correct));
    if (rank !== undefined && rank <= k) hits += 1;
  }
  return hits / correctActions.length;
}

function firstAppearsAt(perStageRanks, fusedRanks, correctAction) {
  let best = null;
  for (const stage of STAGES) {
    const rank = perStageRanks.get(stage)?.get(normalize(correctAction));
    if (rank === undefined) continue;
    if (!best || rank < best.rank) {
      best = { stage, rank };
    }
  }
  const fusedRank = fusedRanks.get(normalize(correctAction));
  if (fusedRank !== undefined && (!best || fusedRank < best.rank)) {
    best = { stage: "fused", rank: fusedRank };
  }
  return best;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function analyze() {
  const files = listTrajectoryFiles(inputRoot);
  const stats = {
    filesScanned: 0,
    toolSearchStagesSeen: 0,
    stagesWithMeasurement: 0,
    stagesWithCorrectActions: 0,
    countedSamples: 0,
  };
  // For each stage (+ "fused"), keep arrays of recall@K values.
  const recallBuckets = {};
  for (const stage of [...STAGES, "fused"]) {
    recallBuckets[stage] = {};
    for (const k of KS) recallBuckets[stage][k] = [];
  }
  // Histogram of "where the correct action first appears".
  const firstAppearHist = {};
  for (const stage of [...STAGES, "fused", "never"]) {
    firstAppearHist[stage] = 0;
  }

  for (const file of files) {
    stats.filesScanned += 1;
    const traj = safeReadJson(file);
    if (traj.__parseError) continue;
    for (const stageRec of traj.stages ?? []) {
      if (stageRec.kind !== "toolSearch") continue;
      const ts = stageRec.toolSearch;
      if (!ts) continue;
      stats.toolSearchStagesSeen += 1;
      if (!ts.perStageScores) continue;
      stats.stagesWithMeasurement += 1;
      const correctActions = Array.isArray(ts.correctActions)
        ? ts.correctActions
        : null;
      if (!correctActions || correctActions.length === 0) continue;
      stats.stagesWithCorrectActions += 1;
      stats.countedSamples += 1;

      const perStageRanks = buildStageRankIndex(ts.perStageScores);
      const fusedRanks = buildFusedRankIndex(ts.fusedTopK);

      for (const stage of STAGES) {
        for (const k of KS) {
          const r = recallAt(perStageRanks.get(stage), correctActions, k);
          if (r !== null) recallBuckets[stage][k].push(r);
        }
      }
      for (const k of KS) {
        const r = recallAt(fusedRanks, correctActions, k);
        if (r !== null) recallBuckets.fused[k].push(r);
      }
      for (const correct of correctActions) {
        const first = firstAppearsAt(perStageRanks, fusedRanks, correct);
        if (!first) firstAppearHist.never += 1;
        else firstAppearHist[first.stage] += 1;
      }
    }
  }

  const recallSummary = {};
  for (const stage of [...STAGES, "fused"]) {
    recallSummary[stage] = {};
    for (const k of KS) {
      const arr = recallBuckets[stage][k];
      recallSummary[stage][k] =
        arr.length === 0 ? null : arr.reduce((s, v) => s + v, 0) / arr.length;
    }
  }
  return { stats, recallSummary, firstAppearHist };
}

function fmt(value) {
  if (value === null || value === undefined) return "—";
  return value.toFixed(2);
}

function buildMarkdown(report) {
  const { stats, recallSummary, firstAppearHist } = report;
  const lines = [];
  lines.push("# Retrieval Funnel Analysis");
  lines.push("");
  lines.push("Generated by `scripts/lifeops-retrieval-funnel.mjs`.");
  lines.push("");
  lines.push("## Sample counts");
  lines.push("");
  lines.push(`- Files scanned: ${stats.filesScanned}`);
  lines.push(`- toolSearch stages seen: ${stats.toolSearchStagesSeen}`);
  lines.push(
    `- Stages with \`perStageScores\` (measurement on): ${stats.stagesWithMeasurement}`,
  );
  lines.push(
    `- Stages with ground-truth \`correctActions\`: ${stats.stagesWithCorrectActions}`,
  );
  lines.push(`- Counted samples: ${stats.countedSamples}`);
  lines.push("");
  lines.push("## Stage-by-stage recall");
  lines.push("");
  lines.push(
    "| Stage          | Top-1 recall | Top-3 recall | Top-5 recall | Top-10 recall |",
  );
  lines.push(
    "|----------------|--------------|--------------|--------------|---------------|",
  );
  for (const stage of STAGES) {
    const r = recallSummary[stage];
    lines.push(
      `| ${stage.padEnd(14)} | ${fmt(r[1]).padEnd(12)} | ${fmt(r[3]).padEnd(12)} | ${fmt(r[5]).padEnd(12)} | ${fmt(r[10]).padEnd(13)} |`,
    );
  }
  const fused = recallSummary.fused;
  lines.push(
    `| **fused (RRF)**| ${fmt(fused[1]).padEnd(12)} | ${fmt(fused[3]).padEnd(12)} | ${fmt(fused[5]).padEnd(12)} | ${fmt(fused[10]).padEnd(13)} |`,
  );
  lines.push("");
  lines.push("## Correct-action-first-appears-here histogram");
  lines.push("");
  lines.push("| Stage   | Count |");
  lines.push("|---------|-------|");
  for (const stage of [...STAGES, "fused", "never"]) {
    lines.push(
      `| ${stage.padEnd(7)} | ${String(firstAppearHist[stage]).padEnd(5)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const report = analyze();
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outMd, buildMarkdown(report));
  process.stdout.write(
    `[funnel] scanned=${report.stats.filesScanned} counted=${report.stats.countedSamples}\n`,
  );
  process.stdout.write(`[funnel] wrote ${outJson}\n`);
  process.stdout.write(`[funnel] wrote ${outMd}\n`);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lifeops-retrieval-funnel.mjs");
if (isMain) main();

export { analyze, buildMarkdown };
