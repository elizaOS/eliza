/**
 * AI Search Service
 * Handles AI-powered search functionality using configured providers
 */

import type { SearchResult } from '../components/SmartSearch';

interface AISearchRequest {
  query: string;
  context?: string;
  maxResults?: number;
}

interface AISearchResponse {
  results: SearchResult[];
  suggestions: string[];
}

// AI provider configurations
const AI_PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-3.5-turbo',
    headers: (apiKey: string) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-haiku-20240307',
    headers: (apiKey: string) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }),
  },
};

export class AISearchService {
  private provider: string;
  private apiKey: string;
  private searchIndex: any;

  constructor(provider: string, apiKey: string, searchIndex?: any) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.searchIndex = searchIndex;
  }

  /**
   * Perform AI-enhanced search
   */
  async search(request: AISearchRequest): Promise<AISearchResponse> {
    try {
      // First, get regular search results if we have an index
      const regularResults = this.searchIndex ? 
        await this.performIndexSearch(request.query) : [];

      // Then enhance with AI
      const aiEnhancedResponse = await this.enhanceWithAI(
        request.query,
        regularResults,
        request.context
      );

      return aiEnhancedResponse;
    } catch (error) {
      console.error('AI Search Error:', error);
      // Fallback to regular search results
      return {
        results: this.searchIndex ? 
          await this.performIndexSearch(request.query) : [],
        suggestions: [],
      };
    }
  }

  /**
   * Perform search using the search index
   */
  private async performIndexSearch(query: string): Promise<SearchResult[]> {
    if (!this.searchIndex || !window.lunr) {
      return [];
    }

    try {
      const idx = window.lunr.Index.load(this.searchIndex);
      const searchResults = idx.search(query);

      return searchResults.map((result: any) => {
        const doc = window.searchDocuments?.[result.ref] || {};
        
        let type: 'doc' | 'api' | 'code' | 'package' | 'community' = 'doc';
        let category = 'Documentation';

        if (doc.url?.includes('/api/')) {
          type = 'api';
          category = 'API Reference';
        } else if (doc.url?.includes('/packages/')) {
          type = 'package';
          category = 'Packages';
        } else if (doc.url?.includes('/blog/')) {
          type = 'community';
          category = 'Blog';
        }

        return {
          id: result.ref,
          title: doc.title || 'Untitled',
          content: doc.content?.substring(0, 200) + '...' || '',
          url: doc.url || '#',
          type,
          category,
          relevance: result.score,
          highlights: [],
          tags: doc.tags || [],
        };
      });
    } catch (error) {
      console.error('Index search error:', error);
      return [];
    }
  }

  /**
   * Enhance search results with AI
   */
  private async enhanceWithAI(
    query: string,
    regularResults: SearchResult[],
    context?: string
  ): Promise<AISearchResponse> {
    const prompt = this.buildSearchPrompt(query, regularResults, context);
    
    try {
      let response;
      
      if (this.provider === 'openai') {
        response = await this.callOpenAI(prompt);
      } else if (this.provider === 'anthropic') {
        response = await this.callAnthropic(prompt);
      } else {
        // Fallback for unsupported providers
        return {
          results: regularResults,
          suggestions: [],
        };
      }

      return this.parseAIResponse(response, regularResults);
    } catch (error) {
      console.error('AI enhancement error:', error);
      return {
        results: regularResults,
        suggestions: [],
      };
    }
  }

  /**
   * Build the prompt for AI search enhancement
   */
  private buildSearchPrompt(
    query: string,
    results: SearchResult[],
    context?: string
  ): string {
    const resultsContext = results.slice(0, 5).map(r => 
      `- ${r.title}: ${r.content.substring(0, 100)}...`
    ).join('\n');

    return `You are a helpful AI assistant for ElizaOS documentation search.
User Query: "${query}"
${context ? `Context: ${context}` : ''}

Current search results:
${resultsContext}

Based on the user's query and the search results, please:
1. Rank the results by relevance (return as array of result indices)
2. Suggest 3 related search queries the user might find helpful
3. Identify if any important documentation is missing from results

Respond in JSON format:
{
  "rankedIndices": [0, 2, 1, ...],
  "suggestions": ["suggestion 1", "suggestion 2", "suggestion 3"],
  "missingTopics": ["topic 1", "topic 2"]
}`;
  }

  /**
   * Call OpenAI API
   */
  private async callOpenAI(prompt: string): Promise<any> {
    const config = AI_PROVIDERS.openai;
    
    const response = await fetch(config.url, {
      method: 'POST',
      headers: config.headers(this.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful AI assistant that enhances documentation search results.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  /**
   * Call Anthropic API
   */
  private async callAnthropic(prompt: string): Promise<any> {
    const config = AI_PROVIDERS.anthropic;
    
    const response = await fetch(config.url, {
      method: 'POST',
      headers: config.headers(this.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }

  /**
   * Parse AI response and enhance results
   */
  private parseAIResponse(
    aiResponse: string,
    originalResults: SearchResult[]
  ): AISearchResponse {
    try {
      const parsed = JSON.parse(aiResponse);
      
      // Reorder results based on AI ranking
      const rankedResults = parsed.rankedIndices
        .filter((idx: number) => idx < originalResults.length)
        .map((idx: number) => ({
          ...originalResults[idx],
          relevance: 1 - (parsed.rankedIndices.indexOf(idx) * 0.1), // Adjust relevance
        }));

      // Add any results not included in ranking
      const unrankedResults = originalResults.filter((_, idx) => 
        !parsed.rankedIndices.includes(idx)
      );

      return {
        results: [...rankedResults, ...unrankedResults],
        suggestions: parsed.suggestions || [],
      };
    } catch (error) {
      console.error('Error parsing AI response:', error);
      return {
        results: originalResults,
        suggestions: [],
      };
    }
  }
}

// Singleton instance
let aiSearchInstance: AISearchService | null = null;

/**
 * Get or create AI search service instance
 */
export function getAISearchService(
  provider?: string,
  apiKey?: string,
  searchIndex?: any
): AISearchService | null {
  if (!provider || !apiKey) {
    return null;
  }

  if (!aiSearchInstance) {
    aiSearchInstance = new AISearchService(provider, apiKey, searchIndex);
  }

  return aiSearchInstance;
}