/**
 * Plugin-registry artifact serving for the registry host
 * (`plugins.elizacloud.ai` / `plugins.staging.elizacloud.ai`).
 *
 * The canonical registry data URL (`packages/registry` README + types) is
 * `plugins.elizacloud.ai/generated-registry.json`, but the wildcard
 * `*.elizacloud.ai/*` Worker route shadows the host — the same disease the
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

import type { AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_BASE_DOMAIN = "elizacloud.ai";

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
  const base =
    typeof env.ELIZA_CLOUD_AGENT_BASE_DOMAIN === "string" &&
    env.ELIZA_CLOUD_AGENT_BASE_DOMAIN.trim().length > 0
      ? env.ELIZA_CLOUD_AGENT_BASE_DOMAIN.trim().toLowerCase()
      : DEFAULT_BASE_DOMAIN;
  return [`plugins.${base}`, `plugins.staging.${base}`];
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

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  } as RequestInit);
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
