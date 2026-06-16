#!/usr/bin/env -S npx tsx

/**
 * Agent Router daemon.
 *
 * Resolves agent id → headscale IP / bridge port / web UI port for the nginx
 * wildcard subdomain router. Routing requires a persisted headscale_ip by default;
 * legacy bridge-host fallback is opt-in because public host + dynamic port
 * metadata is not a reliable ingress target after the Hetzner/control-plane
 * split.
 *
 * Usage:
 *   npx tsx packages/scripts/daemons/agent-router.ts
 *
 * Environment:
 *   AGENT_ROUTER_PORT       default 3458
 *   AGENT_ROUTER_BIND_HOST  default 127.0.0.1
 *   DATABASE_URL            Postgres connection (loaded from .env.local).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./shared/load-env";

type Logger = typeof import("@elizaos/cloud-shared/lib/utils/logger").logger;
type FindAgentSandboxRoutingById =
  typeof import("@elizaos/cloud-shared/db/agent-sandbox-routing").findAgentSandboxRoutingById;

interface RouterDeps {
  logger: Logger;
  findAgentSandboxRoutingById: FindAgentSandboxRoutingById;
}

interface AgentRouterConfig {
  port: number;
  bindHost: string;
}

const DEFAULT_PORT = 3458;
const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_AGENT_BASE_DOMAIN = "elizacloud.ai";
const AGENT_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
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

  // Legacy host routing (no headscale_ip): reach the agent through the docker
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

function buildProxyHeaders(req: IncomingMessage, target: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  headers.set("host", target);
  if (req.headers.host) headers.set("x-forwarded-host", req.headers.host);
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

async function proxyAgentRequest(
  agentId: string,
  url: URL,
  req: IncomingMessage,
): Promise<Response> {
  const routing = await resolveAgentRouting(agentId);
  if (!routing) {
    return Response.json(
      { error: "agent not found or not running" },
      { status: 404 },
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
  if (method !== "GET" && method !== "HEAD") {
    const body = await readIncomingBody(req);
    if (body) init.body = body;
  }

  return fetch(targetUrl, init);
}

async function handleRequest(
  url: URL,
  req?: IncomingMessage,
): Promise<Response> {
  if (url.pathname === "/healthz") {
    return Response.json({ ok: true }, { status: 200 });
  }
  // /headscale-ip is the path nginx Lua already calls; /routing is the alias
  // for new callers.
  const match = url.pathname.match(
    /^\/agents\/([^/]+)\/(headscale-ip|routing)$/,
  );
  if (!match) {
    const agentId = req ? extractAgentIdFromHost(getEffectiveHost(req)) : null;
    if (agentId && req) return proxyAgentRequest(agentId, url, req);
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const agentId = match[1];
  if (!AGENT_ID_RE.test(agentId)) {
    return Response.json({ error: "invalid agent id" }, { status: 400 });
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

async function sendResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => {
    res.setHeader(k, v);
  });
  const body = new Uint8Array(await response.arrayBuffer());
  res.end(body);
}

let server: import("node:http").Server | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  loadLocalEnv(import.meta.url);
  const config = readRouterConfig();
  await resolveAgentRouting("00000000-0000-4000-8000-000000000000");

  const { createServer } = await import("node:http");
  server = createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host || "localhost"}`,
    );
    handleRequest(url, req)
      .then((response) => sendResponse(res, response))
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        void loadDeps()
          .then(({ logger }) => {
            logger.error("[agent-router] handler error", { error });
          })
          .catch(() => {
            console.error(`[agent-router] handler error: ${error}`);
          });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
        }
        res.end(JSON.stringify({ error: "internal error" }));
      });
  });

  server.listen(config.port, config.bindHost, () => {
    console.log("[agent-router] starting", {
      port: config.port,
      bindHost: config.bindHost,
    });
  });

  server.on("error", (err) => {
    const error = err instanceof Error ? err.message : String(err);
    void loadDeps()
      .then(({ logger }) => {
        logger.error("[agent-router] server error", { error });
      })
      .catch(() => {
        console.error(`[agent-router] server error: ${error}`);
      });
    process.exitCode = 1;
  });
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!server) {
    process.exit(0);
  }
  server.close((err) => {
    if (err) {
      void loadDeps().then(({ logger }) => {
        logger.error("[agent-router] close error", {
          signal,
          error: err.message,
        });
      });
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  void loadDeps().then(({ logger }) => {
    logger.error("[agent-router] unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
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
