/**
 * Base client for elizacloud API.
 * Default: https://www.elizacloud.ai — override via VITE_ELIZACLOUD_API_URL.
 * Calls the backend directly; no local proxy.
 */

const ELIZACLOUD_DEFAULT_URL = "https://www.elizacloud.ai";

function getBaseUrl(): string {
  return (
    import.meta.env.VITE_ELIZACLOUD_API_URL ?? ELIZACLOUD_DEFAULT_URL
  ).replace(/\/$/, "");
}

export function getElizacloudUrl(): string {
  return getBaseUrl();
}

export type ApiRequestInit = RequestInit & {
  params?: Record<string, string>;
};

function buildUrl(path: string, params?: Record<string, string>): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalizedPath, getBaseUrl());
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      url.searchParams.set(k, v);
    });
  }
  return url.toString();
}

export async function elizacloudFetch<T = unknown>(
  path: string,
  init?: ApiRequestInit,
): Promise<T> {
  const { params, ...reqInit } = init ?? {};
  const url = buildUrl(path, params);
  const res = await fetch(url, {
    ...reqInit,
    headers: {
      "Content-Type": "application/json",
      ...reqInit.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`elizacloud API error ${res.status}: ${text}`);
  }
  const contentType = res.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  return res.text() as Promise<T>;
}

const SESSION_STORAGE_KEY = "eliza_app_session";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SESSION_STORAGE_KEY);
}

export async function elizacloudAuthFetch<T = unknown>(
  path: string,
  init?: ApiRequestInit,
): Promise<T> {
  const token = getAuthToken();
  const authHeaders: Record<string, string> = {};
  if (token) {
    authHeaders.Authorization = `Bearer ${token}`;
  }
  return elizacloudFetch<T>(path, {
    ...init,
    headers: {
      ...authHeaders,
      ...init?.headers,
    },
  });
}

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function elizacloudAuthFetchStrict<T = unknown>(
  path: string,
  init?: ApiRequestInit,
): Promise<T> {
  const token = getAuthToken();
  if (!token) {
    throw new UnauthorizedError("No auth token");
  }

  const { params, ...reqInit } = init ?? {};
  const url = buildUrl(path, params);
  const res = await fetch(url, {
    ...reqInit,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...reqInit.headers,
    },
  });

  if (res.status === 401) {
    throw new UnauthorizedError("Session expired");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`elizacloud API error ${res.status}: ${text}`);
  }

  const contentType = res.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  return res.text() as Promise<T>;
}
