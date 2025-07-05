/**
 * Example Server-Side AI Search Endpoint
 * 
 * This is an example of how to properly implement AI-powered search
 * on the server side to keep API keys secure.
 * 
 * This would typically be implemented in your backend framework of choice:
 * - Express.js
 * - Next.js API Routes
 * - Netlify Functions
 * - Vercel Serverless Functions
 * - etc.
 */

import type { Request, Response } from 'express';

// Types
interface SearchRequest {
  query: string;
  provider?: string;
  results?: Array<{
    id: string;
    title: string;
    content: string;
    url: string;
  }>;
}

interface SearchResponse {
  results: Array<{
    id: string;
    title: string;
    content: string;
    url: string;
    relevance: number;
    highlights: string[];
  }>;
  suggestions: string[];
}

// Example Express.js endpoint
export async function searchEndpoint(req: Request, res: Response) {
  // 1. Validate request
  const { query, provider, results } = req.body as SearchRequest;
  
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Invalid query' });
  }

  // 2. Rate limiting (implement based on your needs)
  // Example: Check Redis for user's request count
  
  // 3. Get API credentials from environment (server-side only!)
  const apiKey = getApiKey(provider || 'openai');
  
  if (!apiKey) {
    // Fallback to non-AI search
    return res.json({
      results: results || [],
      suggestions: [],
    });
  }

  try {
    // 4. Call AI API
    const aiResponse = await callAIProvider(provider || 'openai', apiKey, {
      query,
      results: results || [],
    });

    // 5. Return enhanced results
    res.json(aiResponse);
  } catch (error) {
    console.error('AI search error:', error);
    // 6. Graceful fallback
    res.json({
      results: results || [],
      suggestions: [],
    });
  }
}

// Helper to get API key based on provider
function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'groq':
      return process.env.GROQ_API_KEY;
    default:
      return undefined;
  }
}

// Helper to call AI provider
async function callAIProvider(
  provider: string,
  apiKey: string,
  data: { query: string; results: any[] }
): Promise<SearchResponse> {
  switch (provider) {
    case 'openai':
      return callOpenAI(apiKey, data);
    case 'anthropic':
      return callAnthropic(apiKey, data);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

// OpenAI implementation
async function callOpenAI(
  apiKey: string,
  data: { query: string; results: any[] }
): Promise<SearchResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful search assistant for ElizaOS documentation.',
        },
        {
          role: 'user',
          content: buildPrompt(data.query, data.results),
        },
      ],
      temperature: 0.3,
      max_tokens: 500,
    }),
  });

  const result = await response.json();
  const content = result.choices[0].message.content;
  
  return parseAIResponse(content, data.results);
}

// Anthropic implementation
async function callAnthropic(
  apiKey: string,
  data: { query: string; results: any[] }
): Promise<SearchResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      messages: [
        {
          role: 'user',
          content: buildPrompt(data.query, data.results),
        },
      ],
      max_tokens: 500,
    }),
  });

  const result = await response.json();
  const content = result.content[0].text;
  
  return parseAIResponse(content, data.results);
}

// Build AI prompt
function buildPrompt(query: string, results: any[]): string {
  const resultsContext = results.slice(0, 5).map((r, idx) => 
    `${idx + 1}. ${r.title}: ${r.content.substring(0, 100)}...`
  ).join('\n');

  return `Search Query: "${query}"

Current search results:
${resultsContext}

Please:
1. Rank these results by relevance (return indices in order)
2. Suggest 3 related searches
3. Extract key highlights from relevant results

Respond in JSON:
{
  "rankedIndices": [1, 3, 2, ...],
  "suggestions": ["...", "...", "..."],
  "highlights": {"1": ["highlight1", "highlight2"], ...}
}`;
}

// Parse AI response
function parseAIResponse(
  aiResponse: string,
  originalResults: any[]
): SearchResponse {
  try {
    const parsed = JSON.parse(aiResponse);
    
    // Build enhanced results
    const results = parsed.rankedIndices
      .filter((idx: number) => idx <= originalResults.length)
      .map((idx: number, rank: number) => {
        const result = originalResults[idx - 1];
        return {
          ...result,
          relevance: 1 - (rank * 0.1),
          highlights: parsed.highlights[idx] || [],
        };
      });

    return {
      results,
      suggestions: parsed.suggestions || [],
    };
  } catch (error) {
    // Fallback if parsing fails
    return {
      results: originalResults.map(r => ({
        ...r,
        relevance: 0.5,
        highlights: [],
      })),
      suggestions: [],
    };
  }
}

// Example Netlify Function wrapper
export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const body = JSON.parse(event.body);
  const mockReq = { body } as Request;
  const mockRes = {
    status: (code: number) => ({
      json: (data: any) => ({
        statusCode: code,
        body: JSON.stringify(data),
      }),
    }),
    json: (data: any) => ({
      statusCode: 200,
      body: JSON.stringify(data),
    }),
  } as any;

  return searchEndpoint(mockReq, mockRes);
};