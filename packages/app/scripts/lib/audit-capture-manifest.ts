/**
 * Derives the pixel-evidence manifest from the current aesthetic-audit report.
 * OCR consumes this closed set so stale files from prior captures cannot be
 * mistaken for evidence produced by the active run.
 */
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import sharp from "sharp";

export interface AuditOcrControls {
  screenshotSha256: string;
  width: number;
  height: number;
  rectangles: { left: number; top: number; width: number; height: number }[];
}

/** Bind CSS control rectangles to the exact captured PNG, including device scale. */
export async function bindAuditOcrControls(
  screenshot: Buffer,
  viewport: {
    width: number;
    height: number;
    rectangles: AuditOcrControls["rectangles"];
  },
): Promise<AuditOcrControls> {
  if (
    !Number.isFinite(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0
  ) {
    throw new Error("Invalid audit OCR viewport dimensions");
  }
  const metadata = await sharp(screenshot).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("Audit screenshot has no pixel dimensions");
  const width = metadata.width;
  const height = metadata.height;
  const scaleX = width / viewport.width;
  const scaleY = height / viewport.height;
  if (Math.abs(scaleX - scaleY) > 0.01)
    throw new Error("Audit screenshot scale does not match its viewport");
  const rectangles = viewport.rectangles.flatMap((rect) => {
    if (
      ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      throw new Error("Invalid measured audit OCR rectangle");
    const left = Math.max(0, Math.min(width, Math.floor(rect.left * scaleX)));
    const top = Math.max(0, Math.min(height, Math.floor(rect.top * scaleY)));
    const right = Math.max(
      0,
      Math.min(width, Math.ceil((rect.left + rect.width) * scaleX)),
    );
    const bottom = Math.max(
      0,
      Math.min(height, Math.ceil((rect.top + rect.height) * scaleY)),
    );
    return right > left && bottom > top
      ? [{ left, top, width: right - left, height: bottom - top }]
      : [];
  });
  return parseOcrControls({
    width,
    height,
    screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
    rectangles,
  });
}

export interface AuditReportRow {
  slug: string;
  viewport: string;
  viewType?: "gui" | "tui";
  verdict?: string;
  /** Present only when the capture loaded a registered remote view bundle. */
  bundleProvenance?: string;
  /** Visible control geometry in the hashed screenshot's pixel coordinates. */
  ocrControls?: AuditOcrControls;
}

export interface AuditScreenshot {
  key: string;
  path: string;
  slug: string;
  viewport: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOcrControls(value: unknown): AuditOcrControls {
  if (
    !isRecord(value) ||
    typeof value.screenshotSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.screenshotSha256) ||
    typeof value.width !== "number" ||
    !Number.isSafeInteger(value.width) ||
    value.width <= 0 ||
    typeof value.height !== "number" ||
    !Number.isSafeInteger(value.height) ||
    value.height <= 0 ||
    !Array.isArray(value.rectangles)
  ) {
    throw new Error("Invalid audit OCR control capture");
  }
  const { width, height, screenshotSha256 } = value;
  const rectangles = value.rectangles.map((rect) => {
    if (
      !isRecord(rect) ||
      typeof rect.left !== "number" ||
      !Number.isSafeInteger(rect.left) ||
      rect.left < 0 ||
      typeof rect.top !== "number" ||
      !Number.isSafeInteger(rect.top) ||
      rect.top < 0 ||
      typeof rect.width !== "number" ||
      !Number.isSafeInteger(rect.width) ||
      rect.width <= 0 ||
      typeof rect.height !== "number" ||
      !Number.isSafeInteger(rect.height) ||
      rect.height <= 0 ||
      rect.left + rect.width > width ||
      rect.top + rect.height > height
    )
      throw new Error("Invalid audit OCR control rectangle");
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  });
  return { screenshotSha256, width, height, rectangles };
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
    if (!isRecord(row)) {
      throw new Error(`Invalid audit report row at index ${index}`);
    }
    assertPathSegment(row.slug, `slug at index ${index}`);
    assertPathSegment(row.viewport, `viewport at index ${index}`);
    if (
      row.viewType !== undefined &&
      row.viewType !== "gui" &&
      row.viewType !== "tui"
    ) {
      throw new Error(`Invalid audit viewType at index ${index}`);
    }
    if (row.verdict !== undefined && typeof row.verdict !== "string") {
      throw new Error(`Invalid audit verdict at index ${index}`);
    }
    if (
      row.bundleProvenance !== undefined &&
      typeof row.bundleProvenance !== "string"
    ) {
      throw new Error(`Invalid audit bundle provenance at index ${index}`);
    }
    return {
      slug: row.slug,
      viewport: row.viewport,
      viewType: row.viewType,
      verdict: row.verdict,
      bundleProvenance: row.bundleProvenance,
      ocrControls:
        row.ocrControls === undefined
          ? undefined
          : parseOcrControls(row.ocrControls),
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
