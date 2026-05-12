#!/usr/bin/env bun
/**
 * Runner — entry point for the InterruptBench harness.
 *
 * Usage:
 *
 *   bun run src/runner.ts                     # scripted mode (default)
 *   bun run src/runner.ts --mode=cerebras     # live LLM mode
 *   bun run src/runner.ts --mode=cerebras --judge
 *   bun run src/runner.ts --scenario=A1-fragmented-email-draft
 *   bun run src/runner.ts --out=./out         # write report files
 *
 * Exit code 0 on completion regardless of pass tier — CI gates should grep
 * the final score (or the printed pass tier line).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Scenario, ScenarioResult } from "./types.ts";
import { loadScenarios } from "./scenarios.ts";
import { runScenario, type EvaluatorMode } from "./evaluator.ts";
import { buildReport, renderJson, renderMarkdown } from "./report.ts";

interface Args {
  mode: EvaluatorMode;
  scenarioFilter?: string;
  out?: string;
  judge: boolean;
  cerebrasModel?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "scripted", judge: false };
  for (const a of argv) {
    if (a === "--mode=cerebras" || a === "--cerebras") args.mode = "cerebras";
    else if (a.startsWith("--mode=")) {
      const v = a.slice(7);
      if (v === "scripted" || v === "cerebras") args.mode = v;
      else throw new Error(`unknown --mode value: ${v}`);
    }
    else if (a.startsWith("--scenario=")) args.scenarioFilter = a.slice("--scenario=".length);
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (a === "--judge") args.judge = true;
    else if (a.startsWith("--model=")) args.cerebrasModel = a.slice("--model=".length);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
  }
  return args;
}

const HELP_TEXT = `InterruptBench runner

Flags:
  --mode=scripted | --mode=cerebras   choose LLM provider (default: scripted)
  --scenario=<id>                     run only this scenario id
  --judge                             enable LLM-as-judge bonus (requires CEREBRAS_API_KEY)
  --model=<id>                        override Cerebras model (default: gpt-oss-120b)
  --out=<dir>                         write report.md and report.json to <dir>
  --help                              show this help

Environment:
  CEREBRAS_API_KEY                    required for --mode=cerebras and --judge
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const all = loadScenarios();
  const scenarios = args.scenarioFilter
    ? all.filter((s) => s.id === args.scenarioFilter)
    : all;
  if (scenarios.length === 0) {
    process.stderr.write(`No scenarios matched filter '${args.scenarioFilter ?? "*"}'\n`);
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  process.stdout.write(`InterruptBench — mode=${args.mode}, ${scenarios.length} scenario(s)\n`);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const tag = `[${scenario.id}]`;
    process.stdout.write(`${tag} running...\n`);
    let result: ScenarioResult;
    try {
      result = await runScenario(scenario, {
        mode: args.mode,
        runJudge: args.judge,
        cerebrasModel: args.cerebrasModel,
      });
    } catch (err) {
      process.stderr.write(`${tag} ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
      result = buildErrorResult(scenario, err);
    }
    results.push(result);
    process.stdout.write(`${tag} score=${(result.score * 100).toFixed(1)} boundary=${result.boundaryViolated ? "VIOLATED" : "ok"} duration=${result.durationMs}ms\n`);
  }
  const finishedAt = new Date().toISOString();
  const report = buildReport({
    results,
    mode: args.mode,
    model: args.mode === "cerebras" ? (args.cerebrasModel ?? "gpt-oss-120b") : undefined,
    startedAt,
    finishedAt,
  });
  process.stdout.write("\n");
  process.stdout.write(renderMarkdown(report));
  process.stdout.write(`\nFINAL SCORE: ${report.finalScore.toFixed(2)} (aggregate=${report.aggregate.toFixed(2)} + judge=${report.judgeBonus.toFixed(2)})\n`);
  process.stdout.write(`PASS TIER: ${report.passTier}\n`);
  if (args.out) {
    const md = resolve(args.out, "report.md");
    const json = resolve(args.out, "report.json");
    mkdirSync(dirname(md), { recursive: true });
    writeFileSync(md, renderMarkdown(report), "utf8");
    writeFileSync(json, renderJson(report), "utf8");
    process.stdout.write(`Wrote ${md}\nWrote ${json}\n`);
  }
}

function buildErrorResult(scenario: Scenario, err: unknown): ScenarioResult {
  const message = err instanceof Error ? err.message : String(err);
  const zero = { raw: 0, weight: 0, weighted: 0, notes: [message] };
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    weight: scenario.weight,
    axes: {
      state: zero,
      intent: zero,
      routing: zero,
      trace: zero,
      boundary: zero,
      latency: zero,
    },
    rawScore: 0,
    score: 0,
    boundaryViolated: false,
    trace: [],
    durationMs: 0,
  };
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
