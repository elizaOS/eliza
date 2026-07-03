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

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statusResponse = await queueFetch(statusUrl, options.apiKey);
    const statusPayload = await readJson(statusResponse, "status");
    if (!statusResponse.ok) {
      throw new Error(`fal queue status failed (${statusResponse.status})`);
    }

    const status = stringField(statusPayload, "status");
    if (status === "COMPLETED") {
      break;
    }
    if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") {
      throw new Error(`fal queue job ended in unexpected status: ${status ?? "unknown"}`);
    }
    if (Date.now() + pollIntervalMs > deadline) {
      throw new Error(`fal queue job timed out after ${timeoutMs}ms (request ${requestId ?? "?"})`);
    }
    await sleep(pollIntervalMs);
  }

  const resultResponse = await queueFetch(responseUrl, options.apiKey);
  const payload = await readJson(resultResponse, "response");
  if (!resultResponse.ok) {
    throw new Error(`fal queue response fetch failed (${resultResponse.status})`);
  }

  return { requestId, payload };
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
