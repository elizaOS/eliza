/**
 * Clawd Code — OpenRouter Adapter
 * OpenAI-compatible API for OpenRouter models (with reasoning support)
 * Default free model: nvidia/nemotron-3-ultra-550b-a55b:free
 */

export interface OpenRouterMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning_details?: unknown;
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  stream?: boolean;
  reasoning?: { enabled: boolean; effort?: 'low' | 'medium' | 'high' };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
      reasoning_details?: unknown;
    };
    finish_reason: string;
  }>;
  usage?: OpenRouterUsage;
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_NEMO_MODEL1 = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const OPENROUTER_NEMO_MODEL2 = 'nvidia/nemotron-3-ultra-550b-a55b';
export const OPENROUTER_NEMO_MODEL3 = 'nvidia/nemotron-3-super-120b-a12b:free';
export const OPENROUTER_FABLE5 = 'anthropic/claude-fable-5';
export const OPENROUTER_FABLE_LATESY = '~anthropic/claude-fable-latest';
export const OPENROUTER_FABLE_LATEST = OPENROUTER_FABLE_LATESY;
export const OPENROUTER_AUTO_MODEL = 'auto';
export const DEFAULT_FREE_MODEL = OPENROUTER_NEMO_MODEL1;

export type OpenRouterPromptMode = 'code' | 'research' | 'repl' | 'trade' | 'general';
export type OpenRouterRoute = 'fast' | 'balanced' | 'intelligent' | 'explicit';

export interface OpenRouterNemoModels {
  model1: string;
  model2: string;
  model3: string;
  balanced: string;
  intelligent: string;
  fast: string;
}

export interface OpenRouterFableModels {
  fable5: string;
  latest: string;
}

export interface OpenRouterProviderModels extends OpenRouterNemoModels, OpenRouterFableModels {}

export interface OpenRouterModelSelection {
  model: string;
  route: OpenRouterRoute;
  reason: string;
  explicit: boolean;
  reasoning?: OpenRouterRequest['reasoning'];
}

function envValue(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const value = env[key]?.trim();
  return value || fallback;
}

export function getOpenRouterNemoModels(
  env: Record<string, string | undefined> = process.env,
): OpenRouterNemoModels {
  const model1 = envValue(
    env,
    'OPENROUTER_NEMO_MODEL1',
    envValue(env, 'OPENROUTER_FREE_MODEL', OPENROUTER_NEMO_MODEL1),
  );
  const model2 = envValue(env, 'OPENROUTER_NEMO_MODEL2', OPENROUTER_NEMO_MODEL2);
  const model3 = envValue(env, 'OPENROUTER_NEMO_MODEL3', OPENROUTER_NEMO_MODEL3);

  return {
    model1,
    model2,
    model3,
    balanced: model1,
    intelligent: model2 || model1,
    fast: model3 || model1,
  };
}

export function getOpenRouterFableModels(
  env: Record<string, string | undefined> = process.env,
): OpenRouterFableModels {
  const fable5 = envValue(env, 'OPENROUTER_FABLE5', OPENROUTER_FABLE5);
  const latest = envValue(
    env,
    'OPENROUTER_FABLE_LATESY',
    envValue(env, 'OPENROUTER_FABLE_LATEST', OPENROUTER_FABLE_LATESY),
  );

  return { fable5, latest };
}

export function getOpenRouterProviderModels(
  env: Record<string, string | undefined> = process.env,
): OpenRouterProviderModels {
  return {
    ...getOpenRouterNemoModels(env),
    ...getOpenRouterFableModels(env),
  };
}

export function isOpenRouterAutoModel(model: string | undefined): boolean {
  const normalized = (model ?? '').trim().toLowerCase();
  return (
    !normalized ||
    normalized === OPENROUTER_AUTO_MODEL ||
    normalized === 'smart' ||
    normalized === 'router' ||
    normalized === 'or-auto' ||
    normalized === 'nemo-auto' ||
    normalized === 'openrouter-auto' ||
    normalized === 'openrouter/nemo-auto' ||
    normalized.startsWith('grok-')
  );
}

function normalizeOpenRouterRequestedModel(
  model: string,
  env?: Record<string, string | undefined>,
): string {
  const normalized = model.trim().toLowerCase();
  const nemo = getOpenRouterNemoModels(env);
  const fable = getOpenRouterFableModels(env);
  const aliases: Record<string, string> = {
    'nemo-ultra-free': nemo.model1,
    'nemo-balanced': nemo.model1,
    'openrouter-nemo': nemo.model1,
    'or-nemo': nemo.model1,
    'nemo-ultra': nemo.model2,
    'nemo-intelligent': nemo.model2,
    'or-intelligent': nemo.model2,
    'nemo-super-free': nemo.model3,
    'nemo-fast': nemo.model3,
    'or-fast': nemo.model3,
    fable: fable.latest,
    fable5: fable.fable5,
    'fable-5': fable.fable5,
    'claude-fable-5': fable.fable5,
    'openrouter-fable5': fable.fable5,
    'or-fable5': fable.fable5,
    'fable-latest': fable.latest,
    'claude-fable-latest': fable.latest,
    'openrouter-fable-latest': fable.latest,
    'or-fable-latest': fable.latest,
  };

  return aliases[normalized] ?? model.trim();
}

export function classifyOpenRouterPrompt(
  prompt: string,
  mode: OpenRouterPromptMode = 'general',
): Exclude<OpenRouterRoute, 'explicit'> {
  const text = prompt.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  if (mode === 'research') return 'intelligent';

  const intelligentKeywords = [
    'agent',
    'anchor',
    'architecture',
    'audit',
    'build',
    'complex',
    'concurrency',
    'debug',
    'deep',
    'design',
    'exploit',
    'failing',
    'implement',
    'migration',
    'multi-file',
    'performance',
    'production',
    'refactor',
    'research',
    'security',
    'solana',
    'strategy',
    'test suite',
    'trade',
  ];
  const fastKeywords = [
    'brief',
    'command',
    'explain',
    'fast',
    'format',
    'one-liner',
    'quick',
    'rename',
    'short',
    'simple',
    'summarize',
    'syntax',
    'typo',
  ];

  if (
    prompt.length > 1200 ||
    wordCount > 180 ||
    intelligentKeywords.some((keyword) => text.includes(keyword))
  ) {
    return 'intelligent';
  }

  if (wordCount <= 28 || fastKeywords.some((keyword) => text.includes(keyword))) {
    return 'fast';
  }

  return 'balanced';
}

export function selectOpenRouterModel(options: {
  prompt: string;
  mode?: OpenRouterPromptMode;
  requestedModel?: string;
  env?: Record<string, string | undefined>;
}): OpenRouterModelSelection {
  const requested = options.requestedModel?.trim();
  const requestedModel = requested
    ? normalizeOpenRouterRequestedModel(requested, options.env)
    : undefined;
  if (requestedModel && !isOpenRouterAutoModel(requestedModel)) {
    return {
      model: requestedModel,
      route: 'explicit',
      reason: 'explicit model requested',
      explicit: true,
    };
  }

  const models = getOpenRouterNemoModels(options.env);
  const route = classifyOpenRouterPrompt(options.prompt, options.mode);
  const reasoning: OpenRouterRequest['reasoning'] | undefined =
    route === 'fast'
      ? undefined
      : { enabled: true, effort: route === 'intelligent' ? 'high' : 'medium' };

  if (route === 'intelligent') {
    return {
      model: models.intelligent,
      route,
      reason: options.mode === 'research' ? 'research mode' : 'complex prompt',
      explicit: false,
      reasoning,
    };
  }

  if (route === 'fast') {
    return {
      model: models.fast,
      route,
      reason: 'short/simple prompt',
      explicit: false,
      reasoning,
    };
  }

  return {
    model: models.balanced,
    route,
    reason: 'balanced prompt',
    explicit: false,
    reasoning,
  };
}

export class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(apiKey: string, baseUrl: string = OPENROUTER_BASE_URL, defaultModel: string = DEFAULT_FREE_MODEL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.defaultModel = defaultModel;
  }

  /**
   * Send a chat completion request (non-streaming)
   */
  async chat(request: Omit<OpenRouterRequest, 'stream'>): Promise<OpenRouterResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://x402.wtf',
        'X-Title': 'Clawd Code',
      },
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${error}`);
    }

    return response.json() as Promise<OpenRouterResponse>;
  }

  /**
   * Stream a chat completion (yields text deltas + reasoning tokens)
   */
  async *stream(request: Omit<OpenRouterRequest, 'stream'>): AsyncGenerator<{
    content: string;
    reasoning?: string;
    usage?: OpenRouterUsage;
    done: boolean;
  }> {
    const url = `${this.baseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://x402.wtf',
        'X-Title': 'Clawd Code',
      },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let finalUsage: OpenRouterUsage | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { content: '', done: true, usage: finalUsage };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            const content = delta?.content || '';
            const reasoning = delta?.reasoning || '';
            if (parsed.usage) finalUsage = parsed.usage;
            yield { content, reasoning, usage: finalUsage, done: false };
          } catch {
            // Skip malformed lines
          }
        }
      }
    }
  }

  /**
   * Quick prompt helper — returns just the text content
   */
  async prompt(userMessage: string, options: {
    model?: string;
    systemPrompt?: string;
    reasoning?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'high';
    maxTokens?: number;
  } = {}): Promise<{ content: string; reasoning_details?: unknown; usage?: OpenRouterUsage; model: string }> {
    const messages: OpenRouterMessage[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: userMessage });

    const response = await this.chat({
      model: options.model || this.defaultModel,
      messages,
      reasoning: options.reasoning !== false ? { enabled: true, effort: options.reasoningEffort } : undefined,
      max_tokens: options.maxTokens,
    });

    const message = response.choices[0]?.message;
    return {
      content: message?.content || '',
      reasoning_details: message?.reasoning_details,
      usage: response.usage,
      model: response.model,
    };
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }
}

/**
 * Create an OpenRouter client from env vars
 */
export function createOpenRouterClient(env: Record<string, string>): OpenRouterClient | null {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const models = getOpenRouterNemoModels(env);

  return new OpenRouterClient(
    apiKey,
    env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
    models.balanced,
  );
}
