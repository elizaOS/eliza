/** Runs the hosted agent-server manager boundary for cloud runtime containers. */

import {
  removeOwnedRedisKeys,
  requireRedisWriteReceipts,
} from "@elizaos/cloud-services-common/redis-ownership";
import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  ElizaError,
  type IAgentRuntime,
  mergeCharacterDefaults,
  type Plugin,
  stringToUuid,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import workflowPlugin from "@elizaos/plugin-workflow";
import {
  AgentMutationQueue,
  settleBeforeDeadline,
  startAndPublishRuntime,
} from "./agent-lifecycle";
import { AgentRoutingPublisher } from "./agent-routing";
import {
  initializeManagedBrowserHost,
  managedBrowserPlugins,
} from "./browser-host";
import { getAdvertisedServerUrl, getRequiredEnv } from "./config";
import {
  type DispatchResult,
  dispatchEvent,
  type JsonObject,
} from "./handlers/event";
import { logger } from "./logger";
import { getRedis } from "./redis";

interface AgentEntryBase {
  agentId: string;
  characterRef: string;
}

interface RunningAgentEntry extends AgentEntryBase {
  runtime: IAgentRuntime;
  state: "running" | "stopping";
}

interface StoppedAgentEntry extends AgentEntryBase {
  state: "stopped";
}

interface StartingAgentEntry extends AgentEntryBase {
  state: "starting";
}

type AgentEntry = RunningAgentEntry | StoppedAgentEntry | StartingAgentEntry;

/**
 * Platform metadata forwarded by the gateway webhook alongside a user message.
 * All fields are optional for backward compatibility with callers that don't
 * provide platform context (e.g. direct API calls, older gateway versions).
 */
export interface MessageMetadata {
  /** Originating platform (e.g. "discord", "telegram", "whatsapp", "twilio", "blooio"). */
  platformName?: string;
  /** Display name of the sender as reported by the platform adapter. */
  senderName?: string;
  /** Platform-specific chat/conversation ID for reply routing. */
  chatId?: string;
  /** Connector account or bot identity that received this message. */
  accountId?: string;
  /** Stable platform-native message/update id used for canonical memory dedupe. */
  platformRecordId?: string;
  /** Platform-native chat type when available. */
  chatType?: string;
}

// Must stay in sync with Platform type in gateway-webhook/src/adapters/types.ts
// and SUPPORTED_PLATFORMS in app/api/internal/webhook/config/route.ts
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set([
  "discord",
  "telegram",
  "whatsapp",
  "twilio",
  "blooio",
]);

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
const MAX_ACCOUNT_ID_LENGTH = 128;
const MAX_PLATFORM_RECORD_ID_LENGTH = 256;
const MAX_CHAT_TYPE_LENGTH = 32;

function truncateMetadata(value: string, max: number): string {
  const wellFormed = toWellFormedUnicode(value);
  return wellFormed.length > max
    ? truncateWellFormed(wellFormed, max)
    : wellFormed;
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncateMetadata(trimmed, max);
}

/** Returns the display name for the connection, falling back to the raw userId. Caps length to prevent oversized values from reaching the database. */
export function resolveUserName(
  userId: string,
  metadata?: MessageMetadata,
): string {
  const name = metadata?.senderName || userId;
  return truncateMetadata(name, MAX_USER_NAME_LENGTH);
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
  const chatId = bounded(metadata?.chatId, MAX_CHAT_ID_LENGTH);
  if (chatId) result.chatId = chatId;
  return result;
}

export function buildCanonicalMessageMetadata(args: {
  source: string;
  userId: string;
  entityId: string;
  metadata?: MessageMetadata;
}): Record<string, unknown> {
  const { source, userId, entityId, metadata } = args;
  const accountId = bounded(metadata?.accountId, MAX_ACCOUNT_ID_LENGTH);
  const platformRecordId = bounded(
    metadata?.platformRecordId,
    MAX_PLATFORM_RECORD_ID_LENGTH,
  );
  const chatType = bounded(metadata?.chatType, MAX_CHAT_TYPE_LENGTH);
  const senderName = bounded(metadata?.senderName, MAX_USER_NAME_LENGTH);

  return {
    type: "message",
    timestamp: Date.now(),
    scope: "private",
    provider: source,
    ...(accountId ? { accountId } : {}),
    ...(platformRecordId
      ? { platformMessageId: platformRecordId, sourceId: platformRecordId }
      : {}),
    ...(chatType ? { chatType } : {}),
    ...(senderName
      ? { sender: { id: userId, name: senderName }, entityName: senderName }
      : { sender: { id: userId } }),
    [source]: {
      id: userId,
      userId,
      entityId,
      ...(senderName ? { name: senderName } : {}),
      ...(accountId ? { accountId } : {}),
      ...(platformRecordId ? { messageId: platformRecordId } : {}),
    },
  };
}

const REDIS_STATE_TTL_SECONDS = Math.max(
  60,
  // parseInt stops at the first non-digit ("1e3junk" -> 1), so a typo
  // silently changed the Redis state TTL instead of falling back to the
  // 120 default. Require the whole trimmed value to be decimal; malformed
  // -> NaN falls through the || 120 chain as before, mirroring
  // resolveGenerationTimeoutMs in the discord plugin.
  (() => {
    const raw = (process.env.REDIS_STATE_TTL_SECONDS ?? "").trim();
    return /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  })() || 120,
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
  private readonly mutations = new AgentMutationQueue();
  private readonly routingPublisher = new AgentRoutingPublisher();
  private _draining = false;
  private inFlight = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly capacity: number) {}

  /** Returns the internal K8s service URL for this pod. */
  private getServerUrl(): string {
    return getAdvertisedServerUrl();
  }

  /** Publishes server status, URL, and agent→server mappings to Redis with TTLs. */
  private refreshRedisState(status?: string): Promise<void> {
    return this.routingPublisher.publish(() => this.publishRedisState(status));
  }

  private async publishRedisState(status?: string) {
    const redis = getRedis();
    const multi = redis.multi();
    const serverName = getRequiredEnv("SERVER_NAME");

    multi.set(
      `server:${serverName}:status`,
      status ?? (this._draining ? "draining" : "running"),
      "EX",
      REDIS_STATE_TTL_SECONDS,
    );
    multi.set(
      `server:${serverName}:url`,
      this.getServerUrl(),
      "EX",
      REDIS_STATE_TTL_SECONDS,
    );

    let expectedReceipts = 2;
    for (const [agentId, entry] of this.agents) {
      if (entry.state === "starting") continue;
      multi.set(
        `agent:${agentId}:server`,
        serverName,
        "EX",
        AGENT_ROUTING_TTL_SECONDS,
      );
      expectedReceipts++;
    }

    requireRedisWriteReceipts(
      await multi.exec(),
      expectedReceipts,
      "agent-server state",
    );
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

    if (
      typeof this.heartbeatTimer === "object" &&
      "unref" in this.heartbeatTimer
    ) {
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
      capacity: this.capacity,
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
    this.assertAcceptingAllocations();
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error("Agent not found");
    if (entry.state !== "running") throw new Error("Agent not running");
    return entry.runtime;
  }

  private assertAcceptingAllocations(): void {
    if (this._draining) {
      throw new ElizaError("Server is draining", {
        code: "AGENT_SERVER_DRAINING",
        severity: "ephemeral",
      });
    }
  }

  /**
   * Starts a new agent runtime on this pod.
   * Reserves capacity immediately, then initializes the runtime asynchronously.
   * @throws {Error} "At capacity" if no slots are available
   * @throws {Error} "Agent already exists" if the agent is already loaded
   */
  async startAgent(agentId: string, characterRef: string) {
    this.assertAcceptingAllocations();
    if (this.agents.has(agentId)) throw new Error("Agent already exists");
    return this.mutations.run(agentId, () =>
      this.startAgentOwned(agentId, characterRef),
    );
  }

  private async startAgentOwned(agentId: string, characterRef: string) {
    this.assertAcceptingAllocations();
    if (this.agents.size >= this.capacity) {
      throw new Error("At capacity");
    }
    if (this.agents.has(agentId)) {
      throw new Error("Agent already exists");
    }

    // Reserve the slot immediately to prevent concurrent requests from exceeding capacity
    this.agents.set(agentId, {
      agentId,
      characterRef,
      state: "starting",
    });

    let ownedRuntime: IAgentRuntime | undefined;
    let publicationAttempted = false;
    this.inFlight++;
    try {
      const character = mergeCharacterDefaults({
        id: stringToUuid(agentId),
        name: characterRef.toLowerCase(),
        secrets: {
          POSTGRES_URL: process.env.POSTGRES_URL || "",
          ...(process.env.ENCRYPTION_SALT
            ? { ENCRYPTION_SALT: process.env.ENCRYPTION_SALT }
            : {}),
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
          ELIZAOS_CLOUD_API_KEY: process.env.ELIZAOS_CLOUD_API_KEY || "",
        },
      });

      // Priority: elizacloud (proxy) > openai
      const plugins: Plugin[] = [
        sqlPlugin as Plugin,
        workflowPlugin as Plugin,
        ...managedBrowserPlugins(Boolean(process.env.ENCRYPTION_SALT)),
      ];
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
          throw new Error(
            "@elizaos/plugin-openai: expected openaiPlugin or default export",
          );
        }
        plugins.push(openaiPlugin);
      }

      this.assertAcceptingAllocations();
      const runtime = new AgentRuntime({ character, plugins });
      ownedRuntime = runtime;
      const skipMigrations = process.env.SKIP_MIGRATIONS === "true";
      await startAndPublishRuntime(
        runtime,
        async () => {
          await runtime.initialize({ skipMigrations });
          if (!this._draining) await initializeManagedBrowserHost(runtime);
          this.assertAcceptingAllocations();
        },
        async () => {
          await this.routingPublisher.publish(async () => {
            this.assertAcceptingAllocations();
            publicationAttempted = true;
            this.agents.set(agentId, {
              agentId,
              characterRef,
              runtime,
              state: "running",
            });
            await this.publishRedisState();
            // Drain can start while publication is awaiting its receipt.
            this.assertAcceptingAllocations();
          });
        },
        () => {
          this.agents.set(agentId, {
            agentId,
            characterRef,
            runtime,
            state: "stopping",
          });
        },
      );
    } catch (err) {
      ownedRuntime?.reportError("AgentManager.startAgent", err, { agentId });
      if (this.agents.get(agentId)?.state !== "stopping") {
        if (publicationAttempted) {
          // Runtime cleanup succeeded. Keep a retryable stopped entry until
          // any partially published routing has also been acknowledged removed.
          this.agents.set(agentId, { agentId, characterRef, state: "stopped" });
          try {
            await this.routingPublisher.retire(
              () =>
                removeOwnedRedisKeys(
                  getRedis(),
                  getRequiredEnv("SERVER_NAME"),
                  [`agent:${agentId}:server`],
                ),
              () => {
                this.agents.delete(agentId);
              },
            );
          } catch (cleanupFailure) {
            throw new AggregateError(
              [err, cleanupFailure],
              "Agent startup and routing cleanup failed",
            );
          }
        } else {
          this.agents.delete(agentId);
        }
      }
      throw err;
    } finally {
      this.inFlight--;
    }
  }

  /** Stops a running agent's runtime, transitioning it to "stopped" state. */
  async stopAgent(id: string) {
    this.rejectStartingMutation(id);
    return this.mutations.run(id, () => this.stopAgentOwned(id));
  }

  private rejectStartingMutation(id: string): void {
    if (this.agents.get(id)?.state === "starting") {
      throw new ElizaError("Agent is initializing", {
        code: "AGENT_INITIALIZING",
        severity: "ephemeral",
      });
    }
  }

  private async stopAgentOwned(id: string) {
    const entry = this.agents.get(id);
    if (!entry) throw new Error("Agent not found");
    if (entry.state === "starting") {
      throw new ElizaError("Agent is initializing", {
        code: "AGENT_INITIALIZING",
        severity: "ephemeral",
      });
    }
    if (entry.state === "stopped") return;
    entry.state = "stopping";
    await entry.runtime.stop();
    this.agents.set(id, {
      agentId: entry.agentId,
      characterRef: entry.characterRef,
      state: "stopped",
    });
    await this.refreshRedisState();
  }

  /** Stops and removes an agent, cleaning up its Redis routing key. */
  async deleteAgent(id: string) {
    this.rejectStartingMutation(id);
    return this.mutations.run(id, () => this.deleteAgentOwned(id));
  }

  private async deleteAgentOwned(id: string) {
    const entry = this.agents.get(id);
    if (!entry) throw new Error("Agent not found");
    if (entry.state === "starting") {
      throw new ElizaError("Agent is initializing", {
        code: "AGENT_INITIALIZING",
        severity: "ephemeral",
      });
    }
    if (entry.state === "running" || entry.state === "stopping") {
      entry.state = "stopping";
      await entry.runtime.stop();
      this.agents.set(id, {
        agentId: entry.agentId,
        characterRef: entry.characterRef,
        state: "stopped",
      });
    }
    await this.routingPublisher.retire(
      () =>
        removeOwnedRedisKeys(getRedis(), getRequiredEnv("SERVER_NAME"), [
          `agent:${id}:server`,
        ]),
      () => {
        this.agents.delete(id);
      },
    );
    await this.refreshRedisState();
  }

  /** Runs work against a loaded runtime while participating in drain tracking. */
  async useRuntime<T>(
    agentId: string,
    fn: (runtime: IAgentRuntime) => Promise<T>,
  ): Promise<T> {
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
  async handleMessage(
    agentId: string,
    userId: string,
    text: string,
    metadata?: MessageMetadata,
  ) {
    this.inFlight++;
    try {
      const rt = this.getRuntime(agentId);
      const uid = stringToUuid(userId);
      const source = resolveSource(metadata);
      const connectorChatId = bounded(metadata?.chatId, MAX_CHAT_ID_LENGTH);
      const connectorAccountId = bounded(
        metadata?.accountId,
        MAX_ACCOUNT_ID_LENGTH,
      );
      const sourceRoomKey =
        source !== "agent-server" && connectorChatId
          ? `${agentId}:${source}:${connectorAccountId ?? "default"}:${connectorChatId}`
          : `${agentId}:${userId}`;
      const roomId = stringToUuid(sourceRoomKey);
      // World ids are a global key and world reads are agent-scoped, so a
      // server-wide id shared by every agent in this pod would collide.
      const worldId = stringToUuid(
        `server:${process.env.SERVER_NAME}:${agentId}`,
      );
      const userName = resolveUserName(userId, metadata);
      const connMeta = buildConnectionMetadata(metadata);
      const chatType = metadata?.chatType?.toLowerCase();
      const channelType =
        chatType && chatType !== "private" && chatType !== "dm"
          ? ChannelType.GROUP
          : ChannelType.DM;

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
        channelId:
          source !== "agent-server" && connectorChatId
            ? connectorChatId
            : `${agentId}-${userId}`,
        type: channelType,
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
          channelType,
        },
      });
      mem.metadata = buildCanonicalMessageMetadata({
        source,
        userId,
        entityId: uid,
        metadata,
      }) as typeof mem.metadata;

      // A running runtime always wires a DefaultMessageService (runtime ctor).
      // A null messageService here means the message pipeline never initialized
      // for this agent — a structural runtime failure, not an empty reply.
      // Optional-chaining past it (the previous `rt.messageService?.`) skipped
      // the pipeline silently and returned a fabricated reply string, which the
      // gateway-webhook consumer accepts as a legitimate 200 reply (see
      // parseAgentResponse), hiding a broken agent end-to-end. Fail closed so
      // the route returns 500. // error-policy:J1 boundary — surface structural
      // pipeline-init failure instead of fabricating a reply.
      const messageService = rt.messageService;
      if (!messageService) {
        throw new Error(
          `Agent ${agentId} has no message service; runtime message pipeline is not initialized`,
        );
      }

      let response = "";
      const mediaUrls: string[] = [];
      await messageService.handleMessage(rt, mem, async (content) => {
        if (content?.text) response += content.text;
        for (const attachment of content?.attachments ?? []) {
          if (attachment.url) mediaUrls.push(attachment.url);
        }
        return [];
      });

      // An empty accumulated response is a real outcome, not a fault: the agent
      // deliberately did not respond (mute / shouldRespond=no) or emitted no
      // text. Return the empty string; the gateway-webhook consumer treats an
      // empty reply as deliberate silence and skips sendReply (see
      // processMessage), so nothing is delivered. The previous fabricated
      // "No response generated." string was fail-open slop — it read like an
      // agent reply and was actually SENT to platform adapters, and (via the
      // removed `?.`) it also masked a structural pipeline failure. Genuine
      // structural failures now throw above.
      return { response, mediaUrls };
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Initiates graceful drain: marks the server as draining, waits up to 50s
   * for in-flight allocations, messages, and events to complete, then stops all runtimes.
   */
  async drain() {
    this._draining = true;
    this.stopHeartbeat();
    const deadline = performance.now() + 50_000;
    const failures: unknown[] = [];
    let timedOut = false;
    try {
      timedOut = !(await settleBeforeDeadline(
        this.refreshRedisState("draining"),
        deadline,
      ));
    } catch (error) {
      failures.push(error);
    }

    while (this.inFlight > 0 && performance.now() < deadline) {
      await new Promise((r) =>
        setTimeout(r, Math.min(200, Math.max(0, deadline - performance.now()))),
      );
    }
    if (this.inFlight > 0) timedOut = true;

    const stops: Promise<void>[] = [];
    for (const [agentId, entry] of this.agents) {
      if (entry.state === "running" || entry.state === "stopping") {
        stops.push(
          this.mutations.run(agentId, async () => {
            // A preceding successful deletion already fulfilled this cleanup.
            if (!this.agents.has(agentId)) return;
            await this.stopAgentOwned(agentId);
          }),
        );
      }
    }
    const settled = Promise.allSettled(stops);
    if (await settleBeforeDeadline(settled, deadline)) {
      for (const result of await settled) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    } else {
      timedOut = true;
    }
    if (timedOut)
      failures.push(
        new ElizaError("Agent-server drain deadline expired", {
          code: "AGENT_SERVER_DRAIN_TIMEOUT",
          severity: "ephemeral",
        }),
      );
    if (failures.length)
      throw new AggregateError(failures, "Agent-server drain failed");
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
    await this.routingPublisher.close(async () => {
      await redis.del(...keys);
    });
  }
}
