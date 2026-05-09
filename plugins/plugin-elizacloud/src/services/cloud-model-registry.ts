/** Fetches and caches available models from ElizaCloud. */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type { CloudAuthService } from "./cloud-auth";

interface ModelListEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ModelListResponse {
  object: string;
  data: ModelListEntry[];
}

export interface AvailableModel {
  id: string;
  provider: string;
  name: string;
  createdAt: number;
}

export interface ModelsByProvider {
  [provider: string]: AvailableModel[];
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const PROVIDER_PREFIXES: ReadonlyArray<[string, string]> = [
  ["gpt-", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["dall-e", "openai"],
  ["whisper", "openai"],
  ["tts", "openai"],
  ["claude-", "anthropic"],
  ["gemini-", "google"],
  ["llama", "meta"],
  ["deepseek", "deepseek"],
  ["grok", "xai"],
  ["kimi", "moonshot"],
];

function extractProvider(modelId: string): string {
  if (modelId.includes("/")) return modelId.split("/")[0];
  const lower = modelId.toLowerCase();
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (lower.startsWith(prefix)) return provider;
  }
  return "unknown";
}

function stripProvider(modelId: string): string {
  if (modelId.includes("/")) {
    return modelId.split("/").slice(1).join("/");
  }
  return modelId;
}

export class CloudModelRegistryService extends Service {
  static serviceType = "CLOUD_MODEL_REGISTRY";
  capabilityDescription = "Discovers and caches available AI models from ElizaCloud";

  private models: AvailableModel[] = [];
  private byProvider: ModelsByProvider = {};
  private lastFetchedAt = 0;
  private fetchPromise: Promise<void> | null = null;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudModelRegistryService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    this.models = [];
    this.byProvider = {};
    this.lastFetchedAt = 0;
  }

  private async initialize(): Promise<void> {
    const auth = this.runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;

    if (!auth?.isAuthenticated()) {
      logger.info("[CloudModelRegistry] Auth not available, will fetch models on first access");
      return;
    }

    await this.fetchModels();
    this.validateConfiguredModels();
  }

  private async fetchModels(): Promise<void> {
    if (this.fetchPromise) {
      await this.fetchPromise;
      return;
    }

    this.fetchPromise = this.doFetchModels();
    await this.fetchPromise;
    this.fetchPromise = null;
  }

  private async doFetchModels(): Promise<void> {
    const auth = this.runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    if (!auth?.isAuthenticated()) return;

    const client = auth.getClient();

    const response = await client.get<ModelListResponse>("/models");
    const entries = response.data ?? [];

    this.models = entries.map((entry) => ({
      id: entry.id,
      provider: extractProvider(entry.id),
      name: stripProvider(entry.id),
      createdAt: entry.created,
    }));

    this.byProvider = {};
    for (const model of this.models) {
      if (!this.byProvider[model.provider]) {
        this.byProvider[model.provider] = [];
      }
      this.byProvider[model.provider].push(model);
    }

    this.lastFetchedAt = Date.now();
    logger.info(
      `[CloudModelRegistry] Loaded ${this.models.length} models from ${Object.keys(this.byProvider).length} providers`
    );
  }

  private validateConfiguredModels(): void {
    if (this.models.length === 0) return;

    const modelIds = new Set(this.models.map((m) => m.id));
    const nameSet = new Set(this.models.map((m) => m.name));

    const settingsToCheck = [
      { key: "ELIZAOS_CLOUD_NANO_MODEL", label: "nano model" },
      { key: "ELIZAOS_CLOUD_MEDIUM_MODEL", label: "medium model" },
      { key: "ELIZAOS_CLOUD_SMALL_MODEL", label: "small model" },
      { key: "ELIZAOS_CLOUD_LARGE_MODEL", label: "large model" },
      { key: "ELIZAOS_CLOUD_MEGA_MODEL", label: "mega model" },
      {
        key: "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
        label: "response handler model",
      },
      {
        key: "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
        label: "action planner model",
      },
      { key: "ELIZAOS_CLOUD_RESPONSE_MODEL", label: "response model" },
      { key: "ELIZAOS_CLOUD_RESEARCH_MODEL", label: "research model" },
      { key: "ELIZAOS_CLOUD_EMBEDDING_MODEL", label: "embedding model" },
      {
        key: "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL",
        label: "image description model",
      },
      {
        key: "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL",
        label: "image generation model",
      },
      { key: "ELIZAOS_CLOUD_TTS_MODEL", label: "TTS model" },
      {
        key: "ELIZAOS_CLOUD_TRANSCRIPTION_MODEL",
        label: "transcription model",
      },
    ];

    for (const { key, label } of settingsToCheck) {
      const value = this.runtime.getSetting(key);
      if (value && typeof value === "string") {
        const found = modelIds.has(value) || nameSet.has(value);
        if (!found) {
          logger.warn(
            `[CloudModelRegistry] Configured ${label} "${value}" not found in available models. ` +
              "It may still work if the gateway supports it, but check your configuration."
          );
        }
      }
    }
  }

  async getAvailableModels(): Promise<AvailableModel[]> {
    if (Date.now() - this.lastFetchedAt > CACHE_TTL_MS) {
      await this.fetchModels();
    }
    return this.models;
  }

  async getModelsByProvider(): Promise<ModelsByProvider> {
    if (Date.now() - this.lastFetchedAt > CACHE_TTL_MS) {
      await this.fetchModels();
    }
    return this.byProvider;
  }
}
