/**
 * Persists Discord user-install welcome jobs and delivers them with
 * crash recovery and deterministic Discord nonces. A delivery Discord
 * rejects for good (the user blocked the bot or closed their DMs) is dropped;
 * a transient failure retries with backoff until the attempt budget is spent.
 */

import { createHash } from "node:crypto";
import {
  DISCORD_WELCOME_DELIVERED as DELIVERED_PREFIX,
  DISCORD_WELCOME_REQUEUE,
  DiscordWelcomeStateError,
  DISCORD_WELCOME_PROCESSING as PROCESSING_KEY,
  DISCORD_WELCOME_PENDING as QUEUE_KEY,
} from "@elizaos/cloud-services-common/discord-welcome-state";
import { logger } from "./logger";
import { isKnownDiscordDirectMessageRejection } from "./proactive-greeting-delivery";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DELIVERED_TTL_SECONDS = 7 * 24 * 60 * 60;
const POLL_INTERVAL_MS = 1_000;
const MAX_DELIVERY_ATTEMPTS = 8;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;
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
  /** Failed delivery attempts so far; set by the queue on a requeue. */
  attempts?: number;
  /** Not delivered before this time; set by the queue on a requeue. */
  retryAt?: string;
}

export interface DiscordInstallWelcomeRedis {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
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
  ): Promise<unknown>;
  lrem(key: string, count: number, value: string): Promise<number>;
}

interface DiscordApiError {
  message?: string;
  code?: number;
}

/** A Discord REST failure with the status and code the terminal-rejection check reads. */
export class DiscordApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "DiscordApiRequestError";
  }
}

/** Discord will never deliver this DM: a 4xx other than rate limiting. */
function isTerminalDeliveryFailure(error: unknown): boolean {
  return (
    error instanceof DiscordApiRequestError &&
    error.status !== 429 &&
    isKnownDiscordDirectMessageRejection(error)
  );
}

function retryDelayMs(attempts: number): number {
  return Math.min(
    RETRY_BASE_DELAY_MS * 2 ** (attempts - 1),
    RETRY_MAX_DELAY_MS,
  );
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
    throw new DiscordApiRequestError(
      `Discord API request failed (${response.status}): ${result.message ?? result.code ?? "unknown error"}`,
      response.status,
      typeof result.code === "number" ? result.code : undefined,
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
  private startInFlight: Promise<void> | null = null;
  private stopInFlight: Promise<void> | null = null;
  private drainInFlight: Promise<void> | null = null;

  constructor(
    private readonly redis: DiscordInstallWelcomeRedis,
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async enqueue(job: DiscordInstallWelcomeJob): Promise<void> {
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(job));
  }

  private async requeue(raw: string, retry: string): Promise<void> {
    const replaced = await this.redis.eval(
      DISCORD_WELCOME_REQUEUE,
      [PROCESSING_KEY, QUEUE_KEY],
      [raw, retry],
    );
    if (replaced !== 1)
      throw new DiscordWelcomeStateError(
        "Discord welcome processing claim was not replaced",
      );
  }

  start(): Promise<void> {
    if (this.stopInFlight || this.interval) return Promise.resolve();
    if (this.startInFlight) return this.startInFlight;
    // Publish the startup before any recovery request can leave this owner.
    this.startInFlight = Promise.resolve()
      .then(async () => {
        await this.recoverProcessingJobs();
        if (this.stopInFlight) return;
        this.interval = setInterval(
          () => this.scheduleDrain(),
          POLL_INTERVAL_MS,
        );
        this.scheduleDrain();
      })
      .finally(() => {
        this.startInFlight = null;
      });
    return this.startInFlight;
  }

  stop(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Join recovery as well as delivery before releasing ownership. The start
    // caller receives any recovery error through its original promise.
    this.stopInFlight = Promise.allSettled([
      this.startInFlight,
      this.drainInFlight,
    ])
      .then(([, drain]) => {
        if (drain.status === "rejected") throw drain.reason;
      })
      .finally(() => {
        this.stopInFlight = null;
      });
    return this.stopInFlight;
  }

  async drainOnce(): Promise<boolean> {
    let claimed = await this.redis.lmove(
      QUEUE_KEY,
      PROCESSING_KEY,
      "right",
      "left",
    );
    if (!claimed) {
      const recovered = await this.redis.lmove(
        PROCESSING_KEY,
        QUEUE_KEY,
        "right",
        "left",
      );
      if (!recovered) return false;
      claimed = await this.redis.lmove(
        QUEUE_KEY,
        PROCESSING_KEY,
        "right",
        "left",
      );
      if (!claimed) return false;
    }
    // Upstash REST deserializes list members by default, so the claim can
    // arrive as the parsed job. enqueue stored JSON.stringify(job), so the
    // same call gives back the exact member for lrem and the requeue.
    const raw = typeof claimed === "string" ? claimed : JSON.stringify(claimed);

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
    if (job.retryAt && Date.parse(job.retryAt) > Date.now()) {
      // Still backing off: back to the pending list untouched.
      await this.requeue(raw, raw);
      return true;
    }

    try {
      await sendDiscordInstallWelcome(job, {
        botToken: this.botToken,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      const attempts = (job.attempts ?? 0) + 1;
      const terminal = isTerminalDeliveryFailure(error);
      if (terminal || attempts >= MAX_DELIVERY_ATTEMPTS) {
        await this.redis.lrem(PROCESSING_KEY, 1, raw);
        logger.warn("Discord install welcome dropped", {
          jobId: job.id,
          attempts,
          reason: terminal ? "rejected_by_discord" : "attempts_exhausted",
          error: sanitizeDiscordInstallWelcomeError(error),
        });
        return true;
      }
      const retry: DiscordInstallWelcomeJob = {
        ...job,
        attempts,
        retryAt: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
      };
      await this.requeue(raw, JSON.stringify(retry));
      logger.warn("Discord install welcome delivery will retry", {
        jobId: job.id,
        attempts,
        retryAt: retry.retryAt,
        error: sanitizeDiscordInstallWelcomeError(error),
      });
      return true;
    }
    // Storage errors are not provider failures. The next drain can inspect
    // the retained marker or recover the processing claim with the same nonce.
    await this.redis.set(deliveredKey, "1", {
      ex: DELIVERED_TTL_SECONDS,
    });
    await this.redis.lrem(PROCESSING_KEY, 1, raw);
    return true;
  }

  private scheduleDrain(): void {
    if (this.stopInFlight || this.drainInFlight) return;
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
