// Wire shapes for /api/trajectories[?/...] (served by @elizaos/app-training).
// Only the fields the widget reads are typed — extra fields the route returns
// are tolerated, just untyped.

export interface TrajectoryListItem {
  id: string;
  status: "active" | "completed" | "error";
  llmCallCount: number;
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
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[trajectory-logger] ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

export async function fetchTrajectoryList(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<TrajectoryListResult> {
  const limit = options.limit ?? 10;
  const res = await fetch(`/api/trajectories?limit=${limit}`, {
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  return readJson<TrajectoryListResult>(res);
}

export async function fetchTrajectoryDetail(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<TrajectoryDetail> {
  const res = await fetch(`/api/trajectories/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  return readJson<TrajectoryDetail>(res);
}
