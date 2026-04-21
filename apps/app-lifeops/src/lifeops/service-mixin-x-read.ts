// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
  LifeOpsXSyncState,
} from "@elizaos/shared/contracts/lifeops";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import { readXPosterCredentialsFromEnv } from "./x-poster.js";
import {
  pullXFeed,
  readXDms,
  searchX,
  XReadError,
  type XRawDm,
  type XRawFeedItem,
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
  return {
    apiKey: posterCreds.apiKey,
    apiSecret: posterCreds.apiSecretKey,
    accessToken: posterCreds.accessToken,
    accessTokenSecret: posterCreds.accessTokenSecret,
    userId: userId.length > 0 ? userId : undefined,
  };
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

function translateXReadError(
  operation: string,
  error: unknown,
): never {
  if (error instanceof XReadError) {
    const status =
      error.category === "auth"
        ? 409
        : error.category === "not_found"
          ? 404
          : error.category === "rate_limit"
            ? 429
            : error.status ?? 502;
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
export function withXRead<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsXReadServiceMixin extends Base {
    async syncXDms(opts: XReadOpts = {}): Promise<{ synced: number }> {
      const credentials = toReaderCredentials();
      if (!credentials) {
        const cached = await this.repository.listXDms(this.agentId(), { limit: 1 });
        if (cached.length > 0) {
          return { synced: 0 };
        }
        fail(409, "X credentials are not configured.");
      }
      const grant = await this.resolveXGrant();
      if (!grant) {
        fail(409, "X is not connected.");
      }
      let page;
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
      await this.repository.upsertXSyncState({
        id: `${this.agentId()}:x:dms`,
        agentId: this.agentId(),
        feedType: "home_timeline",
        lastCursor: page.nextCursor,
        syncedAt,
        updatedAt: syncedAt,
      });
      return { synced: page.items.length };
    }

    async syncXFeed(
      feedType: LifeOpsXFeedType,
      opts: XFeedReadOpts = {},
    ): Promise<{ synced: number }> {
      const credentials = toReaderCredentials();
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
      const grant = await this.resolveXGrant();
      if (!grant) {
        fail(409, "X is not connected.");
      }
      let page;
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
      const grant = await this.resolveXGrant();
      if (!grant) {
        fail(409, "X is not connected.");
      }
      let page;
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

    async getXDms(opts: { conversationId?: string; limit?: number } = {}): Promise<LifeOpsXDm[]> {
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
