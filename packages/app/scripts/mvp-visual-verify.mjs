#!/usr/bin/env node
/**
 * Post-processes the screenshots `audit:app` already captured into a higher-
 * fidelity visual-verification report: for every `<viewport>/<slug>.png` under
 * the audit output it reads the on-screen text (OCR), the dominant-color palette,
 * a pixel diff against a committed baseline, and a declarative pass/fail over
 * per-state expectations (expected OCR substrings, brand-orange accent, no blue,
 * no horizontal overflow). Output is a SEPARATE `mvp-verify/` tree (report.json +
 * contact-sheet.html + diff PNGs) so it never collides with the audit's own
 * report.json. Baselines live under this script directory by default so a clean
 * checkout can compare against reviewed, committed screenshots.
 *
 * This is evidence tooling, not a CI gate — it exits non-zero only when
 * `--strict` is passed (so `audit:app:verify` can chain it) and otherwise always
 * writes the full report for a human to review. Inputs are consumed, never
 * mutated; the audit stays the source of truth for what was captured.
 *
 * Usage:
 *   node scripts/mvp-visual-verify.mjs [--input <dir>] [--baseline <dir>]
 *                                      [--update-baseline] [--viewport <name>]...
 *                                      [--require-state <slug[@viewport]>]...
 *                                      [--require-baseline-states]
 *                                      [--strict]
 * Env: ELIZA_AUDIT_APP_DIR overrides the input dir (matches the audit spec);
 * ELIZA_MVP_VISUAL_BASELINE_DIR overrides the committed baseline directory.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffAgainstBaseline } from "./mvp-visual-verify/diff.mjs";
import { dominantColorsFromPng } from "./mvp-visual-verify/dominant-color.mjs";
import {
  evaluateExpectations,
  resolveSpec,
} from "./mvp-visual-verify/expectation-eval.mjs";
import { renderContactSheet } from "./mvp-visual-verify/html-report.mjs";
import {
  closeOcrEngines,
  ocrImage,
  resolveOcrEngine,
} from "./mvp-visual-verify/ocr.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");

function log(msg) {
  process.stdout.write(`[mvp-visual-verify] ${msg}\n`);
}

export function parseArgs(argv) {
  const args = {
    viewports: [],
    requiredStates: [],
    requireBaselineStates: false,
    updateBaseline: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--viewport") args.viewports.push(argv[++i]);
    else if (a === "--require-state") args.requiredStates.push(argv[++i]);
    else if (a === "--require-baseline-states")
      args.requireBaselineStates = true;
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

/** Directories under the audit output that are outputs/notes, not viewport shots. */
const NON_VIEWPORT_DIRS = new Set([
  "mvp-verify",
  "manual-review",
  "baseline",
  "diffs",
]);

async function isDir(p) {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** Discover viewport subdirs that actually contain screenshots. */
async function discoverViewportDirs(inputDir, only) {
  const entries = await readdir(inputDir, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || NON_VIEWPORT_DIRS.has(e.name)) continue;
    if (only.length && !only.includes(e.name)) continue;
    const pngs = (await readdir(path.join(inputDir, e.name))).filter((f) =>
      f.endsWith(".png"),
    );
    if (pngs.length) dirs.push({ name: e.name, pngs });
  }
  return dirs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function discoverBaselineRequiredStates(baselineRoot, only) {
  const entries = await readdir(baselineRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const states = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (only.length && !only.includes(e.name)) continue;
    const pngs = (await readdir(path.join(baselineRoot, e.name))).filter((f) =>
      f.endsWith(".png"),
    );
    for (const png of pngs) {
      states.push(`${png.replace(/\.png$/, "")}@${e.name}`);
    }
  }
  return states.sort();
}

async function loadReportIndex(inputDir) {
  const reportPath = path.join(inputDir, "report.json");
  const raw = await readFile(reportPath, "utf8").catch(() => null);
  if (!raw) return { index: new Map(), present: false };
  const findings = JSON.parse(raw);
  const index = new Map();
  for (const f of findings) index.set(`${f.slug}::${f.viewport}`, f);
  return { index, present: true, count: findings.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(
      "post-processes audit:app screenshots into mvp-verify/ (OCR + palette + diff + expectations + required-state coverage)",
    );
    return 0;
  }

  const inputDir = path.resolve(
    args.input ??
      process.env.ELIZA_AUDIT_APP_DIR ??
      path.join(appDir, "aesthetic-audit-output"),
  );
  if (!(await isDir(inputDir))) {
    throw new Error(
      `input dir not found: ${inputDir}\nRun 'bun run --cwd packages/app audit:app' first, or pass --input.`,
    );
  }

  const outDir = path.join(inputDir, "mvp-verify");
  const baselineRoot = path.resolve(
    args.baseline ??
      process.env.ELIZA_MVP_VISUAL_BASELINE_DIR ??
      path.join(here, "mvp-visual-verify", "baseline"),
  );
  const diffRoot = path.join(outDir, "diffs");
  await mkdir(outDir, { recursive: true });

  const specsRaw = await readFile(
    path.join(here, "mvp-visual-verify", "expectations.json"),
    "utf8",
  );
  const specs = JSON.parse(specsRaw);

  const {
    index: reportIndex,
    present: reportPresent,
    count: reportCount,
  } = await loadReportIndex(inputDir);
  const ocrEngine = await resolveOcrEngine();

  log(`input: ${inputDir}`);
  log(`baseline: ${baselineRoot}`);
  log(
    `audit report.json: ${reportPresent ? `${reportCount} findings` : "ABSENT (overflow/DOM checks will skip)"}`,
  );
  log(
    `OCR engine: ${ocrEngine.available ? ocrEngine.label : `UNAVAILABLE (${ocrEngine.reason})`}`,
  );
  if (args.updateBaseline)
    log(
      "--update-baseline: recording current shots into the baseline directory",
    );

  const viewportDirs = await discoverViewportDirs(inputDir, args.viewports);
  log(
    `viewports: ${viewportDirs.map((v) => `${v.name}(${v.pngs.length})`).join(", ") || "none found"}`,
  );

  const results = [];
  try {
    for (const vp of viewportDirs) {
      for (const png of vp.pngs) {
        const slug = png.replace(/\.png$/, "");
        const currentPath = path.join(inputDir, vp.name, png);
        const finding = reportIndex.get(`${slug}::${vp.name}`) ?? null;

        const palette = await dominantColorsFromPng(currentPath);
        const ocr = await ocrImage(currentPath);
        const baselinePath = path.join(baselineRoot, vp.name, png);
        const diffOutPath = path.join(diffRoot, vp.name, png);
        // --update-baseline: overwrite the baseline with the current shot BEFORE
        // diffing, so the refresh is deliberate and the diff self-reports 0%.
        if (args.updateBaseline) {
          await mkdir(path.dirname(baselinePath), { recursive: true });
          await (await import("sharp"))
            .default(currentPath)
            .toFile(baselinePath);
        }
        const diff = await diffAgainstBaseline({
          currentPath,
          baselinePath,
          diffOutPath,
          recordMissingBaseline: args.updateBaseline,
        });

        const spec = resolveSpec(specs, slug);
        const expectation = evaluateExpectations(
          { viewport: vp.name, ocr, palette, finding },
          spec,
        );

        results.push({
          slug,
          viewport: vp.name,
          screenshot: path.relative(outDir, currentPath),
          ocr: ocr.available
            ? {
                available: true,
                words: ocr.words,
                chars: ocr.chars,
                text: ocr.text.slice(0, 4000),
              }
            : { available: false, reason: ocr.reason },
          palette: {
            buckets: Object.fromEntries(
              Object.entries(palette.buckets).map(([k, v]) => [
                k,
                Number(v.toFixed(4)),
              ]),
            ),
            swatches: palette.swatches.map((s) => ({
              hex: s.hex,
              bucket: s.bucket,
              ratio: Number(s.ratio.toFixed(4)),
            })),
          },
          diff:
            diff.status === "new"
              ? {
                  status: "new",
                  note: args.updateBaseline
                    ? "baseline recorded; nothing to compare yet"
                    : "baseline missing; run with --update-baseline after manual review",
                }
              : {
                  status: "compared",
                  changedPercent: diff.summary.changedPercent,
                  meanAbsDelta: diff.summary.meanAbsDelta,
                  resized: diff.summary.resized,
                  diffPng: diff.diffPath
                    ? path.relative(outDir, diff.diffPath)
                    : null,
                },
          expectation: {
            pass: expectation.pass,
            reasons: expectation.reasons,
            checks: expectation.checks,
          },
          horizontalOverflowPx: finding?.horizontalOverflowPx ?? null,
        });
      }
    }
  } finally {
    await closeOcrEngines();
  }

  results.sort((a, b) =>
    a.slug === b.slug
      ? a.viewport.localeCompare(b.viewport)
      : a.slug.localeCompare(b.slug),
  );

  const baselineRequiredStates = args.requireBaselineStates
    ? await discoverBaselineRequiredStates(baselineRoot, args.viewports)
    : [];
  const requiredStates = uniqueRequiredStates([
    ...args.requiredStates,
    ...baselineRequiredStates,
  ]);
  const missingRequiredStates = computeMissingRequiredStates(
    requiredStates,
    results,
  );
  const expectationSkips = countExpectationChecks(results, "skip");
  const expectationFailures = results.filter((r) => !r.expectation.pass).length;
  const newBaselines = results.filter((r) => r.diff.status === "new").length;
  const emptyRunFailures = results.length === 0 ? 1 : 0;
  const strictFailures =
    expectationFailures +
    expectationSkips +
    newBaselines +
    emptyRunFailures +
    missingRequiredStates.length;

  const summary = {
    generatedAt: new Date().toISOString(),
    inputDir,
    baselineDir: baselineRoot,
    states: results.length,
    ocrEngine: ocrEngine.available
      ? ocrEngine.label
      : `UNAVAILABLE: ${ocrEngine.reason}`,
    auditReportPresent: reportPresent,
    expectationFailures,
    expectationSkips,
    requireBaselineStates: args.requireBaselineStates,
    requiredStates,
    missingRequiredStates,
    newBaselines,
    overflowStates: results.filter((r) => (r.horizontalOverflowPx ?? 0) > 2)
      .length,
    strictFailures,
  };

  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify({ summary, states: results }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(outDir, "contact-sheet.html"),
    renderContactSheet(summary, results),
    "utf8",
  );

  log(
    `wrote ${results.length} states → ${path.join(outDir, "report.json")} + contact-sheet.html`,
  );
  log(
    `expectation failures: ${summary.expectationFailures} | expectation skips: ${summary.expectationSkips} | missing required states: ${summary.missingRequiredStates.length} | overflow states: ${summary.overflowStates} | new baselines: ${summary.newBaselines}`,
  );
  if (summary.expectationFailures > 0) {
    for (const r of results.filter((r) => !r.expectation.pass)) {
      log(
        `  FAIL ${r.slug} @ ${r.viewport}: ${r.expectation.reasons.join(" | ")}`,
      );
    }
  }

  if (args.strict && summary.strictFailures > 0) {
    log(
      "--strict: exiting non-zero because every required signal must be present and compared",
    );
    if (summary.states === 0) log("  FAIL no screenshots were processed");
    if (summary.newBaselines > 0) {
      log(
        `  FAIL ${summary.newBaselines} screenshot(s) have no baseline comparison`,
      );
    }
    if (summary.expectationSkips > 0) {
      log(`  FAIL ${summary.expectationSkips} expectation check(s) skipped`);
    }
    if (summary.missingRequiredStates.length > 0) {
      log(
        `  FAIL ${summary.missingRequiredStates.length} required screenshot state(s) missing`,
      );
      for (const state of summary.missingRequiredStates) {
        log(
          `    missing ${state.slug}${state.viewport ? ` @ ${state.viewport}` : ""}`,
        );
      }
    }
    return 1;
  }
  return 0;
}

export function parseRequiredState(value) {
  const [slug, viewport, extra] = String(value).split("@");
  if (!slug || extra !== undefined || String(value).endsWith("@")) {
    throw new Error(
      `invalid --require-state value "${value}"; expected slug or slug@viewport`,
    );
  }
  return { slug, viewport: viewport || null };
}

export function uniqueRequiredStates(states) {
  return [...new Set(states)];
}

export function computeMissingRequiredStates(requiredStates, results) {
  if (!requiredStates?.length) return [];
  const presentPairs = new Set(results.map((r) => `${r.slug}@${r.viewport}`));
  const presentSlugs = new Set(results.map((r) => r.slug));
  return requiredStates
    .map(parseRequiredState)
    .filter((required) =>
      required.viewport
        ? !presentPairs.has(`${required.slug}@${required.viewport}`)
        : !presentSlugs.has(required.slug),
    );
}

export function countExpectationChecks(results, status) {
  return results.reduce(
    (count, r) =>
      count +
      r.expectation.checks.filter((check) => check.status === status).length,
    0,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`[mvp-visual-verify] fatal: ${err?.stack || err}\n`);
      process.exit(2);
    },
  );
}
