import { Service, ServiceType } from './service';

export interface SearchOptions {
  limit?: number;
  offset?: number;
  language?: string;
  region?: string;
  dateRange?: {
    start?: Date;
    end?: Date;
  };
  fileType?: string;
  site?: string;
  sortBy?: 'relevance' | 'date' | 'popularity';
  safeSearch?: 'strict' | 'moderate' | 'off';
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  displayUrl?: string;
  thumbnail?: string;
  publishedDate?: Date;
  source?: string;
  relevanceScore?: number;
  snippet?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults?: number;
  searchTime?: number;
  suggestions?: string[];
  nextPageToken?: string;
  relatedSearches?: string[];
}

export interface NewsSearchOptions extends SearchOptions {
  category?:
    | 'general'
    | 'business'
    | 'entertainment'
    | 'health'
    | 'science'
    | 'sports'
    | 'technology';
  freshness?: 'day' | 'week' | 'month';
}

export interface ImageSearchOptions extends SearchOptions {
  size?: 'small' | 'medium' | 'large' | 'wallpaper' | 'any';
  color?:
    | 'color'
    | 'monochrome'
    | 'red'
    | 'orange'
    | 'yellow'
    | 'green'
    | 'blue'
    | 'purple'
    | 'pink'
    | 'brown'
    | 'black'
    | 'gray'
    | 'white';
  type?: 'photo' | 'clipart' | 'line' | 'animated';
  layout?: 'square' | 'wide' | 'tall' | 'any';
  license?: 'any' | 'public' | 'share' | 'sharecommercially' | 'modify';
}

export interface VideoSearchOptions extends SearchOptions {
  duration?: 'short' | 'medium' | 'long' | 'any';
  resolution?: 'high' | 'standard' | 'any';
  quality?: 'high' | 'standard' | 'any';
}

/**
 * Interface for web search services
 */
export abstract class IWebSearchService extends Service {
  static override readonly serviceType = ServiceType.WEB_SEARCH;

  public readonly capabilityDescription = 'Web search and content discovery capabilities';

  /**
   * Perform a general web search
   * @param query - Search query
   * @param options - Search options
   * @returns Promise resolving to search results
   */
  abstract search(query: string, options?: SearchOptions): Promise<SearchResponse>;

  /**
   * Search for news articles
   * @param query - Search query
   * @param options - News search options
   * @returns Promise resolving to news search results
   */
  abstract searchNews(query: string, options?: NewsSearchOptions): Promise<SearchResponse>;

  /**
   * Search for images
   * @param query - Search query
   * @param options - Image search options
   * @returns Promise resolving to image search results
   */
  abstract searchImages(query: string, options?: ImageSearchOptions): Promise<SearchResponse>;

  /**
   * Search for videos
   * @param query - Search query
   * @param options - Video search options
   * @returns Promise resolving to video search results
   */
  abstract searchVideos(query: string, options?: VideoSearchOptions): Promise<SearchResponse>;

  /**
   * Get search suggestions for a query
   * @param query - Partial search query
   * @returns Promise resolving to array of suggestions
   */
  abstract getSuggestions(query: string): Promise<string[]>;

  /**
   * Get trending searches
   * @param region - Optional region code
   * @returns Promise resolving to trending search queries
   */
  abstract getTrendingSearches(region?: string): Promise<string[]>;

  /**
   * Get detailed information about a specific URL
   * @param url - URL to analyze
   * @returns Promise resolving to page information
   */
  abstract getPageInfo(url: string): Promise<{
    title: string;
    description: string;
    content: string;
    metadata: Record<string, string>;
    images: string[];
    links: string[];
  }>;
}
