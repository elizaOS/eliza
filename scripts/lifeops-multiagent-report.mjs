#!/usr/bin/env node
/**
 * Aggregate one multi-agent lifeops run into a side-by-side report.md +
 * report.json.
 *
 * Reads each per-agent subdirectory (`<runDir>/<agent>/lifeops_*.json`)
 * produced by the Python bench (`eliza_lifeops_bench.runner.save_results`),
 * extracts the headline metrics, and writes:
 *
 *   <runDir>/report.md     — side-by-side markdown
 *   <runDir>/report.json   — machine-readable rollup
 *
 * Per-agent metrics surfaced:
 *   - pass@1
 *   - pass@k (when seeds > 1)
 *   - mean_score_per_domain (rolled up to a single mean)
 *   - total_cost_usd, agent_cost_usd, eval_cost_usd
 *   - total_latency_ms
 *   - scenarios_run, scenarios_passed
 *
 * Plus a "cross-agent diff" section listing scenarios where exactly one agent
 * passed — useful when triaging real-world divergences.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const runDir = arg("--run-dir");
const runId = arg("--run-id");
if (!runDir) {
  console.error("[lifeops-multiagent-report] --run-dir required");
  process.exit(2);
}
if (!existsSync(runDir)) {
  console.error(`[lifeops-multiagent-report] run-dir not found: ${runDir}`);
  process.exit(2);
}

const AGENT_CANDIDATES = ["eliza", "hermes", "openclaw", "cerebras-direct"];

function findPythonBenchJson(agentDir) {
  if (!existsSync(agentDir) || !statSync(agentDir).isDirectory()) return null;
  const files = readdirSync(agentDir)
    .filter((f) => f.startsWith("lifeops_") && f.endsWith(".json"))
    .map((f) => ({ file: f, mtime: statSync(join(agentDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? join(agentDir, files[0].file) : null;
}

function meanFromDomainMap(map) {
  if (!map || typeof map !== "object") return null;
  const vals = Object.values(map).filter(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function fmtScore(v) {
  return typeof v === "number" ? v.toFixed(3) : "n/a";
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

const perAgent = [];
for (const agent of AGENT_CANDIDATES) {
  const agentDir = join(runDir, agent);
  const benchJson = findPythonBenchJson(agentDir);
  if (!benchJson) continue;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(benchJson, "utf8"));
  } catch (e) {
    console.warn(
      `[lifeops-multiagent-report] failed to parse ${benchJson}: ${e?.message ?? e}`,
    );
    continue;
  }
  const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
  const passed = scenarios.filter(
    (s) => typeof s.total_score === "number" && typeof s.max_score === "number" && s.max_score > 0 && s.total_score >= s.max_score,
  ).length;
  perAgent.push({
    agent,
    benchJson,
    scenarios_run: scenarios.length,
    scenarios_passed: passed,
    pass_at_1: typeof parsed.pass_at_1 === "number" ? parsed.pass_at_1 : null,
    pass_at_k: typeof parsed.pass_at_k === "number" ? parsed.pass_at_k : null,
    mean_score: meanFromDomainMap(parsed.mean_score_per_domain),
    mean_score_per_domain: parsed.mean_score_per_domain ?? {},
    total_cost_usd:
      typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    agent_cost_usd:
      typeof parsed.agent_cost_usd === "number" ? parsed.agent_cost_usd : null,
    eval_cost_usd:
      typeof parsed.eval_cost_usd === "number" ? parsed.eval_cost_usd : null,
    total_latency_ms:
      typeof parsed.total_latency_ms === "number" ? parsed.total_latency_ms : null,
    model_name: parsed.model_name ?? null,
    judge_model_name: parsed.judge_model_name ?? null,
    seeds: typeof parsed.seeds === "number" ? parsed.seeds : null,
    timestamp: parsed.timestamp ?? null,
    scenario_outcomes: scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      seed: s.seed,
      passed:
        typeof s.total_score === "number" && typeof s.max_score === "number" && s.max_score > 0 && s.total_score >= s.max_score,
      total_score: s.total_score ?? null,
      max_score: s.max_score ?? null,
      terminated_reason: s.terminated_reason ?? null,
      error: s.error ?? null,
    })),
  });
}

// Cross-agent diff: scenarios where exactly one agent passed.
const scenarioAgentPass = new Map(); // scenario_id -> Set(agents that passed)
for (const a of perAgent) {
  for (const sc of a.scenario_outcomes) {
    if (!scenarioAgentPass.has(sc.scenario_id)) {
      scenarioAgentPass.set(sc.scenario_id, new Set());
    }
    if (sc.passed) scenarioAgentPass.get(sc.scenario_id).add(a.agent);
  }
}

const uniquePass = [];
for (const [scenarioId, agentsSet] of scenarioAgentPass) {
  if (agentsSet.size === 1 && perAgent.length > 1) {
    uniquePass.push({ scenarioId, onlyPassed: [...agentsSet][0] });
  }
}

// Markdown report
const lines = [];
lines.push(`# LifeOps Multi-Agent Benchmark Report`);
lines.push(``);
if (runId) lines.push(`Run ID: \`${runId}\``);
lines.push(`Run dir: \`${runDir}\``);
lines.push(`Agents present: ${perAgent.length === 0 ? "_none_" : perAgent.map((a) => `\`${a.agent}\``).join(", ")}`);
lines.push(``);

if (perAgent.length === 0) {
  lines.push(
    `> No per-agent bench outputs found. Each agent should write its results under \`<run-dir>/<agent>/lifeops_*.json\`.`,
  );
} else {
  lines.push(`## Headline (side-by-side)`);
  lines.push(``);
  lines.push(`| agent | scenarios | passed | pass@1 | mean score | total cost | agent cost | eval cost | wall time |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const a of perAgent) {
    lines.push(
      `| ${a.agent} | ${a.scenarios_run} | ${a.scenarios_passed} | ${fmtScore(a.pass_at_1)} | ${fmtScore(a.mean_score)} | ${fmtCost(a.total_cost_usd)} | ${fmtCost(a.agent_cost_usd)} | ${fmtCost(a.eval_cost_usd)} | ${fmtLatency(a.total_latency_ms)} |`,
    );
  }
  lines.push(``);

  lines.push(`## Per-domain mean score`);
  lines.push(``);
  const allDomains = new Set();
  for (const a of perAgent) {
    for (const d of Object.keys(a.mean_score_per_domain ?? {})) {
      allDomains.add(d);
    }
  }
  const domainList = [...allDomains].sort();
  if (domainList.length === 0) {
    lines.push(`_(no per-domain scores in any agent result)_`);
  } else {
    lines.push(
      `| domain | ${perAgent.map((a) => a.agent).join(" | ")} |`,
    );
    lines.push(
      `| --- | ${perAgent.map(() => "---:").join(" | ")} |`,
    );
    for (const d of domainList) {
      const row = [d];
      for (const a of perAgent) {
        const v = a.mean_score_per_domain?.[d];
        row.push(typeof v === "number" ? v.toFixed(3) : "—");
      }
      lines.push(`| ${row.join(" | ")} |`);
    }
  }
  lines.push(``);

  lines.push(`## Cross-agent diffs`);
  lines.push(``);
  if (perAgent.length < 2) {
    lines.push(`_(need at least 2 agents to diff; got ${perAgent.length})_`);
  } else if (uniquePass.length === 0) {
    lines.push(`No scenarios where exactly one agent passed.`);
  } else {
    lines.push(
      `Scenarios where exactly one agent passed (worth inspecting):`,
    );
    lines.push(``);
    lines.push(`| scenario | only agent to pass |`);
    lines.push(`| --- | --- |`);
    for (const u of uniquePass) {
      lines.push(`| \`${u.scenarioId}\` | ${u.onlyPassed} |`);
    }
  }
  lines.push(``);

  lines.push(`## Per-agent transcripts`);
  lines.push(``);
  for (const a of perAgent) {
    lines.push(`- **${a.agent}** → \`${a.benchJson}\``);
  }
  lines.push(``);
}

const reportPath = join(runDir, "report.md");
writeFileSync(reportPath, lines.join("\n") + "\n");
console.log(`[lifeops-multiagent-report] wrote ${reportPath}`);

const reportJson = {
  schema_version: "lifeops-multiagent-v1",
  run_id: runId ?? null,
  run_dir: runDir,
  agents: perAgent.map(({ scenario_outcomes, ...rest }) => ({
    ...rest,
    scenario_outcomes,
  })),
  cross_agent_diffs: uniquePass,
};
const reportJsonPath = join(runDir, "report.json");
writeFileSync(reportJsonPath, JSON.stringify(reportJson, null, 2) + "\n");
console.log(`[lifeops-multiagent-report] wrote ${reportJsonPath}`);
