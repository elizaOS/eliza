#!/usr/bin/env node
/**
 * CLI over the visual-QA analyzer: turn a captured screenshot into a verdict
 * report a reviewer reads next to the pixels. Prints JSON to stdout and, with
 * `--out`, writes it beside the screenshot in a triage bundle (#14336). Exits
 * non-zero when the verdict fails, so a capture lane can gate on the same
 * numbers a human reads.
 *
 *   visual-qa-report.mjs <image.png> [--baseline <prev.png>] \
 *     [--expect <spec.json>] [--out <report.json>]
 *
 * Expectation spec (all optional):
 *   { "state": "ios-first-run", "require_text": ["Sign in"],
 *     "forbid_text": ["undefined","NaN","Startup failed"],
 *     "max_blue_fraction": 0.03 }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeScreenshot } from "./lib/visual-qa.mjs";

function parseArgs(argv) {
  const [image, ...rest] = argv;
  const opts = { image };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (key) opts[key] = rest[i + 1];
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv[0] || argv[0] === "--help") {
    process.stdout.write(
      `${import.meta.url}\nusage: visual-qa-report.mjs <image.png> [--baseline p] [--expect spec.json] [--out report.json]\n`,
    );
    process.exit(argv[0] ? 0 : 2);
  }
  const opts = parseArgs(argv);
  const expect = opts.expect
    ? JSON.parse(readFileSync(opts.expect, "utf8"))
    : {};
  const report = await analyzeScreenshot(opts.image, {
    baseline: opts.baseline ?? null,
    expect,
  });
  const json = JSON.stringify(report, null, 2);
  if (opts.out) writeFileSync(opts.out, json);
  process.stdout.write(`${json}\n`);
  process.exit(report.verdict === "pass" ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[visual-qa-report] ${String(err?.stack ?? err)}\n`);
  process.exit(2);
});
