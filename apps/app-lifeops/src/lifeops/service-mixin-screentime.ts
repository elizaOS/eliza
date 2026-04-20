// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import type {
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeSession,
} from "@elizaos/shared/contracts/lifeops";
import { getActivityReportBetween } from "../activity-profile/activity-tracker-reporting.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";

function isoNow(): string {
  return new Date().toISOString();
}

function computeDurationSeconds(
  startAt: string,
  endAt: string | null | undefined,
  provided: number | undefined,
): number {
  if (typeof provided === "number" && Number.isFinite(provided) && provided >= 0) {
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
  source: "app" | "website";
  identifier: string;
  displayName: string;
  totalSeconds: number;
  sessionCount: number;
  metadata?: Record<string, unknown>;
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

function buildWindowBounds(since: string, until: string): {
  sinceMs: number;
  untilMs: number;
} {
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) {
    fail(400, "since and until must be valid ISO strings with until > since");
  }
  return { sinceMs, untilMs };
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

function toSummaryItems(rows: ScreenTimeAggregateRow[], topN?: number): {
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

/** @internal */
export function withScreenTime<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsScreenTimeServiceMixin extends Base {
    async recordScreenTimeEvent(event: {
      source: "app" | "website";
      identifier: string;
      displayName: string;
      startAt: string;
      endAt?: string | null;
      durationSeconds?: number;
      metadata?: Record<string, unknown>;
    }): Promise<LifeOpsScreenTimeSession> {
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

    async getScreenTimeDaily(opts: {
      date: string;
      source?: "app" | "website";
      limit?: number;
    }): Promise<LifeOpsScreenTimeDaily[]> {
      const { startIso, endIso, startMs, endMs } = resolveUtcDateWindow(
        opts.date,
      );
      const rows: ScreenTimeAggregateRow[] = [];

      if (!opts.source || opts.source === "app") {
        const appReport = await getActivityReportBetween(
          this.runtime,
          this.agentId(),
          {
            sinceMs: startMs,
            untilMs: Math.min(endMs, Date.now()),
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
        const appSessions = await this.repository.listScreenTimeSessionsOverlapping(
          this.agentId(),
          startIso,
          endIso,
          { source: "app" },
        );
        rows.push(...aggregateWebsiteSessions(appSessions, startMs, endMs));
      }

      if (!opts.source || opts.source === "website") {
        const websiteSessions =
          await this.repository.listScreenTimeSessionsOverlapping(
            this.agentId(),
            startIso,
            endIso,
            { source: "website" },
          );
        rows.push(...aggregateWebsiteSessions(websiteSessions, startMs, endMs));
      }

      const dailyRows = toDailyRows(this.agentId(), opts.date, rows);
      return dailyRows.slice(0, opts.limit ?? dailyRows.length);
    }

    async getScreenTimeSummary(opts: {
      since: string;
      until: string;
      source?: "app" | "website";
      topN?: number;
    }): Promise<{
      items: Array<{
        source: "app" | "website";
        identifier: string;
        displayName: string;
        totalSeconds: number;
      }>;
      totalSeconds: number;
    }> {
      const { sinceMs, untilMs } = buildWindowBounds(opts.since, opts.until);
      const rows: ScreenTimeAggregateRow[] = [];

      if (!opts.source || opts.source === "app") {
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
        const appSessions = await this.repository.listScreenTimeSessionsOverlapping(
          this.agentId(),
          opts.since,
          opts.until,
          { source: "app" },
        );
        rows.push(...aggregateWebsiteSessions(appSessions, sinceMs, untilMs));
      }

      if (!opts.source || opts.source === "website") {
        const websiteSessions =
          await this.repository.listScreenTimeSessionsOverlapping(
            this.agentId(),
            opts.since,
            opts.until,
            { source: "website" },
          );
        rows.push(...aggregateWebsiteSessions(websiteSessions, sinceMs, untilMs));
      }

      return toSummaryItems(rows, opts.topN);
    }

    async aggregateDailyForDate(date: string): Promise<{ updated: number }> {
      return this.repository.aggregateScreenTimeDailyForDate(
        this.agentId(),
        date,
      );
    }
  }
  return LifeOpsScreenTimeServiceMixin;
}
