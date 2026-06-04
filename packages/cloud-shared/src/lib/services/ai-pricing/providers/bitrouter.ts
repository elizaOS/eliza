import { getProviderKey } from "../../../providers/provider-env";
import { logger } from "../../../utils/logger";
import { type PricingProductFamily } from "../../ai-pricing-definitions";
import { getCachedExternalEntries } from "../cache";
import { inferProviderFromCanonicalModel, parseNumericPrice } from "../dimensions";
import { stripVersionedSnapshotSuffix } from "../suffix-stripping";
import {
  EXTERNAL_CACHE_TTL_MS,
  type BitRouterCatalogModel,
  type PreparedPricingEntry,
} from "../types";

function bitRouterModelsUrl(): string {
  const baseUrl = (getProviderKey("BITROUTER_BASE_URL") ?? "https://api.bitrouter.ai/v1").replace(
    /\/+$/,
    "",
  );
  const apiBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  return `${apiBaseUrl}/models?output_modalities=all`;
}

function inferBitRouterProductFamily(model: BitRouterCatalogModel): PricingProductFamily {
  if (model.id.includes("embedding")) {
    return "embedding";
  }
  const outputModalities = model.architecture?.output_modalities;
  if (Array.isArray(outputModalities) && outputModalities.length > 0) {
    if (outputModalities.includes("image") && !outputModalities.includes("text")) {
      return "image";
    }
    return "language";
  }
  const modality = model.architecture?.modality ?? "";
  const arrowIdx = modality.indexOf("->");
  const outputs = arrowIdx >= 0 ? modality.slice(arrowIdx + 2) : modality;
  if (outputs.includes("image") && !outputs.includes("text")) {
    return "image";
  }
  return "language";
}

function nestedPrice(pricing: Record<string, unknown>, group: string, key: string): unknown {
  const value = pricing[group];
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

export function buildBitRouterPreparedEntries(
  model: BitRouterCatalogModel,
): PreparedPricingEntry[] {
  const pricing = model.pricing ?? {};
  const provider = inferProviderFromCanonicalModel(model.id);
  const productFamily = inferBitRouterProductFamily(model);
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);
  const baseId = stripVersionedSnapshotSuffix(model.id);
  const sourceUrl = bitRouterModelsUrl();

  const buildEntry = (
    modelId: string,
    chargeType: "input" | "output",
    unitPrice: number,
    priority?: number,
  ): PreparedPricingEntry => ({
    billingSource: "bitrouter",
    provider,
    model: modelId,
    productFamily,
    chargeType,
    unit: "token",
    unitPrice,
    sourceKind: "bitrouter_catalog",
    sourceUrl,
    fetchedAt,
    staleAfter,
    ...(priority !== undefined ? { priority } : {}),
  });

  const entries: PreparedPricingEntry[] = [];
  const promptPrice = parseNumericPrice(
    pricing.prompt ?? nestedPrice(pricing, "input_tokens", "no_cache"),
  );
  if (promptPrice != null) {
    entries.push(buildEntry(model.id, "input", promptPrice));
    if (baseId !== null) {
      entries.push(buildEntry(baseId, "input", promptPrice, -1));
    }
  }

  const completionPrice = parseNumericPrice(
    pricing.completion ?? nestedPrice(pricing, "output_tokens", "text"),
  );
  if (completionPrice != null) {
    entries.push(buildEntry(model.id, "output", completionPrice));
    if (baseId !== null) {
      entries.push(buildEntry(baseId, "output", completionPrice, -1));
    }
  }

  return entries;
}

async function fetchBitRouterJson<T>(url: string): Promise<T> {
  const apiKey = getProviderKey("BITROUTER_API_KEY");
  if (!apiKey) {
    throw new Error("BITROUTER_API_KEY environment variable is required");
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "ElizaCloudPricingBot/1.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchBitRouterCatalogEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("bitrouter", async () => {
    const url = bitRouterModelsUrl();
    const payload = await fetchBitRouterJson<{ data?: BitRouterCatalogModel[] }>(url);
    const models = Array.isArray(payload.data) ? payload.data : [];
    const entries = models.flatMap((model) => buildBitRouterPreparedEntries(model));
    if (entries.length === 0) {
      logger.warn("[AI Pricing] BitRouter catalog returned no priced models", {
        modelCount: models.length,
      });
    }
    return entries;
  });
}
