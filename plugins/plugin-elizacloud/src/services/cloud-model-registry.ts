/** Fetches and caches available models from ElizaCloud. */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { getSetting } from "../utils/config";
import {
  type CloudTextModelReadiness,
  evaluateCloudTextModelReadiness,
} from "./cloud-model-readiness";
import type { CloudAuthService } from "./cloud-auth";
import { cloudCatalogModelIdentity, isCloudCatalogModelAvailable } from "./cloud-model-identity";

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
/** Minimum spacing between catalog retries after a failed fetch. */
const FAILED_FETCH_RETRY_MS = 60 * 1000;

export class CloudModelRegistryService extends Service {
  static serviceType = "CLOUD_MODEL_REGISTRY";
  capabilityDescription = "Discovers and caches available AI models from ElizaCloud";

  private models: AvailableModel[] = [];
  private byProvider: ModelsByProvider = {};
  private lastFetchedAt = 0;
  private lastFetchFailedAt = 0;
  private catalogLoaded = false;
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
    this.lastFetchFailedAt = 0;
    this.catalogLoaded = false;
  }

  private async initialize(): Promise<void> {
    const auth = this.runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;

    if (!auth?.isAuthenticated()) {
      logger.info("[CloudModelRegistry] Auth not available, will fetch models on first access");
      return;
    }

    try {
      await this.fetchModels();
    } catch (error) {
      // error-policy:J7 the catalog is a readiness input, not a boot dependency:
      // an unreachable catalog leaves readiness "unknown" (retryable) and the
      // next status read schedules another bounded fetch.
      logger.warn(
        `[CloudModelRegistry] Model catalog fetch failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    this.validateConfiguredModels();
  }

  private async fetchModels(): Promise<void> {
    if (this.fetchPromise) {
      await this.fetchPromise;
      return;
    }

    this.fetchPromise = this.doFetchModels();
    try {
      await this.fetchPromise;
    } catch (error) {
      this.lastFetchFailedAt = Date.now();
      throw error;
    } finally {
      this.fetchPromise = null;
    }
  }

  /**
   * Readiness of the effective TEXT_SMALL / TEXT_LARGE Cloud model ids against
   * the cached, non-billable `/models` catalog. Synchronous and inference-free
   * so status/health polling can read it on every request; a stale or missing
   * catalog schedules one background refresh (bounded by the cache TTL and the
   * failed-fetch retry spacing) and reports `unknown` until it lands.
   *
   * Only a positive "catalog loaded and the id is not listed" is reported as
   * `model_not_available`; catalog errors never gate chat.
   */
  getTextModelReadiness(): CloudTextModelReadiness {
    this.scheduleRefreshIfStale();
    return evaluateCloudTextModelReadiness({
      catalogLoaded: this.catalogLoaded,
      checkedAt: this.lastFetchedAt,
      catalogFailedAt: this.lastFetchFailedAt,
      models: this.models,
      readSetting: (key) => getSetting(this.runtime, key),
    });
  }

  private scheduleRefreshIfStale(): void {
    if (this.fetchPromise) return;
    const now = Date.now();
    if (this.catalogLoaded && now - this.lastFetchedAt <= CACHE_TTL_MS) return;
    if (this.lastFetchFailedAt > 0 && now - this.lastFetchFailedAt < FAILED_FETCH_RETRY_MS) {
      return;
    }
    const auth = this.runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    if (!auth?.isAuthenticated()) return;
    void this.fetchModels().catch((error: unknown) => {
      // error-policy:J7 background readiness refresh; failure keeps readiness unknown.
      logger.warn(
        `[CloudModelRegistry] Background model catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  private async doFetchModels(): Promise<void> {
    const auth = this.runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    if (!auth?.isAuthenticated()) return;

    const client = auth.getClient();

    const response = await client.requestData<ModelListResponse>("GET", "/models");
    const entries: ModelListEntry[] = response.data ?? [];

    this.models = entries.map((entry) => {
      const identity = cloudCatalogModelIdentity(entry.id, entry.owned_by);
      return {
        id: entry.id,
        provider: identity?.provider ?? "unknown",
        name: identity?.model ?? entry.id,
        createdAt: entry.created,
      };
    });

    this.byProvider = {};
    for (const model of this.models) {
      if (!this.byProvider[model.provider]) {
        this.byProvider[model.provider] = [];
      }
      this.byProvider[model.provider].push(model);
    }

    this.lastFetchedAt = Date.now();
    this.lastFetchFailedAt = 0;
    this.catalogLoaded = true;
    logger.info(
      `[CloudModelRegistry] Loaded ${this.models.length} models from ${Object.keys(this.byProvider).length} providers`
    );
  }

  private validateConfiguredModels(): void {
    if (this.models.length === 0) return;

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
    ];

    for (const { key, label } of settingsToCheck) {
      const value = this.runtime.getSetting(key);
      if (value && typeof value === "string") {
        const found = isCloudCatalogModelAvailable(value, this.models);
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
