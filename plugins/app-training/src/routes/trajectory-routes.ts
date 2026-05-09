/**
 * Trajectory API routes for the Eliza Control UI.
 *
 * Provides endpoints for:
 * - Listing and searching trajectories
 * - Viewing trajectory details with LLM calls and provider accesses
 * - Exporting trajectories to JSON, CSV, or ZIP
 * - Deleting trajectories
 * - Getting trajectory statistics
 * - Enabling/disabling trajectory logging
 *
 * Uses the native trajectories service for data access.
 */

import type http from "node:http";
import { readJsonBody as parseJsonBody, sendJson, sendJsonError } from "@elizaos/core";
import { createZipArchive } from "@elizaos/agent";
import {
  enrichTrajectoryLlmCall,
  executeRawSql,
  extractRows,
  type PersistedStep,
  type PersistedTrajectory,
  saveTrajectory,
} from "@elizaos/agent";
import type {
  Trajectory,
  TrajectoryExportFormat,
  TrajectoryExportOptions,
  TrajectoryExportResult,
  TrajectoryListItem,
  TrajectoryListOptions,
  TrajectoryListResult,
  TrajectoryLlmCall,
  TrajectoryStatus,
  TrajectoryStep,
} from "@elizaos/agent";
import {
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  type AgentRuntime,
} from "@elizaos/core";
import {
  listTrajectoryCallEntries,
} from "../core/trajectory-consumer.js";

export type { TrajectoryExportFormat };

interface TrajectoryLoggerApi {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  listTrajectories(
    options: TrajectoryListOptions,
  ): Promise<TrajectoryListResult>;
  getTrajectoryDetail(trajectoryId: string): Promise<Trajectory | null>;
  getStats(): Promise<unknown>;
  deleteTrajectories(trajectoryIds: string[]): Promise<number>;
  clearAllTrajectories(): Promise<number>;
  exportTrajectories(
    options: RouteTrajectoryExportOptions,
  ): Promise<TrajectoryExportResult>;
  exportTrajectoriesZip?: (
    options: TrajectoryZipExportOptions,
  ) => Promise<TrajectoryZipExportResult>;
}

type TrajectoryZipExportOptions = {
  includePrompts?: boolean;
  trajectoryIds?: string[];
  startDate?: string;
  endDate?: string;
  scenarioId?: string;
  batchId?: string;
};

type TrajectoryZipExportResult = {
  filename: string;
  entries: Array<{ name: string; data: string }>;
};

// UI Compatible Types

interface UITrajectoryRecord {
  id: string;
  agentId: string;
  roomId: string | null;
  entityId: string | null;
  conversationId: string | null;
  source: string;
  status: "active" | "completed" | "error";
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  llmCallCount: number;
  providerAccessCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  scenarioId?: string | null;
  batchId?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface UILlmCall {
  id: string;
  trajectoryId: string;
  stepId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  temperature: number;
  maxTokens: number;
  purpose: string;
  actionType: string;
  stepType: string;
  tags: string[];
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  timestamp: number;
  createdAt: string;
}

interface UIProviderAccess {
  id: string;
  trajectoryId: string;
  stepId: string;
  providerName: string;
  purpose: string;
  data: Record<string, unknown>;
  query?: Record<string, unknown>;
  timestamp: number;
  createdAt: string;
}

interface UITrajectoryDetailResult {
  trajectory: UITrajectoryRecord;
  llmCalls: UILlmCall[];
  providerAccesses: UIProviderAccess[];
  events?: UITrajectoryEvent[];
  contextEvents?: UIContextEvent[];
  toolEvents?: UINativeToolCallEvent[];
  evaluationEvents?: UIEvaluationEvent[];
  cacheObservations?: UICacheObservation[];
  cacheStats?: UICacheStats;
  contextDiffs?: UIContextDiff[];
}

type UIContextEvent = Record<string, unknown> & {
  id: string;
  type: string;
  createdAt?: number;
  source?: string;
  metadata?: Record<string, unknown>;
};

interface UITrajectoryEventBase {
  id: string;
  trajectoryId?: string;
  stepId?: string;
  stage?: string;
  timestamp?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

type UIToolCallStatus =
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

interface UINativeToolCallEvent extends UITrajectoryEventBase {
  type: "tool_call" | "tool_result" | "tool_error";
  callId?: string;
  toolCallId?: string;
  actionName?: string;
  toolName?: string;
  name?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  result?: unknown;
  output?: unknown;
  status?: UIToolCallStatus;
  success?: boolean;
  durationMs?: number;
  duration?: number;
  error?: string;
}

interface UIEvaluationEvent extends UITrajectoryEventBase {
  type: "evaluation" | "evaluator";
  evaluatorName?: string;
  name?: string;
  status?: UIToolCallStatus;
  success?: boolean;
  decision?: string;
  thought?: string;
  result?: unknown;
  durationMs?: number;
  error?: string;
}

interface UICacheObservation extends UITrajectoryEventBase {
  type: "cache_observation" | "cache";
  cacheName?: string;
  key?: string;
  scope?: string;
  hit: boolean;
  reason?: string;
  ttlMs?: number;
  ageMs?: number;
  sizeBytes?: number;
  tokenCount?: number;
}

interface UIContextDiffChange {
  type: string;
  path?: string;
  before?: unknown;
  after?: unknown;
  summary?: string;
  tokenDelta?: number;
}

interface UIContextDiff extends UITrajectoryEventBase {
  type: "context_diff";
  label?: string;
  beforeContextId?: string;
  afterContextId?: string;
  added?: number;
  removed?: number;
  changed?: number;
  tokenDelta?: number;
  changes?: UIContextDiffChange[];
  before?: unknown;
  after?: unknown;
}

type UITrajectoryEvent =
  | UINativeToolCallEvent
  | UIEvaluationEvent
  | UICacheObservation
  | UIContextDiff
  | (UITrajectoryEventBase & { type: string; [key: string]: unknown });

interface UICacheStats {
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
  tokenCount?: number;
  sizeBytes?: number;
}

type RouteTrajectoryJsonShape = typeof ELIZA_NATIVE_TRAJECTORY_FORMAT;

type RouteTrajectoryExportOptions = Omit<
  TrajectoryExportOptions,
  "jsonShape"
> & {
  jsonShape?: RouteTrajectoryJsonShape;
};

// ============================================================================
// Helpers
// ============================================================================

function isRouteCompatibleTrajectoryLogger(
  candidate: unknown,
): candidate is TrajectoryLoggerApi {
  if (!candidate || typeof candidate !== "object") return false;
  const logger = candidate as Partial<TrajectoryLoggerApi>;

  return (
    typeof logger.isEnabled === "function" &&
    typeof logger.setEnabled === "function" &&
    typeof logger.listTrajectories === "function" &&
    typeof logger.getTrajectoryDetail === "function" &&
    typeof logger.getStats === "function" &&
    typeof logger.deleteTrajectories === "function" &&
    typeof logger.clearAllTrajectories === "function" &&
    typeof logger.exportTrajectories === "function"
  );
}

type TrajectoryLoggerRuntimeLike = AgentRuntime & {
  getServicesByType?: (serviceType: string) => unknown;
  getService?: (serviceType: string) => unknown;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  getServiceRegistrationStatus?: (
    serviceType: string,
  ) => "pending" | "registering" | "registered" | "failed" | "unknown";
};

function collectCandidates(
  runtimeLike: TrajectoryLoggerRuntimeLike,
): unknown[] {
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];
  const add = (candidate: unknown): void => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  if (typeof runtimeLike.getServicesByType === "function") {
    const byType = runtimeLike.getServicesByType("trajectories");
    if (Array.isArray(byType)) {
      for (const candidate of byType) {
        add(candidate);
      }
    } else {
      add(byType);
    }
  }

  if (typeof runtimeLike.getService === "function") {
    add(runtimeLike.getService("trajectories"));
  }

  return candidates;
}

function findCompatibleLogger(
  candidates: unknown[],
): TrajectoryLoggerApi | null {
  for (const candidate of candidates) {
    if (isRouteCompatibleTrajectoryLogger(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function getTrajectoryLogger(
  runtime: AgentRuntime,
): Promise<TrajectoryLoggerApi | null> {
  const runtimeLike = runtime as TrajectoryLoggerRuntimeLike;

  // Fast path: service already available.
  const immediate = findCompatibleLogger(collectCandidates(runtimeLike));
  if (immediate) return immediate;

  // The service may still be starting — wait for it if the runtime supports it.
  const status =
    typeof runtimeLike.getServiceRegistrationStatus === "function"
      ? runtimeLike.getServiceRegistrationStatus("trajectories")
      : "unknown";

  if (
    (status === "pending" || status === "registering") &&
    typeof runtimeLike.getServiceLoadPromise === "function"
  ) {
    try {
      await Promise.race([
        runtimeLike.getServiceLoadPromise("trajectories"),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // Service failed to start — fall through to return null.
    }

    // Re-check after waiting.
    return findCompatibleLogger(collectCandidates(runtimeLike));
  }

  return null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toCacheHit(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "hit" || normalized === "true") return true;
    if (normalized === "miss" || normalized === "false") return false;
  }
  return null;
}

function toToolCallStatus(value: unknown): UIToolCallStatus | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "queued" ||
    normalized === "running" ||
    normalized === "completed" ||
    normalized === "skipped" ||
    normalized === "failed"
    ? normalized
    : undefined;
}

function normalizeCreatedAt(
  value: unknown,
  timestamp?: number,
): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return undefined;
}

function timestampFromRecord(
  record: Record<string, unknown>,
): number | undefined {
  const timestamp = toFiniteNumber(record.timestamp);
  if (timestamp !== null) return timestamp;

  const createdAt = toFiniteNumber(record.createdAt);
  if (createdAt !== null) return createdAt;

  if (typeof record.createdAt === "string") {
    const parsed = Date.parse(record.createdAt);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function eventBaseFromRecord(
  record: Record<string, unknown>,
  trajectoryId: string,
  fallbackId: string,
): UITrajectoryEventBase {
  const timestamp = timestampFromRecord(record);
  return {
    id: toOptionalString(record.id) ?? fallbackId,
    trajectoryId,
    stepId: toOptionalString(record.stepId),
    stage: toOptionalString(record.stage),
    timestamp,
    createdAt: normalizeCreatedAt(record.createdAt, timestamp),
    metadata: asRecord(record.metadata) ?? undefined,
  };
}

function normalizeContextEvent(
  event: unknown,
  index: number,
): UIContextEvent | null {
  const record = asRecord(event);
  const type = toOptionalString(record?.type);
  if (!record || !type) return null;
  return {
    ...record,
    id: toOptionalString(record.id) ?? `context-event-${index}`,
    type,
    metadata: asRecord(record.metadata) ?? undefined,
  } as UIContextEvent;
}

function hasV5ContextEvents(traj: Trajectory): boolean {
  const record = asRecord(traj);
  const metadata = asRecord(traj.metadata);
  return Boolean(
    asRecord(record?.contextObject) ||
      asRecord(metadata?.contextObject) ||
      Array.isArray(record?.contextEvents) ||
      Array.isArray(metadata?.contextEvents) ||
      record?.contextObjectVersion === 5,
  );
}

function readContextEventsFromObject(value: unknown): unknown[] | null {
  const record = asRecord(value);
  return Array.isArray(record?.events) ? record.events : null;
}

function extractContextEventsForRoute(traj: Trajectory): unknown[] {
  const record = asRecord(traj);
  const metadata = asRecord(traj.metadata);

  return (
    readContextEventsFromObject(record?.contextObject) ??
    readContextEventsFromObject(metadata?.contextObject) ??
    (Array.isArray(record?.contextEvents) ? record.contextEvents : null) ??
    (Array.isArray(metadata?.contextEvents) ? metadata.contextEvents : null) ??
    (record?.contextObjectVersion === 5 && Array.isArray(record.events)
      ? record.events
      : null) ??
    []
  );
}

function readRecordArray(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown>[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(asRecord(item)),
  );
}

function normalizeToolEvent(
  record: Record<string, unknown>,
  trajectoryId: string,
  fallbackId: string,
): UINativeToolCallEvent | null {
  const type = toOptionalString(record.type);
  if (type !== "tool_call" && type !== "tool_result" && type !== "tool_error") {
    return null;
  }
  const tool = asRecord(record.tool);
  return {
    ...eventBaseFromRecord(record, trajectoryId, fallbackId),
    type,
    callId: toOptionalString(record.callId),
    toolCallId: toOptionalString(record.toolCallId),
    actionName: toOptionalString(record.actionName),
    toolName: toOptionalString(record.toolName) ?? toOptionalString(tool?.name),
    name: toOptionalString(record.name),
    args: asRecord(record.args) ?? undefined,
    input: asRecord(record.input) ?? undefined,
    result: record.result,
    output: record.output,
    status: toToolCallStatus(record.status),
    success: toOptionalBoolean(record.success),
    durationMs: toFiniteNumber(record.durationMs) ?? undefined,
    duration: toFiniteNumber(record.duration) ?? undefined,
    error: toOptionalString(record.error),
  };
}

function normalizeEvaluationEvent(
  record: Record<string, unknown>,
  trajectoryId: string,
  fallbackId: string,
): UIEvaluationEvent | null {
  const type = toOptionalString(record.type);
  if (type !== "evaluation" && type !== "evaluator") return null;
  return {
    ...eventBaseFromRecord(record, trajectoryId, fallbackId),
    type,
    evaluatorName: toOptionalString(record.evaluatorName),
    name: toOptionalString(record.name),
    status: toToolCallStatus(record.status),
    success: toOptionalBoolean(record.success),
    decision: toOptionalString(record.decision),
    thought: toOptionalString(record.thought),
    result: record.result,
    durationMs: toFiniteNumber(record.durationMs) ?? undefined,
    error: toOptionalString(record.error),
  };
}

function normalizeCacheObservation(
  record: Record<string, unknown>,
  trajectoryId: string,
  fallbackId: string,
): UICacheObservation | null {
  const type = toOptionalString(record.type);
  if (type !== "cache_observation" && type !== "cache") return null;
  const hit =
    toCacheHit(record.hit) ??
    toCacheHit(record.cacheHit) ??
    toCacheHit(record.result) ??
    toCacheHit(record.status);
  if (hit === null) return null;
  return {
    ...eventBaseFromRecord(record, trajectoryId, fallbackId),
    type,
    cacheName:
      toOptionalString(record.cacheName) ?? toOptionalString(record.name),
    key: toOptionalString(record.key),
    scope: toOptionalString(record.scope),
    hit,
    reason: toOptionalString(record.reason),
    ttlMs: toFiniteNumber(record.ttlMs) ?? undefined,
    ageMs: toFiniteNumber(record.ageMs) ?? undefined,
    sizeBytes: toFiniteNumber(record.sizeBytes) ?? undefined,
    tokenCount:
      toFiniteNumber(record.tokenCount) ??
      toFiniteNumber(record.cachedInputTokens) ??
      toFiniteNumber(record.cacheReadInputTokens) ??
      undefined,
  };
}

function normalizeContextDiffChange(
  value: unknown,
): UIContextDiffChange | null {
  const record = asRecord(value);
  const type = toOptionalString(record?.type);
  if (!record || !type) return null;
  return {
    type,
    path: toOptionalString(record.path) ?? toOptionalString(record.key),
    before: record.before ?? record.previous,
    after: record.after ?? record.current,
    summary: toOptionalString(record.summary),
    tokenDelta: toFiniteNumber(record.tokenDelta) ?? undefined,
  };
}

function normalizeContextDiff(
  record: Record<string, unknown>,
  trajectoryId: string,
  fallbackId: string,
): UIContextDiff | null {
  if (toOptionalString(record.type) !== "context_diff") return null;
  const summary = asRecord(record.summary);
  const changes = Array.isArray(record.changes)
    ? record.changes
        .map((change) => normalizeContextDiffChange(change))
        .filter((change): change is UIContextDiffChange => change !== null)
    : undefined;
  return {
    ...eventBaseFromRecord(record, trajectoryId, fallbackId),
    type: "context_diff",
    label: toOptionalString(record.label),
    beforeContextId: toOptionalString(record.beforeContextId),
    afterContextId: toOptionalString(record.afterContextId),
    added:
      toFiniteNumber(record.added) ??
      toFiniteNumber(summary?.added) ??
      undefined,
    removed:
      toFiniteNumber(record.removed) ??
      toFiniteNumber(summary?.removed) ??
      undefined,
    changed:
      toFiniteNumber(record.changed) ??
      toFiniteNumber(summary?.changed) ??
      undefined,
    tokenDelta:
      toFiniteNumber(record.tokenDelta) ??
      toFiniteNumber(summary?.tokenDelta) ??
      undefined,
    changes,
    before: record.before,
    after: record.after,
  };
}

function normalizeTrajectoryEvent(
  record: Record<string, unknown>,
  trajectoryId: string,
  fallbackId: string,
): UITrajectoryEvent | null {
  const specialized =
    normalizeToolEvent(record, trajectoryId, fallbackId) ??
    normalizeEvaluationEvent(record, trajectoryId, fallbackId) ??
    normalizeCacheObservation(record, trajectoryId, fallbackId) ??
    normalizeContextDiff(record, trajectoryId, fallbackId);
  if (specialized) return specialized;

  const type = toOptionalString(record.type);
  if (!type) return null;
  return {
    ...record,
    ...eventBaseFromRecord(record, trajectoryId, fallbackId),
    type,
  } as UITrajectoryEvent;
}

function normalizeCacheStats(value: unknown): UICacheStats | null {
  const record = asRecord(value);
  if (!record) return null;
  const hits = toFiniteNumber(record.hits);
  const misses = toFiniteNumber(record.misses);
  const total = toFiniteNumber(record.total);
  if (hits === null || misses === null || total === null) return null;
  return {
    hits,
    misses,
    total,
    hitRate: toFiniteNumber(record.hitRate) ?? hits / Math.max(total, 1),
    tokenCount: toFiniteNumber(record.tokenCount) ?? undefined,
    sizeBytes: toFiniteNumber(record.sizeBytes) ?? undefined,
  };
}

function cacheStatsFromObservations(
  observations: UICacheObservation[],
): UICacheStats | undefined {
  if (observations.length === 0) return undefined;
  const hits = observations.filter((observation) => observation.hit).length;
  const total = observations.length;
  const tokenCount = observations.reduce(
    (sum, observation) => sum + (observation.tokenCount ?? 0),
    0,
  );
  const sizeBytes = observations.reduce(
    (sum, observation) => sum + (observation.sizeBytes ?? 0),
    0,
  );
  return {
    hits,
    misses: total - hits,
    total,
    hitRate: hits / Math.max(total, 1),
    ...(tokenCount > 0 ? { tokenCount } : {}),
    ...(sizeBytes > 0 ? { sizeBytes } : {}),
  };
}

function contextEventToTrajectoryEvent(
  event: UIContextEvent,
  trajectoryId: string,
  index: number,
): UITrajectoryEvent {
  const { createdAt: _createdAt, ...eventWithoutCreatedAt } = event;
  const stage =
    event.type === "tool"
      ? "actions"
      : event.type === "cache"
        ? "cache"
        : "context";
  const base = eventBaseFromRecord(
    { ...event, stage: event.stage ?? stage },
    trajectoryId,
    `context-event-${index}`,
  );
  return {
    ...eventWithoutCreatedAt,
    ...base,
    createdAt: base.createdAt,
    type: event.type,
  } as UITrajectoryEvent;
}

function embeddedEventRecordsFromContextEvent(
  event: UIContextEvent,
): Record<string, unknown>[] {
  const metadata = asRecord(event.metadata);
  const value = event.type === "metadata" ? asRecord(event.value) : null;
  return [
    asRecord(event.event),
    asRecord(event.trajectoryEvent),
    asRecord(event.toolEvent),
    asRecord(event.cacheObservation),
    asRecord(event.contextDiff),
    asRecord(metadata?.event),
    asRecord(metadata?.trajectoryEvent),
    asRecord(metadata?.toolEvent),
    asRecord(metadata?.cacheObservation),
    asRecord(metadata?.contextDiff),
    value && toOptionalString(event.key) === "toolEvent"
      ? { ...value, type: value.type ?? "tool_call" }
      : null,
    value && toOptionalString(event.key) === "cacheObservation"
      ? { ...value, type: value.type ?? "cache_observation" }
      : null,
    value && toOptionalString(event.key) === "contextDiff"
      ? { ...value, type: value.type ?? "context_diff" }
      : null,
  ].filter((record): record is Record<string, unknown> => record !== null);
}

function cacheStatsFromContextEvents(
  events: UIContextEvent[],
): UICacheStats | null {
  for (const event of events) {
    if (
      event.type === "metadata" &&
      (event.key === "cacheStats" || event.key === "cache_stats")
    ) {
      const stats = normalizeCacheStats(event.value);
      if (stats) return stats;
    }
    const metadata = asRecord(event.metadata);
    const stats = normalizeCacheStats(metadata?.cacheStats);
    if (stats) return stats;
  }
  return null;
}

function dedupeTrajectoryEvents<T extends { id?: string; type?: string }>(
  events: T[],
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const [index, event] of events.entries()) {
    const key = `${event.type ?? "event"}:${event.id ?? index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function buildUIEventFields(
  traj: Trajectory,
  trajectoryId: string,
): Omit<
  UITrajectoryDetailResult,
  "trajectory" | "llmCalls" | "providerAccesses"
> {
  const root = asRecord(traj);
  const metadata = asRecord(traj.metadata);
  const contextEvents = hasV5ContextEvents(traj)
    ? extractContextEventsForRoute(traj)
        .map((event, index) => normalizeContextEvent(event, index))
        .filter((event): event is UIContextEvent => event !== null)
    : [];

  const explicitRecords = [
    ...readRecordArray(root, "events"),
    ...readRecordArray(metadata, "events"),
    ...readRecordArray(metadata, "trajectoryEvents"),
    ...contextEvents,
    ...contextEvents.flatMap(embeddedEventRecordsFromContextEvent),
  ];

  const toolEvents = dedupeTrajectoryEvents(
    [
      ...readRecordArray(root, "toolEvents"),
      ...readRecordArray(metadata, "toolEvents"),
      ...explicitRecords,
    ]
      .map((record, index) =>
        normalizeToolEvent(record, trajectoryId, `tool-event-${index}`),
      )
      .filter((event): event is UINativeToolCallEvent => event !== null),
  );

  const evaluationEvents = dedupeTrajectoryEvents(
    [
      ...readRecordArray(root, "evaluationEvents"),
      ...readRecordArray(metadata, "evaluationEvents"),
      ...explicitRecords,
    ]
      .map((record, index) =>
        normalizeEvaluationEvent(
          record,
          trajectoryId,
          `evaluation-event-${index}`,
        ),
      )
      .filter((event): event is UIEvaluationEvent => event !== null),
  );

  const cacheObservations = dedupeTrajectoryEvents(
    [
      ...readRecordArray(root, "cacheObservations"),
      ...readRecordArray(metadata, "cacheObservations"),
      ...explicitRecords,
    ]
      .map((record, index) =>
        normalizeCacheObservation(
          record,
          trajectoryId,
          `cache-observation-${index}`,
        ),
      )
      .filter((event): event is UICacheObservation => event !== null),
  );

  const contextDiffs = dedupeTrajectoryEvents(
    [
      ...readRecordArray(root, "contextDiffs"),
      ...readRecordArray(metadata, "contextDiffs"),
      ...explicitRecords,
    ]
      .map((record, index) =>
        normalizeContextDiff(record, trajectoryId, `context-diff-${index}`),
      )
      .filter((event): event is UIContextDiff => event !== null),
  );

  const events = dedupeTrajectoryEvents([
    ...explicitRecords
      .map((record, index) =>
        normalizeTrajectoryEvent(record, trajectoryId, `event-${index}`),
      )
      .filter((event): event is UITrajectoryEvent => event !== null),
    ...contextEvents.map((event, index) =>
      contextEventToTrajectoryEvent(event, trajectoryId, index),
    ),
    ...toolEvents,
    ...evaluationEvents,
    ...cacheObservations,
    ...contextDiffs,
  ]);

  const cacheStats =
    normalizeCacheStats(root?.cacheStats) ??
    normalizeCacheStats(metadata?.cacheStats) ??
    cacheStatsFromContextEvents(contextEvents) ??
    cacheStatsFromObservations(cacheObservations);

  return {
    ...(events.length > 0 ? { events } : {}),
    ...(contextEvents.length > 0 ? { contextEvents } : {}),
    ...(toolEvents.length > 0 ? { toolEvents } : {}),
    ...(evaluationEvents.length > 0 ? { evaluationEvents } : {}),
    ...(cacheObservations.length > 0 ? { cacheObservations } : {}),
    ...(cacheStats ? { cacheStats } : {}),
    ...(contextDiffs.length > 0 ? { contextDiffs } : {}),
  };
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildDisplayMetadata(traj: Trajectory): Record<string, unknown> {
  const metadata = { ...(asRecord(traj.metadata) ?? {}) };
  const calls = listTrajectoryCallEntries(traj).map((entry) => entry.call);
  if (
    calls.length > 0 &&
    !calls.every((call) => isSyntheticTrajectoryCall(call))
  ) {
    delete metadata.syntheticLlmCall;
    delete metadata.syntheticLlmCallSource;
  }
  return metadata;
}

function normalizePersistedStatus(value: unknown): TrajectoryStatus {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "active" ||
    normalized === "completed" ||
    normalized === "error" ||
    normalized === "timeout"
  ) {
    return normalized;
  }
  return normalized.length > 0 ? "completed" : "active";
}

function toPersistedTrajectory(traj: Trajectory): PersistedTrajectory {
  const metadata = buildDisplayMetadata(traj);
  const status = normalizePersistedStatus(
    traj.metrics?.finalStatus ??
      (typeof traj.endTime === "number" ? "completed" : "active"),
  );
  const persistedSteps: PersistedStep[] = (traj.steps ?? []).map(
    (step, index) => ({
      stepId:
        typeof step.stepId === "string" && step.stepId.trim().length > 0
          ? step.stepId.trim()
          : `${traj.trajectoryId}-step-${index + 1}`,
      stepNumber: index,
      timestamp:
        typeof step.timestamp === "number" && Number.isFinite(step.timestamp)
          ? step.timestamp
          : traj.startTime,
      llmCalls: (step.llmCalls ?? []).map((call, callIndex) => {
        const normalizedCall = enrichTrajectoryLlmCall(
          call as Record<string, unknown>,
        ) as unknown as TrajectoryLlmCall;
        return {
          callId:
            typeof normalizedCall.callId === "string" &&
            normalizedCall.callId.trim().length > 0
              ? normalizedCall.callId.trim()
              : `${traj.trajectoryId}-call-${index + 1}-${callIndex + 1}`,
          timestamp:
            typeof normalizedCall.timestamp === "number" &&
            Number.isFinite(normalizedCall.timestamp)
              ? normalizedCall.timestamp
              : step.timestamp,
          model:
            typeof normalizedCall.model === "string"
              ? normalizedCall.model
              : "unknown",
          systemPrompt:
            typeof normalizedCall.systemPrompt === "string"
              ? normalizedCall.systemPrompt
              : "",
          userPrompt:
            typeof normalizedCall.userPrompt === "string"
              ? normalizedCall.userPrompt
              : "",
          response:
            typeof normalizedCall.response === "string"
              ? normalizedCall.response
              : "",
          temperature: toFiniteNumber(normalizedCall.temperature) ?? 0,
          maxTokens: toFiniteNumber(normalizedCall.maxTokens) ?? 0,
          purpose:
            typeof normalizedCall.purpose === "string"
              ? normalizedCall.purpose
              : "",
          actionType:
            typeof normalizedCall.actionType === "string"
              ? normalizedCall.actionType
              : "",
          stepType:
            typeof normalizedCall.stepType === "string"
              ? normalizedCall.stepType
              : undefined,
          tags: Array.isArray(normalizedCall.tags)
            ? normalizedCall.tags.filter(
                (tag): tag is string => typeof tag === "string",
              )
            : undefined,
          latencyMs: toFiniteNumber(normalizedCall.latencyMs) ?? 0,
          promptTokens:
            toFiniteNumber(normalizedCall.promptTokens) ?? undefined,
          completionTokens:
            toFiniteNumber(normalizedCall.completionTokens) ?? undefined,
        };
      }),
      providerAccesses: (step.providerAccesses ?? []).map(
        (access, accessIndex) => ({
          providerId:
            typeof access.providerId === "string" &&
            access.providerId.trim().length > 0
              ? access.providerId.trim()
              : `${traj.trajectoryId}-provider-${index + 1}-${accessIndex + 1}`,
          providerName:
            typeof access.providerName === "string"
              ? access.providerName
              : "unknown",
          timestamp:
            typeof access.timestamp === "number" &&
            Number.isFinite(access.timestamp)
              ? access.timestamp
              : step.timestamp,
          data: asRecord(access.data) ?? {},
          query: asRecord(access.query) ?? undefined,
          purpose: typeof access.purpose === "string" ? access.purpose : "",
        }),
      ),
    }),
  );

  return {
    id: traj.trajectoryId,
    source: toNullableString(metadata.source) ?? "runtime",
    status,
    startTime: traj.startTime,
    endTime: typeof traj.endTime === "number" ? traj.endTime : null,
    scenarioId:
      typeof traj.scenarioId === "string" ? traj.scenarioId : undefined,
    batchId: typeof traj.batchId === "string" ? traj.batchId : undefined,
    steps: persistedSteps,
    metadata,
    totalReward: 0,
    createdAt: new Date(traj.startTime).toISOString(),
    updatedAt: new Date(
      typeof traj.endTime === "number" ? traj.endTime : Date.now(),
    ).toISOString(),
  };
}

function listItemToUIRecord(item: TrajectoryListItem): UITrajectoryRecord {
  const status =
    item.status === "timeout" || item.status === "error"
      ? "error"
      : item.status;
  return {
    id: item.id,
    agentId: item.agentId,
    roomId: null,
    entityId: null,
    conversationId: null,
    source: item.source,
    status: status as "active" | "completed" | "error",
    startTime: item.startTime,
    endTime: item.endTime,
    durationMs: item.durationMs,
    llmCallCount: item.llmCallCount,
    providerAccessCount: item.providerAccessCount,
    totalPromptTokens: item.totalPromptTokens,
    totalCompletionTokens: item.totalCompletionTokens,
    ...(item.scenarioId ? { scenarioId: item.scenarioId } : {}),
    ...(item.batchId ? { batchId: item.batchId } : {}),
    metadata: {
      ...(item.metadata ?? {}),
      ...(item.scenarioId ? { scenarioId: item.scenarioId } : {}),
      ...(item.batchId ? { batchId: item.batchId } : {}),
    },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt ?? item.createdAt,
  };
}

function trajectoryToUIDetail(traj: Trajectory): UITrajectoryDetailResult {
  const finalStatus = (traj.metrics?.finalStatus as string) ?? "completed";
  const normalizedEndTime =
    typeof traj.endTime === "number" && traj.endTime > 0 ? traj.endTime : null;
  const status: "active" | "completed" | "error" =
    finalStatus === "timeout" ||
    finalStatus === "terminated" ||
    finalStatus === "error"
      ? "error"
      : finalStatus === "completed"
        ? "completed"
        : normalizedEndTime
          ? "completed"
          : "active";

  const llmCalls: UILlmCall[] = [];
  const providerAccesses: UIProviderAccess[] = [];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  const trajectoryId = String(traj.trajectoryId);
  for (const entry of listTrajectoryCallEntries(traj)) {
    const call = enrichTrajectoryLlmCall(
      entry.call as Record<string, unknown>,
    ) as unknown as TrajectoryLlmCall;
    llmCalls.push({
      id: call.callId || `${entry.stepId}-call-${entry.callIndex}`,
      trajectoryId,
      stepId: entry.stepId,
      model: call.model || "unknown",
      systemPrompt: call.systemPrompt || "",
      userPrompt: call.userPrompt || "",
      response: call.response || "",
      temperature: typeof call.temperature === "number" ? call.temperature : 0,
      maxTokens: typeof call.maxTokens === "number" ? call.maxTokens : 0,
      purpose: call.purpose || "",
      actionType: call.actionType || "",
      stepType: call.stepType || "",
      tags: Array.isArray(call.tags)
        ? call.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      latencyMs: call.latencyMs || 0,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      timestamp: call.timestamp || entry.step.timestamp,
      createdAt: new Date(
        call.timestamp || entry.step.timestamp,
      ).toISOString(),
    });
    totalPromptTokens += call.promptTokens || 0;
    totalCompletionTokens += call.completionTokens || 0;
  }

  for (let i = 0; i < (traj.steps || []).length; i++) {
    const step = traj.steps?.[i];
    if (!step) continue;
    const stepId = typeof step.stepId === "string" ? step.stepId : `step-${i}`;
    const providerAccessList = step.providerAccesses ?? [];
    for (let k = 0; k < providerAccessList.length; k++) {
      const access = providerAccessList[k];
      providerAccesses.push({
        id: access.providerId || `${stepId}-provider-${k}`,
        trajectoryId,
        stepId,
        providerName: access.providerName || "unknown",
        purpose: access.purpose || "",
        data: access.data || {},
        query: access.query,
        timestamp: access.timestamp || step.timestamp,
        createdAt: new Date(access.timestamp || step.timestamp).toISOString(),
      });
    }
  }

  const metadata = buildDisplayMetadata(traj);
  const normalizedDurationMs =
    status === "active"
      ? null
      : typeof traj.durationMs === "number"
        ? traj.durationMs
        : null;
  const updatedAtMs = normalizedEndTime ?? (traj.startTime || Date.now());

  const trajectory: UITrajectoryRecord = {
    id: trajectoryId,
    agentId: String(traj.agentId),
    roomId: toNullableString(metadata.roomId),
    entityId: toNullableString(metadata.entityId),
    conversationId: toNullableString(metadata.conversationId),
    source: toNullableString(metadata.source) ?? "chat",
    status,
    startTime: traj.startTime,
    endTime: normalizedEndTime,
    durationMs: normalizedDurationMs,
    llmCallCount: llmCalls.length,
    providerAccessCount: providerAccesses.length,
    totalPromptTokens,
    totalCompletionTokens,
    metadata,
    createdAt: new Date(traj.startTime).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
  };

  return {
    trajectory,
    llmCalls,
    providerAccesses,
    ...buildUIEventFields(traj, trajectoryId),
  };
}

function isSyntheticTrajectoryCall(call: TrajectoryLlmCall): boolean {
  const model = String(call.model ?? "").toLowerCase();
  const systemPrompt = String(call.systemPrompt ?? "").toLowerCase();
  const response = String(call.response ?? "").toLowerCase();

  return (
    model.includes("synthetic") ||
    systemPrompt.includes("[synthetic]") ||
    response.includes("placeholder call inserted")
  );
}

function needsConversationBackfill(traj: Trajectory): boolean {
  const calls = listTrajectoryCallEntries(traj).map((entry) => entry.call);
  if (calls.length === 0) {
    return true;
  }
  return calls.every((call) => isSyntheticTrajectoryCall(call));
}

function extractMessageText(memory: unknown): string {
  if (!memory || typeof memory !== "object") return "";
  const content = (memory as { content?: { text?: unknown } }).content;
  return typeof content?.text === "string" ? content.text.trim() : "";
}

function isTextGenerationLogRow(
  type: string,
  body: Record<string, unknown>,
): boolean {
  if (!type.startsWith("useModel:")) return false;
  const modelType =
    typeof body.modelType === "string" && body.modelType.trim().length > 0
      ? body.modelType.trim().toUpperCase()
      : type.slice("useModel:".length).trim().toUpperCase();
  return (
    modelType === "TEXT_SMALL" ||
    modelType === "TEXT_LARGE" ||
    modelType === "TEXT_COMPLETION" ||
    modelType === "REASONING_SMALL" ||
    modelType === "REASONING_LARGE"
  );
}

async function maybeBackfillTrajectoryFromUseModelLogs(
  runtime: AgentRuntime,
  traj: Trajectory,
): Promise<Trajectory> {
  if (!needsConversationBackfill(traj)) {
    return traj;
  }

  const metadata = (traj.metadata ?? {}) as Record<string, unknown>;
  const messageId = toNullableString(metadata.messageId);
  const roomId = toNullableString(metadata.roomId);
  if (!messageId && !roomId) {
    return traj;
  }

  try {
    const result = await executeRawSql(
      runtime,
      "SELECT type, body, room_id, created_at FROM logs ORDER BY created_at DESC LIMIT 500",
    );
    const rows = extractRows(result);
    if (!Array.isArray(rows) || rows.length === 0) {
      return traj;
    }

    const normalizedRows = rows
      .map((row) => {
        const record = asRecord(row);
        if (!record) return null;
        const bodyValue = record.body;
        const body =
          asRecord(bodyValue) ??
          (typeof bodyValue === "string"
            ? asRecord(JSON.parse(bodyValue))
            : null);
        if (!body) return null;
        return {
          type: typeof record.type === "string" ? record.type : "",
          roomId: toNullableString(record.room_id),
          createdAt:
            typeof record.created_at === "string" ? record.created_at : null,
          body,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    const runEventCandidates = normalizedRows.filter((row) => {
      if (row.type !== "run_event") return false;
      const body = row.body;
      if (typeof body.runId !== "string" || body.runId.trim().length === 0) {
        return false;
      }
      if (messageId && body.messageId === messageId) {
        return true;
      }
      const loggedRoomId = toNullableString(body.roomId) ?? row.roomId;
      const startTime = toFiniteNumber(body.startTime);
      const endTime = toFiniteNumber(body.endTime) ?? startTime;
      return (
        !!roomId &&
        loggedRoomId === roomId &&
        startTime !== null &&
        endTime !== null &&
        endTime >= traj.startTime - 60_000 &&
        startTime <= (traj.endTime ?? traj.startTime + 120_000) + 60_000
      );
    });

    if (runEventCandidates.length === 0) {
      return traj;
    }

    runEventCandidates.sort((left, right) => {
      const leftStart = toFiniteNumber(left.body.startTime) ?? 0;
      const rightStart = toFiniteNumber(right.body.startTime) ?? 0;
      return (
        Math.abs(leftStart - traj.startTime) -
        Math.abs(rightStart - traj.startTime)
      );
    });

    const runId = String(runEventCandidates[0].body.runId);
    const useModelRows = normalizedRows
      .filter(
        (row) =>
          row.body.runId === runId &&
          isTextGenerationLogRow(row.type, row.body),
      )
      .sort((left, right) => {
        const leftTs =
          toFiniteNumber(left.body.timestamp) ??
          Date.parse(left.createdAt ?? "") ??
          0;
        const rightTs =
          toFiniteNumber(right.body.timestamp) ??
          Date.parse(right.createdAt ?? "") ??
          0;
        return leftTs - rightTs;
      });

    if (useModelRows.length === 0) {
      return traj;
    }

    const baseSteps: TrajectoryStep[] =
      traj.steps && traj.steps.length > 0
        ? traj.steps.map((step) => ({
            ...step,
            llmCalls: [] as TrajectoryLlmCall[],
          }))
        : [
            {
              stepId: traj.trajectoryId,
              timestamp: traj.startTime,
              llmCalls: [] as TrajectoryLlmCall[],
              providerAccesses: [],
            },
          ];

    const firstCallTimestamp =
      toFiniteNumber(useModelRows[0]?.body.timestamp) ?? traj.startTime;
    baseSteps[0] = {
      ...baseSteps[0],
      timestamp:
        typeof baseSteps[0].timestamp === "number"
          ? Math.min(baseSteps[0].timestamp, firstCallTimestamp)
          : firstCallTimestamp,
      llmCalls: useModelRows.map((row, index) => {
        const body = row.body;
        const systemPrompt =
          typeof body.systemPrompt === "string" ? body.systemPrompt : "";
        const userPrompt = typeof body.prompt === "string" ? body.prompt : "";
        const response = typeof body.response === "string" ? body.response : "";
        const modelKey =
          typeof body.modelKey === "string" && body.modelKey.trim().length > 0
            ? body.modelKey.trim()
            : row.type.slice("useModel:".length);
        const provider =
          typeof body.provider === "string" && body.provider.trim().length > 0
            ? body.provider.trim()
            : "";
        const model =
          provider && modelKey?.toUpperCase().startsWith("TEXT_")
            ? `${provider}/${modelKey}`
            : modelKey || provider || "unknown";
        return {
          callId: `${traj.trajectoryId}-log-${index + 1}`,
          timestamp:
            toFiniteNumber(body.timestamp) ??
            Date.parse(row.createdAt ?? "") ??
            firstCallTimestamp,
          model,
          systemPrompt,
          userPrompt,
          response,
          temperature: toFiniteNumber(body.temperature) ?? 0,
          maxTokens: toFiniteNumber(body.maxTokens) ?? 0,
          purpose: "chat",
          actionType: "runtime.useModel",
          latencyMs:
            Math.max(0, Math.round(toFiniteNumber(body.executionTime) ?? 0)) ??
            0,
          promptTokens: estimateTokenCount(systemPrompt + userPrompt),
          completionTokens: estimateTokenCount(response),
        };
      }),
    };

    const nextMetadata: Record<string, unknown> = {
      ...metadata,
      llmCallBackfillSource: "logs",
    };
    delete nextMetadata.syntheticLlmCall;
    delete nextMetadata.syntheticLlmCallSource;

    const enriched: Trajectory = {
      ...traj,
      steps: baseSteps,
      metadata: nextMetadata as Trajectory["metadata"],
    };

    try {
      await saveTrajectory(runtime, toPersistedTrajectory(enriched));
    } catch {
      // Best-effort persistence only; still return the enriched detail payload.
    }

    return enriched;
  } catch {
    return traj;
  }
}

async function maybeBackfillTrajectoryFromConversationMemory(
  runtime: AgentRuntime,
  traj: Trajectory,
): Promise<Trajectory> {
  const metadata = (traj.metadata ?? {}) as Record<string, unknown>;
  const roomId = toNullableString(metadata.roomId);
  if (!roomId) {
    return traj;
  }

  try {
    const memories = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 100,
    });
    if (!Array.isArray(memories) || memories.length === 0) {
      return traj;
    }

    const sortedMemories = [...memories].sort(
      (a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0),
    );
    const endTime =
      typeof traj.endTime === "number"
        ? traj.endTime
        : traj.startTime + 120_000;

    const userMemory = [...sortedMemories].reverse().find((memory) => {
      const createdAt = Number(memory.createdAt ?? 0);
      if (!Number.isFinite(createdAt)) return false;
      if (createdAt < traj.startTime - 60_000 || createdAt > endTime + 5_000) {
        return false;
      }
      return (
        memory.entityId !== runtime.agentId &&
        extractMessageText(memory).length > 0
      );
    });
    if (!userMemory) {
      return traj;
    }

    const userCreatedAt = Number(userMemory.createdAt ?? traj.startTime);
    const assistantMemory = sortedMemories.find((memory) => {
      const createdAt = Number(memory.createdAt ?? 0);
      if (!Number.isFinite(createdAt)) return false;
      if (createdAt < userCreatedAt || createdAt > endTime + 30_000) {
        return false;
      }
      return (
        memory.entityId === runtime.agentId &&
        extractMessageText(memory).length > 0
      );
    });
    if (!assistantMemory) {
      return traj;
    }

    const userPrompt = extractMessageText(userMemory);
    const response = extractMessageText(assistantMemory);
    if (!userPrompt || !response) {
      return traj;
    }

    const normalizedUserPrompt = userPrompt.toLowerCase();
    const normalizedResponse = response.toLowerCase();
    const existingCalls = (traj.steps ?? []).flatMap(
      (step) => step.llmCalls ?? [],
    );
    const alreadyCapturedConversation = existingCalls.some((call) => {
      const callPrompt = String(call.userPrompt ?? "")
        .trim()
        .toLowerCase();
      if (
        callPrompt &&
        (callPrompt.includes(normalizedUserPrompt) ||
          normalizedUserPrompt.includes(callPrompt))
      ) {
        return true;
      }

      const callResponse = String(call.response ?? "")
        .trim()
        .toLowerCase();
      return (
        callResponse.length > 0 &&
        (callResponse.includes(normalizedResponse) ||
          normalizedResponse.includes(callResponse))
      );
    });
    if (alreadyCapturedConversation) {
      return traj;
    }

    const baseSteps: TrajectoryStep[] =
      traj.steps && traj.steps.length > 0
        ? traj.steps.map((step) => ({
            ...step,
            llmCalls: [...(step.llmCalls ?? [])],
          }))
        : [
            {
              stepId: traj.trajectoryId,
              timestamp: traj.startTime,
              llmCalls: [] as TrajectoryLlmCall[],
              providerAccesses: [],
            },
          ];

    baseSteps[0] = {
      ...baseSteps[0],
      timestamp:
        typeof baseSteps[0].timestamp === "number"
          ? baseSteps[0].timestamp
          : userCreatedAt,
      llmCalls: [
        {
          callId: `${traj.trajectoryId}-conversation-memory`,
          timestamp: userCreatedAt,
          model: "eliza/conversation-memory-backfill",
          systemPrompt:
            "[backfilled from conversation memory because the trajectory logger did not capture the live LLM call]",
          userPrompt,
          response,
          temperature: 0,
          maxTokens: 0,
          purpose: "chat",
          actionType: "conversation-memory-backfill",
          latencyMs: Math.max(
            0,
            Number(assistantMemory.createdAt ?? endTime) - userCreatedAt,
          ),
        },
        ...(baseSteps[0].llmCalls ?? []),
      ],
    };

    const nextMetadata: Record<string, unknown> = {
      ...metadata,
      llmCallBackfillSource: "conversation-memory",
    };
    delete nextMetadata.syntheticLlmCall;
    delete nextMetadata.syntheticLlmCallSource;

    const enriched: Trajectory = {
      ...traj,
      steps: baseSteps,
      metadata: nextMetadata as Trajectory["metadata"],
    };
    try {
      await saveTrajectory(runtime, toPersistedTrajectory(enriched));
    } catch {
      // Best-effort persistence only; still return the enriched detail payload.
    }
    return enriched;
  } catch {
    return traj;
  }
}

function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function trajectoryMatchesSearch(
  item: TrajectoryListItem,
  detail: Trajectory | null,
  search: string,
): boolean {
  const needle = normalizeSearchQuery(search);
  if (!needle) return true;

  const parts: string[] = [item.id, item.source, item.status, item.createdAt];
  const metadata = detail?.metadata;
  if (metadata && Object.keys(metadata).length > 0) {
    parts.push(JSON.stringify(metadata));
  }

  for (const step of detail?.steps ?? []) {
    for (const call of step.llmCalls ?? []) {
      parts.push(
        String(call.model ?? ""),
        String(call.systemPrompt ?? ""),
        String(call.userPrompt ?? ""),
        String(call.response ?? ""),
        String(call.purpose ?? ""),
        String(call.actionType ?? ""),
      );
    }
    for (const access of step.providerAccesses ?? []) {
      parts.push(
        String(access.providerName ?? ""),
        String(access.purpose ?? ""),
        JSON.stringify(access.data ?? {}),
        JSON.stringify(access.query ?? {}),
      );
    }
  }

  return parts.some((part) => part.toLowerCase().includes(needle));
}

async function applyRouteSearchFilter(
  runtime: AgentRuntime,
  logger: TrajectoryLoggerApi,
  list: TrajectoryListResult,
  search: string,
): Promise<TrajectoryListResult> {
  const filtered = await Promise.all(
    list.trajectories.map(async (item) => {
      const detail = await logger.getTrajectoryDetail(item.id);
      const hydrated = detail
        ? await maybeBackfillTrajectoryFromConversationMemory(
            runtime,
            await maybeBackfillTrajectoryFromUseModelLogs(runtime, detail),
          )
        : null;
      return trajectoryMatchesSearch(item, hydrated, search) ? item : null;
    }),
  );

  return {
    trajectories: filtered.filter((item): item is TrajectoryListItem => !!item),
    total: filtered.filter(Boolean).length,
    offset: list.offset,
    limit: list.limit,
  };
}

// ============================================================================
// Handlers
// ============================================================================

async function handleGetTrajectories(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const logger = await getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectories service not available", 503);
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );

  const options: TrajectoryListOptions = {
    limit: Math.min(
      500,
      Math.max(1, Number(url.searchParams.get("limit")) || 50),
    ),
    offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
    source: url.searchParams.get("source") || undefined,
    status:
      (url.searchParams.get("status") as
        | "active"
        | "completed"
        | "error"
        | "timeout") || undefined,
    startDate: url.searchParams.get("startDate") || undefined,
    endDate: url.searchParams.get("endDate") || undefined,
    search: url.searchParams.get("search") || undefined,
    scenarioId: url.searchParams.get("scenarioId") || undefined,
    batchId: url.searchParams.get("batchId") || undefined,
    isTrainingData: url.searchParams.has("isTrainingData")
      ? url.searchParams.get("isTrainingData") === "true"
      : undefined,
  };
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const result = options.search
    ? await applyRouteSearchFilter(
        runtime,
        logger,
        await logger.listTrajectories({
          ...options,
          search: undefined,
          limit: 500,
          offset: 0,
        }),
        options.search,
      )
    : await logger.listTrajectories(options);

  const pagedTrajectories = options.search
    ? result.trajectories.slice(offset, offset + limit)
    : result.trajectories;

  const uiResult = {
    trajectories: pagedTrajectories.map(listItemToUIRecord),
    total: result.total,
    offset,
    limit,
  };

  sendJson(res, uiResult);
}

async function handleGetTrajectoryDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  trajectoryId: string,
): Promise<void> {
  const logger = await getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectories service not available", 503);
    return;
  }

  const trajectory = await logger.getTrajectoryDetail(trajectoryId);
  if (!trajectory) {
    sendJsonError(res, `Trajectory "${trajectoryId}" not found`, 404);
    return;
  }

  const uiDetail = trajectoryToUIDetail(
    await maybeBackfillTrajectoryFromConversationMemory(
      runtime,
      await maybeBackfillTrajectoryFromUseModelLogs(runtime, trajectory),
    ),
  );
  sendJson(res, uiDetail);
}

async function handleGetStats(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const logger = await getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectories service not available", 503);
    return;
  }

  const stats = await logger.getStats();
  sendJson(res, stats);
}

async function handleGetConfig(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const logger = await getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectories service not available", 503);
    return;
  }

  sendJson(res, {
    enabled: logger.isEnabled(),
  });
}

async function handlePutConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const logger = await getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectories service not available", 503);
    return;
  }

  const body = await parseJsonBody<{ enabled?: boolean }>(req, res);
  if (!body) return;

  if (typeof body.enabled === "boolean") {
    logger.setEnabled(body.enabled);
  }

  sendJson(res, {
    enabled: logger.isEnabled(),
  });
}

async function handleExportTrajectories(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const logger = await getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectories service not available", 503);
    return;
  }

  const body = await parseJsonBody<{
    format?: string;
    includePrompts?: boolean;
    trajectoryIds?: string[];
    startDate?: string;
    endDate?: string;
    scenarioId?: string;
    batchId?: string;
    jsonShape?: string;
  }>(req, res);
  if (!body) return;

  if (body.format === "zip") {
    if (typeof logger.exportTrajectoriesZip !== "function") {
      sendJsonError(
        res,
        "Trajectory ZIP export is unavailable in the active logger",
        503,
      );
      return;
    }

    const zipOptions: TrajectoryZipExportOptions = {
      includePrompts: body.includePrompts,
      trajectoryIds: body.trajectoryIds,
      startDate: body.startDate,
      endDate: body.endDate,
      scenarioId: body.scenarioId,
      batchId: body.batchId,
    };
    const zipResult = await logger.exportTrajectoriesZip(zipOptions);
    const archive = createZipArchive(zipResult.entries);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${zipResult.filename}"`,
    );
    res.end(archive);
    return;
  }

  if (
    body.format !== "json" &&
    body.format !== "jsonl" &&
    body.format !== "csv" &&
    body.format !== "art"
  ) {
    sendJsonError(
      res,
      "Format must be 'json', 'jsonl', 'csv', 'art', or 'zip'",
      400,
    );
    return;
  }

  const jsonShape =
    body.jsonShape === ELIZA_NATIVE_TRAJECTORY_FORMAT
      ? body.jsonShape
      : undefined;
  if (body.jsonShape !== undefined && !jsonShape) {
    sendJsonError(
      res,
      "jsonShape must be 'eliza_native_v1'",
      400,
    );
    return;
  }

  const result = await logger.exportTrajectories({
    format: body.format as TrajectoryExportFormat,
    includePrompts: body.includePrompts,
    trajectoryIds: body.trajectoryIds,
    startDate: body.startDate,
    endDate: body.endDate,
    scenarioId: body.scenarioId,
    batchId: body.batchId,
    ...((body.format === "json" || body.format === "jsonl") && jsonShape
      ? { jsonShape }
      : {}),
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", result.mimeType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${result.filename}"`,
  );
  res.end(result.data);
}

async function handleDeleteTrajectories(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const logger = await getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectories service not available", 503);
    return;
  }

  const body = await parseJsonBody<{
    trajectoryIds?: string[];
    all?: boolean;
    clearAll?: boolean;
  }>(req, res);
  if (!body) return;

  if (body.clearAll || body.all) {
    const deletedCount = await logger.clearAllTrajectories();
    sendJson(res, { deleted: deletedCount });
    return;
  }

  if (Array.isArray(body.trajectoryIds) && body.trajectoryIds.length > 0) {
    const deletedCount = await logger.deleteTrajectories(body.trajectoryIds);
    sendJson(res, { deleted: deletedCount });
    return;
  }

  sendJson(res, { deleted: 0 });
}

// ============================================================================
// Main Router
// ============================================================================

export async function handleTrajectoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/trajectories")) return false;

  // GET /api/trajectories/config
  if (pathname === "/api/trajectories/config" && method === "GET") {
    await handleGetConfig(req, res, runtime);
    return true;
  }

  // PUT /api/trajectories/config
  if (pathname === "/api/trajectories/config" && method === "PUT") {
    await handlePutConfig(req, res, runtime);
    return true;
  }

  // POST /api/trajectories/export
  if (pathname === "/api/trajectories/export" && method === "POST") {
    await handleExportTrajectories(req, res, runtime);
    return true;
  }

  // DELETE /api/trajectories
  if (pathname === "/api/trajectories" && method === "DELETE") {
    await handleDeleteTrajectories(req, res, runtime);
    return true;
  }

  // GET /api/trajectories/stats
  if (pathname === "/api/trajectories/stats" && method === "GET") {
    await handleGetStats(req, res, runtime);
    return true;
  }

  // GET /api/trajectories/:id
  const detailMatch = pathname.match(/^\/api\/trajectories\/([^/]+)$/);
  if (detailMatch && method === "GET") {
    await handleGetTrajectoryDetail(req, res, runtime, detailMatch[1]);
    return true;
  }

  // GET /api/trajectories
  if (pathname === "/api/trajectories" && method === "GET") {
    await handleGetTrajectories(req, res, runtime);
    return true;
  }

  return false;
}
