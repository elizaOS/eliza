import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "@polyagent/shared";
import { streamAdd } from "../redis";
import type { JsonValue } from "../types";
// import { enqueueOutbox } from './outbox'; // Uncomment when needed

/**
 * Supported realtime channels.
 */
export type RealtimeChannel =
  | "feed"
  | "markets"
  | "breaking-news"
  | "upcoming-events"
  | `chat:${string}`
  | `notifications:${string}`
  | `agent:${string}`
  | string;

export interface RealtimeEventEnvelope<T extends JsonValue = JsonValue> {
  channel: RealtimeChannel;
  type: string;
  version?: string;
  data: T;
  timestamp: number;
}

export interface RealtimeTokenPayload {
  userId: string;
  channels: RealtimeChannel[];
  exp: number; // epoch seconds
  iat: number; // epoch seconds
}

const REALTIME_SECRET =
  process.env.REALTIME_SIGNING_SECRET ||
  process.env.JWT_SECRET ||
  process.env.CRON_SECRET;

const base64url = (input: Buffer) =>
  input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeBase64url = (input: string) => {
  const padding = 4 - (input.length % 4 || 4);
  const normalized =
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding % 4);
  return Buffer.from(normalized, "base64");
};

const getSecret = (): Buffer => {
  if (!REALTIME_SECRET) {
    throw new Error("REALTIME_SIGNING_SECRET is not configured");
  }
  return Buffer.from(REALTIME_SECRET);
};

/**
 * Sign a realtime subscription payload (HMAC-SHA256).
 */
export function signRealtimeToken(payload: RealtimeTokenPayload): string {
  const header = { alg: "HS256", typ: "JWT", kid: "realtime" };
  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const sig = createHmac("sha256", getSecret()).update(signingInput).digest();
  return `${signingInput}.${base64url(sig)}`;
}

/**
 * Verify a realtime subscription token and return the payload if valid.
 */
export function verifyRealtimeToken(
  token: string,
): RealtimeTokenPayload | null {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const signingInput = `${h}.${p}`;
  const expected = createHmac("sha256", getSecret())
    .update(signingInput)
    .digest();
  const actual = decodeBase64url(s);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  const payload = JSON.parse(
    decodeBase64url(p).toString(),
  ) as RealtimeTokenPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;
  return payload;
}

/**
 * Publish an event to a realtime channel.
 *
 * Contract:
 * - If DB logic fails upstream, surface the error (caller decides).
 * - If publish fails but upstream work succeeded, we log and rely on the
 *   outbox/worker to replay later.
 */
export async function publishEvent(
  event: RealtimeEventEnvelope,
  opts?: { maxlen?: number },
): Promise<void> {
  const streamKey = toStreamKey(event.channel);
  const res = await streamAdd(
    streamKey,
    { ...event, version: event.version ?? "v1" } as Record<string, JsonValue>,
    {
      maxlen: opts?.maxlen ?? 10_000,
    },
  );
  if (!res) {
    throw new Error("streamAdd returned null (Redis not available)");
  }
  logger.info(
    "Realtime event published",
    { channel: event.channel, type: event.type, streamId: res },
    "Realtime",
  );
}

export const toStreamKey = (channel: RealtimeChannel) => `realtime:${channel}`;

/**
 * Generate a short-lived realtime token for a user and channels.
 * Default expiry: 15 minutes.
 */
export function issueRealtimeToken(params: {
  userId: string;
  channels: RealtimeChannel[];
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (params.ttlSeconds ?? 900);
  const payload: RealtimeTokenPayload = {
    userId: params.userId,
    channels: params.channels,
    exp,
    iat: now,
  };
  return signRealtimeToken(payload);
}

export const generateConnectionId = () => randomBytes(12).toString("hex");
