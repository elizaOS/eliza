import type { LifeOpsSocialHabitDataSource } from "../contracts/lifeops.js";
import type { ScreenTimeAggregateRow } from "./builders.js";

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
              "Android currently provides rolling Usage Stats snapshots; multi-day totals exclude Android until daily exports are wired.",
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
          "iOS Screen Time authorization is present, but usage export is not wired yet.",
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
    statusLabel: "Signal incomplete",
    detail: "Recent mobile signals did not include screen-time metadata.",
  };
}
