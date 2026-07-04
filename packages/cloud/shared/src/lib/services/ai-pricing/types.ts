// Coordinates cloud service types behavior behind route handlers.
import type { PricingDimensions } from "../../../db/schemas/ai-pricing";
import type {
  PricingBillingSource,
  PricingChargeUnit,
  PricingProductFamily,
} from "../ai-pricing-definitions";

export type PriceLookupSource = PricingBillingSource | "seed";

export type PricingRefreshSource =
  | "gateway"
  | "bitrouter"
  | "cerebras"
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

export type BitRouterCatalogModel = {
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

/**
 * Shorter TTL used to NEGATIVE-cache a failed external-catalog fetch. Without it,
 * a permanently-failing upstream (e.g. Cerebras retiring its public
 * `/public/v1/models?format=openrouter` catalog → 404) is re-fetched on EVERY
 * hot-path pricing lookup (measured 2x per chat request in prod), adding the
 * failing fetch's variable latency to every turn. 5 min lets a recovered
 * upstream be picked up again reasonably soon.
 */
export const NEGATIVE_EXTERNAL_CACHE_TTL_MS = 5 * 60 * 1000;

export const BITROUTER_MODELS_URL = "https://api.bitrouter.ai/v1/models?output_modalities=all";
