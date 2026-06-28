import type {
  LifeOpsConnectorGrant,
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/shared";
import { XReadDomain } from "./domains/x-read-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

type XReadOpts = {
  limit?: number;
};

type XFeedReadOpts = XReadOpts & {
  query?: string;
};

/**
 * `resolveXGrant` is contributed by the X write mixin (`withX`) and is not
 * guaranteed to be present in every composition. The read domain tolerates its
 * absence, so it is resolved opportunistically off `this`.
 */
type OptionalXGrantResolver = {
  resolveXGrant?: () => Promise<LifeOpsConnectorGrant | null>;
};

export interface LifeOpsXReadService {
  syncXDms(opts?: XReadOpts): Promise<{ synced: number }>;
  syncXFeed(
    feedType: LifeOpsXFeedType,
    opts?: XFeedReadOpts,
  ): Promise<{ synced: number }>;
  searchXPosts(query: string, opts?: XReadOpts): Promise<LifeOpsXFeedItem[]>;
  getXDms(opts?: {
    conversationId?: string;
    limit?: number;
  }): Promise<LifeOpsXDm[]>;
  getXFeedItems(
    feedType: LifeOpsXFeedType,
    opts?: { limit?: number },
  ): Promise<LifeOpsXFeedItem[]>;
  readXInboundDms(opts?: { limit?: number }): Promise<LifeOpsXDm[]>;
}

/** @internal */
export function withXRead<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsXReadService> {
  class LifeOpsXReadServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly xReadDomain = new XReadDomain(this, {
      resolveXGrant: () => {
        const resolver = (this as OptionalXGrantResolver).resolveXGrant;
        return typeof resolver === "function"
          ? resolver.call(this)
          : Promise.resolve(null);
      },
    });

    syncXDms(opts?: XReadOpts): Promise<{ synced: number }> {
      return this.xReadDomain.syncXDms(opts);
    }

    syncXFeed(
      feedType: LifeOpsXFeedType,
      opts?: XFeedReadOpts,
    ): Promise<{ synced: number }> {
      return this.xReadDomain.syncXFeed(feedType, opts);
    }

    searchXPosts(query: string, opts?: XReadOpts): Promise<LifeOpsXFeedItem[]> {
      return this.xReadDomain.searchXPosts(query, opts);
    }

    getXDms(opts?: {
      conversationId?: string;
      limit?: number;
    }): Promise<LifeOpsXDm[]> {
      return this.xReadDomain.getXDms(opts);
    }

    getXFeedItems(
      feedType: LifeOpsXFeedType,
      opts?: { limit?: number },
    ): Promise<LifeOpsXFeedItem[]> {
      return this.xReadDomain.getXFeedItems(feedType, opts);
    }

    readXInboundDms(opts?: { limit?: number }): Promise<LifeOpsXDm[]> {
      return this.xReadDomain.readXInboundDms(opts);
    }
  }

  return LifeOpsXReadServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsXReadService
  >;
}
