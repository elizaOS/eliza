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
 * Run: `bun scripts/ocr-triage.ts [--audit-dir <dir>] [--ocr <ndjson>] [--out <json>]`.
 * With no `--ocr`, it uses `scripts/mvp-visual-verify/ocr.mjs`, which prefers the
 * installed `tesseract.js` package so CI and local verification do not depend on
 * Homebrew/apt state. Every pixel-broken regression fails the gate directly.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { OVERLAY_NATIVE_OR_CANVAS_SLUGS } from "../test/ui-smoke/aesthetic-audit-rules";
import {
  type EvaluateArgs,
  evaluateOcrContent,
  type OcrContentFinding,
  type OcrExpectation,
  type OcrResult,
  type OcrVerdict,
} from "../test/ui-smoke/ocr-content-rules";
import {
  resolveViewOcrPolicy,
  type ViewOcrPolicy,
} from "../test/ui-smoke/ocr-view-expectations";
import {
  type AuditReportRow,
  buildAuditCaptureManifest,
  parseAuditReport,
  validateOcrRecordPaths,
} from "./lib/audit-capture-manifest";
import {
  analyzeImageFile,
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
]);

export type ReportEntry = AuditReportRow;

interface OcrRecord extends OcrResult {
  path: string;
}

/** A report-authorized screenshot and its canonical evidence key. */
export type AuthorizedShot = ReturnType<
  typeof buildAuditCaptureManifest
>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOcrRecord(value: unknown, index: number): OcrRecord {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !value.path ||
    typeof value.ok !== "boolean" ||
    typeof value.text !== "string" ||
    !Array.isArray(value.lines) ||
    !value.lines.every((line) => typeof line === "string") ||
    typeof value.words !== "number" ||
    !Number.isFinite(value.words) ||
    typeof value.meanConfidence !== "number" ||
    !Number.isFinite(value.meanConfidence) ||
    value.meanConfidence < 0 ||
    value.meanConfidence > 1 ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    throw new Error(`Invalid OCR input record at line ${index + 1}`);
  }
  return {
    path: value.path,
    ok: value.ok,
    text: value.text,
    lines: value.lines,
    words: value.words,
    meanConfidence: value.meanConfidence,
    reason: value.reason,
  };
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
  words: number;
  meanConfidence: number;
  selectedMode: string | null;
  attempts: OcrResult["attempts"];
  pixelBlank: boolean;
  pixelBlankReasons: string[];
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

interface PolicyEvaluationInput {
  expectation: OcrExpectation;
  semanticExemptionReason?: string;
}

type OcrEvaluationPolicy = Omit<EvaluateArgs, "ocr">;

/**
 * Prefer a bounded fallback transcript when it proves more of the declared
 * semantics without hiding any leak or forbidden-content signal found by the
 * engine-selected transcript. OCR's confidence/word-count selector is useful
 * globally, but it cannot know that a smaller sparse pass captured the exact
 * label an audit row exists to prove.
 */
export function selectSemanticallyBestOcrAttempt<T extends OcrResult>(
  record: T,
  policy: OcrEvaluationPolicy,
): { record: T; finding: OcrContentFinding } {
  let bestRecord = record;
  let bestFinding = evaluateOcrContent({ ocr: record, ...policy });
  const requiredAllMisses = (finding: OcrContentFinding): number =>
    (policy.expectation.requireAll ?? []).filter((label) =>
      finding.missingRequired.includes(label),
    ).length;

  for (const attempt of record.attempts ?? []) {
    if (!attempt.ok) continue;
    const candidate = {
      ...record,
      text: attempt.text,
      lines: attempt.text.split("\n").filter(Boolean),
      words: attempt.words,
      meanConfidence: attempt.meanConfidence,
      selectedMode: attempt.mode,
    } as T;
    const finding = evaluateOcrContent({ ocr: candidate, ...policy });
    const preservesSafetySignals =
      bestFinding.errorLeaks.every((leak) =>
        finding.errorLeaks.includes(leak),
      ) &&
      bestFinding.placeholderLeaks.every((leak) =>
        finding.placeholderLeaks.includes(leak),
      ) &&
      bestFinding.forbiddenPresent.every((label) =>
        finding.forbiddenPresent.includes(label),
      ) &&
      finding.blankPixels === bestFinding.blankPixels;
    const candidateRequiredAllMisses = requiredAllMisses(finding);
    const bestRequiredAllMisses = requiredAllMisses(bestFinding);
    const provesMoreSemantics =
      candidateRequiredAllMisses < bestRequiredAllMisses ||
      (candidateRequiredAllMisses === bestRequiredAllMisses &&
        finding.missingRequired.length < bestFinding.missingRequired.length);
    if (preservesSafetySignals && provesMoreSemantics) {
      bestRecord = candidate;
      bestFinding = finding;
    }

    const combined = {
      ...record,
      text: `${record.text}\n${attempt.text}`,
      lines: `${record.text}\n${attempt.text}`.split("\n").filter(Boolean),
      words: record.words + attempt.words,
      meanConfidence: Math.min(record.meanConfidence, attempt.meanConfidence),
      selectedMode: `${record.selectedMode ?? "selected"}+${attempt.mode}`,
    } as T;
    const combinedFinding = evaluateOcrContent({ ocr: combined, ...policy });
    const combinedRequiredAllMisses = requiredAllMisses(combinedFinding);
    const combinedProvesMoreSemantics =
      combinedRequiredAllMisses < requiredAllMisses(bestFinding) ||
      (combinedRequiredAllMisses === requiredAllMisses(bestFinding) &&
        combinedFinding.missingRequired.length <
          bestFinding.missingRequired.length);
    if (combinedProvesMoreSemantics) {
      bestRecord = combined;
      bestFinding = combinedFinding;
    }
  }

  return { record: bestRecord, finding: bestFinding };
}

function resolvePolicyEvaluationInput(
  slug: string,
  policy: ViewOcrPolicy,
  report: ReportEntry,
): PolicyEvaluationInput {
  if (policy.kind === "expectation") {
    return { expectation: policy.expectation };
  }
  if (
    policy.applicability === "unregistered-remote-bundle" &&
    report.bundleProvenance !== undefined
  ) {
    throw new Error(
      `Semantic OCR exemption for ${slug} no longer applies: capture loaded remote bundle provenance ${report.bundleProvenance}`,
    );
  }
  return {
    expectation: policy.fallbackExpectation,
    semanticExemptionReason: policy.reason,
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

/** Returns the closed screenshot set authorized by the current audit report. */
export function authorizedShots(
  auditDir: string,
  report: ReportEntry[],
): ReturnType<typeof buildAuditCaptureManifest> {
  const manifest = buildAuditCaptureManifest(auditDir, report);
  for (const entry of manifest) {
    if (!existsSync(entry.path)) {
      throw new Error(`Current audit screenshot is missing: ${entry.key}`);
    }
  }
  return manifest;
}

async function runPackagedOcr(
  paths: string[],
  alwaysTryFallback = false,
): Promise<OcrRecord[]> {
  const engine = await resolveOcrEngine();
  if (!engine.available) {
    throw new Error(
      `OCR engine unavailable: ${engine.reason}. Run \`bun install\` so the packaged tesseract.js dependency is available, or set ELIZA_TESSERACT_BIN to a system tesseract binary.`,
    );
  }
  const out: OcrRecord[] = [];
  for (const path of paths) {
    const result = await ocrImage(path, { alwaysTryFallback });
    if (!result.available) {
      throw new Error(`OCR failed for ${path}: ${result.reason}`);
    }
    out.push({
      path,
      ok: true,
      text: result.text,
      lines: result.text.split("\n").filter(Boolean),
      words: result.words,
      meanConfidence: result.meanConfidence,
      pixelBlank: result.pixelBlank,
      pixelBlankReasons: result.pixelBlankReasons,
      selectedMode: result.selectedMode,
      attempts: result.attempts,
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
  // Directory precedence mirrors the capture stage exactly (#17128): an
  // explicit CLI --audit-dir is authoritative, otherwise the same
  // ELIZA_AUDIT_APP_DIR the Playwright capture honored, otherwise the default.
  // Without the env tier, an isolated `audit:app` run captured into
  // ELIZA_AUDIT_APP_DIR while OCR silently analyzed whatever stale artifacts
  // sat in the default directory — a false evidence binding.
  const auditDir =
    args["audit-dir"] ??
    (process.env.ELIZA_AUDIT_APP_DIR?.trim() || "aesthetic-audit-output");
  const outPath = args.out ?? join(auditDir, "ocr-triage.json");

  const reportPath = join(auditDir, "report.json");
  if (!existsSync(reportPath)) {
    throw new Error(`Current audit report is missing: ${reportPath}`);
  }
  const report: ReportEntry[] = parseAuditReport(
    JSON.parse(readFileSync(reportPath, "utf8")),
  );
  const manifest = authorizedShots(auditDir, report);
  const reportByKey = new Map<string, ReportEntry>();
  for (const r of report) reportByKey.set(`${r.slug}::${r.viewport}`, r);

  const rawOcr: OcrRecord[] = args.ocr
    ? readFileSync(args.ocr, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((line, index) => parseOcrRecord(JSON.parse(line), index))
    : await runPackagedOcr(manifest.map((entry) => entry.path));
  validateOcrRecordPaths(rawOcr, manifest, auditDir);
  const shotsByKey = new Map(manifest.map((shot) => [shot.key, shot]));
  const ocr: OcrRecord[] = await Promise.all(
    rawOcr.map(async (record) => {
      if (record.pixelBlank !== undefined) {
        if (!record.pixelBlankReasons) {
          throw new Error(
            `OCR record ${record.path} has a pixel verdict without its diagnostics`,
          );
        }
        return record;
      }
      const key = `${slugOf(record.path)}::${viewportOf(record.path)}`;
      const shot = shotsByKey.get(key);
      if (!shot) {
        throw new Error(`OCR record ${key} has no authorized shot`);
      }
      const analysis = await analyzeImageFile(shot.path);
      return {
        ...record,
        pixelBlank: analysis.pixelBlank,
        pixelBlankReasons: analysis.pixelBlankReasons,
      };
    }),
  );

  const entries: TriageEntry[] = [];
  for (let rec of ocr) {
    if (rec.pixelBlank === undefined || !rec.pixelBlankReasons) {
      throw new Error(`OCR record ${rec.path} has no pixel diagnostics`);
    }
    const slug = slugOf(rec.path);
    const viewport = viewportOf(rec.path);
    const rep = reportByKey.get(`${slug}::${viewport}`);
    if (!rep) {
      throw new Error(`OCR record ${slug}::${viewport} has no report row`);
    }
    const policy = resolveViewOcrPolicy(slug);
    const policyInput = resolvePolicyEvaluationInput(slug, policy, rep);
    const exemptFromBlank =
      rep.viewType === "tui" || BLANK_EXEMPT_SLUGS.has(slug);
    let selection = selectSemanticallyBestOcrAttempt(rec, {
      ...policyInput,
      exemptFromBlank,
    });
    rec = selection.record;
    let finding = selection.finding;
    const alreadyTriedSparseFallback = rec.attempts?.some(
      (attempt) => attempt.mode === "sparse-high-contrast",
    );
    if (
      !args.ocr &&
      finding.missingRequired.length > 0 &&
      !alreadyTriedSparseFallback
    ) {
      // A confident transcript can still omit small labels. Retry only the
      // screenshot whose declared content failed, rather than doubling OCR work
      // for the entire audit or accepting a false pixel regression.
      const retried = await runPackagedOcr([rec.path], true);
      const retryRecord = retried[0];
      if (!retryRecord) {
        throw new Error(
          `OCR semantic retry produced no record for ${rec.path}`,
        );
      }
      rec = retryRecord;
      selection = selectSemanticallyBestOcrAttempt(rec, {
        ...policyInput,
        exemptFromBlank,
      });
      rec = selection.record;
      finding = selection.finding;
    }
    const domVerdict = rep.verdict ?? null;
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
      words: rec.words,
      meanConfidence: rec.meanConfidence,
      selectedMode: rec.selectedMode ?? null,
      attempts: rec.attempts,
      pixelBlank: rec.pixelBlank,
      pixelBlankReasons: rec.pixelBlankReasons,
    });
  }

  entries.sort((a, b) => {
    const rank = (e: TriageEntry) =>
      e.regression ? 0 : e.ocrVerdict === "broken" ? 1 : 2;
    return rank(a) - rank(b) || a.slug.localeCompare(b.slug);
  });

  const regressions = entries.filter((e) => e.regression);
  const newRegressions = regressions;
  const knownRegressions: TriageEntry[] = [];

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
