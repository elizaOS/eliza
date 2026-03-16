/**
 * Trajectory API routes for the Milady Control UI.
 *
 * Provides endpoints for:
 * - Listing and searching trajectories
 * - Viewing trajectory details with LLM calls and provider accesses
 * - Exporting trajectories to JSON, CSV, or ZIP
 * - Deleting trajectories
 * - Getting trajectory statistics
 * - Enabling/disabling trajectory logging
 *
 * Uses the @elizaos/plugin-trajectory-logger service for data access.
 */

import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import {
  readJsonBody as parseJsonBody,
  sendJson,
  sendJsonError,
} from "./http-helpers";
import { createZipArchive } from "./zip-utils";

// ============================================================================
// Types
// ============================================================================

type TrajectoryStatus = "active" | "completed" | "error" | "timeout";

interface TrajectoryListOptions {
  limit?: number;
  offset?: number;
  source?: string;
  status?: TrajectoryStatus;
  startDate?: string;
  endDate?: string;
  search?: string;
  scenarioId?: string;
  batchId?: string;
  isTrainingData?: boolean;
}

interface TrajectoryListItem {
  id: string;
  agentId: string;
  source: string;
  status: TrajectoryStatus;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  llmCallCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  createdAt: string;
}

interface TrajectoryLlmCall {
  callId?: string;
  timestamp?: number;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  response?: string;
  temperature?: number;
  maxTokens?: number;
  purpose?: string;
  actionType?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

interface TrajectoryProviderAccess {
  providerId?: string;
  providerName?: string;
  purpose?: string;
  data?: Record<string, unknown>;
  query?: Record<string, unknown>;
  timestamp?: number;
}

interface TrajectoryStep {
  stepId?: string;
  timestamp: number;
  llmCalls?: TrajectoryLlmCall[];
  providerAccesses?: TrajectoryProviderAccess[];
}

interface Trajectory {
  trajectoryId: string;
  agentId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  steps?: TrajectoryStep[];
  metrics?: { finalStatus?: string };
  metadata?: Record<string, unknown>;
}

interface TrajectoryListResult {
  trajectories: TrajectoryListItem[];
  total: number;
  offset: number;
  limit: number;
}

type TrajectoryExportFormat = "json" | "csv" | "art";

interface TrajectoryExportOptions {
  format: TrajectoryExportFormat;
  includePrompts?: boolean;
  trajectoryIds?: string[];
  startDate?: string;
  endDate?: string;
  scenarioId?: string;
  batchId?: string;
}

interface TrajectoryExportResult {
  filename: string;
  data: string | Uint8Array;
  mimeType: string;
}

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
    options: TrajectoryExportOptions,
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
}

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

function getTrajectoryLogger(
  runtime: AgentRuntime,
): TrajectoryLoggerApi | null {
  const runtimeLike = runtime as AgentRuntime & {
    getServicesByType?: (serviceType: string) => unknown;
    getService?: (serviceType: string) => unknown;
  };

  const seen = new Set<unknown>();
  const candidates: unknown[] = [];
  const addCandidate = (candidate: unknown): void => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  if (typeof runtimeLike.getServicesByType === "function") {
    const byType = runtimeLike.getServicesByType("trajectory_logger");
    if (Array.isArray(byType)) {
      for (const candidate of byType) {
        addCandidate(candidate);
      }
    } else {
      addCandidate(byType);
    }
  }

  if (typeof runtimeLike.getService === "function") {
    addCandidate(runtimeLike.getService("trajectory_logger"));
  }

  for (const candidate of candidates) {
    if (isRouteCompatibleTrajectoryLogger(candidate)) {
      return candidate;
    }
  }

  return null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
    providerAccessCount: 0,
    totalPromptTokens: item.totalPromptTokens,
    totalCompletionTokens: item.totalCompletionTokens,
    metadata: {},
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
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

  const steps = traj.steps || [];
  const trajectoryId = String(traj.trajectoryId);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepId = typeof step.stepId === "string" ? step.stepId : `step-${i}`;

    // Process LLM Calls
    const calls = step.llmCalls || [];
    for (let j = 0; j < calls.length; j++) {
      const call = calls[j];
      llmCalls.push({
        id: call.callId || `${stepId}-call-${j}`,
        trajectoryId,
        stepId,
        model: call.model || "unknown",
        systemPrompt: call.systemPrompt || "",
        userPrompt: call.userPrompt || "",
        response: call.response || "",
        temperature:
          typeof call.temperature === "number" ? call.temperature : 0,
        maxTokens: typeof call.maxTokens === "number" ? call.maxTokens : 0,
        purpose: call.purpose || "",
        actionType: call.actionType || "",
        latencyMs: call.latencyMs || 0,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        timestamp: call.timestamp || step.timestamp,
        createdAt: new Date(call.timestamp || step.timestamp).toISOString(),
      });
      totalPromptTokens += call.promptTokens || 0;
      totalCompletionTokens += call.completionTokens || 0;
    }

    // Process Provider Accesses
    const accesses = step.providerAccesses || [];
    for (let k = 0; k < accesses.length; k++) {
      const access = accesses[k];
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

  const metadata = (traj.metadata ?? {}) as Record<string, unknown>;
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

  return { trajectory, llmCalls, providerAccesses };
}

// ============================================================================
// Handlers
// ============================================================================

async function handleGetTrajectories(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const logger = getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectory logger service not available", 503);
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

  const result = await logger.listTrajectories(options);

  const uiResult = {
    trajectories: result.trajectories.map(listItemToUIRecord),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };

  sendJson(res, uiResult);
}

async function handleGetTrajectoryDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  trajectoryId: string,
): Promise<void> {
  const logger = getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectory logger service not available", 503);
    return;
  }

  const trajectory = await logger.getTrajectoryDetail(trajectoryId);
  if (!trajectory) {
    sendJsonError(res, `Trajectory "${trajectoryId}" not found`, 404);
    return;
  }

  const uiDetail = trajectoryToUIDetail(trajectory);
  sendJson(res, uiDetail);
}

async function handleGetStats(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const logger = getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectory logger service not available", 503);
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
  const logger = getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectory logger service not available", 503);
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
  const logger = getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectory logger service not available", 503);
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
  const logger = getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectory logger service not available", 503);
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
    body.format !== "csv" &&
    body.format !== "art"
  ) {
    sendJsonError(res, "Format must be 'json', 'csv', 'art', or 'zip'", 400);
    return;
  }

  const result = await logger.exportTrajectories({
    format: body.format,
    includePrompts: body.includePrompts,
    trajectoryIds: body.trajectoryIds,
    startDate: body.startDate,
    endDate: body.endDate,
    scenarioId: body.scenarioId,
    batchId: body.batchId,
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
  const logger = getTrajectoryLogger(runtime);
  if (!logger) {
    sendJsonError(res, "Trajectory logger service not available", 503);
    return;
  }

  const body = await parseJsonBody<{
    trajectoryIds?: string[];
    all?: boolean;
  }>(req, res);
  if (!body) return;

  if (body.all) {
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
