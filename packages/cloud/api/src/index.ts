/**
 * Cloud API — Cloudflare Workers entrypoint (thin bootstrap).
 *
 * The full Hono stack lives in `./bootstrap-app.ts` and is loaded on first
 * `fetch` / `scheduled` invocation so Worker startup stays under Cloudflare's
 * CPU budget (error 10021).
 *
 *   bun run codegen   # regen the router after adding/removing routes
 *   bun run dev       # wrangler dev
 *   bun run deploy    # wrangler deploy
 */

import "./worker-polyfills";

import type { Hono } from "hono";
import { makeCronHandler } from "@/lib/cron/cloudflare-cron";
import type { AppEnv } from "@/types/cloud-worker-env";
import { serveBlobHostRequest } from "./blob-host";

let appPromise: Promise<Hono<AppEnv>> | undefined;
const AGENT_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEFAULT_AGENT_BASE_DOMAIN = "elizacloud.ai";
const FRONTEND_ALIAS_TARGETS: Record<
  string,
  { appHost: string; apiHost: string }
> = {
  "app.elizacloud.ai": {
    appHost: "eliza-app.pages.dev",
    apiHost: "api.elizacloud.ai",
  },
  "app-staging.elizacloud.ai": {
    appHost: "develop.eliza-app.pages.dev",
    apiHost: "api-staging.elizacloud.ai",
  },
  "staging.elizacloud.ai": {
    appHost: "develop.eliza-cloud-enq.pages.dev",
    apiHost: "api-staging.elizacloud.ai",
  },
};
type AgentDomainBindings = Pick<
  AppEnv["Bindings"],
  "AGENT_ROUTER_ORIGIN_HOST" | "ELIZA_CLOUD_AGENT_BASE_DOMAIN"
>;

async function getApp(): Promise<Hono<AppEnv>> {
  appPromise ??= import("./bootstrap-app").then((m) => m.createApp());
  return appPromise;
}

function healthResponse(env: AppEnv["Bindings"]): Response {
  return Response.json(
    {
      status: "ok",
      timestamp: Date.now(),
      region: (env as { CF_REGION?: string }).CF_REGION ?? "unknown",
      commit: env.ELIZA_DEPLOY_COMMIT ?? null,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}

function normalizeHostname(hostname: string | undefined): string | null {
  const normalized = hostname?.trim().toLowerCase().replace(/\.+$/, "");
  return normalized || null;
}

function normalizeOriginHost(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const origin = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return null;
    }
    return normalizeHostname(origin.host);
  } catch {
    // error-policy:J3 untrusted origin header parse; null = reject (unparseable
    // origin is not a valid host and must not be matched against the allowlist).
    return null;
  }
}

function getGeneratedAgentId(
  url: URL,
  env: AgentDomainBindings,
): string | null {
  const baseDomain =
    normalizeHostname(env.ELIZA_CLOUD_AGENT_BASE_DOMAIN) ??
    DEFAULT_AGENT_BASE_DOMAIN;
  const suffix = `.${baseDomain}`;
  const hostname = normalizeHostname(url.hostname);
  if (!hostname?.endsWith(suffix)) return null;
  const subdomain = hostname.slice(0, -suffix.length);
  return AGENT_ID_RE.test(subdomain) ? subdomain : null;
}

export function redirectFrontendHost(
  url: URL,
  env: AgentDomainBindings,
): Response | null {
  const baseDomain =
    normalizeHostname(env.ELIZA_CLOUD_AGENT_BASE_DOMAIN) ??
    DEFAULT_AGENT_BASE_DOMAIN;
  const hostname = normalizeHostname(url.hostname);
  // `www.` 308s to the apex (the canonical lander + dashboard / "console"
  // origin), preserving path + query. `app.<base>` is deliberately NOT
  // redirected: under the D5 topology split it serves the Eliza agent app
  // (the `eliza-app` Pages project), a separate surface from the apex console.
  // Redirecting it here would bury the app under the console.
  if (hostname !== `www.${baseDomain}`) {
    return null;
  }

  const targetUrl = new URL(url);
  targetUrl.hostname = baseDomain;
  return Response.redirect(targetUrl.toString(), 308);
}

// The Feed app's public host. Feed runs on Railway and serves both its pages and
// its own `/api/*` from one origin, so the wildcard `*.elizacloud.ai/*` Worker
// route would otherwise swallow it (see packages/feed/RAILWAY.md). When the
// operator sets `FEED_ORIGIN_HOST` (the Railway host) this Worker reverse-proxies
// the host to Railway; unset = inert (request falls through to cloud-api as before).
const FEED_ALIAS_HOST = "feed.elizacloud.ai";
const FEED_OBSERVABILITY_SCRIPT_PATHS = new Set([
  "/_vercel/insights/script.js",
  "/_vercel/speed-insights/script.js",
]);
const FEED_PRESET_PFP_PATTERN = /^\/assets\/user-pfps\/pfp-\d{3}\.png$/;
const FRONTEND_ALIAS_PROXY_HEADER_DENYLIST = new Set([
  "cdn-loop",
  "connection",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-real-ip",
]);

export function getFrontendAliasProxyTarget(
  url: URL,
  env?: { FEED_ORIGIN_HOST?: string },
): URL | null {
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return null;

  // Config-gated Feed passthrough. Single origin for pages + API, so no app/api
  // split. Inert unless FEED_ORIGIN_HOST is set.
  if (hostname === FEED_ALIAS_HOST) {
    const feedOrigin = normalizeOriginHost(env?.FEED_ORIGIN_HOST);
    if (!feedOrigin) return null;
    const feedUrl = new URL(url);
    feedUrl.host = feedOrigin;
    return feedUrl;
  }

  const target = FRONTEND_ALIAS_TARGETS[hostname];
  if (!target) return null;

  const apiTarget = getFrontendAliasApiProxyTarget(url);
  if (apiTarget) return apiTarget;

  const targetUrl = new URL(url);
  targetUrl.hostname = target.appHost;
  return targetUrl;
}

function isFrontendAliasBackendPath(url: URL): boolean {
  return (
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/steward" ||
    url.pathname.startsWith("/steward/")
  );
}

export function getFrontendAliasApiProxyTarget(url: URL): URL | null {
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return null;

  const target = FRONTEND_ALIAS_TARGETS[hostname];
  if (!target || !isFrontendAliasBackendPath(url)) return null;

  const targetUrl = new URL(url);
  targetUrl.hostname = target.apiHost;
  return targetUrl;
}

export function getFrontendAliasSyntheticResponse(url: URL): Response | null {
  const hostname = normalizeHostname(url.hostname);
  if (hostname !== FEED_ALIAS_HOST) return null;

  if (FEED_OBSERVABILITY_SCRIPT_PATHS.has(url.pathname)) {
    return new Response("", {
      status: 200,
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }

  if (FEED_PRESET_PFP_PATTERN.test(url.pathname)) {
    const fallbackUrl = new URL(url);
    fallbackUrl.pathname = "/blankmonkey.png";
    fallbackUrl.search = "";
    return Response.redirect(fallbackUrl.toString(), 302);
  }

  return null;
}

function proxyFrontendAliasRequest(
  request: Request,
  url: URL,
  env: AppEnv["Bindings"],
): Promise<Response> | null {
  const syntheticResponse = getFrontendAliasSyntheticResponse(url);
  if (syntheticResponse) return Promise.resolve(syntheticResponse);

  const targetUrl = getFrontendAliasProxyTarget(
    url,
    env as { FEED_ORIGIN_HOST?: string },
  );
  if (!targetUrl) return null;

  return fetch(
    targetUrl.toString(),
    createFrontendAliasProxyInit(request, url),
  );
}

function createFrontendAliasProxyInit(request: Request, url: URL): RequestInit {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const headerName = name.toLowerCase();
    if (
      FRONTEND_ALIAS_PROXY_HEADER_DENYLIST.has(headerName) ||
      headerName.startsWith("cf-")
    ) {
      continue;
    }
    headers.append(name, value);
  }

  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) {
    headers.set("x-forwarded-for", connectingIp);
    headers.set("x-real-ip", connectingIp);
  }
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }

  return init;
}

function proxyGeneratedAgentRequest(
  request: Request,
  env: AppEnv["Bindings"],
  url: URL,
): Promise<Response> | null {
  const agentId = getGeneratedAgentId(url, env);
  if (!agentId) return null;

  // Unified cloud-token auth + tailnet proxy for dedicated agents. Lazy-imported
  // so this entrypoint stays thin (Cloudflare startup-CPU budget) — the auth/DB
  // module only loads on an actual UUID-subdomain request.
  return import("./dedicated-agent-proxy").then((m) =>
    m.handleDedicatedAgentProxy(request, env, url, agentId),
  );
}

/**
 * Managed frontend hosting (#10690): when `ELIZA_FRONTEND_HOST_SUFFIX` is set,
 * a non-API request to `<app-slug>.<suffix>` is served from the app's active
 * frontend deployment. We rewrite it to the internal public serve route (which
 * has DB + R2 bootstrapped) rather than resolving in this thin entrypoint.
 * Opt-in: returns null (no-op) when the suffix env is unset. `/api/*` and
 * `/steward/*` on a system host still reach the API (so the page-view beacon and
 * app APIs work), so only non-API paths are rewritten.
 */
export function getHostedFrontendServeRewrite(
  url: URL,
  env: { ELIZA_FRONTEND_HOST_SUFFIX?: string },
): URL | null {
  const suffix = normalizeHostname(env.ELIZA_FRONTEND_HOST_SUFFIX)?.replace(
    /^\.+/,
    "",
  );
  if (!suffix) return null;
  const hostname = normalizeHostname(url.hostname);
  if (!hostname?.endsWith(`.${suffix}`)) return null;
  const slug = hostname.slice(0, hostname.length - suffix.length - 1);
  if (!slug || slug.includes(".")) return null;
  if (isFrontendAliasBackendPath(url)) return null;

  const rewritten = new URL(url);
  rewritten.pathname = `/api/v1/hosted-frontend/serve${url.pathname === "/" ? "" : url.pathname}`;
  rewritten.searchParams.set("host", hostname);
  return rewritten;
}

const scheduled = makeCronHandler(async (request, env, ctx) =>
  (await getApp()).fetch(request, env, ctx),
);

export default {
  fetch: async (
    request: Request,
    env: AppEnv["Bindings"],
    ctx: ExecutionContext,
  ) => {
    const url = new URL(request.url);
    const frontendAliasApiTarget = getFrontendAliasApiProxyTarget(url);
    if (frontendAliasApiTarget) {
      if (frontendAliasApiTarget.pathname === "/api/health") {
        return healthResponse(env);
      }

      const apiRequest = new Request(
        frontendAliasApiTarget.toString(),
        createFrontendAliasProxyInit(request, url),
      );
      return (await getApp()).fetch(apiRequest, env, ctx);
    }

    const frontendAliasResponse = proxyFrontendAliasRequest(request, url, env);
    if (frontendAliasResponse) return frontendAliasResponse;
    const blobResponse = await serveBlobHostRequest(request, url, env);
    if (blobResponse) return blobResponse;
    const agentProxyResponse = proxyGeneratedAgentRequest(request, env, url);
    if (agentProxyResponse) return agentProxyResponse;
    const frontendRedirect = redirectFrontendHost(url, env);
    if (frontendRedirect) return frontendRedirect;

    const hostedFrontendServe = getHostedFrontendServeRewrite(url, env);
    if (hostedFrontendServe) {
      return (await getApp()).fetch(
        new Request(hostedFrontendServe, request),
        env,
        ctx,
      );
    }

    if (url.pathname === "/api/health") {
      return healthResponse(env);
    }

    // OpenAI-compat prefix rewrite. Dedicated agents whose cloud base/embedding
    // URL got stamped as the bare host (`https://api.elizacloud.ai`) hit
    // `/v1/embeddings` / `/embeddings` (and would for `/chat/completions`),
    // which 404 because the canonical routes live under `/api/v1/*`. Accept the
    // OpenAI-style prefixes by rewriting to `/api/v1/*` so embeddings + inference
    // work regardless of the agent's baked base URL. Cloud routes are all under
    // `/api/`, so `/v1/*` and bare `/embeddings`/`/chat/completions` are
    // otherwise-unused (404) and safe to remap.
    const p = url.pathname;
    if (
      p.startsWith("/v1/") ||
      p === "/embeddings" ||
      p === "/chat/completions"
    ) {
      const rewrittenUrl = new URL(url);
      rewrittenUrl.pathname = p.startsWith("/v1/") ? `/api${p}` : `/api/v1${p}`;
      return (await getApp()).fetch(
        new Request(rewrittenUrl, request),
        env,
        ctx,
      );
    }

    return (await getApp()).fetch(request, env, ctx);
  },

  scheduled,
};
