#!/usr/bin/env bun
/**
 * Standalone dogfood runner. Runs the gitpathologist pipeline against any
 * repo + surface, with no @elizaos/core runtime required (uses heuristic
 * narration fallback). Prints the rendered markdown report plus the
 * raw scored timeline.
 *
 * Usage:
 *   bun run plugins/plugin-gitpathologist/scripts/dogfood.ts <repoRoot> <surface> [since]
 *
 * Example:
 *   bun run plugins/plugin-gitpathologist/scripts/dogfood.ts \
 *     a:/programa/ai/milaidy/eliza \
 *     packages/agent/src/runtime \
 *     60d
 */

import path from "node:path";
import { classify } from "../src/pipeline/classify.ts";
import { findInflections } from "../src/pipeline/inflect.ts";
import { buildFallbackCauses } from "../src/pipeline/narrate-fallback.ts";
import { headSha as readHeadSha, scan } from "../src/pipeline/scan.ts";
import { score } from "../src/pipeline/score.ts";
import { renderReport } from "../src/render.ts";
import type { PathologyReport, SurfaceSpec } from "../src/types.ts";

const [repoRootRaw, surfaceRaw, sinceRaw] = process.argv.slice(2);
if (!repoRootRaw || !surfaceRaw) {
  console.error("usage: bun run dogfood.ts <repoRoot> <surface> [since]");
  process.exit(1);
}
const repoRoot = path.resolve(repoRootRaw);
const surface: SurfaceSpec = { path: surfaceRaw, repoRoot };
const since = sinceRaw ?? "60d";

console.error(`[dogfood] repoRoot=${repoRoot}`);
console.error(`[dogfood] surface=${surface.path}`);
console.error(`[dogfood] since=${since}`);

const t0 = Date.now();
const raw = scan(surface, { since });
console.error(`[dogfood] scan: ${raw.length} commits in ${Date.now() - t0}ms`);
if (raw.length === 0) {
  console.error("[dogfood] no commits in window — nothing to analyze");
  process.exit(0);
}

const chronological = [...raw].reverse();
const classified = classify(chronological);
const points = score(classified);
const { peaks, drifts } = findInflections(points);
const rotCauses = buildFallbackCauses({ timeline: points, drifts });
const llmCalls = 0;

const report: PathologyReport = {
  surface: surface.path,
  repoRoot,
  window: {
    since: points[0]?.date ?? new Date().toISOString(),
    until: points[points.length - 1]?.date ?? new Date().toISOString(),
  },
  commitCount: points.length,
  authors: Array.from(new Set(points.map((p) => p.author))).sort(),
  timeline: points,
  peaks,
  drifts,
  rotCauses,
  llmCalls,
  headSha: readHeadSha(repoRoot),
  generatedAt: new Date().toISOString(),
  cacheKey: "dogfood",
};

console.log(renderReport(report));
console.log("\n---\n## Raw scored timeline\n");
for (const p of points) {
  console.log(
    `\`${p.sha.slice(0, 7)}\` ${p.type.padEnd(8)} files=${String(p.files.length).padStart(3)} churn=${String(p.churn).padStart(5)} delta=${p.delta.toFixed(2).padStart(6)} score=${p.score.toFixed(2).padStart(6)} | ${p.subject.slice(0, 80)}`,
  );
}
console.error(`[dogfood] total: ${Date.now() - t0}ms, ${llmCalls} LLM calls (heuristic fallback)`);
