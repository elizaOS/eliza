// Coordinates cloud service candidate selection behavior behind route handlers.
import type { PricingDimensions } from "../../../db/schemas/ai-pricing";
import {
  expandBitRouterModelIdCandidates,
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
  const matching = candidates.filter(
    ({ entry }) =>
      // Drop any candidate whose price failed to parse to a finite, positive
      // number. `unitPrice` is `Number(entry.unit_price)` over a Postgres
      // NUMERIC column, so a corrupt row (`'NaN'::numeric` reads back as the
      // string "NaN") yields `NaN`. Left in place, such a candidate (a) makes
      // the `right.entry.unitPrice - left.entry.unitPrice` tie-break return
      // `NaN` — an inconsistent sort comparator that can non-deterministically
      // let the corrupt entry WIN over a valid one — and (b) if selected, is
      // billed via `asDecimal(NaN).mul(quantity)` = a `NaN` charge. Fail closed
      // by excluding it here so a corrupt price can never be chosen; the caller
      // then degrades to the fallback tier (provider-max / env default) or
      // fails closed, exactly as an absent price does. Mirrors the finite guard
      // in `resolveFallbackTokenRate`.
      Number.isFinite(entry.unitPrice) &&
      entry.unitPrice > 0 &&
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
 * and BitRouter list stable ids (e.g. claude-sonnet-4.5). Map suffix for catalog lookup.
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

function stripBitRouterModelVariant(model: string): string | null {
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

function stripForcedProviderPrefix(model: string): string | null {
  const slashIndex = model.indexOf("/");
  const colonIndex = model.indexOf(":");
  if (colonIndex <= 0 || (slashIndex !== -1 && slashIndex < colonIndex)) {
    return null;
  }
  return model.slice(colonIndex + 1);
}

/**
 * Slash forced-provider form (`cerebras/gpt-oss-120b`) → colon routing form
 * (`cerebras:gpt-oss-120b`). The pricing catalog keys forced provider rows in
 * BitRouter's colon-routing spelling, but `canonicalModelId(bareModel, provider)`
 * yields the slash spelling. A caller that hits the provider directly (e.g. the
 * shared runtime calling Cerebras) bills by `(bareModel, provider)`, so without
 * this bridge its lookup never reaches the colon-keyed row and throws
 * "Pricing unavailable". Mirror of {@link stripForcedProviderPrefix} (colon → bare).
 *
 * Returns null when the prefix is a dash-bearing namespace (`x-ai/...`) rather
 * than a single-token forced-provider key, or when the id already carries a colon
 * (a routing/variant id like `openai/gpt-oss-120b:nitro`).
 */
function forcedProviderColonVariant(model: string): string | null {
  if (model.includes(":")) return null;
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) return null;
  const prefix = model.slice(0, slashIndex);
  if (prefix.includes("-")) return null;
  return `${prefix}:${model.slice(slashIndex + 1)}`;
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
 * **Why BitRouter + gateway variants:** Manual alias tables and DB rows may
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
    for (const translated of expandBitRouterModelIdCandidates(m)) {
      push(translated);
    }
  };

  pushWithTranslations(canonicalModel);
  const colonForcedVariant = forcedProviderColonVariant(canonicalModel);
  if (colonForcedVariant) {
    pushWithTranslations(colonForcedVariant);
  }
  const unforcedModel = stripForcedProviderPrefix(canonicalModel);
  if (unforcedModel) {
    pushWithTranslations(unforcedModel);
  }
  const baseVariantModel = stripBitRouterModelVariant(canonicalModel);
  if (baseVariantModel) {
    pushWithTranslations(baseVariantModel);
  }
  // Alias keys are gateway-style (`xai/...`, `mistral/...`); look them up using
  // either spelling so BitRouter-form callers also resolve to known aliases.
  for (const aliasKey of expandBitRouterModelIdCandidates(canonicalModel)) {
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
