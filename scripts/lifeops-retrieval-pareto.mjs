#!/usr/bin/env bun
/**
 * Top-K Pareto sweep for action retrieval.
 *
 * Reads measured trajectories (those with `perStageScores` + `fusedTopK`
 * + `correctActions`) and, for each candidate top-K in
 * `K_SWEEP = [3, 5, 8, 12, 20]`, computes:
 *
 *  - Top-K recall against the `correctActions` ground truth.
 *  - Average action-block token contribution at that K. We don't have a
 *    real tokenizer available in this script — instead we use a
 *    proxy: average `(action-name length + description length) / 4` for
 *    the actions that would land in tier A at that K. The proxy is
 *    monotonically increasing in K so the Pareto curve still has the
 *    right shape.
 *  - Planner pass-rate proxy: the share of trajectories where every
 *    action in `selectedActions` appears in the top-K. If
 *    `selectedActions` is missing for a sample, that sample is
 *    excluded from the pass-rate calculation but still contributes to
 *    recall + tokens.
 *
 * For each tier (small/mid/large/frontier), the script picks the K on
 * the recall-vs-tokens Pareto frontier that:
 *  - hits at least the tier's recall floor (small=0.70, mid=0.78,
 *    large=0.85, frontier=0.90), OR the max recall observed, and
 *  - minimizes token contribution subject to that recall floor.
 *
 * Outputs `docs/audits/lifeops-2026-05-11/retrieval-pareto.md` (table
 * per tier + recommended K).
 *
 * The actual prompt-token contribution depends on the action catalog —
 * the proxy is good enough to rank K's relative to each other, which is
 * what the Pareto cut needs.
 *
 * Use:
 *   bun scripts/lifeops-retrieval-pareto.mjs
 *   bun scripts/lifeops-retrieval-pareto.mjs --input /custom/dir
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const K_SWEEP = [3, 5, 8, 12, 20];
const TIERS = ["small", "mid", "large", "frontier"];
const RECALL_FLOOR_BY_TIER = {
  small: 0.7,
  mid: 0.78,
  large: 0.85,
  frontier: 0.9,
};

function parseArgs(argv) {
  const out = { input: null, outMd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input") out.input = argv[++i];
    else if (a === "--out-md") out.outMd = argv[++i];
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
const outMd =
  args.outMd ??
  path.join(
    repoRoot,
    "docs",
    "audits",
    "lifeops-2026-05-11",
    "retrieval-pareto.md",
  );

function listJson(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile() && root.endsWith(".json")) return [root];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...listJson(full));
    else if (e.isFile() && e.name.endsWith(".json")) out.push(full);
  }
  return out;
}

function normalize(s) {
  return String(s ?? "").trim().toLowerCase();
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function tokenProxyForAction(name) {
  // Without a real tokenizer, approximate the action block contribution
  // by name length / 4. Real action descriptions add ~20-60 tokens; we
  // assume a fixed-ish overhead of 40 + 0.25 * nameLength.
  return 40 + Math.ceil((String(name).length || 6) / 4);
}

function analyzeSamples(samples) {
  // Per K: aggregate recall, token proxy, and pass-rate.
  const byK = {};
  for (const k of K_SWEEP) {
    byK[k] = {
      recallSum: 0,
      recallCount: 0,
      tokenSum: 0,
      tokenCount: 0,
      passCount: 0,
      passDenom: 0,
    };
  }
  for (const sample of samples) {
    const { fusedTopK, correctActions, selectedActions } = sample;
    if (!Array.isArray(fusedTopK) || fusedTopK.length === 0) continue;
    const correctNorm = (correctActions ?? []).map(normalize);
    const selectedNorm = (selectedActions ?? []).map(normalize);
    for (const k of K_SWEEP) {
      const topK = fusedTopK.slice(0, k);
      const topKNorm = new Set(topK.map((e) => normalize(e.actionName)));

      if (correctNorm.length > 0) {
        const hits = correctNorm.filter((c) => topKNorm.has(c)).length;
        byK[k].recallSum += hits / correctNorm.length;
        byK[k].recallCount += 1;
      }
      const tokens = topK.reduce(
        (sum, e) => sum + tokenProxyForAction(e.actionName),
        0,
      );
      byK[k].tokenSum += tokens;
      byK[k].tokenCount += 1;

      if (selectedNorm.length > 0) {
        const allPresent = selectedNorm.every((s) => topKNorm.has(s));
        byK[k].passDenom += 1;
        if (allPresent) byK[k].passCount += 1;
      }
    }
  }
  const summary = {};
  for (const k of K_SWEEP) {
    const b = byK[k];
    summary[k] = {
      recall: b.recallCount === 0 ? null : b.recallSum / b.recallCount,
      tokens: b.tokenCount === 0 ? null : b.tokenSum / b.tokenCount,
      passRate: b.passDenom === 0 ? null : b.passCount / b.passDenom,
      samples: b.recallCount,
    };
  }
  return summary;
}

function recommendK(summary, tier) {
  const floor = RECALL_FLOOR_BY_TIER[tier];
  // Pareto: minimize tokens subject to recall >= floor. If no K meets
  // the floor, pick the K with the highest recall (largest K).
  const candidates = K_SWEEP.filter(
    (k) => summary[k].recall !== null && summary[k].recall >= floor,
  );
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const ta = summary[a].tokens ?? Infinity;
      const tb = summary[b].tokens ?? Infinity;
      return ta - tb;
    });
    return { k: candidates[0], reason: "meets-floor min-tokens" };
  }
  const bestRecallK = [...K_SWEEP].sort((a, b) => {
    const ra = summary[a].recall ?? -1;
    const rb = summary[b].recall ?? -1;
    return rb - ra;
  })[0];
  return { k: bestRecallK, reason: "no K met floor; pick max recall" };
}

function collectSamples() {
  const files = listJson(inputRoot);
  const samples = [];
  let scanned = 0;
  let toolSearchCount = 0;
  let measuredCount = 0;
  for (const f of files) {
    scanned += 1;
    const t = safeReadJson(f);
    if (!t) continue;
    for (const stage of t.stages ?? []) {
      if (stage.kind !== "toolSearch") continue;
      toolSearchCount += 1;
      const ts = stage.toolSearch;
      if (!ts || !ts.fusedTopK) continue;
      measuredCount += 1;
      samples.push({
        fusedTopK: ts.fusedTopK,
        correctActions: ts.correctActions ?? [],
        selectedActions: ts.selectedActions ?? [],
      });
    }
  }
  return { samples, scanned, toolSearchCount, measuredCount };
}

function fmt(v, digits = 2) {
  if (v === null || v === undefined) return "—";
  return v.toFixed(digits);
}

function buildMarkdown({ summary, scanned, measuredCount, samples }) {
  const lines = [];
  lines.push("# Retrieval Top-K Pareto Sweep");
  lines.push("");
  lines.push("Generated by `scripts/lifeops-retrieval-pareto.mjs`.");
  lines.push("");
  lines.push(`- Files scanned: ${scanned}`);
  lines.push(`- Samples with \`fusedTopK\`: ${measuredCount}`);
  lines.push(`- Counted samples: ${samples}`);
  lines.push("");
  lines.push("## Per-K aggregate");
  lines.push("");
  lines.push("| K  | Recall | Token proxy | Pass-rate | n |");
  lines.push("|----|--------|-------------|-----------|---|");
  for (const k of K_SWEEP) {
    const s = summary[k];
    lines.push(
      `| ${String(k).padEnd(2)} | ${fmt(s.recall).padEnd(6)} | ${fmt(s.tokens, 0).padEnd(11)} | ${fmt(s.passRate).padEnd(9)} | ${String(s.samples).padEnd(3)} |`,
    );
  }
  lines.push("");
  lines.push("## Per-tier recommended top-K");
  lines.push("");
  lines.push(
    "Recall floor by tier: small=0.70, mid=0.78, large=0.85, frontier=0.90.",
  );
  lines.push("");
  lines.push("| Tier      | Floor | Recommended K | Reason |");
  lines.push("|-----------|-------|---------------|--------|");
  for (const tier of TIERS) {
    const rec = recommendK(summary, tier);
    lines.push(
      `| ${tier.padEnd(9)} | ${fmt(RECALL_FLOOR_BY_TIER[tier]).padEnd(5)} | ${String(rec.k).padEnd(13)} | ${rec.reason} |`,
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- Token contribution uses a per-action length proxy (`40 + nameLength/4`). Use this for relative ranking across K, not absolute prompt-token estimates.",
  );
  lines.push(
    "- Pass-rate is the fraction of samples where every action the planner ultimately invoked appears inside the candidate top-K. Excludes samples without `selectedActions`.",
  );
  lines.push(
    "- When no K meets the recall floor for a tier, the recommendation falls back to the K with the highest absolute recall.",
  );
  lines.push("");
  return lines.join("\n");
}

function main() {
  const { samples, scanned, toolSearchCount, measuredCount } = collectSamples();
  const summary = analyzeSamples(samples);
  const md = buildMarkdown({
    summary,
    scanned,
    measuredCount,
    samples: samples.length,
  });
  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outMd, md);
  process.stdout.write(
    `[pareto] scanned=${scanned} toolSearch=${toolSearchCount} measured=${measuredCount} samples=${samples.length}\n`,
  );
  process.stdout.write(`[pareto] wrote ${outMd}\n`);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lifeops-retrieval-pareto.mjs");
if (isMain) main();

export { analyzeSamples, recommendK, K_SWEEP };
