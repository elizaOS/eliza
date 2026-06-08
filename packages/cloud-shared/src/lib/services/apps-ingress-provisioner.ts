/**
 * Apps ingress provisioner (Apps / Product 2) — the thin IO layer that applies
 * the pure ingress routes ({@link ./apps-ingress-routes}) to a LIVE Caddy via its
 * admin API. Add a per-app reverse-proxy route after the container is running;
 * remove it (by `@id`) on teardown.
 *
 * Mutations go through Caddy's admin API (atomic per route) rather than a
 * Caddyfile reload, so adding/removing one app never blips the others. Each call
 * is best-effort with a short timeout; callers decide failure handling — fail
 * fast on add (so the user retries rather than getting a silent 502), log + carry
 * on for remove (a reconciler sweeps orphaned routes).
 *
 * `fetchImpl` is injectable so the client is unit-testable without a live Caddy;
 * the real wire format is proven against stock Caddy in
 * `scripts/verify-apps-ingress-routing.sh`.
 */

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
  return globalThis.fetch as unknown as IngressFetch;
}

async function safeText(res: IngressResponse): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
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
 * `nodeHost:hostPort`. Deletes any existing route with the same `@id` first so a
 * re-deploy replaces cleanly. Throws on failure (caller should fail the deploy).
 */
export async function addAppRoute(opts: AddRouteOpts): Promise<void> {
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const route = buildCaddyRoute(opts);
  const routeId = route["@id"];

  // best-effort delete of a stale same-id route (idempotent re-deploy)
  await fetchImpl(buildCaddyRouteByIdUrl(opts.adminBase, routeId), {
    method: "DELETE",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined);

  const res = await fetchImpl(buildCaddyAddRouteUrl(opts.adminBase, opts.server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(route),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(
      `[apps-ingress] add-route failed (${res.status}) for ${opts.hostname}: ${await safeText(res)}`,
    );
  }
}

export interface RemoveRouteOpts {
  hostname: string;
  adminBase: string;
  fetchImpl?: IngressFetch;
  timeoutMs?: number;
}

/** Remove a per-app route by `@id` (best-effort; a 404 means it's already gone). */
export async function removeAppRoute(opts: RemoveRouteOpts): Promise<void> {
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const routeId = buildCaddyRouteId(opts.hostname);
  const res = await fetchImpl(buildCaddyRouteByIdUrl(opts.adminBase, routeId), {
    method: "DELETE",
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 200 = removed, 404 = already absent; both are success for teardown.
  if (!res.ok && res.status !== 404) {
    throw new Error(`[apps-ingress] remove-route failed (${res.status}) for ${opts.hostname}`);
  }
}
