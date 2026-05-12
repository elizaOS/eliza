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
  return value.replace(/\/+$/, "");
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

  const params = query instanceof URLSearchParams ? query : new URLSearchParams();

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

function appendQueryValue(params: URLSearchParams, key: string, value: QueryValue | QueryValue[]) {
  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(params, key, item);
    }
    return;
  }
  if (value === null || value === undefined) return;
  params.append(key, String(value));
}

function resolveUrl(baseUrl: string, path: string, query?: QueryParams): string {
  const url = /^https?:\/\//i.test(path)
    ? new URL(path)
    : new URL(`${trimTrailingSlash(baseUrl)}${ensureLeadingSlash(path)}`);
  return appendQuery(url, query).toString();
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeErrorBody(status: number, statusText: string, body: unknown): CloudApiErrorBody {
  if (isRecord(body)) {
    const rawError = body.error;
    const error =
      typeof rawError === "string"
        ? rawError
        : isRecord(rawError) && typeof rawError.message === "string"
          ? rawError.message
          : typeof body.message === "string"
            ? body.message
            : `HTTP ${status}: ${statusText}`;

    return {
      success: false,
      error,
      details: isRecord(body.details) ? body.details : undefined,
      requiredCredits: typeof body.requiredCredits === "number" ? body.requiredCredits : undefined,
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
  return isRecord(value) && typeof value.current === "number" && typeof value.max === "number";
}

function timeoutSignal(timeoutMs?: number, signal?: AbortSignal): AbortSignal | undefined {
  if (signal) return signal;
  if (!timeoutMs) return undefined;
  return AbortSignal.timeout(timeoutMs);
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
    this.baseUrl = normalizeBaseUrl(options.baseUrl, DEFAULT_ELIZA_CLOUD_API_BASE_URL);
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

  async requestRaw(
    method: HttpMethod,
    path: string,
    options: CloudRequestOptions = {},
  ): Promise<Response> {
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
    }

    const init: RequestInit = {
      method,
      headers,
      signal: timeoutSignal(options.timeoutMs, options.signal),
    };

    if (options.json !== undefined) {
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      init.body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
      init.body = options.body;
    }

    return this.fetchImpl(this.buildUrl(path, options.query), init);
  }

  async request<TResponse>(
    method: HttpMethod,
    path: string,
    options: CloudRequestOptions = {},
  ): Promise<TResponse> {
    const response = await this.requestRaw(method, path, options);
    const body = await parseResponseBody(response);

    if (!response.ok) {
      const errorBody = normalizeErrorBody(response.status, response.statusText, body);
      throw response.status === 402
        ? new InsufficientCreditsError(errorBody)
        : new CloudApiError(response.status, errorBody);
    }

    if (body === undefined || typeof body === "string") {
      return { success: true } as TResponse;
    }

    return body as TResponse;
  }

  async get<TResponse>(path: string, options?: CloudRequestOptions): Promise<TResponse> {
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

  async delete<TResponse>(path: string, options?: CloudRequestOptions): Promise<TResponse> {
    return this.request<TResponse>("DELETE", path, options);
  }
}

export class CloudApiClient extends ElizaCloudHttpClient {
  constructor(
    baseUrl: string = DEFAULT_ELIZA_CLOUD_API_BASE_URL,
    apiKey?: string,
    options: Omit<ElizaCloudClientOptions, "apiBaseUrl" | "apiKey" | "baseUrl"> = {},
  ) {
    super({ ...options, baseUrl, apiKey });
  }

  async postUnauthenticated<TResponse>(path: string, body: unknown): Promise<TResponse> {
    return this.post<TResponse>(path, body, { skipAuth: true });
  }
}
