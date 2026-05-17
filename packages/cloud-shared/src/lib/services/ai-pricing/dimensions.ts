import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { AiPricingEntry, NewAiPricingEntry } from "../../../db/repositories/ai-pricing";
import type { PricingDimensions } from "../../../db/schemas/ai-pricing";
import { PLATFORM_MARKUP_MULTIPLIER } from "../../pricing-constants";
import { normalizeProviderKey } from "../../providers/model-id-translation";
import type {
  PricingBillingSource,
  PricingChargeUnit,
  PricingProductFamily,
} from "../ai-pricing-definitions";
import { EXTERNAL_CACHE_TTL_MS, type PreparedPricingEntry, type PriceLookupSource } from "./types";

export function decimalToMoney(value: Decimal): number {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();
}

export function asDecimal(value: number | string | Decimal): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export function applyPlatformMarkup(baseCost: Decimal): {
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

export function dimensionsAreSubset(
  candidate: PricingDimensions,
  requested: PricingDimensions,
): boolean {
  return Object.entries(candidate).every(([key, value]) => requested[key] === value);
}

export function sourcePriorityForKind(sourceKind: string): number {
  if (sourceKind === "manual_override") return 1000;
  if (sourceKind === "fal_model_page") return 250;
  if (sourceKind === "openrouter_catalog") return 175;
  if (sourceKind === "elevenlabs_snapshot") return 150;
  return 100;
}

export function canonicalModelId(model: string, provider?: string | null): string {
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

export function inferProviderFromCanonicalModel(model: string): string {
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

export function normalizeBillingSourceCandidates(
  requested: PricingBillingSource | undefined,
  provider: string,
): PricingBillingSource[] {
  if (!requested) {
    if (provider === "elevenlabs") return ["elevenlabs"];
    if (provider === "fal") return ["fal"];
    if (provider === "suno") return ["suno"];
    if (provider === "vast") return ["vast"];
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

export function toDbEntry(entry: PreparedPricingEntry, timestamp: Date): NewAiPricingEntry {
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

export function aiEntryToPrepared(entry: AiPricingEntry): PreparedPricingEntry {
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

export function parseNumericPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
