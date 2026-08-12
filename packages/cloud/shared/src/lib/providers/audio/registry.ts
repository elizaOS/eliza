// Defines cloud shared registry behavior for backend service consumers.
import type { PricingBillingSource } from "../../services/ai-pricing-definitions";
import { elevenLabsAudioProvider } from "./elevenlabs-audio-generation";
import { falAudioProvider } from "./fal-audio-generation";
import { sunoAudioProvider } from "./suno-audio-generation";
import type { AudioProvider } from "./types";

const PROVIDERS = new Map<PricingBillingSource, AudioProvider>();

export function registerAudioProvider(provider: AudioProvider) {
  PROVIDERS.set(provider.billingSource, provider);
}

export function getAudioProvider(billingSource: PricingBillingSource): AudioProvider {
  const provider = PROVIDERS.get(billingSource);
  if (!provider) {
    throw new Error(`No audio provider registered for billing source: ${billingSource}`);
  }
  return provider;
}

/**
 * String-keyed lookup for callers that read the billing source back from
 * persisted data (the pending-settlement reconcile sweep). Returns undefined
 * instead of throwing so the sweep can skip-and-log unknown sources.
 */
export function findAudioProvider(billingSource: string): AudioProvider | undefined {
  return PROVIDERS.get(billingSource as PricingBillingSource);
}

/**
 * Environment keys forwarded to audio providers. The generate-music route and
 * the music reconcile cron build credentials here so the two paths cannot
 * drift; extend it when registering a new provider.
 */
export function collectAudioProviderApiKeys(
  env: Record<string, unknown>,
): Record<string, string | undefined> {
  const pick = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  return {
    FAL_KEY: pick(env.FAL_KEY),
    FAL_API_KEY: pick(env.FAL_API_KEY),
    FAL_QUEUE_BASE_URL: pick(env.FAL_QUEUE_BASE_URL),
    FAL_QUEUE_POLL_INTERVAL_MS: pick(env.FAL_QUEUE_POLL_INTERVAL_MS),
    FAL_QUEUE_TIMEOUT_MS: pick(env.FAL_QUEUE_TIMEOUT_MS),
    ELEVENLABS_API_KEY: pick(env.ELEVENLABS_API_KEY),
    ELEVENLABS_BASE_URL: pick(env.ELEVENLABS_BASE_URL),
    SUNO_API_KEY: pick(env.SUNO_API_KEY),
    SUNO_BASE_URL: pick(env.SUNO_BASE_URL),
  };
}

registerAudioProvider(falAudioProvider);
registerAudioProvider(elevenLabsAudioProvider);
registerAudioProvider(sunoAudioProvider);
