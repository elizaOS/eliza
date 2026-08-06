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

export { AnonymousChatGate } from "./anonymous-chat-gate";
export { InferenceAdmissionGate } from "./inference-admission-gate";
export { OnboardingSessionCoordinator } from "./onboarding-session-coordinator";
export { SharedRuntimeConversation } from "./shared-runtime-conversation";

let appPromise: Promise<Hono<AppEnv>> | undefined;
const inferenceAppPromises = new Map<string, Promise<Hono<AppEnv>>>();

interface InferenceRouteSpec {
  key: string;
  mountPath: string;
  matches(pathname: string): boolean;
  load(): Promise<{ default: Hono<AppEnv> }>;
}

function exactInferenceRoute(
  pathname: string,
  load: InferenceRouteSpec["load"],
): InferenceRouteSpec {
  return {
    key: pathname,
    mountPath: pathname,
    matches: (candidate) => candidate === pathname,
    load,
  };
}

const INFERENCE_ROUTES: readonly InferenceRouteSpec[] = [
  exactInferenceRoute(
    "/api/v1/chat/completions",
    () => import("../v1/chat/completions/route"),
  ),
  exactInferenceRoute("/api/v1/messages", () => import("../v1/messages/route")),
  exactInferenceRoute(
    "/api/v1/responses",
    () => import("../v1/responses/route"),
  ),
  exactInferenceRoute(
    "/api/v1/embeddings",
    () => import("../v1/embeddings/route"),
  ),
  exactInferenceRoute("/api/v1/chat", () => import("../v1/chat/route")),
  exactInferenceRoute(
    "/api/v1/voice/stt",
    () => import("../v1/voice/stt/route"),
  ),
  exactInferenceRoute(
    "/api/v1/voice/tts",
    () => import("../v1/voice/tts/route"),
  ),
  exactInferenceRoute(
    "/api/v1/generate-image",
    () => import("../v1/generate-image/route"),
  ),
  exactInferenceRoute(
    "/api/v1/generate-video",
    () => import("../v1/generate-video/route"),
  ),
  exactInferenceRoute(
    "/api/v1/generate-music",
    () => import("../v1/generate-music/route"),
  ),
  exactInferenceRoute(
    "/api/v1/generate-sfx",
    () => import("../v1/generate-sfx/route"),
  ),
  exactInferenceRoute(
    "/api/v1/generate-prompts",
    () => import("../v1/generate-prompts/route"),
  ),
  {
    key: "app-chat",
    mountPath: "/api/v1/apps/:id/chat",
    matches: (pathname) => /^\/api\/v1\/apps\/[^/]+\/chat$/.test(pathname),
    load: () => import("../v1/apps/[id]/chat/route"),
  },
  {
    key: "app-generate-image",
    mountPath: "/api/v1/apps/:id/generate-image",
    matches: (pathname) =>
      /^\/api\/v1\/apps\/[^/]+\/generate-image$/.test(pathname),
    load: () => import("../v1/apps/[id]/generate-image/route"),
  },
  {
    key: "agent-a2a",
    mountPath: "/api/agents/:id/a2a",
    matches: (pathname) => /^\/api\/agents\/[^/]+\/a2a$/.test(pathname),
    load: () => import("../agents/[id]/a2a/route"),
  },
  {
    key: "agent-mcp",
    mountPath: "/api/agents/:id/mcp",
    matches: (pathname) => /^\/api\/agents\/[^/]+\/mcp$/.test(pathname),
    load: () => import("../agents/[id]/mcp/route"),
  },
];
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

async function getInferenceApp(
  spec: InferenceRouteSpec,
): Promise<Hono<AppEnv>> {
  let promise = inferenceAppPromises.get(spec.key);
  if (!promise) {
    promise = Promise.all([import("./inference-app"), spec.load()]).then(
      ([shell, route]) =>
        shell.createInferenceApp(spec.mountPath, route.default),
    );
    inferenceAppPromises.set(spec.key, promise);
  }
  return promise;
}

export function isThinInferenceEnabled(
  env: Pick<AppEnv["Bindings"], "THIN_INFERENCE_ENTRY_ENABLED">,
): boolean {
  return env.THIN_INFERENCE_ENTRY_ENABLED === "true";
}

export function isCanonicalInferencePath(pathname: string): boolean {
  return INFERENCE_ROUTES.some((route) => route.matches(pathname));
}

async function dispatchInference(
  request: Request,
  env: AppEnv["Bindings"],
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (!isThinInferenceEnabled(env)) {
    return null;
  }
  const pathname = new URL(request.url).pathname;
  const route = INFERENCE_ROUTES.find((candidate) =>
    candidate.matches(pathname),
  );
  if (!route) return null;

  const dispatchStartedAt = performance.now();
  const moduleWasInitialized = inferenceAppPromises.has(route.key);
  const app = await getInferenceApp(route);
  const moduleInitMs = performance.now() - dispatchStartedAt;
  const response = await app.fetch(request, env, ctx);
  const dispatchMs = performance.now() - dispatchStartedAt;

  response.headers.set("X-Eliza-Inference-Path", "thin");
  response.headers.append(
    "Server-Timing",
    `entry_dispatch;dur=${dispatchMs.toFixed(1)}`,
  );
  if (!moduleWasInitialized) {
    response.headers.append(
      "Server-Timing",
      `inference_module_init;dur=${moduleInitMs.toFixed(1)}`,
    );
  }
  return response;
}

function healthResponse(env: AppEnv["Bindings"]): Response {
  return Response.json(
    {
      status: "ok",
      timestamp: Date.now(),
      region: (env as { CF_REGION?: string }).CF_REGION ?? "unknown",
      commit: env.ELIZA_DEPLOY_COMMIT ?? null,
      // Self-identify which deployment env answered. The staging worker and the
      // prod worker share the `*.elizacloud.ai` zone; the staging worker only
      // owns `staging.*`/`app-staging.*`/`api-staging.*` by claiming those
      // routes MORE specifically than prod's `*.elizacloud.ai/*` wildcard
      // (wrangler.toml [env.staging].routes). If that claim ever lapses, a
      // staging subdomain silently falls into the prod wildcard and starts
      // serving prod — invisible except by asking who answered. This field is
      // the beacon the cross-environment routing verifier probes
      // (packages/cloud/scripts/verify-environment-routing.mjs).
      environment: env.ENVIRONMENT ?? null,
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

export function getFrontendAliasProxyTarget(url: URL): URL | null {
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return null;

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

function proxyFrontendAliasRequest(
  request: Request,
  url: URL,
): Promise<Response> | null {
  const targetUrl = getFrontendAliasProxyTarget(url);
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
      const inferenceResponse = await dispatchInference(apiRequest, env, ctx);
      if (inferenceResponse) return inferenceResponse;
      return (await getApp()).fetch(apiRequest, env, ctx);
    }

    const frontendAliasResponse = proxyFrontendAliasRequest(request, url);
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

    const inferenceResponse = await dispatchInference(request, env, ctx);
    if (inferenceResponse) return inferenceResponse;

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
      const rewrittenRequest = new Request(rewrittenUrl, request);
      const rewrittenInferenceResponse = await dispatchInference(
        rewrittenRequest,
        env,
        ctx,
      );
      if (rewrittenInferenceResponse) return rewrittenInferenceResponse;
      return (await getApp()).fetch(rewrittenRequest, env, ctx);
    }

    return (await getApp()).fetch(request, env, ctx);
  },

  scheduled,
};
