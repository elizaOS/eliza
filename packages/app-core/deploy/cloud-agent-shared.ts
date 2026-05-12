/**
 * Shared Cloud Agent Logic
 *
 * Single implementation of the cloud-agent runtime, health server, and
 * bridge server. Both the main entrypoint and the template entrypoint
 * import from here, passing a config that captures the small differences.
 */

import * as crypto from "node:crypto";
import * as http from "node:http";

// ─── Types ──────────────────────────────────────────────────────────────

export interface BridgeRpcParams {
  text?: string;
  roomId?: string;
  mode?: string;
  channelType?: string;
  source?: string;
  sender?: {
    id?: string;
    username?: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export type NormalizedBridgeMessage = {
  text: string;
  roomKey: string;
  mode: "simple" | "power";
  channelType: "DM" | "GROUP";
  source: string;
  sender?: {
    id?: string;
    username?: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
};

export function normalizeBridgeMessage(
  params?: BridgeRpcParams,
): NormalizedBridgeMessage {
  const trimmedRoomId =
    typeof params?.roomId === "string" && params.roomId.trim().length > 0
      ? params.roomId.trim()
      : "default";
  const source =
    typeof params?.source === "string" && params.source.trim().length > 0
      ? params.source.trim()
      : "cloud-bridge";
  const sender =
    params?.sender && typeof params.sender === "object"
      ? {
          ...(typeof params.sender.id === "string" && params.sender.id.trim()
            ? { id: params.sender.id.trim() }
            : {}),
          ...(typeof params.sender.username === "string" &&
          params.sender.username.trim()
            ? { username: params.sender.username.trim() }
            : {}),
          ...(typeof params.sender.displayName === "string" &&
          params.sender.displayName.trim()
            ? { displayName: params.sender.displayName.trim() }
            : {}),
          ...(params.sender.metadata &&
          typeof params.sender.metadata === "object" &&
          !Array.isArray(params.sender.metadata)
            ? { metadata: params.sender.metadata }
            : {}),
        }
      : undefined;

  return {
    text: typeof params?.text === "string" ? params.text : "",
    roomKey: trimmedRoomId,
    mode: params?.mode === "simple" ? "simple" : "power",
    channelType: params?.channelType === "GROUP" ? "GROUP" : "DM",
    source,
    ...(sender && Object.keys(sender).length > 0 ? { sender } : {}),
    ...(params?.metadata &&
    typeof params.metadata === "object" &&
    !Array.isArray(params.metadata)
      ? { metadata: params.metadata }
      : {}),
  };
}

export interface CloudAgentConfig {
  /** Health endpoint port. Default: 2138 */
  port?: number;
  /** Bridge server port. Default: 18790 */
  bridgePort?: number;
  /**
   * If set, the bridge server requires `Authorization: Bearer <secret>`.
   * Omit or pass empty string to disable auth.
   */
  bridgeSecret?: string;
  /** Max request body size in bytes. Default: 1 MB */
  maxBodyBytes?: number;
  /** Max memories kept in state. 0 = unlimited. Default: 0 */
  maxMemories?: number;
  /**
   * Whether processMessage/processMessageStream accept a chat mode param.
   * When false the mode parameter is ignored (template behaviour).
   */
  enableChatMode?: boolean;
}

interface AgentRuntime {
  processMessage: (params: BridgeRpcParams) => Promise<string>;
  processMessageStream: (
    params: BridgeRpcParams,
    onChunk: (chunk: string) => void,
  ) => Promise<string>;
  getMemories: () => Array<Record<string, unknown>>;
  getConfig: () => Record<string, unknown>;
}

// ─── Main entry ─────────────────────────────────────────────────────────

export function startCloudAgent(userConfig: CloudAgentConfig = {}): void {
  const PORT = userConfig.port ?? Number(process.env.PORT ?? "2138");
  const BRIDGE_PORT =
    userConfig.bridgePort ?? Number(process.env.BRIDGE_PORT ?? "18790");
  const BRIDGE_SECRET = userConfig.bridgeSecret || crypto.randomUUID();
  const bridgeSecretGenerated = !userConfig.bridgeSecret;
  const MAX_BODY_BYTES = userConfig.maxBodyBytes ?? 1_048_576;
  const MAX_MEMORIES = userConfig.maxMemories ?? 0;
  const enableChatMode = userConfig.enableChatMode ?? false;

  let agentRuntime: AgentRuntime | null = null;

  /** In-memory state that persists across snapshots. */
  const state = {
    memories: [] as Array<Record<string, unknown>>,
    config: {} as Record<string, unknown>,
    workspaceFiles: {} as Record<string, string>,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };

  /** Trim memories array to MAX_MEMORIES, removing oldest entries first. */
  function trimMemories(): void {
    if (MAX_MEMORIES > 0 && state.memories.length > MAX_MEMORIES) {
      state.memories.splice(0, state.memories.length - MAX_MEMORIES);
    }
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let body = "";
      let totalBytes = 0;
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (MAX_BODY_BYTES > 0 && totalBytes > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  // ─── elizaOS Runtime ──────────────────────────────────────────────────

  async function initRuntime(): Promise<void> {
    const elizaAvailable = await import("@elizaos/core")
      .then(() => true)
      .catch(() => false);

    if (elizaAvailable) {
      const {
        AgentRuntime: AgentRuntimeCtor,
        createCharacter,
        createMessageMemory,
        stringToUuid,
        ChannelType,
      } = await import("@elizaos/core");

      const character = createCharacter({
        name: process.env.AGENT_NAME ?? "CloudAgent",
        bio: "An elizaOS agent running in the cloud.",
        settings: {
          ...(process.env.DATABASE_URL
            ? {
                POSTGRES_URL: process.env.DATABASE_URL,
                DATABASE_URL: process.env.DATABASE_URL,
              }
            : {}),
        },
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
          ...(process.env.GOOGLE_API_KEY
            ? { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY }
            : {}),
          ...(process.env.XAI_API_KEY
            ? { XAI_API_KEY: process.env.XAI_API_KEY }
            : {}),
          ...(process.env.GROQ_API_KEY
            ? { GROQ_API_KEY: process.env.GROQ_API_KEY }
            : {}),
        },
      });

      const plugins = [];

      const cloudPlugin = await import("@elizaos/plugin-elizacloud")
        .then((m) => m.default ?? m.elizaOSCloudPlugin)
        .catch(() => null);
      if (cloudPlugin) plugins.push(cloudPlugin);

      const sqlPlugin = await import("@elizaos/plugin-sql")
        .then((m) => m.default ?? m.sqlPlugin)
        .catch(() => null);
      if (sqlPlugin) plugins.push(sqlPlugin);

      const workflowPlugin = await import("@elizaos/plugin-workflow")
        .then((m) => m.default ?? m.workflowPlugin)
        .catch(() => null);
      if (workflowPlugin) plugins.push(workflowPlugin);

      const runtime = new AgentRuntimeCtor({ character, plugins });
      await runtime.initialize();
      const runtimeWithBridge = runtime as typeof runtime & {
        ensureWorldExists?: (world: Record<string, unknown>) => Promise<void>;
        ensureRoomExists?: (room: Record<string, unknown>) => Promise<void>;
        ensureParticipantInRoom?: (
          entityId: ReturnType<typeof stringToUuid>,
          roomId: ReturnType<typeof stringToUuid>,
        ) => Promise<void>;
        getEntityById?: (
          entityId: ReturnType<typeof stringToUuid>,
        ) => Promise<Record<string, unknown> | null>;
        createEntity?: (entity: Record<string, unknown>) => Promise<void>;
        updateEntity?: (entity: Record<string, unknown>) => Promise<void>;
      };

      const ensureBridgeContext = async (params: BridgeRpcParams) => {
        const normalized = normalizeBridgeMessage(params);
        const worldId = stringToUuid(
          `${normalized.source}-${normalized.channelType.toLowerCase()}-world`,
        );
        const serverId = stringToUuid(`${normalized.source}-bridge-server`);
        const roomId = stringToUuid(
          `${normalized.source}-bridge-room-${normalized.roomKey}`,
        );
        const entityKey =
          normalized.sender?.id ??
          normalized.sender?.username ??
          `${normalized.source}-bridge-user`;
        const entityId = stringToUuid(
          `${normalized.source}-bridge-user-${entityKey}`,
        );
        const channelType =
          normalized.channelType === "GROUP"
            ? ChannelType.GROUP
            : ChannelType.DM;
        const displayName =
          normalized.sender?.displayName ??
          normalized.sender?.username ??
          "BridgeUser";

        if (typeof runtimeWithBridge.ensureWorldExists === "function") {
          await runtimeWithBridge.ensureWorldExists({
            id: worldId,
            name: normalized.source === "discord" ? "Discord" : "Cloud Bridge",
            agentId: runtime.agentId,
            serverId,
          });
        }

        if (typeof runtimeWithBridge.ensureRoomExists === "function") {
          await runtimeWithBridge.ensureRoomExists({
            id: roomId,
            name: normalized.roomKey,
            type: channelType,
            channelId: normalized.roomKey,
            worldId,
            serverId,
            agentId: runtime.agentId,
            source: normalized.source,
          });
        }

        const entityMetadata =
          normalized.sender?.metadata &&
          typeof normalized.sender.metadata === "object" &&
          !Array.isArray(normalized.sender.metadata)
            ? normalized.sender.metadata
            : undefined;
        const entityPayload = {
          id: entityId,
          agentId: runtime.agentId,
          names: Array.from(
            new Set(
              [displayName, normalized.sender?.username].filter(
                (value): value is string => Boolean(value),
              ),
            ),
          ),
          ...(entityMetadata ? { metadata: entityMetadata } : {}),
        };

        try {
          if (
            typeof runtimeWithBridge.getEntityById === "function" &&
            typeof runtimeWithBridge.updateEntity === "function"
          ) {
            const existingEntity =
              await runtimeWithBridge.getEntityById(entityId);
            if (existingEntity) {
              await runtimeWithBridge.updateEntity({
                ...existingEntity,
                ...entityPayload,
                names:
                  entityPayload.names.length > 0
                    ? entityPayload.names
                    : ((existingEntity.names as string[] | undefined) ?? []),
              });
            } else if (typeof runtimeWithBridge.createEntity === "function") {
              await runtimeWithBridge.createEntity(entityPayload);
            }
          } else if (typeof runtimeWithBridge.createEntity === "function") {
            await runtimeWithBridge.createEntity(entityPayload);
          }
        } catch {
          // Best-effort entity sync. The room flow still works if the entity already exists.
        }

        if (typeof runtimeWithBridge.ensureParticipantInRoom === "function") {
          await Promise.all([
            runtimeWithBridge.ensureParticipantInRoom(runtime.agentId, roomId),
            runtimeWithBridge.ensureParticipantInRoom(entityId, roomId),
          ]);
        }

        return { normalized, entityId, roomId, channelType };
      };

      agentRuntime = {
        processMessage: async (params: BridgeRpcParams): Promise<string> => {
          const { normalized, entityId, roomId, channelType } =
            await ensureBridgeContext(params);
          const message = createMessageMemory({
            id: crypto.randomUUID() as ReturnType<typeof stringToUuid>,
            entityId,
            roomId,
            content: {
              text: normalized.text,
              ...(enableChatMode
                ? {
                    mode: normalized.mode,
                    simple: normalized.mode === "simple",
                  }
                : {}),
              source: normalized.source,
              channelType,
              ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
            },
          });

          let responseText = "";
          await runtime.messageService?.handleMessage(
            runtime,
            message,
            async (content) => {
              if (content?.text) responseText += content.text;
              return [];
            },
          );

          state.lastActivityAt = new Date().toISOString();
          state.memories.push({
            role: "user",
            text: normalized.text,
            timestamp: Date.now(),
            source: normalized.source,
            roomId: normalized.roomKey,
          });
          state.memories.push({
            role: "assistant",
            text: responseText,
            timestamp: Date.now(),
          });
          trimMemories();

          return responseText || "(no response)";
        },
        processMessageStream: async (
          params: BridgeRpcParams,
          onChunk: (chunk: string) => void,
        ): Promise<string> => {
          const { normalized, entityId, roomId, channelType } =
            await ensureBridgeContext(params);
          const message = createMessageMemory({
            id: crypto.randomUUID() as ReturnType<typeof stringToUuid>,
            entityId,
            roomId,
            content: {
              text: normalized.text,
              ...(enableChatMode
                ? {
                    mode: normalized.mode,
                    simple: normalized.mode === "simple",
                  }
                : {}),
              source: normalized.source,
              channelType,
              ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
            },
          });

          let responseText = "";
          await runtime.messageService?.handleMessage(
            runtime,
            message,
            async (content) => {
              if (content?.text) {
                responseText += content.text;
                onChunk(content.text);
              }
              return [];
            },
          );

          state.lastActivityAt = new Date().toISOString();
          state.memories.push({
            role: "user",
            text: normalized.text,
            timestamp: Date.now(),
            source: normalized.source,
            roomId: normalized.roomKey,
          });
          state.memories.push({
            role: "assistant",
            text: responseText,
            timestamp: Date.now(),
          });
          trimMemories();

          return responseText || "(no response)";
        },
        getMemories: () => state.memories,
        getConfig: () => state.config,
      };

      console.log("[cloud-agent] elizaOS runtime initialized with real agent");
    } else {
      console.warn(
        "[cloud-agent] @elizaos/core not available, running in echo mode",
      );
      agentRuntime = {
        processMessage: async (params: BridgeRpcParams): Promise<string> => {
          const normalized = normalizeBridgeMessage(params);
          state.memories.push({
            role: "user",
            text: normalized.text,
            timestamp: Date.now(),
            source: normalized.source,
            roomId: normalized.roomKey,
          });
          const reply = `[echo] ${normalized.text}`;
          state.memories.push({
            role: "assistant",
            text: reply,
            timestamp: Date.now(),
          });
          trimMemories();
          return reply;
        },
        processMessageStream: async (
          params: BridgeRpcParams,
          onChunk: (chunk: string) => void,
        ): Promise<string> => {
          const normalized = normalizeBridgeMessage(params);
          state.memories.push({
            role: "user",
            text: normalized.text,
            timestamp: Date.now(),
            source: normalized.source,
            roomId: normalized.roomKey,
          });
          const reply = `[echo] ${normalized.text}`;
          onChunk(reply);
          state.memories.push({
            role: "assistant",
            text: reply,
            timestamp: Date.now(),
          });
          trimMemories();
          return reply;
        },
        getMemories: () => state.memories,
        getConfig: () => state.config,
      };
    }
  }

  // ─── Health endpoint ──────────────────────────────────────────────────

  /** Consider the runtime hung if no activity for 10 minutes after init. */
  const HUNG_RUNTIME_THRESHOLD_MS = 10 * 60_000;

  const healthServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const lastActivityAge =
        Date.now() - new Date(state.lastActivityAt).getTime();
      const possiblyHung =
        agentRuntime !== null &&
        state.memories.length > 0 &&
        lastActivityAge > HUNG_RUNTIME_THRESHOLD_MS;

      let status: string;
      if (!agentRuntime) {
        status = "initializing";
      } else if (possiblyHung) {
        status = "possibly_hung";
      } else {
        status = "healthy";
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status,
          uptime: process.uptime(),
          startedAt: state.startedAt,
          lastActivityAt: state.lastActivityAt,
          memoryUsage: process.memoryUsage().rss,
          runtimeReady: agentRuntime !== null,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          service: "elizaos-cloud-agent",
          status: "running",
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  healthServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[cloud-agent] Health endpoint listening on port ${PORT}`);
  });

  // ─── Bridge HTTP server ───────────────────────────────────────────────

  const bridgeServer = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    // Auth check (only when BRIDGE_SECRET is configured)
    if (BRIDGE_SECRET) {
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${BRIDGE_SECRET}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (req.method === "POST" && req.url === "/api/snapshot") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          memories: state.memories,
          config: state.config,
          workspaceFiles: state.workspaceFiles,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/restore") {
      const body = await readBody(req);
      let incoming: Partial<typeof state>;
      try {
        incoming = JSON.parse(body) as Partial<typeof state>;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      if (incoming.memories) state.memories = incoming.memories;
      if (incoming.config) state.config = incoming.config;
      if (incoming.workspaceFiles)
        state.workspaceFiles = incoming.workspaceFiles;
      console.log("[cloud-agent] State restored from snapshot");
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── SSE streaming endpoint ────────────────────────────────────────
    if (req.method === "POST" && req.url === "/bridge/stream") {
      if (!agentRuntime) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent runtime not ready" }));
        return;
      }

      const body = await readBody(req);
      let rpc: {
        jsonrpc: string;
        id?: string | number;
        method?: string;
        params?: BridgeRpcParams;
      };
      try {
        rpc = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (rpc.method !== "message.send") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Only message.send is streamable" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent("connected", { rpcId: rpc.id, timestamp: Date.now() });

      await agentRuntime.processMessageStream(
        rpc.params ?? {},
        (chunk: string) => {
          sendEvent("chunk", { text: chunk });
        },
      );

      sendEvent("done", { rpcId: rpc.id, timestamp: Date.now() });
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/bridge") {
      const body = await readBody(req);
      let rpc: {
        jsonrpc: string;
        id?: string | number;
        method?: string;
        params?: BridgeRpcParams;
      };
      try {
        rpc = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (rpc.method === "message.send") {
        if (!agentRuntime) {
          res.writeHead(503);
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              error: {
                code: -32000,
                message: "Agent runtime not ready",
              },
            }),
          );
          return;
        }
        const responseText = await agentRuntime.processMessage(
          rpc.params ?? {},
        );
        res.writeHead(200);
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              text: responseText,
              metadata: { timestamp: Date.now() },
            },
          }),
        );
        return;
      }

      if (rpc.method === "status.get") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              status: agentRuntime ? "running" : "initializing",
              uptime: process.uptime(),
              memoriesCount: state.memories.length,
              startedAt: state.startedAt,
            },
          }),
        );
        return;
      }

      if (rpc.method === "heartbeat") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "heartbeat.ack",
            params: { timestamp: Date.now() },
          }),
        );
        return;
      }

      res.writeHead(200);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32601,
            message: `Method not found: ${rpc.method}`,
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  const bridgeBindAddress = bridgeSecretGenerated ? "127.0.0.1" : "0.0.0.0";
  bridgeServer.listen(BRIDGE_PORT, bridgeBindAddress, () => {
    console.log(
      `[cloud-agent] Bridge server listening on ${bridgeBindAddress}:${BRIDGE_PORT}`,
    );
    if (bridgeSecretGenerated) {
      console.warn(
        "[cloud-agent] CRITICAL: No BRIDGE_SECRET configured — generated ephemeral secret and bound to 127.0.0.1 only",
      );
      console.log(`[cloud-agent] Generated BRIDGE_SECRET: ${BRIDGE_SECRET}`);
    }
  });

  // ─── Startup ──────────────────────────────────────────────────────────

  function shutdown() {
    console.log("[cloud-agent] Shutting down...");
    healthServer.close();
    bridgeServer.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  initRuntime()
    .then(() => {
      console.log("[cloud-agent] Ready");
    })
    .catch((err) => {
      console.error("[cloud-agent] Runtime init failed:", err);
      process.exit(1);
    });
}
