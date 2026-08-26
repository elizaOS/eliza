/**
 * Serves the authenticated context-inspector projection over trajectory-owned
 * content metadata. The route reauthorizes the requested room on every call
 * and emits an allowlisted DTO that cannot carry source text or native IDs.
 */

import { createHmac, randomBytes } from "node:crypto";
import type http from "node:http";
import {
  type AgentRuntime,
  ElizaError,
  isReadView,
  type TrajectoryDetailRecord,
  type TrajectorySummaryRecord,
  type UUID,
  validateUuid,
} from "@elizaos/core";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_VISITED_VALUES = 100_000;
const redactionKeys = new WeakMap<object, Buffer>();

export type ContextInspectorCompleteness =
  | "complete"
  | "partial-recoverable"
  | "partial-source-loss"
  | "unavailable";

export type ContextInspectorRetentionState =
  | "policy-managed"
  | "expires"
  | "expired"
  | "unavailable";

export interface ContextInspectorEntry {
  reference: string;
  kind: "file" | "document" | "attachment" | "email" | "memory" | "tool-result";
  range: {
    unit: "line" | "fragment" | "byte";
    start: number;
    end: number;
    total?: number;
  };
  completeness: ContextInspectorCompleteness;
  omissionReason: string | null;
  retentionState: ContextInspectorRetentionState;
}

export interface ContextInspectorBudget {
  usedTokens: number;
  limitTokens: number;
  reservedTokens: number;
  state: "within-budget" | "rejected" | "unavailable";
}

export interface ContextInspectorResponse {
  schemaVersion: "elizaos.context-inspector/v1";
  entries: ContextInspectorEntry[];
  tokenBudgets: ContextInspectorBudget[];
  page: {
    offset: number;
    limit: number;
    hasPrevious: boolean;
    hasMore: boolean;
    nextOffset: number | null;
  };
  state: "available" | "empty";
}

interface TrajectoriesServiceLike {
  listTrajectories(options: {
    limit: number;
    offset: number;
    roomId: string;
  }): Promise<{
    trajectories: TrajectorySummaryRecord[];
    total: number;
  }>;
  getTrajectoryDetail(id: string): Promise<TrajectoryDetailRecord | null>;
}

interface ContextInspectorRuntime
  extends Pick<
    AgentRuntime,
    "getRoom" | "getRoomsForParticipant" | "getService"
  > {}

export interface ContextInspectorRouteOptions {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  url: URL;
  runtime: ContextInspectorRuntime | null;
  authorization: AgentHttpRequestAuthorization;
  resolveConversationRoomId: (conversationId: UUID) => Promise<UUID | null>;
  now?: () => number;
  redactReference?: (reference: string) => string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parsePageInteger(
  value: string | null,
  fallback: number,
  label: string,
  maximum?: number,
): number {
  if (value === null) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ElizaError(`${label} must be a non-negative integer`, {
      code: "CONTEXT_INSPECTOR_INVALID_QUERY",
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ElizaError(`${label} is outside the supported range`, {
      code: "CONTEXT_INSPECTOR_INVALID_QUERY",
    });
  }
  if (maximum !== undefined && (parsed < 1 || parsed > maximum)) {
    throw new ElizaError(`${label} must be between 1 and ${maximum}`, {
      code: "CONTEXT_INSPECTOR_INVALID_QUERY",
    });
  }
  return parsed;
}

function safeOmissionReason(reason: string | undefined): string | null {
  if (!reason) return null;
  const normalized = reason.toLowerCase();
  if (normalized.includes("budget")) return "token-budget";
  if (normalized.includes("expired") || normalized.includes("retention")) {
    return "retention-expired";
  }
  if (normalized.includes("source") && normalized.includes("loss")) {
    return "partial-source-loss";
  }
  if (normalized.includes("projection")) return "prompt-projection";
  if (normalized.includes("unavailable")) return "source-unavailable";
  return "unspecified";
}

function parseExpiry(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function retentionStateFor(
  completeness: ContextInspectorCompleteness,
  context: { retained?: boolean; expiresAt?: number },
  now: number,
): ContextInspectorRetentionState {
  if (
    completeness === "unavailable" ||
    completeness === "partial-source-loss" ||
    context.retained === false
  ) {
    return "unavailable";
  }
  if (context.expiresAt !== undefined) {
    return context.expiresAt <= now ? "expired" : "expires";
  }
  return "policy-managed";
}

function budgetFromCall(call: unknown): ContextInspectorBudget | null {
  const callRecord = asRecord(call);
  const providerOptions = asRecord(callRecord?.providerOptions);
  const eliza = asRecord(providerOptions?.eliza);
  const budget = asRecord(eliza?.modelInputBudget);
  if (!budget) return null;
  const estimated = finiteNonnegativeInteger(budget.estimatedInputTokens);
  const actual = finiteNonnegativeInteger(callRecord?.promptTokens);
  const threshold = finiteNonnegativeInteger(budget.dispatchThresholdTokens);
  const contextWindow = finiteNonnegativeInteger(budget.contextWindowTokens);
  const reserved =
    finiteNonnegativeInteger(budget.reserveOutputTokens) ??
    finiteNonnegativeInteger(budget.reservedOutputTokens) ??
    0;
  const used = actual ?? estimated;
  const limit = threshold ?? contextWindow;
  if (used === null || limit === null) {
    return {
      usedTokens: used ?? 0,
      limitTokens: limit ?? 0,
      reservedTokens: reserved,
      state: "unavailable",
    };
  }
  return {
    usedTokens: used,
    limitTokens: limit,
    reservedTokens: reserved,
    state: budget.shouldReject === true ? "rejected" : "within-budget",
  };
}

function trajectoryMatchesConversationScope(
  trajectory: Pick<TrajectoryDetailRecord, "metadata">,
  conversationId: UUID,
  roomId: UUID,
): boolean {
  const metadata = trajectory.metadata;
  const recordedConversationId = metadata?.conversationId;
  const recordedRoomId = metadata?.roomId;
  if (
    typeof recordedConversationId === "string" &&
    recordedConversationId !== conversationId &&
    recordedConversationId !== roomId
  ) {
    return false;
  }
  if (typeof recordedRoomId === "string" && recordedRoomId !== roomId) {
    return false;
  }
  return (
    recordedConversationId === conversationId ||
    recordedConversationId === roomId ||
    recordedRoomId === roomId
  );
}

/** Build the content-free wire projection from already authorized records. */
export function buildContextInspectorResponse(input: {
  trajectories: TrajectoryDetailRecord[];
  offset: number;
  limit: number;
  total: number;
  now: number;
  redactReference: (reference: string) => string;
}): ContextInspectorResponse {
  const entries = new Map<string, ContextInspectorEntry>();
  const tokenBudgets: ContextInspectorBudget[] = [];
  const visited = new WeakSet<object>();
  let visitedCount = 0;

  const visit = (
    value: unknown,
    inherited: { retained?: boolean; expiresAt?: number } = {},
  ): void => {
    if (value === null || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    visitedCount += 1;
    if (visitedCount > MAX_VISITED_VALUES) {
      throw new ElizaError(
        "Context inspector source exceeds its metadata traversal bound",
        { code: "CONTEXT_INSPECTOR_SOURCE_BOUND_EXCEEDED" },
      );
    }
    const record = asRecord(value);
    const retained =
      typeof record?.retained === "boolean"
        ? record.retained
        : inherited.retained;
    const parsedExpiry = parseExpiry(record?.expiresAt);
    const context = {
      ...(retained === undefined ? {} : { retained }),
      ...(parsedExpiry === null
        ? inherited.expiresAt === undefined
          ? {}
          : { expiresAt: inherited.expiresAt }
        : { expiresAt: parsedExpiry }),
    };
    if (isReadView(value)) {
      const reference = input.redactReference(value.reference.ref);
      const range = value.slice.range;
      const entry: ContextInspectorEntry = {
        reference,
        kind: value.reference.kind,
        range: {
          unit: range.unit,
          start: range.start,
          end: range.end,
          ...(range.total === undefined ? {} : { total: range.total }),
        },
        completeness: value.slice.completeness,
        omissionReason: safeOmissionReason(value.slice.reason),
        retentionState: retentionStateFor(
          value.slice.completeness,
          context,
          input.now,
        ),
      };
      const key = `${reference}:${range.unit}:${range.start}:${range.end}`;
      entries.set(key, entry);
      return;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child, context);
    }
  };

  for (const trajectory of input.trajectories) {
    for (const step of trajectory.steps ?? []) {
      if (step.action?.result !== undefined) visit(step.action.result);
      for (const call of step.llmCalls ?? []) {
        const budget = budgetFromCall(call);
        if (budget) tokenBudgets.push(budget);
      }
    }
  }

  const sortedEntries = [...entries.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.reference.localeCompare(right.reference) ||
      left.range.start - right.range.start,
  );
  const nextOffset = input.offset + input.limit;
  return {
    schemaVersion: "elizaos.context-inspector/v1",
    entries: sortedEntries,
    tokenBudgets,
    page: {
      offset: input.offset,
      limit: input.limit,
      hasPrevious: input.offset > 0,
      hasMore: nextOffset < input.total,
      nextOffset: nextOffset < input.total ? nextOffset : null,
    },
    state:
      sortedEntries.length === 0 && tokenBudgets.length === 0
        ? "empty"
        : "available",
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

function errorStatus(error: unknown): number {
  if (!(error instanceof ElizaError)) return 500;
  if (error.code === "CONTEXT_INSPECTOR_INVALID_QUERY") return 400;
  if (error.code === "CONTEXT_INSPECTOR_FORBIDDEN") return 403;
  if (error.code === "CONTEXT_INSPECTOR_NOT_FOUND") return 404;
  if (error.code === "CONTEXT_INSPECTOR_SCOPE_CHANGED") return 409;
  if (error.code === "CONTEXT_INSPECTOR_UNAVAILABLE") return 503;
  return 500;
}

function safeErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return "Invalid context inspector request";
    case 403:
      return "Context inspector access denied";
    case 404:
      return "Context inspector source unavailable";
    case 409:
      return "Context inspector scope changed; refresh and retry";
    case 503:
      return "Context inspector temporarily unavailable";
    default:
      return "Context inspector failed";
  }
}

async function authorizeConversation(
  runtime: ContextInspectorRuntime,
  authorization: AgentHttpRequestAuthorization,
  conversationId: UUID,
): Promise<void> {
  if (!authorization.ok) {
    throw new ElizaError("Context inspector requires authentication", {
      code: "CONTEXT_INSPECTOR_FORBIDDEN",
    });
  }
  const room = await runtime.getRoom(conversationId);
  if (!room) {
    throw new ElizaError("Context inspector room is unavailable", {
      code: "CONTEXT_INSPECTOR_NOT_FOUND",
    });
  }
  if (authorization.role === "OWNER") return;
  const principal = validateUuid(authorization.principal);
  if (!principal) {
    throw new ElizaError("Context inspector principal is unavailable", {
      code: "CONTEXT_INSPECTOR_FORBIDDEN",
    });
  }
  const rooms = await runtime.getRoomsForParticipant(principal);
  if (!rooms.some((roomId) => roomId === conversationId)) {
    throw new ElizaError("Context inspector room access is forbidden", {
      code: "CONTEXT_INSPECTOR_FORBIDDEN",
    });
  }
}

function runtimeRedactor(runtime: object): (reference: string) => string {
  let key = redactionKeys.get(runtime);
  if (!key) {
    key = randomBytes(32);
    redactionKeys.set(runtime, key);
  }
  return (reference) =>
    `ctx_${createHmac("sha256", key).update(reference).digest("hex").slice(0, 20)}`;
}

/** Handle GET /api/context-inspector after the host's coarse auth gate. */
export async function handleContextInspectorRoute(
  options: ContextInspectorRouteOptions,
): Promise<boolean> {
  if (
    options.pathname !== "/api/context-inspector" ||
    options.method !== "GET"
  ) {
    return false;
  }
  try {
    if (!options.authorization.ok) {
      sendJson(options.res, 401, { error: "Unauthorized" });
      return true;
    }
    const runtime = options.runtime;
    if (!runtime) {
      throw new ElizaError("Context inspector runtime is unavailable", {
        code: "CONTEXT_INSPECTOR_UNAVAILABLE",
      });
    }
    const rawConversationId = options.url.searchParams.get("conversationId");
    const conversationId = validateUuid(rawConversationId);
    if (!conversationId) {
      throw new ElizaError("conversationId must be a UUID", {
        code: "CONTEXT_INSPECTOR_INVALID_QUERY",
      });
    }
    const offset = parsePageInteger(
      options.url.searchParams.get("offset"),
      0,
      "offset",
    );
    const limit = parsePageInteger(
      options.url.searchParams.get("limit"),
      DEFAULT_LIMIT,
      "limit",
      MAX_LIMIT,
    );
    const roomId = await options.resolveConversationRoomId(conversationId);
    if (!roomId) {
      throw new ElizaError("Context inspector conversation is unavailable", {
        code: "CONTEXT_INSPECTOR_NOT_FOUND",
      });
    }
    await authorizeConversation(runtime, options.authorization, roomId);
    const service = runtime.getService(
      "trajectories",
    ) as TrajectoriesServiceLike | null;
    if (
      !service ||
      typeof service.listTrajectories !== "function" ||
      typeof service.getTrajectoryDetail !== "function"
    ) {
      throw new ElizaError("Trajectory service is unavailable", {
        code: "CONTEXT_INSPECTOR_UNAVAILABLE",
      });
    }
    const page = await service.listTrajectories({
      limit,
      offset,
      roomId,
    });
    const trajectories: TrajectoryDetailRecord[] = [];
    for (const summary of page.trajectories) {
      const detail = await service.getTrajectoryDetail(summary.id);
      if (!detail) {
        throw new ElizaError("Context inspector trajectory disappeared", {
          code: "CONTEXT_INSPECTOR_SCOPE_CHANGED",
        });
      }
      if (!trajectoryMatchesConversationScope(detail, conversationId, roomId)) {
        throw new ElizaError("Context inspector trajectory scope changed", {
          code: "CONTEXT_INSPECTOR_SCOPE_CHANGED",
        });
      }
      trajectories.push(detail);
    }
    const response = buildContextInspectorResponse({
      trajectories,
      offset,
      limit,
      total: page.total,
      now: (options.now ?? Date.now)(),
      redactReference:
        options.redactReference ?? runtimeRedactor(runtime as object),
    });
    sendJson(options.res, 200, response);
  } catch (error) {
    // error-policy:J1 the HTTP boundary maps typed failures to a content-free
    // status/message pair; source errors and locator values are never echoed.
    const status = errorStatus(error);
    sendJson(options.res, status, { error: safeErrorMessage(status) });
  }
  return true;
}
