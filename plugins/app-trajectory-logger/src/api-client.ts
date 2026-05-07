/**
 * Typed fetch client for the trajectory routes exposed by app-training
 * (`/api/trajectories`, `/api/trajectories/:id`).
 *
 * This module owns the wire shapes the UI consumes. The routes themselves
 * live in `@elizaos/app-training/routes/trajectory` — keeping the response
 * shapes here as a narrow contract avoids importing the entire training
 * plugin's UI graph.
 */

export interface TrajectoryListItem {
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

export interface TrajectoryListResult {
  trajectories: TrajectoryListItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface UILlmCall {
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

export interface UIProviderAccess {
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

export type UIToolCallStatus =
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

export interface UIToolEvent {
  id: string;
  trajectoryId?: string;
  stepId?: string;
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
  timestamp?: number;
  createdAt?: string;
}

export interface UIEvaluationEvent {
  id: string;
  trajectoryId?: string;
  stepId?: string;
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
  timestamp?: number;
  createdAt?: string;
}

export interface TrajectoryDetail {
  trajectory: TrajectoryListItem;
  llmCalls: UILlmCall[];
  providerAccesses: UIProviderAccess[];
  events?: unknown[];
  contextEvents?: unknown[];
  toolEvents?: UIToolEvent[];
  evaluationEvents?: UIEvaluationEvent[];
  cacheObservations?: unknown[];
  cacheStats?: unknown;
  contextDiffs?: unknown[];
}

const TRAJECTORY_LIST_PATH = "/api/trajectories";

function buildDetailPath(id: string): string {
  return `/api/trajectories/${encodeURIComponent(id)}`;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[trajectory-logger] ${res.status} ${res.statusText} from ${res.url}${
        body ? `: ${body.slice(0, 240)}` : ""
      }`,
    );
  }
  return (await res.json()) as T;
}

export async function fetchTrajectoryList(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<TrajectoryListResult> {
  const limit = options.limit ?? 10;
  const url = `${TRAJECTORY_LIST_PATH}?limit=${limit}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  return readJson<TrajectoryListResult>(res);
}

export async function fetchTrajectoryDetail(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<TrajectoryDetail> {
  const res = await fetch(buildDetailPath(id), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  return readJson<TrajectoryDetail>(res);
}
