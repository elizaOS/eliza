/** Coordinates multi-tenant Discord gateway connections and event routing. */
import {
  GATEWAY_TOKEN_REQUEST_TIMEOUT_MS,
  gatewayTokenRefreshDelayMs,
  gatewayTokenRetryDelayMs,
  parseGatewayTokenResponse,
} from "@elizaos/cloud-services-common/gateway-auth";
import { Redis } from "@upstash/redis";
import {
  type Attachment,
  Client,
  type ClientOptions,
  type Embed,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialGuildMember,
  type PartialMessage,
  type PartialMessageReaction,
  Partials,
  type PartialUser,
  type Role,
  type User,
} from "discord.js";
import { reconcileDiscordConnectionReady } from "./connection-lifecycle";
import {
  type DiscordInstallWelcomeJob,
  DiscordInstallWelcomeQueue,
} from "./discord-install-welcome-queue";
import { chunkDiscordText, discordChunkNonce } from "./discord-text-chunks";
import {
  type DiscordConnectionDmPolicyState,
  isDmSenderAllowed,
  parseDiscordConnectionDmPolicyState,
} from "./dm-policy";
import { pollTrackedDiscordDms, type TrackedDiscordDm } from "./dm-polling";
import { tryConfirmDiscordIdentityLink } from "./identity-link";
import { logger } from "./logger";
import {
  createManagedGuildVoiceCloudBridge,
  MANAGED_GUILD_VOICE_INTENT,
  ManagedGuildVoiceController,
} from "./managed-guild-voice";
import {
  deliverManagedReply,
  postManagedAgentMessageWithRetry,
  withManagedTypingHeartbeat,
} from "./managed-message-egress";
import {
  drainAndDeliverGreetings as drainAndDeliverPendingGreetings,
  isKnownDiscordDirectMessageRejection,
  isTerminalDiscordDirectMessageError,
} from "./proactive-greeting-delivery";
import { createMockRedis, createNativeRedis } from "./redis-adapter";
import {
  buildManagedFailureReplyOptions,
  buildManagedReplyOptions,
  classifyManagedReplyReceipt,
} from "./reply-components";
import {
  forwardToServer,
  refreshKedaActivity,
  resolveAgentServer,
} from "./server-router";
import {
  hasVoiceAttachments,
  VoiceMessageHandler,
} from "./voice-message-handler";

interface GatewayRedis {
  get<T = string>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    options?: { ex?: number; px?: number; nx?: boolean },
  ): Promise<unknown>;
  setex(key: string, ttlSeconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lmove(
    source: string,
    destination: string,
    whereFrom: "left" | "right",
    whereTo: "left" | "right",
  ): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
}

// ============================================
// Helpers
// ============================================

/**
 * Discord bot token pattern for sanitization.
 * Tokens have format: base64(bot_id).base64(timestamp).base64(hmac)
 * Using permissive pattern to catch edge cases and variations:
 * - Part 1 (bot ID): 15+ characters (varies by ID length)
 * - Part 2 (timestamp): 5+ characters
 * - Part 3 (HMAC): 20+ characters
 */
const DISCORD_TOKEN_PATTERN =
  /[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g;

/**
 * Sanitize error messages to prevent accidental token exposure in logs.
 * Discord bot tokens have a specific format that we can detect and redact.
 */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(DISCORD_TOKEN_PATTERN, "[REDACTED_TOKEN]");
}

/**
 * Parse an integer from environment variable with validation.
 * Throws if the value is not a valid integer or below minimum to fail fast on misconfiguration.
 */
function parseIntEnv(
  name: string,
  defaultValue: number,
  minValue: number = 1,
): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid ${name} environment variable: "${value}" is not a valid integer`,
    );
  }
  if (parsed < minValue) {
    throw new Error(
      `Invalid ${name} environment variable: ${parsed} is below minimum value of ${minValue}`,
    );
  }
  return parsed;
}

// ============================================
// Constants
// ============================================

/** Discord intents: GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES */
const DEFAULT_DISCORD_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessages,
];

/** Interval between polling for bot assignments (30 seconds) */
const BOT_POLL_INTERVAL_MS = 30_000;

/** Interval between heartbeats to Redis (15 seconds) */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** HTTP request timeout for general operations (10 seconds) */
const HTTP_TIMEOUT_MS = 10_000;

/** HTTP request timeout for event forwarding (60 seconds) - AI processing can take longer */
const EVENT_FORWARD_TIMEOUT_MS = 60_000;

/** Redis pod state TTL (5 minutes) */
const POD_STATE_TTL_SECONDS = 300;

/** Redis session state TTL (1 hour) */
const SESSION_STATE_TTL_SECONDS = 3600;

/** Maximum Discord message content length */
const _MAX_DISCORD_MESSAGE_LENGTH = 2000;

/**
 * Stale connection cleanup threshold (10 minutes).
 * Connections in "disconnected" or "error" state for longer than this
 * are removed to prevent memory leaks when control plane is unreachable.
 */
const STALE_CONNECTION_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * TTL for failover lock in seconds.
 * Lock prevents multiple pods from simultaneously claiming the same dead pod.
 * Set to 30s - should be enough for the failover operation, with safety margin.
 */
const FAILOVER_LOCK_TTL_SECONDS = 30;

/**
 * Failover timing configuration.
 *
 * Maximum failover latency = DEAD_POD_THRESHOLD_MS + FAILOVER_CHECK_INTERVAL_MS
 *
 * With defaults (45s threshold + 30s check):
 * - Best case: Pod dies right before check → ~45s failover
 * - Worst case: Pod dies right after check → ~75s failover
 *
 * Tradeoffs:
 * - Lower values = faster failover but more false positives during network blips
 * - Higher values = fewer false positives but longer message gaps
 *
 * The threshold should be at least 2x heartbeat interval to avoid false positives.
 */
const FAILOVER_CHECK_INTERVAL_MS = parseIntEnv(
  "FAILOVER_CHECK_INTERVAL_MS",
  30_000,
);
const DEAD_POD_THRESHOLD_MS = parseIntEnv("DEAD_POD_THRESHOLD_MS", 45_000);

/** Maximum bots per pod - prevents resource exhaustion */
const MAX_BOTS_PER_POD = parseIntEnv("MAX_BOTS_PER_POD", 100);

// ============================================
// Eliza App Bot Leader Election Constants
// ============================================

/**
 * Redis key for Eliza App bot leader election.
 * Configurable via ELIZA_APP_LEADER_KEY env var to prevent collisions
 * when sharing Redis across multiple environments (prod/staging/local).
 */
const ELIZA_APP_LEADER_KEY =
  process.env.ELIZA_APP_LEADER_KEY || "discord:eliza-app-bot:leader";

/** Leader election lock TTL in seconds (10 seconds) */
const ELIZA_APP_LEADER_TTL_SECONDS = 10;

/**
 * Interval between drains of pending proactive onboarding greetings
 * (15 seconds). Only the Eliza App bot leader polls, and the API claims
 * entries atomically. A stable enforced Discord nonce makes lease retries
 * idempotent if the gateway loses the acknowledgement response.
 */
const GREETING_POLL_INTERVAL_MS = parseIntEnv(
  "GREETING_POLL_INTERVAL_MS",
  15_000,
);

/** User-installed apps expose bot DMs but may omit freeform message events. */
const ELIZA_APP_DM_POLL_INTERVAL_MS = parseIntEnv(
  "ELIZA_APP_DM_POLL_INTERVAL_MS",
  2_000,
  500,
);
const ELIZA_APP_DM_CHANNELS_KEY = "discord:eliza-app-bot:dm-channels";
const ELIZA_APP_DM_STATE_PREFIX = "discord:eliza-app-bot:dm-state:";
const ELIZA_APP_DM_CLAIM_PREFIX = "discord:eliza-app-bot:dm-message:";
const ELIZA_APP_DM_STATE_TTL_SECONDS = 180 * 24 * 60 * 60;
const ELIZA_APP_DM_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How often to check/renew leadership (3 seconds) */
const ELIZA_APP_LEADER_CHECK_INTERVAL_MS = 3000;

// ============================================
// Types
// ============================================

/**
 * Escape a string for use in Prometheus label values.
 * Escapes backslashes, newlines, and double quotes per Prometheus exposition format.
 */
const escapePrometheusLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const metric = (
  name: string,
  type: string,
  help: string,
  pod: string,
  value: number,
): string => {
  const escapedPod = escapePrometheusLabel(pod);
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}{pod="${escapedPod}"} ${value}`;
};

interface GatewayConfig {
  podName: string;
  elizaCloudUrl: string;
  gatewayBootstrapSecret: string;
  redisUrl?: string;
  redisToken?: string;
  project: string;
}

interface BotConnection {
  connectionId: string;
  organizationId: string;
  applicationId: string;
  characterId: string | null;
  /** Discord.js client instance. Undefined while a connection reservation is being established. */
  client?: Client;
  status: "connecting" | "connected" | "disconnected" | "error";
  guildCount: number;
  eventsReceived: number;
  eventsRouted: number;
  eventsFailed: number;
  consecutiveFailures: number;
  lastHeartbeat: Date;
  connectedAt?: Date;
  /** Timestamp when status changed to disconnected/error (for stale cleanup) */
  statusChangedAt?: Date;
  error?: string;
  /** Store listener references for cleanup */
  listeners: Map<string, unknown>;
  /** Validated DM state, refreshed from every assignment poll without reconnecting. */
  dmPolicyState: DiscordConnectionDmPolicyState;
}

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  podName: string;
  totalBots: number;
  connectedBots: number;
  disconnectedBots: number;
  totalGuilds: number;
  uptime: number;
  draining: boolean;
  systemBot: {
    enabled: boolean;
    configured: boolean;
    leader: boolean;
    connected: boolean;
  };
  controlPlane: {
    consecutiveFailures: number;
    lastSuccessfulPoll: string | null;
    healthy: boolean;
  };
}

// ============================================
// Helper Functions
// ============================================

/**
 * Fetch with timeout support.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = HTTP_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

interface GatewayManagerRoutingAdapters {
  resolveAgentServer: typeof resolveAgentServer;
  refreshKedaActivity: typeof refreshKedaActivity;
  forwardToServer: typeof forwardToServer;
  fetchAssignments: typeof fetchWithTimeout;
  forwardInWorkerEvent: typeof fetchWithTimeout;
}

const DEFAULT_ROUTING_ADAPTERS: GatewayManagerRoutingAdapters = {
  resolveAgentServer,
  refreshKedaActivity,
  forwardToServer,
  fetchAssignments: fetchWithTimeout,
  forwardInWorkerEvent: fetchWithTimeout,
};

// ============================================
// Gateway Manager
// ============================================

export class GatewayManager {
  private config: GatewayConfig;
  private redis: GatewayRedis | null = null;
  private connections: Map<string, BotConnection> = new Map();
  private startTime: Date = new Date();
  private pollInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private failoverInterval: NodeJS.Timeout | null = null;
  private tokenRefreshTimeout: NodeJS.Timeout | null = null;
  private tokenRefreshRetryAttempt = 0;
  /** Invalidates auth work that outlives shutdown. */
  private authLifecycleGeneration = 0;
  private voiceHandler: VoiceMessageHandler;
  private readonly routingAdapters: GatewayManagerRoutingAdapters;
  private consecutivePollFailures: number = 0;
  private lastSuccessfulPoll: Date | null = null;
  /** Pod is draining - no new assignments, waiting for failover */
  private draining: boolean = false;
  private drainingStartedAt: Date | null = null;
  /** JWT access token for API authentication */
  private accessToken: string | null = null;
  /** Token expiration timestamp */
  private tokenExpiresAt: Date | null = null;

  // ============================================
  // Eliza App Bot (Leader Election)
  // ============================================
  /** Eliza App bot client (only connected if this pod is leader) */
  private elizaAppClient: Client | null = null;
  /** Whether this pod is the Eliza App bot leader */
  private isElizaAppLeader: boolean = false;
  /** Interval for draining pending proactive onboarding greetings (leader only) */
  private greetingPollInterval: NodeJS.Timeout | null = null;
  /**
   * The currently running greeting drain, if any. Polling never overlaps it;
   * graceful teardown lets it finish promptly, while the durable lease and
   * provider nonce also recover correctly from abrupt process termination.
   */
  private greetingDrainInFlight: Promise<void> | null = null;
  /** Poll fallback for user-installed bot DMs that omit Gateway message events. */
  private dmPollInterval: NodeJS.Timeout | null = null;
  private dmPollInFlight: Promise<void> | null = null;
  /** Durable user-install welcome delivery, active on the system-bot leader. */
  private installWelcomeQueue: DiscordInstallWelcomeQueue | null = null;
  /** Live guild audio, owned by the same leader as the system-bot token. */
  private managedGuildVoice: ManagedGuildVoiceController | null = null;
  /** Interval for leader election checks */
  private elizaAppLeaderInterval: NodeJS.Timeout | null = null;

  constructor(
    config: GatewayConfig,
    routingAdapters: Partial<GatewayManagerRoutingAdapters> = {},
  ) {
    this.config = config;
    this.voiceHandler = new VoiceMessageHandler();
    this.routingAdapters = {
      ...DEFAULT_ROUTING_ADAPTERS,
      ...routingAdapters,
    };

    // Initialize Redis for failover coordination.
    // MOCK_REDIS=1 is an explicit opt-in for tests/CI; never silently used
    // when unset, so real credentials are still honored when present.
    const isTcpRedisUrl = (u: string): boolean => /^rediss?:\/\//i.test(u);
    if (process.env.MOCK_REDIS === "1") {
      this.redis = createMockRedis();
      logger.info("[GatewayManager] using in-memory mock Redis (MOCK_REDIS=1)");
    } else if (config.redisUrl && isTcpRedisUrl(config.redisUrl)) {
      // Railway (and any TCP Redis): RESP over ioredis, wrapped in the
      // Upstash-compatible adapter so call sites stay unchanged.
      this.redis = createNativeRedis(config.redisUrl);
      logger.info("[GatewayManager] using native TCP Redis client");
    } else if (config.redisUrl && config.redisToken) {
      // Upstash REST (HTTPS URL + token) remains the compatibility fallback.
      this.redis = new Redis({
        url: config.redisUrl,
        token: config.redisToken,
      });
      logger.info("[GatewayManager] using Upstash REST Redis client");
    } else if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      // Fall back to environment variables if explicit config not provided
      this.redis = Redis.fromEnv();
    } else if (config.redisUrl) {
      // URL provided but no token - log warning and skip Redis
      logger.warn(
        "Redis URL provided without token - failover disabled. Set REDIS_URL (TCP) or KV_REST_API_TOKEN/redisToken (Upstash).",
      );
    }

    const elizaAppEnabled =
      process.env.ELIZA_APP_DISCORD_BOT_ENABLED === "true";
    const elizaAppBotToken = process.env.ELIZA_APP_DISCORD_BOT_TOKEN?.trim();
    if (elizaAppEnabled && elizaAppBotToken && this.redis) {
      this.installWelcomeQueue = new DiscordInstallWelcomeQueue(
        this.redis,
        elizaAppBotToken,
      );
    }
  }

  async enqueueDiscordInstallWelcome(
    job: DiscordInstallWelcomeJob,
  ): Promise<void> {
    if (!this.installWelcomeQueue) {
      throw new Error("Discord install welcome queue is unavailable");
    }
    await this.installWelcomeQueue.enqueue(job);
  }

  /** Sends through the one leader-owned system bot and records the DM cursor. */
  async deliverElizaAppDirectMessage(input: {
    discordUserId: string;
    text: string;
    nonce: string;
  }): Promise<
    { accepted: false } | { accepted: true; providerMessageId: string }
  > {
    const client = this.elizaAppClient;
    if (!this.isElizaAppLeader || !client?.isReady()) {
      return { accepted: false };
    }
    let sent: Awaited<ReturnType<typeof client.users.send>>;
    try {
      sent = await client.users.send(input.discordUserId, {
        content: input.text,
        nonce: input.nonce,
        enforceNonce: true,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      // error-policy:J1 Discord API rejections prove no message was accepted;
      // network and response ambiguity still propagate to the receipt tombstone.
      if (isKnownDiscordDirectMessageRejection(error))
        return { accepted: false };
      throw error;
    }
    try {
      await this.trackElizaAppDm(sent.channelId, input.discordUserId, sent.id);
    } catch (error) {
      // error-policy:J4 polling cursor loss degrades reply ingestion only; the
      // provider receipt remains authoritative for this outbound delivery.
      logger.warn("Failed to persist Eliza App DM polling cursor", {
        discordUserId: input.discordUserId,
        providerMessageId: sent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { accepted: true, providerMessageId: sent.id };
  }

  async readElizaAppDeliveryReceipt(key: string): Promise<string | null> {
    if (!this.redis)
      throw new Error("Discord delivery receipt store unavailable");
    return await this.redis.get<string>(key);
  }

  async claimOrWriteElizaAppDeliveryReceipt(
    key: string,
    value: string,
    options: { ex: number; nx?: boolean },
  ): Promise<unknown> {
    if (!this.redis)
      throw new Error("Discord delivery receipt store unavailable");
    return await this.redis.set(key, value, options);
  }

  async deleteElizaAppDeliveryReceipt(key: string): Promise<unknown> {
    if (!this.redis)
      throw new Error("Discord delivery receipt store unavailable");
    return await this.redis.del(key);
  }

  /**
   * Acquire a JWT token from the token endpoint using the bootstrap secret.
   * This must be called before any API operations.
   */
  private async acquireToken(): Promise<void> {
    const lifecycleGeneration = this.authLifecycleGeneration;
    const acquisitionStartedAt = Date.now();
    logger.info("Acquiring JWT token", { podName: this.config.podName });

    const response = await fetchWithTimeout(
      `${this.config.elizaCloudUrl}/api/internal/auth/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Secret": this.config.gatewayBootstrapSecret,
        },
        body: JSON.stringify({
          pod_name: this.config.podName,
          service: "discord-gateway",
        }),
        timeout: GATEWAY_TOKEN_REQUEST_TIMEOUT_MS,
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to acquire token: ${response.status} - ${error}`);
    }

    const data = parseGatewayTokenResponse(await response.json());
    if (lifecycleGeneration !== this.authLifecycleGeneration) {
      throw new Error("Auth lifecycle changed during token acquisition");
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = new Date(
      acquisitionStartedAt + data.expires_in * 1_000,
    );

    logger.info("JWT token acquired", {
      podName: this.config.podName,
      expiresAt: this.tokenExpiresAt.toISOString(),
    });

    this.scheduleTokenRefresh(data.expires_in);
  }

  /**
   * Refresh the JWT token before it expires.
   */
  private async refreshToken(): Promise<void> {
    await this.acquireToken();
  }

  /**
   * Schedule token refresh halfway through the token lifetime.
   */
  private scheduleTokenRefresh(expiresInSeconds: number): void {
    if (this.tokenRefreshTimeout) {
      clearTimeout(this.tokenRefreshTimeout);
    }

    const refreshInMs = gatewayTokenRefreshDelayMs(expiresInSeconds);
    this.tokenRefreshRetryAttempt = 0;
    const timeout = setTimeout(() => {
      // error-policy:J1 The timer boundary converts renewal failure into a paced retry.
      this.refreshToken().catch((error) => {
        logger.error("Token refresh failed", { error: sanitizeError(error) });
        if (this.tokenRefreshTimeout === timeout) {
          this.scheduleTokenRefreshRetry();
        }
      });
    }, refreshInMs);
    this.tokenRefreshTimeout = timeout;

    logger.debug("Token refresh scheduled", {
      refreshInMs,
      refreshInMinutes: Math.round(refreshInMs / 60000),
    });
  }

  private scheduleTokenRefreshRetry(): void {
    if (this.tokenRefreshTimeout) {
      clearTimeout(this.tokenRefreshTimeout);
    }

    const retryInMs = gatewayTokenRetryDelayMs(this.tokenRefreshRetryAttempt);
    this.tokenRefreshRetryAttempt = Math.min(
      this.tokenRefreshRetryAttempt + 1,
      4,
    );
    const lifecycleGeneration = this.authLifecycleGeneration;
    const timeout = setTimeout(() => {
      if (lifecycleGeneration !== this.authLifecycleGeneration) {
        return;
      }
      // error-policy:J1 The timer boundary retains the paced retry until recovery.
      this.refreshToken().catch((error) => {
        logger.error("Token refresh retry failed", {
          error: sanitizeError(error),
        });
        if (this.tokenRefreshTimeout === timeout) {
          this.scheduleTokenRefreshRetry();
        }
      });
    }, retryInMs);
    this.tokenRefreshTimeout = timeout;

    logger.debug("Token refresh retry scheduled", {
      retryInMs,
      retryAttempt: this.tokenRefreshRetryAttempt,
    });
  }

  /**
   * Get the Authorization header for API requests.
   * Throws if no token is available.
   */
  private getAuthHeader(): { Authorization: string } {
    if (
      !this.accessToken ||
      !this.tokenExpiresAt ||
      Date.now() >= this.tokenExpiresAt.getTime()
    ) {
      throw new Error("No access token available - call acquireToken first");
    }
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async start(): Promise<void> {
    logger.info("Starting gateway manager", { podName: this.config.podName });

    // Acquire JWT token before any API calls - fail fast if this fails
    await this.acquireToken();

    // Start polling for assigned bots (with retry on startup failure)
    try {
      await this.pollForBots();
    } catch (error) {
      logger.error("Initial pollForBots failed, will retry on interval", {
        error: sanitizeError(error),
      });
    }
    this.pollInterval = setInterval(() => {
      this.pollForBots().catch((error) => {
        logger.error("Error in pollForBots interval", {
          error: sanitizeError(error),
        });
      });
    }, BOT_POLL_INTERVAL_MS);

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat().catch((error) => {
        logger.error("Error in sendHeartbeat interval", {
          error: sanitizeError(error),
        });
      });
    }, HEARTBEAT_INTERVAL_MS);

    // Start failover check (claim orphaned connections from dead pods)
    if (this.redis) {
      this.failoverInterval = setInterval(() => {
        this.checkForDeadPods().catch((error) => {
          logger.error("Error in checkForDeadPods interval", {
            error: sanitizeError(error),
          });
        });
      }, FAILOVER_CHECK_INTERVAL_MS);
      logger.info("Failover monitoring enabled", {
        intervalMs: FAILOVER_CHECK_INTERVAL_MS,
      });
    }

    // Starts the voice message retention job
    const voiceMessageEnabled = process.env.VOICE_MESSAGE_ENABLED !== "false";
    if (voiceMessageEnabled) {
      this.voiceHandler.startCleanupJob();
      logger.info("Voice message handling enabled");
    }

    // Start Eliza App bot leader election (if configured)
    await this.startElizaAppBotLeaderElection();

    logger.info("Gateway manager started");
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down gateway manager");

    this.authLifecycleGeneration += 1;

    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.failoverInterval) clearInterval(this.failoverInterval);
    if (this.tokenRefreshTimeout) {
      clearTimeout(this.tokenRefreshTimeout);
      this.tokenRefreshTimeout = null;
    }
    if (this.elizaAppLeaderInterval) clearInterval(this.elizaAppLeaderInterval);
    if (this.greetingPollInterval) clearInterval(this.greetingPollInterval);
    if (this.dmPollInterval) clearInterval(this.dmPollInterval);
    this.voiceHandler.stopCleanupJob();

    // Let an in-flight delivery acknowledge before disconnecting. This is an
    // optimization, not the durability mechanism: abrupt termination leaves
    // the lease recoverable and the provider nonce makes a retry idempotent.
    if (this.greetingDrainInFlight) {
      await this.greetingDrainInFlight;
      this.greetingDrainInFlight = null;
    }
    if (this.dmPollInFlight) {
      await this.dmPollInFlight;
      this.dmPollInFlight = null;
    }

    // Release Eliza App bot leadership for faster failover
    if (this.isElizaAppLeader && this.redis) {
      logger.info("Releasing Eliza App bot leadership");
      // error-policy:J6 best-effort teardown; the leader key carries a TTL so a failed release still expires.
      await this.redis.del(ELIZA_APP_LEADER_KEY).catch(() => {});
      if (this.elizaAppClient) {
        this.elizaAppClient.destroy();
        this.elizaAppClient = null;
      }
      this.isElizaAppLeader = false;
    }

    // Revoke ownership before any awaited teardown. An in-flight login or
    // Discord event must observe that shutdown owns the connection now and
    // may not publish a late status or route an event.
    const connectionsToClose = [...this.connections.entries()];
    this.connections.clear();

    // Save session state and disconnect all bots
    for (const [connectionId, conn] of connectionsToClose) {
      await this.saveSessionState(connectionId, conn);
      this.removeAllListeners(conn);
      // Reservations have no client until connectBot finishes.
      if (conn.client) {
        conn.client.destroy();
      }
      logger.info("Disconnected bot", { connectionId });
    }

    // Release all connections in database so other pods can pick them up immediately
    // This is critical for graceful shutdowns (deployments, scaling) to avoid message loss
    try {
      await fetchWithTimeout(
        `${this.config.elizaCloudUrl}/api/internal/discord/gateway/shutdown`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.getAuthHeader(),
          },
          body: JSON.stringify({ pod_name: this.config.podName }),
        },
      );
      logger.info("Released connections in database", {
        podName: this.config.podName,
      });
    } catch (error) {
      // Log but don't fail shutdown - failover will handle orphaned connections
      logger.error("Failed to release connections in database", {
        error: sanitizeError(error),
      });
    }

    // Clear pod heartbeat from Redis
    if (this.redis) {
      try {
        await this.redis.del(`discord:pod:${this.config.podName}`);
        await this.redis.srem("discord:active_pods", this.config.podName);
      } catch (error) {
        // Log but don't fail shutdown - stale Redis state will expire via TTL
        logger.error("Failed to clear Redis state during shutdown", {
          error: sanitizeError(error),
        });
      }
    }

    logger.info("Gateway manager shutdown complete");
  }

  /**
   * Start draining this pod.
   *
   * When draining:
   * 1. Readiness probe returns unhealthy (stops new bot assignments)
   * 2. Existing bots continue running (liveness probe still healthy)
   * 3. Database is notified to reassign bots to other pods
   * 4. After failover detection window (45-75s), bots will be picked up elsewhere
   *
   * Called by preStop lifecycle hook before SIGTERM.
   */
  async startDraining(): Promise<void> {
    if (this.draining) {
      logger.info("Already draining", { podName: this.config.podName });
      return;
    }

    this.draining = true;
    this.drainingStartedAt = new Date();
    logger.info("Pod entering draining state", {
      podName: this.config.podName,
      botCount: this.connections.size,
    });

    // Notify backend that this pod is draining so it can reassign bots
    // This is proactive - doesn't wait for heartbeat timeout
    try {
      await fetchWithTimeout(
        `${this.config.elizaCloudUrl}/api/internal/discord/gateway/drain`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.getAuthHeader(),
          },
          body: JSON.stringify({
            pod_name: this.config.podName,
            connection_ids: Array.from(this.connections.keys()),
          }),
        },
      );
      logger.info("Notified backend of draining state", {
        podName: this.config.podName,
      });
    } catch (error) {
      // Log but don't fail - failover will still work via heartbeat timeout
      logger.error("Failed to notify backend of draining state", {
        error: sanitizeError(error),
      });
    }
  }

  isDraining(): boolean {
    return this.draining;
  }

  private removeAllListeners(conn: BotConnection): void {
    // Reservations have no client until connectBot finishes.
    if (!conn.client) {
      conn.listeners.clear();
      return;
    }
    // Use client.removeAllListeners() to ensure ALL listeners are removed,
    // even if some weren't tracked in conn.listeners (e.g., due to errors during registration)
    // This prevents memory leaks on repeated login failures
    conn.client.removeAllListeners();
    conn.listeners.clear();
  }

  private async pollForBots(): Promise<void> {
    // Don't poll for new assignments when draining - let other pods pick them up
    if (this.draining) {
      logger.debug("Skipping bot poll - pod is draining", {
        podName: this.config.podName,
      });
      return;
    }

    try {
      // Include current/max counts so backend only claims new connections if we have capacity
      const currentCount = this.connections.size;
      const url = new URL(
        `${this.config.elizaCloudUrl}/api/internal/discord/gateway/assignments`,
      );
      url.searchParams.set("pod", this.config.podName);
      url.searchParams.set("current", currentCount.toString());
      url.searchParams.set("max", MAX_BOTS_PER_POD.toString());

      const response = await this.routingAdapters.fetchAssignments(
        url.toString(),
        {
          headers: this.getAuthHeader(),
        },
      );

      if (!response.ok) {
        this.consecutivePollFailures++;
        logger.warn("Failed to poll for bot assignments", {
          status: response.status,
          consecutiveFailures: this.consecutivePollFailures,
        });
        this.logControlPlaneHealth();
        return;
      }

      const data = (await response.json()) as {
        assignments: Array<{
          connectionId: string;
          organizationId: string;
          applicationId: string;
          botToken: string;
          intents: number;
          characterId: string | null;
          dmPolicyState?: unknown;
        }>;
      };

      for (const assignment of data.assignments) {
        const dmPolicyState = parseDiscordConnectionDmPolicyState(
          assignment.dmPolicyState,
        );
        // Refresh the validated state in place so edits reach an existing bot
        // within one poll interval without replacing its Discord client.
        const existing = this.connections.get(assignment.connectionId);
        if (existing) {
          existing.dmPolicyState = dmPolicyState;
          continue;
        }

        // Check capacity and reserve slot atomically to prevent TOCTOU race
        // Without this, concurrent operations could both pass the check before either adds to the map
        if (this.connections.size >= MAX_BOTS_PER_POD) {
          logger.warn(
            "MAX_BOTS_PER_POD limit reached, skipping remaining assignments",
            {
              currentBots: this.connections.size,
              maxBots: MAX_BOTS_PER_POD,
              skippedConnectionId: assignment.connectionId,
            },
          );
          break;
        }

        // Reserve the slot immediately to prevent concurrent operations
        // from exceeding capacity. connectBot will overwrite with the real connection.
        const reservation: BotConnection = {
          connectionId: assignment.connectionId,
          organizationId: assignment.organizationId,
          applicationId: assignment.applicationId,
          characterId: assignment.characterId ?? null,
          client: undefined,
          status: "connecting",
          guildCount: 0,
          eventsReceived: 0,
          eventsRouted: 0,
          eventsFailed: 0,
          consecutiveFailures: 0,
          lastHeartbeat: new Date(),
          listeners: new Map(),
          dmPolicyState,
        };
        this.connections.set(assignment.connectionId, reservation);

        try {
          await this.connectBot(assignment);
        } catch (error) {
          // Releases the reservation if connectBot throws before setting the real connection.
          this.connections.delete(assignment.connectionId);
          logger.error("Failed to connect bot during assignment", {
            connectionId: assignment.connectionId,
            error: sanitizeError(error),
          });
        }
      }

      // Disconnect bots no longer assigned
      const assignedIds = new Set(data.assignments.map((a) => a.connectionId));
      const toDisconnect = [...this.connections.entries()]
        .filter(([id]) => !assignedIds.has(id))
        .map(([id]) => id);
      for (const connectionId of toDisconnect) {
        await this.disconnectBot(connectionId);
      }

      // Readiness begins only after the complete assignment response has been
      // validated and applied. A 2xx response with malformed data must not
      // admit a cold replica.
      this.consecutivePollFailures = 0;
      this.lastSuccessfulPoll = new Date();
    } catch (error) {
      this.consecutivePollFailures++;
      logger.error("Error polling for bots", {
        error: sanitizeError(error),
        consecutiveFailures: this.consecutivePollFailures,
      });
      this.logControlPlaneHealth();
    }
  }

  private logControlPlaneHealth(): void {
    const CRITICAL_FAILURE_THRESHOLD = 5;
    if (this.consecutivePollFailures >= CRITICAL_FAILURE_THRESHOLD) {
      logger.error("CRITICAL: Lost connection to control plane", {
        consecutiveFailures: this.consecutivePollFailures,
        lastSuccessfulPoll: this.lastSuccessfulPoll?.toISOString() ?? "never",
        controlPlaneUrl: this.config.elizaCloudUrl,
      });
    }
  }

  private async connectBot(assignment: {
    connectionId: string;
    organizationId: string;
    applicationId: string;
    botToken: string;
    intents: number;
    characterId: string | null;
    dmPolicyState?: unknown;
  }): Promise<void> {
    logger.info("Connecting bot", {
      connectionId: assignment.connectionId,
      applicationId: assignment.applicationId,
    });

    const clientOptions: ClientOptions = {
      intents: assignment.intents || DEFAULT_DISCORD_INTENTS,
      // Partials required for DM support - DM channels are not cached by default
      partials: [Partials.Channel, Partials.Message],
    };

    const client = new Client(clientOptions);
    const conn: BotConnection = {
      connectionId: assignment.connectionId,
      organizationId: assignment.organizationId,
      applicationId: assignment.applicationId,
      characterId: assignment.characterId ?? null,
      client,
      status: "connecting",
      guildCount: 0,
      eventsReceived: 0,
      eventsRouted: 0,
      eventsFailed: 0,
      consecutiveFailures: 0,
      lastHeartbeat: new Date(),
      listeners: new Map(),
      dmPolicyState: parseDiscordConnectionDmPolicyState(
        assignment.dmPolicyState,
      ),
    };

    const previous = this.connections.get(assignment.connectionId);
    this.connections.set(assignment.connectionId, conn);
    if (previous?.client) {
      // Same teardown contract as disconnectBot/shutdown: persist the
      // superseded connection's counters before its client is destroyed, so a
      // replacement does not silently discard guild and event totals.
      await this.saveSessionState(assignment.connectionId, previous);
      this.removeAllListeners(previous);
      previous.client.destroy();
    }

    const markConnectionReady = async (
      source: "client-ready" | "shard-ready" | "shard-resume",
      shardId?: number,
    ): Promise<void> => {
      const transition = reconcileDiscordConnectionReady(
        conn,
        client.guilds.cache.size,
      );

      // ClientReady supplies the canonical bot user identity after initial
      // login. Shard recovery events only need to persist a real transition;
      // duplicate ready/resume notifications must not create status-write
      // storms while a connection is already healthy.
      if (!transition.changed && source !== "client-ready") {
        logger.debug("Bot connection already ready", {
          connectionId: assignment.connectionId,
          source,
          shardId,
        });
        return;
      }

      logger.info("Bot connected", {
        connectionId: assignment.connectionId,
        guildCount: conn.guildCount,
        username: client.user?.username,
        botUserId: client.user?.id,
        source,
        shardId,
        previousStatus: transition.previousStatus,
      });
      await this.updateConnectionStatus(
        assignment.connectionId,
        "connected",
        undefined,
        client.user?.id,
      );
    };

    // Create wrapped handlers with error boundaries
    const createHandler = <T extends unknown[]>(
      eventName: string,
      handler: (...args: T) => Promise<void>,
    ) => {
      const wrappedHandler = async (...args: T) => {
        if (this.connections.get(assignment.connectionId) !== conn) {
          return;
        }
        try {
          await handler(...args);
        } catch (error) {
          logger.error(`Error in ${eventName} handler`, {
            connectionId: assignment.connectionId,
            error: sanitizeError(error),
          });
        }
      };
      conn.listeners.set(eventName, wrappedHandler);
      return wrappedHandler;
    };

    client.on(
      Events.ClientReady,
      createHandler(Events.ClientReady, async () => {
        await markConnectionReady("client-ready");
      }),
    );

    client.on(
      Events.ShardReady,
      createHandler(Events.ShardReady, async (shardId: number) => {
        await markConnectionReady("shard-ready", shardId);
      }),
    );

    client.on(
      Events.ShardResume,
      createHandler(
        Events.ShardResume,
        async (shardId: number, _replayedEvents: number) => {
          await markConnectionReady("shard-resume", shardId);
        },
      ),
    );

    client.on(
      Events.MessageCreate,
      createHandler(Events.MessageCreate, async (message: Message) => {
        conn.eventsReceived++;
        await this.handleMessage(assignment.connectionId, message);
      }),
    );

    client.on(
      Events.MessageUpdate,
      createHandler(
        Events.MessageUpdate,
        async (
          _oldMessage: Message | PartialMessage,
          newMessage: Message | PartialMessage,
        ) => {
          conn.eventsReceived++;
          if (newMessage.partial) return;
          await this.forwardEvent(
            assignment.connectionId,
            conn,
            "MESSAGE_UPDATE",
            {
              id: newMessage.id,
              channel_id: newMessage.channelId,
              guild_id: newMessage.guildId,
              content: newMessage.content,
              edited_timestamp: newMessage.editedAt?.toISOString(),
              author: newMessage.author
                ? {
                    id: newMessage.author.id,
                    username: newMessage.author.username,
                    bot: newMessage.author.bot,
                  }
                : undefined,
            },
          );
        },
      ),
    );

    client.on(
      Events.MessageDelete,
      createHandler(
        Events.MessageDelete,
        async (message: Message | PartialMessage) => {
          conn.eventsReceived++;
          await this.forwardEvent(
            assignment.connectionId,
            conn,
            "MESSAGE_DELETE",
            {
              id: message.id,
              channel_id: message.channelId,
              guild_id: message.guildId,
            },
          );
        },
      ),
    );

    client.on(
      Events.MessageReactionAdd,
      createHandler(
        Events.MessageReactionAdd,
        async (
          reaction: MessageReaction | PartialMessageReaction,
          user: User | PartialUser,
        ) => {
          conn.eventsReceived++;
          await this.forwardEvent(
            assignment.connectionId,
            conn,
            "MESSAGE_REACTION_ADD",
            {
              message_id: reaction.message.id,
              channel_id: reaction.message.channelId,
              guild_id: reaction.message.guildId,
              emoji: { name: reaction.emoji.name, id: reaction.emoji.id },
              user_id: user.id,
            },
          );
        },
      ),
    );

    client.on(
      Events.GuildMemberAdd,
      createHandler(Events.GuildMemberAdd, async (member: GuildMember) => {
        conn.eventsReceived++;
        await this.forwardEvent(
          assignment.connectionId,
          conn,
          "GUILD_MEMBER_ADD",
          {
            guild_id: member.guild.id,
            user: {
              id: member.user.id,
              username: member.user.username,
              discriminator: member.user.discriminator,
              avatar: member.user.avatar,
              bot: member.user.bot,
            },
            nick: member.nickname,
            roles: member.roles.cache.map((r: Role) => r.id),
            joined_at: member.joinedAt?.toISOString(),
          },
        );
      }),
    );

    client.on(
      Events.GuildMemberRemove,
      createHandler(
        Events.GuildMemberRemove,
        async (member: GuildMember | PartialGuildMember) => {
          conn.eventsReceived++;
          await this.forwardEvent(
            assignment.connectionId,
            conn,
            "GUILD_MEMBER_REMOVE",
            {
              guild_id: member.guild.id,
              user: {
                id: member.user.id,
                username: member.user.username,
                bot: member.user.bot,
              },
            },
          );
        },
      ),
    );

    client.on(
      Events.InteractionCreate,
      createHandler(
        Events.InteractionCreate,
        async (interaction: Interaction) => {
          conn.eventsReceived++;
          await this.forwardEvent(
            assignment.connectionId,
            conn,
            "INTERACTION_CREATE",
            {
              id: interaction.id,
              type: interaction.type,
              channel_id: interaction.channelId,
              guild_id: interaction.guildId,
              user: {
                id: interaction.user.id,
                username: interaction.user.username,
                bot: interaction.user.bot,
              },
              data: interaction.isChatInputCommand()
                ? {
                    name: interaction.commandName,
                    options: interaction.options.data,
                  }
                : undefined,
            },
          );
        },
      ),
    );

    client.on(
      Events.Error,
      createHandler(Events.Error, async (error: Error) => {
        conn.status = "error";
        conn.statusChangedAt = new Date();
        conn.error = error.message;
        logger.error("Bot error", {
          connectionId: assignment.connectionId,
          error: error.message,
        });
        await this.updateConnectionStatus(
          assignment.connectionId,
          "error",
          error.message,
        );
      }),
    );

    client.on(
      Events.ShardDisconnect,
      createHandler(Events.ShardDisconnect, async () => {
        conn.status = "disconnected";
        conn.statusChangedAt = new Date();
        logger.warn("Bot disconnected", {
          connectionId: assignment.connectionId,
        });
        await this.updateConnectionStatus(
          assignment.connectionId,
          "disconnected",
        );
      }),
    );

    client.on(
      Events.ShardReconnecting,
      createHandler(Events.ShardReconnecting, async () => {
        conn.status = "connecting";
        logger.info("Bot reconnecting", {
          connectionId: assignment.connectionId,
        });
      }),
    );

    try {
      await client.login(assignment.botToken);
    } catch (error) {
      // error-policy:J1 transport boundary — a login failure for the current
      // owner is published to the control plane as an "error" connection
      // status so the next poll can reassign it.
      //
      // error-policy:J5 a disconnect, replacement, or shutdown revokes
      // ownership before it starts awaited teardown, so this rejection belongs
      // to a client that path already destroyed; disconnectBot/shutdown
      // publishes the authoritative status for the slot and this stale
      // rejection must not overwrite it.
      if (this.connections.get(assignment.connectionId) !== conn) {
        logger.debug("Ignoring stale bot login rejection", {
          connectionId: assignment.connectionId,
          error: sanitizeError(error),
        });
        return;
      }

      const errorMessage = sanitizeError(error);
      logger.error("Failed to login bot", {
        connectionId: assignment.connectionId,
        error: errorMessage,
      });

      // Releases the failed connection so it can be retried
      this.removeAllListeners(conn);
      client.destroy();
      this.connections.delete(assignment.connectionId);

      // Update status in database - will allow reassignment on next poll
      await this.updateConnectionStatus(
        assignment.connectionId,
        "error",
        errorMessage,
      );
    }
  }

  private async disconnectBot(connectionId: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    logger.info("Disconnecting bot", { connectionId });
    // Revoke ownership synchronously so a login rejection or queued Discord
    // event cannot race the awaited session save and act as the live client.
    this.connections.delete(connectionId);
    await this.saveSessionState(connectionId, conn);
    this.removeAllListeners(conn);
    // Reservations have no client until connectBot finishes.
    if (conn.client) {
      conn.client.destroy();
    }
    await this.updateConnectionStatus(connectionId, "disconnected");
  }

  /**
   * Clean up stale connections that have been in disconnected/error state
   * for longer than STALE_CONNECTION_THRESHOLD_MS.
   *
   * This prevents memory leaks when the control plane is unreachable
   * and connections accumulate in disconnected state without being
   * removed by the normal poll cycle.
   *
   * Called during heartbeat when control plane is unhealthy.
   */
  private cleanupStaleConnections(): void {
    const now = Date.now();
    const staleConnections: string[] = [];

    for (const [connectionId, conn] of this.connections) {
      // Only releases disconnected or error connections with a timestamp
      if (
        (conn.status === "disconnected" || conn.status === "error") &&
        conn.statusChangedAt
      ) {
        const staleDuration = now - conn.statusChangedAt.getTime();
        if (staleDuration > STALE_CONNECTION_THRESHOLD_MS) {
          staleConnections.push(connectionId);
        }
      }
    }

    if (staleConnections.length > 0) {
      logger.warn("Cleaning up stale connections", {
        count: staleConnections.length,
        connectionIds: staleConnections,
        thresholdMs: STALE_CONNECTION_THRESHOLD_MS,
      });

      for (const connectionId of staleConnections) {
        const conn = this.connections.get(connectionId);
        if (conn) {
          this.removeAllListeners(conn);
          if (conn.client) {
            conn.client.destroy();
          }
          this.connections.delete(connectionId);
        }
      }
    }
  }

  private async handleMessage(
    connectionId: string,
    message: Message,
  ): Promise<void> {
    if (message.author.bot) return;

    const conn = this.connections.get(connectionId);
    if (!conn) return;

    // Enforce one fail-closed DM gate before attachment processing or either
    // routing topology. The cloud-shared event router remains defense in depth
    // for in-worker events.
    if (
      !message.guildId &&
      !isDmSenderAllowed(conn.dmPolicyState, message.author.id)
    ) {
      logger.debug("DM dropped by connection policy at the gateway", {
        connectionId,
        dmPolicy:
          conn.dmPolicyState.status === "valid"
            ? (conn.dmPolicyState.metadata.dmPolicy ?? "open")
            : "invalid",
      });
      return;
    }

    const eventData: Record<string, unknown> = {
      id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId,
      author: {
        id: message.author.id,
        username: message.author.username,
        discriminator: message.author.discriminator,
        avatar: message.author.avatar,
        bot: message.author.bot,
        global_name: message.author.globalName,
      },
      member: message.member
        ? {
            nick: message.member.nickname,
            roles: message.member.roles.cache.map((r: Role) => r.id),
          }
        : undefined,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
      attachments: message.attachments.map((a: Attachment) => ({
        id: a.id,
        filename: a.name,
        url: a.url,
        content_type: a.contentType,
        size: a.size,
      })),
      embeds: message.embeds.map((e: Embed) => ({
        title: e.title,
        description: e.description,
        url: e.url,
        color: e.color,
      })),
      mentions: message.mentions.users.map((u: User) => ({
        id: u.id,
        username: u.username,
        bot: u.bot,
      })),
      referenced_message: message.reference
        ? { id: message.reference.messageId }
        : undefined,
    };

    if (
      process.env.VOICE_MESSAGE_ENABLED !== "false" &&
      hasVoiceAttachments(message.attachments, message.flags)
    ) {
      try {
        const voiceAttachments =
          await this.voiceHandler.processVoiceAttachments(
            message.attachments,
            connectionId,
            message.id,
            message.flags,
          );

        if (voiceAttachments.length > 0) {
          eventData.voice_attachments = voiceAttachments;
          logger.info("Processed voice attachments", {
            connectionId,
            messageId: message.id,
            count: voiceAttachments.length,
          });
        } else {
          logger.warn(
            "Voice attachments detected but none processed successfully",
            {
              connectionId,
              messageId: message.id,
              attachmentCount: message.attachments.size,
            },
          );
        }
      } catch (error) {
        logger.error("Failed to process voice attachments", {
          connectionId,
          messageId: message.id,
          error: sanitizeError(error),
        });
      }
    }

    if (!this.redis) {
      logger.warn("No Redis connection, cannot route message", {
        connectionId,
      });
      return;
    }

    if (!conn.characterId) {
      logger.warn("Connection has no characterId, cannot route message", {
        connectionId,
      });
      return;
    }

    // Path A routing: prefer a self-registered container when its registry
    // key exists (`agent:<characterId>:server`). This is the FEATURE FLAG for
    // container routing: only agents whose container has self-registered take
    // this branch. Every other agent (incl. the working in-worker agent that
    // never registers) falls through to forwardEvent -> CF in-worker, which
    // is the live, proven path. Gradual + reversible: removing the registry
    // key reverts an agent to in-worker with zero redeploy.
    let route: Awaited<
      ReturnType<GatewayManagerRoutingAdapters["resolveAgentServer"]>
    > = null;
    try {
      route = await this.routingAdapters.resolveAgentServer(
        this.redis,
        conn.characterId,
      );
    } catch (error) {
      logger.warn("resolveAgentServer failed; falling back to in-worker", {
        connectionId,
        agentId: conn.characterId,
        error: sanitizeError(error),
      });
    }

    if (!route) {
      // No container registered for this agent — use the in-worker CF path.
      await this.forwardEvent(connectionId, conn, "MESSAGE_CREATE", eventData);
      conn.eventsRouted++;
      return;
    }

    try {
      await this.routingAdapters.refreshKedaActivity(
        this.redis,
        route.serverName,
      );
      const { channel } = message;
      if ("sendTyping" in channel && typeof channel.sendTyping === "function") {
        await channel.sendTyping();
      }

      const userId = `discord-user-${message.author.id}`;
      const response = await this.routingAdapters.forwardToServer(
        route.serverUrl,
        route.serverName,
        conn.characterId,
        userId,
        message.content,
        {
          senderName:
            message.member?.displayName ??
            message.author.globalName ??
            message.author.username,
          accountId: connectionId,
          platformRecordId: message.id,
          chatId: message.channelId,
          chatType: message.guildId ? "group" : "dm",
        },
      );

      if (response) {
        for (const chunk of chunkDiscordText(response)) {
          await message.reply(chunk);
        }
      }

      conn.eventsRouted++;
      conn.consecutiveFailures = 0;
      logger.info("Message routed to server", {
        connectionId,
        serverName: route.serverName,
        agentId: conn.characterId,
        project: this.config.project,
      });
    } catch (error) {
      conn.eventsFailed++;
      conn.consecutiveFailures++;
      logger.error("Failed to route message to server", {
        connectionId,
        agentId: conn.characterId,
        serverName: route.serverName,
        project: this.config.project,
        error: sanitizeError(error),
      });
    }
  }

  private async forwardEvent(
    connectionId: string,
    conn: BotConnection,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const payload = {
      connection_id: connectionId,
      organization_id: conn.organizationId,
      platform_connection_id: connectionId,
      event_type: eventType,
      event_id: (data.id as string) ?? `${eventType}-${Date.now()}`,
      guild_id: (data.guild_id as string) ?? "",
      channel_id: (data.channel_id as string) ?? "",
      data,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await this.routingAdapters.forwardInWorkerEvent(
        `${this.config.elizaCloudUrl}/api/internal/discord/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.getAuthHeader(),
          },
          body: JSON.stringify(payload),
          timeout: EVENT_FORWARD_TIMEOUT_MS, // AI processing can take longer
        },
      );

      if (response.ok) {
        conn.eventsRouted++;
        conn.consecutiveFailures = 0;
        logger.info("Event forwarded", {
          connectionId,
          eventType,
          eventId: payload.event_id,
          channelId: payload.channel_id,
        });
      } else {
        conn.eventsFailed++;
        conn.consecutiveFailures++;
        logger.warn("Failed to forward event", {
          connectionId,
          eventType,
          status: response.status,
          totalFailed: conn.eventsFailed,
          consecutiveFailures: conn.consecutiveFailures,
        });
      }
    } catch (error) {
      conn.eventsFailed++;
      conn.consecutiveFailures++;
      logger.error("Error forwarding event", {
        connectionId,
        eventType,
        error: sanitizeError(error),
        totalFailed: conn.eventsFailed,
        consecutiveFailures: conn.consecutiveFailures,
      });
    }
  }

  private async updateConnectionStatus(
    connectionId: string,
    status: string,
    errorMessage?: string,
    botUserId?: string,
  ): Promise<void> {
    try {
      await fetchWithTimeout(
        `${this.config.elizaCloudUrl}/api/internal/discord/gateway/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.getAuthHeader(),
          },
          body: JSON.stringify({
            connection_id: connectionId,
            pod_name: this.config.podName,
            status,
            error_message: errorMessage,
            // Bot user ID for mention detection (different from application_id)
            bot_user_id: botUserId,
          }),
        },
      );
    } catch (error) {
      logger.error("Failed to update connection status", {
        connectionId,
        status,
        error: sanitizeError(error),
      });
    }
  }

  private async saveSessionState(
    connectionId: string,
    conn: BotConnection,
  ): Promise<void> {
    if (!this.redis) return;

    const state = {
      connectionId,
      organizationId: conn.organizationId,
      applicationId: conn.applicationId,
      podId: this.config.podName,
      guildCount: conn.guildCount,
      eventsReceived: conn.eventsReceived,
      eventsRouted: conn.eventsRouted,
      savedAt: Date.now(),
    };

    try {
      await this.redis.setex(
        `discord:session:${connectionId}`,
        SESSION_STATE_TTL_SECONDS,
        JSON.stringify(state),
      );
    } catch (error) {
      logger.error("Failed to save session state", {
        connectionId,
        error: sanitizeError(error),
      });
    }
  }

  private async sendHeartbeat(): Promise<void> {
    const now = new Date();
    for (const [, conn] of this.connections) {
      conn.lastHeartbeat = now;
    }

    // Update database heartbeat for failover detection (includes stats)
    if (this.connections.size > 0) {
      try {
        // Collect stats for each connection
        const connectionStats = Array.from(this.connections.entries()).map(
          ([id, conn]) => ({
            id,
            guildCount: conn.guildCount,
            eventsReceived: conn.eventsReceived,
            eventsRouted: conn.eventsRouted,
          }),
        );

        await fetchWithTimeout(
          `${this.config.elizaCloudUrl}/api/internal/discord/gateway/heartbeat`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...this.getAuthHeader(),
            },
            body: JSON.stringify({
              pod_name: this.config.podName,
              connection_ids: Array.from(this.connections.keys()),
              connection_stats: connectionStats,
            }),
          },
        );
      } catch (error) {
        logger.error("Failed to update database heartbeat", {
          error: sanitizeError(error),
        });
      }
    }

    // Update Redis for fast failover detection
    if (this.redis) {
      try {
        const podState = {
          podId: this.config.podName,
          connections: Array.from(this.connections.keys()),
          lastHeartbeat: Date.now(),
        };
        await this.redis.setex(
          `discord:pod:${this.config.podName}`,
          POD_STATE_TTL_SECONDS,
          JSON.stringify(podState),
        );
        await this.redis.sadd("discord:active_pods", this.config.podName);
      } catch (error) {
        logger.error("Failed to send Redis heartbeat", {
          error: sanitizeError(error),
        });
      }
    }

    // Releases stale connections when the control plane is unhealthy
    // to prevent memory leaks from accumulating disconnected connections
    const CRITICAL_FAILURE_THRESHOLD = 5;
    if (this.consecutivePollFailures >= CRITICAL_FAILURE_THRESHOLD) {
      this.cleanupStaleConnections();
    }
  }

  private async checkForDeadPods(): Promise<void> {
    if (!this.redis) return;

    try {
      const activePods = await this.redis.smembers("discord:active_pods");
      if (!activePods || activePods.length === 0) return;

      for (const podId of activePods) {
        if (podId === this.config.podName) continue;

        const podState = await this.redis.get<string>(`discord:pod:${podId}`);
        if (!podState) {
          // Pod state expired, it's dead
          await this.claimOrphanedConnections(podId);
          continue;
        }

        const state =
          typeof podState === "string" ? JSON.parse(podState) : podState;
        const timeSinceHeartbeat = Date.now() - state.lastHeartbeat;

        if (timeSinceHeartbeat > DEAD_POD_THRESHOLD_MS) {
          logger.warn("Dead pod detected", { podId, timeSinceHeartbeat });
          await this.claimOrphanedConnections(podId);
        }
      }
    } catch (error) {
      logger.error("Error checking for dead pods", {
        error: sanitizeError(error),
      });
    }
  }

  private async claimOrphanedConnections(deadPodId: string): Promise<void> {
    if (!this.redis) return;

    // Acquire distributed lock to prevent multiple pods from claiming simultaneously
    // Uses SETNX semantics - only one pod can acquire the lock
    const lockKey = `discord:failover:lock:${deadPodId}`;
    const lockAcquired = await this.redis.set(lockKey, this.config.podName, {
      ex: FAILOVER_LOCK_TTL_SECONDS,
      nx: true,
    });

    if (!lockAcquired) {
      logger.debug("Failover lock already held by another pod", {
        deadPodId,
        lockKey,
      });
      return;
    }

    logger.info("Claiming orphaned connections from dead pod", {
      deadPodId,
      lockAcquired: true,
    });

    try {
      // Report to backend that this pod is taking over orphaned connections
      const response = await fetchWithTimeout(
        `${this.config.elizaCloudUrl}/api/internal/discord/gateway/failover`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.getAuthHeader(),
          },
          body: JSON.stringify({
            claiming_pod: this.config.podName,
            dead_pod: deadPodId,
          }),
        },
      );

      if (response.ok) {
        const data = (await response.json()) as { claimed: number };
        logger.info("Claimed orphaned connections", {
          deadPodId,
          claimed: data.claimed,
        });

        // Releases Redis state only when failover was approved
        // Preserve Redis state when failover is rejected because the pod may still be alive
        await this.redis.srem("discord:active_pods", deadPodId);
        await this.redis.del(`discord:pod:${deadPodId}`);
      } else {
        // Preserve Redis state because the pod may still be alive
        // Other pods will retry failover check on next interval
        logger.warn("Failover claim rejected", {
          deadPodId,
          status: response.status,
        });
      }
    } catch (error) {
      logger.error("Error claiming orphaned connections", {
        deadPodId,
        error: sanitizeError(error),
      });
    } finally {
      // Release lock after operation completes (or let it expire naturally)
      // Using DEL is safe here - if another pod somehow got the lock, it means
      // the TTL expired and our operation took too long anyway
      await this.redis.del(lockKey).catch(() => {
        // Ignore lock-release errors because the TTL handles expiry
      });
    }
  }

  // ============================================
  // Eliza App Bot Leader Election
  // ============================================

  /**
   * Start leader election for the Eliza App bot.
   * Only one pod should connect the Eliza App bot to prevent duplicate messages.
   */
  private async startElizaAppBotLeaderElection(): Promise<void> {
    // Require explicit opt-in via ELIZA_APP_DISCORD_BOT_ENABLED
    const enabled = process.env.ELIZA_APP_DISCORD_BOT_ENABLED === "true";
    if (!enabled) {
      logger.debug(
        "Eliza App Discord bot disabled (ELIZA_APP_DISCORD_BOT_ENABLED not set)",
      );
      return;
    }

    const botToken = process.env.ELIZA_APP_DISCORD_BOT_TOKEN;
    if (!botToken) {
      logger.error(
        "Eliza App Discord bot enabled but ELIZA_APP_DISCORD_BOT_TOKEN not set",
      );
      return;
    }

    if (!this.redis) {
      logger.warn(
        "Eliza App bot leader election requires Redis - bot disabled",
      );
      return;
    }

    logger.info("Starting Eliza App bot leader election", {
      podName: this.config.podName,
      ttlSeconds: ELIZA_APP_LEADER_TTL_SECONDS,
      checkIntervalMs: ELIZA_APP_LEADER_CHECK_INTERVAL_MS,
    });

    // Try to become leader immediately
    await this.tryBecomeElizaAppLeader();

    // Keep trying/renewing periodically
    this.elizaAppLeaderInterval = setInterval(() => {
      this.tryBecomeElizaAppLeader().catch((error) => {
        logger.error("Error in Eliza App leader election", {
          error: sanitizeError(error),
        });
      });
    }, ELIZA_APP_LEADER_CHECK_INTERVAL_MS);
  }

  /**
   * Try to acquire or renew Eliza App bot leadership.
   */
  private async tryBecomeElizaAppLeader(): Promise<void> {
    if (!this.redis) return;

    try {
      if (this.isElizaAppLeader) {
        // Already leader - renew the lock
        const renewed = await this.redis.expire(
          ELIZA_APP_LEADER_KEY,
          ELIZA_APP_LEADER_TTL_SECONDS,
        );
        if (!renewed) {
          // Lock was lost (expired or deleted)
          logger.warn(
            "Lost Eliza App bot leadership, attempting to reacquire",
            {
              podName: this.config.podName,
            },
          );
          this.isElizaAppLeader = false;
          await this.disconnectElizaAppBot();
        } else {
          logger.debug("Renewed Eliza App bot leadership", {
            podName: this.config.podName,
          });
        }
        return;
      }

      // Try to acquire leadership
      const acquired = await this.redis.set(
        ELIZA_APP_LEADER_KEY,
        this.config.podName,
        {
          ex: ELIZA_APP_LEADER_TTL_SECONDS,
          nx: true,
        },
      );

      if (acquired === "OK") {
        logger.info("Acquired Eliza App bot leadership", {
          podName: this.config.podName,
          ttlSeconds: ELIZA_APP_LEADER_TTL_SECONDS,
        });
        this.isElizaAppLeader = true;
        await this.connectElizaAppBot();
      } else {
        logger.debug("Eliza App bot leadership held by another pod", {
          podName: this.config.podName,
        });
      }
    } catch (error) {
      logger.error("Error in Eliza App leader election", {
        error: sanitizeError(error),
        podName: this.config.podName,
      });
    }
  }

  /**
   * Connect the Eliza App Discord bot.
   * Only called when this pod has acquired leadership.
   */
  private async connectElizaAppBot(): Promise<void> {
    const botToken = process.env.ELIZA_APP_DISCORD_BOT_TOKEN;
    if (!botToken || this.elizaAppClient) return;

    logger.info("Connecting Eliza App Discord bot", {
      podName: this.config.podName,
    });

    this.elizaAppClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        MANAGED_GUILD_VOICE_INTENT,
      ],
      // Partials required for DM support - DM channels are not cached by default
      partials: [Partials.Channel, Partials.Message],
    });

    this.elizaAppClient.on(Events.ClientReady, () => {
      logger.info("Eliza App bot connected", {
        podName: this.config.podName,
        username: this.elizaAppClient?.user?.username,
        userId: this.elizaAppClient?.user?.id,
      });
      this.startGreetingPolling();
      this.startDmPolling();
      void this.installWelcomeQueue?.start().catch((error) => {
        logger.error("Failed to start Discord install welcome queue", {
          error: sanitizeError(error),
        });
      });
      if (process.env.ELIZA_APP_DISCORD_GUILD_VOICE_ENABLED === "true") {
        const client = this.elizaAppClient;
        if (client && !this.managedGuildVoice) {
          this.managedGuildVoice = new ManagedGuildVoiceController({
            client,
            bridge: createManagedGuildVoiceCloudBridge({
              apiBaseUrl: this.config.elizaCloudUrl,
              getAuthorizationHeader: () => this.getAuthHeader(),
            }),
          });
          void this.managedGuildVoice.start().catch((error) => {
            logger.error("Failed to start managed Discord guild voice", {
              error: sanitizeError(error),
            });
          });
        }
      }
    });

    this.elizaAppClient.on(Events.MessageCreate, async (message: Message) => {
      if (!message.guild) {
        const claimed = await this.claimElizaAppDmMessage(message.id);
        if (!claimed) return;
      }
      await this.handleElizaAppMessage(message);
      if (!message.guild) {
        await this.trackElizaAppDm(
          message.channelId,
          message.author.id,
          message.id,
        );
      }
    });

    this.elizaAppClient.on(Events.Error, (error: Error) => {
      logger.error("Eliza App bot error", {
        podName: this.config.podName,
        error: error.message,
      });
    });

    this.elizaAppClient.on(Events.ShardDisconnect, () => {
      logger.warn("Eliza App bot disconnected", {
        podName: this.config.podName,
      });
    });

    try {
      await this.elizaAppClient.login(botToken);
      logger.info("Eliza App bot login successful", {
        podName: this.config.podName,
      });
    } catch (error) {
      logger.error("Failed to login Eliza App bot", {
        podName: this.config.podName,
        error: sanitizeError(error),
      });
      this.elizaAppClient.destroy();
      this.elizaAppClient = null;
    }
  }

  /**
   * Disconnect the Eliza App bot.
   */
  private async disconnectElizaAppBot(): Promise<void> {
    if (this.managedGuildVoice) {
      await this.managedGuildVoice.stop();
      this.managedGuildVoice = null;
    }
    if (this.greetingPollInterval) {
      clearInterval(this.greetingPollInterval);
      this.greetingPollInterval = null;
    }
    if (this.dmPollInterval) {
      clearInterval(this.dmPollInterval);
      this.dmPollInterval = null;
    }
    // Let an in-flight delivery acknowledge before disconnecting. A crash or
    // forced shutdown remains safe through lease expiry and nonce deduplication.
    if (this.greetingDrainInFlight) {
      await this.greetingDrainInFlight;
      this.greetingDrainInFlight = null;
    }
    if (this.dmPollInFlight) {
      await this.dmPollInFlight;
      this.dmPollInFlight = null;
    }
    await this.installWelcomeQueue?.stop();
    if (this.elizaAppClient) {
      logger.info("Disconnecting Eliza App bot", {
        podName: this.config.podName,
      });
      this.elizaAppClient.destroy();
      this.elizaAppClient = null;
    }
  }

  /**
   * Start the proactive-greeting drain loop. Leader-only (called from
   * connectElizaAppBot): the API's claim is atomic, but a single poller
   * avoids pointless contention and keeps DM sends on the pod that owns the
   * bot connection.
   */
  private startGreetingPolling(): void {
    if (this.greetingPollInterval) return;
    this.greetingPollInterval = setInterval(() => {
      // Skip if the previous drain is still running; never claim a second
      // batch while one is in flight.
      if (this.greetingDrainInFlight) return;
      const drain = this.drainAndDeliverGreetings()
        .catch((error) => {
          // error-policy:J1 This timer callback is the background-job boundary;
          // lease recovery preserves unacknowledged work for the next poll.
          logger.error("Error draining proactive onboarding greetings", {
            error: sanitizeError(error),
          });
        })
        .finally(() => {
          if (this.greetingDrainInFlight === drain) {
            this.greetingDrainInFlight = null;
          }
        });
      this.greetingDrainInFlight = drain;
    }, GREETING_POLL_INTERVAL_MS);
    logger.info("Proactive onboarding greeting polling started", {
      podName: this.config.podName,
      intervalMs: GREETING_POLL_INTERVAL_MS,
    });
  }

  /**
   * Claims pending post-sign-in greetings from the API and delivers each as a
   * proactive DM. Recoverable lease/ack semantics live in
   * {@link drainAndDeliverPendingGreetings}; this wrapper binds the production
   * fetch/auth/send closures.
   */
  private async drainAndDeliverGreetings(): Promise<void> {
    const client = this.elizaAppClient;
    if (!this.isElizaAppLeader || !client?.isReady()) return;

    await drainAndDeliverPendingGreetings({
      drain: () =>
        fetchWithTimeout(
          `${this.config.elizaCloudUrl}/api/internal/discord/eliza-app/pending-greetings`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...this.getAuthHeader(),
            },
            body: JSON.stringify({ action: "claim" }),
            timeout: HTTP_TIMEOUT_MS,
          },
        ),
      acknowledge: (acknowledgements) =>
        fetchWithTimeout(
          `${this.config.elizaCloudUrl}/api/internal/discord/eliza-app/pending-greetings`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...this.getAuthHeader(),
            },
            body: JSON.stringify({ action: "ack", acknowledgements }),
            timeout: HTTP_TIMEOUT_MS,
          },
        ),
      sendDirectMessage: async (userId, content, deliveryNonce) => {
        const result = await this.deliverElizaAppDirectMessage({
          discordUserId: userId,
          text: content,
          nonce: deliveryNonce,
        });
        if (!result.accepted) {
          throw new Error("Eliza App Discord bot is not the active leader");
        }
      },
      isTerminalError: isTerminalDiscordDirectMessageError,
      refreshAuth: () => this.refreshToken(),
      onEvent: (event) => {
        if (event.kind === "delivered") {
          logger.info("Delivered proactive onboarding greeting", {
            sessionId: event.sessionId ?? null,
          });
        } else if (event.kind === "send-failed") {
          logger.warn("Failed to deliver proactive onboarding greeting", {
            sessionId: event.sessionId ?? null,
            error: sanitizeError(event.error),
          });
        } else if (event.kind === "malformed") {
          logger.warn("Skipping malformed proactive greeting", {
            sessionId: event.sessionId ?? null,
          });
        } else if (event.kind === "drain-failed") {
          logger.warn("Proactive greeting drain returned non-OK status", {
            status: event.status,
          });
        } else {
          logger.warn(
            "Proactive greeting acknowledgement returned non-OK status",
            {
              status: event.status,
            },
          );
        }
      },
    });
  }

  private startDmPolling(): void {
    if (this.dmPollInterval) return;
    const run = (): void => {
      if (this.dmPollInFlight) return;
      const poll = this.pollElizaAppDms()
        .catch((error) => {
          // error-policy:J1 This timer callback is the background-job boundary;
          // durable cursors and per-message claims make the next poll safe.
          logger.error("Error polling Eliza App Discord DMs", {
            error: sanitizeError(error),
          });
        })
        .finally(() => {
          if (this.dmPollInFlight === poll) this.dmPollInFlight = null;
        });
      this.dmPollInFlight = poll;
    };
    run();
    this.dmPollInterval = setInterval(run, ELIZA_APP_DM_POLL_INTERVAL_MS);
    logger.info("Eliza App DM fallback polling started", {
      podName: this.config.podName,
      intervalMs: ELIZA_APP_DM_POLL_INTERVAL_MS,
    });
  }

  private dmStateKey(channelId: string): string {
    return `${ELIZA_APP_DM_STATE_PREFIX}${channelId}`;
  }

  private async trackElizaAppDm(
    channelId: string,
    userId: string,
    lastMessageId: string,
  ): Promise<void> {
    if (!this.redis) return;
    const state: TrackedDiscordDm = { channelId, userId, lastMessageId };
    await this.redis.sadd(ELIZA_APP_DM_CHANNELS_KEY, channelId);
    await this.redis.setex(
      this.dmStateKey(channelId),
      ELIZA_APP_DM_STATE_TTL_SECONDS,
      JSON.stringify(state),
    );
  }

  private async listTrackedElizaAppDms(): Promise<TrackedDiscordDm[]> {
    if (!this.redis) return [];
    const channelIds = await this.redis.smembers(ELIZA_APP_DM_CHANNELS_KEY);
    const tracked: TrackedDiscordDm[] = [];
    for (const channelId of channelIds) {
      const state = await this.redis.get<TrackedDiscordDm>(
        this.dmStateKey(channelId),
      );
      if (
        !state ||
        state.channelId !== channelId ||
        !state.userId ||
        !/^\d+$/.test(state.lastMessageId)
      ) {
        await this.redis.srem(ELIZA_APP_DM_CHANNELS_KEY, channelId);
        await this.redis.del(this.dmStateKey(channelId));
        continue;
      }
      tracked.push(state);
    }
    return tracked;
  }

  private async claimElizaAppDmMessage(messageId: string): Promise<boolean> {
    if (!this.redis) return true;
    const result = await this.redis.set(
      `${ELIZA_APP_DM_CLAIM_PREFIX}${messageId}`,
      "1",
      { ex: ELIZA_APP_DM_CLAIM_TTL_SECONDS, nx: true },
    );
    return result === "OK";
  }

  private async pollElizaAppDms(): Promise<void> {
    const client = this.elizaAppClient;
    if (!this.redis || !this.isElizaAppLeader || !client?.isReady()) return;

    const report = await pollTrackedDiscordDms<Message>({
      listTracked: () => this.listTrackedElizaAppDms(),
      fetchAfter: async (state) => {
        const channel = await client.channels.fetch(state.channelId);
        if (!channel?.isDMBased() || !("messages" in channel)) {
          throw Object.assign(new Error("Tracked channel is not a bot DM"), {
            code: 10003,
          });
        }
        const messages = await channel.messages.fetch({
          after: state.lastMessageId,
          limit: 50,
          cache: false,
        });
        return [...messages.values()];
      },
      claimMessage: (messageId) => this.claimElizaAppDmMessage(messageId),
      routeMessage: (message) => this.handleElizaAppMessage(message),
      updateCursor: (state, messageId) =>
        this.trackElizaAppDm(state.channelId, state.userId, messageId),
      removeTracked: async (state) => {
        if (!this.redis) return;
        await this.redis.srem(ELIZA_APP_DM_CHANNELS_KEY, state.channelId);
        await this.redis.del(this.dmStateKey(state.channelId));
      },
      isTerminalChannelError: (error) => {
        const code =
          error && typeof error === "object"
            ? (error as { code?: unknown }).code
            : undefined;
        return code === 10003 || code === 50001 || code === 50007;
      },
      onError: (state, error) => {
        logger.warn("Failed to poll tracked Eliza App Discord DM", {
          channelId: state.channelId,
          error: sanitizeError(error),
        });
      },
    });

    if (report.routed > 0 || report.removed > 0) {
      logger.info("Eliza App DM fallback poll completed", { ...report });
    }
  }

  /**
   * Handle a message received by the Eliza App bot.
   * Handles both DM identity routing and managed guild installs.
   */
  private async handleElizaAppMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.guild) {
      await this.handleManagedAgentGuildMessage(message);
      return;
    }
    const trimmedContent = message.content.trim();
    if (!trimmedContent) return;
    try {
      const linkAttempt = await tryConfirmDiscordIdentityLink(
        {
          cloudBaseUrl: this.config.elizaCloudUrl,
          getAuthHeader: () => this.getAuthHeader(),
        },
        {
          text: trimmedContent,
          discordUserId: message.author.id,
          discordUsername: message.author.username,
        },
      );
      if (linkAttempt.handled) {
        await message.reply(linkAttempt.reply);
        return;
      }
    } catch (error) {
      // error-policy:J4 A recognizable link challenge must not become agent
      // chat when Cloud is unavailable; expose a distinct retryable failure.
      logger.warn("Discord identity-link confirmation unavailable", {
        messageId: message.id,
        error: sanitizeError(error),
      });
      await message.reply(
        "I couldn't verify that link code right now. Please try sending it again in a moment.",
      );
      return;
    }
    await this.routeManagedAgentMessage(message, trimmedContent);
  }

  private async handleManagedAgentGuildMessage(
    message: Message,
  ): Promise<void> {
    const botUserId = this.elizaAppClient?.user?.id;
    if (!botUserId || !message.guildId) {
      return;
    }

    const trimmedContent = message.content.trim();
    if (!trimmedContent) {
      return;
    }

    const botMentionRegex = new RegExp(`<@!?${botUserId}>`, "g");
    const botMentioned =
      message.mentions.users.has(botUserId) ||
      botMentionRegex.test(trimmedContent);
    if (!botMentioned) {
      return;
    }

    const mentionedOtherUser = message.mentions.users.some(
      (user: { id: string }) => user.id !== botUserId,
    );
    const repliedUserId = message.mentions.repliedUser?.id;
    const repliedToAnotherUser = Boolean(
      repliedUserId && repliedUserId !== botUserId,
    );
    if (
      mentionedOtherUser ||
      message.mentions.everyone ||
      repliedToAnotherUser
    ) {
      logger.debug("Ignoring managed guild message that targets someone else", {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
      });
      return;
    }

    const sanitizedContent = trimmedContent.replace(botMentionRegex, "").trim();
    if (!sanitizedContent) {
      return;
    }

    await this.routeManagedAgentMessage(message, sanitizedContent);
  }

  private async routeManagedAgentMessage(
    message: Message,
    content: string,
  ): Promise<void> {
    try {
      // Egress health (proven dropped-turn class, E2E 2026-08-05): a single
      // transient failure from the routing API must not consume the user's
      // turn. The route is idempotent on `discord:<messageId>`, so bounded
      // retry replays the SAME turn instead of dropping it.
      const startedAt = Date.now();
      const route = () =>
        postManagedAgentMessageWithRetry({
          doPost: () =>
            fetchWithTimeout(
              `${this.config.elizaCloudUrl}/api/internal/discord/eliza-app/messages`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...this.getAuthHeader(),
                },
                body: JSON.stringify({
                  ...(message.guildId ? { guildId: message.guildId } : {}),
                  channelId: message.channelId,
                  messageId: message.id,
                  content,
                  sender: {
                    id: message.author.id,
                    username: message.author.username,
                    displayName:
                      message.member?.displayName ??
                      message.author.globalName ??
                      undefined,
                    avatar: message.author.displayAvatarURL() || null,
                  },
                }),
                timeout: EVENT_FORWARD_TIMEOUT_MS,
              },
            ),
          refreshAuth: () => this.refreshToken(),
          onAttemptFailure: ({ attempt, status, error }) => {
            logger.warn("Managed Agent Discord routing attempt failed", {
              guildId: message.guildId ?? null,
              channelId: message.channelId,
              messageId: message.id,
              attempt,
              ...(status !== undefined ? { status } : {}),
              error: sanitizeError(error),
            });
          },
        });
      const typingChannel =
        "sendTyping" in message.channel ? message.channel : null;
      const outcome = typingChannel
        ? await withManagedTypingHeartbeat(
            {
              sendTyping: () => typingChannel.sendTyping(),
              onFailure: (error) => {
                logger.warn("Managed Agent Discord typing heartbeat failed", {
                  guildId: message.guildId ?? null,
                  channelId: message.channelId,
                  messageId: message.id,
                  error,
                });
              },
            },
            route,
          )
        : await route();
      logger.info("Managed Agent Discord routing completed", {
        guildId: message.guildId ?? null,
        channelId: message.channelId,
        messageId: message.id,
        elapsedMs: Date.now() - startedAt,
        attempts: outcome.attempts,
        ok: outcome.ok,
        ...(outcome.ok
          ? {
              traceId: outcome.traceId,
              serverTiming: outcome.serverTiming,
            }
          : {}),
      });

      if (!outcome.ok) {
        logger.error("Managed Agent Discord turn dropped after retries", {
          guildId: message.guildId ?? null,
          channelId: message.channelId,
          messageId: message.id,
          attempts: outcome.attempts,
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
          error: sanitizeError(outcome.error),
        });
        const failureOptions = buildManagedFailureReplyOptions(message.id);
        const failureDelivery = await deliverManagedReply({
          sendFailureNotice: async () =>
            classifyManagedReplyReceipt(
              await message.reply(failureOptions),
              failureOptions,
            ),
        });
        if (failureDelivery.state === "deduplicated") {
          logger.warn(
            "Managed Agent Discord failure notice resolved to an existing nonce message",
            {
              guildId: message.guildId ?? null,
              channelId: message.channelId,
              messageId: message.id,
            },
          );
        } else if (failureDelivery.state === "undeliverable") {
          logger.error(
            "Managed Agent Discord failure notice was undeliverable",
            {
              guildId: message.guildId ?? null,
              channelId: message.channelId,
              messageId: message.id,
              error: sanitizeError(failureDelivery.failureNoticeError),
            },
          );
        }
        return;
      }

      const routed = outcome.routed;

      if (!routed.handled) {
        logger.debug("Managed Agent Discord message was not handled", {
          guildId: message.guildId ?? null,
          channelId: message.channelId,
          reason: routed.reason,
          agentId: routed.agentId,
        });
        return;
      }

      if (!routed.replyText?.trim()) {
        return;
      }

      const replyText = routed.replyText.trim();
      const replyChunks = chunkDiscordText(replyText);
      const failureOptions = buildManagedFailureReplyOptions(message.id);
      const delivery = await deliverManagedReply({
        sendReply: async () => {
          let delivered = false;
          for (let index = 0; index < replyChunks.length; index += 1) {
            const replyOptions = buildManagedReplyOptions(
              discordChunkNonce(message.id, index),
              replyChunks[index] ?? "",
              index === replyChunks.length - 1 ? routed.replyCta : null,
            );
            const receipt = classifyManagedReplyReceipt(
              await message.reply(replyOptions),
              replyOptions,
            );
            if (receipt === "delivered") delivered = true;
          }
          return delivered ? "delivered" : "deduplicated";
        },
        sendFailureNotice: async () =>
          classifyManagedReplyReceipt(
            await message.reply(failureOptions),
            failureOptions,
          ),
      });
      if (delivery.state === "deduplicated") {
        logger.warn(
          "Managed Agent Discord send resolved to an existing nonce message",
          {
            guildId: message.guildId ?? null,
            channelId: message.channelId,
            messageId: message.id,
            attempted: delivery.attempted,
          },
        );
      } else if (delivery.state === "failure_notice") {
        logger.warn("Managed Agent Discord reply degraded to failure notice", {
          guildId: message.guildId ?? null,
          channelId: message.channelId,
          messageId: message.id,
          error: sanitizeError(delivery.primaryError ?? "unknown"),
        });
      } else if (delivery.state === "undeliverable") {
        logger.error(
          "Managed Agent Discord reply and failure notice were undeliverable",
          {
            guildId: message.guildId ?? null,
            channelId: message.channelId,
            messageId: message.id,
            primaryError: sanitizeError(delivery.primaryError ?? "unknown"),
            failureNoticeError: sanitizeError(delivery.failureNoticeError),
          },
        );
      }
    } catch (error) {
      logger.error("Failed to route managed Eliza Discord message", {
        guildId: message.guildId ?? null,
        channelId: message.channelId,
        messageId: message.id,
        error: sanitizeError(error),
      });
    }
  }

  getHealth(): HealthStatus {
    const bots = [...this.connections.values()];
    const connectedBots = bots.filter((c) => c.status === "connected").length;
    const totalBots = bots.length;
    const disconnectedBots = totalBots - connectedBots;
    const totalGuilds = bots.reduce((sum, c) => sum + c.guildCount, 0);

    // Control plane connectivity affects health
    const CRITICAL_FAILURE_THRESHOLD = 5;
    const controlPlaneLost =
      this.consecutivePollFailures >= CRITICAL_FAILURE_THRESHOLD;
    const controlPlaneReady =
      this.lastSuccessfulPoll !== null && !controlPlaneLost;
    const systemBotEnabled =
      process.env.ELIZA_APP_DISCORD_BOT_ENABLED === "true";
    const systemBotConfigured = Boolean(
      process.env.ELIZA_APP_DISCORD_BOT_TOKEN?.trim() && this.redis,
    );
    const systemBotConnected = Boolean(
      this.isElizaAppLeader && this.elizaAppClient?.isReady(),
    );
    const systemBotDegraded =
      systemBotEnabled &&
      (!systemBotConfigured || (this.isElizaAppLeader && !systemBotConnected));

    // Note: draining pods are still "healthy" for liveness (don't restart)
    // but will fail readiness (don't accept new work)
    const status: HealthStatus["status"] = controlPlaneLost
      ? "unhealthy"
      : totalBots > 0 && connectedBots === 0
        ? "unhealthy"
        : systemBotDegraded
          ? "degraded"
          : disconnectedBots > 0
            ? "degraded"
            : "healthy";

    return {
      status,
      podName: this.config.podName,
      totalBots,
      connectedBots,
      disconnectedBots,
      totalGuilds,
      uptime: Date.now() - this.startTime.getTime(),
      draining: this.draining,
      systemBot: {
        enabled: systemBotEnabled,
        configured: systemBotConfigured,
        leader: this.isElizaAppLeader,
        connected: systemBotConnected,
      },
      controlPlane: {
        consecutiveFailures: this.consecutivePollFailures,
        lastSuccessfulPoll: this.lastSuccessfulPoll?.toISOString() ?? null,
        healthy: controlPlaneReady,
      },
    };
  }

  /** Readiness requires one authenticated control-plane poll, not merely a live process. */
  isReady(health: HealthStatus = this.getHealth()): boolean {
    return (
      !health.draining &&
      health.status === "healthy" &&
      health.controlPlane.healthy &&
      health.controlPlane.lastSuccessfulPoll !== null &&
      (health.totalBots === 0 || health.connectedBots > 0)
    );
  }

  getMetrics(): string {
    const h = this.getHealth();
    const pod = this.config.podName;

    const metrics = [
      metric(
        "discord_gateway_bots_total",
        "gauge",
        "Total bots managed",
        pod,
        h.totalBots,
      ),
      metric(
        "discord_gateway_bots_connected",
        "gauge",
        "Connected bots",
        pod,
        h.connectedBots,
      ),
      metric(
        "discord_gateway_guilds_total",
        "gauge",
        "Total guilds",
        pod,
        h.totalGuilds,
      ),
      metric(
        "discord_gateway_uptime_seconds",
        "gauge",
        "Uptime in seconds",
        pod,
        Math.floor(h.uptime / 1000),
      ),
      metric(
        "discord_gateway_draining",
        "gauge",
        "Pod is draining (1=draining, 0=active)",
        pod,
        h.draining ? 1 : 0,
      ),
      metric(
        "discord_gateway_control_plane_failures",
        "gauge",
        "Consecutive control plane poll failures",
        pod,
        h.controlPlane.consecutiveFailures,
      ),
      metric(
        "discord_gateway_control_plane_healthy",
        "gauge",
        "Control plane connectivity (1=healthy, 0=unhealthy)",
        pod,
        h.controlPlane.healthy ? 1 : 0,
      ),
      metric(
        "discord_gateway_system_bot_enabled",
        "gauge",
        "Eliza App system bot is enabled (1=enabled, 0=disabled)",
        pod,
        h.systemBot.enabled ? 1 : 0,
      ),
      metric(
        "discord_gateway_system_bot_configured",
        "gauge",
        "Eliza App system bot has token and leader-election storage (1=configured, 0=missing)",
        pod,
        h.systemBot.configured ? 1 : 0,
      ),
      metric(
        "discord_gateway_system_bot_leader",
        "gauge",
        "Pod owns Eliza App system-bot leadership (1=leader, 0=standby)",
        pod,
        h.systemBot.leader ? 1 : 0,
      ),
      metric(
        "discord_gateway_system_bot_connected",
        "gauge",
        "Leader-owned Eliza App system bot is connected (1=connected, 0=not connected)",
        pod,
        h.systemBot.connected ? 1 : 0,
      ),
    ];

    for (const [id, conn] of this.connections) {
      const escapedId = escapePrometheusLabel(id);
      metrics.push(
        `discord_gateway_events_received{connection="${escapedId}"} ${conn.eventsReceived}`,
      );
      metrics.push(
        `discord_gateway_events_routed{connection="${escapedId}"} ${conn.eventsRouted}`,
      );
      metrics.push(
        `discord_gateway_events_failed{connection="${escapedId}"} ${conn.eventsFailed}`,
      );
    }

    return metrics.join("\n");
  }

  getStatus(): Record<string, unknown> {
    const health = this.getHealth();
    return {
      podName: this.config.podName,
      startTime: this.startTime.toISOString(),
      uptime: Date.now() - this.startTime.getTime(),
      draining: this.draining,
      drainingStartedAt: this.drainingStartedAt?.toISOString() ?? null,
      controlPlane: {
        consecutiveFailures: this.consecutivePollFailures,
        lastSuccessfulPoll: this.lastSuccessfulPoll?.toISOString() ?? null,
      },
      systemBot: health.systemBot,
      connections: [...this.connections.entries()].map(([id, c]) => ({
        connectionId: id,
        organizationId: c.organizationId,
        applicationId: c.applicationId,
        status: c.status,
        guildCount: c.guildCount,
        eventsReceived: c.eventsReceived,
        eventsRouted: c.eventsRouted,
        eventsFailed: c.eventsFailed,
        consecutiveFailures: c.consecutiveFailures,
        lastHeartbeat: c.lastHeartbeat.toISOString(),
        connectedAt: c.connectedAt?.toISOString(),
        error: c.error,
      })),
    };
  }
}
