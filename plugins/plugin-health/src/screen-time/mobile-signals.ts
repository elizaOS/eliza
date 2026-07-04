/**
 * Android Usage Stats and iOS Screen Time signal parsing — maps raw mobile
 * signals into `ScreenTimeAggregateRow`s and derives the mobile data-source
 * status. Re-exports the setup helpers from `./mobile-signal-setup.js`.
 */
import type { LifeOpsSocialHabitDataSource } from "../contracts/lifeops.js";
import type { ScreenTimeAggregateRow } from "./builders.js";

export * from "./mobile-signal-setup.js";

const DAY_MS = 24 * 60 * 60_000;

export interface ScreenTimeMobileSignal {
  platform: string;
  source: string;
  metadata: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function androidPackageLabel(packageName: string): string {
  switch (packageName) {
    case "com.google.android.youtube":
      return "YouTube";
    case "com.twitter.android":
      return "X";
    case "com.discord":
      return "Discord";
    case "com.reddit.frontpage":
      return "Reddit";
    case "com.instagram.android":
      return "Instagram";
    case "com.zhiliaoapp.musically":
      return "TikTok";
    default:
      return packageName;
  }
}

export function androidUsageRowsFromSignals(
  signals: Array<{ metadata: Record<string, unknown> }>,
  sinceMs: number,
  untilMs: number,
): ScreenTimeAggregateRow[] {
  if (untilMs - sinceMs > DAY_MS) {
    return [];
  }

  const byPackage = new Map<string, ScreenTimeAggregateRow>();
  for (const signal of signals) {
    const screenTime = asRecord(signal.metadata.screenTime);
    if (screenTime?.granted !== true) continue;
    for (const rawApp of asArray(screenTime.topApps)) {
      const app = asRecord(rawApp);
      const packageName =
        typeof app?.packageName === "string" ? app.packageName.trim() : "";
      const foregroundMs = positiveNumber(app?.totalTimeForegroundMs);
      if (!packageName || foregroundMs <= 0) continue;
      const totalSeconds = Math.floor(foregroundMs / 1000);
      const existing = byPackage.get(packageName);
      if (existing && existing.totalSeconds >= totalSeconds) continue;
      byPackage.set(packageName, {
        source: "app",
        identifier: packageName,
        displayName: androidPackageLabel(packageName),
        totalSeconds,
        sessionCount: 1,
        metadata: {
          platform: "android",
          packageName,
          lastTimeUsed: app?.lastTimeUsed ?? null,
        },
      });
    }
  }
  return [...byPackage.values()];
}

function coarseCategoryTotalSeconds(
  category: Record<string, unknown> | null,
): number {
  if (!category) return 0;
  if (typeof category.totalSeconds === "number") {
    return positiveNumber(category.totalSeconds);
  }
  const ms = positiveNumber(category.totalMs);
  return ms > 0 ? Math.floor(ms / 1000) : 0;
}

/**
 * iOS coarse screen-time ingestion (issue #9970). Apple's DeviceActivity /
 * FamilyControls model exposes only coarse, in-extension-rendered *category*
 * summaries to the host — never raw per-app export (`rawUsageExportAvailable`
 * is permanently false). When Screen Time authorization is approved and the
 * device reports coarse summaries, ingest those category totals into the same
 * screen-time read path as Android, gated on
 * `metadata.screenTime.authorization.status === "approved"` and
 * `coarseSummaryAvailable === true`.
 *
 * The reader is inert until a native iOS producer emits
 * `metadata.screenTime.categories`; the contract mirrors the host-side coarse
 * model (a category identifier + its total active time). Raw per-app export is
 * never read — if a signal ever set `rawUsageExportAvailable: true` it is
 * skipped, since that violates the platform constraint.
 */
export function iosCoarseUsageRowsFromSignals(
  signals: Array<{ metadata: Record<string, unknown> }>,
  sinceMs: number,
  untilMs: number,
): ScreenTimeAggregateRow[] {
  if (untilMs - sinceMs > DAY_MS) {
    return [];
  }

  const byCategory = new Map<string, ScreenTimeAggregateRow>();
  for (const signal of signals) {
    const screenTime = asRecord(signal.metadata.screenTime);
    if (!screenTime) continue;
    // Raw per-app export is a permanent Apple constraint — never ingest it.
    if (screenTime.rawUsageExportAvailable === true) continue;
    if (screenTime.coarseSummaryAvailable !== true) continue;
    const authorization = asRecord(screenTime.authorization);
    if (authorization?.status !== "approved") continue;

    for (const rawCategory of asArray(screenTime.categories)) {
      const category = asRecord(rawCategory);
      const identifier =
        typeof category?.identifier === "string"
          ? category.identifier.trim()
          : "";
      const totalSeconds = coarseCategoryTotalSeconds(category);
      if (!identifier || totalSeconds <= 0) continue;
      const displayName =
        typeof category?.displayName === "string" && category.displayName.trim()
          ? category.displayName.trim()
          : identifier;
      const key = `ios.category.${identifier}`;
      const existing = byCategory.get(key);
      if (existing && existing.totalSeconds >= totalSeconds) continue;
      byCategory.set(key, {
        source: "app",
        identifier: key,
        displayName,
        totalSeconds,
        sessionCount: 1,
        metadata: { platform: "ios", kind: "category", categoryId: identifier },
      });
    }
  }
  return [...byCategory.values()];
}

export function mobileScreenTimeDataSourceFromSignals(
  signals: ScreenTimeMobileSignal[],
  platform: "android" | "ios",
): Pick<LifeOpsSocialHabitDataSource, "state" | "statusLabel" | "detail"> {
  const platformSignals = signals.filter(
    (signal) =>
      signal.platform === platform &&
      (signal.source === "mobile_device" || signal.source === "mobile_health"),
  );
  if (platformSignals.length === 0) {
    return {
      state: "unwired",
      statusLabel: "Not connected",
      detail:
        platform === "android"
          ? "No recent Android Usage Stats signal has been received."
          : "No recent iOS Screen Time signal has been received.",
    };
  }

  for (const signal of platformSignals) {
    const screenTime = asRecord(signal.metadata.screenTime);
    if (!screenTime) continue;
    if (platform === "android") {
      return screenTime.granted === true
        ? {
            state: "partial",
            statusLabel: "Snapshot only",
            detail:
              "Android currently provides rolling Usage Stats snapshots; multi-day totals exclude Android until daily exports are available.",
          }
        : {
            state: "partial",
            statusLabel: "Permission needed",
            detail: "Android Usage Stats permission has not been granted.",
          };
    }
    const authorization = asRecord(screenTime.authorization);
    if (authorization?.status === "approved") {
      return {
        state: "partial",
        statusLabel: "Export pending",
        detail:
          "iOS Screen Time authorization is present, but usage export is pending.",
      };
    }
    return screenTime.supported === true
      ? {
          state: "partial",
          statusLabel: "Authorization needed",
          detail: "iOS Screen Time setup has not been approved.",
        }
      : {
          state: "unwired",
          statusLabel: "Unsupported",
          detail: "This iOS device has not reported Screen Time support.",
        };
  }

  return {
    state: "partial",
    statusLabel: "Signal partial",
    detail: "Recent mobile signals did not include screen-time metadata.",
  };
}
