import crypto from "node:crypto";
import { logger } from "@elizaos/core";

/**
 * Read-side credentials for the X/Twitter API v2. Mirrors the shape used by
 * {@link ./x-poster.ts} but accepts the canonical `apiSecret` naming; both
 * `apiSecret` and `apiSecretKey` (the poster's name) are accepted via the
 * helper below so a caller can pass either without adaptation.
 */
export interface XReaderCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  userId?: string;
}

export interface XReadPageOptions {
  limit?: number;
  cursor?: string;
}

export interface XFeedPageOptions extends XReadPageOptions {
  query?: string;
}

export type XFeedType = "home_timeline" | "mentions" | "search";

export interface XRawDm {
  id: string;
  conversationId: string;
  senderId: string;
  senderHandle: string;
  text: string;
  createdAt: string;
  isInbound: boolean;
  metadata: Record<string, unknown>;
}

export interface XRawFeedItem {
  id: string;
  authorId: string;
  authorHandle: string;
  text: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface XReadPage<T> {
  items: T[];
  nextCursor: string | null;
}

export class XReadError extends Error {
  readonly status: number | null;
  readonly category: "auth" | "not_found" | "rate_limit" | "network" | "unknown";
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      status: number | null;
      category: XReadError["category"];
      retryAfterSeconds?: number | null;
    },
  ) {
    super(message);
    this.name = "XReadError";
    this.status = options.status;
    this.category = options.category;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 12_000;

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildSignatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sorted)}`;
}

function buildSigningKey(apiSecret: string, tokenSecret: string): string {
  return `${percentEncode(apiSecret)}&${percentEncode(tokenSecret)}`;
}

function signOAuth1(baseString: string, signingKey: string): string {
  return crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
}

/**
 * Build an OAuth 1.0a `Authorization` header for a GET request, merging any
 * query parameters into the signature base string (required by Twitter).
 */
function buildOAuth1GetHeader(args: {
  url: string;
  queryParams: Record<string, string>;
  credentials: XReaderCredentials;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: args.credentials.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: args.credentials.accessToken,
    oauth_version: "1.0",
  };
  const combined: Record<string, string> = { ...args.queryParams, ...oauthParams };
  const baseString = buildSignatureBaseString("GET", args.url, combined);
  const signingKey = buildSigningKey(
    args.credentials.apiSecret,
    args.credentials.accessTokenSecret,
  );
  oauthParams.oauth_signature = signOAuth1(baseString, signingKey);

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
      .join(", ")
  );
}

function categorizeStatus(status: number): XReadError["category"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  return "unknown";
}

function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(value));
}

type TwitterUser = {
  id?: string;
  username?: string;
};

type TwitterApiResponse<T> = {
  data?: T;
  includes?: { users?: TwitterUser[] };
  meta?: {
    next_token?: string;
    pagination_token?: string;
    result_count?: number;
  };
  errors?: Array<{ detail?: string; message?: string; title?: string }>;
  title?: string;
  detail?: string;
};

async function xFetch<T>(args: {
  url: string;
  queryParams: Record<string, string>;
  credentials: XReaderCredentials;
  operation: string;
}): Promise<TwitterApiResponse<T>> {
  const query = new URLSearchParams(args.queryParams).toString();
  const fullUrl = query.length > 0 ? `${args.url}?${query}` : args.url;
  const authorization = buildOAuth1GetHeader({
    url: args.url,
    queryParams: args.queryParams,
    credentials: args.credentials,
  });

  let response: Response;
  try {
    response = await fetch(fullUrl, {
      method: "GET",
      headers: {
        Authorization: authorization,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      {
        boundary: "lifeops",
        integration: "x",
        operation: args.operation,
      },
      `[lifeops] X read network failure: ${message}`,
    );
    throw new XReadError(message, { status: null, category: "network" });
  }

  const payload = (await response.json().catch(() => ({}))) as TwitterApiResponse<T>;

  if (!response.ok) {
    const category = categorizeStatus(response.status);
    const errorMessage =
      payload.errors?.[0]?.detail ??
      payload.errors?.[0]?.message ??
      payload.errors?.[0]?.title ??
      payload.detail ??
      payload.title ??
      `HTTP ${response.status}`;
    const retryAfterSeconds =
      category === "rate_limit" ? parseRetryAfter(response.headers) : null;
    throw new XReadError(errorMessage, {
      status: response.status,
      category,
      retryAfterSeconds,
    });
  }

  return payload;
}

function buildHandleIndex(users: readonly TwitterUser[] | undefined): Map<string, string> {
  const index = new Map<string, string>();
  for (const user of users ?? []) {
    if (user.id && user.username) {
      index.set(user.id, user.username);
    }
  }
  return index;
}

type TwitterDmEvent = {
  id: string;
  event_type?: string;
  text?: string;
  sender_id?: string;
  dm_conversation_id?: string;
  created_at?: string;
};

type TwitterTweet = {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
};

function parseDmEvent(
  event: TwitterDmEvent,
  selfUserId: string | undefined,
  handleIndex: Map<string, string>,
): XRawDm | null {
  if (event.event_type && event.event_type !== "MessageCreate") return null;
  const senderId = event.sender_id ?? "";
  const handle = handleIndex.get(senderId) ?? "";
  return {
    id: event.id,
    conversationId: event.dm_conversation_id ?? "",
    senderId,
    senderHandle: handle,
    text: event.text ?? "",
    createdAt: event.created_at ?? new Date().toISOString(),
    isInbound: selfUserId ? senderId !== selfUserId : true,
    metadata: { raw: event satisfies TwitterDmEvent },
  };
}

function parseTweet(
  tweet: TwitterTweet,
  handleIndex: Map<string, string>,
): XRawFeedItem {
  const authorId = tweet.author_id ?? "";
  return {
    id: tweet.id,
    authorId,
    authorHandle: handleIndex.get(authorId) ?? "",
    text: tweet.text ?? "",
    createdAt: tweet.created_at ?? new Date().toISOString(),
    metadata: { raw: tweet satisfies TwitterTweet },
  };
}

/**
 * Read DM events for the authenticated user via Twitter API v2.
 * Returns raw DM objects and a forward pagination cursor.
 */
export async function readXDms(
  credentials: XReaderCredentials,
  options: XReadPageOptions = {},
): Promise<XReadPage<XRawDm>> {
  const limit = clampLimit(options.limit);
  const url = "https://api.twitter.com/2/dm_events";
  const queryParams: Record<string, string> = {
    max_results: String(limit),
    "dm_event.fields": "id,event_type,text,sender_id,dm_conversation_id,created_at",
    expansions: "sender_id",
    "user.fields": "username",
  };
  if (options.cursor) queryParams.pagination_token = options.cursor;

  const payload = await xFetch<TwitterDmEvent[]>({
    url,
    queryParams,
    credentials,
    operation: "x_read_dms",
  });

  const handleIndex = buildHandleIndex(payload.includes?.users);
  const events = Array.isArray(payload.data) ? payload.data : [];
  const items: XRawDm[] = [];
  for (const event of events) {
    const parsed = parseDmEvent(event, credentials.userId, handleIndex);
    if (parsed) items.push(parsed);
  }
  return {
    items,
    nextCursor: payload.meta?.next_token ?? payload.meta?.pagination_token ?? null,
  };
}

/**
 * Read the authenticated user's feed (home timeline, mentions, or recent search).
 */
export async function pullXFeed(
  credentials: XReaderCredentials,
  feedType: XFeedType,
  options: XFeedPageOptions = {},
): Promise<XReadPage<XRawFeedItem>> {
  const limit = clampLimit(options.limit);
  const baseQuery: Record<string, string> = {
    max_results: String(limit),
    "tweet.fields": "id,text,author_id,created_at,conversation_id,referenced_tweets",
    expansions: "author_id",
    "user.fields": "username",
  };
  if (options.cursor) baseQuery.pagination_token = options.cursor;

  let url: string;
  if (feedType === "home_timeline") {
    if (!credentials.userId) {
      throw new XReadError("home_timeline requires credentials.userId", {
        status: null,
        category: "unknown",
      });
    }
    url = `https://api.twitter.com/2/users/${encodeURIComponent(credentials.userId)}/timelines/reverse_chronological`;
  } else if (feedType === "mentions") {
    if (!credentials.userId) {
      throw new XReadError("mentions requires credentials.userId", {
        status: null,
        category: "unknown",
      });
    }
    url = `https://api.twitter.com/2/users/${encodeURIComponent(credentials.userId)}/mentions`;
  } else {
    const query = (options.query ?? "").trim();
    if (query.length === 0) {
      throw new XReadError("search requires a non-empty query", {
        status: null,
        category: "unknown",
      });
    }
    url = "https://api.twitter.com/2/tweets/search/recent";
    baseQuery.query = query;
  }

  const payload = await xFetch<TwitterTweet[]>({
    url,
    queryParams: baseQuery,
    credentials,
    operation: `x_read_feed_${feedType}`,
  });

  const handleIndex = buildHandleIndex(payload.includes?.users);
  const tweets = Array.isArray(payload.data) ? payload.data : [];
  const items = tweets.map((tweet) => parseTweet(tweet, handleIndex));

  return {
    items,
    nextCursor: payload.meta?.next_token ?? null,
  };
}

/**
 * Alias for {@link pullXFeed} with `feedType: "search"`.
 */
export function searchX(
  credentials: XReaderCredentials,
  query: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<XReadPage<XRawFeedItem>> {
  return pullXFeed(credentials, "search", { ...options, query });
}
