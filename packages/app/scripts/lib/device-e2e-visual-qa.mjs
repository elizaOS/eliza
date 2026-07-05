/**
 * Attaches per-screenshot visual-QA assessments to a device-e2e triage bundle
 * (#14336). Walks the PNG/JPG screenshots a runner captured into a bundle, runs
 * each through `visual-qa.mjs` (`analyzeScreenshot` — OCR, dominant palette,
 * brand-colour fractions, expectation checks), and writes the structured report
 * as `<image>.visual-qa.json` right beside the pixels, plus a `visual-qa.json`
 * aggregate at the bundle root with the pass/fail verdict roll-up.
 *
 * Consumed as the analysis pass of the bundle assembler (or run standalone
 * against an already-produced bundle dir): the point is a reviewer reads the
 * same numbers beside the screenshot that a gate would assert on, so "looks
 * fine" becomes "OCR shows the expected copy, 0.0 blue, verdict pass". The
 * per-image expectation spec (required/forbidden text, blue ceiling, state
 * label) is looked up by basename from a caller-supplied map — the runner knows
 * what each phase's screenshot should show; this module knows nothing about
 * phases.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyzeScreenshot } from "./visual-qa.mjs";

const SCREENSHOT_EXT = new Set([".png", ".jpg", ".jpeg"]);

/** Every screenshot in `dir` (non-recursive), sorted for a stable report order. */
export function listScreenshots(dir) {
  return readdirSync(dir)
    .filter((name) => SCREENSHOT_EXT.has(path.extname(name).toLowerCase()))
    .filter((name) => !name.endsWith(".visual-qa.json"))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Analyze every screenshot under `screenshotsDir`, writing a sidecar report per
 * image and a bundle-root aggregate. `expectations` maps a screenshot basename
 * to the expectation spec passed through to `analyzeScreenshot`; a basename with
 * no entry is analyzed with no expectations (descriptive report, verdict
 * `pass` by default). Returns the aggregate that was written.
 *
 * `analyze` is injectable so tests drive deterministic reports without the
 * `sharp`/`tesseract` pipeline; production callers omit it and get the real one.
 */
export async function attachVisualQa({
  bundleDir,
  screenshotsDir,
  expectations = {},
  analyze = analyzeScreenshot,
}) {
  const images = listScreenshots(screenshotsDir);
  const reports = [];
  for (const image of images) {
    const base = path.basename(image);
    const expect = expectations[base] ?? {};
    const report = await analyze(image, { expect });
    const sidecar = `${image}.visual-qa.json`;
    writeFileSync(sidecar, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    reports.push({
      image: base,
      sidecar: path.relative(bundleDir, sidecar),
      verdict: report.verdict,
      state: report.state ?? null,
    });
  }
  const aggregate = {
    analyzedAt: new Date().toISOString(),
    screenshotsDir: path.relative(bundleDir, screenshotsDir),
    total: reports.length,
    passed: reports.filter((r) => r.verdict === "pass").length,
    failed: reports.filter((r) => r.verdict === "fail").length,
    reports,
  };
  writeFileSync(
    path.join(bundleDir, "visual-qa.json"),
    `${JSON.stringify(aggregate, null, 2)}\n`,
    "utf8",
  );
  return aggregate;
}

/** True when `p` exists and is a directory — guards the walk entrypoint. */
export function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    // error-policy:J3 untrusted path probe — a missing/unreadable path is a
    // definite "not a directory", the only signal the caller needs.
    return false;
  }
}
