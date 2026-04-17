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

/** @internal */
export function withXRead<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsXReadServiceMixin extends Base {
    async syncXDms(opts: XReadOpts = {}): Promise<{ synced: number }> {
      // Ensures the X connector has been configured.
      await this.requireXGrant();
      const credentials = toReaderCredentials();
      if (!credentials) {
        fail(409, "X credentials are not configured.");
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
      await this.requireXGrant();
      const credentials = toReaderCredentials();
      if (!credentials) {
        fail(409, "X credentials are not configured.");
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
      await this.requireXGrant();
      const credentials = toReaderCredentials();
      if (!credentials) {
        fail(409, "X credentials are not configured.");
      }
      const trimmed = (query ?? "").trim();
      if (trimmed.length === 0) {
        fail(400, "searchXPosts requires a non-empty query.");
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
  }

  return LifeOpsXReadServiceMixin;
}
