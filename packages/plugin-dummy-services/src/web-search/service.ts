import { IAgentRuntime, Service, ServiceType, logger } from '@elizaos/core';

// Define web-search-specific types locally since they're not in core
export interface SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  language?: string;
  region?: string;
  safeSearch?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  displayUrl?: string;
  source?: string;
  publishedDate?: Date;
  relevanceScore?: number;
  snippet?: string;
  thumbnail?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  totalResults?: number;
  nextOffset?: number;
}

export interface NewsSearchOptions extends SearchOptions {
  sortBy?: 'relevance' | 'date';
  from?: Date;
  to?: Date;
  category?: string;
}

export interface ImageSearchOptions extends SearchOptions {
  size?: 'small' | 'medium' | 'large';
  type?: 'photo' | 'clipart' | 'gif' | 'transparent';
  color?: string;
}

export interface VideoSearchOptions extends SearchOptions {
  duration?: 'short' | 'medium' | 'long';
  resolution?: 'sd' | 'hd';
}

/**
 * Dummy web search service for testing purposes
 * Provides mock implementations of web search operations
 */
export class DummyWebSearchService extends Service {
  static readonly serviceType = ServiceType.WEB_SEARCH;

  capabilityDescription = 'Dummy web search service for testing';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyWebSearchService> {
    const service = new DummyWebSearchService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    logger.info('DummyWebSearchService initialized');
  }

  async stop(): Promise<void> {
    logger.info('DummyWebSearchService stopped');
  }

  async search(options: SearchOptions): Promise<SearchResponse> {
    logger.debug('Performing web search', JSON.stringify(options));

    const limit = options.limit || 10;
    const results: SearchResult[] = [];

    logger.debug(`Generating ${limit} dummy search results for: ${options.query}`);

    for (let i = 0; i < limit; i++) {
      results.push({
        title: `Result ${i + 1}: ${options.query}`,
        url: `https://example.com/result-${i}`,
        description: `This is dummy search result ${i + 1} for query: ${options.query}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
        displayUrl: `example.com/result-${i}`,
        source: 'DummySearch',
        relevanceScore: 0.9 - i * 0.05,
        snippet: `Dummy snippet for search result ${i + 1}`,
      });
    }

    return {
      results,
      totalResults: 1000,
      nextOffset: (options.offset || 0) + limit,
    };
  }

  async searchNews(options: NewsSearchOptions): Promise<SearchResponse> {
    logger.debug('Performing news search', JSON.stringify(options));

    const limit = options.limit || 10;
    const results: SearchResult[] = [];

    logger.debug(`Generating ${limit} dummy news results for: ${options.query}`);

    for (let i = 0; i < limit; i++) {
      results.push({
        title: `News: ${options.query} - Article ${i + 1}`,
        url: `https://news.example.com/article-${i}`,
        description: `Breaking News ${i + 1}: ${options.query}. This is a dummy news article content that discusses the latest developments.`,
        displayUrl: `news.example.com/article-${i}`,
        source: 'DummyNews',
        publishedDate: new Date(Date.now() - i * 86400000),
        relevanceScore: 0.95 - i * 0.05,
        snippet: `Latest news about ${options.query}`,
      });
    }

    return {
      results,
      totalResults: 500,
      nextOffset: (options.offset || 0) + limit,
    };
  }

  async searchImages(options: ImageSearchOptions): Promise<SearchResponse> {
    logger.debug('Performing image search', JSON.stringify(options));

    const limit = options.limit || 10;
    const results: SearchResult[] = [];

    logger.debug(`Generating ${limit} dummy image results for: ${options.query}`);

    for (let i = 0; i < limit; i++) {
      results.push({
        title: `Image: ${options.query} - ${i + 1}`,
        url: `https://images.example.com/img-${i}.jpg`,
        description: `A ${options.size || 'medium'} image related to ${options.query}`,
        displayUrl: `images.example.com/img-${i}.jpg`,
        source: 'DummyImages',
        thumbnail: `https://images.example.com/thumb-${i}.jpg`,
        relevanceScore: 0.85 - i * 0.05,
        snippet: `Image ${i + 1} related to: ${options.query}`,
      });
    }

    return {
      results,
      totalResults: 10000,
      nextOffset: (options.offset || 0) + limit,
    };
  }

  async searchVideos(options: VideoSearchOptions): Promise<SearchResponse> {
    logger.debug('Performing video search', JSON.stringify(options));

    const limit = options.limit || 10;
    const results: SearchResult[] = [];

    logger.debug(`Generating ${limit} dummy video results for: ${options.query}`);

    for (let i = 0; i < limit; i++) {
      results.push({
        title: `Video: ${options.query} - Part ${i + 1}`,
        url: `https://videos.example.com/video-${i}`,
        description: `A ${options.duration || 'medium'} length video about ${options.query}. This video demonstrates various aspects of the search query.`,
        displayUrl: `videos.example.com/video-${i}`,
        source: 'DummyVideos',
        thumbnail: `https://videos.example.com/thumb-${i}.jpg`,
        publishedDate: new Date(Date.now() - i * 86400000),
        relevanceScore: 0.88 - i * 0.05,
        snippet: `Video ${i + 1}: ${options.query}`,
      });
    }

    return {
      results,
      totalResults: 5000,
      nextOffset: (options.offset || 0) + limit,
    };
  }

  async autocomplete(query: string): Promise<string[]> {
    logger.debug(`Getting autocomplete suggestions for: ${query}`);

    return [
      `${query} tutorial`,
      `${query} examples`,
      `${query} documentation`,
      `${query} best practices`,
      `${query} guide`,
      `${query} tips`,
      `${query} tricks`,
      `${query} how to`,
    ];
  }

  async getTrendingSearches(region?: string): Promise<string[]> {
    logger.debug(`Getting trending searches for region: ${region || 'global'}`);

    return [
      'artificial intelligence',
      'machine learning',
      'blockchain technology',
      'climate change',
      'renewable energy',
      'space exploration',
      'quantum computing',
      'cybersecurity',
    ];
  }

  async getRelatedSearches(query: string): Promise<string[]> {
    logger.debug(`Getting related searches for: ${query}`);

    return [
      `${query} alternatives`,
      `${query} vs competitors`,
      `${query} pricing`,
      `${query} reviews`,
      `best ${query}`,
      `${query} comparison`,
      `${query} features`,
      `${query} benefits`,
    ];
  }

  getDexName(): string {
    return 'dummy-web-search';
  }
}
