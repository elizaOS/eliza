/**
 * vLLM Inference Client for Benchmarking
 *
 * Standalone client that calls vLLM's OpenAI-compatible API for model inference.
 * Used by the benchmark suite to evaluate trained models without requiring
 * the full ElizaOS stack.
 *
 * Features:
 * - OpenAI-compatible API calls to vLLM
 * - Support for LoRA adapters via model path
 * - Automatic health checking
 * - Configurable timeout and retry logic
 * - JSON mode support for structured outputs
 *
 * @example
 * ```typescript
 * const client = new VLLMInferenceClient({
 *   baseUrl: 'http://localhost:9001',
 *   model: 'Qwen/Qwen3-4B',
 *   adapterPath: './trained_models/final_model',
 * });
 *
 * await client.waitForReady();
 * const response = await client.complete({
 *   systemPrompt: 'You are a trading agent.',
 *   userPrompt: 'Analyze the market.',
 * });
 * ```
 */

import { logger } from '../utils/logger';

export interface VLLMClientConfig {
  /** vLLM server base URL (default: http://localhost:9001) */
  baseUrl: string;

  /** Base model name */
  model: string;

  /** Path to LoRA adapter (optional) */
  adapterPath?: string;

  /** Request timeout in ms (default: 60000) */
  timeoutMs?: number;

  /** Max retries for failed requests (default: 3) */
  maxRetries?: number;

  /** Health check interval in ms (default: 2000) */
  healthCheckIntervalMs?: number;

  /** Max wait time for vLLM ready in ms (default: 300000 = 5 min) */
  maxWaitTimeMs?: number;
}

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface CompletionResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

interface OpenAICompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Standalone vLLM inference client for benchmarking trained models.
 */
export class VLLMInferenceClient {
  private config: Required<VLLMClientConfig>;
  private _ready: boolean = false;

  /** Check if client is ready */
  get isReady(): boolean {
    return this._ready;
  }

  constructor(config: VLLMClientConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      model: config.model,
      adapterPath: config.adapterPath || '',
      timeoutMs: config.timeoutMs ?? 60000,
      // Ensure at least 1 attempt (maxRetries=0 would mean zero attempts)
      maxRetries: Math.max(1, config.maxRetries ?? 3),
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 2000,
      maxWaitTimeMs: config.maxWaitTimeMs ?? 300000,
    };
  }

  /**
   * Get the effective model name (with adapter if specified)
   */
  getModelName(): string {
    // vLLM uses the adapter path as the model name when LoRA is loaded
    if (this.config.adapterPath) {
      return this.config.adapterPath;
    }
    return this.config.model;
  }

  /**
   * Check if vLLM server is healthy
   */
  async isHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.config.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get available models from vLLM
   */
  async getModels(): Promise<string[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as {
        data: Array<{ id: string }>;
      };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Wait for vLLM server to be ready
   */
  async waitForReady(): Promise<void> {
    const startTime = Date.now();

    logger.info('Waiting for vLLM server...', {
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      adapterPath: this.config.adapterPath || 'none',
    });

    while (Date.now() - startTime < this.config.maxWaitTimeMs) {
      if (await this.isHealthy()) {
        const models = await this.getModels();
        logger.info('vLLM server ready', { models });
        this._ready = true;
        return;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.config.healthCheckIntervalMs)
      );
    }

    throw new Error(
      `vLLM server not ready after ${this.config.maxWaitTimeMs / 1000}s`
    );
  }

  /**
   * Complete a prompt using vLLM
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();

    const messages = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ];

    const body: Record<string, unknown> = {
      model: this.getModelName(),
      messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 1024,
    };

    // Add JSON mode if requested (vLLM supports guided decoding)
    if (request.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs
      );

      try {
        const response = await fetch(
          `${this.config.baseUrl}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`vLLM error ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as OpenAICompletionResponse;
        const latencyMs = Date.now() - startTime;

        return {
          content: data.choices[0]?.message.content || '',
          model: data.model,
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
          latencyMs,
        };
      } catch (error) {
        lastError = error as Error;
        logger.warn(`vLLM request failed (attempt ${attempt + 1})`, {
          error: lastError.message,
        });

        if (attempt < this.config.maxRetries - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * (attempt + 1))
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError || new Error('vLLM request failed');
  }

  /**
   * Complete with structured JSON output
   */
  async completeJson<T>(
    request: CompletionRequest,
    validator?: (data: unknown) => data is T
  ): Promise<T> {
    const response = await this.complete({
      ...request,
      jsonMode: true,
    });

    // Parse JSON from response
    let jsonText = response.content.trim();

    // Strip markdown code blocks if present
    jsonText = jsonText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    // Extract JSON object
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Response is not valid JSON: ${response.content}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as T;

    if (validator && !validator(parsed)) {
      throw new Error(`Response failed validation: ${JSON.stringify(parsed)}`);
    }

    return parsed;
  }
}

/**
 * Create a vLLM client from environment variables
 */
export function createVLLMClientFromEnv(): VLLMInferenceClient {
  const baseUrl = process.env.VLLM_URL || 'http://localhost:9001';
  const model =
    process.env.VLLM_MODEL || process.env.BASE_MODEL || 'Qwen/Qwen3-4B';
  const adapterPath = process.env.MODEL_PATH || process.env.ADAPTER_PATH || '';

  return new VLLMInferenceClient({
    baseUrl,
    model,
    adapterPath: adapterPath || undefined,
  });
}
