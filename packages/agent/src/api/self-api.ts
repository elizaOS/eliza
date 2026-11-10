/**
 * Read-only calls back into this agent's own API.
 *
 * With a listener of our own the call goes over HTTP; without one it runs in
 * process through the same route kernel and auth boundary, so the bearer never
 * leaves the process. Mutating calls do not use this: they fail fast when there
 * is no listener (see self-api-endpoint.ts).
 */
import { createSelfApiRequestHeaders } from "@elizaos/host/protocol";
import type { DispatchRouteArgs } from "./dispatch-route.ts";
import { dispatchApiRoute } from "./in-process-api.ts";
import { resolveSelfApiTcpBaseUrl } from "./self-api-endpoint.ts";

export interface SelfApiReadRequest {
  runtime: DispatchRouteArgs["runtime"];
  path: string;
  query?: Record<string, string>;
  isAuthorized: () => boolean;
  timeoutMs: number;
}

export interface SelfApiResponse {
  status: number;
  /** Parsed JSON for a 2xx response; undefined otherwise. */
  body: unknown;
}

export async function callSelfApi({
  runtime,
  path,
  query,
  isAuthorized,
  timeoutMs,
}: SelfApiReadRequest): Promise<SelfApiResponse> {
  if (!isAuthorized()) return { status: 401, body: undefined };
  const signal = AbortSignal.timeout(timeoutMs);
  const base = resolveSelfApiTcpBaseUrl(process.env);
  if (base === null) {
    const response = await dispatchApiRoute({
      runtime,
      inProcess: true,
      isAuthorized,
      method: "GET",
      path,
      ...(query ? { query } : {}),
      headers: createSelfApiRequestHeaders(),
      signal,
    });
    const ok = response.status >= 200 && response.status < 300;
    return { status: response.status, body: ok ? response.body : undefined };
  }
  const search = query ? new URLSearchParams(query).toString() : "";
  const response = await fetch(`${base}${path}${search ? `?${search}` : ""}`, {
    redirect: "error",
    headers: createSelfApiRequestHeaders(),
    signal,
  });
  return {
    status: response.status,
    body: response.ok ? await response.json() : undefined,
  };
}
