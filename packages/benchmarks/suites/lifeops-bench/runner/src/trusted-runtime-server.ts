/**
 * Dedicated elizaOS runtime process used by the trusted evidence executor.
 *
 * It loads production plugins, binds only to loopback, and exposes the narrow
 * allowlisted action boundary. The evaluated agent must run in another process
 * without this server's bearer token or evidence-signing credentials.
 */

import http from "node:http";
import { KnowledgeGraphService, knowledgeGraphSchema } from "@elizaos/agent";
import { resolveElizaPluginImportSpecifier } from "@elizaos/agent/runtime/plugin-types";
import { AgentRuntime, elizaLogger, type Plugin } from "@elizaos/core";
import dotenv from "dotenv";
import {
  type BenchmarkSession,
  createSession,
  formatUnknownError,
  selectPluginExport,
  toPlugin,
} from "./server-utils.js";
import {
  parseTrustedRuntimeEvidenceProvenance,
  TRUSTED_RUNTIME_ACTION_PATH,
  TrustedRuntimeActionHandler,
} from "./trusted-runtime-action-handler.js";

dotenv.config({ override: false });

const DEFAULT_PLUGINS = [
  "@elizaos/plugin-sql",
  "@elizaos/plugin-scheduling",
  "@elizaos/plugin-personal-assistant",
  "@elizaos/plugin-calendar",
] as const;
const TRUSTED_EVIDENCE_KNOWLEDGE_GRAPH_PLUGIN: Plugin = {
  name: "trusted-evidence-knowledge-graph",
  description:
    "Production entity and relationship stores used by trusted evidence actions.",
  schema: knowledgeGraphSchema,
  services: [KnowledgeGraphService],
};
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
  const candidate = selectPluginExport(pluginModule, pluginName);
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
  const evidenceProvenance = parseTrustedRuntimeEvidenceProvenance(process.env);
  const configuredPlugins = commaSeparated(
    process.env.ELIZA_BENCH_TRUSTED_RUNTIME_PLUGINS,
  );
  const pluginNames =
    configuredPlugins.length > 0 ? configuredPlugins : [...DEFAULT_PLUGINS];
  const plugins: Plugin[] = [TRUSTED_EVIDENCE_KNOWLEDGE_GRAPH_PLUGIN];
  for (const pluginName of pluginNames) {
    try {
      plugins.push(await loadPlugin(pluginName));
    } catch (error) {
      // error-policy:J2 Preserve the failing plugin import as the startup
      // error cause while adding the configured plugin identity.
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
    evidenceProvenance,
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
        evidenceTier: evidenceProvenance.tier,
        evidenceProvider: evidenceProvenance.provider,
        evidenceBoundary: evidenceProvenance.boundary,
        providerReadback: evidenceProvenance.provider_readback,
      },
      "Trusted runtime action server is ready",
    );
  });
}

startTrustedRuntimeServer().catch((error: unknown) => {
  // error-policy:J1 Process startup is the outermost boundary; it reports the
  // failure and exits instead of leaving a partially initialized server alive.
  elizaLogger.error(
    {
      src: "trusted-runtime-server",
      error: formatUnknownError(error),
    },
    "Trusted runtime action server failed to start",
  );
  process.exit(1);
});
