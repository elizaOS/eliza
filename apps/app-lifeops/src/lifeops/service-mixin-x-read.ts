// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/shared";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import { readXPosterCredentialsFromEnv } from "./x-poster.js";
import {
  pullXFeed,
  readXDms,
  searchX,
  type XRawDm,
  type XRawFeedItem,
  XReadError,
  type XReaderCredentials,
} from "./x-reader.js";

type XReadOpts = {
  limit?: number;
};

type XFeedReadOpts = XReadOpts & {
  query?: string;
};

function toReaderCredentials(): XReaderCredentials | null {
  const posterCreds = readXPosterCredentialsFromEnv();
  if (!posterCreds) return null;
  const userId = (process.env.TWITTER_USER_ID ?? "").trim();
  if (userId.length === 0) return null;
  return {
    apiKey: posterCreds.apiKey,
    apiSecret: posterCreds.apiSecretKey,
    accessToken: posterCreds.accessToken,
    accessTokenSecret: posterCreds.accessTokenSecret,
    userId,
  };
}

type OptionalXGrantResolver = {
  resolveXGrant?: () => Promise<LifeOpsConnectorGrant | null>;
};

async function resolveOptionalXGrant(
  service: OptionalXGrantResolver,
): Promise<LifeOpsConnectorGrant | null> {
  if (typeof service.resolveXGrant !== "function") {
    return null;
  }
  return service.resolveXGrant();
}

function rawDmToLifeOpsXDm(args: {
  agentId: string;
  raw: XRawDm;
  syncedAt: string;
}): LifeOpsXDm {
  return {
    id: crypto.randomUUID(),
    agentId: args.agentId,
    externalDmId: args.raw.id,
    conversationId: args.raw.conversationId,
    senderHandle: args.raw.senderHandle,
    senderId: args.raw.senderId,
    isInbound: args.raw.isInbound,
    text: args.raw.text,
    receivedAt: args.raw.createdAt,
    readAt: null,
    repliedAt: null,
    metadata: args.raw.metadata,
    syncedAt: args.syncedAt,
    updatedAt: args.syncedAt,
  };
}

function rawFeedItemToLifeOpsXFeedItem(args: {
  agentId: string;
  feedType: LifeOpsXFeedType;
  raw: XRawFeedItem;
  syncedAt: string;
}): LifeOpsXFeedItem {
  return {
    id: crypto.randomUUID(),
    agentId: args.agentId,
    externalTweetId: args.raw.id,
    authorHandle: args.raw.authorHandle,
    authorId: args.raw.authorId,
    text: args.raw.text,
    createdAtSource: args.raw.createdAt,
    feedType: args.feedType,
    metadata: args.raw.metadata,
    syncedAt: args.syncedAt,
    updatedAt: args.syncedAt,
  };
}

function managedFeedItemToLifeOpsXFeedItem(args: {
  agentId: string;
  feedType: LifeOpsXFeedType;
  item: {
    id: string;
    authorHandle: string;
    authorId: string;
    text: string;
    createdAt: string | null;
    conversationId: string | null;
    referencedTweets: Array<{ type: string; id: string }>;
    publicMetrics: Record<string, unknown> | null;
    entities: Record<string, unknown> | null;
  };
  syncedAt: string;
}): LifeOpsXFeedItem {
  return {
    id: `${args.agentId}:x-feed:${args.feedType}:${args.item.id}`,
    agentId: args.agentId,
    externalTweetId: args.item.id,
    authorHandle: args.item.authorHandle,
    authorId: args.item.authorId,
    text: args.item.text,
    createdAtSource: args.item.createdAt ?? args.syncedAt,
    feedType: args.feedType,
    metadata: {
      raw: {
        id: args.item.id,
        text: args.item.text,
        author_id: args.item.authorId,
        created_at: args.item.createdAt,
        conversation_id: args.item.conversationId,
        referenced_tweets: args.item.referencedTweets,
        public_metrics: args.item.publicMetrics,
        entities: args.item.entities,
      },
      source: "cloud",
    },
    syncedAt: args.syncedAt,
    updatedAt: args.syncedAt,
  };
}

function translateXReadError(operation: string, error: unknown): never {
  if (error instanceof XReadError) {
    const status =
      error.category === "auth"
        ? 409
        : error.category === "not_found"
          ? 404
          : error.category === "rate_limit"
            ? 429
            : (error.status ?? 502);
    const message =
      error.category === "rate_limit" && error.retryAfterSeconds
        ? `${error.message} (retry after ${error.retryAfterSeconds}s)`
        : error.message;
    fail(status, `[${operation}] ${message}`);
  }
  throw error;
}

function matchesCachedXSearchQuery(
  item: LifeOpsXFeedItem,
  query: string,
): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return false;
  }
  const haystack = [
    item.authorHandle ?? "",
    item.authorId ?? "",
    item.text,
    JSON.stringify(item.metadata ?? {}),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function dedupeCachedSearchResults(
  items: LifeOpsXFeedItem[],
): LifeOpsXFeedItem[] {
  const seen = new Set<string>();
  const unique: LifeOpsXFeedItem[] = [];
  for (const item of items) {
    if (seen.has(item.externalTweetId)) {
      continue;
    }
    seen.add(item.externalTweetId);
    unique.push(item);
  }
  return unique;
}

/** @internal */
export function withXRead<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsXReadServiceMixin extends Base {
    async syncXDms(opts: XReadOpts = {}): Promise<{ synced: number }> {
      const credentials = toReaderCredentials();
      const grant = await resolveOptionalXGrant(this);
      if (grant?.mode === "cloud_managed") {
        const digest = await this.xManagedClient.getDmDigest({
          side: grant.side,
          maxResults: opts.limit,
        });
        const syncedAt = digest.syncedAt;
        for (const message of digest.messages) {
          await this.repository.upsertXDm({
            id: `${this.agentId()}:x:${message.id}`,
            agentId: this.agentId(),
            externalDmId: message.id,
            conversationId: message.conversationId,
            senderHandle: "",
            senderId: message.senderId,
            isInbound: message.direction === "received",
            text: message.text,
            receivedAt: message.createdAt ?? syncedAt,
            readAt: null,
            repliedAt: null,
            metadata: {
              participantId: message.participantId,
              participantIds: message.participantIds,
              recipientId: message.recipientId,
              entities: message.entities,
              hasAttachment: message.hasAttachment,
              source: "cloud",
            },
            syncedAt,
            updatedAt: syncedAt,
          });
        }
        return { synced: digest.messages.length };
      }
      if (!credentials) {
        const cached = await this.repository.listXDms(this.agentId(), {
          limit: 1,
        });
        if (cached.length > 0) {
          return { synced: 0 };
        }
        fail(409, "X credentials are not configured.");
      }
      let page: Awaited<ReturnType<typeof readXDms>>;
      try {
        page = await readXDms(credentials, { limit: opts.limit });
      } catch (error) {
        translateXReadError("x_read_dms", error);
      }
      const syncedAt = new Date().toISOString();
      for (const raw of page.items) {
        await this.repository.upsertXDm(
          rawDmToLifeOpsXDm({
            agentId: this.agentId(),
            raw,
            syncedAt,
          }),
        );
      }
      return { synced: page.items.length };
    }

    async syncXFeed(
      feedType: LifeOpsXFeedType,
      opts: XFeedReadOpts = {},
    ): Promise<{ synced: number }> {
      const credentials = toReaderCredentials();
      const grant = await resolveOptionalXGrant(this);
      if (grant?.mode === "cloud_managed") {
        const feed = await this.xManagedClient.getFeed({
          side: grant.side,
          feedType,
          query: opts.query,
          maxResults: opts.limit,
        });
        for (const item of feed.items) {
          await this.repository.upsertXFeedItem(
            managedFeedItemToLifeOpsXFeedItem({
              agentId: this.agentId(),
              feedType: feed.feedType,
              item,
              syncedAt: feed.syncedAt,
            }),
          );
        }
        await this.repository.upsertXSyncState({
          id: `${this.agentId()}:x:${feedType}`,
          agentId: this.agentId(),
          feedType,
          lastCursor: null,
          syncedAt: feed.syncedAt,
          updatedAt: feed.syncedAt,
        });
        return { synced: feed.items.length };
      }
      if (!credentials) {
        const cached = await this.repository.listXFeedItems(
          this.agentId(),
          feedType,
          { limit: 1 },
        );
        if (cached.length > 0) {
          return { synced: 0 };
        }
        fail(409, "X credentials are not configured.");
      }
      let page: Awaited<ReturnType<typeof pullXFeed>>;
      try {
        page = await pullXFeed(credentials, feedType, {
          limit: opts.limit,
          query: opts.query,
        });
      } catch (error) {
        translateXReadError(`x_read_feed_${feedType}`, error);
      }
      const syncedAt = new Date().toISOString();
      for (const raw of page.items) {
        await this.repository.upsertXFeedItem(
          rawFeedItemToLifeOpsXFeedItem({
            agentId: this.agentId(),
            feedType,
            raw,
            syncedAt,
          }),
        );
      }
      await this.repository.upsertXSyncState({
        id: `${this.agentId()}:x:${feedType}`,
        agentId: this.agentId(),
        feedType,
        lastCursor: page.nextCursor,
        syncedAt,
        updatedAt: syncedAt,
      });
      return { synced: page.items.length };
    }

    async searchXPosts(
      query: string,
      opts: XReadOpts = {},
    ): Promise<LifeOpsXFeedItem[]> {
      const trimmed = (query ?? "").trim();
      if (trimmed.length === 0) {
        fail(400, "searchXPosts requires a non-empty query.");
      }
      const credentials = toReaderCredentials();
      const grant = await resolveOptionalXGrant(this);
      if (grant?.mode === "cloud_managed") {
        const feed = await this.xManagedClient.getFeed({
          side: grant.side,
          feedType: "search",
          query: trimmed,
          maxResults: opts.limit,
        });
        const items: LifeOpsXFeedItem[] = [];
        for (const item of feed.items) {
          const normalized = managedFeedItemToLifeOpsXFeedItem({
            agentId: this.agentId(),
            feedType: "search",
            item,
            syncedAt: feed.syncedAt,
          });
          await this.repository.upsertXFeedItem(normalized);
          items.push(normalized);
        }
        return items;
      }
      if (!credentials) {
        const searchLimit = Math.max(opts.limit ?? 20, 20);
        const cached = dedupeCachedSearchResults([
          ...(await this.repository.listXFeedItems(this.agentId(), "search", {
            limit: searchLimit,
          })),
          ...(await this.repository.listXFeedItems(
            this.agentId(),
            "home_timeline",
            {
              limit: searchLimit,
            },
          )),
          ...(await this.repository.listXFeedItems(this.agentId(), "mentions", {
            limit: searchLimit,
          })),
        ]).filter((item) => matchesCachedXSearchQuery(item, trimmed));
        if (cached.length > 0) {
          return cached.slice(0, opts.limit ?? cached.length);
        }
        fail(409, "X credentials are not configured.");
      }
      let page: Awaited<ReturnType<typeof searchX>>;
      try {
        page = await searchX(credentials, trimmed, { limit: opts.limit });
      } catch (error) {
        translateXReadError("x_search", error);
      }
      const syncedAt = new Date().toISOString();
      const items: LifeOpsXFeedItem[] = [];
      for (const raw of page.items) {
        const item = rawFeedItemToLifeOpsXFeedItem({
          agentId: this.agentId(),
          feedType: "search",
          raw,
          syncedAt,
        });
        await this.repository.upsertXFeedItem(item);
        items.push(item);
      }
      return items;
    }

    async getXDms(
      opts: { conversationId?: string; limit?: number } = {},
    ): Promise<LifeOpsXDm[]> {
      return this.repository.listXDms(this.agentId(), opts);
    }

    async getXFeedItems(
      feedType: LifeOpsXFeedType,
      opts: { limit?: number } = {},
    ): Promise<LifeOpsXFeedItem[]> {
      return this.repository.listXFeedItems(this.agentId(), feedType, opts);
    }

    /**
     * Pull and return only inbound X DMs (messages the authenticated user received,
     * not sent). Performs a live sync against the X API, persists the results, and
     * then returns the inbound subset from the local store.
     *
     * Callers that want the full conversation including outbound messages should
     * call `syncXDms()` followed by `getXDms()` directly.
     */
    async readXInboundDms(
      opts: { limit?: number } = {},
    ): Promise<LifeOpsXDm[]> {
      await this.syncXDms(opts);
      const all = await this.repository.listXDms(this.agentId(), opts);
      return all.filter((dm) => dm.isInbound);
    }
  }

  return LifeOpsXReadServiceMixin;
}
