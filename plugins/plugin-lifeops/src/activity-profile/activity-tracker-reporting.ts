/**
 * Reporting layer for T8d activity tracker.
 *
 * Converts the append-only `life_activity_events` stream into per-app dwell
 * summaries. New repository writes do not persist raw window titles; any
 * legacy titles are passed through {@link redactWindowTitle} before reporting.
 *
 * Duration model:
 *   - Events are sorted ascending by observed_at.
 *   - Each `activate` anchors a dwell interval; the interval ends at the
 *     timestamp of the NEXT event (activate or deactivate), or at `now`
 *     if no following event exists.
 *   - `deactivate` events do not anchor a new interval.
 *   - Intervals are clipped to the report window [since, until].
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type ActivityEventRow,
  listActivityEvents,
} from "./activity-tracker-repo.js";
import {
  type RedactorConfig,
  redactWindowTitle,
  resolveRedactorConfigFromEnv,
} from "./redactor.js";
import { isSystemInactivityApp } from "./system-inactivity-apps.js";

export interface ActivityAppBreakdown {
  bundleId: string;
  appName: string;
  totalMs: number;
  sessionCount: number;
  sampleWindowTitles: string[];
}

export interface ActivityReport {
  sinceMs: number;
  untilMs: number;
  totalMs: number;
  apps: ActivityAppBreakdown[];
}

export interface ActivityReportOptions {
  windowMs: number;
  nowMs?: number;
  limit?: number;
  redactor?: RedactorConfig;
}

interface DwellInterval {
  bundleId: string;
  appName: string;
  startMs: number;
  endMs: number;
  windowTitle: string | null;
}

function intervalsFromEvents(
  events: ActivityEventRow[],
  sinceMs: number,
  untilMs: number,
): DwellInterval[] {
  const intervals: DwellInterval[] = [];
  const timestamps: number[] = events.map((e) => Date.parse(e.observedAt));

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.eventKind !== "activate") continue;
    if (isSystemInactivityApp(ev)) continue;
    const startMs = timestamps[i];
    if (typeof startMs !== "number" || !Number.isFinite(startMs)) continue;
    const nextTs = i + 1 < events.length ? timestamps[i + 1] : untilMs;
    const endMs =
      typeof nextTs === "number" && Number.isFinite(nextTs) ? nextTs : untilMs;
    const clippedStart = Math.max(startMs, sinceMs);
    const clippedEnd = Math.min(endMs, untilMs);
    if (clippedEnd <= clippedStart) continue;
    intervals.push({
      bundleId: ev.bundleId,
      appName: ev.appName,
      startMs: clippedStart,
      endMs: clippedEnd,
      windowTitle: ev.windowTitle,
    });
  }
  return intervals;
}

function aggregateByApp(
  intervals: DwellInterval[],
  redactor: RedactorConfig,
  limit: number | undefined,
): { apps: ActivityAppBreakdown[]; totalMs: number } {
  const byKey = new Map<
    string,
    {
      bundleId: string;
      appName: string;
      totalMs: number;
      sessionCount: number;
      titles: Set<string>;
    }
  >();
  let totalMs = 0;
  for (const it of intervals) {
    const key = it.bundleId || it.appName;
    const durationMs = it.endMs - it.startMs;
    totalMs += durationMs;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        bundleId: it.bundleId,
        appName: it.appName,
        totalMs: 0,
        sessionCount: 0,
        titles: new Set<string>(),
      };
      byKey.set(key, bucket);
    }
    bucket.totalMs += durationMs;
    bucket.sessionCount += 1;
    const redacted = redactWindowTitle(it.windowTitle, redactor);
    if (redacted !== null && redacted.length > 0 && bucket.titles.size < 5) {
      bucket.titles.add(redacted);
    }
  }
  const apps = [...byKey.values()]
    .map((b) => ({
      bundleId: b.bundleId,
      appName: b.appName,
      totalMs: b.totalMs,
      sessionCount: b.sessionCount,
      sampleWindowTitles: [...b.titles],
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  return {
    apps: limit ? apps.slice(0, limit) : apps,
    totalMs,
  };
}

export async function getActivityReportBetween(
  runtime: IAgentRuntime,
  agentId: string,
  options: {
    sinceMs: number;
    untilMs: number;
    limit?: number;
    redactor?: RedactorConfig;
  },
): Promise<ActivityReport> {
  const sinceMs = Math.max(0, Math.trunc(options.sinceMs));
  const untilMs = Math.max(sinceMs, Math.trunc(options.untilMs));
  const redactor = options.redactor ?? resolveRedactorConfigFromEnv();
  const events = await listActivityEvents(
    runtime,
    agentId,
    new Date(sinceMs).toISOString(),
  );
  const intervals = intervalsFromEvents(events, sinceMs, untilMs);
  const { apps, totalMs } = aggregateByApp(intervals, redactor, options.limit);
  return { sinceMs, untilMs, totalMs, apps };
}

export async function getActivityReport(
  runtime: IAgentRuntime,
  agentId: string,
  options: ActivityReportOptions,
): Promise<ActivityReport> {
  const nowMs = options.nowMs ?? Date.now();
  return getActivityReportBetween(runtime, agentId, {
    sinceMs: nowMs - options.windowMs,
    untilMs: nowMs,
    limit: options.limit,
    redactor: options.redactor,
  });
}

export async function getTimeOnApp(
  runtime: IAgentRuntime,
  agentId: string,
  appNameOrBundleId: string,
  options: { windowMs: number; nowMs?: number; redactor?: RedactorConfig },
): Promise<{ totalMs: number; matchedBy: "bundleId" | "appName" | "none" }> {
  const needle = appNameOrBundleId.trim().toLowerCase();
  if (!needle) return { totalMs: 0, matchedBy: "none" };
  const report = await getActivityReport(runtime, agentId, {
    windowMs: options.windowMs,
    nowMs: options.nowMs,
    redactor: options.redactor,
  });
  let totalMs = 0;
  let matchedBy: "bundleId" | "appName" | "none" = "none";
  for (const app of report.apps) {
    if (app.bundleId.toLowerCase() === needle) {
      totalMs += app.totalMs;
      matchedBy = "bundleId";
    } else if (app.appName.toLowerCase() === needle) {
      totalMs += app.totalMs;
      if (matchedBy === "none") matchedBy = "appName";
    }
  }
  return { totalMs, matchedBy };
}
