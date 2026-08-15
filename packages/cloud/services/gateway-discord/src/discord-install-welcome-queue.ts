/**
 * Persists Discord user-install welcome jobs in Redis and delivers them with
 * crash recovery and deterministic Discord nonces.
 */
import { createHash } from "node:crypto";
import { logger } from "./logger";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const QUEUE_KEY = "discord:eliza-app:install-welcome:pending";
const PROCESSING_KEY = "discord:eliza-app:install-welcome:processing";
const DELIVERED_PREFIX = "discord:eliza-app:install-welcome:delivered:";
const DELIVERED_TTL_SECONDS = 7 * 24 * 60 * 60;
const POLL_INTERVAL_MS = 1_000;
const DISCORD_TOKEN_PATTERN =
  /[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g;

export interface DiscordInstallWelcomeJob {
  id: string;
  eventTimestamp: string;
  user: {
    id: string;
    globalName?: string | null;
    username?: string;
  };
}

export interface DiscordInstallWelcomeRedis {
  get<T = string>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    options?: { ex?: number; px?: number; nx?: boolean },
  ): Promise<unknown>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lmove(
    source: string,
    destination: string,
    whereFrom: "left" | "right",
    whereTo: "left" | "right",
  ): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<number>;
}

interface DiscordApiError {
  message?: string;
  code?: number;
}

export function sanitizeDiscordInstallWelcomeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(DISCORD_TOKEN_PATTERN, "[REDACTED_TOKEN]");
}

function deliveryNonce(job: DiscordInstallWelcomeJob): string {
  const digest = createHash("sha256")
    .update(`${job.user.id}:${job.eventTimestamp}`)
    .digest();
  return digest.readBigUInt64BE().toString();
}

async function discordApi<T>(
  path: string,
  body: Record<string, unknown>,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T & DiscordApiError;
  if (!response.ok) {
    throw new Error(
      `Discord API request failed (${response.status}): ${result.message ?? result.code ?? "unknown error"}`,
    );
  }
  return result;
}

export async function sendDiscordInstallWelcome(
  job: DiscordInstallWelcomeJob,
  options: { botToken: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const channel = await discordApi<{ id: string }>(
    "/users/@me/channels",
    { recipient_id: job.user.id },
    options.botToken,
    fetchImpl,
  );
  if (!channel.id) throw new Error("Discord did not return a DM channel");

  const displayName = job.user.globalName?.trim() || job.user.username?.trim();
  const greeting = displayName
    ? `Hey ${displayName} — Eliza here. You're connected. Send me a message here and I'll reply.`
    : "Hey — Eliza here. You're connected. Send me a message here and I'll reply.";
  await discordApi(
    `/channels/${encodeURIComponent(channel.id)}/messages`,
    {
      content: greeting,
      nonce: deliveryNonce(job),
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    },
    options.botToken,
    fetchImpl,
  );
}

export class DiscordInstallWelcomeQueue {
  private interval: ReturnType<typeof setInterval> | null = null;
  private drainInFlight: Promise<void> | null = null;

  constructor(
    private readonly redis: DiscordInstallWelcomeRedis,
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async enqueue(job: DiscordInstallWelcomeJob): Promise<void> {
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(job));
  }

  async start(): Promise<void> {
    if (this.interval) return;
    await this.recoverProcessingJobs();
    this.interval = setInterval(() => this.scheduleDrain(), POLL_INTERVAL_MS);
    this.scheduleDrain();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.drainInFlight;
  }

  async drainOnce(): Promise<boolean> {
    let raw = await this.redis.lmove(
      QUEUE_KEY,
      PROCESSING_KEY,
      "right",
      "left",
    );
    if (!raw) {
      const recovered = await this.redis.lmove(
        PROCESSING_KEY,
        QUEUE_KEY,
        "right",
        "left",
      );
      if (!recovered) return false;
      raw = await this.redis.lmove(QUEUE_KEY, PROCESSING_KEY, "right", "left");
      if (!raw) return false;
    }

    let job: DiscordInstallWelcomeJob;
    try {
      job = JSON.parse(raw) as DiscordInstallWelcomeJob;
      if (!job.id || !job.user?.id || !job.eventTimestamp) {
        throw new Error("Discord install welcome job is invalid");
      }
    } catch (error) {
      await this.redis.lrem(PROCESSING_KEY, 1, raw);
      logger.error("Discarded invalid Discord install welcome job", {
        error: sanitizeDiscordInstallWelcomeError(error),
      });
      return true;
    }

    const deliveredKey = `${DELIVERED_PREFIX}${job.id}`;
    if (await this.redis.get(deliveredKey)) {
      await this.redis.lrem(PROCESSING_KEY, 1, raw);
      return true;
    }

    try {
      await sendDiscordInstallWelcome(job, {
        botToken: this.botToken,
        fetchImpl: this.fetchImpl,
      });
      // Discord's enforce_nonce makes a replay safe if the process dies after
      // the REST response but before this durable delivered marker is written.
      await this.redis.set(deliveredKey, "1", {
        ex: DELIVERED_TTL_SECONDS,
      });
      await this.redis.lrem(PROCESSING_KEY, 1, raw);
    } catch (error) {
      // Requeue before removing the processing claim. A crash between these
      // operations creates a harmless duplicate rather than losing the job.
      await this.redis.lpush(QUEUE_KEY, raw);
      await this.redis.lrem(PROCESSING_KEY, 1, raw);
      logger.warn("Discord install welcome delivery will retry", {
        jobId: job.id,
        error: sanitizeDiscordInstallWelcomeError(error),
      });
    }
    return true;
  }

  private scheduleDrain(): void {
    if (this.drainInFlight) return;
    this.drainInFlight = this.drainOnce()
      .then(() => undefined)
      .catch((error) => {
        logger.error("Discord install welcome queue drain failed", {
          error: sanitizeDiscordInstallWelcomeError(error),
        });
      })
      .finally(() => {
        this.drainInFlight = null;
      });
  }

  private async recoverProcessingJobs(): Promise<void> {
    while (await this.redis.lmove(PROCESSING_KEY, QUEUE_KEY, "right", "left")) {
      // Move every abandoned in-flight job back to the durable pending list.
    }
  }
}
