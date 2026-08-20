#!/usr/bin/env -S npx tsx

/**
 * Agent Router daemon.
 *
 * Resolves agent id → headscale IP / bridge port / web UI port for the nginx
 * wildcard subdomain router. Routing requires a persisted headscale_ip by default;
 * legacy bridge-host fallback is opt-in because public host + dynamic port
 * metadata is not a reliable ingress target after the Hetzner/control-plane
 * split. Browser CORS on this hop is first-party + credentials only — an
 * untrusted Origin is not reflected.
 *
 * Usage:
 *   npx tsx packages/cloud/scripts/admin/daemons/agent-router.ts
 *
 * Environment:
 *   AGENT_ROUTER_PORT       default 3458
 *   AGENT_ROUTER_BIND_HOST  default 127.0.0.1
 *   DATABASE_URL            Postgres connection (loaded from .env.local).
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { isFirstPartyOrigin } from "../../../shared/src/lib/cors/first-party-origin.ts";
import { loadLocalEnv } from "./shared/load-env";

type Logger = typeof import("@elizaos/cloud-shared/lib/utils/logger").logger;
type FindAgentSandboxRoutingById =
  typeof import("@elizaos/cloud-shared/db/agent-sandbox-routing").findAgentSandboxRoutingById;

interface RouterDeps {
  logger: Logger;
  findAgentSandboxRoutingById: FindAgentSandboxRoutingById;
}

export interface AgentRouterConfig {
  port: number;
  bindHost: string;
}

export type RouterReadinessStatus = "warming" | "ready" | "failed";

export interface RouterReadinessState {
  status: RouterReadinessStatus;
}

export interface StartAgentRouterOptions {
  config?: AgentRouterConfig;
  warmRoutingDependencies?: () => Promise<void>;
  warmupTimeoutMs?: number;
  onWarmupError?: (error: Error) => void;
}

export interface StartedAgentRouter {
  server: Server;
  readiness: RouterReadinessState;
  warmupSettled: Promise<void>;
}

const DEFAULT_PORT = 3458;
const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_WARMUP_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_BASE_DOMAIN = "cloud.eliza.app";
const AGENT_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// The first request to an agent after an idle period can hit a transiently cold
// tailnet path that fails while it re-establishes. Retry idempotent requests
// once (the first attempt re-warms the path) before surfacing the failure.
// Non-idempotent requests are never retried (the warm-keep heartbeat holds the
// path open between requests, so a cold POST is rare).
const PROXY_TAILNET_RETRY_ATTEMPTS = 1;
const PROXY_TAILNET_RETRY_DELAY_MS = 400;
// A `running` sandbox with no resolvable ingress (empty headscale_ip, fallback
// off) is transient — the mesh join has not completed yet — so we advertise a
// short client retry window rather than a terminal not-found.
const UNROUTABLE_RETRY_AFTER_SECONDS = 5;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readRouterConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentRouterConfig {
  return {
    port: parsePositiveInt(env.AGENT_ROUTER_PORT, DEFAULT_PORT),
    bindHost: env.AGENT_ROUTER_BIND_HOST?.trim() || DEFAULT_BIND_HOST,
  };
}

let depsPromise: Promise<RouterDeps> | null = null;

async function loadDeps(): Promise<RouterDeps> {
  if (!depsPromise) {
    depsPromise = Promise.all([
      import("@elizaos/cloud-shared/db/agent-sandbox-routing"),
      import("@elizaos/cloud-shared/lib/utils/logger"),
    ]).then(([agentRoutingModule, loggerModule]) => ({
      findAgentSandboxRoutingById:
        agentRoutingModule.findAgentSandboxRoutingById,
      logger: loggerModule.logger,
    }));
  }
  return depsPromise;
}

interface RoutingResponse {
  headscaleIp: string;
  bridgePort: number;
  webUiPort: number;
  bridgeTarget: string;
  webTarget: string;
  target: string;
}

interface SandboxRoutingFields {
  status: string;
  bridge_url?: string | null;
  bridge_port?: number | null;
  headscale_ip?: string | null;
  web_ui_port?: number | null;
}

interface SandboxRoutingOptions {
  allowBridgeHostFallback?: boolean;
}

function parseUrlPort(url: string | null | undefined): number | null {
  if (!url) return null;
  try {
    const { port } = new URL(url);
    if (!port) return null;
    const parsed = Number.parseInt(port, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveSandboxRouting(
  sandbox: SandboxRoutingFields | null | undefined,
  options: SandboxRoutingOptions = {},
): RoutingResponse | null {
  if (sandbox?.status !== "running" || !sandbox.web_ui_port) {
    return null;
  }

  // Headscale mesh routing: the router reaches the CONTAINER directly at its
  // tailnet IP, where only the container-internal port is bound. bridge_port /
  // web_ui_port are the HOST-published ports (docker -p host:container) and do
  // not exist inside the container's network namespace, so they are unreachable
  // over the tailnet. bridge_url is the single source of truth and encodes the
  // reachable container port; the bridge API and the web UI are both served on
  // it. Without a parseable port we cannot route — refuse rather than guess a
  // host port that would never connect.
  const tailnetIp = sandbox.headscale_ip?.trim();
  if (tailnetIp) {
    const containerPort = parseUrlPort(sandbox.bridge_url);
    if (!containerPort) return null;
    const target = `${tailnetIp}:${containerPort}`;
    return {
      headscaleIp: tailnetIp,
      bridgePort: containerPort,
      webUiPort: containerPort,
      bridgeTarget: target,
      webTarget: target,
      target,
    };
  }

  // Host-routing compatibility path (no headscale_ip): reach the agent through the docker
  // host's published bridge/web ports. Off by default — requires the explicit
  // AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK opt-in.
  let bridgePort: number | null =
    typeof sandbox.bridge_port === "number" ? sandbox.bridge_port : null;
  let bridgeHost: string | null = null;
  if (sandbox.bridge_url) {
    try {
      const parsed = new URL(sandbox.bridge_url);
      bridgeHost = options.allowBridgeHostFallback
        ? parsed.hostname || null
        : null;
      bridgePort ??= parsed.port ? Number.parseInt(parsed.port, 10) : null;
    } catch {
      bridgeHost = null;
    }
  }

  if (!bridgeHost) return null;
  if (!bridgePort || !Number.isFinite(bridgePort)) {
    bridgePort = sandbox.web_ui_port;
  }

  const webUiPort = sandbox.web_ui_port;
  const bridgeTarget = `${bridgeHost}:${bridgePort}`;
  const webTarget = `${bridgeHost}:${webUiPort}`;
  return {
    headscaleIp: bridgeHost,
    bridgePort,
    webUiPort,
    bridgeTarget,
    webTarget,
    target: webTarget,
  };
}

export function selectAgentProxyTarget(
  routing: Pick<RoutingResponse, "bridgeTarget" | "webTarget">,
  pathname: string,
): string {
  if (
    pathname === "/bridge" ||
    pathname === "/v1/chat/completions" ||
    pathname.startsWith("/api/agents") ||
    pathname.startsWith("/api/conversations") ||
    pathname.startsWith("/api/messaging") ||
    pathname.startsWith("/api/restore") ||
    pathname.startsWith("/api/snapshot") ||
    pathname.startsWith("/api/wallet")
  ) {
    return routing.bridgeTarget;
  }

  return routing.webTarget;
}

export function isBridgeHostFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK === "true" ||
    env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK === "1"
  );
}

export async function resolveAgentRouting(
  agentId: string,
): Promise<RoutingResponse | null> {
  const { findAgentSandboxRoutingById } = await loadDeps();
  const sandbox = await findAgentSandboxRoutingById(agentId);
  return resolveSandboxRouting(sandbox, {
    allowBridgeHostFallback: isBridgeHostFallbackEnabled(),
  });
}

export function extractAgentIdFromHost(
  hostHeader: string | undefined,
  baseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN ??
    DEFAULT_AGENT_BASE_DOMAIN,
): string | null {
  const hostname = hostHeader?.split(":")[0]?.trim().toLowerCase();
  const normalizedBaseDomain = baseDomain.trim().toLowerCase();
  if (!hostname || !normalizedBaseDomain) return null;

  const suffix = `.${normalizedBaseDomain}`;
  if (!hostname.endsWith(suffix)) return null;

  const subdomain = hostname.slice(0, -suffix.length);
  if (!AGENT_ID_RE.test(subdomain)) return null;
  return subdomain;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function getEffectiveHost(req: IncomingMessage): string | undefined {
  return headerValue(req.headers["x-forwarded-host"]) ?? req.headers.host;
}

async function readIncomingBody(
  req: IncomingMessage,
): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of req) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    chunks.push(bytes);
    totalLength += bytes.byteLength;
  }
  if (chunks.length === 0) return undefined;
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function buildProxyHeaders(
  req: IncomingMessage,
  target: string,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  // The Cloud Worker pins this header to the public agent URL before it
  // retargets Host to the control-plane origin. The container needs that
  // public identity for origin-bound pairing, while Host must identify the
  // tailnet socket. A direct agent-host request has no forwarded value, so its
  // Host remains the compatibility fallback used by request routing above.
  const forwardedHost = getEffectiveHost(req);
  headers.set("host", target);
  if (forwardedHost) headers.set("x-forwarded-host", forwardedHost);
  if (!headers.has("x-forwarded-proto"))
    headers.set("x-forwarded-proto", "http");
  const forwardedFor = req.socket.remoteAddress;
  if (forwardedFor) {
    const existing = headers.get("x-forwarded-for");
    headers.set(
      "x-forwarded-for",
      existing ? `${existing}, ${forwardedFor}` : forwardedFor,
    );
  }
  return headers;
}

/**
 * True when `origin` may be reflected with `Allow-Credentials: true`.
 * The shared Cloud policy is authoritative so new production and legacy
 * origins cannot drift between the edge Worker and its router origin.
 */
export function isCredentialedAgentRouterOrigin(origin: string): boolean {
  return isFirstPartyOrigin(origin);
}

/**
 * CORS headers for the browser-facing agent-proxy path. nginx forwards the
 * request here verbatim and injects nothing, so an error we return with no
 * `access-control-allow-origin` reaches the browser as an opaque
 * "No 'Access-Control-Allow-Origin'" failure that hides the real status (#15347).
 *
 * Credentialed reflection is first-party only. A missing Origin (non-browser)
 * still gets `*` without credentials. An untrusted Origin gets Vary and the
 * method/header allow-list but no ACAO — fail closed, no cookie ride.
 */
export function corsHeaders(
  origin: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    vary: "origin",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-api-key",
  };
  if (!origin) {
    headers["access-control-allow-origin"] = "*";
    return headers;
  }
  if (isCredentialedAgentRouterOrigin(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
  }
  return headers;
}

/**
 * Response for an agent host request that resolves to no routable target. A
 * `running` row with no ingress is "unroutable, retry" (503); anything else is a
 * genuine not-found (404). Both carry CORS so the browser can read the status
 * instead of an opaque CORS failure.
 */
export function buildUnresolvedAgentResponse(
  sandbox: SandboxRoutingFields | null | undefined,
  origin: string | undefined,
): Response {
  const unroutable = sandbox?.status === "running";
  if (unroutable) {
    return Response.json(
      { error: "agent has no routable ingress yet", code: "agent_unroutable" },
      {
        status: 503,
        headers: {
          ...corsHeaders(origin),
          "retry-after": String(UNROUTABLE_RETRY_AFTER_SECONDS),
        },
      },
    );
  }
  // Distinguish a missing row (deleted / never existed) from a row that is
  // merely non-running (pending/stopped/disconnected). Clients may destructively
  // drop a binding only on the definitive not-found code — not on recoverable
  // cold/stopped states that share the old 404 body (#18048 / #18070 review).
  if (!sandbox) {
    return Response.json(
      {
        error: "agent not found or not running",
        code: "agent_not_found",
      },
      { status: 404, headers: corsHeaders(origin) },
    );
  }
  return Response.json(
    {
      error: "agent not running",
      code: "agent_not_running",
      status: sandbox.status,
    },
    {
      status: 503,
      headers: {
        ...corsHeaders(origin),
        "retry-after": String(UNROUTABLE_RETRY_AFTER_SECONDS),
      },
    },
  );
}

async function proxyAgentRequest(
  agentId: string,
  url: URL,
  req: IncomingMessage,
): Promise<Response> {
  const { findAgentSandboxRoutingById } = await loadDeps();
  const sandbox = await findAgentSandboxRoutingById(agentId);
  const routing = sandbox
    ? resolveSandboxRouting(sandbox, {
        allowBridgeHostFallback: isBridgeHostFallbackEnabled(),
      })
    : null;
  if (!routing) {
    return buildUnresolvedAgentResponse(
      sandbox,
      headerValue(req.headers.origin),
    );
  }

  const target = selectAgentProxyTarget(routing, url.pathname);
  const targetUrl = new URL(`${url.pathname}${url.search}`, `http://${target}`);
  const method = req.method ?? "GET";
  const init: RequestInit = {
    method,
    headers: buildProxyHeaders(req, target),
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  };
  const idempotent = method === "GET" || method === "HEAD";
  if (!idempotent) {
    const body = await readIncomingBody(req);
    if (body) init.body = body;
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(targetUrl, init);
    } catch (error) {
      // Only idempotent requests are safe to replay, and only a transport
      // failure (a cold/torn path) — never a real HTTP response — reaches here.
      if (!idempotent || attempt >= PROXY_TAILNET_RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, PROXY_TAILNET_RETRY_DELAY_MS),
      );
    }
  }
}

export async function handleRequest(
  url: URL,
  req?: IncomingMessage,
  readiness: RouterReadinessState = { status: "ready" },
): Promise<Response> {
  if (url.pathname === "/healthz") {
    return Response.json({ ok: true }, { status: 200 });
  }
  if (url.pathname === "/readyz") {
    if (readiness.status === "ready") {
      return Response.json({ ok: true }, { status: 200 });
    }
    return Response.json(
      {
        ok: false,
        code:
          readiness.status === "warming"
            ? "router_warming"
            : "router_dependencies_unavailable",
      },
      { status: 503, headers: { "retry-after": "5" } },
    );
  }
  // /headscale-ip is the path nginx Lua already calls; /routing is the alias
  // for new callers.
  const match = url.pathname.match(
    /^\/agents\/([^/]+)\/(headscale-ip|routing)$/,
  );
  if (!match) {
    const agentId = req ? extractAgentIdFromHost(getEffectiveHost(req)) : null;
    if (agentId && req) {
      // A browser preflights a cross-origin agent call with OPTIONS; answer it
      // at the router with CORS so the real request is allowed to proceed even
      // when the agent itself is unroutable (#15347). No DB lookup / proxy.
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(headerValue(req.headers.origin)),
        });
      }
      if (readiness.status !== "ready") {
        return buildRouterUnavailableResponse(
          readiness,
          headerValue(req.headers.origin),
          true,
        );
      }
      return proxyAgentRequest(agentId, url, req);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const agentId = match[1];
  if (!AGENT_ID_RE.test(agentId)) {
    return Response.json({ error: "invalid agent id" }, { status: 400 });
  }
  if (readiness.status !== "ready") {
    return buildRouterUnavailableResponse(readiness);
  }
  const routing = await resolveAgentRouting(agentId);
  if (!routing) {
    return Response.json(
      { error: "agent not found or not running" },
      { status: 404 },
    );
  }
  return Response.json(routing, { status: 200 });
}

function buildRouterUnavailableResponse(
  readiness: RouterReadinessState,
  origin?: string,
  includeCors = false,
): Response {
  return Response.json(
    {
      error: "agent router is not ready",
      code:
        readiness.status === "warming"
          ? "router_warming"
          : "router_dependencies_unavailable",
    },
    {
      status: 503,
      headers: {
        ...(includeCors ? corsHeaders(origin) : {}),
        "retry-after": "5",
      },
    },
  );
}

export async function sendResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => {
    res.setHeader(k, v);
  });
  if (!response.body) {
    res.end();
    return;
  }

  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    res.flushHeaders();
  }

  await pipeline(Readable.from(response.body), res);
}

let server: Server | null = null;
let shuttingDown = false;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function reportRouterError(label: string, error: Error): Promise<void> {
  try {
    const { logger } = await loadDeps();
    logger.error(`[agent-router] ${label}`, { error: error.message });
  } catch {
    // error-policy:J7 Diagnostics must retain a dependency-free fallback.
    process.stderr.write(`[agent-router] ${label}: ${error.message}\n`);
  }
}

function withTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`routing dependency warmup timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function startAgentRouter(
  options: StartAgentRouterOptions = {},
): Promise<StartedAgentRouter> {
  const config = options.config ?? readRouterConfig();
  const readiness: RouterReadinessState = { status: "warming" };
  const warmRoutingDependencies =
    options.warmRoutingDependencies ??
    (async () => {
      await resolveAgentRouting("00000000-0000-4000-8000-000000000000");
    });
  const warmupTimeoutMs = options.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;

  const { createServer } = await import("node:http");
  const startedServer = createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host || "localhost"}`,
    );
    handleRequest(url, req, readiness)
      .then((response) => sendResponse(res, response))
      .catch((err) => {
        const error = toError(err);
        void reportRouterError("handler error", error);
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal error" }));
      });
  });

  await new Promise<void>((resolve, reject) => {
    startedServer.once("error", reject);
    startedServer.listen(config.port, config.bindHost, () => {
      startedServer.off("error", reject);
      resolve();
    });
  });

  console.log("[agent-router] starting", {
    port: config.port,
    bindHost: config.bindHost,
  });

  startedServer.on("error", (error) => {
    void reportRouterError("server error", toError(error));
    process.exitCode = 1;
  });

  const warmupSettled = withTimeout(
    Promise.resolve().then(warmRoutingDependencies),
    warmupTimeoutMs,
  ).then(
    () => {
      readiness.status = "ready";
    },
    async (cause) => {
      readiness.status = "failed";
      const error = toError(cause);
      if (options.onWarmupError) {
        try {
          options.onWarmupError(error);
        } catch (reportingError) {
          // error-policy:J7 A diagnostic callback must not reject warmup observation.
          await reportRouterError(
            "warmup error reporter failed",
            toError(reportingError),
          );
        }
        return;
      }
      await reportRouterError("dependency warmup failed", error);
    },
  );

  return { server: startedServer, readiness, warmupSettled };
}

async function main(): Promise<void> {
  loadLocalEnv(import.meta.url);
  const started = await startAgentRouter();
  server = started.server;
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!server) {
    process.exit(0);
  }
  server.close((err) => {
    if (err) {
      void reportRouterError(`${signal} close error`, err);
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  void reportRouterError("unhandled rejection", toError(reason));
});

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(
      `[agent-router] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
