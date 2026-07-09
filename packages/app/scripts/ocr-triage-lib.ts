/**
 * Provenance-scoping for the OCR triage: derives the exact screenshot set an OCR
 * run may consume from THIS capture's `report.json`, so a stale PNG left by an
 * earlier run — a since-removed view, an older crash — can never enter the
 * result (#15790). The aesthetic audit records one report row per view×viewport
 * and writes its screenshot to `<auditDir>/<viewport>/<slug>.png`; these pure
 * functions make that mapping total and injective: every row resolves to exactly
 * one existing file, a duplicate row key or a missing file is a hard error (a
 * report that pixels cannot back one-to-one is a broken capture, not a
 * degradable state), and extra files on disk are ignored rather than silently
 * OCR'd. Kept engine-free and dependency-injectable so the guarantees are unit
 * tested without an OCR engine or real screenshots.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AuditReportRow {
  slug: string;
  viewport: string;
  viewType?: "gui" | "tui";
  verdict?: string;
}

export interface ResolvedShot {
  key: string;
  row: AuditReportRow;
  path: string;
}

export function reportRowKey(slug: string, viewport: string): string {
  return `${slug}::${viewport}`;
}

/** `<viewport>/<slug>.png` back to the `slug::viewport` key that names its report row. */
export function shotKeyOfPath(path: string): string {
  return reportRowKey(
    basename(path).replace(/\.png$/, ""),
    basename(dirname(path)),
  );
}

/**
 * One resolved screenshot per report row, in report order. Throws on a duplicate
 * row key or a row whose screenshot file is absent — the OCR set is defined by
 * the report, so a report that cannot be backed one-to-one by real pixels fails
 * loudly instead of being quietly padded with, or short of, screenshots.
 */
export function resolveAuditScreenshots(
  report: AuditReportRow[],
  auditDir: string,
  fileExists: (p: string) => boolean = existsSync,
): ResolvedShot[] {
  const seen = new Set<string>();
  const resolved: ResolvedShot[] = [];
  for (const row of report) {
    const key = reportRowKey(row.slug, row.viewport);
    if (seen.has(key)) {
      throw new Error(`[ocr-triage] duplicate report row ${key}`);
    }
    seen.add(key);
    const path = join(auditDir, row.viewport, `${row.slug}.png`);
    if (!fileExists(path)) {
      throw new Error(
        `[ocr-triage] report row ${key} has no screenshot at ${path} — the capture is incomplete or the report is stale`,
      );
    }
    resolved.push({ key, row, path });
  }
  return resolved;
}

/**
 * Selects the precomputed OCR record for each resolved shot from an `--ocr`
 * ndjson dump, in report order. Records whose path matches no report row (stale
 * PNGs) are dropped; a report row with no matching record is a hard error, so a
 * precomputed run is held to the same one-row-one-screenshot contract as a live
 * packaged run.
 */
export function selectOcrRecordsForShots<T extends { path: string }>(
  shots: ResolvedShot[],
  records: T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const rec of records) byKey.set(shotKeyOfPath(rec.path), rec);
  return shots.map((shot) => {
    const rec = byKey.get(shot.key);
    if (!rec) {
      throw new Error(
        `[ocr-triage] --ocr input has no record for report row ${shot.key}`,
      );
    }
    return rec;
  });
}
