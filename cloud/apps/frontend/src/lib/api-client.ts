/**
 * Typed fetch wrapper for the SPA. All `/api/*` calls go through this so
 * we have one place that:
 *
 * - injects credentials (the steward-token cookie + Authorization Bearer
 *   from localStorage when present)
 * - resolves the API base URL (same-origin in browsers, configured base URL
 *   only in SSR/scripts)
 * - throws structured errors on non-2xx
 *
 * Usage:
 *   const me = await api<MeResponse>("/api/users/me");
 *   await api("/api/v1/apps/123", { method: "DELETE" });
 */

const STEWARD_TOKEN_KEY = "steward_session_token";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function getApiBaseUrl(): string {
  if (typeof window !== "undefined") return "";

  const fromEnv =
    import.meta.env.VITE_API_URL ?? import.meta.env.NEXT_PUBLIC_API_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0)
    return fromEnv.replace(/\/+$/, "");
  return "";
}

function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    const parsed = new URL(path);
    if (typeof window !== "undefined") {
      if (parsed.origin !== window.location.origin) {
        throw new ApiError(
          0,
          "CROSS_ORIGIN_API_URL",
          "Browser API calls must use same-origin paths so auth cookies and tokens stay scoped to Eliza Cloud.",
        );
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return path;
  }

  if (!path.startsWith("/")) {
    throw new ApiError(0, "INVALID_API_PATH", "API paths must start with '/'.");
  }

  return `${getApiBaseUrl()}${path}`;
}

function readStewardToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STEWARD_TOKEN_KEY);
  } catch {
    return null;
  }
}

export interface ApiRequestInit extends Omit<RequestInit, "body"> {
  /** JSON body — automatically serialized + Content-Type applied. */
  json?: unknown;
  /** Raw body (string / FormData / Blob). Mutually exclusive with `json`. */
  body?: BodyInit | null;
  /** Skip steward token injection (e.g. for the steward-session endpoint itself). */
  skipAuth?: boolean;
}

async function readPayload(
  res: Response,
  strictJson: boolean,
): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  if (!isJson) return res.text();

  try {
    return await res.json();
  } catch {
    if (strictJson) {
      throw new ApiError(
        res.status,
        "INVALID_JSON_RESPONSE",
        `API returned invalid JSON with status ${res.status}`,
      );
    }
    return null;
  }
}

function errorDetails(
  payload: unknown,
  status: number,
): { code: string; message: string } {
  if (typeof payload === "object" && payload) {
    const body = payload as {
      error?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const message =
      (typeof body.error === "string" && body.error) ||
      (typeof body.message === "string" && body.message) ||
      `Request failed with status ${status}`;
    const code =
      typeof body.code === "string" && body.code ? body.code : `HTTP_${status}`;
    return { code, message };
  }

  if (typeof payload === "string" && payload) {
    const trimmed = payload.trim();
    const message = trimmed.startsWith("<")
      ? `Request failed with status ${status}; API returned a non-JSON response`
      : trimmed.slice(0, 500);
    return { code: `HTTP_${status}`, message };
  }

  return {
    code: `HTTP_${status}`,
    message: `Request failed with status ${status}`,
  };
}

export async function apiFetch(
  path: string,
  init: ApiRequestInit = {},
): Promise<Response> {
  const { json, body, skipAuth, headers: rawHeaders, ...rest } = init;

  const headers = new Headers(rawHeaders);
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (!skipAuth) {
    const token = readStewardToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const url = resolveApiUrl(path);

  const res = await fetch(url, {
    ...rest,
    credentials: "include",
    headers,
    body: json !== undefined ? JSON.stringify(json) : (body ?? null),
  });

  if (!res.ok) {
    const payload = await readPayload(res, false);
    const { code, message } = errorDetails(payload, res.status);
    throw new ApiError(res.status, code, message, payload);
  }

  return res;
}

export async function api<T = unknown>(
  path: string,
  init: ApiRequestInit = {},
): Promise<T> {
  const res = await apiFetch(path, init);
  const payload = await readPayload(res, true);

  return payload as T;
}
