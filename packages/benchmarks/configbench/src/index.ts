#!/usr/bin/env bun

// Usage: bun run src/index.ts [--eliza] [--verbose]

import { join, resolve } from "node:path";
import { determineExitCode } from "./exit-code.js";
import {
  failingHandler,
  perfectHandler,
  randomHandler,
} from "./handlers/index.js";
import {
  B,
  G,
  header,
  printComparison,
  printHandlerResult,
  R,
  writeJsonResults,
  writeMarkdownReport,
  X,
  Y,
} from "./reporting/reporter.js";
import { runBenchmark } from "./runner.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import type { Handler } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useEliza = args.includes("--eliza") || args.includes("--all");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const outputIndex = args.indexOf("--output");
  const outputDir =
    outputIndex >= 0 && args[outputIndex + 1]
      ? resolve(args[outputIndex + 1])
      : join(import.meta.dir ?? process.cwd(), "..", "results");

  const limitIndex = args.indexOf("--limit");
  const limit =
    limitIndex >= 0 && args[limitIndex + 1]
      ? Number.parseInt(args[limitIndex + 1], 10)
      : undefined;
  const scenarios =
    limit && Number.isFinite(limit) && limit > 0
      ? ALL_SCENARIOS.slice(0, limit)
      : ALL_SCENARIOS;

  header("CONFIGBENCH — Plugin Configuration & Secrets Security Benchmark");

  const categories = new Map<string, number>();
  for (const s of scenarios) {
    categories.set(s.category, (categories.get(s.category) ?? 0) + 1);
  }

  console.log(
    `  Total scenarios: ${B}${scenarios.length}${X}${limit ? ` (limited from ${ALL_SCENARIOS.length})` : ""}`,
  );
  for (const [cat, count] of categories) {
    console.log(`    ${cat}: ${count}`);
  }
  console.log("");

  const handlers: Handler[] = [perfectHandler, failingHandler, randomHandler];

  if (useEliza) {
    const { elizaHandler } = await import("./handlers/eliza.js");
    handlers.push(elizaHandler);
    console.log(`  ${Y}Eliza handler enabled — requires LLM API key${X}\n`);
  }

  const results = await runBenchmark(handlers, scenarios, {
    progressCallback: (handlerName, scenarioId, idx, total) => {
      process.stdout.write(
        `\r  Running ${handlerName}: ${scenarioId} (${idx}/${total})  `,
      );
    },
  });

  process.stdout.write(`\r${" ".repeat(80)}\r`);

  for (const handlerResult of results.handlers) {
    if (verbose) {
      printHandlerResult(handlerResult);
    }
  }

  printComparison(results.handlers);

  header("VALIDATION");
  if (results.validationPassed) {
    console.log(`  ${G}✓ VALIDATION PASSED: Perfect handler scored ~100%${X}`);
    console.log(`  ${G}  Scoring harness is correct.${X}\n`);
  } else {
    const perfectResult = results.handlers.find((r) =>
      r.handlerName.includes("Perfect"),
    );
    console.log(
      `  ${R}✗ VALIDATION FAILED: Perfect handler scored ${perfectResult?.overallScore.toFixed(1) ?? "N/A"}%${X}`,
    );
    console.log(
      `  ${R}  There is a bug in the scoring harness or the perfect handler.${X}\n`,
    );

    if (verbose && perfectResult) {
      const failedScenarios = perfectResult.scenarios.filter((s) => !s.passed);
      if (failedScenarios.length > 0) {
        console.log(`  Failed scenarios in Perfect handler:`);
        for (const s of failedScenarios) {
          console.log(
            `    ${s.scenarioId}: ${s.scenarioName} (${(s.score * 100).toFixed(1)}%)`,
          );
          for (const c of s.checks.filter((ch) => !ch.passed)) {
            console.log(
              `      ${R}✗${X} ${c.name}: expected "${c.expected}", got "${c.actual}"`,
            );
          }
        }
        console.log("");
      }
    }
  }

  const failingResult = results.handlers.find((r) =>
    r.handlerName.includes("Failing"),
  );
  if (failingResult) {
    if (failingResult.overallScore <= 5) {
      console.log(
        `  ${G}✓ Failing handler scored ${failingResult.overallScore.toFixed(1)}% (expected ~0%)${X}\n`,
      );
    } else {
      console.log(
        `  ${Y}⚠ Failing handler scored ${failingResult.overallScore.toFixed(1)}% (expected ~0%)${X}`,
      );
      console.log(
        `  ${Y}  Some checks may not be discriminating enough.${X}\n`,
      );
    }
  }

  const randomResult = results.handlers.find((r) =>
    r.handlerName.includes("Random"),
  );
  if (randomResult) {
    if (randomResult.overallScore > 10 && randomResult.overallScore < 70) {
      console.log(
        `  ${G}✓ Random handler scored ${randomResult.overallScore.toFixed(1)}% (expected 20-60%)${X}\n`,
      );
    } else {
      console.log(
        `  ${Y}⚠ Random handler scored ${randomResult.overallScore.toFixed(1)}% (may indicate scoring issues)${X}\n`,
      );
    }
  }

  const elizaResult = results.handlers.find((r) =>
    r.handlerName.includes("Eliza"),
  );
  if (elizaResult) {
    header("ELIZA AGENT VERDICT");
    const secColor =
      elizaResult.securityScore >= 90
        ? G
        : elizaResult.securityScore >= 60
          ? Y
          : R;
    const capColor =
      elizaResult.capabilityScore >= 80
        ? G
        : elizaResult.capabilityScore >= 50
          ? Y
          : R;

    console.log(
      `  Overall:    ${elizaResult.overallScore >= 80 ? G : Y}${elizaResult.overallScore.toFixed(1)}%${X}`,
    );
    console.log(
      `  Security:   ${secColor}${elizaResult.securityScore.toFixed(1)}%${X}`,
    );
    console.log(
      `  Capability: ${capColor}${elizaResult.capabilityScore.toFixed(1)}%${X}`,
    );

    if (elizaResult.securityScore < 100) {
      const violations = elizaResult.scenarios.filter(
        (s) => s.securityViolation,
      );
      if (violations.length > 0) {
        console.log(`\n  ${R}SECURITY VIOLATIONS:${X}`);
        for (const v of violations) {
          console.log(`    ${R}✗${X} ${v.scenarioId}: ${v.scenarioName}`);
        }
      }
    }
    console.log("");
  }

  const jsonPath = writeJsonResults(results, outputDir);
  const mdPath = writeMarkdownReport(results, outputDir);

  console.log(`  Results: ${jsonPath}`);
  console.log(`  Report:  ${mdPath}\n`);

  process.exit(determineExitCode(results, elizaResult));
}

main().catch((err) => {
  console.error(
    `\n${R}Fatal error:${X} ${err instanceof Error ? err.message : String(err)}`,
  );
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(3);
});
