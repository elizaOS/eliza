#!/usr/bin/env -S npx tsx
/**
 * Agent Router daemon.
 *
 * Replaces /opt/milady-cloud/agent-lookup.cjs which queried the legacy
 * `milady_sandboxes` table. This daemon queries `agent_sandboxes` and
 * returns the same response shape so nginx Lua (`agent-router.lua`) keeps
 * working without changes.
 *
 * Usage:
 *   npx tsx packages/scripts/daemons/agent-router.ts
 *
 * Environment:
 *   AGENT_ROUTER_PORT  default 3458 — picked to avoid conflict with the
 *                      legacy agent-lookup.cjs on 3456 during transition.
 *   DATABASE_URL       Postgres connection (loaded from .env.local).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Logger = typeof import("../../lib/utils/logger").logger;
type Repo = typeof import("../../db/repositories/agent-sandboxes").agentSandboxesRepository;

interface RouterDeps {
  logger: Logger;
  agentSandboxesRepository: Repo;
}

export interface AgentRouterConfig {
  port: number;
  bindHost: string;
}

const DEFAULT_PORT = 3458;
const DEFAULT_BIND_HOST = "127.0.0.1";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadLocalEnv(): void {
  const scriptPath = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(scriptPath), "../../..");
  loadEnvFile(path.join(projectRoot, ".env.local"));
  loadEnvFile(path.join(projectRoot, ".env"));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readRouterConfig(env: NodeJS.ProcessEnv = process.env): AgentRouterConfig {
  return {
    port: parsePositiveInt(env.AGENT_ROUTER_PORT, DEFAULT_PORT),
    bindHost: env.AGENT_ROUTER_BIND_HOST?.trim() || DEFAULT_BIND_HOST,
  };
}

let depsPromise: Promise<RouterDeps> | null = null;

async function loadDeps(): Promise<RouterDeps> {
  if (!depsPromise) {
    depsPromise = Promise.all([
      import("../../db/repositories/agent-sandboxes"),
      import("../../lib/utils/logger"),
    ]).then(([repoModule, loggerModule]) => ({
      agentSandboxesRepository: repoModule.agentSandboxesRepository,
      logger: loggerModule.logger,
    }));
  }
  return depsPromise;
}

interface RoutingResponse {
  headscaleIp: string;
  bridgePort: number;
  webUiPort: number;
  target: string;
}

/**
 * Resolve routing info for a given agent id.
 * Exported so unit tests can call it without spinning up an HTTP server.
 */
export async function resolveAgentRouting(agentId: string): Promise<RoutingResponse | null> {
  const { agentSandboxesRepository } = await loadDeps();
  const sandbox = await agentSandboxesRepository.findById(agentId);
  if (!sandbox || sandbox.status !== "running") return null;
  if (!sandbox.bridge_url || !sandbox.web_ui_port) return null;

  let parsed: URL;
  try {
    parsed = new URL(sandbox.bridge_url);
  } catch {
    return null;
  }

  const host = parsed.hostname;
  const bridgePort = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
  const webUiPort = sandbox.web_ui_port;

  return {
    headscaleIp: host,
    bridgePort,
    webUiPort,
    target: `${host}:${webUiPort}`,
  };
}

const AGENT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function handleRequest(url: URL): Promise<Response> {
  if (url.pathname === "/healthz") {
    return Response.json({ ok: true }, { status: 200 });
  }
  const match = url.pathname.match(/^\/agents\/([^/]+)\/(headscale-ip|routing)$/);
  if (!match) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const agentId = match[1] ?? "";
  if (!AGENT_ID_RE.test(agentId)) {
    return Response.json({ error: "invalid agent id" }, { status: 400 });
  }
  const routing = await resolveAgentRouting(agentId);
  if (!routing) {
    return Response.json({ error: "agent not found or not running" }, { status: 404 });
  }
  return Response.json(routing, { status: 200 });
}

let server: import("node:http").Server | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  loadLocalEnv();
  const config = readRouterConfig();
  const { logger } = await loadDeps();

  const { createServer } = await import("node:http");
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    handleRequest(url)
      .then((response) => {
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        return response.text();
      })
      .then((body) => {
        res.end(body);
      })
      .catch((err) => {
        logger.error("[agent-router] handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
        }
        res.end(JSON.stringify({ error: "internal error" }));
      });
  });

  server.listen(config.port, config.bindHost, () => {
    logger.info("[agent-router] starting", {
      port: config.port,
      bindHost: config.bindHost,
    });
  });

  server.on("error", (err) => {
    logger.error("[agent-router] server error", {
      error: err instanceof Error ? err.message : String(err),
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
