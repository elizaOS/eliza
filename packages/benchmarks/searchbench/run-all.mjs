/**
 * Searchbench orchestrator (#13534).
 *
 * Spawns the measuring harness (`searchbench-kpi.ts`) under
 * `bun --conditions=eliza-source` (it imports the real `@elizaos/plugin-sql`
 * PGlite adapter + migrations), then reads the recorded
 * `results/searchbench/latest.json` and writes a consolidated dashboard under
 * `results/summary/`.
 *
 *   node packages/benchmarks/searchbench/run-all.mjs
 *   node packages/benchmarks/searchbench/run-all.mjs --json
 *
 * Exit codes mirror the harness:
 *   0  measured gold set present, all budgets pass
 *   1  a budget FAILED — a retrieval-quality or latency regression
 *   2  nothing measurable (PGlite/import failure); no false green
 *
 * The `1` path is the CI regression gate: a drop in recall@10 (the multi-word /
 * older-than-window fixes), precision@10, MRR, nDCG, or a p95-latency / index-
 * build blowout all exit non-zero.
 */
import { spawnSync } from "node:child_process";
import {
  HERE,
  join,
  mkdirSync,
  RESULTS_ROOT,
  readLatest,
  writeFileSync,
} from "./lib.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");
const BUN_BIN = process.env.BUN_PATH || "bun";

function runHarness() {
  const res = spawnSync(
    BUN_BIN,
    ["--conditions=eliza-source", join(HERE, "searchbench-kpi.ts")],
    {
      stdio: JSON_ONLY ? ["ignore", "ignore", "inherit"] : "inherit",
      env: process.env,
    },
  );
  if (res.error) {
    console.error(`[searchbench] failed to spawn bun: ${res.error.message}`);
    return 2;
  }
  return res.status ?? 1;
}

function renderMarkdown(rec, status) {
  const lines = [
    "# Chat Message Searchbench",
    "",
    `Generated: ${NOW}`,
    "",
    `Status: **${status.toUpperCase()}**`,
    "",
  ];
  if (!rec) {
    lines.push("_no result recorded._", "");
    return lines.join("\n");
  }
  const a = rec.aggregate ?? {};
  lines.push("## Aggregate", "");
  lines.push(
    `- corpus: ${a.corpusSize ?? "?"} messages, gold cases: ${(rec.gold ?? []).length}`,
  );
  lines.push(
    `- insert: ${a.insertMs ?? "?"} ms, index build (REINDEX): ${a.indexBuildMs ?? "?"} ms`,
  );
  lines.push(
    `- recall@10: ${a.recallAt10 ?? "—"}, precision@10: ${a.precisionAt10 ?? "—"}, MRR: ${a.mrr ?? "—"}, nDCG@10: ${a.ndcgAt10 ?? "—"}`,
  );
  lines.push(
    `- latency p50/p95/max: ${a.p50LatencyMs ?? "—"} / ${a.p95LatencyMs ?? "—"} / ${a.maxLatencyMs ?? "—"} ms (${a.latencySamples ?? 0} samples)`,
  );
  lines.push("");
  lines.push("## Gold set", "");
  lines.push(
    "| case | kind | relevant | returned | hits@10 | recall@10 | prec@10 | RR | nDCG@10 | latency |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const g of rec.gold ?? []) {
    lines.push(
      `| ${g.id} | ${g.kind} | ${g.relevant} | ${g.returned} | ${g.hitsAt10} | ${g.recallAt10 ?? "—"} | ${g.precisionAt10 ?? "—"} | ${g.reciprocalRank ?? "—"} | ${g.ndcgAt10 ?? "—"} | ${g.latencyMs ?? "—"} ms |`,
    );
  }
  lines.push("");
  lines.push("## Budget checks", "");
  for (const c of rec.checks ?? []) {
    const cmp = c.cmp === "min" ? "≥" : "≤";
    lines.push(
      `- ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.value ?? "—"} ${cmp} ${c.budget}`,
    );
  }
  lines.push("", "---", "", "Budgets live in `budgets.json`.", "");
  return lines.join("\n");
}

function main() {
  if (!JSON_ONLY) console.log(">>> searchbench");
  const code = runHarness();
  const status = code === 0 ? "pass" : code === 2 ? "skipped" : "fail";
  const rec = readLatest("searchbench");
  const summaryDir = join(RESULTS_ROOT, "summary");
  mkdirSync(summaryDir, { recursive: true });
  const stamp = NOW.replace(/[:.]/g, "-");
  const summary = { recordedAt: NOW, status, exitCode: code, searchbench: rec };
  writeFileSync(
    join(summaryDir, `${stamp}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(summaryDir, "latest.json"),
    JSON.stringify(summary, null, 2),
  );
  const md = renderMarkdown(rec, status);
  writeFileSync(join(summaryDir, `${stamp}.md`), md);
  writeFileSync(join(summaryDir, "latest.md"), md);
  if (JSON_ONLY) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(md);
    console.log(`dashboard -> ${join(summaryDir, "latest.md")}`);
  }
  process.exit(code);
}

main();
