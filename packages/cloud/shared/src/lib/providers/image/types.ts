// Defines cloud shared types behavior for backend service consumers.
import type { PricingBillingSource } from "../../services/ai-pricing-definitions";

export interface ImageGenRequest {
  model: string;
  prompt: string;
  sourceImage?: string;
  aspectRatio?: string;
  size?: string;
  apiKeys: Record<string, string | undefined>;
}

export interface GeneratedImage {
  dataUrl: string;
  bytes: Uint8Array;
  mimeType: string;
  text: string;
}

export interface ImageProvider {
  billingSource: PricingBillingSource;
  generate(req: ImageGenRequest): Promise<GeneratedImage>;
  healthCheck?(): Promise<boolean>;
}
