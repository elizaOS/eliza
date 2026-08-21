/**
 * Cloud API — Cloudflare Workers entrypoint (thin bootstrap).
 *
 * The full Hono stack lives in `./bootstrap-app.ts` and is loaded only for
 * unmatched `fetch` / `scheduled` invocations. Latency-critical provider,
 * inference, and internal gateway routes use bounded shells so ordinary turns
 * do not evaluate the generated application router.
 *
 *   bun run codegen   # regen the router after adding/removing routes
 *   bun run dev       # wrangler dev
 *   bun run deploy    # wrangler deploy
 */

import "./worker-polyfills";

import {
  canonicalCloudPathForLegacyDashboard,
  canonicalElizaServiceHostname,
  classifyElizaHostname,
  ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared/elizacloud";
import type { Hono, ExecutionContext as HonoExecutionContext } from "hono";
import {
  cloneRequestWithScheduledCronMetadata,
  makeCronHandler,
} from "@/lib/cron/cloudflare-cron";
import {
  ELIZA_TRACE_ID_HEADER,
  resolveElizaTraceId,
  setHttpTelemetryHeaders,
} from "@/lib/observability/http-telemetry";
import { shouldDecorateHttpTelemetryStatus } from "@/lib/observability/http-telemetry-hono";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { isStorageReadCapabilityPath, serveBlobHostRequest } from "./blob-host";
import { isThinCliSessionPath } from "./cli-session-paths";
import { isPersonalSharedTelegramEdgeEnabled } from "./personal-shared-telegram-edge";
import { serveRegistryHostRequest } from "./registry-host";
import { routeShardKey } from "./router-shards";
import { isThinStewardPath } from "./steward/public-paths";

export { AnonymousChatGate } from "./anonymous-chat-gate";
export { isThinCliSessionPath } from "./cli-session-paths";
export { InferenceAdmissionGate } from "./inference-admission-gate";
export { InferenceRateLimitV2RollbackFloor } from "./inference-rate-limit-v2-rollback-floor";
export { OnboardingSessionCoordinator } from "./onboarding-session-coordinator";
export { PersonalDeliveryProjection } from "./personal-delivery-projection";
export { PersonalTelegramDelivery } from "./personal-telegram-delivery";
export { SharedRuntimeConversation } from "./shared-runtime-conversation";
export {
  isThinStewardEmailAuthPath,
  isThinStewardPath,
  isThinStewardPublicPath,
} from "./steward/public-paths";
export { TwitterOAuthRefreshCoordinator } from "./twitter-oauth-refresh-coordinator";

/**
 * Full-app promises memoised per route shard (issue #22550). Each entry is a
 * complete middleware stack whose generated routes are limited to the shard
 * that can match the request path, so a cold isolate serving one path family
 * does not evaluate the other ~600 route modules.
 */
const fullAppPromises = new Map<string | null, Promise<Hono<AppEnv>>>();
const inferenceAppPromises = new Map<string, Promise<Hono<AppEnv>>>();
/** Lazy thin shell for login-critical Steward GETs (#18049). */
let stewardThinAppPromise: Promise<Hono<AppEnv>> | undefined;
/** Lazy thin shell for the CLI-session login hot path (#22948). */
let cliSessionThinAppPromise: Promise<Hono<AppEnv>> | undefined;
/** Lazy provider-webhook shell that avoids the generated application router. */
let webhookAppPromise: Promise<Hono<AppEnv>> | undefined;
/** Lazy authenticated Discord shell that avoids the generated application router. */
let discordGatewayAppPromise: Promise<Hono<AppEnv>> | undefined;

const STAGING_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGING_SESSION_KEY_ID_RE = /^staging-qa-v1-[A-Za-z0-9._-]{1,48}$/;

function hasExactStagingSessionUuidList(value: string | undefined): boolean {
  const entries = value
    ?.split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Boolean(
    entries &&
      entries.length > 0 &&
      entries.length <= 100 &&
      entries.every((entry) => STAGING_SESSION_UUID_RE.test(entry)),
  );
}

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
const DEFAULT_AGENT_BASE_DOMAIN =
  ELIZA_DOMAIN_CONTRACTS.production.dedicatedAgentHostnameSuffix.slice(1);
const FRONTEND_ALIAS_TARGETS: Record<
  string,
  { appHost: string; apiHost: string }
> = {
  "cloud.eliza.app": {
    appHost: "eliza-app.pages.dev",
    apiHost: "api.eliza.app",
  },
  "cloud-staging.eliza.app": {
    appHost: "develop.eliza-app.pages.dev",
    apiHost: "api-staging.eliza.app",
  },
  "staging.eliza.app": {
    appHost: "develop.eliza-app.pages.dev",
    apiHost: "api-staging.eliza.app",
  },
};
type AgentDomainBindings = Pick<
  AppEnv["Bindings"],
  "AGENT_ROUTER_ORIGIN_HOST" | "ELIZA_CLOUD_AGENT_BASE_DOMAIN"
>;

function getAppForPath(pathname: string): Promise<Hono<AppEnv>> {
  const shard = routeShardKey(pathname);
  let promise = fullAppPromises.get(shard);
  if (!promise) {
    promise = import("./bootstrap-app").then((m) =>
      m.createApp({ requestPath: pathname }),
    );
    fullAppPromises.set(shard, promise);
  }
  return promise;
}

/** Preserve Workerd upgrade responses; rebuilding one drops its `webSocket` extension. */
export function decorateFullAppDispatchResponse(
  response: Response,
  traceId: string,
  dispatchMs: number,
  moduleInitMs: number | null,
): Response {
  if (!shouldDecorateHttpTelemetryStatus(response.status)) return response;

  const responseHeaders = new Headers(response.headers);
  setHttpTelemetryHeaders(responseHeaders, traceId, [
    { name: "full_app_dispatch", durationMs: dispatchMs },
    // Cold/warm marker on every decorated response: `full_app_module_init`
    // alone cannot distinguish "warm isolate" from "header stripped", and its
    // duration under-reports cold bootstrap because workerd freezes the clock
    // across pure CPU — the cost lands in full_app_dispatch at the first I/O
    // (#22948).
    {
      name: "full_app_isolate",
      durationMs: 0,
      description: moduleInitMs === null ? "warm" : "cold",
    },
    ...(moduleInitMs === null
      ? []
      : [{ name: "full_app_module_init", durationMs: moduleInitMs }]),
  ]);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function dispatchFullApp(
  request: Request,
  env: AppEnv["Bindings"],
  ctx: ExecutionContext | HonoExecutionContext,
  loadFullApp?: () => Promise<Hono<AppEnv>>,
): Promise<Response> {
  const startedAt = performance.now();
  const requestPathname = new URL(request.url).pathname;
  const moduleWasInitialized = loadFullApp
    ? true
    : fullAppPromises.has(routeShardKey(requestPathname));
  const loadApp = loadFullApp ?? (() => getAppForPath(requestPathname));
  const traceId = resolveElizaTraceId(request.headers);
  const headers = new Headers(request.headers);
  headers.set(ELIZA_TRACE_ID_HEADER, traceId);
  const tracedRequest = cloneRequestWithScheduledCronMetadata(request, {
    headers,
  });
  let moduleInitMs: number | null = null;
  let status: number | null = null;

  try {
    const app = await loadApp();
    moduleInitMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const response = await app.fetch(tracedRequest, env, ctx);
    status = response.status;
    const dispatchMs = Math.round((performance.now() - startedAt) * 100) / 100;
    return decorateFullAppDispatchResponse(
      response,
      traceId,
      dispatchMs,
      moduleWasInitialized ? null : moduleInitMs,
    );
  } finally {
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const logContext = {
      traceId,
      path: new URL(request.url).pathname,
      status,
      moduleWasInitialized,
      moduleInitMs,
      durationMs,
    };
    if (
      status === null ||
      status >= 500 ||
      durationMs >= 1_000 ||
      (moduleInitMs ?? 0) >= 250
    ) {
      logger.warn(
        "[CloudEntrypoint] full app dispatch slow or failed",
        logContext,
      );
    } else {
      logger.info("[CloudEntrypoint] full app dispatch completed", logContext);
    }
  }
}

async function getStewardThinApp(): Promise<Hono<AppEnv>> {
  stewardThinAppPromise ??= import("./steward/thin-app").then((m) =>
    m.createStewardThinApp(),
  );
  return stewardThinAppPromise;
}

async function getCliSessionThinApp(): Promise<Hono<AppEnv>> {
  cliSessionThinAppPromise ??= import("./cli-session-app").then((m) =>
    m.createCliSessionThinApp(),
  );
  return cliSessionThinAppPromise;
}

const ELIZA_APP_WEBHOOK_PATH =
  /^\/api\/eliza-app\/webhook\/(?:blooio|discord|telegram|twilio|whatsapp)(?:\/|$)/;

export function isElizaAppWebhookPath(pathname: string): boolean {
  return ELIZA_APP_WEBHOOK_PATH.test(pathname);
}

async function getWebhookApp(): Promise<Hono<AppEnv>> {
  webhookAppPromise ??= import("./webhook-app").then((module) =>
    module.createWebhookApp(),
  );
  return webhookAppPromise;
}

async function dispatchWebhook(
  request: Request,
  env: AppEnv["Bindings"],
  ctx: ExecutionContext,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!isElizaAppWebhookPath(pathname)) return null;

  const startedAt = performance.now();
  const moduleWasInitialized = webhookAppPromise !== undefined;
  const traceId = resolveElizaTraceId(request.headers);
  const headers = new Headers(request.headers);
  headers.set(ELIZA_TRACE_ID_HEADER, traceId);
  const app = await getWebhookApp();
  const moduleInitMs = performance.now() - startedAt;
  const response = await app.fetch(new Request(request, { headers }), env, ctx);
  const dispatchMs = performance.now() - startedAt;
  const responseHeaders = new Headers(response.headers);
  setHttpTelemetryHeaders(responseHeaders, traceId, [
    { name: "webhook_entry_dispatch", durationMs: dispatchMs },
    ...(!moduleWasInitialized
      ? [{ name: "webhook_module_init", durationMs: moduleInitMs }]
      : []),
  ]);
  responseHeaders.set("X-Eliza-Webhook-Path", "thin");

  const logContext = {
    traceId,
    path: pathname,
    status: response.status,
    moduleWasInitialized,
    moduleInitMs: Math.round(moduleInitMs * 100) / 100,
    durationMs: Math.round(dispatchMs * 100) / 100,
  };
  if (response.status >= 500 || dispatchMs >= 1_000 || moduleInitMs >= 250) {
    logger.warn(
      "[CloudEntrypoint] webhook dispatch slow or failed",
      logContext,
    );
  } else {
    logger.info("[CloudEntrypoint] webhook dispatch completed", logContext);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

const INTERNAL_DISCORD_GATEWAY_PATH =
  "/api/internal/discord/eliza-app/messages";

export function isInternalDiscordGatewayPath(pathname: string): boolean {
  return pathname === INTERNAL_DISCORD_GATEWAY_PATH;
}

async function getDiscordGatewayApp(): Promise<Hono<AppEnv>> {
  discordGatewayAppPromise ??= import("./discord-gateway-app").then((module) =>
    module.createDiscordGatewayApp(),
  );
  return discordGatewayAppPromise;
}

async function dispatchDiscordGateway(
  request: Request,
  env: AppEnv["Bindings"],
  ctx: ExecutionContext,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!isInternalDiscordGatewayPath(pathname)) return null;

  const startedAt = performance.now();
  const moduleWasInitialized = discordGatewayAppPromise !== undefined;
  const traceId = resolveElizaTraceId(request.headers);
  const headers = new Headers(request.headers);
  headers.set(ELIZA_TRACE_ID_HEADER, traceId);
  const app = await getDiscordGatewayApp();
  const moduleInitMs = performance.now() - startedAt;
  const response = await app.fetch(new Request(request, { headers }), env, ctx);
  const dispatchMs = performance.now() - startedAt;
  const responseHeaders = new Headers(response.headers);
  setHttpTelemetryHeaders(responseHeaders, traceId, [
    { name: "discord_entry_dispatch", durationMs: dispatchMs },
    ...(!moduleWasInitialized
      ? [{ name: "discord_module_init", durationMs: moduleInitMs }]
      : []),
  ]);
  responseHeaders.set("X-Eliza-Discord-Path", "thin");

  const logContext = {
    traceId,
    status: response.status,
    moduleWasInitialized,
    moduleInitMs: Math.round(moduleInitMs * 100) / 100,
    durationMs: Math.round(dispatchMs * 100) / 100,
  };
  if (response.status >= 500 || dispatchMs >= 1_000 || moduleInitMs >= 250) {
    logger.warn(
      "[CloudEntrypoint] Discord gateway dispatch slow or failed",
      logContext,
    );
  } else {
    logger.info(
      "[CloudEntrypoint] Discord gateway dispatch completed",
      logContext,
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function dispatchCliSession(
  request: Request,
  env: AppEnv["Bindings"],
  ctx: ExecutionContext,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!isThinCliSessionPath(request.method, pathname)) return null;

  const dispatchStartedAt = performance.now();
  const moduleWasInitialized = cliSessionThinAppPromise !== undefined;
  const app = await getCliSessionThinApp();
  const moduleInitMs = performance.now() - dispatchStartedAt;
  const response = await app.fetch(request, env, ctx);
  const dispatchMs = performance.now() - dispatchStartedAt;

  const headers = new Headers(response.headers);
  headers.set("X-Eliza-Cli-Session-Path", "thin");
  headers.append(
    "Server-Timing",
    `entry_dispatch;dur=${dispatchMs.toFixed(1)}`,
  );
  if (!moduleWasInitialized) {
    headers.append(
      "Server-Timing",
      `cli_session_module_init;dur=${moduleInitMs.toFixed(1)}`,
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function dispatchThinSteward(
  request: Request,
  env: AppEnv["Bindings"],
  ctx: ExecutionContext,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!isThinStewardPath(request.method, pathname)) return null;

  const dispatchStartedAt = performance.now();
  const moduleWasInitialized = stewardThinAppPromise !== undefined;
  const app = await getStewardThinApp();
  const moduleInitMs = performance.now() - dispatchStartedAt;
  const response = await app.fetch(request, env, ctx);
  const dispatchMs = performance.now() - dispatchStartedAt;

  const headers = new Headers(response.headers);
  headers.set("X-Eliza-Steward-Path", "thin");
  headers.append(
    "Server-Timing",
    `entry_dispatch;dur=${dispatchMs.toFixed(1)}`,
  );
  if (!moduleWasInitialized) {
    headers.append(
      "Server-Timing",
      `steward_module_init;dur=${moduleInitMs.toFixed(1)}`,
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
  const personalSharedTelegramEdgeEnabled =
    isPersonalSharedTelegramEdgeEnabled(env);
  const stagingSessionVersion =
    env.STAGING_SESSION_EXCHANGE_VERSION?.trim() || null;
  const stagingSessionSigningSecret =
    env.STAGING_SESSION_EXCHANGE_SIGNING_SECRET?.trim() ?? "";
  const stagingSessionEnabled =
    env.NODE_ENV === "production" &&
    env.ENVIRONMENT === "staging" &&
    env.STAGING_SESSION_EXCHANGE_ENABLED === "true" &&
    env.STAGING_SESSION_EXCHANGE_VERSION === "v1";
  const stagingSessionReady =
    stagingSessionEnabled &&
    stagingSessionSigningSecret.length >= 32 &&
    stagingSessionSigningSecret !== env.STEWARD_JWT_SECRET?.trim() &&
    stagingSessionSigningSecret !== env.STEWARD_SESSION_SECRET?.trim() &&
    stagingSessionSigningSecret !== env.ELIZA_SERVICE_JWT_SECRET?.trim() &&
    STAGING_SESSION_KEY_ID_RE.test(
      env.STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID?.trim() ?? "",
    ) &&
    Boolean(env.STEWARD_TENANT_ID?.trim()) &&
    hasExactStagingSessionUuidList(
      env.STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS,
    ) &&
    hasExactStagingSessionUuidList(
      env.STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS,
    ) &&
    hasExactStagingSessionUuidList(
      env.STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS,
    );
  return Response.json(
    {
      status: "ok",
      timestamp: Date.now(),
      region: (env as { CF_REGION?: string }).CF_REGION ?? "unknown",
      commit: env.ELIZA_DEPLOY_COMMIT ?? null,
      // Self-identify which deployment env answered. Production and staging
      // share the eliza.app zone. Staging claims its
      // exact control-plane names and `*.cloud-staging.eliza.app` before the
      // production managed-agent wildcard can handle the request.
      // (wrangler.toml [env.staging].routes). If that claim ever lapses, a
      // staging subdomain silently falls into the prod wildcard and starts
      // serving prod — invisible except by asking who answered. This field is
      // the beacon the cross-environment routing verifier probes
      // (packages/cloud/scripts/verify-environment-routing.mjs).
      environment: env.ENVIRONMENT ?? null,
      // The protected Telegram cutover uses a secret binding to override the
      // tracked false default without changing code. This value-free beacon
      // lets the release workflow prove the served state and fail closed when
      // a provider-side mutation has an ambiguous result.
      personalSharedTelegramEdge: {
        enabled: personalSharedTelegramEdgeEnabled,
      },
      // Value-free cutover receipt for the default-off staging QA bridge. The
      // deploy workflow proves exact code first, flips the secret last, then
      // requires this beacon to report the expected version/readiness. No key,
      // allowlist, kid, or subject value is exposed.
      stagingSessionExchange:
        env.ENVIRONMENT === "staging"
          ? {
              enabled: stagingSessionEnabled,
              ready: stagingSessionReady,
              version: stagingSessionVersion,
            }
          : null,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}

function normalizeHostname(hostname: string | undefined): string | null {
  const value = hostname?.trim().toLowerCase();
  if (!value) return null;
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 46) end--;
  const normalized = value.slice(0, end);
  return normalized || null;
}

export function getGeneratedAgentId(
  url: URL,
  env: AgentDomainBindings,
): string | null {
  const baseDomain =
    normalizeHostname(env.ELIZA_CLOUD_AGENT_BASE_DOMAIN) ??
    DEFAULT_AGENT_BASE_DOMAIN;
  const suffix = `.${baseDomain}`;
  const hostname = normalizeHostname(url.hostname);
  if (hostname?.endsWith(suffix)) {
    const subdomain = hostname.slice(0, -suffix.length);
    if (AGENT_ID_RE.test(subdomain)) return subdomain;
  }
  return null;
}

export function redirectFrontendHost(
  url: URL,
  _env: AgentDomainBindings,
): Response | null {
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return null;
  // docs.elizacloud.ai is retired, not migrated as a separate product. Send
  // every stale bookmark to the canonical Eliza homepage instead of keeping a
  // second Cloud-branded docs entrypoint alive.
  if (hostname === "docs.elizacloud.ai") {
    return Response.redirect(
      ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin,
      308,
    );
  }
  const classified = classifyElizaHostname(hostname);
  const canonicalDashboardPath = canonicalCloudPathForLegacyDashboard(
    url.pathname,
    url.search,
  );
  let canonicalHostname: string | null = null;
  if (hostname === "www.eliza.app") {
    canonicalHostname = new URL(
      ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin,
    ).hostname;
  } else if (classified.role === "legacy-marketing") {
    const contract =
      ELIZA_DOMAIN_CONTRACTS[classified.environment ?? "production"];
    if (isFrontendAliasBackendPath(url)) {
      canonicalHostname = new URL(contract.cloudApiOrigin).hostname;
    } else if (canonicalDashboardPath) {
      canonicalHostname = new URL(contract.cloudAppOrigin).hostname;
      url.pathname = canonicalDashboardPath;
    } else {
      canonicalHostname = classified.canonicalHostname;
    }
  } else if (
    classified.role === "legacy-cloud-app" ||
    classified.role === "legacy-cloud-api"
  ) {
    canonicalHostname = classified.canonicalHostname;
  } else if (
    classified.role === "legacy-dedicated-agent" &&
    classified.agentId &&
    AGENT_ID_RE.test(classified.agentId)
  ) {
    canonicalHostname = classified.canonicalHostname;
  } else {
    canonicalHostname = canonicalElizaServiceHostname(hostname);
    if (!canonicalHostname && hostname === "os.elizacloud.ai") {
      canonicalHostname = "os.eliza.app";
    }
  }
  if (!canonicalHostname || canonicalHostname === hostname) return null;

  if (
    canonicalDashboardPath &&
    (classified.role === "legacy-marketing" ||
      classified.role === "legacy-cloud-app")
  ) {
    url.pathname = canonicalDashboardPath;
  }

  const targetUrl = new URL(url);
  targetUrl.hostname = canonicalHostname;
  return Response.redirect(targetUrl.toString(), 308);
}

/** Identify legacy wildcard hosts with no explicit redirect or UUID agent. */
export function isUnsupportedLegacyWildcardHostname(
  rawHostname: string,
): boolean {
  const hostname = normalizeHostname(rawHostname);
  if (!hostname?.endsWith(".elizacloud.ai")) return false;
  if (hostname === "docs.elizacloud.ai" || hostname === "os.elizacloud.ai") {
    return false;
  }
  if (canonicalElizaServiceHostname(hostname)) return false;

  const classified = classifyElizaHostname(hostname);
  if (
    classified.role === "legacy-marketing" ||
    classified.role === "legacy-cloud-app" ||
    classified.role === "legacy-cloud-api"
  ) {
    return false;
  }
  return !(
    classified.role === "legacy-dedicated-agent" &&
    classified.agentId &&
    AGENT_ID_RE.test(classified.agentId)
  );
}

function rejectUnsupportedLegacyWildcardHost(url: URL): Response | null {
  if (!isUnsupportedLegacyWildcardHostname(url.hostname)) return null;
  return Response.json(
    { error: "not_found" },
    {
      status: 404,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
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
    url.pathname.startsWith("/steward/") ||
    // OIDC requires discovery and its key set at the issuer origin's root, so
    // those two documents must reach this Worker rather than the hosted
    // frontend. Match them exactly: a `/.well-known/` prefix would also move
    // every other well-known path on the alias hosts off the SPA, including
    // publishing the internal-service JWKS where it is not published today.
    url.pathname === "/.well-known/openid-configuration" ||
    url.pathname === "/.well-known/oidc/jwks.json"
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
 * The rewrite preserves the request hostname, which the serve route reads as
 * the ONLY trusted host source — no `?host=` override is attached or honored.
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
  return rewritten;
}

const scheduled = makeCronHandler(async (request, env, ctx) =>
  dispatchFullApp(request, env, ctx),
);

export default {
  fetch: async (
    request: Request,
    env: AppEnv["Bindings"],
    ctx: ExecutionContext,
  ) => {
    const url = new URL(request.url);
    // Capability tokens are bearer credentials. Reserve their opaque namespace
    // before any host redirect or proxy can forward it to another origin.
    if (isStorageReadCapabilityPath(url)) {
      return (
        (await serveBlobHostRequest(request, url, env)) ??
        Response.json(
          { success: false, error: "Not found", code: "resource_not_found" },
          { status: 404, headers: { "cache-control": "private, no-store" } },
        )
      );
    }
    const frontendAliasApiTarget = getFrontendAliasApiProxyTarget(url);
    if (frontendAliasApiTarget) {
      if (frontendAliasApiTarget.pathname === "/api/health") {
        return healthResponse(env);
      }

      const apiRequest = new Request(
        frontendAliasApiTarget.toString(),
        createFrontendAliasProxyInit(request, url),
      );
      const webhookResponse = await dispatchWebhook(apiRequest, env, ctx);
      if (webhookResponse) return webhookResponse;
      const discordGatewayResponse = await dispatchDiscordGateway(
        apiRequest,
        env,
        ctx,
      );
      if (discordGatewayResponse) return discordGatewayResponse;
      const cliSessionThinResponse = await dispatchCliSession(
        apiRequest,
        env,
        ctx,
      );
      if (cliSessionThinResponse) return cliSessionThinResponse;
      const stewardThinResponse = await dispatchThinSteward(
        apiRequest,
        env,
        ctx,
      );
      if (stewardThinResponse) return stewardThinResponse;
      const inferenceResponse = await dispatchInference(apiRequest, env, ctx);
      if (inferenceResponse) return inferenceResponse;
      return dispatchFullApp(apiRequest, env, ctx);
    }

    const frontendAliasResponse = proxyFrontendAliasRequest(request, url);
    if (frontendAliasResponse) return frontendAliasResponse;
    const frontendRedirect = redirectFrontendHost(url, env);
    if (frontendRedirect) return frontendRedirect;
    const unsupportedLegacyHost = rejectUnsupportedLegacyWildcardHost(url);
    if (unsupportedLegacyHost) return unsupportedLegacyHost;
    const blobResponse = await serveBlobHostRequest(request, url, env);
    if (blobResponse) return blobResponse;
    const registryResponse = await serveRegistryHostRequest(request, url, env);
    if (registryResponse) return registryResponse;
    const agentProxyResponse = proxyGeneratedAgentRequest(request, env, url);
    if (agentProxyResponse) return agentProxyResponse;

    const hostedFrontendServe = getHostedFrontendServeRewrite(url, env);
    if (hostedFrontendServe) {
      return dispatchFullApp(
        new Request(hostedFrontendServe, request),
        env,
        ctx,
      );
    }

    if (url.pathname === "/api/health") {
      return healthResponse(env);
    }

    const webhookResponse = await dispatchWebhook(request, env, ctx);
    if (webhookResponse) return webhookResponse;

    const discordGatewayResponse = await dispatchDiscordGateway(
      request,
      env,
      ctx,
    );
    if (discordGatewayResponse) return discordGatewayResponse;

    // CLI-session login hot path before full-app bootstrap (#22948).
    const cliSessionThinResponse = await dispatchCliSession(request, env, ctx);
    if (cliSessionThinResponse) return cliSessionThinResponse;

    // Login-critical Steward GETs before full-app bootstrap (#18049).
    const stewardThinResponse = await dispatchThinSteward(request, env, ctx);
    if (stewardThinResponse) return stewardThinResponse;

    const inferenceResponse = await dispatchInference(request, env, ctx);
    if (inferenceResponse) return inferenceResponse;

    // OpenAI-compat prefix rewrite. Dedicated agents whose cloud base/embedding
    // URL got stamped as the bare host (`https://api.eliza.app`) hit
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
      return dispatchFullApp(rewrittenRequest, env, ctx);
    }

    return dispatchFullApp(request, env, ctx);
  },

  scheduled,
};
