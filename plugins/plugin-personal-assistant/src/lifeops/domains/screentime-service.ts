/**
 * Screen-time domain for LifeOps: aggregates device usage signals (mobile,
 * browser companion) into the owner-facing screen-time summary, breakdown, and
 * weekly-average projections. Screen-time planning logic lives in
 * `@elizaos/plugin-health`; this domain assembles the assistant projection.
 */
import crypto from "node:crypto";
import {
  type BrowserBridgeCompanionStatus,
  type BrowserBridgeSettings,
  browserBridgeCompanionIsRecent,
  browserBridgePermissionsReady,
  isBrowserBridgePaused,
} from "@elizaos/plugin-browser";
import {
  androidUsageRowsFromSignals,
  buildScreenTimeBreakdown,
  buildScreenTimeMetrics,
  buildScreenTimeSummary,
  buildScreenTimeVisibleBuckets,
  buildScreenTimeWeeklyAverageItems,
  computePriorScreenTimeRange,
  computeScreenTimeRange,
  enumerateScreenTimeHistoryDays,
  iosCoarseUsageRowsFromSignals,
  isSocialCategory,
  isSystemInactivityApp,
  mergeScreenTimeAggregateRows,
  mobileScreenTimeDataSourceFromSignals,
  type ScreenTimeAggregateRow,
  type ScreenTimeWeeklyAverageItem,
  screenTimeBucketList,
  screenTimeDeviceLabel,
  screenTimeRangeLabel,
  screenTimeSourceLabel,
} from "@elizaos/plugin-health";
import type {
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeHistoryPoint,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSession,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeBreakdown as ScreenTimeBreakdown,
  LifeOpsScreenTimeBucket as ScreenTimeBucket,
  LifeOpsSocialHabitSummary as SocialHabitSummary,
} from "@elizaos/shared";
import { getActivityReportBetween } from "../../activity-profile/activity-tracker-reporting.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import { fail } from "../service-normalize.js";

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

type ScreenTimeEventInput = {
  source: "app" | "website";
  identifier: string;
  displayName: string;
  startAt: string;
  endAt?: string | null;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Browser-domain methods the screen-time domain depends on. They live on the
 * browser domain (`withBrowser`), so they are injected as typed callbacks
 * rather than read off {@link LifeOpsContext}.
 */
export type ScreenTimeDomainDeps = {
  getBrowserSettings(): Promise<BrowserBridgeSettings>;
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
};

type ScreenTimeWeeklyAverageResponse = {
  items: ScreenTimeWeeklyAverageItem[];
  totalSeconds: number;
  daysInWindow: number;
};

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
        typeof session.metadata.platform === "string"
          ? session.metadata.platform
          : null,
    })
  );
}

function toDailyRows(
  agentId: string,
  date: string,
  rows: ScreenTimeAggregateRow[],
): LifeOpsScreenTimeDaily[] {
  const now = isoNow();
  return mergeScreenTimeAggregateRows(rows).map((row) => ({
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

function inWindow(
  iso: string | null | undefined,
  sinceMs: number,
  untilMs: number,
): boolean {
  if (!iso) return false;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed >= sinceMs && parsed <= untilMs;
}

function browserTrackingDataSourceState(
  settings: BrowserBridgeSettings,
  companions: BrowserBridgeCompanionStatus[],
): "live" | "partial" | "unwired" {
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

export class ScreenTimeDomain {
  constructor(
    private readonly ctx: LifeOpsContext,
    private readonly deps: ScreenTimeDomainDeps,
  ) {}

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
      agentId: this.ctx.agentId(),
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
    await this.ctx.repository.upsertScreenTimeSession(session);
    return session;
  }

  async finishActiveScreenTimeSession(
    id: string,
    endAt: string,
    durationSeconds: number,
  ): Promise<void> {
    await this.ctx.repository.finishScreenTimeSession(
      this.ctx.agentId(),
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
        this.ctx.runtime,
        this.ctx.agentId(),
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
        await this.ctx.repository.listScreenTimeSessionsOverlapping(
          this.ctx.agentId(),
          opts.since,
          opts.until,
          { source: "app" },
        );
      rows.push(
        ...aggregateWebsiteSessions(
          appSessions.filter((session) => !isSystemInactivitySession(session)),
          sinceMs,
          untilMs,
        ),
      );
      const mobileSignals = await this.ctx.repository.listActivitySignals(
        this.ctx.agentId(),
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
      rows.push(
        ...iosCoarseUsageRowsFromSignals(
          mobileSignals.filter(
            (signal) =>
              signal.platform === "ios" &&
              inWindow(signal.observedAt, sinceMs, untilMs),
          ),
          sinceMs,
          untilMs,
        ),
      );
    }

    if (opts.source === "website") {
      const websiteSessions =
        await this.ctx.repository.listScreenTimeSessionsOverlapping(
          this.ctx.agentId(),
          opts.since,
          opts.until,
          { source: "website" },
        );
      rows.push(...aggregateWebsiteSessions(websiteSessions, sinceMs, untilMs));
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

    const dailyRows = toDailyRows(this.ctx.agentId(), opts.date, rows);
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
    return buildScreenTimeSummary(rows, opts.topN);
  }

  async getScreenTimeBreakdown(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    topN?: number;
  }): Promise<ScreenTimeBreakdown> {
    const rows = await this.collectScreenTimeRows(opts);
    return buildScreenTimeBreakdown(rows, opts.topN);
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
        screenTimeDeviceLabel(row.device),
        row.totalSeconds,
      );
      addBucket(
        surfaceBuckets,
        row.source,
        screenTimeSourceLabel(row.source),
        row.totalSeconds,
      );
      addBucket(
        browserBuckets,
        row.browser?.toLowerCase(),
        row.browser,
        row.totalSeconds,
      );
    }

    const xDms = await this.ctx.repository.listXDms(this.ctx.agentId(), {
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
        this.deps.getBrowserSettings(),
        this.deps.listBrowserCompanions(),
        this.ctx.repository.listActivitySignals(this.ctx.agentId(), {
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
      totalSeconds: socialRows.reduce((sum, row) => sum + row.totalSeconds, 0),
      services: fullBreakdown.byService.slice(0, opts.topN ?? 8),
      devices: screenTimeBucketList(deviceBuckets),
      surfaces: screenTimeBucketList(surfaceBuckets),
      browsers: screenTimeBucketList(browserBuckets),
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
          detail: "macOS app focus events are included in screen-time totals.",
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
                ? "Browser tracking is enabled but permissions, recency, or pause state need attention."
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
    const [breakdown, social, priorBreakdown, priorSocial] = await Promise.all([
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
            enumerateScreenTimeHistoryDays(window).map(async (day) => {
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
      visible: buildScreenTimeVisibleBuckets(breakdown, social),
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
      items: buildScreenTimeWeeklyAverageItems(summary.items, daysInWindow),
      totalSeconds: summary.totalSeconds,
      daysInWindow,
    };
  }

  async aggregateDailyForDate(date: string): Promise<{ updated: number }> {
    return this.ctx.repository.aggregateScreenTimeDailyForDate(
      this.ctx.agentId(),
      date,
    );
  }
}
