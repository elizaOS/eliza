#!/usr/bin/env bun
/**
 * Compute a delta between two `report.json` artifacts emitted by
 * `aggregate-lifeops-run.mjs` and write `<outDir>/delta.json` +
 * `<outDir>/delta.md`.
 *
 * Usage:
 *   bun run lifeops:delta -- \
 *     --baseline <path-to-report.json> \
 *     --candidate <path-to-report.json> \
 *     --out <dir> \
 *     [--baseline-label "develop@abc"] \
 *     [--candidate-label "feature@def"]
 *
 * Schema: `lifeops-bench-delta-v1` (see
 * `packages/benchmarks/lib/src/metrics-schema.ts`). The payload is validated
 * against the Zod schema before write — a validation failure aborts the
 * script with the field paths that failed.
 *
 * `deltaCacheHitPct` is `null` when either side reported no cache info.
 * Otherwise it is `candidate - baseline` (positive = candidate cached more
 * tokens).
 *
 * Pass-rate delta is computed from `passCount / scenarioCount` on each side,
 * not from a per-scenario boolean diff, so the script tolerates scenario
 * sets that drifted between runs (different scenarios still contribute to
 * `perScenario` but only via their own pass booleans).
 */

import fs from "node:fs";
import path from "node:path";
import {
  DELTA_SCHEMA_VERSION,
  DeltaSchema,
  ReportSchema,
} from "@elizaos-benchmarks/lib";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const baselinePath = arg("--baseline");
const candidatePath = arg("--candidate");
const outDir = arg("--out");
if (!baselinePath || !candidatePath || !outDir) {
  console.error(
    "[lifeops-bench-delta] required: --baseline <path> --candidate <path> --out <dir>",
  );
  process.exit(2);
}

const baselineLabel = arg("--baseline-label", "baseline");
const candidateLabel = arg("--candidate-label", "candidate");

function loadReport(p) {
  const raw = fs.readFileSync(path.resolve(p), "utf8");
  const parsed = ReportSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((iss) => `  - ${iss.path.join(".") || "(root)"}: ${iss.message}`)
      .join("\n");
    throw new Error(
      `[lifeops-bench-delta] ${p} is not a valid report.json:\n${issues}`,
    );
  }
  return parsed.data;
}

const baseline = loadReport(baselinePath);
const candidate = loadReport(candidatePath);

// Index scenarios by id so we only compare like-for-like.
const baselineById = new Map(baseline.scenarios.map((s) => [s.scenarioId, s]));
const candidateById = new Map(
  candidate.scenarios.map((s) => [s.scenarioId, s]),
);

const scenarioIds = new Set([...baselineById.keys(), ...candidateById.keys()]);

const perScenario = [];
for (const scenarioId of [...scenarioIds].sort()) {
  const b = baselineById.get(scenarioId);
  const c = candidateById.get(scenarioId);
  // Only emit a scenario delta when both sides ran it.
  if (!b || !c) continue;

  const totalTokensB = b.totalInputTokens + b.totalOutputTokens;
  const totalTokensC = c.totalInputTokens + c.totalOutputTokens;
  const cacheHitB = b.aggregateCacheHitPct;
  const cacheHitC = c.aggregateCacheHitPct;
  const deltaCacheHitPct =
    cacheHitB === null || cacheHitC === null
      ? null
      : +(cacheHitC - cacheHitB).toFixed(4);

  perScenario.push({
    scenarioId,
    passBaseline: b.passAt1,
    passCandidate: c.passAt1,
    deltaCostUsd: +(c.totalCostUsd - b.totalCostUsd).toFixed(6),
    deltaLatencyMs: c.timeToCompleteMs - b.timeToCompleteMs,
    deltaTotalTokens: totalTokensC - totalTokensB,
    deltaCacheHitPct,
  });
}

const baselineRollup = baseline.rollup;
const candidateRollup = candidate.rollup;
const deltaCacheHitPctRollup =
  baselineRollup.aggregateCacheHitPct === null ||
  candidateRollup.aggregateCacheHitPct === null
    ? null
    : +(
        candidateRollup.aggregateCacheHitPct -
        baselineRollup.aggregateCacheHitPct
      ).toFixed(4);

const rollup = {
  deltaPassRate: +(candidateRollup.passRate - baselineRollup.passRate).toFixed(
    4,
  ),
  deltaCostUsd: +(
    candidateRollup.totalCostUsd - baselineRollup.totalCostUsd
  ).toFixed(6),
  deltaTotalTokens:
    candidateRollup.totalInputTokens +
    candidateRollup.totalOutputTokens -
    (baselineRollup.totalInputTokens + baselineRollup.totalOutputTokens),
  deltaCacheHitPct: deltaCacheHitPctRollup,
  deltaTimeMs: candidateRollup.totalTimeMs - baselineRollup.totalTimeMs,
};

const deltaPayload = {
  schemaVersion: DELTA_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  baseline: { runId: baseline.runId, label: baselineLabel },
  candidate: { runId: candidate.runId, label: candidateLabel },
  perScenario,
  rollup,
};

const parsed = DeltaSchema.safeParse(deltaPayload);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((iss) => `  - ${iss.path.join(".") || "(root)"}: ${iss.message}`)
    .join("\n");
  throw new Error(
    `[lifeops-bench-delta] delta.json failed schema validation:\n${issues}`,
  );
}

fs.mkdirSync(path.resolve(outDir), { recursive: true });
const deltaJsonPath = path.join(path.resolve(outDir), "delta.json");
fs.writeFileSync(deltaJsonPath, `${JSON.stringify(parsed.data, null, 2)}\n`);

// ---------------------------------------------------------------------------
// delta.md — human-readable rollup. Pairs with delta.json; both kept side by
// side so reviewers can skim the diff without parsing JSON.
// ---------------------------------------------------------------------------

const fmtDelta = (n) => (n > 0 ? `+${n}` : `${n}`);
const fmtPct = (n) =>
  n === null ? "n/a" : `${(n * 100).toFixed(2).replace(/^-/, "−")}%`;
const fmtDeltaPct = (n) =>
  n === null ? "n/a" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const fmtMoney = (n) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(4)}`;

const mdLines = [
  `# LifeOps benchmark delta`,
  ``,
  `**baseline**: ${baselineLabel} (runId \`${baseline.runId}\`)`,
  `**candidate**: ${candidateLabel} (runId \`${candidate.runId}\`)`,
  `**generatedAt**: ${parsed.data.generatedAt}`,
  ``,
  `## Rollup`,
  ``,
  `| metric | baseline | candidate | Δ |`,
  `| --- | ---: | ---: | ---: |`,
  `| pass rate | ${fmtPct(baselineRollup.passRate)} | ${fmtPct(candidateRollup.passRate)} | ${fmtDeltaPct(rollup.deltaPassRate)} |`,
  `| total cost | $${baselineRollup.totalCostUsd.toFixed(4)} | $${candidateRollup.totalCostUsd.toFixed(4)} | ${fmtMoney(rollup.deltaCostUsd)} |`,
  `| total tokens | ${(baselineRollup.totalInputTokens + baselineRollup.totalOutputTokens).toLocaleString()} | ${(candidateRollup.totalInputTokens + candidateRollup.totalOutputTokens).toLocaleString()} | ${fmtDelta(rollup.deltaTotalTokens)} |`,
  `| cache hit % | ${fmtPct(baselineRollup.aggregateCacheHitPct)} | ${fmtPct(candidateRollup.aggregateCacheHitPct)} | ${fmtDeltaPct(rollup.deltaCacheHitPct)} |`,
  `| total time (ms) | ${baselineRollup.totalTimeMs.toFixed(0)} | ${candidateRollup.totalTimeMs.toFixed(0)} | ${fmtDelta(rollup.deltaTimeMs)} |`,
  ``,
  `## Per-scenario`,
  ``,
  `| scenario | base pass | cand pass | Δ cost | Δ tokens | Δ latency (ms) | Δ cache hit % |`,
  `| --- | :-: | :-: | ---: | ---: | ---: | ---: |`,
];
for (const s of perScenario) {
  mdLines.push(
    `| \`${s.scenarioId}\` | ${s.passBaseline ? "✓" : "✗"} | ${s.passCandidate ? "✓" : "✗"} | ${fmtMoney(s.deltaCostUsd)} | ${fmtDelta(s.deltaTotalTokens)} | ${fmtDelta(s.deltaLatencyMs)} | ${fmtDeltaPct(s.deltaCacheHitPct)} |`,
  );
}

const deltaMdPath = path.join(path.resolve(outDir), "delta.md");
fs.writeFileSync(deltaMdPath, `${mdLines.join("\n")}\n`);

process.stdout.write(
  `[lifeops-bench-delta] wrote ${deltaJsonPath}\n` +
    `[lifeops-bench-delta] wrote ${deltaMdPath}\n`,
);
