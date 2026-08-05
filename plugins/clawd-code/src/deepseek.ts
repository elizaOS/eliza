/**
 * Clawd Code - DeepSeek OpenAI-compatible API client
 */

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface DeepSeekTextResponse {
  content: string;
  usage?: DeepSeekUsage;
  model?: string;
}

type DeepSeekMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type DeepSeekChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: DeepSeekUsage;
  model?: string;
};

export class DeepSeekClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.deepseek.com',
  ) {}

  async chat(options: {
    model: string;
    messages: DeepSeekMessage[];
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
    thinking?: boolean;
  }): Promise<DeepSeekTextResponse> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: false,
    };

    if (options.thinking !== undefined) {
      body.thinking = { type: options.thinking ? 'enabled' : 'disabled' };
    }
    if (options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek ${response.status}: ${error}`);
    }

    const data = (await response.json()) as DeepSeekChatResponse;
    return {
      content: data.choices?.[0]?.message?.content?.trim() ?? '',
      usage: data.usage,
      model: data.model,
    };
  }
}

export function createDeepSeekClient(apiKey: string | undefined, baseUrl?: string): DeepSeekClient | null {
  if (!apiKey) return null;
  return new DeepSeekClient(apiKey, baseUrl);
}
