import type {
  IAgentRuntime,
  SearchCategoryRegistration,
} from "@elizaos/core";

export const X_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "x",
  label: "X recent posts",
  description: "Search recent X posts with the configured X connector.",
  contexts: ["social", "knowledge"],
  filters: [
    { name: "query", label: "Query", type: "string", required: true },
    {
      name: "maxResults",
      label: "Max results",
      description: "Maximum posts to return, from 1 to 100.",
      type: "number",
      default: 10,
    },
  ],
  resultSchemaSummary:
    "XFeedTweet[] with id, authorId, username, text, likeCount, retweetCount, replyCount, and createdAt.",
  capabilities: ["recent-search", "posts", "social"],
  source: "plugin:x",
  serviceType: "x",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerXSearchCategory(runtime: IAgentRuntime): void {
  if (!hasSearchCategory(runtime, X_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(X_SEARCH_CATEGORY);
  }
}
