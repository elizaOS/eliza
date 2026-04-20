/**
 * `milady-scenarios` CLI. Two commands:
 *
 *   run  <dir> [--report <path>] [--report-dir <dir>] [--runId <id>] [--scenario <id,id,...>] [fileGlob ...]
 *   list <dir> [fileGlob ...]
 *
 * Exit codes:
 *   0  all scenarios passed (or skipped with SKIP_REASON set)
 *   1  at least one scenario failed
 *   2  configuration error (no LLM key, bad args, silent skip without reason)
 */

import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { logger } from "@elizaos/core";
import { availableProviderNames } from "../../app-core/test/helpers/live-provider.ts";
import { runScenario } from "./executor.ts";
import { loadAllScenarios } from "./loader.ts";
import {
  buildAggregate,
  printStdoutSummary,
  writeReport,
  writeReportBundle,
} from "./reporter.ts";
import { createScenarioRuntime } from "./runtime-factory.ts";
import type { ScenarioReport } from "./types.ts";

interface ParsedArgs {
  command: "run" | "list";
  dir: string;
  reportPath?: string;
  reportDir?: string;
  runId?: string;
  filter?: Set<string>;
  fileGlobs?: string[];
}

function usageAndExit(message: string, code: number): never {
  process.stderr.write(`[milady-scenarios] ${message}\n`);
  process.stderr.write(
    "Usage:\n  milady-scenarios run  <dir> [--report <jsonPath>] [--report-dir <dir>] [--runId <id>] [--scenario id1,id2] [fileGlob ...]\n  milady-scenarios list <dir> [fileGlob ...]\n",
  );
  process.exit(code);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length < 2) {
    usageAndExit("missing command or directory", 2);
  }
  const command = argv[0];
  if (command !== "run" && command !== "list") {
    usageAndExit(`unknown command '${command}'`, 2);
  }
  const dir = argv[1];
  if (!dir || dir.startsWith("--")) {
    usageAndExit("missing scenario directory", 2);
  }
  let reportPath: string | undefined;
  let reportDir: string | undefined;
  let runId: string | undefined;
  let filter: Set<string> | undefined;
  const fileGlobs: string[] = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      usageAndExit("unexpected empty argument", 2);
    }
    if (arg === "--report") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--report missing value", 2);
      reportPath = next;
      i += 1;
    } else if (arg === "--report-dir") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--report-dir missing value", 2);
      reportDir = next;
      i += 1;
    } else if (arg === "--runId") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--runId missing value", 2);
      runId = next;
      i += 1;
    } else if (arg === "--scenario") {
      const next = argv[i + 1];
      if (!next) usageAndExit("--scenario missing value", 2);
      const ids = next
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      filter = new Set(ids);
      i += 1;
    } else if (arg.startsWith("--")) {
      usageAndExit(`unknown flag '${arg}'`, 2);
    } else {
      fileGlobs.push(arg);
    }
  }
  return {
    command: command as "run" | "list",
    dir: path.resolve(dir),
    reportPath: reportPath ? path.resolve(reportPath) : undefined,
    reportDir: reportDir ? path.resolve(reportDir) : undefined,
    runId,
    filter,
    fileGlobs,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (parsed.command === "list") {
    const loaded = await loadAllScenarios(
      parsed.dir,
      parsed.filter,
      parsed.fileGlobs,
    );
    for (const { scenario } of loaded) {
      process.stdout.write(`${scenario.id}\n`);
    }
    return 0;
  }

  if (availableProviderNames().length === 0) {
    process.stderr.write(
      "[milady-scenarios] no LLM provider API key set; refusing to run (WS7 policy: fail loudly on silent credential skips).\n  Set one of: GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY.\n",
    );
    return 2;
  }

  const minJudgeScore = Number.parseFloat(
    process.env.LIFEOPS_LIVE_JUDGE_MIN_SCORE ?? "0.8",
  );
  if (!Number.isFinite(minJudgeScore) || minJudgeScore <= 0) {
    process.stderr.write(
      `[milady-scenarios] invalid LIFEOPS_LIVE_JUDGE_MIN_SCORE=${process.env.LIFEOPS_LIVE_JUDGE_MIN_SCORE}\n`,
    );
    return 2;
  }

  const loaded = await loadAllScenarios(
    parsed.dir,
    parsed.filter,
    parsed.fileGlobs,
  );
  if (loaded.length === 0) {
    process.stderr.write(
      `[milady-scenarios] no scenarios discovered under ${parsed.dir}${parsed.filter ? ` (filter=${[...parsed.filter].join(",")})` : ""}${parsed.fileGlobs && parsed.fileGlobs.length > 0 ? ` (fileGlobs=${parsed.fileGlobs.join(",")})` : ""}\n`,
    );
    return 2;
  }

  logger.info(
    `[milady-scenarios] discovered ${loaded.length} scenario(s) under ${parsed.dir}`,
  );

  const startedAtIso = new Date().toISOString();
  // Note: a single bun process can only instantiate PGLite once reliably —
  // attempting to tear down and recreate the native binding segfaults. So the
  // CLI always uses a single shared runtime. For true per-scenario isolation
  // (required when testing cross-scenario state leakage), invoke the CLI
  // once per scenario from a shell loop (see scripts/run-scenarios-isolated.mjs).
  const { runtime, providerName, cleanup } = await createScenarioRuntime();
  logger.info(`[milady-scenarios] live provider: ${providerName}`);

  const reports: ScenarioReport[] = [];
  try {
    for (const { scenario } of loaded) {
      logger.info(`[milady-scenarios] ▶ ${scenario.id}`);
      const report = await runScenario(scenario, runtime, {
        providerName,
        minJudgeScore,
        turnTimeoutMs: 120_000,
      });
      reports.push(report);
      logger.info(
        `[milady-scenarios] ${report.status === "passed" ? "✓" : report.status === "skipped" ? "∼" : "✗"} ${scenario.id} ${report.status} (${report.durationMs}ms)${report.skipReason ? ` — ${report.skipReason}` : ""}`,
      );
    }
  } finally {
    await cleanup();
  }

  const completedAtIso = new Date().toISOString();
  const aggregate = buildAggregate(
    reports,
    providerName,
    startedAtIso,
    completedAtIso,
    parsed.runId ?? crypto.randomUUID(),
  );

  if (parsed.reportPath) {
    writeReport(aggregate, parsed.reportPath);
  }
  if (parsed.reportDir) {
    writeReportBundle(aggregate, parsed.reportDir);
  }
  printStdoutSummary(aggregate);

  // SKIP_REASON guard: if any scenarios skipped and no SKIP_REASON is set, fail.
  const skipReason = (process.env.SKIP_REASON ?? "").trim();
  if (aggregate.totals.skipped > 0 && skipReason.length === 0) {
    process.stderr.write(
      `[milady-scenarios] ${aggregate.totals.skipped} scenario(s) skipped without SKIP_REASON — failing loudly per WS7 policy.\n`,
    );
    return 2;
  }

  return aggregate.totals.failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `[milady-scenarios] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
