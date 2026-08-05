/**
 * Clawd Code - xAI API client
 */

export interface XaiUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface XaiTextResponse {
  content: string;
  citations: string[];
  usage?: XaiUsage;
  model?: string;
}

type XaiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type XaiResponseOutputItem = {
  type?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

type XaiResponsesApiResponse = {
  output_text?: string;
  output?: XaiResponseOutputItem[];
  citations?: string[];
  usage?: XaiUsage;
  model?: string;
};

type XaiChatApiResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: XaiUsage;
  model?: string;
};

export class XaiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.x.ai/v1',
  ) {}

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  async chat(options: {
    model: string;
    messages: XaiMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<XaiTextResponse> {
    const response = await this.post<XaiChatApiResponse>('/chat/completions', {
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
    });

    return {
      content: response.choices?.[0]?.message?.content?.trim() ?? '',
      citations: [],
      usage: response.usage,
      model: response.model,
    };
  }

  async responses(options: {
    model: string;
    input: Array<{ role: 'user' | 'system'; content: string }>;
    tools?: Array<{ type: 'web_search' | 'x_search' | 'code_interpreter' }>;
    reasoning?: { effort: 'low' | 'medium' | 'high' };
  }): Promise<XaiTextResponse> {
    const response = await this.post<XaiResponsesApiResponse>('/responses', {
      model: options.model,
      input: options.input,
      tools: options.tools,
      reasoning: options.reasoning,
    });

    return {
      content: extractResponsesText(response).trim(),
      citations: response.citations ?? [],
      usage: response.usage,
      model: response.model,
    };
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`xAI ${response.status}: ${error}`);
    }

    return (await response.json()) as T;
  }
}

export function createXaiClient(apiKey: string | undefined): XaiClient | null {
  if (!apiKey) return null;
  return new XaiClient(apiKey);
}

function extractResponsesText(response: XaiResponsesApiResponse): string {
  if (response.output_text) return response.output_text;

  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}
