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

registerAudioProvider(falAudioProvider);
registerAudioProvider(elevenLabsAudioProvider);
registerAudioProvider(sunoAudioProvider);
