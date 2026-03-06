/**
 * Milaidy Benchmark Server.
 *
 * Starts a lightweight HTTP server wrapping the full milaidy agent runtime
 * so that Python benchmark runners can communicate via HTTP.
 *
 * Usage:
 *   node --import tsx packages/milaidy/src/benchmark/server.ts
 *
 * Env vars:
 *   MILAIDY_BENCH_PORT  – port to listen on (default 3939)
 *
 * @module benchmark/server
 */
import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";

import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  logger,
  stringToUuid,
  type Character,
  type Plugin,
  type UUID,
} from "@elizaos/core";

import { loadMilaidyConfig, type MilaidyConfig } from "../config/config.js";
import { createMilaidyPlugin } from "../milaidy-plugin.js";
import {
  ensureAgentWorkspace,
  resolveDefaultAgentWorkspaceDir,
} from "../providers/workspace.js";

import {
  createBenchmarkPlugin,
  setBenchmarkContext,
  getCapturedAction,
  clearCapturedAction,
  BENCHMARK_MESSAGE_TEMPLATE,
  type BenchmarkContext,
  type CapturedAction,
} from "./plugin.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginModuleShape {
  default?: Plugin;
  plugin?: Plugin;
}

interface MessageRequest {
  text: string;
  context?: BenchmarkContext;
}

interface MessageResponse {
  text: string;
  thought: string | null;
  actions: string[];
  params: Record<string, unknown>;
}

interface ResetRequest {
  task_id: string;
  benchmark: string;
}

// ---------------------------------------------------------------------------
// Plugin resolution (simplified from eliza.ts — benchmarks only need model
// providers, not channels or UI plugins)
// ---------------------------------------------------------------------------

const PROVIDER_PLUGIN_MAP: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
  OPENAI_API_KEY: "@elizaos/plugin-openai",
  GOOGLE_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-genai",
  GROQ_API_KEY: "@elizaos/plugin-groq",
  XAI_API_KEY: "@elizaos/plugin-xai",
  OPENROUTER_API_KEY: "@elizaos/plugin-openrouter",
  OLLAMA_BASE_URL: "@elizaos/plugin-ollama",
};

function looksLikePlugin(value: unknown): value is Plugin {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.description === "string";
}

function extractPlugin(mod: PluginModuleShape): Plugin | null {
  if (looksLikePlugin(mod.default)) return mod.default;
  if (looksLikePlugin(mod.plugin)) return mod.plugin;
  if (looksLikePlugin(mod)) return mod as unknown as Plugin;
  return null;
}

async function resolveModelPlugins(): Promise<Plugin[]> {
  const plugins: Plugin[] = [];

  for (const [envKey, pluginName] of Object.entries(PROVIDER_PLUGIN_MAP)) {
    if (!process.env[envKey]) continue;
    try {
      const mod = (await import(pluginName)) as PluginModuleShape;
      const pluginInstance = extractPlugin(mod);
      if (pluginInstance) {
        plugins.push(pluginInstance);
        logger.info(`[bench] Loaded model plugin: ${pluginName}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[bench] Could not load ${pluginName}: ${msg}`);
    }
  }

  // Also try core plugins needed for basic operation
  for (const coreName of ["@elizaos/plugin-sql"]) {
    try {
      const mod = (await import(coreName)) as PluginModuleShape;
      const pluginInstance = extractPlugin(mod);
      if (pluginInstance) {
        plugins.push(pluginInstance);
        logger.info(`[bench] Loaded core plugin: ${coreName}`);
      }
    } catch {
      // Non-fatal — SQL plugin may not be needed for all benchmarks
    }
  }

  return plugins;
}

// ---------------------------------------------------------------------------
// Build Character
// ---------------------------------------------------------------------------

function buildBenchmarkCharacter(config: MilaidyConfig): Character {
  const name = config.agent?.name ?? "Milaidy";
  const bio =
    config.agent?.bio ??
    "An AI assistant powered by Milaidy and elizaOS, executing benchmark tasks with precision.";

  // Collect API secrets from env
  const secretKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OLLAMA_BASE_URL",
  ];

  const secrets: Record<string, string> = {};
  for (const key of secretKeys) {
    const value = process.env[key];
    if (value?.trim()) {
      secrets[key] = value;
    }
  }

  return createCharacter({
    name,
    bio,
    system:
      `You are ${name}, an autonomous AI agent executing benchmark tasks. ` +
      `Analyze the task context carefully and take precise, effective actions.`,
    secrets,
    templates: {
      messageHandlerTemplate: BENCHMARK_MESSAGE_TEMPLATE,
    },
    settings: {
      checkShouldRespond: false, // Always respond in benchmark mode
    },
  });
}

// ---------------------------------------------------------------------------
// Runtime creation
// ---------------------------------------------------------------------------

async function createBenchmarkRuntime(
  config: MilaidyConfig,
): Promise<AgentRuntime> {
  const character = buildBenchmarkCharacter(config);

  // Workspace setup
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  // Skip bootstrap files for benchmarks — the benchmark plugin provides all
  // context and the templates may not be present in development layouts.
  await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: false });

  // Create plugins
  const agentId =
    character.name?.toLowerCase().replace(/\s+/g, "-") ?? "main";
  const milaidyPlugin = createMilaidyPlugin({
    workspaceDir,
    bootstrapMaxChars: config.agents?.defaults?.bootstrapMaxChars,
    agentId,
  });
  const benchmarkPlugin = createBenchmarkPlugin();

  const modelPlugins = await resolveModelPlugins();

  if (modelPlugins.length === 0) {
    logger.warn(
      "[bench] No model provider plugins loaded — set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)",
    );
  }

  // Separate SQL plugin for pre-registration
  const sqlPlugin = modelPlugins.find((p) => p.name === "sql");
  const otherPlugins = modelPlugins.filter((p) => p.name !== "sql");

  const runtime = new AgentRuntime({
    character,
    plugins: [milaidyPlugin, benchmarkPlugin, ...otherPlugins],
  });

  if (sqlPlugin) {
    await runtime.registerPlugin(sqlPlugin);
  }

  await runtime.initialize();

  logger.info(
    `[bench] Runtime initialized — agent=${character.name}, plugins=${runtime.plugins?.length ?? 0}`,
  );

  return runtime;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const port = Number(process.env.MILAIDY_BENCH_PORT ?? "3939");

  // Load config
  let config: MilaidyConfig;
  try {
    config = loadMilaidyConfig();
  } catch {
    logger.warn("[bench] No config found, using defaults");
    config = {} as MilaidyConfig;
  }

  // Create runtime
  logger.info("[bench] Initializing milaidy benchmark runtime...");
  const runtime = await createBenchmarkRuntime(config);

  const agentName = runtime.character?.name ?? "Milaidy";
  const userId = crypto.randomUUID() as UUID;

  // Per-session state
  let currentRoomId = stringToUuid(`bench-${crypto.randomUUID()}`);

  async function ensureRoom(roomId: UUID): Promise<void> {
    try {
      await runtime.ensureConnection({
        entityId: userId,
        roomId,
        worldId: stringToUuid("benchmark-world"),
        userName: "BenchmarkRunner",
        source: "benchmark",
        channelId: "benchmark",
        type: ChannelType.API,
      });
    } catch {
      // Ignore — room may already exist
    }
  }

  await ensureRoom(currentRoomId);

  // Request handler
  const server = http.createServer(async (req, res) => {
    // CORS
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      // Health check
      if (pathname === "/api/benchmark/health" && req.method === "GET") {
        jsonResponse(res, 200, {
          status: "ready",
          agent_name: agentName,
          plugins: runtime.plugins?.length ?? 0,
        });
        return;
      }

      // Reset session
      if (pathname === "/api/benchmark/reset" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as ResetRequest;

        // Create a fresh room for the new task
        currentRoomId = stringToUuid(`bench-${body.task_id}-${crypto.randomUUID()}`);
        await ensureRoom(currentRoomId);

        // Clear benchmark state
        setBenchmarkContext(null);
        clearCapturedAction();

        jsonResponse(res, 200, { status: "ok", room_id: currentRoomId });
        return;
      }

      // Send message
      if (pathname === "/api/benchmark/message" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as MessageRequest;

        if (!body.text) {
          jsonResponse(res, 400, { error: "Missing 'text' field" });
          return;
        }

        // Set benchmark context for the provider
        if (body.context) {
          setBenchmarkContext(body.context);
        }

        // Clear previous captured action
        clearCapturedAction();

        // Create message memory
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId: currentRoomId,
          content: {
            text: body.text,
            source: "benchmark",
            channelType: ChannelType.API,
          },
        });

        // Process through the FULL canonical pipeline
        let responseText = "";
        let responseThought: string | null = null;
        let responseActions: string[] = [];

        const result = await runtime.messageService?.handleMessage(
          runtime,
          message,
          async (content) => {
            if (content?.text) {
              responseText += content.text;
            }
            return [];
          },
        );

        // Extract structured data from result
        if (result?.response_content ?? result?.responseContent) {
          const rc = result.response_content ?? result.responseContent;
          if (rc) {
            responseText = responseText || rc.text || "";
            responseThought = rc.thought ?? null;
            responseActions = rc.actions ?? [];
          }
        }

        // Build params from captured action
        const captured = getCapturedAction();
        const params: Record<string, unknown> = {};
        if (captured) {
          if (captured.command !== undefined) params.command = captured.command;
          if (captured.toolName !== undefined)
            params.tool_name = captured.toolName;
          if (captured.arguments !== undefined)
            params.arguments = captured.arguments;
          if (captured.operation !== undefined)
            params.operation = captured.operation;
          if (captured.elementId !== undefined)
            params.element_id = captured.elementId;
          if (captured.value !== undefined) params.value = captured.value;
        }

        const response: MessageResponse = {
          text: responseText,
          thought: responseThought,
          actions: responseActions,
          params,
        };

        jsonResponse(res, 200, response as unknown as Record<string, unknown>);
        return;
      }

      // 404
      jsonResponse(res, 404, { error: "Not found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[bench] Request error: ${msg}`);
      jsonResponse(res, 500, { error: msg });
    }
  });

  server.listen(port, () => {
    logger.info(`[bench] Milaidy benchmark server listening on port ${port}`);
    // Print to stdout so the Python manager can detect startup
    console.log(`MILAIDY_BENCH_READY port=${port}`);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("[bench] Shutting down...");
    server.close();
    runtime
      .stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(
    "[bench] Fatal:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
