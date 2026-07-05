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
  const args = { viewports: [], updateBaseline: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--viewport") args.viewports.push(argv[++i]);
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
      "post-processes audit:app screenshots into mvp-verify/ (OCR + palette + diff + expectations)",
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

  const expectationSkips = countExpectationChecks(results, "skip");
  const expectationFailures = results.filter((r) => !r.expectation.pass).length;
  const newBaselines = results.filter((r) => r.diff.status === "new").length;
  const emptyRunFailures = results.length === 0 ? 1 : 0;
  const strictFailures =
    expectationFailures + expectationSkips + newBaselines + emptyRunFailures;

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
    `expectation failures: ${summary.expectationFailures} | expectation skips: ${summary.expectationSkips} | overflow states: ${summary.overflowStates} | new baselines: ${summary.newBaselines}`,
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
    return 1;
  }
  return 0;
}

export function countExpectationChecks(results, status) {
  return results.reduce(
    (count, r) =>
      count +
      r.expectation.checks.filter((check) => check.status === status).length,
    0,
  );
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderContactSheet(summary, results) {
  const rows = results
    .map((r) => {
      const swatches = r.palette.swatches
        .map(
          (s) =>
            `<span class="sw" title="${esc(s.hex)} ${esc(s.bucket)} ${(s.ratio * 100).toFixed(1)}%" style="background:${esc(s.hex)}">${(s.ratio * 100).toFixed(0)}</span>`,
        )
        .join("");
      const verdict = r.expectation.pass
        ? '<span class="pass">PASS</span>'
        : `<span class="fail">FAIL</span>`;
      const checks = r.expectation.checks
        .map(
          (c) =>
            `<div class="chk ${c.status}">${esc(c.name)}: ${esc(c.detail)}</div>`,
        )
        .join("");
      const ocrCell = r.ocr.available
        ? `<div class="ocr">${esc(r.ocr.text || "(no glyphs)")}</div><div class="meta">${r.ocr.words} words</div>`
        : `<div class="na">N/A — ${esc(r.ocr.reason)}</div>`;
      const diffCell =
        r.diff.status === "new"
          ? '<span class="new">NEW baseline</span>'
          : `${r.diff.changedPercent}% changed${r.diff.resized ? " (resized)" : ""}${r.diff.diffPng ? `<br><img class="thumb" src="${esc(r.diff.diffPng)}">` : ""}`;
      return `<tr class="${r.expectation.pass ? "" : "row-fail"}">
        <td class="slug">${esc(r.slug)}<br><span class="meta">${esc(r.viewport)}</span></td>
        <td><img class="thumb" src="${esc(r.screenshot)}" loading="lazy"></td>
        <td>${ocrCell}</td>
        <td class="pal">${swatches}<div class="meta">${Object.entries(
          r.palette.buckets,
        )
          .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
          .join(" · ")}</div></td>
        <td class="diff">${diffCell}</td>
        <td>${verdict}<div class="checks">${checks}</div></td>
      </tr>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>mvp visual verify</title>
<style>
  body{font:13px system-ui,sans-serif;margin:16px;color:#1a1a1a;background:#faf9f7}
  h1{font-size:18px} .summary{margin:8px 0 16px;padding:8px 12px;background:#fff;border:1px solid #e5e0d8;border-radius:6px}
  table{border-collapse:collapse;width:100%} td,th{border:1px solid #e5e0d8;padding:6px;vertical-align:top;text-align:left}
  th{background:#f0ece5;position:sticky;top:0}
  .thumb{max-width:260px;max-height:180px;border:1px solid #ddd}
  .slug{font-weight:600;white-space:nowrap} .meta{color:#8a8378;font-size:11px}
  .ocr{max-width:280px;max-height:160px;overflow:auto;font-size:11px;white-space:pre-wrap;color:#444}
  .sw{display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;font-size:9px;color:#000;mix-blend-mode:difference;border:1px solid #ccc;margin:1px}
  .pass{color:#0a7d3c;font-weight:700} .fail{color:#c0392b;font-weight:700} .na{color:#b58900}
  .row-fail{background:#fff4f2} .checks{margin-top:4px}
  .chk{font-size:11px;padding:1px 0} .chk.pass{color:#0a7d3c} .chk.fail{color:#c0392b} .chk.skip{color:#8a8378}
  .new{color:#b58900;font-weight:600}
</style>
<h1>mvp visual verify</h1>
<div class="summary">
  ${esc(summary.states)} states · OCR: ${esc(summary.ocrEngine)} · expectation failures: <b>${summary.expectationFailures}</b> ·
  skipped checks: <b>${summary.expectationSkips}</b> · overflow states: <b>${summary.overflowStates}</b> ·
  new baselines: ${summary.newBaselines} · audit report: ${summary.auditReportPresent ? "loaded" : "ABSENT"} ·
  baseline: ${esc(summary.baselineDir)} · ${esc(summary.generatedAt)}
</div>
<table>
  <tr><th>state</th><th>screenshot</th><th>OCR text</th><th>palette</th><th>diff vs baseline</th><th>expectations</th></tr>
  ${rows}
</table>`;
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
