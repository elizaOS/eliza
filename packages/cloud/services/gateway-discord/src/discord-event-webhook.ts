/**
 * Verifies Discord application event webhooks and durably enqueues a welcome
 * after a user installs Eliza to their account.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { Hono } from "hono";
import type { DiscordInstallWelcomeJob } from "./discord-install-welcome-queue";
import { sanitizeDiscordInstallWelcomeError } from "./discord-install-welcome-queue";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const APPLICATION_AUTHORIZED = "APPLICATION_AUTHORIZED";
const USER_INSTALL = 1;
const PUBLIC_KEY_TIMEOUT_MS = 750;
const ENQUEUE_TIMEOUT_MS = 1_250;

interface DiscordWebhookPayload {
  application_id?: string;
  type?: number;
  event?: {
    type?: string;
    timestamp?: string;
    data?: {
      integration_type?: number;
      user?: { id?: string; global_name?: string | null; username?: string };
    };
  };
}

export interface DiscordEventWebhookDependencies {
  applicationId: string;
  getPublicKey: () => Promise<string>;
  enqueue: (job: DiscordInstallWelcomeJob) => Promise<void>;
}

export interface DiscordEventWebhookRouteConfig
  extends DiscordEventWebhookDependencies {
  enabled: boolean;
  logError?: (message: string, context: { error: string }) => void;
}

function discordPublicKey(rawPublicKey: string) {
  if (!/^[0-9a-f]{64}$/i.test(rawPublicKey)) {
    throw new Error("Discord application public key is invalid");
  }
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(rawPublicKey, "hex")]),
    format: "der",
    type: "spki",
  });
}

export function verifyDiscordEventSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  publicKey: string,
): boolean {
  if (!/^[0-9a-f]{128}$/i.test(signature) || !timestamp) return false;
  return verify(
    null,
    Buffer.from(`${timestamp}${rawBody}`),
    discordPublicKey(publicKey),
    Buffer.from(signature, "hex"),
  );
}

function welcomeJobId(
  applicationId: string,
  userId: string,
  eventTimestamp: string,
): string {
  return createHash("sha256")
    .update(`${applicationId}:${userId}:${eventTimestamp}`)
    .digest("hex");
}

async function withinWebhookBudget<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operation} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function handleDiscordEventWebhook(
  request: Request,
  deps: DiscordEventWebhookDependencies,
): Promise<Response> {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const publicKey = await withinWebhookBudget(
    deps.getPublicKey(),
    PUBLIC_KEY_TIMEOUT_MS,
    "Discord public-key resolution",
  );
  if (!verifyDiscordEventSignature(rawBody, timestamp, signature, publicKey)) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: DiscordWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as DiscordWebhookPayload;
  } catch {
    return new Response(JSON.stringify({ error: "invalid payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (payload.application_id && payload.application_id !== deps.applicationId) {
    return new Response(JSON.stringify({ error: "wrong application" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (payload.type === 0) {
    return new Response(null, {
      status: 204,
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = payload.event;
  const user = event?.data?.user;
  if (
    payload.type === 1 &&
    event?.type === APPLICATION_AUTHORIZED &&
    event.data?.integration_type === USER_INSTALL &&
    event.timestamp &&
    user?.id
  ) {
    await withinWebhookBudget(
      deps.enqueue({
        id: welcomeJobId(deps.applicationId, user.id, event.timestamp),
        eventTimestamp: event.timestamp,
        user: {
          id: user.id,
          globalName: user.global_name,
          username: user.username,
        },
      }),
      ENQUEUE_TIMEOUT_MS,
      "Discord install welcome enqueue",
    );
  }

  return new Response(null, {
    status: 204,
    headers: { "Content-Type": "application/json" },
  });
}

export function createDiscordEventWebhookApp(
  config: DiscordEventWebhookRouteConfig,
): Hono {
  const app = new Hono();
  app.post("/discord/event-webhook", async (c) => {
    if (!config.enabled) {
      return c.json({ error: "Discord app bot is disabled" }, 503);
    }
    try {
      return await handleDiscordEventWebhook(c.req.raw, config);
    } catch (error) {
      // error-policy:J1 Bound all pre-ACK work and translate transient
      // verification/queue failures so Discord retries without a dropped job.
      config.logError?.("Discord application event webhook failed", {
        error: sanitizeDiscordInstallWelcomeError(error),
      });
      return c.json({ error: "Discord webhook processing failed" }, 503);
    }
  });
  return app;
}

export function createDiscordPublicKeyResolver(options: {
  botToken: string;
  configuredPublicKey?: string;
  fetchImpl?: typeof fetch;
}): () => Promise<string> {
  let cached = options.configuredPublicKey?.trim();
  return async () => {
    if (cached) return cached;
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${DISCORD_API_BASE}/applications/@me`, {
      headers: { Authorization: `Bot ${options.botToken}` },
    });
    const application = (await response.json()) as {
      public_key?: string;
      verify_key?: string;
      message?: string;
    };
    const publicKey = application.public_key ?? application.verify_key;
    if (!response.ok || !publicKey) {
      throw new Error(
        `Unable to resolve Discord application public key (${response.status}): ${application.message ?? "missing public key"}`,
      );
    }
    cached = publicKey;
    return cached;
  };
}
