/**
 * Verifies Discord application event webhooks and starts a DM after a user
 * installs Eliza to their account.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const APPLICATION_AUTHORIZED = "APPLICATION_AUTHORIZED";
const USER_INSTALL = 1;

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

interface DiscordApiError {
  message?: string;
  code?: number;
}

export interface DiscordEventWebhookDependencies {
  applicationId: string;
  botToken: string;
  getPublicKey: () => Promise<string>;
  fetchImpl?: typeof fetch;
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

function deliveryNonce(userId: string, eventTimestamp: string): string {
  const digest = createHash("sha256")
    .update(`${userId}:${eventTimestamp}`)
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

async function sendInstallWelcome(
  user: { id: string; global_name?: string | null; username?: string },
  eventTimestamp: string,
  deps: DiscordEventWebhookDependencies,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const channel = await discordApi<{ id: string }>(
    "/users/@me/channels",
    { recipient_id: user.id },
    deps.botToken,
    fetchImpl,
  );
  if (!channel.id) throw new Error("Discord did not return a DM channel");

  const displayName = user.global_name?.trim() || user.username?.trim();
  const greeting = displayName
    ? `Hey ${displayName} — Eliza here. You're connected. Send me a message here and I'll reply.`
    : "Hey — Eliza here. You're connected. Send me a message here and I'll reply.";
  await discordApi(
    `/channels/${encodeURIComponent(channel.id)}/messages`,
    {
      content: greeting,
      nonce: deliveryNonce(user.id, eventTimestamp),
      enforce_nonce: true,
    },
    deps.botToken,
    fetchImpl,
  );
}

export async function handleDiscordEventWebhook(
  request: Request,
  deps: DiscordEventWebhookDependencies,
): Promise<Response> {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const publicKey = await deps.getPublicKey();
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
    await sendInstallWelcome(
      {
        id: user.id,
        global_name: user.global_name,
        username: user.username,
      },
      event.timestamp,
      deps,
    );
  }

  return new Response(null, {
    status: 204,
    headers: { "Content-Type": "application/json" },
  });
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
