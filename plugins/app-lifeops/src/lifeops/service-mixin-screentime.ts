import crypto from "node:crypto";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser";
import type {
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeHistoryPoint,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeMetrics,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSession,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeTargetBucket,
  LifeOpsScreenTimeVisibleBuckets,
  LifeOpsScreenTimeBreakdown as ScreenTimeBreakdown,
  LifeOpsScreenTimeBucket as ScreenTimeBucket,
  LifeOpsSocialHabitDataSource as SocialHabitDataSource,
  LifeOpsSocialHabitSummary as SocialHabitSummary,
} from "@elizaos/shared";
import { getActivityReportBetween } from "../activity-profile/activity-tracker-reporting.js";
import { isSystemInactivityApp } from "../activity-profile/system-inactivity-apps.js";
import {
  browserBridgeCompanionIsRecent,
  browserBridgePermissionsReady,
  isBrowserBridgePaused,
} from "./browser-readiness.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import {
  classifyScreenTimeTarget,
  isSocialCategory,
} from "./social-taxonomy.js";

function isoNow(): string {
  return new Date().toISOString();
}

function computeDurationSeconds(
  startAt: string,
  endAt: string | null | undefined,
  provided: number | undefined,
): number {
  if (
    typeof provided === "number" &&
    Number.isFinite(provided) &&
    provided >= 0
  ) {
    return Math.floor(provided);
  }
  if (!endAt) return 0;
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  const delta = Math.max(0, Math.floor((endMs - startMs) / 1000));
  return delta;
}

type ScreenTimeAggregateRow = {
  source: LifeOpsScreenTimeSource;
  identifier: string;
  displayName: string;
  totalSeconds: number;
  sessionCount: number;
  metadata?: Record<string, unknown>;
};

type ScreenTimeWeeklyAverageItem = {
  source: "app";
  identifier: string;
  displayName: string;
  totalSeconds: number;
  averageSecondsPerDay: number;
  averageMinutesPerDay: number;
};

type ScreenTimeEventInput = {
  source: "app" | "website";
  identifier: string;
  displayName: string;
  startAt: string;
  endAt?: string | null;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
};

type ScreenTimeMixinDependencies = LifeOpsServiceBase & {
  getBrowserSettings(): Promise<BrowserBridgeSettings>;
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
};

type ScreenTimeWeeklyAverageResponse = {
  items: ScreenTimeWeeklyAverageItem[];
  totalSeconds: number;
  daysInWindow: number;
};

export interface LifeOpsScreenTimeServicePublic {
  recordScreenTimeEvent(
    event: ScreenTimeEventInput,
  ): Promise<LifeOpsScreenTimeSession>;
  finishActiveScreenTimeSession(
    id: string,
    endAt: string,
    durationSeconds: number,
  ): Promise<void>;
  collectScreenTimeRows(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
  }): Promise<ScreenTimeAggregateRow[]>;
  getScreenTimeDaily(opts: {
    date: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    limit?: number;
  }): Promise<LifeOpsScreenTimeDaily[]>;
  getScreenTimeSummary(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    topN?: number;
  }): Promise<LifeOpsScreenTimeSummary>;
  getScreenTimeBreakdown(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    topN?: number;
  }): Promise<ScreenTimeBreakdown>;
  getSocialHabitSummary(opts: {
    since: string;
    until: string;
    topN?: number;
  }): Promise<SocialHabitSummary>;
  getScreenTimeHistory(opts: {
    range: LifeOpsScreenTimeRangeKey;
    topN?: number;
    socialTopN?: number;
  }): Promise<LifeOpsScreenTimeHistoryResponse>;
  getScreenTimeWeeklyAverageByApp(opts: {
    since: string;
    until: string;
    daysInWindow: number;
    identifier?: string;
    topN?: number;
  }): Promise<ScreenTimeWeeklyAverageResponse>;
  aggregateDailyForDate(date: string): Promise<{ updated: number }>;
}

const DAY_MS = 86_400_000;

function resolveUtcDateWindow(date: string): {
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
} {
  const startIso = `${date}T00:00:00.000Z`;
  const endIso = `${date}T23:59:59.999Z`;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    fail(400, "date must be a valid YYYY-MM-DD string");
  }
  return { startIso, endIso, startMs, endMs };
}

function buildWindowBounds(
  since: string,
  until: string,
): {
  sinceMs: number;
  untilMs: number;
} {
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (
    !Number.isFinite(sinceMs) ||
    !Number.isFinite(untilMs) ||
    untilMs <= sinceMs
  ) {
    fail(400, "since and until must be valid ISO strings with until > since");
  }
  return { sinceMs, untilMs };
}

function startOfLocalDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function screenTimeRangeLabel(range: LifeOpsScreenTimeRangeKey): string {
  switch (range) {
    case "today":
      return "Today";
    case "this-week":
      return "This Week";
    case "7d":
      return "Last 7d";
    case "30d":
      return "Last 30d";
  }
}

function computeScreenTimeRange(
  range: LifeOpsScreenTimeRangeKey,
  now = new Date(),
): { since: string; until: string } {
  const until = now.toISOString();
  if (range === "today") {
    return { since: startOfLocalDay(now).toISOString(), until };
  }
  if (range === "this-week") {
    const startToday = startOfLocalDay(now);
    const dayOfWeek = startToday.getDay();
    return { since: addDays(startToday, -dayOfWeek).toISOString(), until };
  }
  if (range === "7d") {
    return { since: addDays(startOfLocalDay(now), -6).toISOString(), until };
  }
  return { since: addDays(startOfLocalDay(now), -29).toISOString(), until };
}

function computePriorScreenTimeRange(
  range: LifeOpsScreenTimeRangeKey,
  current: { since: string; until: string },
): { since: string; until: string } | null {
  if (range === "today") {
    return null;
  }
  const sinceMs = Date.parse(current.since);
  const untilMs = Date.parse(current.until);
  const spanMs = untilMs - sinceMs;
  return {
    since: new Date(sinceMs - spanMs).toISOString(),
    until: current.since,
  };
}

function enumerateHistoryDays(period: {
  since: string;
  until: string;
}): Array<{ date: string; since: string; until: string; label: string }> {
  const days: Array<{
    date: string;
    since: string;
    until: string;
    label: string;
  }> = [];
  const endMs = Date.parse(period.until);
  let cursor = startOfLocalDay(new Date(Date.parse(period.since)));
  while (cursor.getTime() <= endMs) {
    const dayStart = cursor;
    const dayEnd = addDays(dayStart, 1);
    days.push({
      date: dayStart.toISOString().slice(0, 10),
      since: dayStart.toISOString(),
      until: new Date(Math.min(dayEnd.getTime(), endMs)).toISOString(),
      label: new Intl.DateTimeFormat(undefined, {
        month: "numeric",
        day: "numeric",
      }).format(dayStart),
    });
    cursor = dayEnd;
  }
  return days;
}

function deltaPercent(current: number, prior: number): number | null {
  if (prior <= 0) {
    return current > 0 ? null : 0;
  }
  return Math.round(((current - prior) / prior) * 100);
}

function bucketSeconds(buckets: ScreenTimeBucket[], key: string): number {
  return buckets.find((item) => item.key === key)?.totalSeconds ?? 0;
}

function serviceSeconds(summary: SocialHabitSummary, key: string): number {
  return summary.services.find((item) => item.key === key)?.totalSeconds ?? 0;
}

function normalizeIdentifierFilter(
  identifier: string | undefined,
): string | null {
  const normalized = identifier?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function filterRowsByIdentifier(
  rows: ScreenTimeAggregateRow[],
  identifier: string | undefined,
): ScreenTimeAggregateRow[] {
  const normalized = normalizeIdentifierFilter(identifier);
  if (!normalized) {
    return rows;
  }
  return rows.filter((row) => row.identifier === normalized);
}

function clipSessionDurationSeconds(
  session: LifeOpsScreenTimeSession,
  windowStartMs: number,
  windowEndMs: number,
): number {
  const sessionStartMs = Date.parse(session.startAt);
  if (!Number.isFinite(sessionStartMs)) {
    return 0;
  }
  const endBoundMs = Math.min(windowEndMs, Date.now());
  const sessionEndMs =
    session.endAt && Number.isFinite(Date.parse(session.endAt))
      ? Date.parse(session.endAt)
      : endBoundMs;
  const clippedStart = Math.max(sessionStartMs, windowStartMs);
  const clippedEnd = Math.min(sessionEndMs, endBoundMs);
  if (clippedEnd <= clippedStart) {
    return 0;
  }
  return Math.max(0, Math.floor((clippedEnd - clippedStart) / 1000));
}

function aggregateWebsiteSessions(
  sessions: LifeOpsScreenTimeSession[],
  windowStartMs: number,
  windowEndMs: number,
): ScreenTimeAggregateRow[] {
  const groups = new Map<string, ScreenTimeAggregateRow>();
  for (const session of sessions) {
    const clippedSeconds = clipSessionDurationSeconds(
      session,
      windowStartMs,
      windowEndMs,
    );
    if (clippedSeconds <= 0) {
      continue;
    }
    const key = `${session.source}::${session.identifier}`;
    const existing = groups.get(key);
    if (existing) {
      existing.totalSeconds += clippedSeconds;
      existing.sessionCount += 1;
      continue;
    }
    groups.set(key, {
      source: session.source,
      identifier: session.identifier,
      displayName: session.displayName || session.identifier,
      totalSeconds: clippedSeconds,
      sessionCount: 1,
      metadata: session.metadata,
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (right.totalSeconds !== left.totalSeconds) {
      return right.totalSeconds - left.totalSeconds;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}

function isSystemInactivitySession(session: LifeOpsScreenTimeSession): boolean {
  return (
    session.source === "app" &&
    isSystemInactivityApp({
      bundleId: session.identifier,
      appName: session.displayName,
      platform:
        typeof session.metadata?.platform === "string"
          ? session.metadata.platform
          : null,
    })
  );
}

function mergeAggregateRows(
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

function toDailyRows(
  agentId: string,
  date: string,
  rows: ScreenTimeAggregateRow[],
): LifeOpsScreenTimeDaily[] {
  const now = isoNow();
  return mergeAggregateRows(rows).map((row) => ({
    id: `screen-time:${agentId}:${date}:${row.source}:${row.identifier}`,
    agentId,
    source: row.source,
    identifier: row.identifier,
    date,
    totalSeconds: row.totalSeconds,
    sessionCount: row.sessionCount,
    metadata: {
      displayName: row.displayName,
      ...(row.metadata ?? {}),
    },
    createdAt: now,
    updatedAt: now,
  }));
}

function toSummaryItems(
  rows: ScreenTimeAggregateRow[],
  topN?: number,
): {
  items: Array<{
    source: "app" | "website";
    identifier: string;
    displayName: string;
    totalSeconds: number;
  }>;
  totalSeconds: number;
} {
  const sorted = mergeAggregateRows(rows);
  const limited = sorted.slice(0, topN ?? sorted.length);
  return {
    items: limited.map((row) => ({
      source: row.source,
      identifier: row.identifier,
      displayName: row.displayName,
      totalSeconds: row.totalSeconds,
    })),
    totalSeconds: sorted.reduce((sum, row) => sum + row.totalSeconds, 0),
  };
}

function toWeeklyAverageItems(
  items: Array<{
    source: "app" | "website";
    identifier: string;
    displayName: string;
    totalSeconds: number;
  }>,
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
  buckets: Map<string, ScreenTimeBucket>,
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

function bucketList(
  buckets: Map<string, ScreenTimeBucket>,
): ScreenTimeBucket[] {
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

function deviceLabel(device: string): string {
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

function sourceLabel(source: string): string {
  return source === "website" ? "Web" : "Apps";
}

function toBreakdownItems(
  rows: ScreenTimeAggregateRow[],
  topN?: number,
): ScreenTimeBreakdown {
  const sorted = mergeAggregateRows(rows);
  const sourceBuckets = new Map<string, ScreenTimeBucket>();
  const categoryBuckets = new Map<string, ScreenTimeBucket>();
  const deviceBuckets = new Map<string, ScreenTimeBucket>();
  const serviceBuckets = new Map<string, ScreenTimeBucket>();
  const browserBuckets = new Map<string, ScreenTimeBucket>();

  const items = sorted.map((row) => {
    const classification = classifyScreenTimeTarget(row);
    addBucket(
      sourceBuckets,
      row.source,
      sourceLabel(row.source),
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
      deviceLabel(classification.device),
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
    bySource: bucketList(sourceBuckets),
    byCategory: bucketList(categoryBuckets),
    byDevice: bucketList(deviceBuckets),
    byService: bucketList(serviceBuckets),
    byBrowser: bucketList(browserBuckets),
    fetchedAt: isoNow(),
  };
}

function buildScreenTimeMetrics(
  breakdown: ScreenTimeBreakdown,
  social: SocialHabitSummary,
  priorBreakdown: ScreenTimeBreakdown | null,
  priorSocial: SocialHabitSummary | null,
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

function buildVisibleBuckets(
  breakdown: ScreenTimeBreakdown,
  social: SocialHabitSummary,
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

function inWindow(
  iso: string | null | undefined,
  sinceMs: number,
  untilMs: number,
): boolean {
  if (!iso) return false;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed >= sinceMs && parsed <= untilMs;
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

function androidUsageRowsFromSignals(
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
    if (!screenTime || screenTime.granted !== true) continue;
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

function mobileScreenTimeDataSourceFromSignals(
  signals: Array<{
    platform: string;
    source: string;
    metadata: Record<string, unknown>;
  }>,
  platform: "android" | "ios",
): Pick<SocialHabitDataSource, "state" | "statusLabel" | "detail"> {
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

function browserTrackingDataSourceState(
  settings: BrowserBridgeSettings,
  companions: BrowserBridgeCompanionStatus[],
): SocialHabitDataSource["state"] {
  if (!settings.enabled || settings.trackingMode === "off") {
    return "unwired";
  }
  if (isBrowserBridgePaused(settings)) {
    return "partial";
  }
  if (companions.length === 0) {
    return "unwired";
  }

  const connectedCompanions = companions.filter(
    (companion) => companion.connectionState === "connected",
  );
  if (connectedCompanions.length === 0) {
    return companions.some(
      (companion) => companion.connectionState === "permission_blocked",
    )
      ? "partial"
      : "unwired";
  }

  const recentConnectedCompanions = connectedCompanions.filter((companion) =>
    browserBridgeCompanionIsRecent(companion),
  );
  if (recentConnectedCompanions.length === 0) {
    return "partial";
  }

  return recentConnectedCompanions.some((companion) =>
    browserBridgePermissionsReady(settings, companion.permissions),
  )
    ? "live"
    : "partial";
}

/** @internal */
export function withScreenTime<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsScreenTimeServicePublic> {
  const ScreenTimeBase =
    Base as unknown as Constructor<ScreenTimeMixinDependencies>;

  class LifeOpsScreenTimeServiceMixin extends ScreenTimeBase {
    async recordScreenTimeEvent(
      event: ScreenTimeEventInput,
    ): Promise<LifeOpsScreenTimeSession> {
      if (event.source !== "app" && event.source !== "website") {
        fail(400, "source must be 'app' or 'website'");
      }
      if (!event.identifier || typeof event.identifier !== "string") {
        fail(400, "identifier is required");
      }
      if (!event.startAt || typeof event.startAt !== "string") {
        fail(400, "startAt is required");
      }
      const now = isoNow();
      const endAt = event.endAt ?? null;
      const isActive = endAt === null;
      const durationSeconds = computeDurationSeconds(
        event.startAt,
        endAt,
        event.durationSeconds,
      );
      const session: LifeOpsScreenTimeSession = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        source: event.source,
        identifier: event.identifier,
        displayName: event.displayName || event.identifier,
        startAt: event.startAt,
        endAt,
        durationSeconds,
        isActive,
        metadata: event.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertScreenTimeSession(session);
      return session;
    }

    async finishActiveScreenTimeSession(
      id: string,
      endAt: string,
      durationSeconds: number,
    ): Promise<void> {
      await this.repository.finishScreenTimeSession(
        this.agentId(),
        id,
        endAt,
        Math.max(0, Math.floor(durationSeconds)),
      );
    }

    async collectScreenTimeRows(opts: {
      since: string;
      until: string;
      source?: LifeOpsScreenTimeSource;
      identifier?: string;
    }): Promise<ScreenTimeAggregateRow[]> {
      const { sinceMs, untilMs } = buildWindowBounds(opts.since, opts.until);
      const rows: ScreenTimeAggregateRow[] = [];

      if (opts.source === "app") {
        const appReport = await getActivityReportBetween(
          this.runtime,
          this.agentId(),
          {
            sinceMs,
            untilMs: Math.min(untilMs, Date.now()),
          },
        );
        rows.push(
          ...appReport.apps.map((app) => ({
            source: "app" as const,
            identifier: app.bundleId || app.appName,
            displayName: app.appName || app.bundleId,
            totalSeconds: Math.floor(app.totalMs / 1000),
            sessionCount: app.sessionCount,
            metadata: {
              sampleWindowTitles: app.sampleWindowTitles,
            },
          })),
        );
        const appSessions =
          await this.repository.listScreenTimeSessionsOverlapping(
            this.agentId(),
            opts.since,
            opts.until,
            { source: "app" },
          );
        rows.push(
          ...aggregateWebsiteSessions(
            appSessions.filter(
              (session) => !isSystemInactivitySession(session),
            ),
            sinceMs,
            untilMs,
          ),
        );
        const mobileSignals = await this.repository.listActivitySignals(
          this.agentId(),
          {
            sinceAt: opts.since,
            limit: 200,
          },
        );
        rows.push(
          ...androidUsageRowsFromSignals(
            mobileSignals.filter(
              (signal) =>
                signal.platform === "android" &&
                inWindow(signal.observedAt, sinceMs, untilMs),
            ),
            sinceMs,
            untilMs,
          ),
        );
      }

      if (opts.source === "website") {
        const websiteSessions =
          await this.repository.listScreenTimeSessionsOverlapping(
            this.agentId(),
            opts.since,
            opts.until,
            { source: "website" },
          );
        rows.push(
          ...aggregateWebsiteSessions(websiteSessions, sinceMs, untilMs),
        );
      }

      return filterRowsByIdentifier(rows, opts.identifier);
    }

    async getScreenTimeDaily(opts: {
      date: string;
      source?: LifeOpsScreenTimeSource;
      identifier?: string;
      limit?: number;
    }): Promise<LifeOpsScreenTimeDaily[]> {
      const { startIso, endIso } = resolveUtcDateWindow(opts.date);
      const rows = await this.collectScreenTimeRows({
        since: startIso,
        until: endIso,
        source: opts.source,
        identifier: opts.identifier,
      });

      const dailyRows = toDailyRows(this.agentId(), opts.date, rows);
      return dailyRows.slice(0, opts.limit ?? dailyRows.length);
    }

    async getScreenTimeSummary(opts: {
      since: string;
      until: string;
      source?: LifeOpsScreenTimeSource;
      identifier?: string;
      topN?: number;
    }): Promise<LifeOpsScreenTimeSummary> {
      const rows = await this.collectScreenTimeRows(opts);
      return toSummaryItems(rows, opts.topN);
    }

    async getScreenTimeBreakdown(opts: {
      since: string;
      until: string;
      source?: LifeOpsScreenTimeSource;
      identifier?: string;
      topN?: number;
    }): Promise<ScreenTimeBreakdown> {
      const rows = await this.collectScreenTimeRows(opts);
      return toBreakdownItems(rows, opts.topN);
    }

    async getSocialHabitSummary(opts: {
      since: string;
      until: string;
      topN?: number;
    }): Promise<SocialHabitSummary> {
      const { sinceMs, untilMs } = buildWindowBounds(opts.since, opts.until);
      const fullBreakdown = await this.getScreenTimeBreakdown({
        since: opts.since,
        until: opts.until,
      });
      const socialRows = fullBreakdown.items.filter(
        (item) => item.service || isSocialCategory(item.category),
      );
      const deviceBuckets = new Map<string, ScreenTimeBucket>();
      const surfaceBuckets = new Map<string, ScreenTimeBucket>();
      const browserBuckets = new Map<string, ScreenTimeBucket>();
      for (const row of socialRows) {
        addBucket(
          deviceBuckets,
          row.device,
          deviceLabel(row.device),
          row.totalSeconds,
        );
        addBucket(
          surfaceBuckets,
          row.source,
          sourceLabel(row.source),
          row.totalSeconds,
        );
        addBucket(
          browserBuckets,
          row.browser?.toLowerCase(),
          row.browser,
          row.totalSeconds,
        );
      }

      const xDms = await this.repository.listXDms(this.agentId(), {
        limit: 500,
      });
      const xReceivedWindowDms = xDms.filter((dm) =>
        inWindow(dm.receivedAt, sinceMs, untilMs),
      );
      const xInbound = xReceivedWindowDms.filter((dm) => dm.isInbound).length;
      const xOutbound = xReceivedWindowDms.length - xInbound;
      const xOpened = xDms.filter((dm) =>
        inWindow(dm.readAt, sinceMs, untilMs),
      ).length;
      const xReplied = xDms.filter((dm) =>
        inWindow(dm.repliedAt, sinceMs, untilMs),
      ).length;

      const [browserSettings, browserCompanions, recentMobileSignals] =
        await Promise.all([
          this.getBrowserSettings(),
          this.listBrowserCompanions(),
          this.repository.listActivitySignals(this.agentId(), {
            sinceAt: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
            limit: 100,
          }),
        ]);
      const messageChannels = [
        {
          channel: "x_dm" as const,
          label: "X DMs",
          inbound: xInbound,
          outbound: xOutbound,
          opened: xOpened,
          replied: xReplied,
        },
      ];
      const browserState = browserTrackingDataSourceState(
        browserSettings,
        browserCompanions,
      );
      const androidState = mobileScreenTimeDataSourceFromSignals(
        recentMobileSignals,
        "android",
      );
      const iosState = mobileScreenTimeDataSourceFromSignals(
        recentMobileSignals,
        "ios",
      );

      return {
        since: opts.since,
        until: opts.until,
        totalSeconds: socialRows.reduce(
          (sum, row) => sum + row.totalSeconds,
          0,
        ),
        services: fullBreakdown.byService.slice(0, opts.topN ?? 8),
        devices: bucketList(deviceBuckets),
        surfaces: bucketList(surfaceBuckets),
        browsers: bucketList(browserBuckets),
        sessions: socialRows.slice(0, opts.topN ?? 8),
        messages: {
          channels: messageChannels,
          inbound: xInbound,
          outbound: xOutbound,
          opened: xOpened,
          replied: xReplied,
        },
        dataSources: [
          {
            id: "macos_activity",
            label: "Mac apps",
            state: "live",
            statusLabel: "Live",
            detail:
              "macOS app focus events are included in screen-time totals.",
          },
          {
            id: "browser_bridge",
            label: "Browser",
            state: browserState,
            statusLabel:
              browserState === "live"
                ? "Live"
                : browserState === "partial"
                  ? "Needs attention"
                  : "Not connected",
            detail:
              browserState === "live"
                ? "Browser focus sessions are included in website totals."
                : browserState === "partial"
                  ? "Browser tracking is enabled but permissions, recency, or pause state are incomplete."
                  : "Browser tracking is disabled or no companion is connected.",
          },
          {
            id: "android_usage_stats",
            label: "Android apps",
            ...androidState,
          },
          {
            id: "ios_device_activity",
            label: "iOS apps",
            ...iosState,
          },
        ],
        fetchedAt: isoNow(),
      };
    }

    async getScreenTimeHistory(opts: {
      range: LifeOpsScreenTimeRangeKey;
      topN?: number;
      socialTopN?: number;
    }): Promise<LifeOpsScreenTimeHistoryResponse> {
      const window = computeScreenTimeRange(opts.range);
      const priorWindow = computePriorScreenTimeRange(opts.range, window);
      const [breakdown, social, priorBreakdown, priorSocial] =
        await Promise.all([
          this.getScreenTimeBreakdown({
            since: window.since,
            until: window.until,
            topN: opts.topN,
          }),
          this.getSocialHabitSummary({
            since: window.since,
            until: window.until,
            topN: opts.socialTopN,
          }),
          priorWindow
            ? this.getScreenTimeBreakdown({
                since: priorWindow.since,
                until: priorWindow.until,
                topN: opts.topN,
              })
            : Promise.resolve(null),
          priorWindow
            ? this.getSocialHabitSummary({
                since: priorWindow.since,
                until: priorWindow.until,
                topN: opts.socialTopN,
              })
            : Promise.resolve(null),
        ]);
      const history: LifeOpsScreenTimeHistoryPoint[] =
        opts.range === "today"
          ? []
          : await Promise.all(
              enumerateHistoryDays(window).map(async (day) => {
                const summary = await this.getScreenTimeSummary({
                  since: day.since,
                  until: day.until,
                });
                return {
                  ...day,
                  totalSeconds: summary.totalSeconds,
                };
              }),
            );

      return {
        range: opts.range,
        label: screenTimeRangeLabel(opts.range),
        window,
        priorWindow,
        breakdown,
        social,
        history,
        metrics: buildScreenTimeMetrics(
          breakdown,
          social,
          priorBreakdown,
          priorSocial,
        ),
        visible: buildVisibleBuckets(breakdown, social),
        fetchedAt: isoNow(),
      };
    }

    async getScreenTimeWeeklyAverageByApp(opts: {
      since: string;
      until: string;
      daysInWindow: number;
      identifier?: string;
      topN?: number;
    }): Promise<ScreenTimeWeeklyAverageResponse> {
      const summary = await this.getScreenTimeSummary({
        since: opts.since,
        until: opts.until,
        source: "app",
        identifier: opts.identifier,
        topN: opts.topN,
      });
      const daysInWindow = Math.max(1, Math.floor(opts.daysInWindow));
      return {
        items: toWeeklyAverageItems(summary.items, daysInWindow),
        totalSeconds: summary.totalSeconds,
        daysInWindow,
      };
    }

    async aggregateDailyForDate(date: string): Promise<{ updated: number }> {
      return this.repository.aggregateScreenTimeDailyForDate(
        this.agentId(),
        date,
      );
    }
  }
  return LifeOpsScreenTimeServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsScreenTimeServicePublic
  >;
}
