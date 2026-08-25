/**
 * Pure packaged-desktop acceptance contracts for relaunch persistence and
 * screenshot signal quality.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";

sharp.cache(false);
sharp.concurrency(1);

export interface ReturningInstallStorageSnapshot {
  origin: string | null;
  firstRunComplete: string | null;
  setupStep: string | null;
  uiShellMode: string | null;
  activeServer: string | null;
}

export interface StoragePersistenceAssessment {
  ok: boolean;
  mismatches: Array<{
    key: keyof ReturningInstallStorageSnapshot;
    before: string | null;
    after: string | null;
  }>;
}

const PERSISTED_RETURNING_INSTALL_KEYS = [
  "firstRunComplete",
  "setupStep",
  "uiShellMode",
  "activeServer",
] as const satisfies readonly (keyof ReturningInstallStorageSnapshot)[];

export function assessReturningInstallPersistence(
  before: ReturningInstallStorageSnapshot,
  after: ReturningInstallStorageSnapshot,
): StoragePersistenceAssessment {
  const mismatches: StoragePersistenceAssessment["mismatches"] = [];
  for (const key of PERSISTED_RETURNING_INSTALL_KEYS) {
    if (before[key] === null || after[key] !== before[key]) {
      mismatches.push({ key, before: before[key], after: after[key] });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export function formatStoragePersistenceFailure(args: {
  before: ReturningInstallStorageSnapshot;
  after: ReturningInstallStorageSnapshot;
  partition: string;
  stateDir: string;
}): string {
  const assessment = assessReturningInstallPersistence(args.before, args.after);
  const summarize = (
    key: keyof ReturningInstallStorageSnapshot,
    value: string | null,
  ): string => {
    if (value === null) return "null";
    if (key !== "activeServer") return JSON.stringify(value);
    const digest = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 12);
    return `present(length=${value.length},sha256=${digest})`;
  };
  const mismatchText = assessment.mismatches
    .map(
      ({ key, before, after }) =>
        `${key}: before=${summarize(key, before)} after=${summarize(key, after)}`,
    )
    .join("; ");
  const originText =
    args.before.origin === args.after.origin
      ? `origin=${JSON.stringify(args.after.origin)}`
      : `origin changed: before=${JSON.stringify(args.before.origin)} after=${JSON.stringify(args.after.origin)}`;
  return [
    "Packaged renderer localStorage did not persist across a real process relaunch.",
    mismatchText,
    originText,
    `partition=${args.partition}`,
    `stateDir=${args.stateDir}`,
  ].join(" ");
}

export interface PackagedScreenshotSignal {
  width: number;
  height: number;
  sampledPixels: number;
  nonDarkRatio: number;
  activeRowRatio: number;
  activeColumnRatio: number;
  luminanceRange: number;
}

export async function analyzePackagedScreenshotSignal(
  buffer: Buffer,
): Promise<PackagedScreenshotSignal> {
  const { data, info } = await sharp(buffer)
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .resize({
      width: 160,
      height: 160,
      fit: "inside",
      withoutEnlargement: true,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const activeRows = new Set<number>();
  const activeColumns = new Set<number>();
  let nonDarkPixels = 0;
  let minLuminance = 255;
  let maxLuminance = 0;
  for (let offset = 0; offset < data.length; offset += 3) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    minLuminance = Math.min(minLuminance, luminance);
    maxLuminance = Math.max(maxLuminance, luminance);
    if (
      luminance < 28 &&
      Math.max(red, green, blue) - Math.min(red, green, blue) < 18
    ) {
      continue;
    }
    const pixelIndex = offset / 3;
    nonDarkPixels += 1;
    activeRows.add(Math.floor(pixelIndex / info.width));
    activeColumns.add(pixelIndex % info.width);
  }
  const sampledPixels = info.width * info.height;
  return {
    width: info.width,
    height: info.height,
    sampledPixels,
    nonDarkRatio: sampledPixels === 0 ? 0 : nonDarkPixels / sampledPixels,
    activeRowRatio: info.height === 0 ? 0 : activeRows.size / info.height,
    activeColumnRatio: info.width === 0 ? 0 : activeColumns.size / info.width,
    luminanceRange: maxLuminance - minLuminance,
  };
}

export function packagedScreenshotSignalIssues(
  label: string,
  signal: PackagedScreenshotSignal,
): string[] {
  const issues: string[] = [];
  if (signal.sampledPixels === 0) {
    issues.push(`${label}: screenshot is empty`);
  }
  if (signal.nonDarkRatio < 0.015) {
    issues.push(
      `${label}: only ${(signal.nonDarkRatio * 100).toFixed(2)}% of sampled pixels contain visible UI signal`,
    );
  }
  if (signal.activeRowRatio < 0.06) {
    issues.push(
      `${label}: visible signal spans only ${(signal.activeRowRatio * 100).toFixed(2)}% of sampled rows`,
    );
  }
  if (signal.activeColumnRatio < 0.06) {
    issues.push(
      `${label}: visible signal spans only ${(signal.activeColumnRatio * 100).toFixed(2)}% of sampled columns`,
    );
  }
  if (signal.luminanceRange < 20) {
    issues.push(
      `${label}: luminance range ${signal.luminanceRange.toFixed(2)} is too flat`,
    );
  }
  return issues;
}

export async function assertPackagedScreenshotHasSubstantialUi(
  buffer: Buffer,
  label: string,
): Promise<void> {
  const signal = await analyzePackagedScreenshotSignal(buffer);
  const issues = packagedScreenshotSignalIssues(label, signal);
  if (issues.length > 0) {
    throw new Error(
      `${label}: substantial rendered UI check failed: ${issues.join("; ")}; metrics=${JSON.stringify(signal)}`,
    );
  }
}
