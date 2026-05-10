import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { dbWrite } from "@/db/helpers";
import {
  type AiPricingEntry,
  aiPricingRepository,
  type NewAiPricingEntry,
} from "@/db/repositories/ai-pricing";
import {
  aiPricingEntries,
  aiPricingRefreshRuns,
  type PricingDimensions,
} from "@/db/schemas/ai-pricing";
import { PLATFORM_MARKUP_MULTIPLIER } from "@/lib/pricing-constants";
import {
  expandOpenRouterModelIdCandidates,
  expandPersistedPricingProviderKeys,
  normalizeProviderKey,
} from "@/lib/providers/model-id-translation";
import { logger } from "@/lib/utils/logger";
import {
  ELEVENLABS_SNAPSHOT_PRICING,
  getSupportedMusicModelDefinition,
  getSupportedVideoModelDefinition,
  MUSIC_SNAPSHOT_PRICING,
  PRICING_LEGACY_IDS_BY_TARGET,
  PRICING_MODEL_ALIASES,
  type PricingBillingSource,
  type PricingChargeUnit,
  type PricingProductFamily,
  SUPPORTED_IMAGE_MODELS,
  SUPPORTED_VIDEO_MODELS,
  type SupportedVideoModelDefinition,
} from "./ai-pricing-definitions";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";
const EXTERNAL_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_OPENROUTER_IMAGE_OUTPUT_TOKENS = 1300;

type PriceLookupSource = PricingBillingSource | "seed";

type PricingRefreshSource = "gateway" | "openrouter" | "fal" | "elevenlabs" | "suno";

type PreparedPricingEntry = {
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

type OpenRouterCatalogModel = {
  id: string;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: Record<string, unknown>;
};

type ExternalCacheValue = {
  expiresAt: number;
  entries: PreparedPricingEntry[];
};

type CandidatePreparedPricingEntry = {
  entry: PreparedPricingEntry;
  modelId: string;
  logicalProvider: string;
};

const externalCatalogCache = new Map<string, ExternalCacheValue>();

function decimalToMoney(value: Decimal): number {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();
}

function asDecimal(value: number | string | Decimal): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

function applyPlatformMarkup(baseCost: Decimal): {
  baseTotalCost: number;
  totalCost: number;
  platformMarkup: number;
} {
  const total = baseCost.mul(PLATFORM_MARKUP_MULTIPLIER);
  const roundedBase = decimalToMoney(baseCost);
  const roundedTotal = decimalToMoney(total);

  return {
    baseTotalCost: roundedBase,
    totalCost: roundedTotal,
    platformMarkup: decimalToMoney(total.minus(baseCost)),
  };
}

function normalizeDimensionValue(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return JSON.stringify(value);
}

export function normalizePricingDimensions(
  dimensions?: Record<string, unknown>,
): PricingDimensions {
  if (!dimensions) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(dimensions)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalizeDimensionValue(value)]),
  );
}

export function buildDimensionKey(dimensions?: Record<string, unknown>): string {
  const normalized = normalizePricingDimensions(dimensions);
  return Object.keys(normalized).length === 0 ? "*" : JSON.stringify(normalized);
}

function dimensionsAreSubset(candidate: PricingDimensions, requested: PricingDimensions): boolean {
  return Object.entries(candidate).every(([key, value]) => requested[key] === value);
}

function sourcePriorityForKind(sourceKind: string): number {
  if (sourceKind === "manual_override") return 1000;
  if (sourceKind === "fal_model_page") return 250;
  if (sourceKind === "openrouter_catalog") return 175;
  if (sourceKind === "elevenlabs_snapshot") return 150;
  return 100;
}

function canonicalModelId(model: string, provider?: string | null): string {
  if (model.includes("/")) {
    return model;
  }

  if (provider === "elevenlabs") {
    return `elevenlabs/${model}`;
  }

  if (provider === "fal") {
    return model;
  }

  if (provider) {
    return `${provider}/${model}`;
  }

  return model;
}

function inferProviderFromCanonicalModel(model: string): string {
  if (model.startsWith("fal-ai/") || model.startsWith("wan/")) return "fal";
  if (model.startsWith("elevenlabs/")) return "elevenlabs";
  if (!model.includes("/")) return "unknown";
  return normalizeProviderKey(model.split("/", 1)[0]);
}

/** Provider column for a catalog `model` row; cross-provider aliases use the target id prefix, not the request gateway. */
export function providerForPricingCandidate(modelId: string, requestProvider: string): string {
  const inferred = inferProviderFromCanonicalModel(modelId);
  return inferred !== "unknown" ? inferred : requestProvider;
}

function normalizeBillingSourceCandidates(
  requested: PricingBillingSource | undefined,
  provider: string,
): PricingBillingSource[] {
  if (!requested) {
    if (provider === "elevenlabs") return ["elevenlabs"];
    if (provider === "fal") return ["fal"];
    if (provider === "suno") return ["suno"];
    return ["openrouter"];
  }

  switch (requested) {
    case "openai":
      return ["openai", "openrouter"];
    case "anthropic":
      return ["anthropic", "openrouter"];
    case "groq":
      return ["groq", "openrouter"];
    default:
      return [requested];
  }
}

function hashPreparedEntry(entry: PreparedPricingEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        billingSource: entry.billingSource,
        provider: entry.provider,
        model: entry.model,
        productFamily: entry.productFamily,
        chargeType: entry.chargeType,
        unit: entry.unit,
        unitPrice: entry.unitPrice,
        dimensions: normalizePricingDimensions(entry.dimensions),
        sourceUrl: entry.sourceUrl,
        metadata: entry.metadata ?? {},
      }),
    )
    .digest("hex");
}

function toDbEntry(entry: PreparedPricingEntry, timestamp: Date): NewAiPricingEntry {
  const dimensions = normalizePricingDimensions(entry.dimensions);

  return {
    billing_source: entry.billingSource,
    provider: entry.provider,
    model: entry.model,
    product_family: entry.productFamily,
    charge_type: entry.chargeType,
    unit: entry.unit,
    unit_price: entry.unitPrice.toString(),
    currency: "USD",
    dimension_key: buildDimensionKey(dimensions),
    dimensions,
    source_kind: entry.sourceKind,
    source_url: entry.sourceUrl,
    source_hash: hashPreparedEntry(entry),
    fetched_at: entry.fetchedAt ?? timestamp,
    stale_after: entry.staleAfter ?? new Date(timestamp.getTime() + EXTERNAL_CACHE_TTL_MS),
    effective_from: timestamp,
    priority: entry.priority ?? sourcePriorityForKind(entry.sourceKind),
    is_active: true,
    is_override: entry.isOverride ?? false,
    metadata: entry.metadata ?? {},
    updated_at: timestamp,
  };
}

function aiEntryToPrepared(entry: AiPricingEntry): PreparedPricingEntry {
  return {
    billingSource: entry.billing_source as PriceLookupSource,
    provider: entry.provider,
    model: entry.model,
    productFamily: entry.product_family as PricingProductFamily,
    chargeType: entry.charge_type,
    unit: entry.unit as PricingChargeUnit,
    unitPrice: Number(entry.unit_price),
    dimensions: entry.dimensions,
    sourceKind: entry.source_kind,
    sourceUrl: entry.source_url,
    fetchedAt: entry.fetched_at ?? undefined,
    staleAfter: entry.stale_after ?? undefined,
    priority: entry.priority,
    isOverride: entry.is_override,
    metadata: entry.metadata,
  };
}

function parseNumericPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

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

function buildOpenRouterPreparedEntries(model: OpenRouterCatalogModel): PreparedPricingEntry[] {
  const pricing = model.pricing ?? {};
  const provider = inferProviderFromCanonicalModel(model.id);
  const productFamily = inferOpenRouterProductFamily(model);
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);
  const entries: PreparedPricingEntry[] = [];

  const promptPrice = parseNumericPrice(pricing.prompt);
  if (promptPrice != null) {
    entries.push({
      billingSource: "openrouter",
      provider,
      model: model.id,
      productFamily,
      chargeType: "input",
      unit: "token",
      unitPrice: promptPrice,
      sourceKind: "openrouter_catalog",
      sourceUrl: OPENROUTER_MODELS_URL,
      fetchedAt,
      staleAfter,
    });
  }

  const completionPrice = parseNumericPrice(pricing.completion);
  if (completionPrice != null) {
    entries.push({
      billingSource: "openrouter",
      provider,
      model: model.id,
      productFamily,
      chargeType: "output",
      unit: "token",
      unitPrice: completionPrice,
      sourceKind: "openrouter_catalog",
      sourceUrl: OPENROUTER_MODELS_URL,
      fetchedAt,
      staleAfter,
    });
  }

  return entries;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFalPricingParagraph(html: string): string {
  const match = html.match(
    /(?:For every second of video.*?<\/p>|Your request will cost.*?<\/p>|For a 5s video without audio.*?<\/p>)/is,
  );

  if (!match) {
    throw new Error("Pricing paragraph not found on fal model page");
  }

  return stripHtml(match[0]);
}

function buildFalEntry(
  model: SupportedVideoModelDefinition,
  unit: PricingChargeUnit,
  unitPrice: number,
  dimensions: PricingDimensions = {},
  metadata?: Record<string, unknown>,
): PreparedPricingEntry {
  const fetchedAt = new Date();
  return {
    billingSource: "fal",
    provider: "fal",
    model: model.modelId,
    productFamily: "video",
    chargeType: "generation",
    unit,
    unitPrice,
    dimensions,
    sourceKind: "fal_model_page",
    sourceUrl: model.pageUrl,
    fetchedAt,
    staleAfter: new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS),
    metadata,
  };
}

function parseFalPricingEntries(
  model: SupportedVideoModelDefinition,
  paragraph: string,
): PreparedPricingEntry[] {
  const entries: PreparedPricingEntry[] = [];

  switch (model.pricingParser) {
    case "veo": {
      const match = paragraph.match(/\$([\d.]+)\s+\(audio off\)\s+or\s+\$([\d.]+)\s+\(audio on\)/i);
      if (!match) {
        throw new Error(`Unable to parse Veo pricing paragraph: ${paragraph}`);
      }

      entries.push(buildFalEntry(model, "second", Number(match[1]), { audio: false }));
      entries.push(buildFalEntry(model, "second", Number(match[2]), { audio: true }));
      break;
    }
    case "veo31": {
      const match = paragraph.match(
        /\$([\d.]+)\s+without audio\s+or\s+\$([\d.]+)\s+with audio\s+for 720p or 1080p.*?\$([\d.]+)\s+per second without audio,\s+or\s+\$([\d.]+)\s+with/i,
      );
      if (!match) {
        throw new Error(`Unable to parse Veo 3.1 pricing paragraph: ${paragraph}`);
      }

      for (const resolution of ["720p", "1080p"]) {
        entries.push(
          buildFalEntry(model, "second", Number(match[1]), {
            resolution,
            audio: false,
          }),
        );
        entries.push(
          buildFalEntry(model, "second", Number(match[2]), {
            resolution,
            audio: true,
          }),
        );
      }
      entries.push(
        buildFalEntry(model, "second", Number(match[3]), {
          resolution: "4k",
          audio: false,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[4]), {
          resolution: "4k",
          audio: true,
        }),
      );
      break;
    }
    case "veo31lite": {
      const match = paragraph.match(
        /\$([\d.]+)\s+for 720p with audio,\s+\$([\d.]+)\s+for 720p without audio,\s+\$([\d.]+)\s+for 1080p with audio\s+or\s+\$([\d.]+)\s+for 1080p without audio/i,
      );
      if (!match) {
        throw new Error(`Unable to parse Veo 3.1 Lite pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "second", Number(match[1]), {
          resolution: "720p",
          audio: true,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[2]), {
          resolution: "720p",
          audio: false,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[3]), {
          resolution: "1080p",
          audio: true,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[4]), {
          resolution: "1080p",
          audio: false,
        }),
      );
      break;
    }
    case "kling": {
      const match = paragraph.match(
        /\$([\d.]+)\s+\(audio off\)\s+or\s+\$([\d.]+)\s+\(audio on\)(?:,\s+if voice control is used while generating audio you will be charged\s+\$([\d.]+))?/i,
      );
      if (!match) {
        throw new Error(`Unable to parse Kling pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "second", Number(match[1]), {
          audio: false,
          voiceControl: false,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[2]), {
          audio: true,
          voiceControl: false,
        }),
      );
      if (match[3]) {
        entries.push(
          buildFalEntry(model, "second", Number(match[3]), {
            audio: true,
            voiceControl: true,
          }),
        );
      }
      break;
    }
    case "hailuo_standard": {
      const match = paragraph.match(/\$([\d.]+)\s+per\s+6 second.*?\$([\d.]+)\s+per\s+10 second/i);
      if (!match) {
        throw new Error(`Unable to parse Hailuo standard pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "request", Number(match[1]), {
          durationSeconds: 6,
        }),
      );
      entries.push(
        buildFalEntry(model, "request", Number(match[2]), {
          durationSeconds: 10,
        }),
      );
      break;
    }
    case "hailuo_pro": {
      const match = paragraph.match(/\$([\d.]+)\s+per video generation/i);
      if (!match) {
        throw new Error(`Unable to parse Hailuo pro pricing paragraph: ${paragraph}`);
      }

      entries.push(buildFalEntry(model, "request", Number(match[1]), {}));
      break;
    }
    case "wan": {
      const match = paragraph.match(
        /\$([\d.]+)\s+per second for 720p,\s+\$([\d.]+)\s+per second for 1080p/i,
      );
      if (!match) {
        throw new Error(`Unable to parse Wan pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "second", Number(match[1]), {
          resolution: "720p",
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[2]), {
          resolution: "1080p",
        }),
      );
      break;
    }
    case "pixverse": {
      const match = paragraph.match(
        /\$([\d.]+)\s+for 360p and 540p,\s+\$([\d.]+)\s+for 720p,\s+and\s+\$([\d.]+)\s+for 1080p\.\s+Enabling audio adds\s+\$([\d.]+)\s+for 360p\/540p\/720p,\s+and\s+\$([\d.]+)\s+for 1080p\.\s+For 8-second videos, costs are 2x the 5-second base;\s+for 10-second videos, costs are 2.2x the 5-second base/i,
      );
      if (!match) {
        throw new Error(`Unable to parse PixVerse pricing paragraph: ${paragraph}`);
      }

      const baseByResolution: Record<string, number> = {
        "360p": Number(match[1]),
        "540p": Number(match[1]),
        "720p": Number(match[2]),
        "1080p": Number(match[3]),
      };
      const audioAddByResolution: Record<string, number> = {
        "360p": Number(match[4]),
        "540p": Number(match[4]),
        "720p": Number(match[4]),
        "1080p": Number(match[5]),
      };
      const multipliers: Record<number, number> = { 5: 1, 8: 2, 10: 2.2 };

      for (const [duration, multiplier] of Object.entries(multipliers)) {
        const numericDuration = Number(duration);
        for (const [resolution, basePrice] of Object.entries(baseByResolution)) {
          if (numericDuration === 10 && resolution === "1080p") {
            continue;
          }

          const silentPrice = basePrice * multiplier;
          entries.push(
            buildFalEntry(model, "request", silentPrice, {
              durationSeconds: numericDuration,
              resolution,
              audio: false,
            }),
          );

          const audioPrice = (basePrice + audioAddByResolution[resolution]) * multiplier;
          entries.push(
            buildFalEntry(model, "request", audioPrice, {
              durationSeconds: numericDuration,
              resolution,
              audio: true,
            }),
          );
        }
      }
      break;
    }
    case "seedance": {
      const match = paragraph.match(/\$([\d.]+)\/second/);
      if (!match) {
        throw new Error(`Unable to parse Seedance pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "second", Number(match[1]), {
          resolution: "720p",
        }),
      );
      break;
    }
  }

  return entries;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ElizaCloudPricingBot/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return await response.text();
}

function evictExpiredCacheEntries(): void {
  const now = Date.now();
  for (const [key, value] of externalCatalogCache) {
    if (value.expiresAt <= now) {
      externalCatalogCache.delete(key);
    }
  }
}

async function getCachedExternalEntries(
  cacheKey: string,
  loader: () => Promise<PreparedPricingEntry[]>,
): Promise<PreparedPricingEntry[]> {
  const cached = externalCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entries;
  }

  // Evict expired entries before adding new ones to prevent unbounded growth
  evictExpiredCacheEntries();

  const entries = await loader();
  externalCatalogCache.set(cacheKey, {
    entries,
    expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS,
  });
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
  "qwen/qwen3-embedding-8b",
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

async function fetchOpenRouterCatalogEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("openrouter", async () => {
    const payload = await fetchJson<{ data?: OpenRouterCatalogModel[] }>(OPENROUTER_MODELS_URL);
    const models = Array.isArray(payload.data) ? payload.data : [];
    const bulkEntries = models.flatMap((model) => buildOpenRouterPreparedEntries(model));
    const embeddingEntries = await fetchOpenRouterEmbeddingEndpointEntries();
    const imageEntries = await fetchOpenRouterImageEndpointEntries();
    return [...bulkEntries, ...embeddingEntries, ...imageEntries];
  });
}

async function fetchFalCatalogEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("fal", async () => {
    const entryArrays = await Promise.all(
      SUPPORTED_VIDEO_MODELS.map(async (model) => {
        try {
          const html = await fetchText(model.pageUrl);
          const paragraph = extractFalPricingParagraph(html);
          return parseFalPricingEntries(model, paragraph);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("[AI Pricing] fal parse failed, falling back to DB", {
            model: model.modelId,
            error: message,
          });

          // Fallback: return last known active DB entries for this model
          const dbEntries = await aiPricingRepository.listActiveEntries({
            billingSource: "fal",
            provider: "fal",
            model: model.modelId,
            productFamily: "video",
            chargeType: "generation",
          });

          if (dbEntries.length > 0) {
            return dbEntries.map((entry) => aiEntryToPrepared(entry));
          }

          logger.error("[AI Pricing] No DB fallback available", {
            model: model.modelId,
          });
          return [];
        }
      }),
    );

    return [...entryArrays.flat(), ...buildMusicSnapshotEntries("fal", "fal_model_page")];
  });
}

function buildMusicSnapshotEntries(
  billingSource?: PricingBillingSource,
  sourceKind?: string,
): PreparedPricingEntry[] {
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);
  return MUSIC_SNAPSHOT_PRICING.filter(
    (entry) => !billingSource || entry.billingSource === billingSource,
  ).map((entry) => ({
    billingSource: entry.billingSource,
    provider: entry.provider,
    model: entry.modelId,
    productFamily: entry.productFamily,
    chargeType: entry.chargeType,
    unit: entry.unit,
    unitPrice: entry.unitPrice,
    dimensions: entry.dimensions,
    sourceKind:
      sourceKind ??
      (entry.billingSource === "suno"
        ? "suno_snapshot"
        : entry.billingSource === "fal"
          ? "fal_model_page"
          : "elevenlabs_snapshot"),
    sourceUrl: entry.sourceUrl,
    fetchedAt,
    staleAfter,
    metadata: entry.metadata,
  }));
}

async function fetchElevenLabsEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("elevenlabs", async () => {
    const fetchedAt = new Date();
    const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);

    return [
      ...ELEVENLABS_SNAPSHOT_PRICING.map((entry) => ({
        billingSource: entry.billingSource,
        provider: entry.provider,
        model: entry.modelId,
        productFamily: entry.productFamily,
        chargeType: entry.chargeType,
        unit: entry.unit,
        unitPrice: entry.unitPrice,
        dimensions: entry.dimensions,
        sourceKind: "elevenlabs_snapshot",
        sourceUrl: entry.sourceUrl,
        fetchedAt,
        staleAfter,
        metadata: entry.metadata,
      })),
      ...buildMusicSnapshotEntries("elevenlabs", "elevenlabs_snapshot"),
    ];
  });
}

async function fetchSunoEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("suno", async () =>
    buildMusicSnapshotEntries("suno", "suno_snapshot"),
  );
}

async function fetchEntriesForSource(source: PriceLookupSource): Promise<PreparedPricingEntry[]> {
  switch (source) {
    case "gateway":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "groq":
      return await fetchOpenRouterCatalogEntries();
    case "fal":
      return await fetchFalCatalogEntries();
    case "elevenlabs":
      return await fetchElevenLabsEntries();
    case "suno":
      return await fetchSunoEntries();
    case "vast":
    case "seed":
      return [];
  }
}

/**
 * Tie-breaker ordering for persisted/live pricing rows that share priority and
 * dimension specificity but differ only by provider namespace (`xai` vs `x-ai`).
 *
 * **Why:** During migration both spellings can exist briefly; picking the
 * logical key first keeps charges aligned with app-level provider labels and
 * avoids non-deterministic `localeCompare` on `model` deciding billing.
 */
function providerPersistRank(provider: string, logicalProvider: string): number {
  const keys = expandPersistedPricingProviderKeys(logicalProvider);
  const idx = keys.indexOf(provider);
  return idx === -1 ? keys.length : idx;
}

function chooseBestCandidatePricingEntry(
  candidates: CandidatePreparedPricingEntry[],
  requestedDimensions: PricingDimensions,
  canonicalModel: string,
): CandidatePreparedPricingEntry | null {
  const matching = candidates.filter(({ entry }) =>
    dimensionsAreSubset(normalizePricingDimensions(entry.dimensions), requestedDimensions),
  );

  if (matching.length === 0) {
    return null;
  }

  const sorted = [...matching].sort((left, right) => {
    const priorityDiff = (right.entry.priority ?? 0) - (left.entry.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;

    const specificityDiff =
      Object.keys(normalizePricingDimensions(right.entry.dimensions)).length -
      Object.keys(normalizePricingDimensions(left.entry.dimensions)).length;
    if (specificityDiff !== 0) return specificityDiff;

    const leftCanonicalRank = left.modelId === canonicalModel ? 0 : 1;
    const rightCanonicalRank = right.modelId === canonicalModel ? 0 : 1;
    const canonicalDiff = leftCanonicalRank - rightCanonicalRank;
    if (canonicalDiff !== 0) return canonicalDiff;

    const providerDiff =
      providerPersistRank(left.entry.provider, left.logicalProvider) -
      providerPersistRank(right.entry.provider, right.logicalProvider);
    if (providerDiff !== 0) return providerDiff;

    return right.modelId.localeCompare(left.modelId);
  });

  return sorted[0] ?? null;
}

/**
 * Anthropic API returns dated snapshot ids (e.g. claude-sonnet-4-5-20250929); gateway
 * and OpenRouter list stable ids (e.g. claude-sonnet-4.5). Map suffix for catalog lookup.
 */
function normalizeAnthropicCatalogModelSuffix(suffix: string): string {
  let s = suffix.replace(/-20\d{6,8}$/, "");
  let prev = "";
  for (let i = 0; i < 8 && prev !== s; i++) {
    prev = s;
    s = s.replace(/-(\d)-(\d)(?=-|$)/g, "-$1.$2");
  }
  return s;
}

function stripOpenRouterModelVariant(model: string): string | null {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  const variantIndex = model.indexOf(":", slashIndex >= 0 ? slashIndex : 0);
  if (variantIndex === -1) {
    return null;
  }
  return model.slice(0, variantIndex);
}

/** Manual gateway rename map + inverse (new id → legacy ids still in DB). */
function collectGatewayPricingManualAliasCandidates(canonicalModel: string): string[] {
  const extras: string[] = [];
  const seen = new Set<string>();
  const push = (m: string) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    extras.push(m);
  };

  const forward = PRICING_MODEL_ALIASES[canonicalModel];
  if (forward) {
    for (const target of forward) {
      push(target);
    }
  }

  for (const legacyId of PRICING_LEGACY_IDS_BY_TARGET[canonicalModel] ?? []) {
    if (legacyId !== canonicalModel) {
      push(legacyId);
    }
  }

  return extras;
}

/**
 * Ordered ids to try when resolving pricing (exact first, then catalog aliases).
 *
 * **Why OpenRouter + gateway variants:** Manual alias tables and DB rows may
 * still key off either spelling; expanding both avoids “pricing unavailable” for
 * valid models during migration.
 */
export function expandPricingCatalogModelCandidates(canonicalModel: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (m: string) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    out.push(m);
  };

  const pushWithTranslations = (m: string) => {
    for (const translated of expandOpenRouterModelIdCandidates(m)) {
      push(translated);
    }
  };

  pushWithTranslations(canonicalModel);
  const baseVariantModel = stripOpenRouterModelVariant(canonicalModel);
  if (baseVariantModel) {
    pushWithTranslations(baseVariantModel);
  }
  // Alias keys are gateway-style (`xai/...`, `mistral/...`); look them up using
  // either spelling so OpenRouter-form callers also resolve to known aliases.
  for (const aliasKey of expandOpenRouterModelIdCandidates(canonicalModel)) {
    for (const id of collectGatewayPricingManualAliasCandidates(aliasKey)) {
      pushWithTranslations(id);
    }
  }
  if (canonicalModel.startsWith("anthropic/")) {
    const suffix = canonicalModel.slice("anthropic/".length);
    const normalized = normalizeAnthropicCatalogModelSuffix(suffix);
    if (normalized !== suffix) {
      push(`anthropic/${normalized}`);
    }
  }

  return out;
}

/**
 * Resolves a single prepared pricing row for token/flat charges.
 *
 * **Why provider expansion:** `ai_pricing` may store `provider` as either the
 * short logical key (`xai`) or OpenRouter’s namespace (`x-ai`) from ingest
 * timing; querying both prevents false “pricing unavailable” during and after
 * migration. **Why union-ranking:** Equivalent model spellings are collected
 * before choosing one row, so caller spelling cannot change the billed price
 * when duplicate rows exist under `xai/...` and `x-ai/...`.
 */
async function resolvePreparedPricingEntry(params: {
  billingSource?: PricingBillingSource;
  provider: string;
  model: string;
  productFamily: PricingProductFamily;
  chargeType: string;
  dimensions?: Record<string, unknown>;
}): Promise<PreparedPricingEntry> {
  const canonicalModel = canonicalModelId(params.model, params.provider);
  const modelCandidates = expandPricingCatalogModelCandidates(canonicalModel);
  const requestedDimensions = normalizePricingDimensions(params.dimensions);
  const sources = normalizeBillingSourceCandidates(params.billingSource, params.provider);

  for (const source of sources) {
    const providerModelPairs = modelCandidates.flatMap((modelId) => {
      const logical = providerForPricingCandidate(modelId, params.provider);
      return expandPersistedPricingProviderKeys(logical).map((provider) => ({
        provider,
        model: modelId,
      }));
    });

    const allPersisted = await aiPricingRepository.listActiveEntriesForProviderModelPairs({
      billingSource: source,
      productFamily: params.productFamily,
      chargeType: params.chargeType,
      pairs: providerModelPairs,
    });

    const persistedCandidates = modelCandidates.flatMap(
      (modelId): CandidatePreparedPricingEntry[] => {
        const logicalProvider = providerForPricingCandidate(modelId, params.provider);
        const providerKeys = expandPersistedPricingProviderKeys(logicalProvider);
        return allPersisted
          .filter((row) => row.model === modelId && providerKeys.includes(row.provider))
          .map((entry) => ({
            entry: aiEntryToPrepared(entry),
            modelId,
            logicalProvider,
          }));
      },
    );

    const bestPersisted = chooseBestCandidatePricingEntry(
      persistedCandidates,
      requestedDimensions,
      canonicalModel,
    );
    if (bestPersisted) {
      if (bestPersisted.modelId !== canonicalModel) {
        logger.warn("ai-pricing: resolved pricing via alias", {
          canonicalModel,
          resolvedVia: bestPersisted.modelId,
          productFamily: params.productFamily,
          chargeType: params.chargeType,
          billingSource: source,
        });
      }
      return bestPersisted.entry;
    }

    const liveAll = await fetchEntriesForSource(source);
    const liveCandidates = modelCandidates.flatMap((modelId): CandidatePreparedPricingEntry[] => {
      const logicalProvider = providerForPricingCandidate(modelId, params.provider);
      const providerKeys = expandPersistedPricingProviderKeys(logicalProvider);
      return liveAll
        .filter(
          (entry) =>
            entry.model === modelId &&
            providerKeys.includes(entry.provider) &&
            entry.productFamily === params.productFamily &&
            entry.chargeType === params.chargeType,
        )
        .map((entry) => ({
          entry,
          modelId,
          logicalProvider,
        }));
    });

    const bestLive = chooseBestCandidatePricingEntry(
      liveCandidates,
      requestedDimensions,
      canonicalModel,
    );
    if (bestLive) {
      if (bestLive.modelId !== canonicalModel) {
        logger.warn("ai-pricing: resolved pricing via alias", {
          canonicalModel,
          resolvedVia: bestLive.modelId,
          productFamily: params.productFamily,
          chargeType: params.chargeType,
          billingSource: source,
        });
      }
      return bestLive.entry;
    }
  }

  throw new Error(
    `Pricing unavailable for ${params.productFamily}:${params.chargeType} ${canonicalModel}`,
  );
}

function computeCostFromEntry(entry: PreparedPricingEntry, quantity: number): FlatOperationCost {
  const baseCost = asDecimal(entry.unitPrice).mul(quantity);
  const markedUp = applyPlatformMarkup(baseCost);

  return {
    totalCost: markedUp.totalCost,
    baseTotalCost: markedUp.baseTotalCost,
    platformMarkup: markedUp.platformMarkup,
    matchedEntry: {
      billingSource: entry.billingSource,
      provider: entry.provider,
      model: entry.model,
      productFamily: entry.productFamily,
      chargeType: entry.chargeType,
      unit: entry.unit,
      unitPrice: entry.unitPrice,
      dimensions: normalizePricingDimensions(entry.dimensions),
      sourceKind: entry.sourceKind,
      sourceUrl: entry.sourceUrl,
    },
  };
}

function quantityForEntryUnit(
  unit: PricingChargeUnit,
  amount: {
    count?: number;
    durationSeconds?: number;
    durationMinutes?: number;
    durationHours?: number;
    characters?: number;
    tokens?: number;
    requests?: number;
  },
): number {
  switch (unit) {
    case "image":
      return amount.count ?? amount.requests ?? 1;
    case "second":
      return amount.durationSeconds ?? 0;
    case "minute":
      return amount.durationMinutes ?? (amount.durationSeconds ?? 0) / 60;
    case "hour":
      return amount.durationHours ?? (amount.durationSeconds ?? 0) / 3600;
    case "character":
      return amount.characters ?? 0;
    case "token":
      return amount.tokens ?? 0;
    case "request":
      return amount.requests ?? 1;
    case "1k_requests":
      return (amount.requests ?? 0) / 1000;
  }
}

export async function calculateTextCostFromCatalog(params: {
  model: string;
  provider: string;
  billingSource?: PricingBillingSource;
  inputTokens: number;
  outputTokens: number;
}): Promise<TokenCostBreakdown> {
  const canonicalModel = canonicalModelId(params.model, params.provider);
  const inputEntry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: canonicalModel,
    productFamily: params.model.includes("embedding") ? "embedding" : "language",
    chargeType: "input",
  });
  const outputEntry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: canonicalModel,
    productFamily: params.model.includes("embedding") ? "embedding" : "language",
    chargeType: "output",
  }).catch(() => null);

  const baseInputCost = asDecimal(inputEntry.unitPrice).mul(params.inputTokens);
  const baseOutputCost = outputEntry
    ? asDecimal(outputEntry.unitPrice).mul(params.outputTokens)
    : new Decimal(0);

  const inputTotals = applyPlatformMarkup(baseInputCost);
  const outputTotals = applyPlatformMarkup(baseOutputCost);

  return {
    inputCost: inputTotals.totalCost,
    outputCost: outputTotals.totalCost,
    totalCost: decimalToMoney(asDecimal(inputTotals.totalCost).plus(outputTotals.totalCost)),
    baseInputCost: inputTotals.baseTotalCost,
    baseOutputCost: outputTotals.baseTotalCost,
    baseTotalCost: decimalToMoney(baseInputCost.plus(baseOutputCost)),
    platformMarkup: decimalToMoney(
      asDecimal(inputTotals.platformMarkup).plus(outputTotals.platformMarkup),
    ),
  };
}

export async function calculateImageGenerationCostFromCatalog(params: {
  model: string;
  provider: string;
  billingSource?: PricingBillingSource;
  imageCount?: number;
  dimensions?: Record<string, unknown>;
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider: params.provider,
    model: params.model,
    productFamily: "image",
    chargeType: "generation",
    dimensions: params.dimensions,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, { count: params.imageCount ?? 1 }),
  );
}

export async function calculateVideoGenerationCostFromCatalog(params: {
  model: string;
  billingSource?: "fal";
  durationSeconds?: number;
  dimensions?: Record<string, unknown>;
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource ?? "fal",
    provider: "fal",
    model: params.model,
    productFamily: "video",
    chargeType: "generation",
    dimensions: params.dimensions,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, {
      durationSeconds: params.durationSeconds,
      requests: 1,
    }),
  );
}

export async function calculateMusicGenerationCostFromCatalog(params: {
  model: string;
  provider?: "fal" | "elevenlabs" | "suno";
  billingSource?: "fal" | "elevenlabs" | "suno";
  durationSeconds?: number;
  dimensions?: Record<string, unknown>;
}): Promise<FlatOperationCost> {
  const definition = getSupportedMusicModelDefinition(params.model);
  const provider =
    params.provider ?? definition?.provider ?? inferProviderFromCanonicalModel(params.model);
  const entry = await resolvePreparedPricingEntry({
    billingSource: params.billingSource,
    provider,
    model: params.model,
    productFamily: "music",
    chargeType: "generation",
    dimensions: params.dimensions,
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, {
      durationSeconds: params.durationSeconds ?? definition?.defaultParameters.durationSeconds,
      requests: 1,
    }),
  );
}

export async function calculateTTSCostFromCatalog(params: {
  model: string;
  characterCount: number;
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: "elevenlabs",
    provider: "elevenlabs",
    model: params.model,
    productFamily: "tts",
    chargeType: "generation",
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, { characters: params.characterCount }),
  );
}

export async function calculateSTTCostFromCatalog(params: {
  model: string;
  durationSeconds: number;
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: "elevenlabs",
    provider: "elevenlabs",
    model: params.model,
    productFamily: "stt",
    chargeType: "generation",
  });

  return computeCostFromEntry(
    entry,
    quantityForEntryUnit(entry.unit, {
      durationSeconds: params.durationSeconds,
    }),
  );
}

export async function calculateVoiceCloneCostFromCatalog(params: {
  cloneType: "instant" | "professional";
}): Promise<FlatOperationCost> {
  const entry = await resolvePreparedPricingEntry({
    billingSource: "elevenlabs",
    provider: "elevenlabs",
    model: `elevenlabs/${params.cloneType}`,
    productFamily: "voice_clone",
    chargeType: "generation",
  });

  return computeCostFromEntry(entry, 1);
}

export function getDefaultVideoBillingDimensions(modelId: string): {
  durationSeconds: number;
  dimensions: PricingDimensions;
} {
  const definition = getSupportedVideoModelDefinition(modelId);
  if (!definition) {
    throw new Error(`Unsupported video model: ${modelId}`);
  }

  const dimensions = normalizePricingDimensions({
    ...(definition.defaultParameters.resolution
      ? { resolution: definition.defaultParameters.resolution }
      : {}),
    ...(definition.defaultParameters.audio !== undefined
      ? { audio: definition.defaultParameters.audio }
      : {}),
    ...(definition.defaultParameters.voiceControl !== undefined
      ? { voiceControl: definition.defaultParameters.voiceControl }
      : {}),
    ...(definition.pricingParser === "hailuo_standard"
      ? { durationSeconds: definition.defaultParameters.durationSeconds }
      : {}),
    ...(definition.pricingParser === "pixverse"
      ? { durationSeconds: definition.defaultParameters.durationSeconds }
      : {}),
  });

  return {
    durationSeconds: definition.defaultParameters.durationSeconds,
    dimensions,
  };
}

async function refreshSourceEntries(
  source: PricingRefreshSource,
  sourceUrl: string,
  loader: () => Promise<PreparedPricingEntry[]>,
): Promise<{
  source: PricingRefreshSource;
  fetchedEntries: number;
  upsertedEntries: number;
  deactivatedEntries: number;
  success: boolean;
  error?: string;
}> {
  const startedAt = new Date();
  const [run] = await dbWrite
    .insert(aiPricingRefreshRuns)
    .values({
      source,
      status: "running",
      source_url: sourceUrl,
      started_at: startedAt,
      metadata: {},
    })
    .returning();

  try {
    const entries = await loader();
    if (entries.length === 0) {
      throw new Error(`No pricing entries fetched from ${source}`);
    }

    const now = new Date();
    const dbEntries = entries.map((entry) => toDbEntry(entry, now));

    const currentActiveRows = await aiPricingRepository.listActiveEntries({
      sourceKind: dbEntries[0]?.source_kind ?? source,
    });

    await dbWrite.transaction(async (tx) => {
      // Full snapshot replace for this source_kind: every active row is deactivated,
      // then the freshly fetched catalog is inserted. Stale product_family values
      // (e.g. token rows previously stored as "image") are not left active alongside
      // corrected rows; there is no partial upsert keyed only on model + charge_type.
      await tx
        .update(aiPricingEntries)
        .set({
          is_active: false,
          effective_until: now,
          updated_at: now,
        })
        .where(
          and(
            eq(aiPricingEntries.is_active, true),
            eq(aiPricingEntries.source_kind, dbEntries[0].source_kind),
          ),
        );

      await tx.insert(aiPricingEntries).values(dbEntries);

      await tx
        .update(aiPricingRefreshRuns)
        .set({
          status: "completed",
          fetched_entries: entries.length,
          upserted_entries: dbEntries.length,
          deactivated_entries: currentActiveRows.length,
          completed_at: new Date(),
        })
        .where(eq(aiPricingRefreshRuns.id, run.id));
    });

    return {
      source,
      fetchedEntries: entries.length,
      upsertedEntries: dbEntries.length,
      deactivatedEntries: currentActiveRows.length,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[AI Pricing] Refresh failed", { source, error: message });

    await dbWrite
      .update(aiPricingRefreshRuns)
      .set({
        status: "failed",
        error: message,
        completed_at: new Date(),
      })
      .where(eq(aiPricingRefreshRuns.id, run.id));

    return {
      source,
      fetchedEntries: 0,
      upsertedEntries: 0,
      deactivatedEntries: 0,
      success: false,
      error: message,
    };
  }
}

export async function refreshPricingCatalog(
  sources: PricingRefreshSource[] = ["openrouter", "fal", "elevenlabs"],
) {
  const results = [];

  if (sources.includes("openrouter")) {
    results.push(
      await refreshSourceEntries("openrouter", OPENROUTER_MODELS_URL, async () => {
        return await fetchOpenRouterCatalogEntries();
      }),
    );
  }

  if (sources.includes("fal")) {
    results.push(
      await refreshSourceEntries("fal", "https://fal.ai/models", async () => {
        return await fetchFalCatalogEntries();
      }),
    );
  }

  if (sources.includes("elevenlabs")) {
    results.push(
      await refreshSourceEntries("elevenlabs", "https://elevenlabs.io/pricing/api", async () => {
        return await fetchElevenLabsEntries();
      }),
    );
  }

  if (sources.includes("suno")) {
    results.push(
      await refreshSourceEntries("suno", "https://docs.sunoapi.org/suno-api/", async () => {
        return await fetchSunoEntries();
      }),
    );
  }

  return {
    success: results.every((result) => result.success),
    results,
    refreshedAt: new Date().toISOString(),
  };
}

export async function listPersistedPricingEntries(filters?: {
  billingSource?: string;
  provider?: string;
  model?: string;
  productFamily?: string;
  chargeType?: string;
}) {
  const entries = await aiPricingRepository.listActiveEntries({
    billingSource: filters?.billingSource,
    provider: filters?.provider,
    model: filters?.model ? canonicalModelId(filters.model, filters.provider) : undefined,
    productFamily: filters?.productFamily,
    chargeType: filters?.chargeType,
  });

  return entries.map((entry) => aiEntryToPrepared(entry));
}

export async function listRecentPricingRefreshRuns(limit: number = 20) {
  return await aiPricingRepository.listRecentRefreshRuns(limit);
}
