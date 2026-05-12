import type { Service } from "@elizaos/core";

export interface IWebSearchService extends Service {
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score: number;
  publishedDate?: string;
};

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
