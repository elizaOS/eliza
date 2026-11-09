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
 *   AGENT_ROUTER_MAX_BODY_BYTES  default 52428800 (50 MiB) per proxied request body
 *   DATABASE_URL            Postgres connection (loaded from .env.local).
 */

import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import { connect, type Socket } from "node:net";
import * as path from "node:path";
import { type Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadCloudLocalEnv } from "@elizaos/cloud-services-common/node";
import { isAgentBridgePath } from "../../../shared/src/lib/agent-api-routing.ts";
import { isFirstPartyOrigin } from "../../../shared/src/lib/cors/first-party-origin.ts";

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
  /** First retry delay after a failed warmup; doubles up to 30 s. */
  warmupRetryDelayMs?: number;
  onWarmupError?: (error: Error) => void;
  /** Routing lookup override; defaults to the cloud-shared DB query. */
  findAgentSandboxRoutingById?: FindAgentSandboxRoutingById;
  /** Overrides the per-route upstream response-headers budget. */
  proxyHeadersTimeoutMs?: number;
  /** Overrides AGENT_ROUTER_MAX_BODY_BYTES. */
  maxBodyBytes?: number;
}

export interface StartedAgentRouter {
  server: Server;
  readiness: RouterReadinessState;
  /** Settles with the first warmup attempt; later retries run in the background. */
  warmupSettled: Promise<void>;
  stopWarmup: () => void;
}

const DEFAULT_PORT = 3458;
const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_WARMUP_TIMEOUT_MS = 15_000;
const DEFAULT_WARMUP_RETRY_DELAY_MS = 1_000;
const MAX_WARMUP_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;
// Budget for the agent to send response headers. Once headers arrive the body
// may stream for as long as the client stays connected (SSE, long downloads).
// Workflow generation and runs answer only when done, so they get the same
// 5-minute budget as the Cloud dedicated-agent proxy (undici's own
// headersTimeout is also 300 s).
const DEFAULT_PROXY_HEADERS_TIMEOUT_MS = 120_000;
const WORKFLOW_PROXY_HEADERS_TIMEOUT_MS = 300_000;
const WEBSOCKET_IDLE_TIMEOUT_MS = 10 * 60_000;
// Fixed parse base for the request target. The target is always origin-form
// (`/path?query`), so a leading `//` stays path and never becomes authority.
const REQUEST_TARGET_BASE = "http://router.invalid";
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
  "transfer-encoding",
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
    depsPromise.catch(() => {
      depsPromise = null;
    });
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
  if (isAgentBridgePath(pathname)) return routing.bridgeTarget;

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

/**
 * Parses an origin-form request target against a fixed base. Returns null for
 * absolute-form, `*` and anything the URL parser rejects; nginx and the Cloud
 * Worker only send origin-form.
 */
export function parseRequestTarget(raw: string | undefined): URL | null {
  const target = raw ?? "/";
  if (!target.startsWith("/")) return null;
  try {
    return new URL(`${REQUEST_TARGET_BASE}${target}`);
  } catch {
    return null;
  }
}

/**
 * The agent URL for a request: always the routed tailnet target, with only the
 * client's path and query copied over. The pathname setter cannot introduce an
 * authority, so `//host/...` stays a path on the target.
 */
export function buildAgentTargetUrl(target: string, url: URL): URL {
  const targetUrl = new URL(`http://${target}`);
  targetUrl.pathname = url.pathname;
  targetUrl.search = url.search;
  return targetUrl;
}

export function agentProxyHeadersTimeoutMs(
  method: string,
  pathname: string,
): number {
  if (method.toUpperCase() !== "POST") return DEFAULT_PROXY_HEADERS_TIMEOUT_MS;
  const normalizedPath = pathname.replace(/\/+$/, "");
  if (
    normalizedPath === "/api/workflow/workflows/generate" ||
    normalizedPath === "/api/workflow/workflows/resolve-clarification" ||
    /^\/api\/workflow\/workflows\/[^/]+\/run$/.test(normalizedPath)
  ) {
    return WORKFLOW_PROXY_HEADERS_TIMEOUT_MS;
  }
  return DEFAULT_PROXY_HEADERS_TIMEOUT_MS;
}

function hasRequestBody(req: IncomingMessage): boolean {
  if (req.headers["transfer-encoding"]) return true;
  const length = Number.parseInt(req.headers["content-length"] ?? "", 10);
  return Number.isFinite(length) && length > 0;
}

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

function limitBodyStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(new BodyTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
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

interface RouterRequestContext {
  /** The client response; its early close aborts the upstream fetch. */
  res?: ServerResponse;
  findAgentSandboxRoutingById?: FindAgentSandboxRoutingById;
  proxyHeadersTimeoutMs?: number;
  maxBodyBytes: number;
}

async function findSandbox(
  agentId: string,
  context: RouterRequestContext,
): ReturnType<FindAgentSandboxRoutingById> {
  const find =
    context.findAgentSandboxRoutingById ??
    (await loadDeps()).findAgentSandboxRoutingById;
  return find(agentId);
}

async function resolveAgentProxyTarget(
  agentId: string,
  pathname: string,
  context: RouterRequestContext,
): Promise<
  | { target: string; sandbox: SandboxRoutingFields }
  | { target: null; sandbox: SandboxRoutingFields | null | undefined }
> {
  const sandbox = await findSandbox(agentId, context);
  const routing = sandbox
    ? resolveSandboxRouting(sandbox, {
        allowBridgeHostFallback: isBridgeHostFallbackEnabled(),
      })
    : null;
  if (!sandbox || !routing) return { target: null, sandbox };
  return { target: selectAgentProxyTarget(routing, pathname), sandbox };
}

async function proxyAgentRequest(
  agentId: string,
  url: URL,
  req: IncomingMessage,
  context: RouterRequestContext,
): Promise<Response> {
  const origin = headerValue(req.headers.origin);
  const { target, sandbox } = await resolveAgentProxyTarget(
    agentId,
    url.pathname,
    context,
  );
  if (!target) return buildUnresolvedAgentResponse(sandbox, origin);

  const targetUrl = buildAgentTargetUrl(target, url);
  const method = req.method ?? "GET";
  const headers = buildProxyHeaders(req, target);
  const idempotent = method === "GET" || method === "HEAD";
  let body: ReadableStream<Uint8Array> | undefined;
  if (!idempotent && hasRequestBody(req)) {
    const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
    if (Number.isFinite(declared) && declared > context.maxBodyBytes) {
      return requestBodyTooLargeResponse(origin);
    }
    // Keep a declared length so the agent sees the same framing as before.
    if (Number.isFinite(declared)) headers.set("content-length", `${declared}`);
    // Non-idempotent requests are never retried, so the body streams straight
    // through instead of being buffered.
    body = limitBodyStream(
      Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
      context.maxBodyBytes,
    );
  }

  // The client going away aborts the upstream request (and its body stream).
  // `res` close is the signal: `req` close fires once the body has been read.
  const clientGone = new AbortController();
  const res = context.res;
  const onClientClose = () => {
    if (res && !res.writableEnded) clientGone.abort();
  };
  res?.once("close", onClientClose);

  // One deadline for the headers phase, shared by the idempotent retry.
  const headersTimeoutMs =
    context.proxyHeadersTimeoutMs ??
    agentProxyHeadersTimeoutMs(method, url.pathname);
  const deadline = Date.now() + headersTimeoutMs;

  for (let attempt = 0; ; attempt++) {
    const headersPhase = new AbortController();
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        headersPhase.abort(
          new DOMException("agent response headers timed out", "TimeoutError"),
        );
      },
      Math.max(0, deadline - Date.now()),
    );
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.any([headersPhase.signal, clientGone.signal]),
    };
    if (body) {
      init.body = body;
      init.duplex = "half";
    }
    try {
      return await fetch(targetUrl, init);
    } catch (error) {
      if (timedOut) {
        return Response.json(
          {
            error: "agent did not respond in time",
            code: "agent_timeout",
          },
          { status: 504, headers: corsHeaders(origin) },
        );
      }
      if (
        error instanceof BodyTooLargeError ||
        (error instanceof Error && error.cause instanceof BodyTooLargeError)
      ) {
        return requestBodyTooLargeResponse(origin);
      }
      // Only idempotent requests are safe to replay, and only a transport
      // failure (a cold/torn path) — never a real HTTP response — reaches here.
      if (
        !idempotent ||
        clientGone.signal.aborted ||
        attempt >= PROXY_TAILNET_RETRY_ATTEMPTS
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PROXY_TAILNET_RETRY_DELAY_MS),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function requestBodyTooLargeResponse(origin: string | undefined): Response {
  return Response.json(
    { error: "request body too large", code: "request_body_too_large" },
    { status: 413, headers: corsHeaders(origin) },
  );
}

export async function handleRequest(
  url: URL,
  req?: IncomingMessage,
  readiness: RouterReadinessState = { status: "ready" },
): Promise<Response> {
  return routeRequest(url, req, readiness, {
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  });
}

async function routeRequest(
  url: URL,
  req: IncomingMessage | undefined,
  readiness: RouterReadinessState,
  context: RouterRequestContext,
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
      return proxyAgentRequest(agentId, url, req, context);
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
  const routing = resolveSandboxRouting(await findSandbox(agentId, context), {
    allowBridgeHostFallback: isBridgeHostFallbackEnabled(),
  });
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

const RESPONSE_SKIP_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
]);

export async function sendResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => {
    // fetch has already decoded and de-chunked the body, so its framing and
    // encoding headers no longer describe what we send. set-cookie is joined
    // by forEach and is copied below as separate values.
    if (RESPONSE_SKIP_HEADERS.has(k)) return;
    res.setHeader(k, v);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
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

let stopActiveWarmup: (() => void) | null = null;

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

function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

/**
 * Relays a WebSocket (or other HTTP/1.1 Upgrade) request to the agent with the
 * same target pinning as plain requests. The Cloud Worker has already
 * authenticated the caller; the container applies its own auth.
 */
async function relayAgentUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  readiness: RouterReadinessState,
  context: RouterRequestContext,
): Promise<void> {
  // Node drops its own socket error handler on upgrade; a reset during the
  // routing lookup must not become an uncaught exception.
  socket.on("error", () => socket.destroy());
  const url = parseRequestTarget(req.url);
  if (!url) return rejectUpgrade(socket, 400);
  const agentId = extractAgentIdFromHost(getEffectiveHost(req));
  if (!agentId) return rejectUpgrade(socket, 404);
  if (readiness.status !== "ready") return rejectUpgrade(socket, 503);
  const { target, sandbox } = await resolveAgentProxyTarget(
    agentId,
    url.pathname,
    context,
  );
  if (!target) {
    return rejectUpgrade(
      socket,
      buildUnresolvedAgentResponse(sandbox, undefined).status,
    );
  }
  if (socket.destroyed) return;

  const targetUrl = buildAgentTargetUrl(target, url);
  const headers = buildProxyHeaders(req, target);
  headers.set("connection", "upgrade");
  headers.set("upgrade", headerValue(req.headers.upgrade) ?? "websocket");
  const lines = [
    `${req.method ?? "GET"} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`,
  ];
  headers.forEach((value, name) => {
    lines.push(`${name}: ${value}`);
  });

  const upstream: Socket = connect({
    host: targetUrl.hostname.replace(/^\[|\]$/g, ""),
    port: Number.parseInt(targetUrl.port || "80", 10),
  });
  let connected = false;
  const destroyBoth = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.setTimeout(WEBSOCKET_IDLE_TIMEOUT_MS, destroyBoth);
  upstream.once("connect", () => {
    connected = true;
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", (error) => {
    if (!connected) {
      void reportRouterError("upgrade connect error", error);
      upstream.destroy();
      rejectUpgrade(socket, 502);
      return;
    }
    destroyBoth();
  });
  upstream.once("close", () => {
    if (connected) socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  socket.once("close", () => upstream.destroy());
}

/**
 * Test-only seam: Bun's node:http does not deliver writes on an upgraded
 * socket, so tests drive the relay over a plain net socket.
 */
export const __agentRouterTestHooks = {
  relayAgentUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    findAgentSandboxRoutingById: FindAgentSandboxRoutingById,
  ): Promise<void> {
    return relayAgentUpgrade(
      req,
      socket,
      head,
      { status: "ready" },
      { findAgentSandboxRoutingById, maxBodyBytes: DEFAULT_MAX_BODY_BYTES },
    );
  },
};

export async function startAgentRouter(
  options: StartAgentRouterOptions = {},
): Promise<StartedAgentRouter> {
  const config = options.config ?? readRouterConfig();
  const readiness: RouterReadinessState = { status: "warming" };
  const usesDefaultWarmup = !options.warmRoutingDependencies;
  const warmRoutingDependencies =
    options.warmRoutingDependencies ??
    (async () => {
      await resolveAgentRouting("00000000-0000-4000-8000-000000000000");
    });
  const warmupTimeoutMs = options.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;
  const context: RouterRequestContext = {
    findAgentSandboxRoutingById: options.findAgentSandboxRoutingById,
    proxyHeadersTimeoutMs: options.proxyHeadersTimeoutMs,
    maxBodyBytes:
      options.maxBodyBytes ??
      parsePositiveInt(
        process.env.AGENT_ROUTER_MAX_BODY_BYTES,
        DEFAULT_MAX_BODY_BYTES,
      ),
  };

  const { createServer } = await import("node:http");
  const startedServer = createServer((req, res) => {
    const url = parseRequestTarget(req.url);
    if (!url) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "bad request target" }));
      return;
    }
    routeRequest(url, req, readiness, { ...context, res })
      .then((response) => sendResponse(res, response))
      .catch((err) => {
        const error = toError(err);
        void reportRouterError("handler error", error);
        if (res.headersSent || res.destroyed) {
          res.destroy(error);
          return;
        }
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal error" }));
      });
  });
  startedServer.on("upgrade", (req, socket, head) => {
    relayAgentUpgrade(req, socket, head, readiness, context).catch((err) => {
      void reportRouterError("upgrade error", toError(err));
      rejectUpgrade(socket, 502);
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

  // Warmup retries in-process until it succeeds: a transient database outage
  // at boot must not leave the router failed until the next restart. /readyz
  // keeps reporting router_dependencies_unavailable between attempts.
  let warmupStopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const stopWarmup = () => {
    warmupStopped = true;
    if (retryTimer) clearTimeout(retryTimer);
  };
  stopActiveWarmup = stopWarmup;
  startedServer.once("close", stopWarmup);

  let attemptPending = false;
  const runWarmupAttempt = (): Promise<void> => {
    attemptPending = true;
    const attempt = Promise.resolve().then(warmRoutingDependencies);
    // A late success of an attempt that already timed out still counts.
    attempt
      .then(
        () => {
          readiness.status = "ready";
        },
        () => {},
      )
      .finally(() => {
        attemptPending = false;
      });
    return withTimeout(attempt, warmupTimeoutMs);
  };

  const retryWarmup = (delayMs: number) => {
    if (warmupStopped || readiness.status === "ready") return;
    retryTimer = setTimeout(() => {
      if (warmupStopped || readiness.status === "ready") return;
      // One attempt at a time: a timed-out attempt may still be running.
      if (attemptPending) {
        retryWarmup(delayMs);
        return;
      }
      runWarmupAttempt().then(
        () => {},
        async (cause) => {
          if (readiness.status !== "ready") readiness.status = "failed";
          await reportRouterError("dependency warmup retry", toError(cause));
          retryWarmup(Math.min(delayMs * 2, MAX_WARMUP_RETRY_DELAY_MS));
        },
      );
    }, delayMs);
    retryTimer.unref?.();
  };

  if (usesDefaultWarmup) {
    // A module that fails to load or evaluate stays failed in this process
    // (ESM caches it), so retrying cannot help; exit and let systemd restart.
    loadDeps().catch(async (cause) => {
      await reportRouterError("routing modules failed to load", toError(cause));
      process.exit(1);
    });
  }

  const warmupSettled = runWarmupAttempt().then(
    () => {},
    async (cause) => {
      if (readiness.status !== "ready") readiness.status = "failed";
      retryWarmup(options.warmupRetryDelayMs ?? DEFAULT_WARMUP_RETRY_DELAY_MS);
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

  return { server: startedServer, readiness, warmupSettled, stopWarmup };
}

async function main(): Promise<void> {
  loadCloudLocalEnv(fileURLToPath(new URL("../../../", import.meta.url)));
  const started = await startAgentRouter();
  server = started.server;
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopActiveWarmup?.();
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
