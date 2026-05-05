import type {
  IAgentRuntime,
  SearchCategoryRegistration,
} from "@elizaos/core";

export const YOUTUBE_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "youtube",
  label: "YouTube videos",
  description:
    "Search YouTube for music videos, songs, and general videos.",
  contexts: ["media", "knowledge"],
  filters: [
    { name: "query", label: "Query", type: "string", required: true },
    {
      name: "limit",
      label: "Limit",
      description: "Maximum videos to return.",
      type: "number",
      default: 5,
    },
    {
      name: "includeShorts",
      label: "Include Shorts",
      description: "Whether YouTube Shorts should be included.",
      type: "boolean",
      default: false,
    },
  ],
  resultSchemaSummary:
    "YouTubeSearchResult[] with url, title, duration, channel, and views.",
  capabilities: ["videos", "music", "links", "metadata"],
  source: "plugin:music-library",
  serviceType: "youtubeSearch",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerMusicLibrarySearchCategories(
  runtime: IAgentRuntime,
): void {
  if (!hasSearchCategory(runtime, YOUTUBE_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(YOUTUBE_SEARCH_CATEGORY);
  }
}
