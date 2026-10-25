// Coordinates cloud service openrouter behavior behind route handlers.
import { logger } from "../../../utils/logger";
import { inferProviderFromCanonicalModel, parseNumericPrice } from "../dimensions";
import {
  type BitRouterCatalogModel,
  EXTERNAL_CACHE_TTL_MS,
  type PreparedPricingEntry,
} from "../types";

// OpenRouter publishes per-token USD prices (pricing.prompt / pricing.completion)
// for hundreds of language models with NO auth. We append these as LOW-PRIORITY
// (-1) fallback rows to the BitRouter gateway result so any model the API offers
// that BitRouter's catalog does not price (e.g. openai/gpt-5.5,
// anthropic/claude-haiku-4.5, x-ai/grok-4.20) still resolves a real price instead
// of 500-ing "Pricing unavailable". A live BitRouter price or a FORCED row
// (priority 0) always wins over these, so this never overrides a configured
// price — it only fills gaps. Same source the gpt-oss-120b forced row cites.
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// Non-language families have dedicated pricing paths (image/video/tts/stt/
// embedding charge by image/second/character, not per token). Only language
// token pricing is mirrored from OpenRouter.
const NON_LANGUAGE_MODEL_ID = /image|embedding|whisper|\btts\b|audio|video|moderation/i;

export function buildOpenRouterPreparedEntries(
  model: BitRouterCatalogModel,
): PreparedPricingEntry[] {
  if (!model?.id || NON_LANGUAGE_MODEL_ID.test(model.id)) return [];

  const pricing = model.pricing ?? {};
  const provider = inferProviderFromCanonicalModel(model.id);
  const fetchedAt = new Date();
  const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);

  const buildEntry = (chargeType: "input" | "output", unitPrice: number): PreparedPricingEntry => ({
    billingSource: "bitrouter",
    provider,
    model: model.id,
    productFamily: "language",
    chargeType,
    unit: "token",
    unitPrice,
    sourceKind: "openrouter_catalog",
    sourceUrl: OPENROUTER_MODELS_URL,
    fetchedAt,
    staleAfter,
    // Fallback only — BitRouter live rows and FORCED rows (priority 0) win.
    priority: -1,
  });

  const entries: PreparedPricingEntry[] = [];
  // OpenRouter `prompt`/`completion` are USD per token (OpenRouter flat form),
  // used as-is — matching resolveTokenUnitPrice's flat-field handling.
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

export async function fetchOpenRouterCatalogEntries(): Promise<PreparedPricingEntry[]> {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: {
        "User-Agent": "ElizaCloudPricingBot/1.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.warn("[AI Pricing] OpenRouter catalog fetch failed", {
        status: response.status,
      });
      return [];
    }
    const payload = (await response.json()) as { data?: BitRouterCatalogModel[] };
    const models = Array.isArray(payload.data) ? payload.data : [];
    return models.flatMap((model) => buildOpenRouterPreparedEntries(model));
  } catch (error) {
    // Non-fatal: OpenRouter is a fallback price source. If it is unreachable the
    // BitRouter catalog + forced rows still resolve every configured model.
    logger.warn("[AI Pricing] OpenRouter catalog fetch error (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
