/**
 * Moltbook Context Providers
 *
 * ## WHY THREE TIERS?
 *
 * LLMs have limited context windows. Every token spent on context is a token
 * NOT available for reasoning or response. Different tasks need different
 * amounts of context:
 *
 * - "Can I post?" → LOW (~100 tokens) - just status
 * - "What should I post about?" → MEDIUM (~300 tokens) - status + topics
 * - "Analyze community and find opportunities" → HIGH (~800 tokens) - everything
 *
 * By offering three tiers, the task planner can choose the right amount:
 * - Simple tasks: pick LOW, save context budget for other things
 * - Complex tasks: pick HIGH, get full analysis
 *
 * ## WHY DYNAMIC?
 *
 * Marking providers as `dynamic: true` tells elizaOS:
 * - "This provider's output changes based on current state"
 * - "The task planner should consider calling this when relevant"
 * - "Don't cache the output - re-run each time"
 *
 * ## WHY CACHE COMMUNITY ANALYSIS?
 *
 * Even though providers are dynamic, we cache the community analysis:
 * - Analysis is computationally expensive (processes entire feed)
 * - Community patterns don't change second-to-second
 * - Cache with timestamp allows freshness checks
 *
 * The cache is per-agent (keyed by agentId) so multiple agents don't conflict.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { PLUGIN_NAME } from "../constants";
import { analyzeCommunity, formatContextForPrompt, isAnalysisFresh } from "../lib/intelligence";
import { getRateLimitStatus } from "../lib/rateLimiter";
import type { MoltbookService } from "../service";
import type { CommunityContext } from "../types";

// Cache community analysis per agent
const analysisCache = new Map<string, CommunityContext>();

// =============================================================================
// LOW RESOLUTION - Status only (~100 tokens)
// =============================================================================

/**
 * Moltbook Status Provider (Low Resolution)
 *
 * Use when you just need to know:
 * - Is the agent authenticated?
 * - Can it post/comment right now?
 * - Basic rate limit status
 *
 * Does NOT include: feed content, community analysis, or engagement opportunities.
 * Fastest provider - no API calls if credentials are cached.
 */
export const moltbookStatusProvider: Provider = {
  name: "MOLTBOOK_STATUS",
  description:
    'Quick Moltbook status check: authentication state and rate limits. Use for simple "can I post?" checks. Low context cost.',
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    const service = runtime.getService<MoltbookService>(PLUGIN_NAME);
    if (!service) {
      return {
        text: "Moltbook: Service not available",
        values: { moltbookEnabled: false },
        data: {},
      };
    }

    const creds = await service.getCredentials();
    if (!creds) {
      return {
        text: "Moltbook: Not authenticated",
        values: { moltbookEnabled: false, moltbookAuthenticated: false },
        data: {},
      };
    }

    const rateLimits = getRateLimitStatus(runtime.agentId);

    // Minimal text output
    const status = [];
    status.push(`Moltbook: @${creds.username}`);
    if (!rateLimits.canPost) {
      status.push(`(can post in ${Math.ceil(rateLimits.timeUntilCanPost / 60000)}m)`);
    }
    if (rateLimits.commentsRemaining < 10) {
      status.push(`(${rateLimits.commentsRemaining} comments left)`);
    }

    return {
      text: status.join(" "),
      values: {
        moltbookEnabled: true,
        moltbookAuthenticated: true,
        moltbookUsername: creds.username,
        moltbookCanPost: rateLimits.canPost,
        moltbookCanComment: rateLimits.canComment,
      },
      data: {
        credentials: { username: creds.username, userId: creds.userId },
        rateLimits,
      },
    };
  },
};

// =============================================================================
// MEDIUM RESOLUTION - Status + Community Summary (~300 tokens)
// =============================================================================

/**
 * Moltbook Context Provider (Medium Resolution)
 *
 * Use when making engagement decisions:
 * - What topics are hot right now?
 * - What's the community vibe?
 * - Should I post or wait?
 *
 * Includes: authentication, rate limits, active topics, vibe.
 * Does NOT include: detailed opportunities, notable users, posting patterns.
 * Moderate cost - may trigger feed fetch if cache is stale.
 */
export const moltbookContextProvider: Provider = {
  name: "MOLTBOOK_CONTEXT",
  description:
    "Moltbook status plus community summary: hot topics and vibe. Use for deciding whether/what to post. Medium context cost.",
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    const service = runtime.getService<MoltbookService>(PLUGIN_NAME);
    if (!service) {
      return {
        text: "Moltbook: Service not available",
        values: { moltbookEnabled: false },
        data: {},
      };
    }

    const creds = await service.getCredentials();
    if (!creds) {
      return {
        text: "Moltbook: Not authenticated",
        values: { moltbookEnabled: false, moltbookAuthenticated: false },
        data: {},
      };
    }

    // Get or refresh community analysis
    let context = analysisCache.get(runtime.agentId);
    if (!isAnalysisFresh(context)) {
      try {
        const feed = await service.getFeed({ forceFresh: !context });
        if (feed) {
          context = analyzeCommunity(feed, runtime);
          analysisCache.set(runtime.agentId, context);
        }
      } catch (error) {
        runtime.logger.error({ error }, "Failed to analyze Moltbook community");
      }
    }

    const rateLimits = getRateLimitStatus(runtime.agentId);

    // Medium-detail output
    const lines: string[] = [];
    lines.push(`## Moltbook (@${creds.username})`);

    if (!rateLimits.canPost) {
      lines.push(`Can post in ${Math.ceil(rateLimits.timeUntilCanPost / 60000)} min`);
    }

    if (context) {
      if (context.activeTopics.length > 0) {
        lines.push(`**Hot topics:** ${context.activeTopics.slice(0, 5).join(", ")}`);
      }
      lines.push(`**Vibe:** ${context.vibe}`);
    }

    return {
      text: lines.join("\n"),
      values: {
        moltbookEnabled: true,
        moltbookAuthenticated: true,
        moltbookUsername: creds.username,
        moltbookCanPost: rateLimits.canPost,
        moltbookCanComment: rateLimits.canComment,
        moltbookActiveTopics: context?.activeTopics || [],
        moltbookVibe: context?.vibe || "unknown",
      },
      data: {
        credentials: { username: creds.username, userId: creds.userId },
        rateLimits,
        activeTopics: context?.activeTopics,
        vibe: context?.vibe,
      },
    };
  },
};

// =============================================================================
// HIGH RESOLUTION - Full Analysis (~800 tokens)
// =============================================================================

/**
 * Moltbook Full Analysis Provider (High Resolution)
 *
 * Use when you need the complete picture:
 * - Specific engagement opportunities with priorities
 * - What posting patterns work well
 * - Notable community members
 * - Full context for composing quality content
 *
 * Includes: everything from medium + opportunities, notable users, what works.
 * High cost - always fetches fresh feed data.
 * Use sparingly, only when crafting posts or making strategic decisions.
 */
export const moltbookFullAnalysisProvider: Provider = {
  name: "MOLTBOOK_FULL_ANALYSIS",
  description:
    "Complete Moltbook analysis: opportunities, notable users, what works. Use when composing posts or making strategic engagement decisions. High context cost.",
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    const service = runtime.getService<MoltbookService>(PLUGIN_NAME);
    if (!service) {
      return {
        text: "Moltbook: Service not available",
        values: { moltbookEnabled: false },
        data: {},
      };
    }

    const creds = await service.getCredentials();
    if (!creds) {
      return {
        text: "Moltbook: Not authenticated",
        values: { moltbookEnabled: false, moltbookAuthenticated: false },
        data: {},
      };
    }

    // Always fetch fresh for full analysis
    let context: CommunityContext | undefined;
    try {
      const feed = await service.getFeed({ forceFresh: true });
      if (feed) {
        context = analyzeCommunity(feed, runtime);
        analysisCache.set(runtime.agentId, context);
      }
    } catch (error) {
      runtime.logger.error({ error }, "Failed to get full Moltbook analysis");
      context = analysisCache.get(runtime.agentId);
    }

    const rateLimits = getRateLimitStatus(runtime.agentId);
    const profile = await service.getOwnProfile();

    // Get submolts list for community awareness
    const submolts = await service.getSubmolts();

    // Get global trending posts (different from personalized feed)
    const globalPosts = await service.getPosts({ sort: "hot", limit: 10 });

    // Full detail output
    const lines: string[] = [];

    lines.push(`## Moltbook Full Analysis`);
    lines.push("");
    lines.push(`**Account:** @${creds.username} (${creds.claimStatus || "unclaimed"})`);
    if (profile) {
      lines.push(`**Stats:** ${profile.postCount} posts, ${profile.followerCount} followers`);
    }
    lines.push("");

    // Rate limit status
    lines.push("**Rate Limits:**");
    lines.push(
      `- Can post: ${rateLimits.canPost ? "Yes" : `No (wait ${Math.ceil(rateLimits.timeUntilCanPost / 60000)}m)`}`
    );
    lines.push(`- Comments remaining: ${rateLimits.commentsRemaining}/50`);
    lines.push(`- Requests remaining: ${rateLimits.requestsRemaining}/100`);

    // Available submolts (communities)
    if (submolts && submolts.length > 0) {
      lines.push("");
      lines.push("**Communities (submolts):**");
      for (const s of submolts.slice(0, 5)) {
        lines.push(`- m/${s.name}: ${s.description?.slice(0, 50) || "No description"}...`);
      }
      if (submolts.length > 5) {
        lines.push(`  ...and ${submolts.length - 5} more`);
      }
    }

    // Global trending (beyond personalized feed)
    if (globalPosts && globalPosts.posts.length > 0) {
      lines.push("");
      lines.push("**Global Trending:**");
      for (const p of globalPosts.posts.slice(0, 3)) {
        lines.push(`- "${p.title}" by @${p.author.username} (↑${p.score})`);
      }
    }

    if (context) {
      lines.push("");
      lines.push(formatContextForPrompt(context));
    }

    // Note about semantic search capability
    lines.push("");
    lines.push("_Tip: Use semantic search to find relevant posts by meaning, not just keywords._");

    return {
      text: lines.join("\n"),
      values: {
        moltbookEnabled: true,
        moltbookAuthenticated: true,
        moltbookUsername: creds.username,
        moltbookUserId: creds.userId,
        moltbookCanPost: rateLimits.canPost,
        moltbookCanComment: rateLimits.canComment,
        moltbookActiveTopics: context?.activeTopics || [],
        moltbookVibe: context?.vibe || "unknown",
        moltbookOpportunityCount: context?.engagementOpportunities.length || 0,
        moltbookSubmoltCount: submolts?.length || 0,
      },
      data: {
        credentials: {
          username: creds.username,
          userId: creds.userId,
          claimStatus: creds.claimStatus,
        },
        rateLimits,
        profile,
        submolts,
        globalTrending: globalPosts?.posts.slice(0, 5),
        communityContext: context,
      },
    };
  },
};

// =============================================================================
// EXPORTS & UTILITIES
// =============================================================================

/**
 * All Moltbook providers grouped by resolution
 */
export const moltbookProviders = {
  low: moltbookStatusProvider,
  medium: moltbookContextProvider,
  high: moltbookFullAnalysisProvider,
};

/**
 * Clear the analysis cache for an agent
 */
export function clearAnalysisCache(agentId: string): void {
  analysisCache.delete(agentId);
}

/**
 * Force refresh community analysis
 */
export async function refreshCommunityAnalysis(
  runtime: IAgentRuntime
): Promise<CommunityContext | null> {
  const service = runtime.getService<MoltbookService>(PLUGIN_NAME);
  if (!service) return null;

  try {
    const feed = await service.getFeed({ forceFresh: true });
    if (feed) {
      const context = analyzeCommunity(feed, runtime);
      analysisCache.set(runtime.agentId, context);
      return context;
    }
  } catch (error) {
    runtime.logger.error({ error }, "Failed to refresh Moltbook community analysis");
  }

  return analysisCache.get(runtime.agentId) || null;
}

export default moltbookContextProvider;
