/**
 * LLM Orchestrator — wraps BabylonLLMClient with the prompt system.
 */

import { BabylonLLMClient } from "@babylon/engine";
import type { JsonValue, LLMJsonSchema } from "@babylon/engine";
import { renderPrompt } from "@babylon/engine";
import type { LLMExecuteOptions, LLMOrchestrator } from "./types";

export class DefaultLLMOrchestrator implements LLMOrchestrator {
  private readonly client: BabylonLLMClient;

  constructor(client?: BabylonLLMClient) {
    this.client = client ?? new BabylonLLMClient();
  }

  async execute<T>(options: LLMExecuteOptions): Promise<T> {
    const rendered = renderPrompt(
      options.prompt,
      (options.variables ?? {}) as Record<string, JsonValue>,
    );
    const result = await this.client.generateJSON(
      rendered,
      options.schema as LLMJsonSchema | undefined,
      { model: options.model },
    );
    return result as T;
  }

  getClient(): BabylonLLMClient {
    return this.client;
  }
}
