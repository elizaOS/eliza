import { type IAgentRuntime, logger } from "@elizaos/core";
import type { TwitterService } from "../services/twitter.service.js";

/**
 * Structured tweet shape returned by the X feed actions. Kept intentionally
 * thin — only the fields the agent / ranker / summarizer need.
 */
export interface XFeedTweet {
  id: string;
  authorId: string | null;
  username: string | null;
  text: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  createdAt: string | null;
}

export interface XDirectMessage {
  id: string;
  senderId: string;
  senderUsername: string | null;
  text: string;
  createdAt: string | null;
  read: boolean;
}

export interface TwitterNotConfiguredResult {
  success: false;
  reason: "twitter-not-configured";
  text: string;
}

export interface RateLimitedResult {
  success: false;
  reason: "rate-limited";
  retryAfterSeconds: number | null;
  text: string;
}

export interface ConfirmationRequiredResult {
  success: false;
  requiresConfirmation: true;
  preview: string;
  text: string;
}

export function makeNotConfigured(
  actionName: string,
): TwitterNotConfiguredResult {
  logger.warn(
    { action: actionName, reason: "twitter-not-configured" },
    `[${actionName}] Twitter service not registered — returning explicit absence result`,
  );
  return {
    success: false,
    reason: "twitter-not-configured",
    text: "Twitter/X is not configured on this agent. Install @elizaos/plugin-twitter and provide TWITTER_API_KEY, TWITTER_API_SECRET_KEY, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET.",
  };
}

export function makeRateLimited(
  actionName: string,
  retryAfterSeconds: number | null,
): RateLimitedResult {
  const hint =
    retryAfterSeconds !== null
      ? ` Try again in ${retryAfterSeconds} seconds.`
      : " Please retry later.";
  logger.warn(
    { action: actionName, retryAfterSeconds },
    `[${actionName}] Twitter API rate limit (429)`,
  );
  return {
    success: false,
    reason: "rate-limited",
    retryAfterSeconds,
    text: `Twitter/X rate limit reached.${hint}`,
  };
}

/**
 * Detect Twitter API rate-limit errors across the various shapes the v2 client
 * throws (ApiResponseError, plain Error with status, fetch Response-like).
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: number;
    status?: number;
    statusCode?: number;
    rateLimitError?: boolean;
    message?: string;
  };
  if (e.rateLimitError === true) return true;
  if (e.code === 429 || e.status === 429 || e.statusCode === 429) return true;
  if (typeof e.message === "string" && /\b429\b|rate.?limit/i.test(e.message)) {
    return true;
  }
  return false;
}

export function extractRetryAfterSeconds(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    rateLimit?: { reset?: number };
    headers?: Record<string, string | string[] | undefined>;
  };
  if (e.rateLimit?.reset && typeof e.rateLimit.reset === "number") {
    const delta = e.rateLimit.reset - Math.floor(Date.now() / 1000);
    return delta > 0 ? delta : 0;
  }
  const ra = e.headers?.["retry-after"];
  const raValue = Array.isArray(ra) ? ra[0] : ra;
  if (typeof raValue === "string") {
    const parsed = Number.parseInt(raValue, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function getTwitterService(
  runtime: IAgentRuntime,
): TwitterService | null {
  const service = runtime.getService("twitter");
  return (service as TwitterService | null | undefined) ?? null;
}

/**
 * Rank feed tweets by `likes + retweets * 2` and return the top-N.
 * Pure function — exported for unit tests.
 */
export function rankFeedTweets(
  tweets: XFeedTweet[],
  limit: number,
): XFeedTweet[] {
  const score = (t: XFeedTweet): number => t.likeCount + t.retweetCount * 2;
  return [...tweets]
    .sort((a, b) => score(b) - score(a))
    .slice(0, Math.max(0, limit));
}

export function readBooleanOption(
  options: Record<string, unknown> | undefined,
  key: string,
): boolean {
  if (!options) return false;
  const raw = options[key];
  return raw === true || raw === "true";
}

export function readStringOption(
  options: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!options) return null;
  const raw = options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export function readNumberOption(
  options: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (!options) return null;
  const raw = options[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
