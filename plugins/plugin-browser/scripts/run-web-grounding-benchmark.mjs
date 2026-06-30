#!/usr/bin/env bun
/**
 * Web-element grounding benchmark runner — REAL Chromium (#10333).
 *
 * Renders a self-contained grounding page in a real Chromium, takes a real
 * screenshot, reads each target's real bbox via a BROWSER `get box` command,
 * scores a grounder's point-in-bbox accuracy AND verifies the real
 * screenshot→click path (click the predicted point, confirm the navigation
 * reached the target). Writes oracle + corner run-report artifacts. The
 * plugin-browser analog of `plugin-computeruse/src/parity/screenspot.ts`, wired
 * through the real BROWSER screenshot + click surface.
 *
 * Skips gracefully (exit 0) when no Chromium binary is available.
 *
 * Usage:
 *   bun scripts/run-web-grounding-benchmark.mjs [--out <file>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGroundingPage,
  buildWebGroundingSamples,
  cornerGrounder,
  createChromiumBenchmarkExecutor,
  launchChromiumBenchmarkBrowser,
  oracleGrounder,
  resolveChromiumExecutablePath,
  scoreWebGrounding,
} from "../src/benchmark/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function parseArgs(argv) {
  const opts = { out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opts.out = argv[++i];
  }
  return opts;
}

async function main() {
  const chromium = resolveChromiumExecutablePath();
  if (!chromium) {
    console.log(
      "[web-grounding] no Chromium binary found — skipping " +
        "(run `bunx playwright install --with-deps chromium` first).",
    );
    return;
  }
  console.log(`[web-grounding] using Chromium at ${chromium}`);
  const opts = parseArgs(process.argv.slice(2));
  const outDir =
    opts.out ??
    path.join(repoRoot, ".github/issue-evidence/10333-browser-real-chromium");

  const { browser, close } = await launchChromiumBenchmarkBrowser();
  const reports = {};
  try {
    for (const [name, grounder] of [
      ["oracle", oracleGrounder],
      ["corner", cornerGrounder],
    ]) {
      const { executor, dispose } = await createChromiumBenchmarkExecutor({
        browser,
      });
      try {
        const page = buildGroundingPage();
        const { samples } = await buildWebGroundingSamples(executor, page);
        reports[name] = await scoreWebGrounding(
          executor,
          page,
          samples,
          grounder,
          name,
        );
      } finally {
        await dispose();
      }
    }
  } finally {
    await close();
  }

  await mkdir(outDir, { recursive: true });
  for (const [name, report] of Object.entries(reports)) {
    const stamped = { generatedAt: new Date().toISOString(), ...report };
    const outPath = path.join(outDir, `web-grounding-chromium-${name}-run.json`);
    await writeFile(outPath, `${JSON.stringify(stamped, null, 2)}\n`);
    console.log(
      `  ${name.padEnd(8)} in-box ${report.inBox}/${report.total} ` +
        `(acc ${(report.accuracy * 100).toFixed(1)}%), ` +
        `click-hits ${report.clickHits}/${report.total} ` +
        `(acc ${(report.clickAccuracy * 100).toFixed(1)}%) → ` +
        `${path.relative(repoRoot, outPath)}`,
    );
  }

  // The oracle must perfectly ground + click; otherwise CI catches a regression.
  if (reports.oracle.accuracy !== 1 || reports.oracle.clickAccuracy !== 1) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
