/**
 * Wire types and fetch wrappers for trajectory logger routes.
 * The core trajectory API may return larger payloads, but this client types only
 * the fields the widget reads and tolerates extra route fields.
 */

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

/**
 * HTTP error from a trajectory route, carrying the response status so callers
 * can distinguish a "service not mounted" surface (404/503 — the training
 * plugin that serves `/api/trajectories*` is absent) from a genuine failure.
 */
export class TrajectoryHttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, body: string) {
    super(
      `[trajectory-logger] ${status} ${statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
    this.name = "TrajectoryHttpError";
    this.status = status;
  }

  /**
   * True when the status means the trajectory routes are not available on this
   * surface (the provider plugin is not loaded) rather than a request failure.
   */
  get isUnavailable(): boolean {
    return this.status === 404 || this.status === 503;
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TrajectoryHttpError(res.status, res.statusText, body);
  }
  return (await res.json()) as T;
}

/** List GET — same 15s Fal #21205 family. Independent hop. */
export const TRAJECTORY_LIST_FETCH_TIMEOUT_MS = 15_000;
/** Detail GET — independent hop, own 15s deadline. */
export const TRAJECTORY_DETAIL_FETCH_TIMEOUT_MS = 15_000;
/** Purge DELETE — independent hop, own 15s deadline. */
export const TRAJECTORY_PURGE_FETCH_TIMEOUT_MS = 15_000;
/** Export GET — independent hop, own 15s deadline. */
export const TRAJECTORY_EXPORT_FETCH_TIMEOUT_MS = 15_000;

export function composeTrajectoryFetchSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}

export async function fetchTrajectoryListWithFetch(
  options: { limit?: number; signal?: AbortSignal },
  fetchImpl: typeof fetch,
  timeoutMs: number = TRAJECTORY_LIST_FETCH_TIMEOUT_MS,
): Promise<TrajectoryListResult> {
  const limit = options.limit ?? 10;
  const res = await fetchImpl(`/api/trajectories?limit=${limit}`, {
    headers: { Accept: "application/json" },
    signal: composeTrajectoryFetchSignal(options.signal, timeoutMs),
  });
  return readJson<TrajectoryListResult>(res);
}

export async function fetchTrajectoryDetailWithFetch(
  id: string,
  options: { signal?: AbortSignal },
  fetchImpl: typeof fetch,
  timeoutMs: number = TRAJECTORY_DETAIL_FETCH_TIMEOUT_MS,
): Promise<TrajectoryDetail> {
  const res = await fetchImpl(`/api/trajectories/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    signal: composeTrajectoryFetchSignal(options.signal, timeoutMs),
  });
  return readJson<TrajectoryDetail>(res);
}

export async function purgeTrajectoryWithFetch(
  id: string,
  options: { signal?: AbortSignal },
  fetchImpl: typeof fetch,
  timeoutMs: number = TRAJECTORY_PURGE_FETCH_TIMEOUT_MS,
): Promise<void> {
  const res = await fetchImpl(`/api/trajectories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
    signal: composeTrajectoryFetchSignal(options.signal, timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`purgeTrajectory failed: ${res.status} ${res.statusText}`);
  }
}

export async function fetchTrajectoryExportWithFetch(
  id: string,
  options: { signal?: AbortSignal },
  fetchImpl: typeof fetch,
  timeoutMs: number = TRAJECTORY_EXPORT_FETCH_TIMEOUT_MS,
): Promise<Blob> {
  const res = await fetchImpl(
    `/api/trajectories/${encodeURIComponent(id)}/export`,
    {
      headers: { Accept: "application/zip" },
      signal: composeTrajectoryFetchSignal(options.signal, timeoutMs),
    },
  );
  if (!res.ok) {
    throw new Error(
      `fetchTrajectoryExport failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.blob();
}

export async function fetchTrajectoryList(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<TrajectoryListResult> {
  return fetchTrajectoryListWithFetch(options, globalThis.fetch);
}

export async function fetchTrajectoryDetail(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<TrajectoryDetail> {
  return fetchTrajectoryDetailWithFetch(id, options, globalThis.fetch);
}

/**
 * Soft-purge a single trajectory. The server route is wired by the training
 * plugin; if it returns 404 the caller surfaces "not available" rather than
 * silently failing.
 */
export async function purgeTrajectory(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  return purgeTrajectoryWithFetch(id, options, globalThis.fetch);
}

/**
 * Export a trajectory as a signed zip bundle. The server route returns the
 * archive as `application/zip` (with a `X-Eliza-Signature` header carrying the
 * detached signature). Caller is responsible for streaming the blob.
 */
export async function fetchTrajectoryExport(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<Blob> {
  return fetchTrajectoryExportWithFetch(id, options, globalThis.fetch);
}
