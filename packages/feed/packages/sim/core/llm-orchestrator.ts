/**
 * LLM Orchestrator — wraps FeedLLMClient with the prompt system.
 */

import { FeedLLMClient } from '@feed/engine';
import type { LLMJsonSchema } from '@feed/engine/llm/types';
import { renderPrompt } from '@feed/engine/prompts';
import type { JsonValue } from '@feed/engine/types/common';
import type { LLMExecuteOptions, LLMOrchestrator } from './types';

export class DefaultLLMOrchestrator implements LLMOrchestrator {
  private readonly client: FeedLLMClient;

  constructor(client?: FeedLLMClient) {
    this.client = client ?? new FeedLLMClient();
  }

  async execute<T>(options: LLMExecuteOptions): Promise<T> {
    const rendered = renderPrompt(
      options.prompt,
      (options.variables ?? {}) as Record<string, JsonValue>
    );
    const result = await this.client.generateJSON(
      rendered,
      options.schema as LLMJsonSchema | undefined,
      { model: options.model }
    );
    return result as T;
  }

  getClient(): FeedLLMClient {
    return this.client;
  }
}
