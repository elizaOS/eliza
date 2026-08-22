/**
 * Low-level HTTP layer for the SDK: `ElizaCloudHttpClient` (GET/POST/PUT/PATCH/
 * DELETE with auth-header injection and query building), the `CloudApiClient`
 * subclass scoped to `/api/v1`, and the error types `CloudApiError` (thrown on
 * any non-2xx) and its 402 specialisation `InsufficientCreditsError`.
 * `ElizaCloudClient` builds on top of this.
 * Request deadlines remain owned through raw and parsed body consumption;
 * parsed bodies fail closed at explicit byte and chunk resource boundaries.
 */

import {
  type CloudApiErrorBody,
  type CloudRequestOptions,
  DEFAULT_ELIZA_CLOUD_API_BASE_URL,
  type ElizaCloudClientOptions,
  type HttpMethod,
  type QueryParams,
  type QueryValue,
} from "./types.js";

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimTrailingSlash(trimmed && trimmed.length > 0 ? trimmed : fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendQuery(url: URL, query?: QueryParams): URL {
  if (!query) return url;

  const params =
    query instanceof URLSearchParams ? query : new URLSearchParams();

  if (!(query instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(query)) {
      appendQueryValue(params, key, value);
    }
  }

  for (const [key, value] of params) {
    url.searchParams.append(key, value);
  }

  return url;
}

function appendQueryValue(
  params: URLSearchParams,
  key: string,
  value: QueryValue | QueryValue[],
) {
  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(params, key, item);
    }
    return;
  }
  if (value === null || value === undefined) return;
  params.append(key, String(value));
}

function resolveUrl(
  baseUrl: string,
  path: string,
  query?: QueryParams,
): string {
  const url = /^https?:\/\//i.test(path)
    ? new URL(path)
    : new URL(`${trimTrailingSlash(baseUrl)}${ensureLeadingSlash(path)}`);
  return appendQuery(url, query).toString();
}

/**
 * A body the server labelled `application/json` but that failed to parse. The
 * raw text is retained so error responses can still surface it in their message;
 * on a 2xx response `request()` promotes this to a thrown failure rather than
 * fabricating a success — a malformed JSON body is a broken response, not data.
 */
const malformedJsonBodyBrand = Symbol("MalformedJsonBody");

interface MalformedJsonBody {
  readonly [malformedJsonBodyBrand]: true;
  readonly kind: "malformed-json";
  readonly text: string;
}

const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY_CHUNKS = 8_192;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface RequestDeadline {
  readonly signal: AbortSignal | undefined;
  readonly aborted: Promise<never>;
  close(): void;
}

function isMalformedJsonBody(value: unknown): value is MalformedJsonBody {
  return (
    isRecord(value) &&
    (value as { [malformedJsonBodyBrand]?: unknown })[
      malformedJsonBodyBrand
    ] === true
  );
}

function responseBodyTooLarge(response: Response): CloudApiError {
  return new CloudApiError(response.status, {
    success: false,
    error: `HTTP ${response.status}: response body exceeds the ${MAX_RESPONSE_BODY_BYTES}-byte SDK limit`,
    code: "response_body_too_large",
  });
}

function releaseReaderNoThrow(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    reader.releaseLock();
  } catch {
    // error-policy:J6 Releasing a terminal response stream is teardown-only.
  }
}

function cancelBodyDetached(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): void {
  if (!body) return;
  try {
    void body
      .cancel(reason)
      // error-policy:J6 The selected response-boundary failure already belongs to the caller.
      .catch(() => undefined);
  } catch {
    // error-policy:J6 A synchronous cancellation failure is teardown-only.
  }
}

function cancelReaderDetached(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  try {
    void reader
      .cancel(reason)
      // error-policy:J6 The selected response-boundary failure already belongs to the caller.
      .catch(() => undefined)
      .finally(() => releaseReaderNoThrow(reader));
  } catch {
    // error-policy:J6 A synchronous cancellation failure is teardown-only.
    releaseReaderNoThrow(reader);
  }
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (!signal) return reader.read();
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_RESPONSE_BODY_BYTES
    ) {
      const error = responseBodyTooLarge(response);
      cancelBodyDetached(response.body, error);
      throw error;
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let receivedChunks = 0;
  let complete = false;
  let failure: unknown;
  try {
    for (;;) {
      const next = await readWithSignal(reader, signal);
      signal?.throwIfAborted();
      if (next.done) {
        complete = true;
        break;
      }
      receivedChunks += 1;
      if (receivedChunks > MAX_RESPONSE_BODY_CHUNKS) {
        throw responseBodyTooLarge(response);
      }
      if (next.value.byteLength === 0) continue;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BODY_BYTES) {
        throw responseBodyTooLarge(response);
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    // error-policy:J2 Preserve the selected read or abort failure through teardown.
    failure = error;
    throw error;
  } finally {
    if (complete) releaseReaderNoThrow(reader);
    else cancelReaderDetached(reader, failure ?? signal?.reason);
  }
}

async function parseResponseBody(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, signal);
  if (!text) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {
    // error-policy:J3 declared-JSON parse failure returns a typed marker; the
    // caller surfaces it (error path) or throws (2xx), never a fake success.
    return {
      [malformedJsonBodyBrand]: true,
      kind: "malformed-json",
      text,
    } satisfies MalformedJsonBody;
  }
}

function responseWithOwnedBody(
  response: Response,
  deadline: RequestDeadline,
): Response {
  if (!response.body || !deadline.signal) {
    deadline.close();
    return response;
  }

  const signal = deadline.signal;
  const reader = response.body.getReader();
  let terminal = false;
  let streamController: ReadableByteStreamController | undefined;
  const onAbort = (): void => {
    const reason = signal.reason;
    fail(reason);
    streamController?.error(reason);
  };
  const removeAbortListener = (): void => {
    signal.removeEventListener("abort", onAbort);
  };
  const finish = (): void => {
    if (terminal) return;
    terminal = true;
    removeAbortListener();
    releaseReaderNoThrow(reader);
    deadline.close();
  };
  const fail = (reason: unknown): void => {
    if (terminal) return;
    terminal = true;
    removeAbortListener();
    cancelReaderDetached(reader, reason);
    deadline.close();
  };
  const bodySource: UnderlyingByteSource = {
    type: "bytes",
    start(controller) {
      streamController = controller;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const next = await Promise.race([reader.read(), deadline.aborted]);
        signal.throwIfAborted();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        if (next.value.byteLength === 0) return;
        controller.enqueue(next.value);
      } catch (error) {
        if (terminal) return;
        fail(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      fail(reason);
    },
  };
  const body = new ReadableStream(bodySource) as ReadableStream<Uint8Array>;
  const owned = new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  const nativeClone = owned.clone.bind(owned);
  Object.defineProperties(owned, {
    clone: {
      configurable: true,
      value: (): Response => responseWithMetadata(nativeClone(), response),
    },
    redirected: { configurable: true, value: response.redirected },
    type: { configurable: true, value: response.type },
    url: { configurable: true, value: response.url },
  });
  return owned;
}

function responseWithMetadata(response: Response, source: Response): Response {
  const nativeClone = response.clone.bind(response);
  Object.defineProperties(response, {
    clone: {
      configurable: true,
      value: (): Response => responseWithMetadata(nativeClone(), source),
    },
    redirected: { configurable: true, value: source.redirected },
    type: { configurable: true, value: source.type },
    url: { configurable: true, value: source.url },
  });
  return response;
}

function normalizeErrorBody(
  status: number,
  statusText: string,
  body: unknown,
): CloudApiErrorBody {
  if (isMalformedJsonBody(body)) {
    return {
      success: false,
      error: `HTTP ${status}: ${body.text}`,
    };
  }
  if (isRecord(body)) {
    const rawError = body.error;
    const errorObject = isRecord(rawError) ? rawError : null;
    const error =
      typeof rawError === "string"
        ? rawError
        : errorObject && typeof errorObject.message === "string"
          ? errorObject.message
          : typeof body.message === "string"
            ? body.message
            : `HTTP ${status}: ${statusText}`;

    return {
      success: false,
      error,
      code:
        typeof body.code === "string"
          ? body.code
          : errorObject && typeof errorObject.code === "string"
            ? errorObject.code
            : undefined,
      type:
        typeof body.type === "string"
          ? body.type
          : errorObject && typeof errorObject.type === "string"
            ? errorObject.type
            : undefined,
      details: isRecord(body.details) ? body.details : undefined,
      requiredCredits:
        typeof body.requiredCredits === "number"
          ? body.requiredCredits
          : undefined,
      quota: isQuota(body.quota) ? body.quota : undefined,
    };
  }

  return {
    success: false,
    error:
      typeof body === "string" && body.trim()
        ? `HTTP ${status}: ${body}`
        : `HTTP ${status}: ${statusText}`,
  };
}

function isQuota(value: unknown): value is { current: number; max: number } {
  return (
    isRecord(value) &&
    typeof value.current === "number" &&
    typeof value.max === "number"
  );
}

function requestDeadline(
  timeoutMs?: number,
  signal?: AbortSignal,
): RequestDeadline {
  signal?.throwIfAborted();
  const delayMs = timeoutMs ?? 0;
  const hasTimeout = delayMs !== 0;
  if (
    hasTimeout &&
    (!Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new RangeError(
      `Cloud request timeoutMs must be a timer-safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }

  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  if (!hasTimeout && !signal) {
    return { signal: undefined, aborted, close() {} };
  }

  const controller = hasTimeout ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let onCallerAbort: (() => void) | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (onCallerAbort) signal?.removeEventListener("abort", onCallerAbort);
  };
  const abort = (reason: unknown): void => {
    if (controller?.signal.aborted || closed) return;
    // Select caller-versus-timeout provenance before the transport can reject
    // its own pending operation with a generic AbortError.
    rejectAbort(reason);
    controller?.abort(reason);
    close();
  };
  if (signal) {
    onCallerAbort = (): void => abort(signal.reason);
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  if (hasTimeout) {
    timer = setTimeout(
      () =>
        abort(
          new DOMException(
            "The Cloud request deadline expired.",
            "TimeoutError",
          ),
        ),
      delayMs,
    );
  }
  return {
    signal: controller?.signal ?? signal,
    aborted,
    close,
  };
}

export class CloudApiError extends Error {
  readonly statusCode: number;
  readonly errorBody: CloudApiErrorBody;

  constructor(statusCode: number, body: CloudApiErrorBody) {
    super(body.error);
    this.name = "CloudApiError";
    this.statusCode = statusCode;
    this.errorBody = body;
  }
}

export class InsufficientCreditsError extends CloudApiError {
  readonly requiredCredits: number;

  constructor(body: CloudApiErrorBody) {
    super(402, body);
    this.name = "InsufficientCreditsError";
    this.requiredCredits = body.requiredCredits ?? 0;
  }
}

export class ElizaCloudHttpClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private bearerToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: HeadersInit | undefined;

  constructor(options: ElizaCloudClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl,
      DEFAULT_ELIZA_CLOUD_API_BASE_URL,
    );
    this.apiKey = options.apiKey;
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultHeaders = options.defaultHeaders;
  }

  setApiKey(key: string | undefined): void {
    this.apiKey = key;
  }

  setBearerToken(token: string | undefined): void {
    this.bearerToken = token;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = normalizeBaseUrl(url, DEFAULT_ELIZA_CLOUD_API_BASE_URL);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getApiKey(): string | undefined {
    return this.apiKey;
  }

  buildWsUrl(path: string): string {
    return `${this.baseUrl.replace(/^http/, "ws")}${ensureLeadingSlash(path)}`;
  }

  buildUrl(path: string, query?: QueryParams): string {
    return resolveUrl(this.baseUrl, path, query);
  }

  private async dispatchRequest(
    method: HttpMethod,
    path: string,
    options: CloudRequestOptions,
  ): Promise<{ response: Response; deadline: RequestDeadline }> {
    const deadline = requestDeadline(options.timeoutMs, options.signal);
    try {
      const headers = new Headers(this.defaultHeaders);
      const optionHeaders = new Headers(options.headers);
      for (const [key, value] of optionHeaders) {
        headers.set(key, value);
      }

      if (!options.skipAuth) {
        const token = this.bearerToken ?? this.apiKey;
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        if (this.apiKey) {
          headers.set("X-API-Key", this.apiKey);
        }
      } else {
        headers.delete("Authorization");
        headers.delete("X-API-Key");
      }

      const init: RequestInit = {
        method,
        headers,
        signal: deadline.signal,
      };

      if (options.json !== undefined) {
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        init.body = JSON.stringify(options.json);
      } else if (options.body !== undefined) {
        init.body = options.body;
      }

      deadline.signal?.throwIfAborted();
      const fetchPromise = this.fetchImpl(
        this.buildUrl(path, options.query),
        init,
      );
      void fetchPromise.then(
        (lateResponse) => {
          if (deadline.signal?.aborted) {
            cancelBodyDetached(lateResponse.body, deadline.signal.reason);
          }
        },
        () => {
          // error-policy:J5 The same fetch rejection is observed by the race below.
        },
      );
      const response = await Promise.race([fetchPromise, deadline.aborted]);
      return { response, deadline };
    } catch (error) {
      deadline.close();
      throw error;
    }
  }

  async requestRaw(
    method: HttpMethod,
    path: string,
    options: CloudRequestOptions = {},
  ): Promise<Response> {
    const { response, deadline } = await this.dispatchRequest(
      method,
      path,
      options,
    );
    try {
      return responseWithOwnedBody(response, deadline);
    } catch (error) {
      deadline.close();
      cancelBodyDetached(response.body, error);
      throw error;
    }
  }

  async request<TResponse>(
    method: HttpMethod,
    path: string,
    options: CloudRequestOptions = {},
  ): Promise<TResponse> {
    const { response, deadline } = await this.dispatchRequest(
      method,
      path,
      options,
    );
    try {
      const body = await parseResponseBody(response, deadline.signal);

      if (!response.ok) {
        const errorBody = normalizeErrorBody(
          response.status,
          response.statusText,
          body,
        );
        throw response.status === 402
          ? new InsufficientCreditsError(errorBody)
          : new CloudApiError(response.status, errorBody);
      }

      // A 2xx that promised JSON but delivered unparseable bytes is a broken
      // response, not a success — surface it instead of fabricating one.
      if (isMalformedJsonBody(body)) {
        throw new CloudApiError(response.status, {
          success: false,
          error: `HTTP ${response.status}: malformed JSON response body: ${body.text}`,
        });
      }

      if (body === undefined || typeof body === "string") {
        return { success: true } as TResponse;
      }

      return body as TResponse;
    } finally {
      deadline.close();
    }
  }

  async get<TResponse>(
    path: string,
    options?: CloudRequestOptions,
  ): Promise<TResponse> {
    return this.request<TResponse>("GET", path, options);
  }

  async post<TResponse>(
    path: string,
    body?: unknown,
    options: Omit<CloudRequestOptions, "json"> = {},
  ): Promise<TResponse> {
    return this.request<TResponse>("POST", path, { ...options, json: body });
  }

  async put<TResponse>(
    path: string,
    body?: unknown,
    options: Omit<CloudRequestOptions, "json"> = {},
  ): Promise<TResponse> {
    return this.request<TResponse>("PUT", path, { ...options, json: body });
  }

  async patch<TResponse>(
    path: string,
    body?: unknown,
    options: Omit<CloudRequestOptions, "json"> = {},
  ): Promise<TResponse> {
    return this.request<TResponse>("PATCH", path, { ...options, json: body });
  }

  async delete<TResponse>(
    path: string,
    options?: CloudRequestOptions,
  ): Promise<TResponse> {
    return this.request<TResponse>("DELETE", path, options);
  }
}

export class CloudApiClient extends ElizaCloudHttpClient {
  constructor(
    baseUrl: string = DEFAULT_ELIZA_CLOUD_API_BASE_URL,
    apiKey?: string,
    options: Omit<
      ElizaCloudClientOptions,
      "apiBaseUrl" | "apiKey" | "baseUrl"
    > = {},
  ) {
    super({ ...options, baseUrl, apiKey });
  }

  async postUnauthenticated<TResponse>(
    path: string,
    body: unknown,
  ): Promise<TResponse> {
    return this.post<TResponse>(path, body, { skipAuth: true });
  }
}
