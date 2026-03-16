import { SUBSCRIPTION_PROVIDER_MAP } from "../auth/types";
import type { MiladyConfig } from "../config/types.milady";

/**
 * Apply subscription provider configuration to the config object.
 *
 * Sets `agents.defaults.subscriptionProvider` and `agents.defaults.model.primary`
 * so the runtime auto-detects the correct provider on restart.
 *
 * Mutates `config` in place.
 */
export function applySubscriptionProviderConfig(
  config: Partial<MiladyConfig>,
  provider: string,
): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  const defaults = config.agents.defaults;

  const subscriptionKey =
    provider === "openai-subscription" ? "openai-codex" : provider;
  const modelProvider =
    SUBSCRIPTION_PROVIDER_MAP[
      subscriptionKey as keyof typeof SUBSCRIPTION_PROVIDER_MAP
    ];

  if (modelProvider) {
    defaults.subscriptionProvider = subscriptionKey;
    defaults.model = { ...defaults.model, primary: modelProvider };
  }
}

/**
 * Clear subscription provider configuration from the config object.
 *
 * Removes `agents.defaults.subscriptionProvider` so the runtime
 * doesn't try to auto-detect a subscription provider on restart.
 *
 * Mutates `config` in place.
 */
export function clearSubscriptionProviderConfig(
  config: Partial<MiladyConfig>,
): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  delete config.agents.defaults.subscriptionProvider;
}
