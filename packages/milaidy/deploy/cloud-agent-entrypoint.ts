/**
 * Cloud Agent Entrypoint
 *
 * Runs inside the ECS container. Starts a real elizaOS AgentRuntime with
 * the ElizaCloud plugin for inference, serves a health endpoint on $PORT,
 * and a bridge HTTP server on $BRIDGE_PORT that forwards messages into
 * the runtime and serves snapshot/restore for state management.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? "3000");
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? "18790");

// ─── elizaOS Runtime ────────────────────────────────────────────────────

/**
 * The runtime is initialized asynchronously. All bridge requests that
 * need the runtime check `agentRuntime` and return 503 if it hasn't
 * started yet.
 */
let agentRuntime: {
  processMessage: (text: string, roomId: string) => Promise<string>;
  getMemories: () => Array<Record<string, unknown>>;
  getConfig: () => Record<string, unknown>;
} | null = null;

/** In-memory state that persists across snapshots. */
const state = {
  memories: [] as Array<Record<string, unknown>>,
  config: {} as Record<string, unknown>,
  workspaceFiles: {} as Record<string, string>,
  startedAt: new Date().toISOString(),
};

async function initRuntime(): Promise<void> {
  /**
   * Dynamic import — the elizaOS packages may or may not be installed in
   * the container image. When they are, we get a real agent runtime. When
   * they aren't (e.g., during development or bare container testing), we
   * fall back to the echo handler so the bridge protocol is still
   * exercisable end-to-end.
   */
  const elizaAvailable = await import("@elizaos/core")
    .then(() => true)
    .catch(() => false);

  if (elizaAvailable) {
    const {
      AgentRuntime,
      createCharacter,
      createMessageMemory,
      InMemoryDatabaseAdapter,
      mergeDbSettings,
      provisionAgent,
      stringToUuid,
      ChannelType,
    } = await import("@elizaos/core");

    const character = createCharacter({
      name: process.env.AGENT_NAME ?? "CloudAgent",
      bio: "An elizaOS agent running in the cloud.",
      secrets: {
        ...(process.env.ELIZAOS_CLOUD_API_KEY
          ? { ELIZAOS_CLOUD_API_KEY: process.env.ELIZAOS_CLOUD_API_KEY }
          : {}),
        ...(process.env.OPENAI_API_KEY
          ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
          : {}),
        ...(process.env.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
          : {}),
      },
    });

    const plugins = [];

    const cloudPlugin = await import("@elizaos/plugin-elizacloud")
      .then((m) => m.default ?? m.elizaOSCloudPlugin)
      .catch(() => null);
    if (cloudPlugin) plugins.push(cloudPlugin);

    const sqlPluginModule = await import("@elizaos/plugin-sql").catch(() => null);
    const sqlPlugin = sqlPluginModule?.default ?? sqlPluginModule?.sqlPlugin ?? null;
    if (sqlPlugin) plugins.push(sqlPlugin);

    const agentId = stringToUuid(character.name ?? "CloudAgent");
    const adapter = process.env.POSTGRES_URL && sqlPluginModule?.createDatabaseAdapter
      ? sqlPluginModule.createDatabaseAdapter(
          { postgresUrl: process.env.POSTGRES_URL },
          agentId,
        )
      : new InMemoryDatabaseAdapter();
    await adapter.initialize();

    const characterWithSettings = await mergeDbSettings(character, adapter, agentId);

    const runtime = new AgentRuntime({ character: characterWithSettings, adapter, plugins });
    await runtime.initialize();
    await provisionAgent(runtime, { runMigrations: true });

    const taskService = await runtime.getService("task");
    if (taskService && typeof (taskService as { startTimer?: () => void }).startTimer === "function") {
      (taskService as { startTimer: () => void }).startTimer();
    }

    const userId = crypto.randomUUID() as ReturnType<typeof stringToUuid>;
    const roomId = stringToUuid("cloud-agent-bridge-room");
    const worldId = stringToUuid("cloud-agent-world");

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "BridgeUser",
      source: "cloud-bridge",
      channelId: "cloud-bridge",
      type: ChannelType.DM,
    });

    agentRuntime = {
      processMessage: async (text: string, _roomId: string): Promise<string> => {
        const message = createMessageMemory({
          id: crypto.randomUUID() as ReturnType<typeof stringToUuid>,
          entityId: userId,
          roomId,
          content: { text, source: "cloud-bridge", channelType: ChannelType.DM },
        });

        let responseText = "";
        await runtime.messageService?.handleMessage(runtime, message, async (content) => {
          if (content?.text) responseText += content.text;
          return [];
        });

        state.memories.push({ role: "user", text, timestamp: Date.now() });
        state.memories.push({ role: "assistant", text: responseText, timestamp: Date.now() });

        return responseText || "(no response)";
      },
      getMemories: () => state.memories,
      getConfig: () => state.config,
    };

    console.log("[cloud-agent] elizaOS runtime initialized with real agent");
  } else {
    // Fallback: no elizaOS installed — echo mode for protocol testing
    console.warn("[cloud-agent] @elizaos/core not available, running in echo mode");
    agentRuntime = {
      processMessage: async (text: string): Promise<string> => {
        state.memories.push({ role: "user", text, timestamp: Date.now() });
        const reply = `[echo] ${text}`;
        state.memories.push({ role: "assistant", text: reply, timestamp: Date.now() });
        return reply;
      },
      getMemories: () => state.memories,
      getConfig: () => state.config,
    };
  }
}

// ─── Health endpoint ────────────────────────────────────────────────────

const healthServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: agentRuntime ? "healthy" : "initializing",
      uptime: process.uptime(),
      startedAt: state.startedAt,
      memoryUsage: process.memoryUsage().rss,
      runtimeReady: agentRuntime !== null,
    }));
    return;
  }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "elizaos-cloud-agent", status: "running" }));
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
});

healthServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[cloud-agent] Health endpoint listening on port ${PORT}`);
});

// ─── Bridge HTTP server ─────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const bridgeServer = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "POST" && req.url === "/api/snapshot") {
    res.writeHead(200);
    res.end(JSON.stringify({
      memories: state.memories,
      config: state.config,
      workspaceFiles: state.workspaceFiles,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/restore") {
    const body = await readBody(req);
    const incoming = JSON.parse(body) as Partial<typeof state>;
    if (incoming.memories) state.memories = incoming.memories;
    if (incoming.config) state.config = incoming.config;
    if (incoming.workspaceFiles) state.workspaceFiles = incoming.workspaceFiles;
    console.log("[cloud-agent] State restored from snapshot");
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/bridge") {
    const body = await readBody(req);
    const rpc = JSON.parse(body) as {
      jsonrpc: string;
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    };

    if (rpc.method === "message.send") {
      if (!agentRuntime) {
        res.writeHead(503);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "Agent runtime not ready" } }));
        return;
      }
      const text = (rpc.params?.text as string) ?? "";
      const roomId = (rpc.params?.roomId as string) ?? "default";
      const responseText = await agentRuntime.processMessage(text, roomId);
      res.writeHead(200);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { text: responseText, metadata: { timestamp: Date.now() } } }));
      return;
    }

    if (rpc.method === "status.get") {
      res.writeHead(200);
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: rpc.id,
        result: { status: agentRuntime ? "running" : "initializing", uptime: process.uptime(), memoriesCount: state.memories.length, startedAt: state.startedAt },
      }));
      return;
    }

    if (rpc.method === "heartbeat") {
      res.writeHead(200);
      res.end(JSON.stringify({ jsonrpc: "2.0", method: "heartbeat.ack", params: { timestamp: Date.now() } }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `Method not found: ${rpc.method}` } }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not Found" }));
});

bridgeServer.listen(BRIDGE_PORT, "0.0.0.0", () => {
  console.log(`[cloud-agent] Bridge server listening on port ${BRIDGE_PORT}`);
});

// ─── Startup ────────────────────────────────────────────────────────────

function shutdown() {
  console.log("[cloud-agent] Shutting down...");
  healthServer.close();
  bridgeServer.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Initialize runtime asynchronously — bridge returns 503 until ready
initRuntime().then(() => {
  console.log("[cloud-agent] Ready");
}).catch((err) => {
  console.error("[cloud-agent] Runtime init failed:", err);
  // Don't exit — health/bridge still work for diagnostics
});
