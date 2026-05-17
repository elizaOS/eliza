import type { PricingDimensions } from "../../../db/schemas/ai-pricing";
import type {
  PricingBillingSource,
  PricingChargeUnit,
  PricingProductFamily,
} from "../ai-pricing-definitions";

export type PriceLookupSource = PricingBillingSource | "seed";

export type PricingRefreshSource =
  | "gateway"
  | "openrouter"
  | "fal"
  | "elevenlabs"
  | "suno"
  | "vast";

export type PreparedPricingEntry = {
  billingSource: PriceLookupSource;
  provider: string;
  model: string;
  productFamily: PricingProductFamily;
  chargeType: string;
  unit: PricingChargeUnit;
  unitPrice: number;
  dimensions?: PricingDimensions;
  sourceKind: string;
  sourceUrl: string;
  fetchedAt?: Date;
  staleAfter?: Date;
  priority?: number;
  isOverride?: boolean;
  metadata?: Record<string, unknown>;
};

export interface TokenCostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  baseInputCost: number;
  baseOutputCost: number;
  baseTotalCost: number;
  platformMarkup: number;
}

export interface FlatOperationCost {
  totalCost: number;
  baseTotalCost: number;
  platformMarkup: number;
  matchedEntry: {
    billingSource: string;
    provider: string;
    model: string;
    productFamily: string;
    chargeType: string;
    unit: string;
    unitPrice: number;
    dimensions: PricingDimensions;
    sourceKind?: string;
    sourceUrl?: string;
  };
}

export type OpenRouterCatalogModel = {
  id: string;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: Record<string, unknown>;
};

export type ExternalCacheValue = {
  expiresAt: number;
  entries: PreparedPricingEntry[];
};

export type CandidatePreparedPricingEntry = {
  entry: PreparedPricingEntry;
  modelId: string;
  logicalProvider: string;
};

export const EXTERNAL_CACHE_TTL_MS = 15 * 60 * 1000;

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";

export const DEFAULT_OPENROUTER_IMAGE_OUTPUT_TOKENS = 1300;
