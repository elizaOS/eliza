/**
 * Dedicated elizaOS runtime process used by the trusted evidence executor.
 *
 * It loads production plugins, binds only to loopback, and exposes the narrow
 * allowlisted action boundary. The evaluated agent must run in another process
 * without this server's bearer token or evidence-signing credentials.
 */

import http from "node:http";
import { resolveElizaPluginImportSpecifier } from "@elizaos/agent/runtime/plugin-types";
import {
  AgentRuntime,
  elizaLogger,
  type Plugin,
} from "@elizaos/core";
import dotenv from "dotenv";
import {
  createSession,
  formatUnknownError,
  toPlugin,
  type BenchmarkSession,
} from "./server-utils.js";
import {
  TrustedRuntimeActionHandler,
  TRUSTED_RUNTIME_ACTION_PATH,
} from "./trusted-runtime-action-handler.js";

dotenv.config({ override: false });

const DEFAULT_PLUGINS = [
  "@elizaos/plugin-sql",
  "@elizaos/plugin-personal-assistant",
  "@elizaos/plugin-calendar",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function commaSeparated(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

async function loadPlugin(pluginName: string): Promise<Plugin> {
  const pluginModule = (await import(
    resolveElizaPluginImportSpecifier(pluginName)
  )) as Record<string, unknown>;
  const candidate =
    pluginModule.default ?? pluginModule[Object.keys(pluginModule)[0]];
  if (!candidate) {
    throw new Error(`plugin ${pluginName} has no exported plugin object`);
  }
  return toPlugin(candidate, pluginName);
}

export async function startTrustedRuntimeServer(): Promise<void> {
  const host =
    process.env.ELIZA_BENCH_TRUSTED_RUNTIME_HOST?.trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      "trusted runtime server must bind to loopback; use a mutually authenticated reverse proxy for remote access",
    );
  }
  const port = Number(
    process.env.ELIZA_BENCH_TRUSTED_RUNTIME_PORT?.trim() || "3941",
  );
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error("ELIZA_BENCH_TRUSTED_RUNTIME_PORT is invalid");
  }
  const bearerToken =
    process.env.ELIZA_BENCH_TRUSTED_RUNTIME_TOKEN?.trim() || "";
  if (!bearerToken) {
    throw new Error("ELIZA_BENCH_TRUSTED_RUNTIME_TOKEN is required");
  }
  if (
    process.env.ELIZA_BENCH_TOKEN?.trim() &&
    bearerToken === process.env.ELIZA_BENCH_TOKEN?.trim()
  ) {
    throw new Error(
      "trusted runtime and evaluated-agent benchmark tokens must be distinct",
    );
  }
  const allowedActionNames = commaSeparated(
    process.env.ELIZA_BENCH_TRUSTED_RUNTIME_ALLOWED_ACTIONS,
  );
  if (allowedActionNames.length === 0) {
    throw new Error(
      "ELIZA_BENCH_TRUSTED_RUNTIME_ALLOWED_ACTIONS must explicitly allow at least one action",
    );
  }
  const configuredPlugins = commaSeparated(
    process.env.ELIZA_BENCH_TRUSTED_RUNTIME_PLUGINS,
  );
  const pluginNames =
    configuredPlugins.length > 0
      ? configuredPlugins
      : [...DEFAULT_PLUGINS];
  const plugins: Plugin[] = [];
  for (const pluginName of pluginNames) {
    try {
      plugins.push(await loadPlugin(pluginName));
    } catch (error) {
      throw new Error(
        `trusted runtime could not load ${pluginName}: ${formatUnknownError(error)}`,
        { cause: error },
      );
    }
  }

  const runtime = new AgentRuntime({
    character: {
      name: "LifeOps Evidence Runtime",
      bio: ["Executes owner-authorized LifeOps actions for evidence capture."],
      messageExamples: [],
      adjectives: [],
      plugins: [],
      settings: { secrets: {} },
    },
    plugins,
  });
  await runtime.initialize();

  const registeredActions = new Set(
    runtime.getAllActions().map((action) => action.name),
  );
  const missingActions = allowedActionNames.filter(
    (name) => !registeredActions.has(name),
  );
  if (missingActions.length > 0) {
    throw new Error(
      `trusted runtime allowlist contains unregistered actions: ${missingActions.join(", ")}`,
    );
  }
  const sessions = new Map<string, BenchmarkSession>();
  const resolveSession = (taskId: string): BenchmarkSession => {
    const existing = sessions.get(taskId);
    if (existing) return existing;
    const created = createSession(taskId, "lifeops_trusted_runtime");
    sessions.set(taskId, created);
    return created;
  };
  const handler = new TrustedRuntimeActionHandler({
    runtime,
    bearerToken,
    allowedActions: new Set(allowedActionNames),
    resolveSession,
  });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (await handler.tryHandle(req, res, pathname)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, host, () => {
    elizaLogger.info(
      {
        src: "trusted-runtime-server",
        host,
        port,
        path: TRUSTED_RUNTIME_ACTION_PATH,
        plugins: pluginNames,
        actions: allowedActionNames,
      },
      "Trusted runtime action server is ready",
    );
  });
}

startTrustedRuntimeServer().catch((error: unknown) => {
  elizaLogger.error(
    {
      src: "trusted-runtime-server",
      error: formatUnknownError(error),
    },
    "Trusted runtime action server failed to start",
  );
  process.exit(1);
});
