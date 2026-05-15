import { AsyncLocalStorage } from "node:async_hooks";

const MAX_EVENTS = 1_000;
const DEFAULT_SLOW_REQUEST_MS = 1_000;
const DEFAULT_SLOW_DB_MS = 250;
const DEFAULT_DB_BURST_COUNT = 20;

export interface CloudRequestTelemetry {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string | null;
  organizationId?: string | null;
  authMethod?: string | null;
  dbCalls: number;
  dbReadCalls: number;
  dbWriteCalls: number;
  duplicateDbReadCalls: number;
  duplicateReadKeys: Array<{ key: string; count: number }>;
  slowDbCalls: CloudDbTelemetry[];
  createdAt: string;
}

export interface CloudDbTelemetry {
  requestId?: string;
  operation: "read" | "write" | "transaction";
  label: string;
  durationMs: number;
  duplicateReadCount?: number;
  createdAt: string;
}

export interface CloudTelemetrySnapshot {
  generatedAt: string;
  thresholds: {
    slowRequestMs: number;
    slowDbMs: number;
    dbBurstCount: number;
  };
  requests: CloudRequestTelemetry[];
  slowRequests: CloudRequestTelemetry[];
  db: CloudDbTelemetry[];
  slowDb: CloudDbTelemetry[];
  burstyRequests: CloudRequestTelemetry[];
  duplicateReadRequests: CloudRequestTelemetry[];
}

interface RequestContext {
  id: string;
  method: string;
  path: string;
  startedAt: number;
  dbCalls: number;
  dbReadCalls: number;
  dbWriteCalls: number;
  duplicateDbReadCalls: number;
  readKeys: Map<string, number>;
  slowDbCalls: CloudDbTelemetry[];
}

const requestAls = new AsyncLocalStorage<RequestContext>();
const requests: CloudRequestTelemetry[] = [];
const dbEvents: CloudDbTelemetry[] = [];

function numberEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function thresholds() {
  return {
    slowRequestMs: numberEnv("CLOUD_SLOW_REQUEST_MS", DEFAULT_SLOW_REQUEST_MS),
    slowDbMs: numberEnv("CLOUD_SLOW_DB_MS", DEFAULT_SLOW_DB_MS),
    dbBurstCount: numberEnv("CLOUD_DB_BURST_COUNT", DEFAULT_DB_BURST_COUNT),
  };
}

function pushBounded<T>(list: T[], value: T): void {
  list.unshift(value);
  if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
}

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function readKey(label: string): string {
  return label.replace(/\s+/g, " ").trim().slice(0, 500) || "unlabeled-read";
}

export async function observeCloudRequest<T>(
  input: { id: string; method: string; path: string },
  fn: () => Promise<{
    result: T;
    status: number;
    userId?: string | null;
    organizationId?: string | null;
    authMethod?: string | null;
  }>,
): Promise<T> {
  const context: RequestContext = {
    ...input,
    startedAt: performance.now(),
    dbCalls: 0,
    dbReadCalls: 0,
    dbWriteCalls: 0,
    duplicateDbReadCalls: 0,
    readKeys: new Map(),
    slowDbCalls: [],
  };

  return requestAls.run(context, async () => {
    const response = await fn();
    const duplicateReadKeys = [...context.readKeys]
      .filter(([, count]) => count > 1)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    pushBounded(requests, {
      id: input.id,
      method: input.method,
      path: input.path,
      status: response.status,
      durationMs: elapsedMs(context.startedAt),
      userId: response.userId,
      organizationId: response.organizationId,
      authMethod: response.authMethod,
      dbCalls: context.dbCalls,
      dbReadCalls: context.dbReadCalls,
      dbWriteCalls: context.dbWriteCalls,
      duplicateDbReadCalls: context.duplicateDbReadCalls,
      duplicateReadKeys,
      slowDbCalls: context.slowDbCalls.slice(0, 20),
      createdAt: nowIso(),
    });

    return response.result;
  });
}

export async function observeDbOperation<T>(
  operation: CloudDbTelemetry["operation"],
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const context = requestAls.getStore();
  let duplicateReadCount: number | undefined;

  if (context) {
    context.dbCalls += 1;
    if (operation === "read") {
      context.dbReadCalls += 1;
      const key = readKey(label);
      const count = (context.readKeys.get(key) ?? 0) + 1;
      context.readKeys.set(key, count);
      if (count > 1) {
        duplicateReadCount = count;
        context.duplicateDbReadCalls += 1;
      }
    } else {
      context.dbWriteCalls += 1;
    }
  }

  try {
    return await fn();
  } finally {
    const event: CloudDbTelemetry = {
      requestId: context?.id,
      operation,
      label: readKey(label),
      durationMs: elapsedMs(startedAt),
      duplicateReadCount,
      createdAt: nowIso(),
    };
    pushBounded(dbEvents, event);
    if (event.durationMs >= thresholds().slowDbMs && context) {
      context.slowDbCalls.push(event);
    }
  }
}

export function getCloudTelemetrySnapshot(limit = 200): CloudTelemetrySnapshot {
  const t = thresholds();
  const req = requests.slice(0, limit);
  const db = dbEvents.slice(0, limit);
  return {
    generatedAt: nowIso(),
    thresholds: t,
    requests: req,
    slowRequests: req.filter((r) => r.durationMs >= t.slowRequestMs),
    db,
    slowDb: db.filter((r) => r.durationMs >= t.slowDbMs),
    burstyRequests: req.filter((r) => r.dbCalls >= t.dbBurstCount),
    duplicateReadRequests: req.filter((r) => r.duplicateDbReadCalls > 0),
  };
}

export function clearCloudTelemetry(): void {
  requests.length = 0;
  dbEvents.length = 0;
}
