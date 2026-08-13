/**
 * Plugin-registry artifact serving for the registry host
 * (`plugins.eliza.app` / `plugins-staging.eliza.app`).
 *
 * The canonical registry data URL (`packages/registry` README + types) is
 * `plugins.eliza.app/generated-registry.json`, but the managed-agent wildcard
 * Worker route shadows the host — the same disease the
 * blob host has (see `blob-host.ts`) — so every registry fetch 404'd on this
 * worker's JSON router even though the artifact is committed in-repo and raw
 * GitHub serves it fine.
 *
 * This handler makes the worker itself serve the host: GET/HEAD requests for
 * a deny-by-default allowlist of registry artifacts are proxied from raw
 * GitHub (the committed artifact is the source of truth; it is regenerated on
 * `develop`, so both prod and staging hosts serve the current registry rather
 * than a promote-lagged copy). Anything else on the host stays a JSON 404.
 */

import { ELIZA_SERVICE_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Deny-by-default allowlist of served artifact paths → upstream raw-GitHub
 * URLs. Add a path only when `packages/registry` documents it as a published
 * artifact consumed over HTTP.
 */
const REGISTRY_ARTIFACTS: Readonly<Record<string, string>> = {
  "/generated-registry.json":
    "https://raw.githubusercontent.com/elizaOS/eliza/develop/packages/registry/generated-registry.json",
};

/** Worker-edge + client cache horizon. The artifact changes only when a
 * registry PR lands on develop; five minutes keeps consumers fresh without
 * hammering raw GitHub. */
const CACHE_TTL_SECONDS = 300;

/** The only binding this handler reads — narrow so tests need no casts. */
type RegistryHostBindings = Pick<
  AppEnv["Bindings"],
  "ELIZA_CLOUD_AGENT_BASE_DOMAIN"
>;

function registryHosts(env: RegistryHostBindings): readonly string[] {
  const environment = env.ELIZA_CLOUD_AGENT_BASE_DOMAIN?.includes("staging")
    ? "staging"
    : "production";
  return [
    new URL(ELIZA_SERVICE_DOMAIN_CONTRACTS[environment].pluginRegistryOrigin)
      .hostname,
  ];
}

function notFound(): Response {
  return Response.json(
    { success: false, error: "Not found", code: "resource_not_found" },
    { status: 404 },
  );
}

export async function serveRegistryHostRequest(
  request: Request,
  url: URL,
  env: RegistryHostBindings,
): Promise<Response | null> {
  if (!registryHosts(env).includes(url.hostname.toLowerCase())) return null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      {
        success: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      },
      { status: 405, headers: { allow: "GET, HEAD" } },
    );
  }

  const upstreamUrl = REGISTRY_ARTIFACTS[url.pathname];
  if (!upstreamUrl) return notFound();

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
  } catch {
    // error-policy:J1 boundary translation — a rejected upstream fetch (DNS
    // failure, connection reset to raw GitHub) fails closed as this host's own
    // JSON 404; the worker entry has no other catch on this path, so letting it
    // escape would surface a Cloudflare 1101 exception page instead.
    return notFound();
  }
  if (!upstream.ok) {
    // Fail closed with this host's own 404 shape — never leak the upstream
    // response through as if it were the artifact.
    return notFound();
  }

  const headers = new Headers();
  // raw GitHub labels .json as text/plain; restore the artifact's contract.
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}`);
  // Registry data is public and consumed cross-origin (docs site, app UIs).
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(upstream.body, { status: 200, headers });
}
