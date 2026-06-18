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

let appPromise: Promise<Hono<AppEnv>> | undefined;
const AGENT_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEFAULT_AGENT_BASE_DOMAIN = "elizacloud.ai";
const DEFAULT_AGENT_ROUTER_ORIGIN_HOST = "eliza-production-1.elizacloud.ai";
const FRONTEND_ALIAS_TARGETS: Record<
  string,
  { appHost: string; apiHost: string }
> = {
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
  // `www.` and `app.` both 308 to the apex (the canonical login + dashboard
  // origin). `app.<base>` is an intuitive host humans type/bookmark for "the
  // app", but the API Worker's `*.<base>/*` route claims it — so
  // `app.<base>/login` hits the Worker and 404s (no SPA) and the user cannot
  // sign in. Redirect the whole host to the apex, preserving path + query.
  if (hostname !== `www.${baseDomain}` && hostname !== `app.${baseDomain}`) {
    return null;
  }

  const targetUrl = new URL(url);
  targetUrl.hostname = baseDomain;
  return Response.redirect(targetUrl.toString(), 308);
}

export function getFrontendAliasProxyTarget(url: URL): URL | null {
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return null;
  const target = FRONTEND_ALIAS_TARGETS[hostname];
  if (!target) return null;

  const isBackendPath =
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/steward" ||
    url.pathname.startsWith("/steward/");
  const targetUrl = new URL(url);
  targetUrl.hostname = isBackendPath ? target.apiHost : target.appHost;
  return targetUrl;
}

function proxyFrontendAliasRequest(
  request: Request,
  url: URL,
): Promise<Response> | null {
  const targetUrl = getFrontendAliasProxyTarget(url);
  if (!targetUrl) return null;

  const headers = new Headers(request.headers);
  headers.delete("host");
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

  return fetch(new Request(targetUrl, init));
}

function proxyGeneratedAgentRequest(
  request: Request,
  env: AppEnv["Bindings"],
  url: URL,
): Promise<Response> | null {
  if (!getGeneratedAgentId(url, env)) return null;

  const originHost =
    normalizeHostname(env.AGENT_ROUTER_ORIGIN_HOST) ??
    DEFAULT_AGENT_ROUTER_ORIGIN_HOST;
  const targetUrl = new URL(request.url);
  targetUrl.hostname = originHost;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return fetch(new Request(targetUrl, init));
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
    const frontendAliasResponse = proxyFrontendAliasRequest(request, url);
    if (frontendAliasResponse) return frontendAliasResponse;
    const agentProxyResponse = proxyGeneratedAgentRequest(request, env, url);
    if (agentProxyResponse) return agentProxyResponse;
    const frontendRedirect = redirectFrontendHost(url, env);
    if (frontendRedirect) return frontendRedirect;

    if (url.pathname === "/api/health") {
      return healthResponse(env);
    }

    return (await getApp()).fetch(request, env, ctx);
  },

  scheduled,
};
