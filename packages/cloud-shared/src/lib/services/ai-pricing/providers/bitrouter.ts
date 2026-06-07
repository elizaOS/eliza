import { getProviderKey } from "../../../providers/provider-env";
import { logger } from "../../../utils/logger";
import { type PricingChargeUnit, type PricingProductFamily } from "../../ai-pricing-definitions";
import { getCachedExternalEntries } from "../cache";
import { inferProviderFromCanonicalModel, parseNumericPrice } from "../dimensions";
import { stripVersionedSnapshotSuffix } from "../suffix-stripping";
import {
  type BitRouterCatalogModel,
  EXTERNAL_CACHE_TTL_MS,
  type PreparedPricingEntry,
} from "../types";

const CEREBRAS_PRICING_SOURCE_URL = "https://www.cerebras.ai/pricing";
// OpenRouter doesn't return a priced row from BitRouter for `openai/gpt-oss-120b`,
// but it's the canonical fallback for the cloud's default TEXT_SMALL model
// (`openai/gpt-oss-120b:nitro`, see packages/core/src/contracts/service-routing.ts).
// Variant stripping in candidate-selection.ts collapses :nitro / :free to the
// base id, so one base entry covers every variant.
const OPENROUTER_PRICING_SOURCE_URL = "https://openrouter.ai/openai/gpt-oss-120b";

const FORCED_BITROUTER_PRICING: ReadonlyArray<{
  model: string;
  provider: string;
  productFamily: PricingProductFamily;
  unit: PricingChargeUnit;
  inputUnitPrice: number;
  outputUnitPrice: number;
  sourceUrl: string;
  metadata?: Record<string, unknown>;
}> = [
  {
    model: "cerebras:gpt-oss-120b",
    provider: "cerebras",
    productFamily: "language",
    unit: "token",
    inputUnitPrice: 0.00000035,
    outputUnitPrice: 0.00000075,
    sourceUrl: CEREBRAS_PRICING_SOURCE_URL,
    metadata: {
      sourceNote: "Cerebras Developer tier price converted from $0.35/$0.75 per 1M tokens.",
    },
  },
  {
    model: "cerebras:zai-glm-4.7",
    provider: "cerebras",
    productFamily: "language",
    unit: "token",
    inputUnitPrice: 0.00000225,
    outputUnitPrice: 0.00000275,
    sourceUrl: CEREBRAS_PRICING_SOURCE_URL,
    metadata: {
      sourceNote: "Cerebras Developer tier price converted from $2.25/$2.75 per 1M tokens.",
    },
  },
  {
    model: "openai/gpt-oss-120b",
    provider: "openai",
    productFamily: "language",
    unit: "token",
    // $0.10 / 1M input tokens
    inputUnitPrice: 0.0000001,
    // $0.50 / 1M output tokens
    outputUnitPrice: 0.0000005,
    sourceUrl: OPENROUTER_PRICING_SOURCE_URL,
    metadata: {
      sourceNote:
        "Estimate from OpenRouter public pricing (2026-06-07). Replace once BitRouter catalog returns a priced row for openai/gpt-oss-120b.",
    },
  },
];

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

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Resolves a per-token unit price from a BitRouter catalog `pricing` object.
 *
 * BitRouter exposes two shapes with DIFFERENT units:
 *  - legacy flat field (`prompt` / `completion`): USD **per token** (OpenRouter
 *    form) — used as-is;
 *  - structured field (`input_tokens.no_cache` / `output_tokens.text`): USD
 *    **per million tokens** — divided by 1e6 to normalize to per token.
 *
 * The catalog stores per-token unit prices, so the per-million form must be
 * converted or every cost is inflated ~1,000,000× (e.g. claude-sonnet at
 * input_tokens.no_cache=3 would bill $3/token instead of $0.000003/token).
 */
function resolveTokenUnitPrice(
  pricing: Record<string, unknown>,
  flatKey: "prompt" | "completion",
  group: "input_tokens" | "output_tokens",
  nestedKey: string,
): number | null {
  const flat = parseNumericPrice(pricing[flatKey]);
  if (flat != null) return flat;

  const perMillion = parseNumericPrice(nestedPrice(pricing, group, nestedKey));
  if (perMillion != null) return perMillion / TOKENS_PER_MILLION;

  return null;
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
  const promptPrice = resolveTokenUnitPrice(pricing, "prompt", "input_tokens", "no_cache");
  if (promptPrice != null) {
    entries.push(buildEntry(model.id, "input", promptPrice));
    if (baseId !== null) {
      entries.push(buildEntry(baseId, "input", promptPrice, -1));
    }
  }

  const completionPrice = resolveTokenUnitPrice(pricing, "completion", "output_tokens", "text");
  if (completionPrice != null) {
    entries.push(buildEntry(model.id, "output", completionPrice));
    if (baseId !== null) {
      entries.push(buildEntry(baseId, "output", completionPrice, -1));
    }
  }

  return entries;
}

function buildForcedBitRouterPricingEntries(): PreparedPricingEntry[] {
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);

  return FORCED_BITROUTER_PRICING.flatMap(
    ({
      model,
      provider,
      productFamily,
      unit,
      inputUnitPrice,
      outputUnitPrice,
      sourceUrl,
      metadata,
    }) => [
      {
        billingSource: "bitrouter" as const,
        provider,
        model,
        productFamily,
        chargeType: "input" as const,
        unit,
        unitPrice: inputUnitPrice,
        sourceKind: "bitrouter_catalog",
        sourceUrl,
        fetchedAt,
        staleAfter,
        metadata,
      },
      {
        billingSource: "bitrouter" as const,
        provider,
        model,
        productFamily,
        chargeType: "output" as const,
        unit,
        unitPrice: outputUnitPrice,
        sourceKind: "bitrouter_catalog",
        sourceUrl,
        fetchedAt,
        staleAfter,
        metadata,
      },
    ],
  );
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
    const payload = await fetchBitRouterJson<{
      data?: BitRouterCatalogModel[];
    }>(url);
    const models = Array.isArray(payload.data) ? payload.data : [];
    const entries = [
      ...models.flatMap((model) => buildBitRouterPreparedEntries(model)),
      ...buildForcedBitRouterPricingEntries(),
    ];
    if (entries.length === 0) {
      logger.warn("[AI Pricing] BitRouter catalog returned no priced models", {
        modelCount: models.length,
      });
    }
    return entries;
  });
}
