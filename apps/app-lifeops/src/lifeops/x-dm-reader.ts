/**
 * x-dm-reader.ts
 *
 * X (Twitter) Direct Message reader — a distinct channel from the public feed.
 *
 * The feed reader (`x-reader.ts` + `service-mixin-x-read.ts`) handles home
 * timeline, mentions, and search. This module provides the DM-specific
 * capability descriptor and the high-level pull function that the LifeOps
 * service layer uses to read inbound DMs independently of feed operations.
 *
 * Why a separate file from `x-reader.ts`:
 * - DMs require different OAuth scopes ("Direct Messages Read") than feed
 *   reads ("Tweet Read") — they are separate permission grants.
 * - The DM channel is private; the feed is public. Access control,
 *   capability checking, and connector-status reporting differ.
 * - Keeping the channels separate prevents callers from accidentally
 *   conflating "I have x.read for feeds" with "I can read DMs".
 *
 * Capability descriptor:
 *   channel: "x_dm"
 *   direction: "inbound"
 *   transport: "api" | "browser" (API is primary; browser path is a future escape hatch)
 *   requiredScopes: ["dm.read"]
 *   requiredEnvVars: ["TWITTER_API_KEY", "TWITTER_API_SECRET", "TWITTER_ACCESS_TOKEN", "TWITTER_ACCESS_TOKEN_SECRET"]
 */

import { logger } from "@elizaos/core";
import {
  readXDms,
  XReadError,
  type XRawDm,
  type XReadPageOptions,
  type XReaderCredentials,
} from "./x-reader.js";

// ---------------------------------------------------------------------------
// Capability descriptor — typed, no heuristics
// ---------------------------------------------------------------------------

export type XDmTransport = "api" | "browser";

/**
 * Typed capability descriptor for the X DM inbound channel.
 *
 * A connector produces one of these to declare what it can do. The service
 * layer reads this — no switch/if-on-string branching.
 */
export interface XDmCapabilityDescriptor {
  /** Discriminant: always "x_dm". Distinct from "x_feed". */
  readonly channel: "x_dm";
  /** Direction this descriptor describes. */
  readonly direction: "inbound";
  /** How the read is performed. */
  readonly transport: XDmTransport;
  /** OAuth scopes required for this capability. */
  readonly requiredScopes: readonly string[];
  /** Process environment variables that must be set. */
  readonly requiredEnvVars: readonly string[];
  /** Optional: max DMs returned per pull call. */
  readonly maxPerPull: number;
}

/**
 * Capability descriptor for the primary X DM inbound path via Twitter API v2.
 */
export const X_DM_INBOUND_CAPABILITY: XDmCapabilityDescriptor = {
  channel: "x_dm",
  direction: "inbound",
  transport: "api",
  requiredScopes: ["dm.read"],
  requiredEnvVars: [
    "TWITTER_API_KEY",
    "TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_TOKEN_SECRET",
  ],
  maxPerPull: 100,
} as const;

// ---------------------------------------------------------------------------
// Credential reading
// ---------------------------------------------------------------------------

/**
 * Read X DM reader credentials from the environment.
 *
 * Accepts the same env vars as the poster and feed reader so a single set of
 * app credentials covers all X operations.
 *
 * Returns null when any required var is absent.
 */
export function readXDmCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): XReaderCredentials | null {
  const apiKey = env.TWITTER_API_KEY?.trim();
  const apiSecret = env.TWITTER_API_SECRET?.trim();
  const accessToken = env.TWITTER_ACCESS_TOKEN?.trim();
  const accessTokenSecret = env.TWITTER_ACCESS_TOKEN_SECRET?.trim();

  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    return null;
  }

  const userId = env.TWITTER_USER_ID?.trim();
  return {
    apiKey,
    apiSecret,
    accessToken,
    accessTokenSecret,
    userId: userId && userId.length > 0 ? userId : undefined,
  };
}

// ---------------------------------------------------------------------------
// Normalized DM type
// ---------------------------------------------------------------------------

/**
 * A normalized inbound X DM.
 *
 * Callers receive this type — not `XRawDm` — so the service layer and any
 * downstream consumers depend only on this stable shape.
 */
export interface XInboundDm {
  /** Local stable ID (UUID generated at pull time). */
  id: string;
  /** Native Twitter DM event ID. */
  externalDmId: string;
  /** Twitter conversation (DM thread) ID. */
  conversationId: string;
  /** @handle of the sender. */
  senderHandle: string;
  /** Numeric Twitter user ID of the sender. */
  senderId: string;
  /** Plain-text message body. */
  text: string;
  /** ISO 8601 timestamp from the Twitter API. */
  receivedAt: string;
  /** Whether this message was sent to us (vs sent by us). */
  isInbound: boolean;
  /** ISO 8601 timestamp when we pulled this message. */
  syncedAt: string;
  /** Raw metadata from the API for debugging. */
  metadata: Record<string, unknown>;
}

function rawDmToXInboundDm(raw: XRawDm, syncedAt: string): XInboundDm {
  return {
    id: `${raw.conversationId}:${raw.id}`,
    externalDmId: raw.id,
    conversationId: raw.conversationId,
    senderHandle: raw.senderHandle,
    senderId: raw.senderId,
    text: raw.text,
    receivedAt: raw.createdAt,
    isInbound: raw.isInbound,
    syncedAt,
    metadata: raw.metadata,
  };
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface XDmPullResult {
  /** Normalized inbound DMs (only messages where isInbound is true). */
  inbound: XInboundDm[];
  /** All normalized DMs (inbound + outbound). */
  all: XInboundDm[];
  /** Pagination cursor for the next pull. Null when no more pages. */
  nextCursor: string | null;
  /** ISO 8601 timestamp of this pull. */
  syncedAt: string;
  /** Whether credentials were present at pull time. */
  hasCredentials: boolean;
}

// ---------------------------------------------------------------------------
// Pull function
// ---------------------------------------------------------------------------

/**
 * Pull inbound X DMs via the Twitter API v2 `/dm_events` endpoint.
 *
 * - Requires credentials from {@link readXDmCredentialsFromEnv}.
 * - Returns an empty result (not null, not thrown) when credentials are absent.
 * - Logs rate-limit and auth errors at warn; rethrows unexpected errors.
 * - Deduplication by `externalDmId` is the caller's responsibility (typically
 *   via the repository upsert).
 *
 * @param options.limit  Maximum DMs to fetch (1–100, default 25).
 * @param options.cursor Pagination cursor from a previous pull's `nextCursor`.
 * @param options.env    Override for process.env (useful in tests).
 */
export async function pullXInboundDms(options: {
  limit?: number;
  cursor?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<XDmPullResult> {
  const syncedAt = new Date().toISOString();
  const credentials = readXDmCredentialsFromEnv(options.env ?? process.env);

  if (!credentials) {
    return {
      inbound: [],
      all: [],
      nextCursor: null,
      syncedAt,
      hasCredentials: false,
    };
  }

  const readOptions: XReadPageOptions = {
    limit: options.limit,
    cursor: options.cursor,
  };

  let page: Awaited<ReturnType<typeof readXDms>>;
  try {
    page = await readXDms(credentials, readOptions);
  } catch (error) {
    if (error instanceof XReadError) {
      logger.warn(
        {
          boundary: "lifeops",
          integration: "x_dm",
          operation: "x_dm_pull",
          category: error.category,
          status: error.status,
          retryAfterSeconds: error.retryAfterSeconds,
        },
        `[lifeops] X DM pull failed (${error.category}): ${error.message}`,
      );
      // Rate-limit and auth errors are not retriable here; return empty.
      if (error.category === "rate_limit" || error.category === "auth") {
        return {
          inbound: [],
          all: [],
          nextCursor: null,
          syncedAt,
          hasCredentials: true,
        };
      }
    }
    throw error;
  }

  const all = page.items.map((raw) => rawDmToXInboundDm(raw, syncedAt));
  const inbound = all.filter((dm) => dm.isInbound);

  return {
    inbound,
    all,
    nextCursor: page.nextCursor,
    syncedAt,
    hasCredentials: true,
  };
}
