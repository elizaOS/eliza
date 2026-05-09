import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  type IAgentRuntime,
  mergeCharacterDefaults,
  type Plugin,
  stringToUuid,
} from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import workflowPlugin from "@elizaos/plugin-workflow";
import { getAdvertisedServerUrl } from "./config";
import { type DispatchResult, dispatchEvent, type JsonObject } from "./handlers/event";
import { logger } from "./logger";
import { getRedis } from "./redis";

interface AgentEntry {
  agentId: string;
  characterRef: string;
  runtime: IAgentRuntime;
  state: "running" | "stopped";
}

/**
 * Platform metadata forwarded by the gateway webhook alongside a user message.
 * All fields are optional for backward compatibility with callers that don't
 * provide platform context (e.g. direct API calls, older gateway versions).
 */
export interface MessageMetadata {
  /** Originating platform (e.g. "telegram", "whatsapp", "twilio", "blooio"). */
  platformName?: string;
  /** Display name of the sender as reported by the platform adapter. */
  senderName?: string;
  /** Platform-specific chat/conversation ID for reply routing. */
  chatId?: string;
}

// Must stay in sync with Platform type in gateway-webhook/src/adapters/types.ts
// and SUPPORTED_PLATFORMS in app/api/internal/webhook/config/route.ts
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(["telegram", "whatsapp", "twilio", "blooio"]);

/** Returns the message source, falling back to "agent-server" when no platform is specified or unrecognized. */
export function resolveSource(metadata?: MessageMetadata): string {
  if (metadata?.platformName && KNOWN_PLATFORMS.has(metadata.platformName)) {
    return metadata.platformName;
  }
  if (metadata?.platformName) {
    logger.warn("Unrecognized platformName, falling back to agent-server", {
      platformName: metadata.platformName,
    });
  }
  return "agent-server";
}

const MAX_USER_NAME_LENGTH = 255;
const MAX_CHAT_ID_LENGTH = 128;

/** Returns the display name for the connection, falling back to the raw userId. Caps length to prevent oversized values from reaching the database. */
export function resolveUserName(userId: string, metadata?: MessageMetadata): string {
  const name = metadata?.senderName || userId;
  return name.length > MAX_USER_NAME_LENGTH ? name.slice(0, MAX_USER_NAME_LENGTH) : name;
}

/**
 * Builds a metadata record for ensureConnection() from platform context.
 * Returns undefined when no platform-specific fields are present, keeping
 * the connection params backward-compatible.
 */
export function buildConnectionMetadata(
  metadata?: MessageMetadata,
): Record<string, string> | undefined {
  const validPlatform =
    metadata?.platformName && KNOWN_PLATFORMS.has(metadata.platformName)
      ? metadata.platformName
      : undefined;

  if (!validPlatform) {
    if (metadata?.chatId && !metadata?.platformName) {
      logger.debug("Discarding chatId — no platformName provided");
    }
    return undefined;
  }

  const result: Record<string, string> = { platformName: validPlatform };
  if (metadata?.chatId) {
    result.chatId = metadata.chatId.slice(0, MAX_CHAT_ID_LENGTH);
  }
  return result;
}

const REDIS_STATE_TTL_SECONDS = Math.max(
  60,
  Number.parseInt(process.env.REDIS_STATE_TTL_SECONDS ?? "120", 10) || 120,
);
const REDIS_REFRESH_INTERVAL_MS = 30_000;
const AGENT_ROUTING_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Manages the lifecycle of agent runtimes within this pod.
 *
 * Responsibilities:
 *   - Maintains an in-memory Map of loaded agents and their runtimes
 *   - Tracks in-flight request count for graceful SIGTERM drain
 *   - Publishes server/agent state to Redis for gateway routing
 *   - Provides handleMessage() and handleEvent() entry points
 */
export class AgentManager {
  private agents = new Map<string, AgentEntry>();
  private _draining = false;
  private inFlight = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Returns the internal K8s service URL for this pod. */
  private getServerUrl(): string {
    return getAdvertisedServerUrl();
  }

  /** Publishes server status, URL, and agent→server mappings to Redis with TTLs. */
  private async refreshRedisState(status = this._draining ? "draining" : "running") {
    const redis = getRedis();
    const multi = redis.multi();
    const serverName = process.env.SERVER_NAME!;

    multi.set(`server:${serverName}:status`, status, "EX", REDIS_STATE_TTL_SECONDS);
    multi.set(`server:${serverName}:url`, this.getServerUrl(), "EX", REDIS_STATE_TTL_SECONDS);

    for (const agentId of this.agents.keys()) {
      multi.set(`agent:${agentId}:server`, serverName, "EX", AGENT_ROUTING_TTL_SECONDS);
    }

    await multi.exec();
  }

  /** Starts the periodic Redis state refresh timer. */
  private startHeartbeat() {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void this.refreshRedisState().catch((err) => {
        logger.error("Failed to refresh agent-server Redis state", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, REDIS_REFRESH_INTERVAL_MS);

    if (typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  /** Stops the periodic Redis state refresh timer. */
  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Initializes Redis state and starts the heartbeat. Must be called before accepting traffic. */
  async initialize() {
    await this.refreshRedisState("running");
    this.startHeartbeat();
  }

  /** Returns true when SIGTERM has been received and the server is draining. */
  isDraining(): boolean {
    return this._draining;
  }

  /** Returns a snapshot of server and agent state for the /status endpoint. */
  getStatus() {
    return {
      serverName: process.env.SERVER_NAME,
      tier: process.env.TIER,
      capacity: Number(process.env.CAPACITY),
      agentCount: this.agents.size,
      inFlight: this.inFlight,
      draining: this._draining,
      agents: [...this.agents.values()].map((a) => ({
        agentId: a.agentId,
        characterRef: a.characterRef,
        state: a.state,
      })),
    };
  }

  /**
   * Returns the IAgentRuntime for a loaded, running agent.
   * @throws {Error} "Agent not found" if the agent is not loaded on this pod
   * @throws {Error} "Agent not running" if the agent is in a stopped state
   */
  getRuntime(agentId: string): IAgentRuntime {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error("Agent not found");
    if (entry.state !== "running") throw new Error("Agent not running");
    return entry.runtime;
  }

  /**
   * Starts a new agent runtime on this pod.
   * Reserves capacity immediately, then initializes the runtime asynchronously.
   * @throws {Error} "At capacity" if no slots are available
   * @throws {Error} "Agent already exists" if the agent is already loaded
   */
  async startAgent(agentId: string, characterRef: string) {
    if (this.agents.size >= Number(process.env.CAPACITY)) {
      throw new Error("At capacity");
    }
    if (this.agents.has(agentId)) {
      throw new Error("Agent already exists");
    }

    // Reserve the slot immediately to prevent concurrent requests from exceeding capacity
    this.agents.set(agentId, {
      agentId,
      characterRef,
      runtime: null as unknown as IAgentRuntime,
      state: "stopped",
    });

    try {
      const character = mergeCharacterDefaults({
        name: characterRef.toLowerCase(),
        secrets: {
          POSTGRES_URL: process.env.POSTGRES_URL || "",
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
          ELIZAOS_CLOUD_API_KEY: process.env.ELIZAOS_CLOUD_API_KEY || "",
        },
      });

      // Priority: elizacloud (proxy) > openai
      const plugins: Plugin[] = [sqlPlugin as Plugin, workflowPlugin as Plugin];
      if (process.env.ELIZAOS_CLOUD_API_KEY) {
        const elizacloudPlugin = await import("@elizaos/plugin-elizacloud");
        plugins.push(elizacloudPlugin.default as Plugin);
      } else if (process.env.OPENAI_API_KEY) {
        const openaiMod = (await import("@elizaos/plugin-openai")) as {
          openaiPlugin?: Plugin;
          default?: Plugin;
        };
        const openaiPlugin = openaiMod.openaiPlugin ?? openaiMod.default;
        if (!openaiPlugin) {
          throw new Error("@elizaos/plugin-openai: expected openaiPlugin or default export");
        }
        plugins.push(openaiPlugin);
      }

      const runtime = new AgentRuntime({ character, plugins });
      const skipMigrations = process.env.SKIP_MIGRATIONS === "true";
      await runtime.initialize({ skipMigrations });

      this.agents.set(agentId, {
        agentId,
        characterRef,
        runtime,
        state: "running",
      });
      await this.refreshRedisState();
    } catch (err) {
      this.agents.delete(agentId);
      throw err;
    }
  }

  /** Stops a running agent's runtime, transitioning it to "stopped" state. */
  async stopAgent(id: string) {
    const entry = this.agents.get(id);
    if (!entry) throw new Error("Agent not found");
    if (entry.state === "stopped") return;
    await entry.runtime.stop();
    entry.state = "stopped";
    await this.refreshRedisState();
  }

  /** Stops and removes an agent, cleaning up its Redis routing key. */
  async deleteAgent(id: string) {
    const entry = this.agents.get(id);
    if (!entry) throw new Error("Agent not found");
    if (entry.state === "running") await entry.runtime.stop();
    this.agents.delete(id);
    await getRedis().del(`agent:${id}:server`);
    await this.refreshRedisState();
  }

  /** Runs work against a loaded runtime while participating in drain tracking. */
  async useRuntime<T>(agentId: string, fn: (runtime: IAgentRuntime) => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await fn(this.getRuntime(agentId));
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Handles a structured event delivered by the gateway's forwardEventToServer().
   *
   * Tracks in-flight count so drain() waits for event processing to complete
   * before stopping runtimes on SIGTERM. Delegates dispatch to handlers/event.ts.
   */
  async handleEvent(
    agentId: string,
    userId: string,
    type: "cron" | "notification" | "system",
    payload: JsonObject,
  ): Promise<DispatchResult> {
    this.inFlight++;
    try {
      const rt = this.getRuntime(agentId);
      return await dispatchEvent(rt, agentId, userId, type, payload);
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Handles a user message by routing it through the agent's message pipeline.
   * Tracks in-flight count for graceful drain during SIGTERM.
   *
   * @param metadata - Optional platform context forwarded by the gateway webhook.
   *   When provided, `senderName` personalizes the connection's userName,
   *   `platformName` sets the message source (e.g. "telegram"), and `chatId`
   *   is stored in connection metadata for future proactive reply routing.
   */
  async handleMessage(agentId: string, userId: string, text: string, metadata?: MessageMetadata) {
    this.inFlight++;
    try {
      const rt = this.getRuntime(agentId);
      const uid = stringToUuid(userId);
      const roomId = stringToUuid(`${agentId}:${userId}`);
      const worldId = stringToUuid(`server:${process.env.SERVER_NAME}`);
      const source = resolveSource(metadata);
      const userName = resolveUserName(userId, metadata);
      const connMeta = buildConnectionMetadata(metadata);

      if (metadata) {
        // senderName and chatId excluded (PII — phone numbers, display names)
        logger.debug("Handling message with platform context", {
          agentId,
          source,
        });
      }

      // The intersection narrows the cast to only the extra `metadata`
      // field so the compiler still checks the standard fields.
      await rt.ensureConnection({
        entityId: uid,
        roomId,
        worldId,
        userName,
        source,
        channelId: `${agentId}-${userId}`,
        type: ChannelType.DM,
        ...(connMeta && { metadata: connMeta }),
      } as Parameters<typeof rt.ensureConnection>[0] & {
        metadata?: Record<string, string>;
      });

      const mem = createMessageMemory({
        entityId: uid,
        roomId,
        content: {
          text,
          source,
          channelType: ChannelType.DM,
        },
      });

      let response = "";
      await rt.messageService?.handleMessage(rt, mem, async (content) => {
        if (content?.text) response += content.text;
        return [];
      });

      return response || "No response generated.";
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Initiates graceful drain: marks the server as draining, waits up to 50s
   * for in-flight requests (messages + events) to complete, then stops all runtimes.
   */
  async drain() {
    this._draining = true;
    await this.refreshRedisState("draining");
    this.stopHeartbeat();

    // Wait for in-flight requests to finish before stopping runtimes
    const deadline = Date.now() + 50_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    for (const [, entry] of this.agents) {
      if (entry.state === "running") {
        await entry.runtime.stop();
        entry.state = "stopped";
      }
    }
  }

  /** Removes this server's status/url keys from Redis during shutdown. */
  async cleanupRedis() {
    this.stopHeartbeat();
    const redis = getRedis();
    // Only clean server status/url — agent mappings are managed by the operator
    // and must persist across scale-down so the gateway can still route messages
    const keys = [
      `server:${process.env.SERVER_NAME}:status`,
      `server:${process.env.SERVER_NAME}:url`,
    ];
    await redis.del(...keys);
  }
}
