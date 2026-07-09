/**
 * Derives the pixel-evidence manifest from the current aesthetic-audit report.
 * OCR consumes this closed set so stale files from prior captures cannot be
 * mistaken for evidence produced by the active run.
 */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface AuditReportRow {
  slug: string;
  viewport: string;
  viewType?: "gui" | "tui";
  verdict?: string;
}

export interface AuditScreenshot {
  key: string;
  path: string;
  slug: string;
  viewport: string;
}

function assertPathSegment(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    /[\\/]/.test(value)
  ) {
    throw new Error(`Invalid audit ${field}: ${JSON.stringify(value)}`);
  }
}

export function parseAuditReport(value: unknown): AuditReportRow[] {
  if (!Array.isArray(value)) {
    throw new Error("Audit report must be an array");
  }
  return value.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`Invalid audit report row at index ${index}`);
    }
    const candidate = row as Record<string, unknown>;
    assertPathSegment(candidate.slug, `slug at index ${index}`);
    assertPathSegment(candidate.viewport, `viewport at index ${index}`);
    if (
      candidate.viewType !== undefined &&
      candidate.viewType !== "gui" &&
      candidate.viewType !== "tui"
    ) {
      throw new Error(`Invalid audit viewType at index ${index}`);
    }
    if (
      candidate.verdict !== undefined &&
      typeof candidate.verdict !== "string"
    ) {
      throw new Error(`Invalid audit verdict at index ${index}`);
    }
    return {
      slug: candidate.slug,
      viewport: candidate.viewport,
      viewType: candidate.viewType,
      verdict: candidate.verdict,
    };
  });
}

export function auditScreenshotKey(slug: string, viewport: string): string {
  return `${slug}::${viewport}`;
}

export function buildAuditCaptureManifest(
  auditDir: string,
  report: readonly AuditReportRow[],
): AuditScreenshot[] {
  if (report.length === 0) {
    throw new Error("Audit report contains no screenshot rows");
  }

  const seen = new Set<string>();
  return report.map((row) => {
    assertPathSegment(row.slug, "slug");
    assertPathSegment(row.viewport, "viewport");
    const key = auditScreenshotKey(row.slug, row.viewport);
    if (seen.has(key)) {
      throw new Error(`Duplicate audit report row: ${key}`);
    }
    seen.add(key);
    return {
      key,
      path: join(auditDir, row.viewport, `${row.slug}.png`),
      slug: row.slug,
      viewport: row.viewport,
    };
  });
}

export function screenshotKeyFromPath(path: string): string {
  const slug = basename(path).replace(/\.png$/i, "");
  const viewport = basename(dirname(path));
  return auditScreenshotKey(slug, viewport);
}

export function validateOcrRecordPaths(
  records: readonly { path: string }[],
  manifest: readonly AuditScreenshot[],
  auditDir = ".",
): void {
  const expected = new Map(
    manifest.map((entry) => [entry.key, resolve(entry.path)]),
  );
  const seen = new Set<string>();

  for (const record of records) {
    const key = screenshotKeyFromPath(record.path);
    const expectedPath = expected.get(key);
    const recordPath = resolve(record.path);
    const auditRelativePath = isAbsolute(record.path)
      ? recordPath
      : resolve(auditDir, record.path);
    if (
      !expectedPath ||
      (recordPath !== expectedPath && auditRelativePath !== expectedPath)
    ) {
      throw new Error(`OCR input is not in the current audit report: ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate OCR input: ${key}`);
    }
    seen.add(key);
  }

  const missing = [...expected.keys()].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(
      `OCR input is missing current audit rows: ${missing.join(", ")}`,
    );
  }
}
