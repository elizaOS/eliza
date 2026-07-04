#!/usr/bin/env node
// Drives repo automation voice openwakeword eval with explicit CLI and CI behavior.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultOpenWakeWordOutputDir,
  OPENWAKEWORD_SCHEMA,
  readOpenWakeWordReport,
  renderOpenWakeWordValidationMarkdown,
  resolveOpenWakeWordReportPath,
  validateOpenWakeWordReport,
} from "./lib/voice-openwakeword-eval.mjs";

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
  console.log(`Usage: node packages/scripts/voice-openwakeword-eval.mjs [--report path] [--out dir]

Validates real openWakeWord wake-context evidence for issue #9958.

Required report schema: ${OPENWAKEWORD_SCHEMA}
Default report: ELIZA_VOICE_OPENWAKEWORD_REPORT
Default output: ELIZA_VOICE_OPENWAKEWORD_OUT, or ELIZA_VOICE_MATRIX_OUT/<cell>, or .github/issue-evidence/9958-voice-openwakeword-evaluation
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
    : resolveOpenWakeWordReportPath(process.env);
  if (!reportPath) {
    console.error(
      "[voice:openwakeword] set ELIZA_VOICE_OPENWAKEWORD_REPORT or pass --report with a real openWakeWord JSON report",
    );
    process.exit(2);
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`[voice:openwakeword] report does not exist: ${reportPath}`);
    process.exit(2);
  }

  const outDir = args.out
    ? path.resolve(args.out)
    : defaultOpenWakeWordOutputDir(process.env, REPO_ROOT);
  const report = readOpenWakeWordReport(reportPath);
  const result = validateOpenWakeWordReport(report, {
    reportPath,
    repoRoot: REPO_ROOT,
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "openwakeword-eval.json"),
    JSON.stringify(
      {
        schema: "eliza_voice_openwakeword_validation_v1",
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
    path.join(outDir, "openwakeword-eval.md"),
    renderOpenWakeWordValidationMarkdown(result, { reportPath }),
  );

  console.log(
    `[voice:openwakeword] wrote ${path.relative(REPO_ROOT, outDir)}/openwakeword-eval.json`,
  );
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`[voice:openwakeword] ${error}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    `[voice:openwakeword] ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
