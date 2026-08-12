/**
 * Minimal fal.ai queue-API client for long-running generation jobs
 * (video, audio). Raw `fetch` instead of `@fal-ai/client` so:
 *
 *  - cloud-shared carries no extra dependency, mirroring the raw-fetch
 *    image provider (`providers/image/fal-image-generation.ts`);
 *  - the queue base URL is overridable (`FAL_QUEUE_BASE_URL`), which lets
 *    deterministic tests point the REAL provider code at a local mock
 *    upstream and keeps CI keyless.
 *
 * Queue contract (https://docs.fal.ai/model-apis/queue):
 *   POST {base}/{model}            -> { request_id, status_url, response_url }
 *   GET  {status_url}              -> { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
 *   GET  {response_url}            -> model output payload
 */

const DEFAULT_QUEUE_BASE_URL = "https://queue.fal.run";
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface FalQueueOptions {
  apiKey: string;
  /** Override for tests / proxies. Default: https://queue.fal.run */
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface FalQueueResult {
  requestId?: string;
  payload: Record<string, unknown>;
}

/**
 * Thrown when a job was successfully enqueued on fal but its terminal state
 * could not be determined (poll timeout, status transport failure, status 5xx,
 * non-JSON status body, result 5xx). The upstream job may still complete and
 * bill the platform, so callers must not refund credit holds blindly (#18436).
 */
export class FalQueueEnqueuedError extends Error {
  readonly requestId: string;

  constructor(requestId: string, message: string) {
    super(message);
    this.name = "FalQueueEnqueuedError";
    this.requestId = requestId;
  }
}

/**
 * @deprecated Prefer {@link FalQueueEnqueuedError}. Kept as a named subclass so
 * existing timeout-specific tests and call sites keep working.
 */
export class FalQueueTimeoutError extends FalQueueEnqueuedError {
  readonly timeoutMs: number;

  constructor(requestId: string, timeoutMs: number) {
    super(requestId, `fal queue job timed out after ${timeoutMs}ms (request ${requestId})`);
    this.name = "FalQueueTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function asEnqueuedOrThrow(requestId: string | undefined, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (requestId) {
    throw new FalQueueEnqueuedError(requestId, message);
  }
  throw error instanceof Error ? error : new Error(message);
}

/**
 * Upstream job state as verified against the fal queue status API.
 * `failed` is only for definitive provider verdicts (unknown request id, or a
 * COMPLETED job whose result endpoint rejects the render).
 */
export type FalQueueJobStatus =
  | { state: "pending" }
  | { state: "succeeded"; payload: Record<string, unknown>; requestId: string }
  | { state: "failed"; error: string };

export interface FalQueueJobStatusRequest {
  model: string;
  requestId: string;
  options: FalQueueOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The submit response tells us where to poll. Those URLs come from the
 * upstream, so require them to stay on the queue origin — a compromised or
 * misbehaving upstream must not be able to point our poller at arbitrary
 * internal hosts.
 */
function assertSameOrigin(urlString: string, base: URL, label: string): URL {
  const url = new URL(urlString);
  if (url.origin !== base.origin) {
    throw new Error(`fal queue returned a cross-origin ${label}: ${url.origin}`);
  }
  return url;
}

async function queueFetch(url: URL, apiKey: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: {
      Authorization: `Key ${apiKey}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    throw new Error(`fal queue ${label} returned a non-JSON-object response`);
  }
  return payload;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit a job to the fal queue and poll until it completes, returning the
 * final response payload. Throws on upstream errors, cross-origin poll URLs,
 * and timeout.
 */
export async function runFalQueueJob(
  model: string,
  input: Record<string, unknown>,
  options: FalQueueOptions,
): Promise<FalQueueResult> {
  const base = new URL(options.baseUrl ?? DEFAULT_QUEUE_BASE_URL);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const submitUrl = new URL(
    `${base.pathname.replace(/\/+$/, "")}/${model}`.replace(/^\/+/, "/"),
    base.origin,
  );
  const submitResponse = await queueFetch(submitUrl, options.apiKey, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const submitPayload = await readJson(submitResponse, "submit");
  if (!submitResponse.ok) {
    const detail =
      stringField(submitPayload, "detail") ?? stringField(submitPayload, "message") ?? "";
    throw new Error(
      `fal queue submit failed (${submitResponse.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const requestId = stringField(submitPayload, "request_id");
  const statusUrlRaw = stringField(submitPayload, "status_url");
  const responseUrlRaw = stringField(submitPayload, "response_url");
  if (!statusUrlRaw || !responseUrlRaw) {
    throw new Error("fal queue submit returned no status_url/response_url");
  }
  const statusUrl = assertSameOrigin(statusUrlRaw, base, "status_url");
  const responseUrl = assertSameOrigin(responseUrlRaw, base, "response_url");

  // From this point the job is live upstream. Non-definitive failures must
  // preserve requestId so callers keep credit holds for reconcile (#18436).
  // Definitive failures (404 unknown job, unexpected terminal status, result 4xx)
  // stay ordinary Errors so the route can refund safely.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let statusResponse: Response;
    try {
      statusResponse = await queueFetch(statusUrl, options.apiKey);
    } catch (error) {
      asEnqueuedOrThrow(requestId, error);
    }

    let statusPayload: Record<string, unknown>;
    try {
      statusPayload = await readJson(statusResponse, "status");
    } catch (error) {
      // Non-JSON / empty body on status is not a definitive terminal state.
      asEnqueuedOrThrow(requestId, error);
    }

    if (!statusResponse.ok) {
      // 404 is definitive (provider does not know the job). 5xx / 429 / 408
      // leave outcome unknown → keep the hold.
      if (statusResponse.status === 404) {
        throw new Error(`fal queue status failed (${statusResponse.status})`);
      }
      if (
        statusResponse.status >= 500 ||
        statusResponse.status === 429 ||
        statusResponse.status === 408
      ) {
        asEnqueuedOrThrow(
          requestId,
          new Error(`fal queue status failed (${statusResponse.status})`),
        );
      }
      throw new Error(`fal queue status failed (${statusResponse.status})`);
    }

    const status = stringField(statusPayload, "status");
    if (status === "COMPLETED") {
      break;
    }
    if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") {
      // Unexpected terminal-ish status from the provider — definitive failure.
      throw new Error(`fal queue job ended in unexpected status: ${status ?? "unknown"}`);
    }
    if (Date.now() + pollIntervalMs > deadline) {
      if (requestId) {
        throw new FalQueueTimeoutError(requestId, timeoutMs);
      }
      throw new Error(`fal queue job timed out after ${timeoutMs}ms (request unknown)`);
    }
    await sleep(pollIntervalMs);
  }

  let resultResponse: Response;
  try {
    resultResponse = await queueFetch(responseUrl, options.apiKey);
  } catch (error) {
    asEnqueuedOrThrow(requestId, error);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readJson(resultResponse, "response");
  } catch (error) {
    asEnqueuedOrThrow(requestId, error);
  }

  if (!resultResponse.ok) {
    // COMPLETED + 4xx on result is a terminal render failure (safe to refund).
    // 5xx / transport-class remain unknown so the hold is retained.
    if (resultResponse.status >= 400 && resultResponse.status < 500) {
      const detail =
        stringField(payload, "detail") ??
        stringField(payload, "message") ??
        resultResponse.statusText;
      throw new Error(
        detail || `fal queue response fetch failed (${resultResponse.status})`,
      );
    }
    asEnqueuedOrThrow(
      requestId,
      new Error(`fal queue response fetch failed (${resultResponse.status})`),
    );
  }

  return { requestId, payload };
}

/**
 * Probe an already-enqueued fal queue job without re-submitting. Used by
 * generate-music pending recovery and the music reconcile cron.
 */
export async function getFalQueueJobStatus(
  req: FalQueueJobStatusRequest,
): Promise<FalQueueJobStatus> {
  const base = new URL(req.options.baseUrl ?? DEFAULT_QUEUE_BASE_URL);
  const modelPath = req.model.replace(/^\/+/, "");
  const requestId = req.requestId.trim();
  if (!requestId) {
    return { state: "failed", error: "fal queue status probe requires a request id" };
  }

  const statusUrl = new URL(
    `${base.pathname.replace(/\/+$/, "")}/${modelPath}/requests/${encodeURIComponent(requestId)}/status`.replace(
      /^\/+/,
      "/",
    ),
    base.origin,
  );
  const responseUrl = new URL(
    `${base.pathname.replace(/\/+$/, "")}/${modelPath}/requests/${encodeURIComponent(requestId)}`.replace(
      /^\/+/,
      "/",
    ),
    base.origin,
  );

  const statusResponse = await queueFetch(statusUrl, req.options.apiKey);
  if (statusResponse.status === 404) {
    return {
      state: "failed",
      error: `fal.ai does not know request ${requestId}`,
    };
  }
  const statusPayload = await readJson(statusResponse, "status");
  if (!statusResponse.ok) {
    throw new Error(`fal queue status failed (${statusResponse.status})`);
  }

  const status = stringField(statusPayload, "status");
  if (status !== "COMPLETED") {
    if (status === "IN_QUEUE" || status === "IN_PROGRESS" || !status) {
      return { state: "pending" };
    }
    return {
      state: "failed",
      error: `fal queue job ended in unexpected status: ${status}`,
    };
  }

  const resultResponse = await queueFetch(responseUrl, req.options.apiKey);
  const payload = await readJson(resultResponse, "response");
  if (!resultResponse.ok) {
    // COMPLETED + client error on the result endpoint is a terminal render
    // failure; transport/server faults must propagate so holds stay open.
    if (resultResponse.status >= 400 && resultResponse.status < 500) {
      const detail =
        stringField(payload, "detail") ?? stringField(payload, "message") ?? resultResponse.statusText;
      return {
        state: "failed",
        error: detail || `fal queue response fetch failed (${resultResponse.status})`,
      };
    }
    throw new Error(`fal queue response fetch failed (${resultResponse.status})`);
  }

  return { state: "succeeded", payload, requestId };
}

/** Resolve the fal credentials + queue endpoints from a provider apiKeys record. */
export function falQueueOptionsFromApiKeys(
  apiKeys: Record<string, string | undefined>,
): FalQueueOptions {
  const apiKey = apiKeys.FAL_KEY ?? apiKeys.FAL_API_KEY;
  if (!apiKey) {
    throw new Error("fal is not configured: missing FAL_KEY / FAL_API_KEY");
  }
  const pollIntervalMs = Number(apiKeys.FAL_QUEUE_POLL_INTERVAL_MS ?? "");
  const timeoutMs = Number(apiKeys.FAL_QUEUE_TIMEOUT_MS ?? "");
  return {
    apiKey,
    baseUrl: apiKeys.FAL_QUEUE_BASE_URL,
    ...(Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? { pollIntervalMs } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}
