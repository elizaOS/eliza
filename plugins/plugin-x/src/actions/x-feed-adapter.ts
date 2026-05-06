import { type IAgentRuntime, logger } from "@elizaos/core";
import type { XService } from "../services/x.service.js";
import type { XDirectMessage, XFeedTweet } from "./x-feed-helpers.js";
import { getTwitterService } from "./x-feed-helpers.js";

async function logSdkCall<T>(
  op: string,
  context: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logger.debug(
    { sdk: "twitter-api-v2", op, ...context },
    `[RealXFeedAdapter] ${op} started`,
  );
  try {
    const result = await fn();
    logger.info(
      {
        sdk: "twitter-api-v2",
        op,
        ...context,
        durationMs: Date.now() - startedAt,
      },
      `[RealXFeedAdapter] ${op} ok`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      {
        sdk: "twitter-api-v2",
        op,
        ...context,
        durationMs: Date.now() - startedAt,
        error: message,
      },
      `[RealXFeedAdapter] ${op} failed`,
    );
    throw error;
  }
}

/**
 * Minimal boundary over the TwitterService / plugin-twitter client for the
 * X feed / search / DM actions. Implementations may come from the real
 * plugin-twitter service or a test fake registered on the runtime.
 *
 * The runtime lookup keys are:
 *  - service type "twitter"            → real TwitterService instance
 *  - service type "x-feed-adapter"     → override used by tests
 */
export interface XFeedAdapter {
  fetchHomeTimeline(count: number): Promise<XFeedTweet[]>;
  searchRecent(query: string, maxResults: number): Promise<XFeedTweet[]>;
  listDirectMessages(options: {
    onlyUnread: boolean;
    limit: number;
  }): Promise<XDirectMessage[]>;
  sendDirectMessage(args: {
    recipient: string;
    text: string;
  }): Promise<{ id: string }>;
  createTweet(args: { text: string }): Promise<{ id: string }>;
}

export const X_FEED_ADAPTER_SERVICE_TYPE = "x-feed-adapter";

function tweetFromV2(
  tweet: {
    id?: string;
    text?: string;
    author_id?: string;
    created_at?: string;
    public_metrics?: {
      like_count?: number;
      retweet_count?: number;
      reply_count?: number;
    };
  },
  usernameByAuthorId: Map<string, string>,
): XFeedTweet {
  const authorId = tweet.author_id ?? null;
  return {
    id: tweet.id ?? "",
    authorId,
    username: authorId ? (usernameByAuthorId.get(authorId) ?? null) : null,
    text: tweet.text ?? "",
    likeCount: tweet.public_metrics?.like_count ?? 0,
    retweetCount: tweet.public_metrics?.retweet_count ?? 0,
    replyCount: tweet.public_metrics?.reply_count ?? 0,
    createdAt: tweet.created_at ?? null,
  };
}

function buildUsernameMap(
  includes: { users?: Array<{ id: string; username?: string }> } | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const user of includes?.users ?? []) {
    if (user.id && user.username) map.set(user.id, user.username);
  }
  return map;
}

/**
 * Adapter backed by the real TwitterService. Uses the underlying twitter-api-v2
 * client directly for fields we need (public_metrics, author context).
 */
export class RealXFeedAdapter implements XFeedAdapter {
  constructor(private readonly service: XService) {}

  private async v2Client() {
    const base = this.service.twitterClient?.client;
    if (!base) throw new Error("Twitter base client not initialized");
    // Access via the auth provider used by the base client.
    const auth = (
      base as unknown as { auth: { getV2Client: () => Promise<unknown> } }
    ).auth;
    if (!auth) throw new Error("Twitter auth not initialized");
    return auth.getV2Client() as Promise<{
      v2: {
        homeTimeline: (
          opts: Record<string, unknown>,
        ) => AsyncIterable<unknown> & {
          includes?: { users?: Array<{ id: string; username?: string }> };
        };
        search: (
          query: string,
          opts: Record<string, unknown>,
        ) => AsyncIterable<unknown> & {
          includes?: { users?: Array<{ id: string; username?: string }> };
        };
        tweet: (text: string) => Promise<{ data: { id: string } }>;
      };
      v1: unknown;
      currentUserV2: () => Promise<{ data: { id: string } }>;
    }>;
  }

  async fetchHomeTimeline(count: number): Promise<XFeedTweet[]> {
    const max = Math.min(Math.max(1, count), 100);
    return logSdkCall("homeTimeline", { max }, async () => {
      const client = await this.v2Client();
      const iter = client.v2.homeTimeline({
        max_results: max,
        "tweet.fields": [
          "id",
          "text",
          "created_at",
          "author_id",
          "public_metrics",
        ],
        "user.fields": ["id", "username", "name"],
        expansions: ["author_id"],
      });
      const tweets: XFeedTweet[] = [];
      const usernameMap = buildUsernameMap(iter.includes);
      for await (const raw of iter) {
        tweets.push(
          tweetFromV2(raw as Parameters<typeof tweetFromV2>[0], usernameMap),
        );
        if (tweets.length >= max) break;
      }
      return tweets;
    });
  }

  async searchRecent(query: string, maxResults: number): Promise<XFeedTweet[]> {
    const max = Math.min(Math.max(1, maxResults), 100);
    return logSdkCall(
      "searchRecent",
      { max, queryLen: query.length },
      async () => {
        const client = await this.v2Client();
        const iter = client.v2.search(query, {
          max_results: max,
          "tweet.fields": [
            "id",
            "text",
            "created_at",
            "author_id",
            "public_metrics",
          ],
          "user.fields": ["id", "username", "name"],
          expansions: ["author_id"],
        });
        const tweets: XFeedTweet[] = [];
        const usernameMap = buildUsernameMap(iter.includes);
        for await (const raw of iter) {
          tweets.push(
            tweetFromV2(raw as Parameters<typeof tweetFromV2>[0], usernameMap),
          );
          if (tweets.length >= max) break;
        }
        return tweets;
      },
    );
  }

  async listDirectMessages(_options: {
    onlyUnread: boolean;
    limit: number;
  }): Promise<XDirectMessage[]> {
    return logSdkCall(
      "listDmEvents",
      { limit: _options.limit, onlyUnread: _options.onlyUnread },
      async () => {
        // X API v2 exposes DM lookup via /2/dm_events. Broker / OAuth2 scopes
        // determine availability. We surface whatever the v2 client exposes.
        const client = (await this.v2Client()) as unknown as {
          v2: {
            listDmEvents?: (opts: Record<string, unknown>) => AsyncIterable<{
              id?: string;
              sender_id?: string;
              text?: string;
              created_at?: string;
              event_type?: string;
            }> & {
              includes?: { users?: Array<{ id: string; username?: string }> };
            };
          };
        };
        const iter = client.v2.listDmEvents?.({
          max_results: Math.min(Math.max(1, _options.limit), 50),
          "dm_event.fields": [
            "id",
            "created_at",
            "sender_id",
            "text",
            "event_type",
          ],
          "user.fields": ["id", "username"],
          expansions: ["sender_id"],
          event_types: ["MessageCreate"],
        });
        if (!iter) {
          throw new Error(
            "Twitter v2 client does not expose listDmEvents - DM reads require the twitter-api-v2 DM module.",
          );
        }
        const usernameMap = buildUsernameMap(iter.includes);
        const messages: XDirectMessage[] = [];
        for await (const event of iter) {
          if (event.event_type && event.event_type !== "MessageCreate")
            continue;
          messages.push({
            id: event.id ?? "",
            senderId: event.sender_id ?? "",
            senderUsername: event.sender_id
              ? (usernameMap.get(event.sender_id) ?? null)
              : null,
            text: event.text ?? "",
            createdAt: event.created_at ?? null,
            read: false,
          });
          if (messages.length >= _options.limit) break;
        }
        return messages;
      },
    );
  }

  async sendDirectMessage(args: {
    recipient: string;
    text: string;
  }): Promise<{ id: string }> {
    return logSdkCall(
      "sendDmToParticipant",
      { recipient: args.recipient, textLen: args.text.length },
      async () => {
        const client = (await this.v2Client()) as unknown as {
          v2: {
            sendDmToParticipant?: (
              participantId: string,
              body: { text: string },
            ) => Promise<{ data: { dm_event_id: string } }>;
          };
        };
        if (!client.v2.sendDmToParticipant) {
          throw new Error(
            "Twitter v2 client does not expose sendDmToParticipant - DM send requires the twitter-api-v2 DM module.",
          );
        }
        const result = await client.v2.sendDmToParticipant(args.recipient, {
          text: args.text,
        });
        return { id: result.data.dm_event_id };
      },
    );
  }

  async createTweet(args: { text: string }): Promise<{ id: string }> {
    return logSdkCall("tweet", { textLen: args.text.length }, async () => {
      const client = await this.v2Client();
      const result = await client.v2.tweet(args.text);
      return { id: result.data.id };
    });
  }
}

/**
 * Resolve the adapter for the given runtime:
 *  - if a test registered an override adapter under "x-feed-adapter", use it
 *  - else wrap the real TwitterService if available
 *  - else return null (caller surfaces twitter-not-configured)
 */
export function resolveXFeedAdapter(
  runtime: IAgentRuntime,
): XFeedAdapter | null {
  const override = runtime.getService(X_FEED_ADAPTER_SERVICE_TYPE);
  if (override && isXFeedAdapterLike(override)) {
    return override;
  }
  const service = getTwitterService(runtime);
  if (!service?.twitterClient) return null;
  return new RealXFeedAdapter(service);
}

function isXFeedAdapterLike(value: unknown): value is XFeedAdapter {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.fetchHomeTimeline === "function" &&
    typeof v.searchRecent === "function" &&
    typeof v.listDirectMessages === "function" &&
    typeof v.sendDirectMessage === "function" &&
    typeof v.createTweet === "function"
  );
}
