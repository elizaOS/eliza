// Wires hosted Eliza agent types behavior for cloud runtime services.
import type { Service } from "@elizaos/core";

export interface IWebSearchService extends Service {
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}

/**
 * Website reputation of a result address. `not_listed` only means no current
 * threat list contains it; nothing here means the site is safe.
 */
export type SearchResultReputation =
  | { status: "listed"; sources: string[]; categories: string[]; warning: string }
  | { status: "not_listed"; label: "No known threat" }
  | { status: "unavailable" };

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score: number;
  publishedDate?: string;
  reputation?: SearchResultReputation;
};

export type SearchReputationWarning = { url: string; host: string; warning: string };

export type SearchImage = {
  url: string;
  description?: string;
};

export type SearchResponse = {
  answer?: string;
  query: string;
  responseTime: number;
  images: SearchImage[];
  results: SearchResult[];
  model?: string;
  provider?: string;
  searchQueries?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost?: number;
  /** Listed addresses that appear in the synthesized answer text. */
  reputationWarnings?: SearchReputationWarning[];
};

export interface SearchOptions {
  topic?: "general" | "finance";
  max_results?: number;
  time_range?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  start_date?: string;
  end_date?: string;
  source?: string;
  model?: string;
}
