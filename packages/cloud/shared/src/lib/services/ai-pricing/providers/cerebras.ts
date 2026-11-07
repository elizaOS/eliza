// Coordinates cloud service cerebras behavior behind route handlers.
import { logger } from "../../../utils/logger";
import { getCachedExternalEntries } from "../cache";
import { parseNumericPrice } from "../dimensions";
import { fetchJson } from "../fetch";
import {
  type BitRouterCatalogModel,
  EXTERNAL_CACHE_TTL_MS,
  type PreparedPricingEntry,
} from "../types";

const CEREBRAS_PUBLIC_MODELS_URL = "https://api.cerebras.ai/public/v1/models?format=openrouter";

type CerebrasPublicModel = BitRouterCatalogModel & {
  id: string;
  name?: string;
};

export function buildCerebrasPreparedEntries(model: CerebrasPublicModel): PreparedPricingEntry[] {
  const pricing = model.pricing ?? {};
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);
  const modelId = `cerebras/${model.id}`;

  const buildEntry = (chargeType: "input" | "output", unitPrice: number): PreparedPricingEntry => ({
    billingSource: "cerebras",
    provider: "cerebras",
    model: modelId,
    productFamily: "language",
    chargeType,
    unit: "token",
    unitPrice,
    sourceKind: "cerebras_public_catalog",
    sourceUrl: CEREBRAS_PUBLIC_MODELS_URL,
    fetchedAt,
    staleAfter,
  });

  const entries: PreparedPricingEntry[] = [];
  const promptPrice = parseNumericPrice(pricing.prompt);
  if (promptPrice != null) {
    entries.push(buildEntry("input", promptPrice));
  }

  const completionPrice = parseNumericPrice(pricing.completion);
  if (completionPrice != null) {
    entries.push(buildEntry("output", completionPrice));
  }

  return entries;
}

export async function fetchCerebrasPublicCatalogEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("cerebras", async () => {
    const payload = await fetchJson<{ data?: CerebrasPublicModel[] }>(CEREBRAS_PUBLIC_MODELS_URL);
    const models = Array.isArray(payload.data) ? payload.data : [];
    const entries = models.flatMap((model) => buildCerebrasPreparedEntries(model));
    if (entries.length === 0) {
      logger.warn("[AI Pricing] Cerebras public catalog returned no priced models", {
        modelCount: models.length,
      });
    }
    return entries;
  });
}
