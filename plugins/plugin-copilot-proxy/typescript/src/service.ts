import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { CopilotProxyClient, CopilotProxyError } from "./client";
import {
  getBaseUrl,
  getContextWindow,
  getLargeModel,
  getMaxTokens,
  getSmallModel,
  getTimeoutSeconds,
  isPluginEnabled,
} from "./environment";
import type { ModelName } from "./types";

/**
 * Service class for managing Copilot Proxy interactions.
 */
export class CopilotProxyService {
  private client: CopilotProxyClient | null = null;
  private initialized = false;
  private runtime: IAgentRuntime | null = null;

  /**
   * Initialize the service with runtime configuration.
   */
  async initialize(runtime: IAgentRuntime): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.runtime = runtime;

    if (!isPluginEnabled(runtime)) {
      logger.info(
        "[CopilotProxy] Plugin is disabled via COPILOT_PROXY_ENABLED=false",
      );
      return;
    }

    try {
      const baseUrl = getBaseUrl(runtime);
      const timeoutSeconds = getTimeoutSeconds(runtime);
      const maxTokens = getMaxTokens(runtime);

      this.client = new CopilotProxyClient(baseUrl, timeoutSeconds, maxTokens);

      // Check if the proxy server is available
      const isAvailable = await this.client.healthCheck();
      if (!isAvailable) {
        logger.warn(
          "[CopilotProxy] Proxy server is not available at " +
            baseUrl +
            ". Make sure the Copilot Proxy VS Code extension is running.",
        );
      } else {
        logger.info(
          "[CopilotProxy] Successfully connected to proxy server at " + baseUrl,
        );
      }

      this.initialized = true;
    } catch (error) {
      logger.error("[CopilotProxy] Failed to initialize: " + String(error));
      throw error;
    }
  }

  /**
   * Check if the service is initialized and available.
   */
  get isAvailable(): boolean {
    return this.initialized && this.client !== null;
  }

  /**
   * Get the underlying client.
   */
  getClient(): CopilotProxyClient | null {
    return this.client;
  }

  /**
   * Get the small model ID.
   */
  getSmallModel(): ModelName {
    if (!this.runtime) {
      throw new Error("Service not initialized");
    }
    return getSmallModel(this.runtime);
  }

  /**
   * Get the large model ID.
   */
  getLargeModel(): ModelName {
    if (!this.runtime) {
      throw new Error("Service not initialized");
    }
    return getLargeModel(this.runtime);
  }

  /**
   * Get the context window size.
   */
  getContextWindow(): number {
    if (!this.runtime) {
      return 128000;
    }
    return getContextWindow(this.runtime);
  }

  /**
   * Get the max tokens setting.
   */
  getMaxTokens(): number {
    if (!this.runtime) {
      return 8192;
    }
    return getMaxTokens(this.runtime);
  }

  /**
   * Generate text using the small model.
   */
  async generateTextSmall(
    prompt: string,
    options: {
      system?: string;
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      stop?: readonly string[];
    } = {},
  ): Promise<string> {
    if (!this.client) {
      throw new Error("CopilotProxy service not initialized");
    }

    const model = this.getSmallModel();
    const result = await this.client.generateText(model, prompt, options);
    return result.text;
  }

  /**
   * Generate text using the large model.
   */
  async generateTextLarge(
    prompt: string,
    options: {
      system?: string;
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      stop?: readonly string[];
    } = {},
  ): Promise<string> {
    if (!this.client) {
      throw new Error("CopilotProxy service not initialized");
    }

    const model = this.getLargeModel();
    const result = await this.client.generateText(model, prompt, options);
    return result.text;
  }

  /**
   * Generate a JSON object using the small model.
   */
  async generateObjectSmall(
    prompt: string,
    options: {
      system?: string;
      maxTokens?: number;
      temperature?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const jsonPrompt = this.buildJsonPrompt(prompt);
    const systemPrompt = this.buildJsonSystemPrompt(options.system);

    const text = await this.generateTextSmall(jsonPrompt, {
      ...options,
      system: systemPrompt,
      temperature: options.temperature ?? 0.2,
    });

    return this.extractJson(text);
  }

  /**
   * Generate a JSON object using the large model.
   */
  async generateObjectLarge(
    prompt: string,
    options: {
      system?: string;
      maxTokens?: number;
      temperature?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const jsonPrompt = this.buildJsonPrompt(prompt);
    const systemPrompt = this.buildJsonSystemPrompt(options.system);

    const text = await this.generateTextLarge(jsonPrompt, {
      ...options,
      system: systemPrompt,
      temperature: options.temperature ?? 0.2,
    });

    return this.extractJson(text);
  }

  /**
   * Build a prompt optimized for JSON output.
   */
  private buildJsonPrompt(prompt: string): string {
    if (
      prompt.includes("```json") ||
      prompt.includes("respond with valid JSON")
    ) {
      return prompt;
    }
    return (
      prompt +
      "\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text."
    );
  }

  /**
   * Build a system prompt for JSON generation.
   */
  private buildJsonSystemPrompt(existingSystem?: string): string {
    if (existingSystem) {
      return `${existingSystem}\nYou must respond with valid JSON only. No markdown, no code blocks, no explanation text.`;
    }
    return "You must respond with valid JSON only. No markdown, no code blocks, no explanation text.";
  }

  /**
   * Extract JSON from a text response.
   */
  private extractJson(text: string): Record<string, unknown> {
    // Try direct parse
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue to other extraction methods
    }

    // Try extracting from code block
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1].trim());
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Continue
      }
    }

    // Try extracting from any code block
    const anyBlockMatch = text.match(/```(?:\w*)\s*([\s\S]*?)\s*```/);
    if (anyBlockMatch) {
      const content = anyBlockMatch[1].trim();
      if (content.startsWith("{") && content.endsWith("}")) {
        try {
          const parsed = JSON.parse(content);
          if (typeof parsed === "object" && parsed !== null) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Continue
        }
      }
    }

    // Try finding JSON object in text
    const jsonObject = this.findJsonObject(text);
    if (jsonObject) {
      try {
        const parsed = JSON.parse(jsonObject);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Continue
      }
    }

    throw new CopilotProxyError(
      "Could not extract valid JSON from model response",
      0,
      text,
    );
  }

  /**
   * Find a JSON object in text.
   */
  private findJsonObject(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return trimmed;
    }

    let best: string | null = null;
    let depth = 0;
    let start: number | null = null;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === "{") {
        if (depth === 0) {
          start = i;
        }
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0 && start !== null) {
          const candidate = text.slice(start, i + 1);
          if (best === null || candidate.length > best.length) {
            best = candidate;
          }
        }
      }
    }

    return best;
  }

  /**
   * Shutdown the service.
   */
  async shutdown(): Promise<void> {
    this.client = null;
    this.initialized = false;
    this.runtime = null;
    logger.info("[CopilotProxy] Service shut down");
  }
}

/**
 * Singleton instance of the Copilot Proxy service.
 */
let serviceInstance: CopilotProxyService | null = null;

/**
 * Get or create the Copilot Proxy service instance.
 */
export function getCopilotProxyService(): CopilotProxyService {
  if (!serviceInstance) {
    serviceInstance = new CopilotProxyService();
  }
  return serviceInstance;
}
