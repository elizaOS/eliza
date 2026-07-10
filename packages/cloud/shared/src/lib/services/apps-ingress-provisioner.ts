/**
 * Applies per-app reverse-proxy routes to a live Caddy admin API after a
 * container starts and removes them during teardown.
 *
 * Mutations go through Caddy's admin API (atomic per route) rather than a
 * Caddyfile reload, so adding/removing one app never blips the others. Each call
 * has a short timeout and fails fast unless a DELETE confirms the route is
 * already absent. This prevents a failed replacement from leaving duplicate
 * route identifiers or an unreachable deployment that appears healthy.
 *
 * `fetchImpl` is injectable so the client is unit-testable without a live Caddy;
 * the real wire format is proven against stock Caddy in
 * `scripts/verify-apps-ingress-routing.sh`.
 */

import { ElizaError } from "@elizaos/core";
import {
  type AppRouteInput,
  buildCaddyAddRouteUrl,
  buildCaddyRoute,
  buildCaddyRouteByIdUrl,
  buildCaddyRouteId,
} from "./apps-ingress-routes";

export interface IngressResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type IngressFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<IngressResponse>;

const DEFAULT_TIMEOUT_MS = 5000;

function resolveFetch(f?: IngressFetch): IngressFetch {
  if (f) return f;
  return globalThis.fetch as IngressFetch;
}

function caddyAdminRequest(adminBase: string): {
  adminHost: string;
  headers: Record<string, string>;
} {
  const adminUrl = new URL(adminBase);
  return {
    adminHost: adminUrl.host,
    headers: { Origin: adminUrl.origin },
  };
}

function mutationError(input: {
  operation: "add-route" | "remove-route" | "replace-route-delete";
  status?: number;
  hostname: string;
  adminHost: string;
  detail?: string;
  cause?: unknown;
}): ElizaError {
  const status = input.status === undefined ? "request" : String(input.status);
  const detail = input.detail ? `: ${input.detail}` : "";
  return new ElizaError(
    `[apps-ingress] ${input.operation} failed (${status}) for ${input.hostname} via ${input.adminHost}${detail}`,
    {
      code: "CADDY_ADMIN_MUTATION_FAILED",
      context: {
        operation: input.operation,
        status: input.status,
        hostname: input.hostname,
        adminHost: input.adminHost,
      },
      cause: input.cause,
      severity: "ephemeral",
    },
  );
}

async function responseDetail(res: IngressResponse): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch (cause) {
    // error-policy:J2 Preserve the body-read failure at the Caddy boundary.
    throw new ElizaError("[apps-ingress] failed to read Caddy admin error response", {
      code: "CADDY_ADMIN_RESPONSE_READ_FAILED",
      cause,
      severity: "ephemeral",
    });
  }
}

export interface AddRouteOpts extends AppRouteInput {
  /** Caddy admin API base, e.g. `http://127.0.0.1:2019`. */
  adminBase: string;
  /** HTTP server name in the Caddy config. Default `srv0`. */
  server?: string;
  fetchImpl?: IngressFetch;
  timeoutMs?: number;
}

/**
 * Add (idempotently) a per-app route: `<hostname>` -> reverse_proxy
 * `127.0.0.1:hostPort` (Caddy is co-located on the app node). Deletes any
 * existing route with the same `@id` first so a re-deploy replaces cleanly.
 * Throws on failure (caller should fail the deploy).
 */
export async function addAppRoute(opts: AddRouteOpts): Promise<void> {
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const route = buildCaddyRoute(opts);
  const routeId = route["@id"];
  const adminRequest = caddyAdminRequest(opts.adminBase);

  let deleteRes: IngressResponse;
  try {
    deleteRes = await fetchImpl(buildCaddyRouteByIdUrl(opts.adminBase, routeId), {
      method: "DELETE",
      headers: adminRequest.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // error-policy:J2 Classify transport failures at the Caddy mutation boundary.
    throw mutationError({
      operation: "replace-route-delete",
      hostname: opts.hostname,
      adminHost: adminRequest.adminHost,
      cause,
    });
  }
  if (!deleteRes.ok && deleteRes.status !== 404) {
    throw mutationError({
      operation: "replace-route-delete",
      status: deleteRes.status,
      hostname: opts.hostname,
      adminHost: adminRequest.adminHost,
      detail: await responseDetail(deleteRes),
    });
  }

  let res: IngressResponse;
  try {
    res = await fetchImpl(buildCaddyAddRouteUrl(opts.adminBase, opts.server), {
      method: "POST",
      headers: {
        ...adminRequest.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(route),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // error-policy:J2 Classify transport failures at the Caddy mutation boundary.
    throw mutationError({
      operation: "add-route",
      hostname: opts.hostname,
      adminHost: adminRequest.adminHost,
      cause,
    });
  }
  if (!res.ok) {
    throw mutationError({
      operation: "add-route",
      status: res.status,
      hostname: opts.hostname,
      adminHost: adminRequest.adminHost,
      detail: await responseDetail(res),
    });
  }
}

export interface RemoveRouteOpts {
  hostname: string;
  adminBase: string;
  fetchImpl?: IngressFetch;
  timeoutMs?: number;
}

/** Remove a per-app route by `@id`; a 404 confirms it is already gone. */
export async function removeAppRoute(opts: RemoveRouteOpts): Promise<void> {
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const routeId = buildCaddyRouteId(opts.hostname);
  const adminRequest = caddyAdminRequest(opts.adminBase);
  let res: IngressResponse;
  try {
    res = await fetchImpl(buildCaddyRouteByIdUrl(opts.adminBase, routeId), {
      method: "DELETE",
      headers: adminRequest.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // error-policy:J2 Classify transport failures at the Caddy mutation boundary.
    throw mutationError({
      operation: "remove-route",
      hostname: opts.hostname,
      adminHost: adminRequest.adminHost,
      cause,
    });
  }
  // 200 = removed, 404 = already absent; both are success for teardown.
  if (!res.ok && res.status !== 404) {
    throw mutationError({
      operation: "remove-route",
      status: res.status,
      hostname: opts.hostname,
      adminHost: adminRequest.adminHost,
    });
  }
}
