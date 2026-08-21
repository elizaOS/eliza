#!/usr/bin/env node

/**
 * CLI for the Cloudflare Pages frontend freshness verifier.
 *
 * Runs after `wrangler pages deploy` and probes the live custom domain, not the
 * preview URL printed by wrangler, because launch regressions happen when the
 * custom domain remains pinned to an older Pages deployment. The local `dist`
 * entry chunk is the deployment contract; optional `--require-text` values add
 * flow-level proof that critical UI code is present in the served bundle.
 *
 * Usage:
 *   node packages/cloud/scripts/verify-pages-frontend-cli.mjs \
 *     --served-url https://cloud.eliza.app \
 *     --dist packages/app/dist \
 *     --require-text "Signing in to your agent"
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { verifyPagesFrontendOnce } from "./verify-pages-frontend.mjs";

function parseArgs(argv) {
  const out = {
    servedUrl: null,
    distDir: null,
    requiredTexts: [],
    attempts: 6,
    intervalMs: 10_000,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--served-url") out.servedUrl = argv[++i];
    else if (arg.startsWith("--served-url=")) {
      out.servedUrl = arg.slice("--served-url=".length);
    } else if (arg === "--dist") out.distDir = argv[++i];
    else if (arg.startsWith("--dist="))
      out.distDir = arg.slice("--dist=".length);
    else if (arg === "--require-text") out.requiredTexts.push(argv[++i]);
    else if (arg.startsWith("--require-text=")) {
      out.requiredTexts.push(arg.slice("--require-text=".length));
    } else if (arg === "--attempts") out.attempts = Number(argv[++i]);
    else if (arg.startsWith("--attempts=")) {
      out.attempts = Number(arg.slice("--attempts=".length));
    } else if (arg === "--interval-ms") out.intervalMs = Number(argv[++i]);
    else if (arg.startsWith("--interval-ms=")) {
      out.intervalMs = Number(arg.slice("--interval-ms=".length));
    } else if (arg === "--json") out.json = true;
  }
  return out;
}

function stdout(line = "") {
  process.stdout.write(`${line}\n`);
}

function stderr(line = "") {
  process.stderr.write(`${line}\n`);
}

function writeStepSummary(report) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions provides this path.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const requiredRows =
    report.requiredTextResults.length === 0
      ? ["| _none_ | - |"]
      : report.requiredTextResults.map(
          (result) =>
            `| \`${result.text.replaceAll("`", "\\`")}\` | ${result.present ? "present" : "missing"} |`,
        );
  const lines = [
    "### Pages frontend freshness verification",
    "",
    `**${report.ok ? "PASS" : "FAIL"}** - ${report.reason}`,
    "",
    `- Detail: ${report.detail}`,
    `- Expected entry asset(s): ${report.expectedAssets.join(", ") || "-"}`,
    `- Served entry asset(s): ${report.servedAssets.join(", ") || "-"}`,
    "",
    "| Required text | Status |",
    "| --- | --- |",
    ...requiredRows,
    "",
  ];
  try {
    fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
  } catch {
    // error-policy:J7 diagnostics-must-not-kill-the-loop - the step summary is
    // auxiliary CI output; the process exit code still carries the verdict.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.servedUrl || !args.distDir) {
    stderr(
      "verify-pages-frontend: --served-url and --dist are required arguments",
    );
    process.exit(2);
  }

  let report = null;
  const retrySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    report = await verifyPagesFrontendOnce({
      servedUrl: args.servedUrl,
      distDir: args.distDir,
      requiredTexts: args.requiredTexts,
      retrySleep,
    });
    if (report.ok) break;
    stderr(
      `verify-pages-frontend attempt ${attempt}/${args.attempts}: ${report.reason} - ${report.detail}`,
    );
    if (attempt < args.attempts) await retrySleep(args.intervalMs);
  }

  if (args.json) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    stdout(`${report.ok ? "PASS" : "FAIL"}: ${report.reason}`);
    stdout(report.detail);
    stdout(`expected=${report.expectedAssets.join(",") || "-"}`);
    stdout(`served=${report.servedAssets.join(",") || "-"}`);
    for (const result of report.requiredTextResults) {
      stdout(
        `required-text ${result.present ? "present" : "missing"}: ${result.text}`,
      );
    }
  }

  writeStepSummary(report);
  process.exit(report.ok ? 0 : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    // error-policy:J1 boundary translation - verifier crashes must fail the
    // deployment gate instead of letting a stale frontend read as healthy.
    stderr("verify-pages-frontend: unexpected error");
    stderr(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

export { parseArgs };
