// Wire shapes for /api/trajectories[?/...] (served by @elizaos/plugin-training).
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

/**
 * Soft-purge a single trajectory. The server route is wired by the training
 * plugin; if it returns 404 the caller surfaces "not available" rather than
 * silently failing.
 */
export async function purgeTrajectory(id: string): Promise<void> {
  const res = await fetch(`/api/trajectories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`purgeTrajectory failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * Export a trajectory as a signed zip bundle. The server route returns the
 * archive as `application/zip` (with a `X-Eliza-Signature` header carrying the
 * detached signature). Caller is responsible for streaming the blob.
 */
export async function fetchTrajectoryExport(id: string): Promise<Blob> {
  const res = await fetch(
    `/api/trajectories/${encodeURIComponent(id)}/export`,
    { headers: { Accept: "application/zip" } },
  );
  if (!res.ok) {
    throw new Error(
      `fetchTrajectoryExport failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.blob();
}
