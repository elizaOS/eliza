// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins. Real type safety is enforced at the
// composed-service level.
import crypto from "node:crypto";
import type { Memory } from "@elizaos/core";
import type {
  LifeOpsConnectorGrant,
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/shared";
import {
  fetchXDirectMessagesWithRuntimeService,
  fetchXFeedWithRuntimeService,
  searchXPostsWithRuntimeService,
} from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";

type XReadOpts = {
  limit?: number;
};

type XFeedReadOpts = XReadOpts & {
  query?: string;
};

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
        : metadata.fromBot === true
          ? false
          : true,
    text: stringField(args.memory.content?.text),
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
    text: stringField(args.memory.content?.text),
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

async function hasCachedXDms(
  service: LifeOpsServiceBase,
  opts: XReadOpts,
): Promise<boolean> {
  const cached = await service.repository.listXDms(service.agentId(), {
    limit: opts.limit ?? 1,
  });
  return cached.length > 0;
}

async function hasCachedXFeed(
  service: LifeOpsServiceBase,
  feedType: LifeOpsXFeedType,
  opts: XReadOpts,
): Promise<boolean> {
  const cached = await service.repository.listXFeedItems(
    service.agentId(),
    feedType,
    { limit: opts.limit ?? 1 },
  );
  return cached.length > 0;
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
      const grant = await resolveOptionalXGrant(this);
      const delegated = await fetchXDirectMessagesWithRuntimeService({
        runtime: this.runtime,
        grant,
        limit: opts.limit,
      });
      if (delegated.status !== "handled") {
        if (await hasCachedXDms(this, opts)) {
          return { synced: 0 };
        }
        lifeOpsReadDelegationFailed("x_read_dms", delegated);
      }
      const syncedAt = new Date().toISOString();
      for (const memory of delegated.value) {
        await this.repository.upsertXDm(
          memoryToLifeOpsXDm({
            agentId: this.agentId(),
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
      const grant = await resolveOptionalXGrant(this);
      const delegated = await fetchXFeedWithRuntimeService({
        runtime: this.runtime,
        grant,
        feedType,
        limit: opts.limit,
      });
      if (delegated.status !== "handled") {
        if (await hasCachedXFeed(this, feedType, opts)) {
          return { synced: 0 };
        }
        lifeOpsReadDelegationFailed(`x_read_feed_${feedType}`, delegated);
      }
      const syncedAt = new Date().toISOString();
      for (const memory of delegated.value) {
        await this.repository.upsertXFeedItem(
          memoryToLifeOpsXFeedItem({
            agentId: this.agentId(),
            feedType,
            memory,
            syncedAt,
          }),
        );
      }
      await this.repository.upsertXSyncState({
        id: `${this.agentId()}:x:${feedType}`,
        agentId: this.agentId(),
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
      const trimmed = (query ?? "").trim();
      if (trimmed.length === 0) {
        fail(400, "searchXPosts requires a non-empty query.");
      }
      const grant = await resolveOptionalXGrant(this);
      const delegated = await searchXPostsWithRuntimeService({
        runtime: this.runtime,
        grant,
        query: trimmed,
        limit: opts.limit,
      });
      if (delegated.status !== "handled") {
        const searchLimit = cachedLimit(opts);
        const cached = dedupeCachedSearchResults([
          ...(await this.repository.listXFeedItems(this.agentId(), "search", {
            limit: searchLimit,
          })),
          ...(await this.repository.listXFeedItems(
            this.agentId(),
            "home_timeline",
            { limit: searchLimit },
          )),
          ...(await this.repository.listXFeedItems(this.agentId(), "mentions", {
            limit: searchLimit,
          })),
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
          agentId: this.agentId(),
          feedType: "search",
          memory,
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
