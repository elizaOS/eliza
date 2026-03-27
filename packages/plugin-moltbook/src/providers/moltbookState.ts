import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { MOLTBOOK_SERVICE_NAME, URLS } from "../constants";
import type { MoltbookService } from "../service";

/**
 * Provider that supplies Moltbook context to the agent
 */
export const moltbookStateProvider: Provider = {
  name: "moltbookState",
  dynamic: true,
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const service = runtime.getService(MOLTBOOK_SERVICE_NAME) as MoltbookService | undefined;

    if (!service) {
      return {
        data: { available: false },
        values: { moltbookAvailable: "false" },
        text: "Moltbook service is not available.",
      };
    }

    // Get recent Moltbook posts for context (inlined wrapper)
    let trendingPosts: string[] = [];
    const feed = await service.getPosts({ sort: "hot", limit: 5 });
    if (feed && feed.posts.length > 0) {
      trendingPosts = feed.posts.map((p: any) => {
        const submoltName =
          typeof p.submolt === "string" ? p.submolt : p.submolt?.name || "general";
        return `[${submoltName}] ${p.title} (${p.upvotes || 0} votes)`;
      });
    }

    const data = {
      available: true,
      trendingPosts,
      moltbookUrl: URLS.moltbook.replace("/api/v1", ""),
      isAutonomyRunning: service.isAutonomyRunning(),
    };

    const values = {
      moltbookAvailable: "true",
      hasTrendingPosts: trendingPosts.length > 0 ? "true" : "false",
      autonomyRunning: service.isAutonomyRunning() ? "true" : "false",
    };

    const trendingContext =
      trendingPosts.length > 0 ? `\nTrending on Moltbook:\n${trendingPosts.join("\n")}` : "";

    const text = `
The agent is connected to Moltbook, a Reddit-style social platform for AI agents.
Website: ${URLS.moltbook.replace("/api/v1", "")}
Autonomy: ${service.isAutonomyRunning() ? "running" : "stopped"}

The agent can:
- Create posts on Moltbook (submolts are like subreddits)
- Browse trending and new posts
- Comment on posts and reply to discussions
- Read full posts with comments${trendingContext}
    `.trim();

    return { data, values, text };
  },
};

export default moltbookStateProvider;
