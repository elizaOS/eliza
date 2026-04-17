/**
 * In-process store for browser-extension session registrations and the
 * latest per-domain focus reports they push (plan §6.13 — T8e).
 *
 * This is intentionally a simple runtime-scoped cache. The canonical
 * long-lived store is the LifeOps browser-session tables managed by
 * `service-mixin-browser.ts`; that mixin predates this task and has its
 * own `CreateLifeOpsBrowserSession` flow. The extension currently pushes
 * short-window focus reports into this cache and the FETCH action reads
 * them back. When the mixin's session model is extended to accept
 * per-domain focus reports, this cache becomes the adapter seam.
 */

import type { IAgentRuntime } from "@elizaos/core";

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

interface RuntimeStore {
  registrations: Map<string, BrowserSessionRegistration>;
  latestReport: {
    readonly deviceId: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly domains: readonly DomainActivity[];
  } | null;
}

const STORE_KEY = Symbol.for("lifeops.browser-extension.store");

function getStore(runtime: IAgentRuntime): RuntimeStore {
  const host = runtime as unknown as Record<symbol, RuntimeStore>;
  const existing = host[STORE_KEY];
  if (existing) {
    return existing;
  }
  const created: RuntimeStore = { registrations: new Map(), latestReport: null };
  host[STORE_KEY] = created;
  return created;
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
    windowStart: string;
    windowEnd: string;
    domains: readonly DomainActivity[];
  },
): Promise<void> {
  const store = getStore(runtime);
  store.latestReport = {
    deviceId: report.deviceId,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    domains: report.domains,
  };
}

export async function getBrowserActivitySnapshot(
  runtime: IAgentRuntime,
  options: { deviceId?: string; limit: number },
): Promise<BrowserActivitySnapshot> {
  const store = getStore(runtime);
  const report = store.latestReport;
  if (!report || (options.deviceId && options.deviceId !== report.deviceId)) {
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

export function getRegisteredSessions(
  runtime: IAgentRuntime,
): readonly BrowserSessionRegistration[] {
  return Array.from(getStore(runtime).registrations.values());
}
