#!/usr/bin/env node
/**
 * Aggregate one multi-agent personality run into a side-by-side report.md
 * and report.json.
 *
 * Reads each per-agent run dir's `verdicts.json` (produced by
 * `scripts/personality-bench-run.mjs`) and writes:
 *
 *   <runDir>/report.md     — side-by-side markdown
 *   <runDir>/report.json   — machine-readable rollup
 *
 * Inputs:
 *   --run-dir <multi-agent run dir>
 *   --run-id  <run id>
 *   --inputs  <inputs.json>      JSON of `{ agents: [{ agent, run_dir }] }`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const runDir = arg("--run-dir");
const runId = arg("--run-id");
const inputsPath = arg("--inputs");
if (!runDir || !inputsPath) {
  console.error(
    "[personality-multiagent-report] --run-dir and --inputs are required",
  );
  process.exit(2);
}
if (!existsSync(runDir)) {
  console.error(`[personality-multiagent-report] run-dir not found: ${runDir}`);
  process.exit(2);
}
if (!existsSync(inputsPath)) {
  console.error(
    `[personality-multiagent-report] inputs.json not found: ${inputsPath}`,
  );
  process.exit(2);
}

const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
const agentRuns = Array.isArray(inputs?.agents) ? inputs.agents : [];

const BUCKET_ORDER = [
  "shut_up",
  "hold_style",
  "note_trait_unrelated",
  "escalation",
  "scope_global_vs_user",
];

function emptyMatrix() {
  return {
    shut_up: { pass: 0, fail: 0, needsReview: 0 },
    hold_style: { pass: 0, fail: 0, needsReview: 0 },
    note_trait_unrelated: { pass: 0, fail: 0, needsReview: 0 },
    escalation: { pass: 0, fail: 0, needsReview: 0 },
    scope_global_vs_user: { pass: 0, fail: 0, needsReview: 0 },
  };
}

const perAgent = [];
for (const a of agentRuns) {
  const verdictsPath = join(a.run_dir, "verdicts.json");
  if (!existsSync(verdictsPath)) {
    console.warn(
      `[personality-multiagent-report] missing verdicts.json under ${a.run_dir}; skipping ${a.agent}`,
    );
    continue;
  }
  const v = JSON.parse(readFileSync(verdictsPath, "utf8"));
  perAgent.push({
    agent: a.agent,
    runDir: a.run_dir,
    model: v.model ?? null,
    totals: v.totals ?? { pass: 0, fail: 0, needsReview: 0 },
    perBucket: v.per_bucket ?? emptyMatrix(),
    scenarios: typeof v.scenarios === "number" ? v.scenarios : 0,
    wallMs: typeof v.wall_ms === "number" ? v.wall_ms : 0,
    judgeWallMs: typeof v.judge_wall_ms === "number" ? v.judge_wall_ms : 0,
    totalCost: typeof v.total_cost_usd === "number" ? v.total_cost_usd : 0,
    promptTokens: typeof v.prompt_tokens === "number" ? v.prompt_tokens : 0,
    completionTokens:
      typeof v.completion_tokens === "number" ? v.completion_tokens : 0,
    errors: typeof v.errors === "number" ? v.errors : 0,
    verdicts: Array.isArray(v.verdicts) ? v.verdicts : [],
  });
}

function fmtPct(pass, total) {
  if (total <= 0) return "0.0%";
  return `${((100 * pass) / total).toFixed(1)}%`;
}
function fmtCost(v) {
  return typeof v === "number" ? `$${v.toFixed(4)}` : "n/a";
}
function fmtLatency(ms) {
  if (typeof ms !== "number") return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(2)}min`;
}

// ── Cross-agent diff buckets ──
const verdictByScenarioByAgent = new Map(); // scenarioId -> Map(agent -> verdict)
for (const a of perAgent) {
  for (const v of a.verdicts) {
    if (!verdictByScenarioByAgent.has(v.scenarioId)) {
      verdictByScenarioByAgent.set(v.scenarioId, new Map());
    }
    verdictByScenarioByAgent.get(v.scenarioId).set(a.agent, v);
  }
}

const uniquePass = [];
const allFail = [];
const allNeedsReview = [];
for (const [scenarioId, byAgent] of verdictByScenarioByAgent) {
  const passing = [];
  let everyFail = true;
  let everyNeedsReview = true;
  for (const [agent, v] of byAgent) {
    if (v.verdict === "PASS") passing.push(agent);
    if (v.verdict !== "FAIL") everyFail = false;
    if (v.verdict !== "NEEDS_REVIEW") everyNeedsReview = false;
  }
  if (passing.length === 1 && perAgent.length > 1) {
    const winner = passing[0];
    const otherReason = [];
    for (const [agent, v] of byAgent) {
      if (agent !== winner) {
        otherReason.push(`${agent}=${v.verdict}`);
      }
    }
    uniquePass.push({
      scenarioId,
      onlyAgent: winner,
      winningReason: byAgent.get(winner)?.reason ?? "(no reason)",
      others: otherReason,
    });
  }
  if (everyFail && byAgent.size === perAgent.length) {
    allFail.push({
      scenarioId,
      reason: byAgent.values().next().value?.reason ?? "(no reason)",
    });
  }
  if (everyNeedsReview && byAgent.size === perAgent.length) {
    allNeedsReview.push({
      scenarioId,
      reason: byAgent.values().next().value?.reason ?? "(no reason)",
    });
  }
}

// ── NEEDS_REVIEW list (all NR verdicts across agents, sorted) ──
const needsReviewList = [];
for (const a of perAgent) {
  for (const v of a.verdicts) {
    if (v.verdict === "NEEDS_REVIEW") {
      needsReviewList.push({
        scenarioId: v.scenarioId,
        bucket: v.bucket,
        agent: a.agent,
        reason: v.reason,
      });
    }
  }
}
needsReviewList.sort((x, y) =>
  `${x.scenarioId}:${x.agent}`.localeCompare(`${y.scenarioId}:${y.agent}`),
);

// ── Markdown ──
const lines = [];
lines.push(`# Personality bench — multi-agent`);
lines.push("");
if (runId) lines.push(`Run ID: \`${runId}\``);
lines.push(`Run dir: \`${runDir}\``);
lines.push(
  `Agents: ${perAgent.length === 0 ? "_none_" : perAgent.map((a) => `\`${a.agent}\``).join(", ")}`,
);
lines.push("");

if (perAgent.length === 0) {
  lines.push(`> No per-agent results discovered.`);
} else {
  lines.push(`## Summary`);
  lines.push("");
  lines.push(
    `| agent | scenarios | PASS | FAIL | NEEDS_REVIEW | %Pass | cost | wall |`,
  );
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const a of perAgent) {
    lines.push(
      `| ${a.agent} | ${a.scenarios} | ${a.totals.pass} | ${a.totals.fail} | ${a.totals.needsReview} | ${fmtPct(a.totals.pass, a.scenarios)} | ${fmtCost(a.totalCost)} | ${fmtLatency(a.wallMs)} |`,
    );
  }
  lines.push("");

  lines.push(`## Per-bucket × agent`);
  lines.push("");
  lines.push(`| bucket | ${perAgent.map((a) => a.agent).join(" | ")} |`);
  lines.push(`| --- | ${perAgent.map(() => "---:").join(" | ")} |`);
  for (const b of BUCKET_ORDER) {
    const row = [b];
    for (const a of perAgent) {
      const cell = a.perBucket[b] ?? { pass: 0, fail: 0, needsReview: 0 };
      const total = cell.pass + cell.fail + cell.needsReview;
      row.push(`${cell.pass}/${total}`);
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");

  lines.push(`## Cross-agent diffs`);
  lines.push("");
  if (perAgent.length < 2) {
    lines.push(`_(need at least 2 agents to diff; got ${perAgent.length})_`);
  } else {
    lines.push(`### Scenarios where exactly one agent passed`);
    lines.push("");
    if (uniquePass.length === 0) {
      lines.push(`_None._`);
    } else {
      lines.push(
        `| scenario | only agent to pass | others | judge reason (winning agent) |`,
      );
      lines.push(`| --- | --- | --- | --- |`);
      for (const u of uniquePass) {
        lines.push(
          `| \`${u.scenarioId}\` | ${u.onlyAgent} | ${u.others.join(", ")} | ${u.winningReason} |`,
        );
      }
    }
    lines.push("");

    lines.push(`### Scenarios where ALL agents failed (real-capability gap)`);
    lines.push("");
    if (allFail.length === 0) {
      lines.push(`_None._`);
    } else {
      lines.push(`| scenario | judge reason (representative) |`);
      lines.push(`| --- | --- |`);
      for (const u of allFail) {
        lines.push(`| \`${u.scenarioId}\` | ${u.reason} |`);
      }
    }
    lines.push("");

    if (allNeedsReview.length > 0) {
      lines.push(`### Scenarios flagged NEEDS_REVIEW by ALL agents`);
      lines.push("");
      lines.push(`| scenario | judge reason (representative) |`);
      lines.push(`| --- | --- |`);
      for (const u of allNeedsReview) {
        lines.push(`| \`${u.scenarioId}\` | ${u.reason} |`);
      }
      lines.push("");
    }
  }

  lines.push(`## NEEDS_REVIEW list (operator-attention)`);
  lines.push("");
  if (needsReviewList.length === 0) {
    lines.push(`_None._`);
  } else {
    lines.push(`| scenario | agent | bucket | judge reason |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const r of needsReviewList) {
      lines.push(
        `| \`${r.scenarioId}\` | ${r.agent} | ${r.bucket} | ${r.reason} |`,
      );
    }
  }
  lines.push("");

  lines.push(`## Per-agent run dirs`);
  lines.push("");
  for (const a of perAgent) {
    lines.push(`- **${a.agent}** → \`${a.runDir}\``);
  }
  lines.push("");
}

writeFileSync(join(runDir, "report.md"), lines.join("\n"));
console.log(
  `[personality-multiagent-report] wrote ${join(runDir, "report.md")}`,
);

const reportJson = {
  schema_version: "personality-bench-multiagent-v1",
  run_id: runId ?? null,
  run_dir: runDir,
  agents: perAgent.map((a) => ({
    agent: a.agent,
    run_dir: a.runDir,
    model: a.model,
    scenarios: a.scenarios,
    totals: a.totals,
    per_bucket: a.perBucket,
    wall_ms: a.wallMs,
    judge_wall_ms: a.judgeWallMs,
    total_cost_usd: a.totalCost,
    prompt_tokens: a.promptTokens,
    completion_tokens: a.completionTokens,
    errors: a.errors,
  })),
  cross_agent_diffs: {
    unique_pass: uniquePass,
    all_fail: allFail,
    all_needs_review: allNeedsReview,
  },
  needs_review: needsReviewList,
};
writeFileSync(join(runDir, "report.json"), JSON.stringify(reportJson, null, 2));
console.log(
  `[personality-multiagent-report] wrote ${join(runDir, "report.json")}`,
);
