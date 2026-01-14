/**
 * Model classes and configurations
 * Converted from sweagent/agent/models.py
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import axios from "axios";
import { z } from "zod";
import {
  ContentPolicyViolationError,
  ContextWindowExceededError,
  EOFError,
  InstanceCallLimitExceededError,
  InstanceCostLimitExceededError,
  RetryWithOutputError,
  TotalCostLimitExceededError,
} from "../exceptions";
import type { History, HistoryItem } from "../types";
import { getLogger } from "../utils/log";
import type { ToolConfig } from "./agents";
import type { APIResponse, ModelOutput } from "./types";
import { calculateCost } from "./utils/model-pricing";

const logger = getLogger("models");

/**
 * Retry configuration
 */
export const RetryConfigSchema = z.object({
  retries: z.number().default(20),
  minWait: z.number().default(10),
  maxWait: z.number().default(120),
});

export type RetryConfig = z.infer<typeof RetryConfigSchema>;

/**
 * Generic API model configuration
 */
export const GenericAPIModelConfigSchema = z.object({
  name: z.string().describe("Name of the model"),
  perInstanceCostLimit: z
    .number()
    .default(3.0)
    .describe("Cost limit for every instance (task)"),
  totalCostLimit: z.number().default(0.0).describe("Total cost limit"),
  perInstanceCallLimit: z
    .number()
    .default(0)
    .describe("Per instance call limit"),
  temperature: z.number().default(0.0).describe("Sampling temperature"),
  topP: z.number().nullable().default(1.0).describe("Sampling top-p"),
  apiBase: z.string().nullable().optional(),
  apiVersion: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional().describe("API key to the model"),
  stop: z.array(z.string()).default([]).describe("Custom stop sequences"),
  completionKwargs: z
    .record(z.string(), z.any())
    .default(() => ({}))
    .describe("Additional kwargs for completion"),
  convertSystemToUser: z
    .boolean()
    .default(false)
    .describe("Whether to convert system messages to user messages"),
  retry: RetryConfigSchema.default(() => ({
    retries: 20,
    minWait: 10,
    maxWait: 120,
  })),
  delay: z.number().default(0.0).describe("Minimum delay before querying"),
  fallbacks: z.array(z.record(z.string(), z.any())).default(() => []),
  chooseApiKeyByThread: z.boolean().default(true),
  maxInputTokens: z.number().nullable().optional(),
  maxOutputTokens: z.number().nullable().optional(),
  litellmModelRegistry: z.string().nullable().optional(),
  customTokenizer: z.record(z.string(), z.any()).nullable().optional(),
});

export type GenericAPIModelConfig = z.infer<typeof GenericAPIModelConfigSchema>;

/**
 * Human model configuration
 */
export const HumanModelConfigSchema = z.object({
  name: z.literal("human"),
  costPerCall: z.number().default(0),
  catchEof: z.boolean().optional(),
});

export type HumanModelConfig = z.infer<typeof HumanModelConfigSchema>;

/**
 * Replay model configuration
 */
export const ReplayModelConfigSchema = z.object({
  name: z.literal("replay"),
  replayPath: z.string(),
});

export type ReplayModelConfig = z.infer<typeof ReplayModelConfigSchema>;

/**
 * Instant empty submit model configuration
 */
export interface InstantEmptySubmitModelConfig {
  name: "instant_empty_submit";
  delay?: number;
}

/**
 * Human thought model configuration
 */
export interface HumanThoughtModelConfig {
  name: "human_thought";
  catchEof?: boolean;
}

/**
 * Union type for all model configurations
 */
export type ModelConfig =
  | GenericAPIModelConfig
  | HumanModelConfig
  | ReplayModelConfig
  | InstantEmptySubmitModelConfig
  | HumanThoughtModelConfig;

/**
 * Global statistics tracking
 */
export class GlobalStats {
  totalCost: number = 0;
  lastQueryTimestamp: number = 0;

  addCost(cost: number): void {
    this.totalCost += cost;
  }

  updateTimestamp(): void {
    this.lastQueryTimestamp = Date.now() / 1000;
  }
}

/**
 * Instance-specific statistics
 */
export class InstanceStats {
  instanceCost: number = 0;
  tokensSent: number = 0;
  tokensReceived: number = 0;
  apiCalls: number = 0;

  add(other: InstanceStats): InstanceStats {
    const result = new InstanceStats();
    result.instanceCost = this.instanceCost + other.instanceCost;
    result.tokensSent = this.tokensSent + other.tokensSent;
    result.tokensReceived = this.tokensReceived + other.tokensReceived;
    result.apiCalls = this.apiCalls + other.apiCalls;
    return result;
  }

  subtract(other: InstanceStats): InstanceStats {
    const result = new InstanceStats();
    result.instanceCost = this.instanceCost - other.instanceCost;
    result.tokensSent = this.tokensSent - other.tokensSent;
    result.tokensReceived = this.tokensReceived - other.tokensReceived;
    result.apiCalls = this.apiCalls - other.apiCalls;
    return result;
  }
}

/**
 * Abstract base class for all models
 */
export abstract class AbstractModel {
  protected config: ModelConfig;
  protected stats: InstanceStats;
  protected globalStats: GlobalStats;
  protected tools: ToolConfig;

  constructor(config: ModelConfig, tools: ToolConfig) {
    this.config = config;
    this.tools = tools;
    this.stats = new InstanceStats();
    this.globalStats = new GlobalStats();
  }

  resetStats(): void {
    this.stats = new InstanceStats();
  }

  getStats(): InstanceStats {
    return this.stats;
  }

  abstract query(
    history: History,
    temperature?: number,
    n?: number,
  ): Promise<ModelOutput | ModelOutput[]>;

  get instanceCostLimit(): number {
    return (
      ("perInstanceCostLimit" in this.config
        ? this.config.perInstanceCostLimit
        : 0) || 0
    );
  }

  protected checkCostLimits(): void {
    if (
      "perInstanceCostLimit" in this.config &&
      this.config.perInstanceCostLimit > 0 &&
      this.stats.instanceCost >= this.config.perInstanceCostLimit
    ) {
      throw new InstanceCostLimitExceededError(
        `Instance cost ${this.stats.instanceCost} exceeds limit ${this.config.perInstanceCostLimit}`,
      );
    }

    if (
      "totalCostLimit" in this.config &&
      this.config.totalCostLimit > 0 &&
      this.globalStats.totalCost >= this.config.totalCostLimit
    ) {
      throw new TotalCostLimitExceededError(
        `Total cost ${this.globalStats.totalCost} exceeds limit ${this.config.totalCostLimit}`,
      );
    }

    if (
      "perInstanceCallLimit" in this.config &&
      this.config.perInstanceCallLimit > 0 &&
      this.stats.apiCalls >= this.config.perInstanceCallLimit
    ) {
      throw new InstanceCallLimitExceededError(
        `API calls ${this.stats.apiCalls} exceeds limit ${this.config.perInstanceCallLimit}`,
      );
    }
  }
}

/**
 * Human model for interactive input
 */
export class HumanModel extends AbstractModel {
  protected historyPath?: string;
  protected catchEof: boolean;

  constructor(config: HumanModelConfig, tools: ToolConfig) {
    super(config, tools);
    this.historyPath =
      process.env.HISTFILE ||
      path.join(process.env.HOME || ".", ".swe_agent_history");
    this.catchEof = config.catchEof !== false; // Default to true
    this.loadReadlineHistory();
  }

  protected loadReadlineHistory(): void {
    // In Node.js, readline history handling is different
    // We'd need to implement custom history management
  }

  protected updateStats(): void {
    this.stats.apiCalls++;
    const config = this.config as HumanModelConfig;
    this.stats.instanceCost += config.costPerCall || 0;
    this.globalStats.addCost(config.costPerCall || 0);
    this.globalStats.updateTimestamp();
    this.checkCostLimits();
  }

  async query(
    _history: History,
    actionPrompt: string | number = "> ",
    n?: number,
  ): Promise<ModelOutput | ModelOutput[]> {
    this.updateStats();

    const prompt = typeof actionPrompt === "string" ? actionPrompt : "> ";

    // Create readline interface
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt,
    });

    return new Promise((resolve, _reject) => {
      // Handle EOF (Ctrl+D)
      rl.on("close", () => {
        if (!this.catchEof) {
          // Re-raise EOFError when catchEof is disabled
          throw new EOFError();
        }
        console.log("\nGoodbye!");
        const result: ModelOutput = {
          message: "exit",
        };
        resolve(n ? [result] : result);
      });

      rl.question(prompt, (answer) => {
        // Check if answer is null (EOF)
        if (answer === null) {
          rl.close();
          return;
        }

        rl.close();

        // Handle special commands
        if (answer.startsWith("RAISE_")) {
          this.handleRaiseCommands(answer);
        }

        const result: ModelOutput = {
          message: answer,
        };

        resolve(n ? [result] : result);
      });
    });
  }

  protected handleRaiseCommands(action: string): void {
    if (action === "RAISE_InstanceCostLimitExceededError") {
      throw new InstanceCostLimitExceededError();
    }
    if (action === "RAISE_ContentPolicyViolationError") {
      throw new ContentPolicyViolationError();
    }
    // Add other raise commands as needed
  }
}

/**
 * LiteLLM model for API-based models
 */
export class LiteLLMModel extends AbstractModel {
  private apiKeys: string[];
  private currentKeyIndex: number = 0;

  constructor(config: GenericAPIModelConfig, tools: ToolConfig) {
    super(config as ModelConfig, tools);
    this.apiKeys = this.getApiKeys();
  }

  private getApiKeys(): string[] {
    const config = this.config as GenericAPIModelConfig;
    if (!config.apiKey) {
      // Try to get from environment
      const envKey =
        process.env[`${config.name.toUpperCase().replace(/-/g, "_")}_API_KEY`];
      if (envKey) {
        return envKey.split(":::");
      }
      return [];
    }

    const apiKey = config.apiKey;
    if (apiKey.startsWith("$")) {
      // It's an environment variable
      const envKey = process.env[apiKey.substring(1)];
      if (envKey) {
        return envKey.split(":::");
      }
      return [];
    }

    return apiKey.split(":::");
  }

  private chooseApiKey(): string | null {
    if (this.apiKeys.length === 0) {
      return null;
    }

    const config = this.config as GenericAPIModelConfig;
    if (config.chooseApiKeyByThread) {
      // Use thread-based selection
      const threadId = process.pid % this.apiKeys.length;
      return this.apiKeys[threadId];
    }

    // Round-robin selection
    const key = this.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  protected async sleep(): Promise<void> {
    const config = this.config as GenericAPIModelConfig;
    const timeSinceLastQuery =
      Date.now() / 1000 - this.globalStats.lastQueryTimestamp;
    const sleepTime = Math.max(0, config.delay - timeSinceLastQuery);
    if (sleepTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepTime * 1000));
    }
  }

  async query(
    history: History,
    temperature?: number,
    n: number = 1,
  ): Promise<ModelOutput | ModelOutput[]> {
    await this.sleep();

    const messages = this.historyToMessages(history);
    const results = await this.singleQuery(messages, n, temperature);

    return n === 1 ? results[0] : results;
  }

  private async singleQuery(
    messages: HistoryItem[],
    n?: number,
    temperature?: number,
  ): Promise<ModelOutput[]> {
    const apiKey = this.chooseApiKey();
    const config = this.config as GenericAPIModelConfig;

    interface RequestData {
      model: string;
      messages?: HistoryItem[];
      temperature: number;
      top_p: number | null;
      n: number;
      stop: string[];
      max_tokens?: number;
      system?: string;
      contents?: Array<{ role: string; parts: Array<{ text: string }> }>;
      [key: string]: unknown;
    }

    const requestData: RequestData = {
      model: config.name,
      messages,
      temperature: temperature ?? config.temperature,
      top_p: config.topP,
      n: n || 1,
      stop: config.stop,
      ...config.completionKwargs,
      ...(config.maxOutputTokens && { max_tokens: config.maxOutputTokens }),
    };

    // Determine API endpoint and headers based on provider
    const isAnthropic =
      config.name.includes("claude") || config.name.includes("anthropic");
    const isGemini =
      config.name.includes("gemini") || config.name.includes("google");

    let apiUrl: string;
    let headers: Record<string, string>;
    let finalRequestData: RequestData = requestData;

    if (isAnthropic) {
      apiUrl = config.apiBase || "https://api.anthropic.com/v1/messages";
      headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey || "",
        "anthropic-version": "2023-06-01",
      };

      // Convert messages format for Anthropic
      const system = messages.find((m) => m.role === "system");
      if (system) {
        finalRequestData = {
          ...requestData,
          system:
            typeof system.content === "string"
              ? system.content
              : JSON.stringify(system.content),
          messages: messages.filter((m) => m.role !== "system"),
        };
      }
    } else if (isGemini) {
      apiUrl =
        config.apiBase ||
        `https://generativelanguage.googleapis.com/v1beta/models/${config.name}:generateContent?key=${apiKey}`;
      headers = {
        "Content-Type": "application/json",
      };

      // Convert messages format for Google
      finalRequestData = {
        ...requestData,
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [
            {
              text:
                typeof m.content === "string"
                  ? m.content
                  : JSON.stringify(m.content),
            },
          ],
        })),
      };
    } else {
      // OpenAI and compatible APIs
      apiUrl = config.apiBase || "https://api.openai.com/v1/chat/completions";
      headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
    }

    try {
      const response = await axios.post<APIResponse>(apiUrl, finalRequestData, {
        headers,
      });

      this.updateStatsFromResponse(response.data);

      // Convert API response to ModelOutput format
      const outputs: ModelOutput[] = [];
      if (response.data.choices) {
        for (const choice of response.data.choices) {
          outputs.push({
            message: choice.message?.content || "",
          });
        }
      }
      return outputs;
    } catch (error) {
      logger.error("API call failed", error);
      throw error;
    }
  }

  private updateStatsFromResponse(response: APIResponse): void {
    const usage = response.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;

    // Calculate cost (this would need proper model pricing data)
    const cost = this.calculateCost(inputTokens, outputTokens);

    this.stats.tokensSent += inputTokens;
    this.stats.tokensReceived += outputTokens;
    this.stats.instanceCost += cost;
    this.stats.apiCalls++;

    this.globalStats.addCost(cost);
    this.globalStats.updateTimestamp();

    this.checkCostLimits();
  }

  private calculateCost(inputTokens: number, outputTokens: number): number {
    const config = this.config as GenericAPIModelConfig;
    return calculateCost(config.name, inputTokens, outputTokens);
  }

  private historyToMessages(history: History): HistoryItem[] {
    const messages: HistoryItem[] = [];
    const config = this.config as GenericAPIModelConfig;

    for (const item of history) {
      const role = this.getRole(item);

      if (config.convertSystemToUser && role === "system") {
        messages.push({
          role: "user",
          content: item.content,
        });
      } else {
        messages.push({
          role,
          content: item.content,
          ...(item.toolCalls && { tool_calls: item.toolCalls }),
          ...(item.toolCallIds && { tool_call_id: item.toolCallIds[0] }),
        });
      }
    }

    return messages;
  }

  private getRole(historyItem: HistoryItem): string {
    if (
      historyItem.role === "user" ||
      historyItem.role === "system" ||
      historyItem.role === "assistant"
    ) {
      return historyItem.role;
    }

    if (historyItem.agent) {
      return "assistant";
    }

    if (
      historyItem.role === "tool" ||
      historyItem.messageType === "observation"
    ) {
      return "tool";
    }

    return "user";
  }
}

/**
 * Human model with thought prompting
 */
export class HumanThoughtModel extends HumanModel {
  async query(
    _history: History,
    actionPrompt: string | number = "> ",
    n?: number,
  ): Promise<ModelOutput | ModelOutput[]> {
    // First get the thought
    const thoughtPrompt = "What is your thought? > ";
    const thoughtRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: thoughtPrompt,
    });

    const thought = await new Promise<string>((resolve) => {
      thoughtRl.question(thoughtPrompt, (answer) => {
        thoughtRl.close();
        resolve(answer);
      });
    });

    // Then get the action
    const actionRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: typeof actionPrompt === "string" ? actionPrompt : "> ",
    });

    const action = await new Promise<string>((resolve) => {
      actionRl.question("What is your action? > ", (answer) => {
        actionRl.close();

        if (!this.catchEof && answer === "") {
          throw new EOFError();
        }

        resolve(answer);
      });
    });

    this.updateStats();

    // Handle special commands
    if (action.startsWith("RAISE_")) {
      this.handleRaiseCommands(action);
    }

    const result: ModelOutput = {
      message: `${thought}\n\`\`\`\n${action}\n\`\`\``,
    };

    return n ? [result] : result;
  }
}

/**
 * Replay model for replaying trajectories
 */
export class ReplayModel extends AbstractModel {
  private replays: Array<Array<string | ModelOutput>>;
  private replayIdx: number = 0;
  private actionIdx: number = 0;
  private usesFunctionCalling: boolean;
  private submitCommand: string;

  constructor(config: ReplayModelConfig, tools: ToolConfig) {
    super(config, tools);

    if (!config.replayPath || !fs.existsSync(config.replayPath)) {
      throw new Error(`Replay file ${config.replayPath} not found`);
    }

    const content = fs.readFileSync(config.replayPath, "utf-8");
    this.replays = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parsed = JSON.parse(line);
        return Object.values(parsed)[0] as Array<string | ModelOutput>;
      });

    this.usesFunctionCalling = tools.useFunctionCalling;
    this.submitCommand = tools.submitCommand || "submit";
  }

  private nextReplay(): void {
    this.replayIdx++;
    this.actionIdx = 0;
  }

  async query(_history: History): Promise<ModelOutput> {
    this.stats.apiCalls++;

    const actions = this.replays[this.replayIdx];
    let action: string | ModelOutput;

    if (this.actionIdx >= actions.length) {
      logger.error(
        "Reached end of replay trajectory without submitting. Submitting now.",
      );

      if (this.usesFunctionCalling) {
        action = {
          message: `Calling \`${this.submitCommand}\` to submit.`,
          toolCalls: [
            {
              type: "function",
              id: "call_submit",
              function: {
                name: this.submitCommand,
                arguments: "{}",
              },
            },
          ],
        };
      } else {
        action = `\`\`\`\n${this.submitCommand}\n\`\`\``;
      }
    } else {
      action = actions[this.actionIdx];
    }

    this.actionIdx++;

    if (typeof action === "string" && action === "submit") {
      this.nextReplay();
      return { message: action };
    }

    if (typeof action === "object") {
      return action as ModelOutput;
    }

    return { message: action };
  }
}

/**
 * Instant empty submit model for testing
 */
export class InstantEmptySubmitModel extends AbstractModel {
  private actionIdx: number = 0;
  private delay: number;

  constructor(
    config: { name: "instant_empty_submit"; delay?: number },
    tools: ToolConfig,
  ) {
    super(config, tools);
    this.delay = config.delay || 0;
  }

  async query(_history: History): Promise<ModelOutput> {
    // Add random delay if configured
    if (this.delay > 0) {
      const sleepTime = Math.random() * this.delay;
      await new Promise((resolve) => setTimeout(resolve, sleepTime * 1000));
    }

    let action: string;

    if (this.actionIdx === 0) {
      this.actionIdx = 1;
      action =
        "DISCUSSION\n" +
        "Let's reproduce the bug by creating a `reproduce.py` file.\n\n" +
        "```\n" +
        "touch reproduce.py\n" +
        "```\n";
    } else {
      this.actionIdx = 0;
      action =
        "DISCUSSION\nThe task should be resolved, so let's submit the patch.\n\n```\nsubmit\n```\n";
    }

    this.stats.apiCalls++;
    return { message: action };
  }
}

/**
 * Predetermined test model for testing
 */
export class PredeterminedTestModel extends AbstractModel {
  private responses: Array<string | ModelOutput>;
  private responseIdx: number = 0;

  constructor(responses: Array<string | ModelOutput>, tools?: ToolConfig) {
    super({ name: "test" } as ModelConfig, tools || ({} as ToolConfig));
    this.responses = responses;
  }

  async query(_history: History): Promise<ModelOutput> {
    if (this.responseIdx >= this.responses.length) {
      throw new Error("Ran out of predetermined responses");
    }

    const response = this.responses[this.responseIdx++];

    // Handle special test commands
    if (typeof response === "string") {
      if (response === "raise_cost") {
        throw new InstanceCostLimitExceededError("Test cost limit exceeded");
      }
      if (response === "raise_context") {
        throw new ContextWindowExceededError("Test context window exceeded");
      }
      if (response === "raise_runtime" || response === "raise_model_error") {
        // Create a RuntimeError-like error that the agent will recognize
        const error = new Error("Test runtime error");
        error.name = "RuntimeError";
        throw error;
      }
      if (response === "raise_format_error") {
        throw new RetryWithOutputError("Test format error");
      }

      return { message: response };
    }

    return response;
  }
}

// Export types for testing
export { ModelOutput } from "./types";

/**
 * Factory function to create model instances
 */
export function getModel(
  config: ModelConfig,
  tools: ToolConfig,
): AbstractModel {
  switch (config.name) {
    case "human":
      return new HumanModel(config as HumanModelConfig, tools);
    case "human_thought": {
      // HumanThoughtModel expects HumanModelConfig which has costPerCall
      const humanThoughtConfig: HumanModelConfig = {
        name: "human",
        costPerCall: 0,
        catchEof: (config as HumanThoughtModelConfig).catchEof,
      };
      return new HumanThoughtModel(humanThoughtConfig, tools);
    }
    case "replay":
      return new ReplayModel(config as ReplayModelConfig, tools);
    case "instant_empty_submit":
      return new InstantEmptySubmitModel(
        config as InstantEmptySubmitModelConfig,
        tools,
      );
    default:
      return new LiteLLMModel(config as GenericAPIModelConfig, tools);
  }
}
