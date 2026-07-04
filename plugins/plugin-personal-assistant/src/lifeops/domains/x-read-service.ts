/**
 * X (Twitter) read domain for LifeOps: fetches the owner's X feed, DMs, and post
 * search through the runtime-service delegates and projects them into assistant
 * DTOs. Read-only counterpart to the write-side x-service.
 */
import crypto from "node:crypto";
import type { Memory } from "@elizaos/core";
import type {
  LifeOpsConnectorGrant,
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/shared";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  fetchXDirectMessagesWithRuntimeService,
  fetchXFeedWithRuntimeService,
  searchXPostsWithRuntimeService,
} from "../runtime-service-delegates.js";
import { fail } from "../service-normalize.js";

type XReadOpts = {
  limit?: number;
};

type XFeedReadOpts = XReadOpts & {
  query?: string;
};

/**
 * Dependencies the X read domain needs that do NOT live on
 * {@link LifeOpsContext}. `resolveXGrant` is owned by the X write domain
 * (`withX`); the read domain uses it opportunistically and tolerates its
 * absence, so it is injected as a typed callback rather than read off `this`.
 */
type XReadDomainDeps = {
  resolveXGrant: () => Promise<LifeOpsConnectorGrant | null>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isoFromMemory(memory: Memory, fallback: string): string {
  const createdAt = Number(memory.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0
    ? new Date(createdAt).toISOString()
    : fallback;
}

function lifeOpsReadDelegationFailed(
  operation: string,
  result: { reason: string; error?: unknown },
): never {
  const detail =
    result.error instanceof Error
      ? result.error.message
      : result.error
        ? String(result.error)
        : result.reason;
  fail(
    result.reason.includes("not registered") ? 409 : 502,
    `[${operation}] ${detail}`,
  );
}

function memoryToLifeOpsXDm(args: {
  agentId: string;
  memory: Memory;
  syncedAt: string;
}): LifeOpsXDm {
  const metadata = record(args.memory.metadata);
  const x = record(metadata.x);
  const sender = record(metadata.sender);
  const externalDmId = stringField(
    x.dmEventId ?? metadata.messageIdFull ?? args.memory.id,
    crypto.randomUUID(),
  );
  const senderId = stringField(
    x.senderId ?? sender.id ?? args.memory.entityId,
    "unknown",
  );
  const senderHandle = stringField(
    x.senderUsername ?? sender.username ?? sender.name,
  );
  const receivedAt = isoFromMemory(args.memory, args.syncedAt);
  return {
    id: `${args.agentId}:x:${externalDmId}`,
    agentId: args.agentId,
    externalDmId,
    conversationId: stringField(
      x.conversationId ?? args.memory.roomId,
      `dm:${senderId}`,
    ),
    senderHandle,
    senderId,
    isInbound:
      typeof x.isInbound === "boolean"
        ? x.isInbound
        : metadata.fromBot !== true,
    text: stringField(args.memory.content.text),
    receivedAt,
    readAt: null,
    repliedAt: null,
    metadata: {
      ...metadata,
      source: "plugin-x-runtime",
    },
    syncedAt: args.syncedAt,
    updatedAt: args.syncedAt,
  };
}

function memoryToLifeOpsXFeedItem(args: {
  agentId: string;
  feedType: LifeOpsXFeedType;
  memory: Memory;
  syncedAt: string;
}): LifeOpsXFeedItem {
  const metadata = record(args.memory.metadata);
  const x = record(metadata.x);
  const sender = record(metadata.sender);
  const externalTweetId = stringField(
    x.tweetId ?? metadata.messageIdFull ?? args.memory.id,
    crypto.randomUUID(),
  );
  const authorId = stringField(
    x.userId ?? sender.id ?? args.memory.entityId,
    "unknown",
  );
  return {
    id: `${args.agentId}:x-feed:${args.feedType}:${externalTweetId}`,
    agentId: args.agentId,
    externalTweetId,
    authorHandle: stringField(x.username ?? sender.username),
    authorId,
    text: stringField(args.memory.content.text),
    createdAtSource: isoFromMemory(args.memory, args.syncedAt),
    feedType: args.feedType,
    metadata: {
      ...metadata,
      source: "plugin-x-runtime",
    },
    syncedAt: args.syncedAt,
    updatedAt: args.syncedAt,
  };
}

function cachedLimit(opts: XReadOpts): number {
  return Math.max(opts.limit ?? 20, 20);
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
    item.authorHandle,
    item.authorId,
    item.text,
    JSON.stringify(item.metadata),
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

/**
 * X (Twitter) read-side sync and queries: DM/feed/search delegation to the
 * runtime X service with a cache-fallback, plus persisted reads. Depends on
 * the optional `resolveXGrant` callback owned by the X write domain.
 */
export class XReadDomain {
  constructor(
    private readonly ctx: LifeOpsContext,
    private readonly deps: XReadDomainDeps,
  ) {}

  async syncXDms(opts: XReadOpts = {}): Promise<{ synced: number }> {
    const grant = await this.deps.resolveXGrant();
    const delegated = await fetchXDirectMessagesWithRuntimeService({
      runtime: this.ctx.runtime,
      grant,
      limit: opts.limit,
    });
    if (delegated.status !== "handled") {
      if (await this.hasCachedXDms(opts)) {
        return { synced: 0 };
      }
      lifeOpsReadDelegationFailed("x_read_dms", delegated);
    }
    const syncedAt = new Date().toISOString();
    for (const memory of delegated.value) {
      await this.ctx.repository.upsertXDm(
        memoryToLifeOpsXDm({
          agentId: this.ctx.agentId(),
          memory,
          syncedAt,
        }),
      );
    }
    return { synced: delegated.value.length };
  }

  async syncXFeed(
    feedType: LifeOpsXFeedType,
    opts: XFeedReadOpts = {},
  ): Promise<{ synced: number }> {
    const grant = await this.deps.resolveXGrant();
    const delegated = await fetchXFeedWithRuntimeService({
      runtime: this.ctx.runtime,
      grant,
      feedType,
      limit: opts.limit,
    });
    if (delegated.status !== "handled") {
      if (await this.hasCachedXFeed(feedType, opts)) {
        return { synced: 0 };
      }
      lifeOpsReadDelegationFailed(`x_read_feed_${feedType}`, delegated);
    }
    const syncedAt = new Date().toISOString();
    for (const memory of delegated.value) {
      await this.ctx.repository.upsertXFeedItem(
        memoryToLifeOpsXFeedItem({
          agentId: this.ctx.agentId(),
          feedType,
          memory,
          syncedAt,
        }),
      );
    }
    await this.ctx.repository.upsertXSyncState({
      id: `${this.ctx.agentId()}:x:${feedType}`,
      agentId: this.ctx.agentId(),
      feedType,
      lastCursor: null,
      syncedAt,
      updatedAt: syncedAt,
    });
    return { synced: delegated.value.length };
  }

  async searchXPosts(
    query: string,
    opts: XReadOpts = {},
  ): Promise<LifeOpsXFeedItem[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      fail(400, "searchXPosts requires a non-empty query.");
    }
    const grant = await this.deps.resolveXGrant();
    const delegated = await searchXPostsWithRuntimeService({
      runtime: this.ctx.runtime,
      grant,
      query: trimmed,
      limit: opts.limit,
    });
    if (delegated.status !== "handled") {
      const searchLimit = cachedLimit(opts);
      const cached = dedupeCachedSearchResults([
        ...(await this.ctx.repository.listXFeedItems(
          this.ctx.agentId(),
          "search",
          {
            limit: searchLimit,
          },
        )),
        ...(await this.ctx.repository.listXFeedItems(
          this.ctx.agentId(),
          "home_timeline",
          { limit: searchLimit },
        )),
        ...(await this.ctx.repository.listXFeedItems(
          this.ctx.agentId(),
          "mentions",
          {
            limit: searchLimit,
          },
        )),
      ]).filter((item) => matchesCachedXSearchQuery(item, trimmed));
      if (cached.length > 0) {
        return cached.slice(0, opts.limit ?? cached.length);
      }
      lifeOpsReadDelegationFailed("x_search", delegated);
    }
    const syncedAt = new Date().toISOString();
    const items: LifeOpsXFeedItem[] = [];
    for (const memory of delegated.value) {
      const item = memoryToLifeOpsXFeedItem({
        agentId: this.ctx.agentId(),
        feedType: "search",
        memory,
        syncedAt,
      });
      await this.ctx.repository.upsertXFeedItem(item);
      items.push(item);
    }
    return items;
  }

  async getXDms(
    opts: { conversationId?: string; limit?: number } = {},
  ): Promise<LifeOpsXDm[]> {
    return this.ctx.repository.listXDms(this.ctx.agentId(), opts);
  }

  async getXFeedItems(
    feedType: LifeOpsXFeedType,
    opts: { limit?: number } = {},
  ): Promise<LifeOpsXFeedItem[]> {
    return this.ctx.repository.listXFeedItems(
      this.ctx.agentId(),
      feedType,
      opts,
    );
  }

  async readXInboundDms(opts: { limit?: number } = {}): Promise<LifeOpsXDm[]> {
    await this.syncXDms(opts);
    const all = await this.ctx.repository.listXDms(this.ctx.agentId(), opts);
    return all.filter((dm) => dm.isInbound);
  }

  private async hasCachedXDms(opts: XReadOpts): Promise<boolean> {
    const cached = await this.ctx.repository.listXDms(this.ctx.agentId(), {
      limit: opts.limit ?? 1,
    });
    return cached.length > 0;
  }

  private async hasCachedXFeed(
    feedType: LifeOpsXFeedType,
    opts: XReadOpts,
  ): Promise<boolean> {
    const cached = await this.ctx.repository.listXFeedItems(
      this.ctx.agentId(),
      feedType,
      { limit: opts.limit ?? 1 },
    );
    return cached.length > 0;
  }
}
