import type { PricingDimensions } from "../../../db/schemas/ai-pricing";
import {
  expandOpenRouterModelIdCandidates,
  expandPersistedPricingProviderKeys,
} from "../../providers/model-id-translation";
import { PRICING_LEGACY_IDS_BY_TARGET, PRICING_MODEL_ALIASES } from "../ai-pricing-definitions";
import { dimensionsAreSubset, normalizePricingDimensions } from "./dimensions";
import type { CandidatePreparedPricingEntry } from "./types";

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

export function chooseBestCandidatePricingEntry(
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

    // When two stripped snapshot variants reduce to the same canonical id
    // (e.g. `gemini-2.0-flash-001` and `gemini-2.0-flash-002` both stripping
    // to `gemini-2.0-flash`), every preceding tie-break is a no-op. Prefer
    // the higher unitPrice as a conservative fallback: never under-bill the
    // platform when snapshot prices diverge.
    const priceDiff = right.entry.unitPrice - left.entry.unitPrice;
    if (priceDiff !== 0) return priceDiff;

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
 * still key off either spelling; expanding both avoids "pricing unavailable" for
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
