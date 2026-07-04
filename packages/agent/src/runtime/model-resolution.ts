/**
 * Derives model-selection identifiers from an ElizaConfig: the primary model id
 * (agents.defaults.model.primary), the preferred provider id (from the resolved
 * service-routing llmText transport/backend, falling back to a model-name hint),
 * and the plugin package that provider maps to. Returns undefined when nothing is
 * explicitly configured, so elizaOS falls back to whichever model plugin loads.
 */
import {
  getFirstRunProviderOption,
  normalizeFirstRunProviderId,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveProviderIdFromSelectionHint(
  value: string | undefined,
): string | undefined {
  const trimmed = trimEnvString(value);
  if (!trimmed) return undefined;

  return (
    normalizeFirstRunProviderId(trimmed) ??
    normalizeFirstRunProviderId(trimmed.split("/", 1)[0]) ??
    undefined
  );
}

/**
 * Resolve the primary model identifier from Eliza config.
 *
 * Eliza stores the model under `agents.defaults.model.primary` as an
 * AgentModelListConfig object. Returns undefined when no model is
 * explicitly configured (elizaOS falls back to whichever model
 * plugin is loaded).
 */
/** @internal Exported for testing. */
export function resolvePrimaryModel(config: ElizaConfig): string | undefined {
  const modelConfig = config.agents?.defaults?.model;
  if (!modelConfig) return undefined;

  // AgentDefaultsConfig.model is AgentModelListConfig: { primary?, fallbacks? }
  return modelConfig.primary;
}

/** @internal Exported for testing. */
export function resolvePreferredProviderId(
  config: ElizaConfig,
): string | undefined {
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const backend = normalizeFirstRunProviderId(llmText?.backend);

  if (llmText?.transport === "cloud-proxy" && backend === "elizacloud") {
    return "elizacloud";
  }

  if (llmText?.transport === "direct") {
    const directProvider =
      backend && backend !== "elizacloud" ? backend : undefined;
    return (
      directProvider ?? resolveProviderIdFromSelectionHint(llmText.primaryModel)
    );
  }

  if (llmText?.transport === "remote") {
    const remoteProvider =
      backend && backend !== "elizacloud" ? backend : undefined;
    return (
      remoteProvider ?? resolveProviderIdFromSelectionHint(llmText.primaryModel)
    );
  }

  return resolveProviderIdFromSelectionHint(resolvePrimaryModel(config));
}

/** @internal Exported for testing. */
export function resolvePreferredProviderPluginName(
  config: ElizaConfig,
): string | undefined {
  const providerId = resolvePreferredProviderId(config);
  return providerId
    ? getFirstRunProviderOption(providerId)?.pluginName
    : undefined;
}
