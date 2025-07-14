import { IAgentRuntime } from '@elizaos/core';
import {
  IWebSearchService,
  SearchOptions,
  SearchResult,
  SearchResponse,
  NewsSearchOptions,
  ImageSearchOptions,
  VideoSearchOptions,
} from '@elizaos/core';

/**
 * Dummy web search service for testing purposes
 * Provides mock implementations of web search operations
 */
export class DummyWebSearchService extends IWebSearchService {
  static override readonly serviceType = IWebSearchService.serviceType;

  private trendingSearches = [
    'artificial intelligence',
    'machine learning',
    'blockchain technology',
    'climate change',
    'space exploration',
    'quantum computing',
    'renewable energy',
    'cybersecurity',
    'biotechnology',
    'autonomous vehicles',
  ];

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyWebSearchService> {
    const service = new DummyWebSearchService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.runtime.logger.info('DummyWebSearchService initialized');
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('DummyWebSearchService stopped');
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    this.runtime.logger.debug(`Searching for: "${query}"`);

    if (options) {
      this.runtime.logger.debug('Search options:', options);
    }

    // Mock search results
    const results: SearchResult[] = [
      {
        title: `${query} - Comprehensive Guide`,
        url: `https://example.com/guide/${query.replace(/\s+/g, '-')}`,
        description: `A comprehensive guide about ${query}. This mock result provides detailed information and explanations about the topic.`,
        displayUrl: 'example.com',
        thumbnail: 'https://example.com/thumbnail1.jpg',
        publishedDate: new Date('2024-01-15'),
        source: 'Example Guide',
        relevanceScore: 0.95,
        snippet: `Learn everything about ${query} with this detailed guide...`,
      },
      {
        title: `${query} - Latest News and Updates`,
        url: `https://news.example.com/latest/${query.replace(/\s+/g, '-')}`,
        description: `Stay updated with the latest news about ${query}. Recent developments, trends, and insights.`,
        displayUrl: 'news.example.com',
        thumbnail: 'https://news.example.com/thumbnail2.jpg',
        publishedDate: new Date('2024-01-10'),
        source: 'Example News',
        relevanceScore: 0.88,
        snippet: `Breaking news about ${query}: Recent developments show...`,
      },
      {
        title: `${query} - Wikipedia`,
        url: `https://en.wikipedia.org/wiki/${query.replace(/\s+/g, '_')}`,
        description: `Wikipedia article about ${query}. Comprehensive information from the free encyclopedia.`,
        displayUrl: 'en.wikipedia.org',
        publishedDate: new Date('2023-12-01'),
        source: 'Wikipedia',
        relevanceScore: 0.82,
        snippet: `${query} is a topic that encompasses various aspects...`,
      },
    ];

    return {
      query,
      results,
      totalResults: 156789,
      searchTime: 0.42,
      suggestions: [
        `${query} tutorial`,
        `${query} examples`,
        `${query} best practices`,
        `${query} 2024`,
      ],
      relatedSearches: [
        `what is ${query}`,
        `how to ${query}`,
        `${query} vs alternatives`,
        `${query} benefits`,
      ],
    };
  }

  async searchNews(query: string, options?: NewsSearchOptions): Promise<SearchResponse> {
    this.runtime.logger.debug(`Searching news for: "${query}"`);

    if (options) {
      this.runtime.logger.debug('News search options:', options);
    }

    // Mock news results
    const results: SearchResult[] = [
      {
        title: `Breaking: ${query} Makes Headlines`,
        url: `https://news.example.com/breaking/${query.replace(/\s+/g, '-')}`,
        description: `Latest breaking news about ${query}. Important developments that are making headlines today.`,
        displayUrl: 'news.example.com',
        thumbnail: 'https://news.example.com/breaking.jpg',
        publishedDate: new Date(Date.now() - 3600000), // 1 hour ago
        source: 'Example News',
        relevanceScore: 0.93,
      },
      {
        title: `${query}: Analysis and Commentary`,
        url: `https://analysis.example.com/commentary/${query.replace(/\s+/g, '-')}`,
        description: `Expert analysis and commentary on ${query}. In-depth perspectives from industry leaders.`,
        displayUrl: 'analysis.example.com',
        thumbnail: 'https://analysis.example.com/analysis.jpg',
        publishedDate: new Date(Date.now() - 7200000), // 2 hours ago
        source: 'Example Analysis',
        relevanceScore: 0.87,
      },
    ];

    return {
      query,
      results,
      totalResults: 12345,
      searchTime: 0.28,
      suggestions: [`${query} news`, `${query} headlines`, `${query} updates`],
    };
  }

  async searchImages(query: string, options?: ImageSearchOptions): Promise<SearchResponse> {
    this.runtime.logger.debug(`Searching images for: "${query}"`);

    if (options) {
      this.runtime.logger.debug('Image search options:', options);
    }

    // Mock image results
    const results: SearchResult[] = Array.from({ length: 12 }, (_, i) => ({
      title: `${query} Image ${i + 1}`,
      url: `https://images.example.com/${query.replace(/\s+/g, '-')}-${i + 1}.jpg`,
      description: `High-quality image of ${query}. Perfect for various uses and applications.`,
      displayUrl: 'images.example.com',
      thumbnail: `https://images.example.com/thumb/${query.replace(/\s+/g, '-')}-${i + 1}.jpg`,
      source: 'Example Images',
      relevanceScore: 0.9 - i * 0.05,
    }));

    return {
      query,
      results,
      totalResults: 45678,
      searchTime: 0.35,
    };
  }

  async searchVideos(query: string, options?: VideoSearchOptions): Promise<SearchResponse> {
    this.runtime.logger.debug(`Searching videos for: "${query}"`);

    if (options) {
      this.runtime.logger.debug('Video search options:', options);
    }

    // Mock video results
    const results: SearchResult[] = [
      {
        title: `${query} - Complete Tutorial`,
        url: `https://video.example.com/tutorial/${query.replace(/\s+/g, '-')}`,
        description: `Complete tutorial about ${query}. Step-by-step guide with examples and demonstrations.`,
        displayUrl: 'video.example.com',
        thumbnail: `https://video.example.com/thumb/tutorial-${query.replace(/\s+/g, '-')}.jpg`,
        publishedDate: new Date('2024-01-05'),
        source: 'Example Video',
        relevanceScore: 0.91,
      },
      {
        title: `${query} Explained in 5 Minutes`,
        url: `https://video.example.com/quick/${query.replace(/\s+/g, '-')}`,
        description: `Quick explanation of ${query} in just 5 minutes. Perfect for beginners and quick reference.`,
        displayUrl: 'video.example.com',
        thumbnail: `https://video.example.com/thumb/quick-${query.replace(/\s+/g, '-')}.jpg`,
        publishedDate: new Date('2024-01-03'),
        source: 'Example Video',
        relevanceScore: 0.86,
      },
    ];

    return {
      query,
      results,
      totalResults: 8765,
      searchTime: 0.31,
    };
  }

  async getSuggestions(query: string): Promise<string[]> {
    this.runtime.logger.debug(`Getting suggestions for: "${query}"`);

    // Mock suggestions based on query
    const suggestions = [
      `${query} tutorial`,
      `${query} guide`,
      `${query} examples`,
      `${query} best practices`,
      `${query} vs alternatives`,
      `how to ${query}`,
      `what is ${query}`,
      `${query} 2024`,
    ];

    return suggestions;
  }

  async getTrendingSearches(region?: string): Promise<string[]> {
    this.runtime.logger.debug(`Getting trending searches for region: ${region || 'global'}`);

    // Return shuffled trending searches
    return [...this.trendingSearches].sort(() => Math.random() - 0.5);
  }

  async getPageInfo(url: string): Promise<{
    title: string;
    description: string;
    content: string;
    metadata: Record<string, string>;
    images: string[];
    links: string[];
  }> {
    this.runtime.logger.debug(`Getting page info for: ${url}`);

    // Mock page information
    const domain = new URL(url).hostname;

    return {
      title: `Mock Page Title - ${domain}`,
      description: `This is a mock page description for ${url}. It provides detailed information about the page content.`,
      content: `Mock page content from ${url}.\n\nThis is a comprehensive analysis of the page including:\n- Main content sections\n- Important information\n- Key topics covered\n- Related resources\n\nThe page provides valuable insights and information for users interested in the topic.`,
      metadata: {
        'og:title': `Mock Page Title - ${domain}`,
        'og:description': `Mock page description for ${url}`,
        'og:type': 'website',
        'og:url': url,
        'og:image': `${url}/og-image.jpg`,
        'twitter:card': 'summary_large_image',
        'twitter:title': `Mock Page Title - ${domain}`,
        'twitter:description': `Mock page description for ${url}`,
        author: 'Mock Author',
        keywords: 'mock, page, content, analysis',
      },
      images: [`${url}/image1.jpg`, `${url}/image2.jpg`, `${url}/banner.jpg`],
      links: [
        `${url}/page1`,
        `${url}/page2`,
        `${url}/contact`,
        `${url}/about`,
        'https://external-link.com',
      ],
    };
  }
}
