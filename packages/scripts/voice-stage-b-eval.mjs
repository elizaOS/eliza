#!/usr/bin/env node
// Drives repo automation voice stage b eval with explicit CLI and CI behavior.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultStageBOutputDir,
  readStageBReport,
  renderStageBValidationMarkdown,
  resolveStageBReportPath,
  STAGE_B_SCHEMA,
  validateStageBReport,
} from "./lib/voice-stage-b-eval.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function parseArgs(argv) {
  const args = {
    report: null,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--report") args.report = argv[++i] ?? null;
    else if (token === "--out") args.out = argv[++i] ?? null;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node packages/scripts/voice-stage-b-eval.mjs [--report path] [--out dir]

Validates the Stage-B STT evidence report for issue #9958.

Required report schema: ${STAGE_B_SCHEMA}
Default report: ELIZA_VOICE_STAGE_B_REPORT
Default output: ELIZA_VOICE_STAGE_B_OUT, or ELIZA_VOICE_MATRIX_OUT/<cell>, or .github/issue-evidence/9958-voice-stage-b-evaluation
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const reportPath = args.report
    ? path.resolve(args.report)
    : resolveStageBReportPath(process.env);
  if (!reportPath) {
    console.error(
      "[voice:stage-b] set ELIZA_VOICE_STAGE_B_REPORT or pass --report with a real Stage-B JSON report",
    );
    process.exit(2);
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`[voice:stage-b] report does not exist: ${reportPath}`);
    process.exit(2);
  }

  const outDir = args.out
    ? path.resolve(args.out)
    : defaultStageBOutputDir(process.env, REPO_ROOT);
  const report = readStageBReport(reportPath);
  const result = validateStageBReport(report, {
    reportPath,
    repoRoot: REPO_ROOT,
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "stage-b-eval.json"),
    JSON.stringify(
      {
        schema: "eliza_voice_stage_b_validation_v1",
        issue: 9958,
        generatedAt: new Date().toISOString(),
        reportPath,
        ...result,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "stage-b-eval.md"),
    renderStageBValidationMarkdown(result, { reportPath }),
  );

  console.log(
    `[voice:stage-b] wrote ${path.relative(REPO_ROOT, outDir)}/stage-b-eval.json`,
  );
  if (!result.ok) {
    for (const error of result.errors)
      console.error(`[voice:stage-b] ${error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    `[voice:stage-b] ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
