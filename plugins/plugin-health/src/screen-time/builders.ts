/**
 * Pure screen-time builders: summary, breakdown, per-target metrics, and
 * visible-bucket assembly over normalized aggregate rows. No runtime or IO.
 */
import type {
  LifeOpsScreenTimeBreakdown,
  LifeOpsScreenTimeBucket,
  LifeOpsScreenTimeMetrics,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeSummaryItem,
  LifeOpsScreenTimeTargetBucket,
  LifeOpsScreenTimeVisibleBuckets,
  LifeOpsSocialHabitSummary,
} from "../contracts/lifeops.js";
import { classifyScreenTimeTarget } from "./social-taxonomy.js";

export interface ScreenTimeAggregateRow {
  source: LifeOpsScreenTimeSource;
  identifier: string;
  displayName: string;
  totalSeconds: number;
  sessionCount: number;
  metadata?: Record<string, unknown>;
}

export interface ScreenTimeWeeklyAverageItem {
  source: "app";
  identifier: string;
  displayName: string;
  totalSeconds: number;
  averageSecondsPerDay: number;
  averageMinutesPerDay: number;
}

export function mergeScreenTimeAggregateRows(
  rows: ScreenTimeAggregateRow[],
): ScreenTimeAggregateRow[] {
  const groups = new Map<string, ScreenTimeAggregateRow>();
  for (const row of rows) {
    const key = `${row.source}::${row.identifier}`;
    const existing = groups.get(key);
    if (existing) {
      existing.totalSeconds += row.totalSeconds;
      existing.sessionCount += row.sessionCount;
      existing.metadata = {
        ...(existing.metadata ?? {}),
        ...(row.metadata ?? {}),
      };
      if (!existing.displayName && row.displayName) {
        existing.displayName = row.displayName;
      }
      continue;
    }
    groups.set(key, {
      ...row,
      metadata: row.metadata ?? {},
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (right.totalSeconds !== left.totalSeconds) {
      return right.totalSeconds - left.totalSeconds;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}

export function buildScreenTimeSummary(
  rows: ScreenTimeAggregateRow[],
  topN?: number,
): LifeOpsScreenTimeSummary {
  const sorted = mergeScreenTimeAggregateRows(rows);
  const limited = sorted.slice(0, topN ?? sorted.length);
  return {
    items: limited.map(
      (row): LifeOpsScreenTimeSummaryItem => ({
        source: row.source,
        identifier: row.identifier,
        displayName: row.displayName,
        totalSeconds: row.totalSeconds,
      }),
    ),
    totalSeconds: sorted.reduce((sum, row) => sum + row.totalSeconds, 0),
  };
}

export function buildScreenTimeWeeklyAverageItems(
  items: LifeOpsScreenTimeSummaryItem[],
  daysInWindow: number,
): ScreenTimeWeeklyAverageItem[] {
  const safeDays = Math.max(1, Math.floor(daysInWindow));
  return items.map((item) => ({
    source: "app",
    identifier: item.identifier,
    displayName: item.displayName,
    totalSeconds: item.totalSeconds,
    averageSecondsPerDay: Math.round(item.totalSeconds / safeDays),
    averageMinutesPerDay: Math.round(item.totalSeconds / safeDays / 60),
  }));
}

function addBucket(
  buckets: Map<string, LifeOpsScreenTimeBucket>,
  key: string | null | undefined,
  label: string | null | undefined,
  totalSeconds: number,
): void {
  if (!key || totalSeconds <= 0) return;
  const existing = buckets.get(key);
  if (existing) {
    existing.totalSeconds += totalSeconds;
    return;
  }
  buckets.set(key, {
    key,
    label: label || key,
    totalSeconds,
  });
}

export function screenTimeBucketList(
  buckets: Map<string, LifeOpsScreenTimeBucket>,
): LifeOpsScreenTimeBucket[] {
  return [...buckets.values()].sort((left, right) => {
    if (right.totalSeconds !== left.totalSeconds) {
      return right.totalSeconds - left.totalSeconds;
    }
    return left.label.localeCompare(right.label);
  });
}

function categoryLabel(category: string): string {
  switch (category) {
    case "browser":
      return "Browser";
    case "communication":
      return "Messages";
    case "social":
      return "Social";
    case "system":
      return "System";
    case "video":
      return "Video";
    case "work":
      return "Work";
    default:
      return "Other";
  }
}

export function screenTimeDeviceLabel(device: string): string {
  switch (device) {
    case "browser":
      return "Browser";
    case "computer":
      return "Computer";
    case "phone":
      return "Phone";
    case "tablet":
      return "Tablet";
    default:
      return "Unknown";
  }
}

export function screenTimeSourceLabel(source: string): string {
  return source === "website" ? "Web" : "Apps";
}

export function buildScreenTimeBreakdown(
  rows: ScreenTimeAggregateRow[],
  topN?: number,
  fetchedAt = new Date().toISOString(),
): LifeOpsScreenTimeBreakdown {
  const sorted = mergeScreenTimeAggregateRows(rows);
  const sourceBuckets = new Map<string, LifeOpsScreenTimeBucket>();
  const categoryBuckets = new Map<string, LifeOpsScreenTimeBucket>();
  const deviceBuckets = new Map<string, LifeOpsScreenTimeBucket>();
  const serviceBuckets = new Map<string, LifeOpsScreenTimeBucket>();
  const browserBuckets = new Map<string, LifeOpsScreenTimeBucket>();

  const items = sorted.map((row) => {
    const classification = classifyScreenTimeTarget(row);
    addBucket(
      sourceBuckets,
      row.source,
      screenTimeSourceLabel(row.source),
      row.totalSeconds,
    );
    addBucket(
      categoryBuckets,
      classification.category,
      categoryLabel(classification.category),
      row.totalSeconds,
    );
    addBucket(
      deviceBuckets,
      classification.device,
      screenTimeDeviceLabel(classification.device),
      row.totalSeconds,
    );
    addBucket(
      serviceBuckets,
      classification.service,
      classification.serviceLabel,
      row.totalSeconds,
    );
    addBucket(
      browserBuckets,
      classification.browser?.toLowerCase(),
      classification.browser,
      row.totalSeconds,
    );
    return {
      source: row.source,
      identifier: row.identifier,
      displayName: row.displayName,
      totalSeconds: row.totalSeconds,
      sessionCount: row.sessionCount,
      category: classification.category,
      device: classification.device,
      service: classification.service,
      serviceLabel: classification.serviceLabel,
      browser: classification.browser,
    };
  });

  return {
    items: items.slice(0, topN ?? items.length),
    totalSeconds: sorted.reduce((sum, row) => sum + row.totalSeconds, 0),
    bySource: screenTimeBucketList(sourceBuckets),
    byCategory: screenTimeBucketList(categoryBuckets),
    byDevice: screenTimeBucketList(deviceBuckets),
    byService: screenTimeBucketList(serviceBuckets),
    byBrowser: screenTimeBucketList(browserBuckets),
    fetchedAt,
  };
}

function deltaPercent(current: number, prior: number): number | null {
  if (prior <= 0) {
    return current > 0 ? null : 0;
  }
  return Math.round(((current - prior) / prior) * 100);
}

function bucketSeconds(
  buckets: LifeOpsScreenTimeBucket[],
  key: string,
): number {
  return buckets.find((item) => item.key === key)?.totalSeconds ?? 0;
}

function serviceSeconds(
  summary: LifeOpsSocialHabitSummary,
  key: string,
): number {
  return summary.services.find((item) => item.key === key)?.totalSeconds ?? 0;
}

export function buildScreenTimeMetrics(
  breakdown: LifeOpsScreenTimeBreakdown,
  social: LifeOpsSocialHabitSummary,
  priorBreakdown: LifeOpsScreenTimeBreakdown | null,
  priorSocial: LifeOpsSocialHabitSummary | null,
): LifeOpsScreenTimeMetrics {
  const totalSeconds = breakdown.totalSeconds;
  const appSeconds = bucketSeconds(breakdown.bySource, "app");
  const webSeconds = bucketSeconds(breakdown.bySource, "website");
  const phoneSeconds = bucketSeconds(breakdown.byDevice, "phone");
  const socialSeconds = social.totalSeconds;
  const youtubeSeconds = serviceSeconds(social, "youtube");
  const xSeconds = serviceSeconds(social, "x");
  const messageOpened = social.messages.opened;
  const messageOutbound = social.messages.outbound;
  const messageInbound = social.messages.inbound;

  if (!priorBreakdown || !priorSocial) {
    return {
      totalSeconds,
      appSeconds,
      webSeconds,
      phoneSeconds,
      socialSeconds,
      youtubeSeconds,
      xSeconds,
      messageOpened,
      messageOutbound,
      messageInbound,
      deltas: null,
    };
  }

  return {
    totalSeconds,
    appSeconds,
    webSeconds,
    phoneSeconds,
    socialSeconds,
    youtubeSeconds,
    xSeconds,
    messageOpened,
    messageOutbound,
    messageInbound,
    deltas: {
      totalPercent: deltaPercent(totalSeconds, priorBreakdown.totalSeconds),
      appPercent: deltaPercent(
        appSeconds,
        bucketSeconds(priorBreakdown.bySource, "app"),
      ),
      webPercent: deltaPercent(
        webSeconds,
        bucketSeconds(priorBreakdown.bySource, "website"),
      ),
      phonePercent: deltaPercent(
        phoneSeconds,
        bucketSeconds(priorBreakdown.byDevice, "phone"),
      ),
      socialPercent: deltaPercent(socialSeconds, priorSocial.totalSeconds),
      youtubePercent: deltaPercent(
        youtubeSeconds,
        serviceSeconds(priorSocial, "youtube"),
      ),
      xPercent: deltaPercent(xSeconds, serviceSeconds(priorSocial, "x")),
      messageOpenedPercent: deltaPercent(
        messageOpened,
        priorSocial.messages.opened,
      ),
    },
  };
}

export function buildScreenTimeVisibleBuckets(
  breakdown: LifeOpsScreenTimeBreakdown,
  social: LifeOpsSocialHabitSummary,
): LifeOpsScreenTimeVisibleBuckets {
  const categories = breakdown.byCategory.filter(
    (item) => item.totalSeconds > 0,
  );
  const devices = breakdown.byDevice.filter((item) => item.totalSeconds > 0);
  const browsers = breakdown.byBrowser.filter((item) => item.totalSeconds > 0);
  const services = social.services.filter((item) => item.totalSeconds > 0);
  const surfaces = social.surfaces.filter((item) => item.totalSeconds > 0);
  const topTargets: LifeOpsScreenTimeTargetBucket[] = breakdown.items
    .filter((item) => item.totalSeconds > 0)
    .map((item) => ({
      key: `${item.source}:${item.identifier}`,
      label: item.displayName,
      totalSeconds: item.totalSeconds,
      source: item.source,
      identifier: item.identifier,
    }));
  const sessionBuckets = social.sessions
    .filter((item) => item.totalSeconds > 0)
    .map((item) => ({
      key: `${item.source}:${item.identifier}`,
      label: item.serviceLabel ?? item.displayName,
      totalSeconds: item.totalSeconds,
      source: item.source,
      identifier: item.identifier,
    }));
  const channels = social.messages.channels.filter(
    (channel) =>
      channel.opened > 0 || channel.outbound > 0 || channel.inbound > 0,
  );
  const hasMessageActivity =
    social.messages.opened > 0 ||
    social.messages.outbound > 0 ||
    social.messages.inbound > 0;
  const setupSources = social.dataSources.filter(
    (source) => source.state !== "live",
  );

  return {
    categories,
    devices,
    browsers,
    services,
    surfaces,
    topTargets,
    sessionBuckets,
    channels,
    setupSources,
    hasMessageActivity,
    hasUsage:
      breakdown.totalSeconds > 0 ||
      categories.length > 0 ||
      devices.length > 0 ||
      browsers.length > 0 ||
      topTargets.length > 0 ||
      social.totalSeconds > 0 ||
      services.length > 0 ||
      surfaces.length > 0 ||
      sessionBuckets.length > 0 ||
      hasMessageActivity,
  };
}
