/**
 * Clawd Code - Z.AI OpenAI-compatible API client
 * Supports GLM-5.2 chat, GLM-5V vision, GLM-Image generation, and thinking mode.
 */

export const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const ZAI_AGENT_BASE_URL = 'https://api.z.ai/api/v1';
export const ZAI_DEFAULT_MODEL = 'glm-5.2';
export const ZAI_FAST_MODEL = 'glm-5-turbo';
export const ZAI_VISION_MODEL = 'glm-5v-turbo';
export const ZAI_TRADE_VISION_MODEL = 'glm-5v-turbo';
export const ZAI_VISION_FAST_MODEL = 'glm-4.6v-flashx';
export const ZAI_IMAGE_MODEL = 'glm-image';
export const ZAI_IMAGE_FALLBACK_MODEL = 'cogview-4';
export const ZAI_SLIDE_AGENT_ID = 'slides_glm_agent';

export type ZaiThinkingType = 'enabled' | 'disabled';
export type ZaiReasoningEffort = 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

export type ZaiMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

export interface ZaiMessage {
  role: 'system' | 'user' | 'assistant';
  content: ZaiMessageContent;
}

export interface ZaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ZaiTextResponse {
  content: string;
  reasoningContent?: string;
  usage?: ZaiUsage;
  model?: string;
}

export interface ZaiImageResponse {
  url?: string;
  b64Json?: string;
  model?: string;
}

export interface ZaiEnvConfig {
  baseUrl: string;
  agentBaseUrl: string;
  model: string;
  fastModel: string;
  chartModel: string;
  visionModel: string;
  tradeVisionModel: string;
  chartVisionModel: string;
  visionFastModel: string;
  imageModel: string;
  thinkingType: ZaiThinkingType;
  reasoningEffort: ZaiReasoningEffort;
}

export interface ZaiSlideAgentPage {
  position: number;
  width?: number;
  height?: number;
}

export interface ZaiSlideAgentRequestOptions {
  prompt: string;
  stream?: boolean;
  conversationId?: string;
  requestId?: string;
}

export interface ZaiSlideAgentExportOptions {
  conversationId: string;
  includePdf?: boolean;
  pages?: ZaiSlideAgentPage[];
}

export type ZaiSlideAgentContentItem = {
  type?: string;
  tag_cn?: string;
  tag_en?: string;
  text?: string;
  file_url?: string;
  image_url?: string;
  object?: {
    tool_name?: string;
    input?: string;
    output?: string;
    position?: number[];
  };
};

export interface ZaiSlideAgentMessage {
  role?: string;
  phase?: string;
  content?: ZaiSlideAgentContentItem[];
}

export interface ZaiSlideAgentChoice {
  index?: number;
  finish_reason?: string;
  message?: ZaiSlideAgentMessage[];
  messages?: ZaiSlideAgentMessage[];
}

export interface ZaiSlideAgentResponse {
  id?: string;
  conversation_id?: string;
  agent_id?: string;
  choices?: ZaiSlideAgentChoice[];
  error?: {
    code?: string;
    message?: string;
  };
}

type ZaiChatApiResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: ZaiUsage;
  model?: string;
};

type ZaiSseChatChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: ZaiUsage;
  model?: string;
};

type ZaiImageApiResponse = {
  data?: Array<{
    url?: string;
    b64_json?: string;
  }>;
  model?: string;
};

function envValue(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const value = env[key]?.trim();
  return value || fallback;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function normalizeZaiThinking(value: string | undefined): ZaiThinkingType {
  const normalized = (value ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no', 'disabled', 'disable'].includes(normalized)) return 'disabled';
  return 'enabled';
}

export function normalizeZaiReasoningEffort(value: string | undefined): ZaiReasoningEffort {
  const normalized = (value ?? '').trim().toLowerCase();
  if (['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'].includes(normalized)) {
    return normalized as ZaiReasoningEffort;
  }
  return 'max';
}

export function getZaiEnvConfig(env: Record<string, string | undefined> = process.env): ZaiEnvConfig {
  const model = envValue(env, 'ZAI_MODEL', ZAI_DEFAULT_MODEL);
  const visionModel = envValue(env, 'ZAI_VISION_MODEL', ZAI_VISION_MODEL);
  const tradeVisionModel = envValue(env, 'ZAI_TRADE_VISION_MODEL', visionModel || ZAI_TRADE_VISION_MODEL);
  return {
    baseUrl: normalizeBaseUrl(envValue(env, 'ZAI_BASE_URL', ZAI_BASE_URL)),
    agentBaseUrl: normalizeBaseUrl(envValue(env, 'ZAI_AGENT_BASE_URL', ZAI_AGENT_BASE_URL)),
    model,
    fastModel: envValue(env, 'ZAI_FAST_MODEL', ZAI_FAST_MODEL),
    chartModel: envValue(env, 'ZAI_CHART_MODEL', model),
    visionModel,
    tradeVisionModel,
    chartVisionModel: envValue(env, 'ZAI_CHART_VISION_MODEL', tradeVisionModel),
    visionFastModel: envValue(env, 'ZAI_VISION_FAST_MODEL', ZAI_VISION_FAST_MODEL),
    imageModel: envValue(env, 'ZAI_IMAGE_MODEL', ZAI_IMAGE_MODEL),
    thinkingType: normalizeZaiThinking(env.ZAI_THINKING),
    reasoningEffort: normalizeZaiReasoningEffort(env.ZAI_REASONING_EFFORT),
  };
}

export function buildZaiSlideAgentRequest(options: ZaiSlideAgentRequestOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agent_id: ZAI_SLIDE_AGENT_ID,
    stream: options.stream ?? false,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: options.prompt,
          },
        ],
      },
    ],
  };
  if (options.conversationId) body.conversation_id = options.conversationId;
  if (options.requestId) body.request_id = options.requestId;
  return body;
}

export function buildZaiSlideAgentExportRequest(options: ZaiSlideAgentExportOptions): Record<string, unknown> {
  return {
    agent_id: ZAI_SLIDE_AGENT_ID,
    conversation_id: options.conversationId,
    custom_variables: {
      include_pdf: options.includePdf ?? true,
      ...(options.pages?.length ? { pages: options.pages } : {}),
    },
  };
}

export function extractZaiSlideAgentText(response: ZaiSlideAgentResponse): string {
  const chunks: string[] = [];
  for (const choice of response.choices ?? []) {
    for (const message of choice.message ?? choice.messages ?? []) {
      for (const content of message.content ?? []) {
        if (content.text) chunks.push(content.text);
        if (content.object?.output) chunks.push(content.object.output);
      }
    }
  }
  return chunks.join('\n').trim();
}

export function extractZaiSlideAgentUrls(response: ZaiSlideAgentResponse): Array<{ type: 'file' | 'image'; url: string; tag?: string }> {
  const urls: Array<{ type: 'file' | 'image'; url: string; tag?: string }> = [];
  for (const choice of response.choices ?? []) {
    for (const message of choice.message ?? choice.messages ?? []) {
      for (const content of message.content ?? []) {
        const tag = content.tag_en || content.tag_cn;
        if (content.file_url) urls.push({ type: 'file', url: content.file_url, tag });
        if (content.image_url) urls.push({ type: 'image', url: content.image_url, tag });
      }
    }
  }
  return urls;
}

export class ZaiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = ZAI_BASE_URL,
  ) {}

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  async chat(options: {
    model: string;
    messages: ZaiMessage[];
    maxTokens?: number;
    temperature?: number;
    thinking?: ZaiThinkingType;
    reasoningEffort?: ZaiReasoningEffort;
  }): Promise<ZaiTextResponse> {
    const response = await this.post<ZaiChatApiResponse>('/chat/completions', {
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      thinking: { type: options.thinking ?? 'enabled' },
      reasoning_effort: options.reasoningEffort,
    });

    const message = response.choices?.[0]?.message;
    return {
      content: message?.content?.trim() ?? '',
      reasoningContent: message?.reasoning_content,
      usage: response.usage,
      model: response.model,
    };
  }

  async *streamChat(options: {
    model: string;
    messages: ZaiMessage[];
    maxTokens?: number;
    temperature?: number;
    thinking?: ZaiThinkingType;
    reasoningEffort?: ZaiReasoningEffort;
  }): AsyncGenerator<{ text: string; reasoning?: string; done: boolean; usage?: ZaiUsage; model?: string }> {
    const response = await fetch(`${normalizeBaseUrl(this.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: this.headers('text/event-stream'),
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        thinking: { type: options.thinking ?? 'enabled' },
        reasoning_effort: options.reasoningEffort,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Z.AI ${response.status}: ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Z.AI stream: no response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let finalUsage: ZaiUsage | undefined;
    let finalModel: string | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as ZaiSseChatChunk;
          const delta = parsed.choices?.[0]?.delta;
          if (parsed.usage) finalUsage = parsed.usage;
          if (parsed.model) finalModel = parsed.model;
          yield {
            text: delta?.content ?? '',
            reasoning: delta?.reasoning_content,
            done: false,
          };
        } catch {
          // Skip malformed SSE frames.
        }
      }
    }

    yield { text: '', done: true, usage: finalUsage, model: finalModel };
  }

  async analyzeImage(options: {
    model: string;
    prompt: string;
    imageUrl: string;
    maxTokens?: number;
    thinking?: ZaiThinkingType;
    reasoningEffort?: ZaiReasoningEffort;
  }): Promise<ZaiTextResponse> {
    return this.chat({
      model: options.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: options.imageUrl } },
            { type: 'text', text: options.prompt },
          ],
        },
      ],
      maxTokens: options.maxTokens,
      thinking: options.thinking,
      reasoningEffort: options.reasoningEffort,
    });
  }

  async generateImage(options: {
    model: string;
    prompt: string;
    size?: string;
  }): Promise<ZaiImageResponse> {
    const response = await this.post<ZaiImageApiResponse>('/images/generations', {
      model: options.model,
      prompt: options.prompt,
      size: options.size,
    });
    const first = response.data?.[0] ?? {};
    return {
      url: first.url,
      b64Json: first.b64_json,
      model: response.model ?? options.model,
    };
  }

  private headers(accept?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en',
      ...(accept ? { Accept: accept } : {}),
    };
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${normalizeBaseUrl(this.baseUrl)}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Z.AI ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }
}

export class ZaiAgentClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = ZAI_AGENT_BASE_URL,
  ) {}

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  async createSlidePoster(options: ZaiSlideAgentRequestOptions): Promise<ZaiSlideAgentResponse> {
    return this.post<ZaiSlideAgentResponse>('/agents', buildZaiSlideAgentRequest(options));
  }

  async getSlidePosterExport(options: ZaiSlideAgentExportOptions): Promise<ZaiSlideAgentResponse> {
    return this.post<ZaiSlideAgentResponse>('/agents/conversation', buildZaiSlideAgentExportRequest(options));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en',
    };
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${normalizeBaseUrl(this.baseUrl)}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Z.AI Agent ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }
}

export function createZaiClient(apiKey: string | undefined, baseUrl?: string): ZaiClient | null {
  if (!apiKey) return null;
  return new ZaiClient(apiKey, baseUrl);
}

export function createZaiAgentClient(apiKey: string | undefined, baseUrl?: string): ZaiAgentClient | null {
  if (!apiKey) return null;
  return new ZaiAgentClient(apiKey, baseUrl);
}

export function createZaiClientFromEnv(env: Record<string, string | undefined>): ZaiClient | null {
  const config = getZaiEnvConfig(env);
  return createZaiClient(env.ZAI_API_KEY, config.baseUrl);
}

export function createZaiAgentClientFromEnv(env: Record<string, string | undefined>): ZaiAgentClient | null {
  const config = getZaiEnvConfig(env);
  return createZaiAgentClient(env.ZAI_API_KEY, config.agentBaseUrl);
}
