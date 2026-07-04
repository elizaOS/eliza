/**
 * X (Twitter) read service mixin: declares the LifeOps X read service surface
 * and the mixin that composes the x-read domain's feed/DM/search methods onto
 * the LifeOpsService base.
 */
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/shared";

type XReadOpts = {
  limit?: number;
};

type XFeedReadOpts = XReadOpts & {
  query?: string;
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
