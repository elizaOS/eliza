/** Registers video providers and resolves configured candidates for Cloud routes. */
import type {
  PricingBillingSource,
  SupportedVideoModelDefinition,
} from "../../services/ai-pricing-definitions";
import { atlasCloudVideoProvider } from "./atlascloud-video-generation";
import { falVideoProvider } from "./fal-video-generation";
import type { VideoProvider } from "./types";

const PROVIDERS = new Map<PricingBillingSource, VideoProvider>();

export function registerVideoProvider(provider: VideoProvider) {
  PROVIDERS.set(provider.billingSource, provider);
}

export function getVideoProvider(billingSource: PricingBillingSource): VideoProvider {
  const provider = PROVIDERS.get(billingSource);
  if (!provider) {
    throw new Error(`No video provider registered for billing source: ${billingSource}`);
  }
  return provider;
}

/**
 * String-keyed lookup for callers that read the billing source back from
 * persisted data (the pending-settlement reconcile sweep). Returns undefined
 * instead of throwing so the sweep can skip-and-log unknown sources.
 */
export function findVideoProvider(billingSource: string): VideoProvider | undefined {
  return PROVIDERS.get(billingSource as PricingBillingSource);
}

export interface ConfiguredVideoProviderCandidate {
  definition: SupportedVideoModelDefinition;
  provider: VideoProvider;
}

/**
 * Resolves an ordered model list to providers that have usable credentials.
 * Callers retain model order so the first entry is primary and later entries
 * are fallbacks.
 */
export function getConfiguredVideoProviderCandidates(
  definitions: readonly SupportedVideoModelDefinition[],
  apiKeys: Record<string, string | undefined>,
): ConfiguredVideoProviderCandidate[] {
  return definitions.flatMap((definition) => {
    const provider = getVideoProvider(definition.billingSource);
    if (provider.isConfigured && !provider.isConfigured(apiKeys)) return [];
    return [{ definition, provider }];
  });
}

/**
 * Environment keys forwarded to video providers. Both the generate-video
 * route and the reconcile cron build their provider credentials here so the
 * two paths can never drift; extend it when registering a new provider.
 */
export function collectVideoProviderApiKeys(
  env: Record<string, unknown>,
): Record<string, string | undefined> {
  const pick = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  return {
    FAL_KEY: pick(env.FAL_KEY),
    FAL_API_KEY: pick(env.FAL_API_KEY),
    ATLASCLOUD_API_KEY: pick(env.ATLASCLOUD_API_KEY),
    ATLASCLOUD_BASE_URL: pick(env.ATLASCLOUD_BASE_URL),
  };
}

registerVideoProvider(falVideoProvider);
registerVideoProvider(atlasCloudVideoProvider);
