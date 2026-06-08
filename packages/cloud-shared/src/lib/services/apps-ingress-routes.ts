/**
 * Apps ingress route builders (Apps / Product 2) — pure construction of the
 * Caddy admin-API objects that make `<shortid>.apps.elizacloud.ai` reverse-proxy
 * to an app's container on its node.
 *
 * The front door: stock Caddy on the app node terminates TLS (on-demand, gated
 * by an `ask` endpoint) and routes each per-app hostname to that container's
 * published host port. Routes are managed LIVE via Caddy's admin API — the
 * daemon POSTs a route right after the container is marked running and DELETEs it
 * (by `@id`) on teardown — so adding/removing one app never reloads the others.
 *
 * Pure + IO-free, so the wire format is a unit-testable contract; the actual
 * HTTP calls live in `apps-ingress-provisioner`.
 */

export interface AppRouteInput {
  /** The app's public host, e.g. `abc12345.apps.elizacloud.ai`. */
  hostname: string;
  /** The app node the container runs on (private IP or hostname reachable by Caddy). */
  nodeHost: string;
  /** The published host port of the container on that node. */
  hostPort: number;
}

/** A Caddy admin-API route object (the subset we emit). */
export interface CaddyRoute {
  "@id": string;
  match: Array<{ host: string[] }>;
  handle: Array<{ handler: "reverse_proxy"; upstreams: Array<{ dial: string }> }>;
}

/**
 * Stable Caddy route `@id` for an app host — derived from the host's first label
 * (the app shortid). Lets the add be idempotent (re-POST replaces) and the delete
 * address the route by id without scanning.
 */
export function buildCaddyRouteId(hostname: string): string {
  const label = hostname.split(".")[0] ?? hostname;
  const safe = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `app-${safe}`;
}

/** The Caddy admin-API route: host-match -> reverse_proxy to `nodeHost:hostPort`. */
export function buildCaddyRoute(input: AppRouteInput): CaddyRoute {
  return {
    "@id": buildCaddyRouteId(input.hostname),
    match: [{ host: [input.hostname] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `${input.nodeHost}:${input.hostPort}` }],
      },
    ],
  };
}

/** Admin-API URL to APPEND a route to a server (POST the route object here). */
export function buildCaddyAddRouteUrl(adminBase: string, server = "srv0"): string {
  return `${adminBase.replace(/\/+$/, "")}/config/apps/http/servers/${server}/routes`;
}

/** Admin-API URL to address a route BY `@id` (DELETE / GET / PATCH). */
export function buildCaddyRouteByIdUrl(adminBase: string, routeId: string): string {
  return `${adminBase.replace(/\/+$/, "")}/id/${routeId}`;
}

/**
 * The on-demand-TLS `ask` URL Caddy hits (before issuing a LE cert for a
 * subdomain) to confirm the shortid is a live app — abuse prevention so an
 * attacker can't make Caddy spam Let's Encrypt for non-existent subdomains.
 */
export function buildOnDemandAskUrl(controlPlaneBase: string, shortid: string): string {
  return `${controlPlaneBase.replace(/\/+$/, "")}/api/apps/${encodeURIComponent(shortid)}/is-valid`;
}
