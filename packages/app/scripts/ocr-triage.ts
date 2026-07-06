/**
 * Pixel-truth triage over an all-views audit capture: OCR every captured view
 * with the packaged Tesseract engine, run the content rules, and cross-check the
 * result against the DOM-derived verdict the aesthetic audit already recorded in
 * `report.json`.
 *
 * The payoff is two-directional. It catches renders the DOM audit passed but a
 * user would see broken — a caught-and-rendered crash string, a blank paint, an
 * unresolved template token — none of which move `consoleErrors` or
 * `readableChars`. And it positively verifies views whose pixels contain the
 * labels they exist to show, retiring them from the manual "needs-eyeball" pile
 * instead of leaving every soft-signal view for a human to squint at.
 *
 * Run: `bun scripts/ocr-triage.ts [--audit-dir <dir>] [--ocr <ndjson>] [--out <json>] [--baseline <json>]`.
 * With no `--ocr`, it uses `scripts/mvp-visual-verify/ocr.mjs`, which prefers the
 * installed `tesseract.js` package so CI and local verification do not depend on
 * Homebrew/apt state. A `--baseline` file lists `slug::viewport` regressions already tracked by
 * an issue; the gate exits non-zero only on a regression NOT in that baseline —
 * the same ratchet posture as the aesthetic audit's verdict-debt map, so a known
 * bug stays visible without wedging CI while a NEW pixel-broken render fails it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  evaluateOcrContent,
  type OcrResult,
  type OcrVerdict,
} from "../test/ui-smoke/ocr-content-rules";
import { VIEW_EXPECTATIONS } from "../test/ui-smoke/ocr-view-expectations";
import {
  closeOcrEngines,
  ocrImage,
  resolveOcrEngine,
} from "./mvp-visual-verify/ocr.mjs";

/**
 * Slugs whose healthy render legitimately OCRs to little or no text: the wallpaper
 * background, and native/canvas overlay surfaces that paint their own pixels. They
 * are waived from the blank-pixel floor, mirroring the aesthetic audit's
 * `OVERLAY_NATIVE_OR_CANVAS_SLUGS`. TUI views are waived structurally via the
 * `viewType` the report already carries.
 */
const BLANK_EXEMPT_SLUGS = new Set<string>([
  "builtin-background",
  "plugin-focus-gui",
  "plugin-focus-tui",
]);

interface ReportEntry {
  slug: string;
  viewport: string;
  viewType?: "gui" | "tui";
  verdict?: string;
}

interface OcrRecord extends OcrResult {
  path: string;
}

interface TriageEntry {
  slug: string;
  viewport: string;
  path: string;
  domVerdict: string | null;
  ocrVerdict: OcrVerdict;
  reasons: string[];
  /** DOM audit passed (good/needs-eyeball) but the pixels are broken — the caught bug. */
  regression: boolean;
  text: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

function listPngs(dir: string): string[] {
  const out: string[] = [];
  for (const viewport of readdirSync(dir, { withFileTypes: true })) {
    if (!viewport.isDirectory()) continue;
    const vp = join(dir, viewport.name);
    for (const f of readdirSync(vp)) {
      if (f.endsWith(".png")) out.push(join(vp, f));
    }
  }
  return out;
}

async function runPackagedOcr(paths: string[]): Promise<OcrRecord[]> {
  const engine = await resolveOcrEngine();
  if (!engine.available) {
    throw new Error(
      `OCR engine unavailable: ${engine.reason}. Run \`bun install\` so the packaged tesseract.js dependency is available, or set ELIZA_TESSERACT_BIN to a system tesseract binary.`,
    );
  }
  const out: OcrRecord[] = [];
  for (const path of paths) {
    const result = await ocrImage(path);
    if (!result.available) {
      throw new Error(`OCR failed for ${path}: ${result.reason}`);
    }
    out.push({
      path,
      ok: true,
      text: result.text,
      lines: result.text.split("\n").filter(Boolean),
      words: result.words,
      meanConfidence: 1,
    });
  }
  return out;
}

function slugOf(path: string): string {
  return basename(path).replace(/\.png$/, "");
}
function viewportOf(path: string): string {
  return basename(dirname(path));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const auditDir = args["audit-dir"] ?? "aesthetic-audit-output";
  const outPath = args.out ?? join(auditDir, "ocr-triage.json");

  // Baseline = `slug::viewport` keys of regressions already tracked by an issue.
  // A regression in the baseline is known debt (reported, not gating); one that
  // is NOT in the baseline is a new pixel-broken render and fails the gate.
  const baseline: Set<string> = new Set(
    args.baseline && existsSync(args.baseline)
      ? (JSON.parse(readFileSync(args.baseline, "utf8")).known ?? [])
      : [],
  );

  const reportPath = join(auditDir, "report.json");
  const report: ReportEntry[] = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, "utf8"))
    : [];
  const reportByKey = new Map<string, ReportEntry>();
  for (const r of report) reportByKey.set(`${r.slug}::${r.viewport}`, r);

  const pngs = listPngs(auditDir);
  const ocr: OcrRecord[] = args.ocr
    ? readFileSync(args.ocr, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as OcrRecord)
    : await runPackagedOcr(pngs);

  const entries: TriageEntry[] = [];
  for (const rec of ocr) {
    const slug = slugOf(rec.path);
    const viewport = viewportOf(rec.path);
    const rep = reportByKey.get(`${slug}::${viewport}`) ?? null;
    const exemptFromBlank =
      rep?.viewType === "tui" || BLANK_EXEMPT_SLUGS.has(slug);
    const finding = evaluateOcrContent({
      ocr: rec,
      expectation: VIEW_EXPECTATIONS[slug],
      exemptFromBlank,
    });
    const domVerdict = rep?.verdict ?? null;
    const domPassed = domVerdict === "good" || domVerdict === "needs-eyeball";
    entries.push({
      slug,
      viewport,
      path: rec.path,
      domVerdict,
      ocrVerdict: finding.verdict,
      reasons: finding.reasons,
      regression: domPassed && finding.verdict === "broken",
      text: rec.text,
    });
  }

  entries.sort((a, b) => {
    const rank = (e: TriageEntry) =>
      e.regression ? 0 : e.ocrVerdict === "broken" ? 1 : 2;
    return rank(a) - rank(b) || a.slug.localeCompare(b.slug);
  });

  const regressions = entries.filter((e) => e.regression);
  const newRegressions = regressions.filter(
    (e) => !baseline.has(`${e.slug}::${e.viewport}`),
  );
  const knownRegressions = regressions.filter((e) =>
    baseline.has(`${e.slug}::${e.viewport}`),
  );

  const summary = {
    total: entries.length,
    verified: entries.filter((e) => e.ocrVerdict === "verified").length,
    broken: entries.filter((e) => e.ocrVerdict === "broken").length,
    needsEyeball: entries.filter((e) => e.ocrVerdict === "needs-eyeball")
      .length,
    regressions: regressions.length,
    knownRegressions: knownRegressions.length,
    newRegressions: newRegressions.length,
  };

  writeFileSync(outPath, JSON.stringify({ summary, entries }, null, 2));

  console.log(
    `[ocr-triage] ${summary.total} views | verified ${summary.verified} | broken ${summary.broken} | needs-eyeball ${summary.needsEyeball}`,
  );
  if (knownRegressions.length) {
    console.log(
      `\n[ocr-triage] ${knownRegressions.length} known regression(s) (baselined — tracked by issue):`,
    );
    for (const e of knownRegressions) {
      console.log(
        `  · ${e.slug} [${e.viewport}] dom=${e.domVerdict} → broken: ${e.reasons.join("; ")}`,
      );
    }
  }
  if (newRegressions.length) {
    console.log(
      `\n[ocr-triage] ${newRegressions.length} NEW REGRESSION(S) — DOM audit passed, pixels are broken:`,
    );
    for (const e of newRegressions) {
      console.log(
        `  ✗ ${e.slug} [${e.viewport}] dom=${e.domVerdict} → broken: ${e.reasons.join("; ")}`,
      );
    }
  }
  console.log(`\n[ocr-triage] wrote ${outPath}`);
  process.exitCode = newRegressions.length > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error("[ocr-triage]", e);
    process.exitCode = 2;
  })
  .finally(async () => {
    await closeOcrEngines();
    if (process.exitCode) process.exit(process.exitCode);
  });
