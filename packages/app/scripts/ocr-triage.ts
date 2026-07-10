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
 * Provenance is report-authoritative: the triage evaluates exactly the
 * screenshots named by the current `report.json` — one per row, all present —
 * never a directory glob. A screenshot left behind by an earlier capture is
 * structurally unable to enter the result, so the OCR row count always equals
 * the DOM report row count and a stale render can never be mis-reported as a
 * current regression (#15790).
 *
 * Run: `bun scripts/ocr-triage.ts [--audit-dir <dir>] [--ocr <ndjson>] [--out <json>] [--baseline <json>]`.
 * With no `--ocr`, it uses `scripts/mvp-visual-verify/ocr.mjs`, which prefers the
 * installed `tesseract.js` package so CI and local verification do not depend on
 * Homebrew/apt state. A `--baseline` file lists `slug::viewport` regressions already tracked by
 * an issue; the gate exits non-zero only on a regression NOT in that baseline —
 * the same ratchet posture as the aesthetic audit's verdict-debt map, so a known
 * bug stays visible without wedging CI while a NEW pixel-broken render fails it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { OVERLAY_NATIVE_OR_CANVAS_SLUGS } from "../test/ui-smoke/aesthetic-audit-rules";
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
 * Slugs whose healthy render legitimately OCRs to little or no text: wallpaper
 * backgrounds, sparse overlay-native surfaces, and canvas-style views that paint
 * their own chrome. Keep this tied to the aesthetic audit policy so a view is not
 * judged as overlay-native by DOM/pixel audit but blank-broken by OCR triage.
 */
const BLANK_EXEMPT_SLUGS = new Set<string>([
  ...OVERLAY_NATIVE_OR_CANVAS_SLUGS,
  "builtin-background",
  "plugin-focus-gui",
  // Legacy alias route that resolves to the launcher-grid fallback (see
  // launcher-curation.ts and the ocr-view-expectations.ts trailer). The grid's
  // white-on-gradient icon labels sit right at the engine's blank word floor
  // (1–2 garbled words across runs), so without the exemption the same healthy
  // render flaps between needs-eyeball and blank-broken run to run.
  "builtin-rolodex",
]);

export interface ReportEntry {
  slug: string;
  viewport: string;
  viewType?: "gui" | "tui";
  verdict?: string;
}

interface OcrRecord extends OcrResult {
  path: string;
}

export interface TriageEntry {
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

export interface TriageSummary {
  total: number;
  verified: number;
  broken: number;
  needsEyeball: number;
  regressions: number;
  knownRegressions: number;
  newRegressions: number;
}

export interface TriageResult {
  summary: TriageSummary;
  entries: TriageEntry[];
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

/** One authorized screenshot per current report row, with its on-disk path. */
export interface AuthorizedShot {
  key: string;
  slug: string;
  viewport: string;
  path: string;
}

/**
 * The screenshots the current `report.json` authorizes OCR to evaluate — the
 * single source of provenance for this triage.
 *
 * The prior implementation globbed every PNG under the audit directory, so a
 * screenshot left behind by an earlier capture (a retired view, a since-fixed
 * crash) was OCR'd and mis-reported as a CURRENT regression (#15790: 240 report
 * rows, 379 globbed PNGs). Scoping to report rows makes stale files structurally
 * unable to enter the result: a shot not named by a row is never read, and every
 * row's shot must exist. A missing report, a duplicate row, or a row whose
 * screenshot is absent is a corrupt capture and fails fast rather than silently
 * narrowing the run.
 */
export function authorizedShots(
  auditDir: string,
  report: ReportEntry[],
): AuthorizedShot[] {
  if (report.length === 0) {
    throw new Error(
      `[ocr-triage] ${join(auditDir, "report.json")} lists no views — run \`audit:app:capture\` first. OCR is scoped to the current report, never a directory glob.`,
    );
  }
  const seen = new Set<string>();
  return report.map((r) => {
    const key = `${r.slug}::${r.viewport}`;
    if (seen.has(key)) {
      throw new Error(
        `[ocr-triage] duplicate report row ${key} — report.json is corrupt; each slug::viewport must appear once.`,
      );
    }
    seen.add(key);
    const path = join(auditDir, r.viewport, `${r.slug}.png`);
    if (!existsSync(path)) {
      throw new Error(
        `[ocr-triage] report row ${key} has no screenshot at ${path} — the capture is incomplete; re-run \`audit:app:capture\`.`,
      );
    }
    return { key, slug: r.slug, viewport: r.viewport, path };
  });
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

function recordMatchesShotPath(
  auditDir: string,
  recordPath: string,
  shotPath: string,
): boolean {
  const expected = resolve(shotPath);
  if (resolve(recordPath) === expected) return true;
  return !isAbsolute(recordPath) && resolve(auditDir, recordPath) === expected;
}

/**
 * Bind imported OCR evidence one-to-one to the screenshots authorized by the
 * current report. Filtering an over-broad NDJSON file would make a combined or
 * stale evidence bundle look healthy after the bad records disappeared, so
 * every missing, duplicate, unexpected, or path-mismatched record fails.
 */
export function validateImportedOcrRecords(
  auditDir: string,
  sourcePath: string,
  shots: AuthorizedShot[],
  records: OcrRecord[],
): OcrRecord[] {
  const expected = new Map(shots.map((shot) => [shot.key, shot]));
  const byKey = new Map<string, OcrRecord>();

  for (const record of records) {
    const key = `${slugOf(record.path)}::${viewportOf(record.path)}`;
    if (byKey.has(key)) {
      throw new Error(
        `[ocr-triage] duplicate OCR record ${key} in ${sourcePath} — each report row must have exactly one record.`,
      );
    }
    const shot = expected.get(key);
    if (!shot) {
      throw new Error(
        `[ocr-triage] unexpected OCR record ${key} in ${sourcePath} — imported OCR must exactly match the current report.`,
      );
    }
    if (!recordMatchesShotPath(auditDir, record.path, shot.path)) {
      throw new Error(
        `[ocr-triage] OCR record ${key} points to ${record.path}, expected ${shot.path}.`,
      );
    }
    byKey.set(key, record);
  }

  return shots.map((shot) => {
    const record = byKey.get(shot.key);
    if (!record) {
      throw new Error(
        `[ocr-triage] report row ${shot.key} has no OCR record in ${sourcePath} — the OCR input is out of sync with report.json.`,
      );
    }
    return record;
  });
}

export async function runOcrTriage(argv: string[]): Promise<TriageResult> {
  const args = parseArgs(argv);
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

  // Provenance: OCR evaluates exactly the shots the current report authorizes —
  // one per row, all present — so the OCR row count equals the DOM report row
  // count by construction and no stale PNG can slip in (#15790).
  const shots = authorizedShots(auditDir, report);

  let ocr: OcrRecord[];
  if (args.ocr) {
    const records = readFileSync(args.ocr, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as OcrRecord);
    ocr = validateImportedOcrRecords(auditDir, args.ocr, shots, records);
  } else {
    ocr = await runPackagedOcr(shots.map((s) => s.path));
  }

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
  return { summary, entries };
}

// Auto-run only as a CLI entrypoint (`bun scripts/ocr-triage.ts …`). When a test
// imports this module for `authorizedShots`, `import.meta.main` is false so the
// triage does not fire and call `process.exit` out from under the test runner.
if (import.meta.main) {
  runOcrTriage(process.argv.slice(2))
    .then(({ summary }) => {
      process.exitCode = summary.newRegressions > 0 ? 1 : 0;
    })
    .catch((e) => {
      // error-policy:J1 CLI boundary — surface the failure and exit non-zero.
      console.error("[ocr-triage]", e);
      process.exitCode = 2;
    })
    .finally(async () => {
      await closeOcrEngines();
      if (process.exitCode) process.exit(process.exitCode);
    });
}
