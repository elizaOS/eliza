import { logger } from "../../../utils/logger";
import { type PricingProductFamily, SUPPORTED_IMAGE_MODELS } from "../../ai-pricing-definitions";
import { getCachedExternalEntries } from "../cache";
import { inferProviderFromCanonicalModel, parseNumericPrice } from "../dimensions";
import { fetchJson } from "../fetch";
import { stripVersionedSnapshotSuffix } from "../suffix-stripping";
import {
  DEFAULT_OPENROUTER_IMAGE_OUTPUT_TOKENS,
  EXTERNAL_CACHE_TTL_MS,
  OPENROUTER_MODELS_URL,
  type OpenRouterCatalogModel,
  type PreparedPricingEntry,
} from "../types";

function inferOpenRouterProductFamily(model: OpenRouterCatalogModel): PricingProductFamily {
  if (model.id.includes("embedding")) {
    return "embedding";
  }
  // OpenRouter's `architecture.modality` mixes input + output modalities (e.g.
  // "text+image+file->text"), so a text model that accepts images would be
  // misclassified as "image" if we just .includes("image"). Inspect the
  // dedicated output modalities array instead — image only when the model
  // emits images. Fall back to the legacy combined string only when the
  // explicit array is missing.
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

/**
 * Builds pricing entries from a single OpenRouter catalog row.
 *
 * For each (input/output) price we emit the exact-id row at default priority
 * and — when `stripVersionedSnapshotSuffix` produces a base id — a duplicate
 * row at `priority: -1` so lookups for the unsuffixed canonical id resolve.
 * The exact match still wins via `chooseBestCandidatePricingEntry`'s priority
 * tie-break when both forms are requested.
 */
export function buildOpenRouterPreparedEntries(
  model: OpenRouterCatalogModel,
): PreparedPricingEntry[] {
  const pricing = model.pricing ?? {};
  const provider = inferProviderFromCanonicalModel(model.id);
  const productFamily = inferOpenRouterProductFamily(model);
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);
  const baseId = stripVersionedSnapshotSuffix(model.id);

  const buildEntry = (
    modelId: string,
    chargeType: "input" | "output",
    unitPrice: number,
    priority?: number,
  ): PreparedPricingEntry => ({
    billingSource: "openrouter",
    provider,
    model: modelId,
    productFamily,
    chargeType,
    unit: "token",
    unitPrice,
    sourceKind: "openrouter_catalog",
    sourceUrl: OPENROUTER_MODELS_URL,
    fetchedAt,
    staleAfter,
    ...(priority !== undefined ? { priority } : {}),
  });

  const entries: PreparedPricingEntry[] = [];
  const promptPrice = parseNumericPrice(pricing.prompt);
  if (promptPrice != null) {
    entries.push(buildEntry(model.id, "input", promptPrice));
    if (baseId !== null) {
      entries.push(buildEntry(baseId, "input", promptPrice, -1));
    }
  }

  const completionPrice = parseNumericPrice(pricing.completion);
  if (completionPrice != null) {
    entries.push(buildEntry(model.id, "output", completionPrice));
    if (baseId !== null) {
      entries.push(buildEntry(baseId, "output", completionPrice, -1));
    }
  }

  return entries;
}

// Embedding models are NOT returned by OpenRouter's bulk /v1/models listing,
// even though /v1/embeddings serves them. Pricing is exposed only via the
// per-model endpoints route, so we fetch those explicitly for every embedding
// model OpenRouter actually serves and merge them into the catalog.
//
// Inventory checked against OpenRouter on 2026-04-28: these are the embedding
// model ids that return a populated `/api/v1/models/{id}/endpoints` response.
const OPENROUTER_EMBEDDING_MODEL_IDS = [
  "openai/text-embedding-3-small",
  "openai/text-embedding-3-large",
  "openai/text-embedding-ada-002",
] as const;

async function fetchOpenRouterEmbeddingEndpointEntries(): Promise<PreparedPricingEntry[]> {
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);

  const results = await Promise.all(
    OPENROUTER_EMBEDDING_MODEL_IDS.map(async (modelId): Promise<PreparedPricingEntry[]> => {
      const url = `https://openrouter.ai/api/v1/models/${modelId}/endpoints`;
      try {
        const payload = await fetchJson<{
          data?: {
            endpoints?: Array<{
              pricing?: { prompt?: string | number };
            }>;
          };
        }>(url);
        const endpoint = payload.data?.endpoints?.[0];
        const unitPrice = parseNumericPrice(endpoint?.pricing?.prompt);
        if (unitPrice == null) {
          return [];
        }
        return [
          {
            billingSource: "openrouter",
            provider: inferProviderFromCanonicalModel(modelId),
            model: modelId,
            productFamily: "embedding",
            chargeType: "input",
            unit: "token",
            unitPrice,
            sourceKind: "openrouter_endpoints",
            sourceUrl: url,
            fetchedAt,
            staleAfter,
          },
        ];
      } catch (error) {
        logger.warn("[AI Pricing] OpenRouter embedding endpoint fetch failed", {
          modelId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }),
  );

  return results.flat();
}

async function fetchOpenRouterImageEndpointEntries(): Promise<PreparedPricingEntry[]> {
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);

  const results = await Promise.all(
    SUPPORTED_IMAGE_MODELS.map(async (model): Promise<PreparedPricingEntry[]> => {
      const url = `https://openrouter.ai/api/v1/models/${model.modelId}/endpoints`;
      try {
        const payload = await fetchJson<{
          data?: {
            endpoints?: Array<{
              pricing?: { image_output?: string | number };
            }>;
          };
        }>(url);
        const endpoint = payload.data?.endpoints?.[0];
        const outputTokenPrice = parseNumericPrice(endpoint?.pricing?.image_output);
        if (outputTokenPrice == null) {
          return [];
        }
        const estimatedOutputTokens =
          model.estimatedOutputTokens ?? DEFAULT_OPENROUTER_IMAGE_OUTPUT_TOKENS;

        return [
          {
            billingSource: "openrouter",
            provider: inferProviderFromCanonicalModel(model.modelId),
            model: model.modelId,
            productFamily: "image",
            chargeType: "generation",
            unit: "image",
            unitPrice: outputTokenPrice * estimatedOutputTokens,
            dimensions: model.defaultDimensions,
            sourceKind: "openrouter_endpoints",
            sourceUrl: url,
            fetchedAt,
            staleAfter,
            metadata: {
              estimated_output_tokens: estimatedOutputTokens,
              image_output_token_price: outputTokenPrice,
            },
          },
        ];
      } catch (error) {
        logger.warn("[AI Pricing] OpenRouter image endpoint fetch failed", {
          modelId: model.modelId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }),
  );

  return results.flat();
}

export async function fetchOpenRouterCatalogEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("openrouter", async () => {
    const payload = await fetchJson<{ data?: OpenRouterCatalogModel[] }>(OPENROUTER_MODELS_URL);
    const models = Array.isArray(payload.data) ? payload.data : [];
    const bulkEntries = models.flatMap((model) => buildOpenRouterPreparedEntries(model));
    const embeddingEntries = await fetchOpenRouterEmbeddingEndpointEntries();
    const imageEntries = await fetchOpenRouterImageEndpointEntries();
    return [...bulkEntries, ...embeddingEntries, ...imageEntries];
  });
}
