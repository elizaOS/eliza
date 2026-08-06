import { ApiError } from "./types";
import type { RequestOptions } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  return (
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL) ||
    "http://localhost:3001"
  );
}

function getApiKey(): string | undefined {
  return typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_API_KEY
    : undefined;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("aborted"))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt), 8_000);
}

/** Combine multiple AbortSignals into one. Aborts if any source aborts. */
function combineSignals(...signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];

  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    const listener = () => controller.abort(sig.reason);
    sig.addEventListener("abort", listener, { once: true });
    listeners.push(() => sig.removeEventListener("abort", listener));
  }

  return {
    signal: controller.signal,
    cleanup: () => listeners.forEach((fn) => fn()),
  };
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    message = body.error ?? body.message ?? message;
  } catch {
    // ignore parse errors
  }

  const type =
    res.status === 401
      ? "auth"
      : res.status === 404
        ? "not_found"
        : res.status === 429
          ? "rate_limit"
          : res.status >= 500
            ? "server"
            : "server";

  const retryAfterMs =
    res.status === 429
      ? (parseInt(res.headers.get("Retry-After") ?? "60", 10) || 60) * 1_000
      : undefined;

  return new ApiError(res.status, message, type, retryAfterMs);
}

// ---------------------------------------------------------------------------
// ApiClient
// ---------------------------------------------------------------------------

class ApiClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  /** In-flight GET requests keyed by path — for deduplication. */
  private readonly inflight = new Map<string, Promise<Response>>();

  constructor() {
    this.baseUrl = getBaseUrl();
    this.apiKey = getApiKey();
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extra,
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    attempt = 0
  ): Promise<Response> {
    try {
      if (attempt > 0) {
        console.debug(`[api] retry ${attempt}/${MAX_RETRY_ATTEMPTS - 1} ${init.method ?? "GET"} ${url}`);
      } else {
        console.debug(`[api] → ${init.method ?? "GET"} ${url}`);
      }
      const res = await fetch(url, init);
      console.debug(`[api] ← ${res.status} ${url}`);

      if (res.status >= 500 && attempt < MAX_RETRY_ATTEMPTS - 1 && !init.signal?.aborted) {
        await sleep(backoffMs(attempt));
        return this.fetchWithRetry(url, init, attempt + 1);
      }
      return res;
    } catch (err) {
      if (!isAbortError(err) && attempt < MAX_RETRY_ATTEMPTS - 1) {
        await sleep(backoffMs(attempt));
        return this.fetchWithRetry(url, init, attempt + 1);
      }
      throw err;
    }
  }

  /**
   * Core fetch method. Applies auth headers, timeout, and retry logic.
   * Pass `timeout: 0` to disable timeout (e.g. for streaming responses).
   */
  async request(
    path: string,
    init: RequestInit & { timeout?: number; extraHeaders?: Record<string, string> } = {}
  ): Promise<Response> {
    const {
      timeout = DEFAULT_TIMEOUT_MS,
      signal: userSignal,
      extraHeaders,
      ...rest
    } = init;

    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders(extraHeaders);

    const timeoutSignals: (AbortSignal | undefined)[] = [userSignal];
    let timeoutController: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (timeout > 0) {
      timeoutController = new AbortController();
      timeoutId = setTimeout(() => timeoutController!.abort(), timeout);
      timeoutSignals.push(timeoutController.signal);
    }

    const { signal, cleanup } = combineSignals(...timeoutSignals);

    try {
      return await this.fetchWithRetry(url, { ...rest, headers, signal }, 0);
    } catch (err) {
      if (isAbortError(err)) {
        const didTimeout = timeoutController?.signal.aborted ?? false;
        throw new ApiError(
          408,
          didTimeout ? "Request timed out" : "Request cancelled",
          didTimeout ? "timeout" : "abort"
        );
      }
      throw new ApiError(
        0,
        err instanceof Error ? err.message : "Network error",
        "network"
      );
    } finally {
      cleanup();
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience methods
  // ---------------------------------------------------------------------------

  /** GET with request deduplication. */
  async get<T>(path: string, opts?: RequestOptions): Promise<T> {
    const key = path;
    const existing = this.inflight.get(key);
    if (existing) {
      const res = await existing;
      if (!res.ok) throw await toApiError(res.clone());
      return res.clone().json() as Promise<T>;
    }

    const promise = this.request(path, { method: "GET", signal: opts?.signal });
    this.inflight.set(key, promise);
    promise.finally(() => this.inflight.delete(key));

    const res = await promise;
    if (!res.ok) throw await toApiError(res);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const res = await this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      signal: opts?.signal,
      extraHeaders: opts?.headers,
    });
    if (!res.ok) throw await toApiError(res);
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const res = await this.request(path, {
      method: "PATCH",
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    if (!res.ok) throw await toApiError(res);
    return res.json() as Promise<T>;
  }

  async delete(path: string, opts?: RequestOptions): Promise<void> {
    const res = await this.request(path, {
      method: "DELETE",
      signal: opts?.signal,
    });
    if (!res.ok) throw await toApiError(res);
  }

  /**
   * POST that returns the raw Response (for streaming). Timeout is disabled
   * automatically.
   */
  async postStream(
    path: string,
    body: unknown,
    opts?: RequestOptions
  ): Promise<Response> {
    const res = await this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      signal: opts?.signal,
      timeout: 0,
      extraHeaders: opts?.headers,
    });
    if (!res.ok) throw await toApiError(res);
    return res;
  }
}

export const apiClient = new ApiClient();
