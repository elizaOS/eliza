/** Exposes available cloud models in agent state. */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { CloudModelRegistryService, ModelsByProvider } from "../services/cloud-model-registry";

const TTL = 300_000; // 5 minutes

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
  position: 92,
  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    const registry = runtime.getService("CLOUD_MODEL_REGISTRY") as
      | CloudModelRegistryService
      | undefined;

    if (!registry) return { text: "" };

    const cached = runtimeCaches.get(runtime);
    if (cached && Date.now() - cached.at < TTL) {
      return formatModels(cached.value);
    }

    const byProvider = await registry.getModelsByProvider();

    if (Object.keys(byProvider).length === 0) {
      return { text: "" };
    }

    runtimeCaches.set(runtime, { value: byProvider, at: Date.now() });
    return formatModels(byProvider);
  },
};

function formatModels(byProvider: ModelsByProvider): ProviderResult {
  const providers = Object.keys(byProvider).sort();
  const total = Object.values(byProvider).reduce((n, m) => n + m.length, 0);

  return {
    text: `ElizaCloud: ${total} models (${providers.join(", ")})`,
    values: {
      cloudModelProviders: providers.join(","),
      cloudModelCount: total,
    },
  };
}
