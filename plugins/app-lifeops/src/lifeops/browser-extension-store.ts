/**
 * In-process store for browser-extension session registrations and the
 * recent per-domain focus reports they push.
 *
 * This is intentionally a simple runtime-scoped cache. The canonical
 * long-lived store is the LifeOps browser-session tables managed by
 * `service-mixin-browser.ts`; that mixin predates this task and has its
 * own `CreateLifeOpsBrowserSession` flow. Browser activity is short-window
 * telemetry, so the action layer keeps a bounded in-memory history here
 * and aggregates across that history on demand.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { evaluateProactiveBlockOnBrowserFocus } from "../website-blocker/proactive-block-bridge.js";

export interface BrowserSessionRegistration {
  readonly deviceId: string;
  readonly userAgent: string;
  readonly extensionVersion: string;
  readonly browserVendor: "chrome" | "safari" | "unknown";
  readonly registeredAt: string;
}

export interface DomainActivity {
  readonly domain: string;
  readonly focusMs: number;
  readonly sessionCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

export interface BrowserActivitySnapshot {
  readonly deviceId: string | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly domains: readonly DomainActivity[];
}

interface BrowserActivityReport extends BrowserActivitySnapshot {
  readonly deviceId: string;
  readonly generatedAt: string;
}

interface RuntimeStore {
  registrations: Map<string, BrowserSessionRegistration>;
  reports: BrowserActivityReport[];
}

const STORE_KEY = Symbol.for("lifeops.browser-extension.store");
const MAX_REPORT_HISTORY = 2_048;
const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function getStore(runtime: IAgentRuntime): RuntimeStore {
  const host = runtime as IAgentRuntime & Record<symbol, RuntimeStore>;
  const existing = host[STORE_KEY];
  if (existing) {
    return existing;
  }
  const created: RuntimeStore = { registrations: new Map(), reports: [] };
  host[STORE_KEY] = created;
  return created;
}

function parseIsoMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeReport(report: {
  deviceId: string;
  generatedAt?: string;
  windowStart: string;
  windowEnd: string;
  domains: readonly DomainActivity[];
}): BrowserActivityReport | null {
  const windowStartMs = parseIsoMs(report.windowStart);
  const windowEndMs = parseIsoMs(report.windowEnd);
  if (
    windowStartMs === null ||
    windowEndMs === null ||
    windowEndMs <= windowStartMs
  ) {
    return null;
  }
  return {
    deviceId: report.deviceId,
    generatedAt: report.generatedAt ?? new Date(windowEndMs).toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    domains: report.domains.map((domain) => ({
      ...domain,
      domain: domain.domain.trim().toLowerCase(),
    })),
  };
}

function trimReports(
  reports: BrowserActivityReport[],
): BrowserActivityReport[] {
  if (reports.length === 0) {
    return reports;
  }
  const newestEndMs =
    parseIsoMs(reports[reports.length - 1]?.windowEnd) ?? Date.now();
  const earliestAllowedMs = newestEndMs - MAX_REPORT_AGE_MS;
  const ageTrimmed = reports.filter((report) => {
    const reportEndMs = parseIsoMs(report.windowEnd);
    return reportEndMs !== null && reportEndMs >= earliestAllowedMs;
  });
  return ageTrimmed.slice(-MAX_REPORT_HISTORY);
}

function matchingReports(
  reports: readonly BrowserActivityReport[],
  deviceId?: string,
): BrowserActivityReport[] {
  if (!deviceId) {
    return [...reports];
  }
  return reports.filter((report) => report.deviceId === deviceId);
}

function domainsMatch(
  reportedDomain: string,
  requestedDomain: string,
): boolean {
  return (
    reportedDomain === requestedDomain ||
    reportedDomain.endsWith(`.${requestedDomain}`) ||
    requestedDomain.endsWith(`.${reportedDomain}`)
  );
}

function domainFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const hostname = parsed.hostname.trim().toLowerCase().replace(/\.+$/, "");
    return hostname || null;
  } catch {
    return null;
  }
}

export async function recordBrowserSessionRegistration(
  runtime: IAgentRuntime,
  registration: BrowserSessionRegistration,
): Promise<void> {
  const store = getStore(runtime);
  store.registrations.set(registration.deviceId, registration);
}

export async function recordBrowserActivityReport(
  runtime: IAgentRuntime,
  report: {
    deviceId: string;
    generatedAt?: string;
    windowStart: string;
    windowEnd: string;
    domains: readonly DomainActivity[];
  },
): Promise<void> {
  const store = getStore(runtime);
  const normalized = normalizeReport(report);
  if (!normalized) {
    return;
  }
  store.reports = trimReports([...store.reports, normalized]);
}

export async function recordBrowserFocusWindow(
  runtime: IAgentRuntime,
  args: {
    deviceId: string;
    url: string;
    windowStart: string;
    windowEnd: string;
  },
): Promise<boolean> {
  const domain = domainFromUrl(args.url);
  const windowStartMs = parseIsoMs(args.windowStart);
  const windowEndMs = parseIsoMs(args.windowEnd);
  if (
    !domain ||
    windowStartMs === null ||
    windowEndMs === null ||
    windowEndMs <= windowStartMs
  ) {
    return false;
  }
  await recordBrowserActivityReport(runtime, {
    deviceId: args.deviceId,
    generatedAt: new Date(windowEndMs).toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    domains: [
      {
        domain,
        focusMs: windowEndMs - windowStartMs,
        sessionCount: 1,
        firstObservedAt: new Date(windowStartMs).toISOString(),
        lastObservedAt: new Date(windowEndMs).toISOString(),
      },
    ],
  });
  await evaluateProactiveBlockOnBrowserFocus(runtime, {
    domain,
    deviceId: args.deviceId,
  });
  return true;
}

export async function getBrowserActivitySnapshot(
  runtime: IAgentRuntime,
  options: { deviceId?: string; limit: number },
): Promise<BrowserActivitySnapshot> {
  const store = getStore(runtime);
  const reports = matchingReports(store.reports, options.deviceId);
  const report = reports[reports.length - 1] ?? null;
  if (!report) {
    return {
      deviceId: options.deviceId ?? null,
      windowStart: new Date(0).toISOString(),
      windowEnd: new Date(0).toISOString(),
      domains: [],
    };
  }
  const sorted = [...report.domains].sort((a, b) => b.focusMs - a.focusMs);
  return {
    deviceId: report.deviceId,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    domains: sorted.slice(0, options.limit),
  };
}

export async function getBrowserDomainActivity(
  runtime: IAgentRuntime,
  options: {
    deviceId?: string;
    domain: string;
    sinceMs: number;
    untilMs: number;
  },
): Promise<{ totalMs: number; reportCount: number }> {
  const normalizedDomain = options.domain.trim().toLowerCase();
  if (!normalizedDomain || options.untilMs <= options.sinceMs) {
    return { totalMs: 0, reportCount: 0 };
  }

  const reports = matchingReports(
    getStore(runtime).reports,
    options.deviceId,
  ).filter((report) => {
    const reportStartMs = parseIsoMs(report.windowStart);
    const reportEndMs = parseIsoMs(report.windowEnd);
    return (
      reportStartMs !== null &&
      reportEndMs !== null &&
      reportEndMs > options.sinceMs &&
      reportStartMs < options.untilMs
    );
  });

  let totalMs = 0;
  for (const report of reports) {
    const reportStartMs = parseIsoMs(report.windowStart);
    const reportEndMs = parseIsoMs(report.windowEnd);
    if (reportStartMs === null || reportEndMs === null) {
      continue;
    }
    const overlapStartMs = Math.max(reportStartMs, options.sinceMs);
    const overlapEndMs = Math.min(reportEndMs, options.untilMs);
    const overlapMs = Math.max(0, overlapEndMs - overlapStartMs);
    const reportWindowMs = Math.max(1, reportEndMs - reportStartMs);
    if (overlapMs === 0) {
      continue;
    }
    const overlapRatio = overlapMs / reportWindowMs;

    for (const domain of report.domains) {
      if (domainsMatch(domain.domain, normalizedDomain)) {
        totalMs += domain.focusMs * overlapRatio;
      }
    }
  }

  return { totalMs: Math.round(totalMs), reportCount: reports.length };
}

export function getRegisteredSessions(
  runtime: IAgentRuntime,
): readonly BrowserSessionRegistration[] {
  return Array.from(getStore(runtime).registrations.values());
}
