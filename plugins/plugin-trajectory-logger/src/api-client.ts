/**
 * Wire types and fetch wrappers for trajectory logger routes.
 * The core trajectory API may return larger payloads, but this client types only
 * the fields the widget reads and tolerates extra route fields.
 * Requests go through the shared app client so they use the selected agent's
 * API base, credentials and transport, like the main Trajectories view.
 */
import type { InferenceTimingDevPayload } from "@elizaos/core";
import { client, isApiError } from "@elizaos/ui";

export interface TrajectoryListItem {
  id: string;
  status: "active" | "completed" | "error";
  llmCallCount: number;
  startTime?: number;
  endTime?: number;
  durationMs?: number;
}

export interface TrajectoryListResult {
  trajectories: TrajectoryListItem[];
  total: number;
}

export interface UILlmCall {
  id: string;
  model: string;
  response: string;
  purpose: string;
  actionType: string;
  stepType: string;
  timestamp?: number;
  latencyMs?: number;
  tokenUsageEstimated?: boolean;
  promptTokens?: number;
  completionTokens?: number;
}

export interface UIProviderAccess {
  id: string;
  providerName: string;
  purpose: string;
}

export interface UIToolEvent {
  id: string;
  type: "tool_call" | "tool_result" | "tool_error";
  actionName?: string;
  toolName?: string;
  name?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  result?: unknown;
  output?: unknown;
  status?: "queued" | "running" | "completed" | "skipped" | "failed";
  success?: boolean;
  durationMs?: number;
  error?: string;
}

export interface UIEvaluationEvent {
  id: string;
  evaluatorName?: string;
  name?: string;
  status?: "queued" | "running" | "completed" | "skipped" | "failed";
  success?: boolean;
  decision?: string;
  thought?: string;
  error?: string;
}

export interface TrajectoryDetail {
  trajectory: TrajectoryListItem;
  llmCalls: UILlmCall[];
  providerAccesses: UIProviderAccess[];
  toolEvents?: UIToolEvent[];
  evaluationEvents?: UIEvaluationEvent[];
  semanticStages?: {
    stageId: string;
    kind: string;
    startedAt: number;
    endedAt?: number;
    latencyMs?: number;
    payload: Record<string, unknown>;
  }[];
}

/**
 * True when a trajectory request failed because the routes are not mounted on
 * this agent (404/503 - the provider plugin is absent) rather than a genuine
 * request failure.
 */
export function isTrajectoryRouteUnavailable(err: unknown): boolean {
  return isApiError(err) && (err.status === 404 || err.status === 503);
}

/**
 * True when the shared client ended a polling hop at its request deadline.
 * A slow trajectory endpoint is not a polling failure and should stay quiet
 * until the next scheduled hop.
 */
export function isTrajectoryRequestTimeout(err: unknown): boolean {
  return isApiError(err) && err.kind === "timeout";
}

/** Each GET is an independent hop with its own 15s deadline. */
const TRAJECTORY_FETCH_TIMEOUT_MS = 15_000;

function getTrajectoryJson<T>(
  path: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  return client.fetch<T>(
    path,
    { method: "GET", signal },
    { timeoutMs: TRAJECTORY_FETCH_TIMEOUT_MS },
  );
}

export async function fetchTrajectoryList(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<TrajectoryListResult> {
  const limit = options.limit ?? 10;
  return getTrajectoryJson<TrajectoryListResult>(
    `/api/trajectories?limit=${limit}`,
    options.signal,
  );
}

export async function fetchTrajectoryDetail(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<TrajectoryDetail> {
  return getTrajectoryJson<TrajectoryDetail>(
    `/api/trajectories/${encodeURIComponent(id)}`,
    options.signal,
  );
}

/** Optional local diagnostics. Join by recorded identity, never timestamp proximity. */
export async function fetchTrajectoryTiming(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<Pick<InferenceTimingDevPayload, "turns" | "flows">> {
  const payload = await getTrajectoryJson<InferenceTimingDevPayload>(
    "/api/dev/inference-timing?limit=200",
    options.signal,
  );
  const turns = payload.turns.filter((turn) =>
    turn.spans.some((span) => span.meta?.trajectoryId === id),
  );
  const turnIds = new Set(turns.map((turn) => turn.turnId));
  return {
    turns,
    flows: payload.flows.filter((flow) => turnIds.has(flow.turnId)),
  };
}
