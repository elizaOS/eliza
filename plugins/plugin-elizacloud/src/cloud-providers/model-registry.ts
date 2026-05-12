/** Exposes available cloud models in agent state. */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { CloudModelRegistryService, ModelsByProvider } from "../services/cloud-model-registry";

const TTL = 300_000; // 5 minutes
const MAX_MODEL_PROVIDERS = 12;
const MAX_MODELS_PER_PROVIDER = 50;

/**
 * Per-runtime cache using a WeakMap keyed by the runtime object.
 * This avoids sharing stale model data between different agent instances
 * running in the same process.
 */
const runtimeCaches = new WeakMap<IAgentRuntime, { value: ModelsByProvider; at: number }>();

export const modelRegistryProvider: Provider = {
  name: "elizacloud_models",
  description: "Available AI models from ElizaCloud grouped by provider",
  descriptionCompressed: "Available AI models from ElizaCloud by provider.",
  dynamic: true,
  contexts: ["settings", "finance"],
  contextGate: { anyOf: ["settings", "finance"] },
  cacheStable: false,
  cacheScope: "turn",
  position: 92,
  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    try {
      const registry = runtime.getService("CLOUD_MODEL_REGISTRY") as
        | CloudModelRegistryService
        | undefined;

      if (!registry) return { text: "" };

      const cached = runtimeCaches.get(runtime);
      if (cached && Date.now() - cached.at < TTL) {
        const cachedValue = Object.fromEntries(
          Object.entries(cached.value).slice(0, MAX_MODEL_PROVIDERS)
        ) as ModelsByProvider;
        return formatModels(cachedValue);
      }

      const byProvider = await registry.getModelsByProvider();

      if (Object.keys(byProvider).length === 0) {
        return { text: "" };
      }

      runtimeCaches.set(runtime, { value: byProvider, at: Date.now() });
      const capped = Object.fromEntries(
        Object.entries(byProvider).slice(0, MAX_MODEL_PROVIDERS)
      ) as ModelsByProvider;
      return formatModels(capped);
    } catch {
      return { text: "", values: {}, data: {} };
    }
  },
};

function formatModels(byProvider: ModelsByProvider): ProviderResult {
  const providers = Object.keys(byProvider).sort().slice(0, MAX_MODEL_PROVIDERS);
  const total = providers.reduce(
    (n, provider) => n + byProvider[provider].slice(0, MAX_MODELS_PER_PROVIDER).length,
    0
  );

  return {
    text: `ElizaCloud: ${total} models (${providers.join(", ")})`,
    values: {
      cloudModelProviders: providers.join(","),
      cloudModelCount: total,
    },
  };
}
