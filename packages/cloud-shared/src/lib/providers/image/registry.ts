import type { PricingBillingSource } from "../../services/ai-pricing-definitions";
import { bitRouterImageProvider } from "./bitrouter-image-generation";
import { falImageProvider } from "./fal-image-generation";
import type { ImageProvider } from "./types";

const PROVIDERS = new Map<PricingBillingSource, ImageProvider>();

export function registerImageProvider(provider: ImageProvider) {
  PROVIDERS.set(provider.billingSource, provider);
}

export function getImageProvider(billingSource: PricingBillingSource): ImageProvider {
  const provider = PROVIDERS.get(billingSource);
  if (!provider) {
    throw new Error(`No image provider registered for billing source: ${billingSource}`);
  }
  return provider;
}

registerImageProvider(bitRouterImageProvider);
registerImageProvider(falImageProvider);
