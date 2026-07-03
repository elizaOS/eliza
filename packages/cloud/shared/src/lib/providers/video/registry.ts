import type { PricingBillingSource } from "../../services/ai-pricing-definitions";
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

registerVideoProvider(falVideoProvider);
