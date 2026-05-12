#!/usr/bin/env bun
/**
 * Smoke test for `scripts/lifeops-retrieval-funnel.mjs`.
 *
 * Writes a synthetic trajectory directory with two `toolSearch` stages
 * (one where the correct action is recovered at rank 1 via `exact`, one
 * where it's only recovered at rank 4 via `bm25`), runs the funnel
 * script via a child process, and validates the emitted markdown table
 * + JSON shape.
 *
 * Invocation: `bun scripts/__tests__/lifeops-retrieval-funnel.test.mjs`.
 * Exits non-zero on the first failed assertion.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-funnel-test-"));
const trajectoryDir = path.join(tmpRoot, "trajectories", "agent-test");
const outDir = path.join(tmpRoot, "out");
fs.mkdirSync(trajectoryDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

function makeTrajectory({
  trajectoryId,
  correctActions,
  perStageScores,
  fusedTopK,
}) {
  return {
    trajectoryId,
    agentId: "agent-test",
    scenarioId: trajectoryId,
    rootMessage: { id: "m1", text: "test", sender: "u" },
    startedAt: 1_700_000_000_000,
    status: "completed",
    stages: [
      {
        stageId: `stage-toolsearch-${trajectoryId}`,
        kind: "toolSearch",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_000_100,
        latencyMs: 100,
        toolSearch: {
          query: { text: "do the thing" },
          results: [],
          tier: { tierA: [], tierB: [], omitted: 0 },
          durationMs: 100,
          correctActions,
          perStageScores,
          fusedTopK,
        },
      },
    ],
  };
}

// Trajectory A — correct action MUSIC, exact-hint hits at rank 1.
const trajA = makeTrajectory({
  trajectoryId: "tj-A",
  correctActions: ["MUSIC"],
  perStageScores: {
    exact: [{ actionName: "MUSIC", score: 1, rank: 1 }],
    regex: [],
    keyword: [
      { actionName: "MUSIC", score: 0.8, rank: 1 },
      { actionName: "EMAIL", score: 0.2, rank: 2 },
    ],
    bm25: [
      { actionName: "MUSIC", score: 1.5, rank: 1 },
      { actionName: "PLAY_TRACK", score: 0.9, rank: 2 },
    ],
    embedding: [],
    contextMatch: [],
  },
  fusedTopK: [
    { actionName: "MUSIC", rrfScore: 0.05, rank: 1 },
    { actionName: "PLAY_TRACK", rrfScore: 0.02, rank: 2 },
  ],
});

// Trajectory B — correct action CALENDAR, only bm25 surfaces it (rank 4),
// and the fused list also surfaces it at rank 3.
const trajB = makeTrajectory({
  trajectoryId: "tj-B",
  correctActions: ["CALENDAR"],
  perStageScores: {
    exact: [],
    regex: [],
    keyword: [
      { actionName: "EMAIL", score: 0.5, rank: 1 },
      { actionName: "MUSIC", score: 0.3, rank: 2 },
    ],
    bm25: [
      { actionName: "EMAIL", score: 1, rank: 1 },
      { actionName: "MUSIC", score: 0.9, rank: 2 },
      { actionName: "PLAY_TRACK", score: 0.8, rank: 3 },
      { actionName: "CALENDAR", score: 0.7, rank: 4 },
    ],
    embedding: [],
    contextMatch: [],
  },
  fusedTopK: [
    { actionName: "EMAIL", rrfScore: 0.04, rank: 1 },
    { actionName: "MUSIC", rrfScore: 0.03, rank: 2 },
    { actionName: "CALENDAR", rrfScore: 0.02, rank: 3 },
  ],
});

// Trajectory C — no perStageScores. Should be ignored by the funnel.
const trajC = {
  trajectoryId: "tj-C",
  agentId: "agent-test",
  rootMessage: { id: "m1", text: "test", sender: "u" },
  startedAt: 1_700_000_000_000,
  status: "completed",
  stages: [
    {
      stageId: "stage-toolsearch-C",
      kind: "toolSearch",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_100,
      latencyMs: 100,
      toolSearch: {
        query: { text: "no measurement" },
        results: [],
        tier: { tierA: [], tierB: [], omitted: 0 },
        durationMs: 100,
      },
    },
  ],
};

fs.writeFileSync(path.join(trajectoryDir, "tj-A.json"), JSON.stringify(trajA));
fs.writeFileSync(path.join(trajectoryDir, "tj-B.json"), JSON.stringify(trajB));
fs.writeFileSync(path.join(trajectoryDir, "tj-C.json"), JSON.stringify(trajC));

const outJson = path.join(outDir, "retrieval-funnel.json");
const outMd = path.join(outDir, "retrieval-funnel.md");

const scriptPath = path.join(
  REPO_ROOT,
  "scripts",
  "lifeops-retrieval-funnel.mjs",
);

const result = spawnSync(
  process.execPath,
  [
    scriptPath,
    "--input",
    path.join(tmpRoot, "trajectories"),
    "--out-json",
    outJson,
    "--out-md",
    outMd,
  ],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  failures.push(
    `funnel script exited with status ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
  );
}

assert(fs.existsSync(outJson), "funnel JSON output missing");
assert(fs.existsSync(outMd), "funnel markdown output missing");

const report = JSON.parse(fs.readFileSync(outJson, "utf8"));

assert(
  report.stats.filesScanned === 3,
  `expected 3 files scanned, got ${report.stats.filesScanned}`,
);
assert(
  report.stats.toolSearchStagesSeen === 3,
  `expected 3 toolSearch stages, got ${report.stats.toolSearchStagesSeen}`,
);
assert(
  report.stats.stagesWithMeasurement === 2,
  `expected 2 measured stages (C ignored), got ${report.stats.stagesWithMeasurement}`,
);
assert(
  report.stats.countedSamples === 2,
  `expected 2 counted samples, got ${report.stats.countedSamples}`,
);

// recallSummary checks
// exact: only A contributes — A correct=MUSIC at rank 1 → recall@1 = 1.0;
// B contributes 0.0 → mean recall@1 across both should be 0.5.
const r = report.recallSummary;
assert(
  Math.abs(r.exact["1"] - 0.5) < 1e-9,
  `exact recall@1 expected 0.5, got ${r.exact["1"]}`,
);
// bm25 recall@1 — A has MUSIC at rank 1, B has CALENDAR at rank 4 → 0.5
assert(
  Math.abs(r.bm25["1"] - 0.5) < 1e-9,
  `bm25 recall@1 expected 0.5, got ${r.bm25["1"]}`,
);
// bm25 recall@5 — A=1, B=1 (CALENDAR at rank 4 ≤ 5) → mean 1.0
assert(
  Math.abs(r.bm25["5"] - 1.0) < 1e-9,
  `bm25 recall@5 expected 1.0, got ${r.bm25["5"]}`,
);
// fused recall@3 — A=1 (rank 1), B=1 (rank 3) → mean 1.0
assert(
  Math.abs(r.fused["3"] - 1.0) < 1e-9,
  `fused recall@3 expected 1.0, got ${r.fused["3"]}`,
);

// firstAppearHist: A's correct=MUSIC first appears in `exact` at rank 1;
// B's correct=CALENDAR first appears in `bm25` at rank 4 (lower than
// fused rank 3 → wait, 3 < 4, so fused wins).
const hist = report.firstAppearHist;
assert(hist.exact === 1, `firstAppearHist.exact expected 1, got ${hist.exact}`);
assert(
  hist.fused === 1,
  `firstAppearHist.fused expected 1 (CALENDAR via fused rank 3 < bm25 rank 4), got ${hist.fused}`,
);

// markdown smoke
const md = fs.readFileSync(outMd, "utf8");
assert(md.includes("# Retrieval Funnel Analysis"), "markdown missing title");
assert(md.includes("| Stage"), "markdown missing recall table header");
assert(md.includes("**fused (RRF)**"), "markdown missing fused row");
assert(md.includes("histogram"), "markdown missing histogram section");

if (failures.length > 0) {
  process.stderr.write(`FAIL — ${failures.length} assertion(s)\n`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write("ok — lifeops-retrieval-funnel.test.mjs\n");
