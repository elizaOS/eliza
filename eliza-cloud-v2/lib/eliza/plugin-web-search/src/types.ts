import type { Service } from "@elizaos/core";

export interface ITavilyService extends Service {
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
};

export interface SearchOptions {
  auto_parameters?: boolean;
  topic?: "general" | "news" | "finance";
  search_depth?: "basic" | "advanced";
  chunks_per_source?: number; // 1-3, only available when search_depth is "advanced"
  max_results?: number; // 0-20
  time_range?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  start_date?: string; // Format: YYYY-MM-DD
  end_date?: string; // Format: YYYY-MM-DD
  include_answer?: boolean | "basic" | "advanced";
  include_raw_content?: boolean | "markdown" | "text";
  include_images?: boolean;
  include_image_descriptions?: boolean;
  include_favicon?: boolean;
  include_domains?: string[]; // Maximum 300 domains
  exclude_domains?: string[]; // Maximum 150 domains
  country?: string; // Available only if topic is "general"
}
