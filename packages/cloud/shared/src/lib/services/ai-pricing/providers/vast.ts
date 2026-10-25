// Coordinates cloud service vast behavior behind route handlers.
import { logger } from "../../../utils/logger";
import { getCachedExternalEntries } from "../cache";
import { EXTERNAL_CACHE_TTL_MS, type PreparedPricingEntry } from "../types";

const VAST_DEFAULT_PRICING_PER_1M: Record<string, { input: number; output: number }> = {
  "vast/eliza-1-2b": { input: 0.2, output: 0.4 },
  "vast/eliza-1-9b": { input: 1, output: 2 },
  "vast/eliza-1-27b": { input: 4, output: 8 },
  "vast/eliza-1-27b-256k": { input: 5, output: 10 },
};

export function parseVastPricingOverrides(): Record<string, { input: number; output: number }> {
  const raw = process.env.VAST_PRICING_PER_1M_JSON?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { input?: unknown; output?: unknown }>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([model, value]) => {
        const input = Number(value?.input);
        const output = Number(value?.output);
        if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
          logger.warn("ai-pricing: ignoring invalid Vast pricing override", {
            model,
          });
          return [];
        }
        return [[model, { input, output }]];
      }),
    );
  } catch (error) {
    logger.warn("ai-pricing: failed to parse VAST_PRICING_PER_1M_JSON", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export async function fetchVastSnapshotEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("vast", async () => {
    const fetchedAt = new Date();
    const staleAfter = new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS);
    const prices = {
      ...VAST_DEFAULT_PRICING_PER_1M,
      ...parseVastPricingOverrides(),
    };

    return Object.entries(prices).flatMap(([model, perMillion]) =>
      (
        [
          ["input", perMillion.input],
          ["output", perMillion.output],
        ] as const
      ).map(([chargeType, perMillionTokens]) => ({
        billingSource: "vast",
        provider: "vast",
        model,
        productFamily: "language",
        chargeType,
        unit: "token",
        unitPrice: perMillionTokens / 1_000_000,
        sourceKind: "vast_internal_snapshot",
        sourceUrl: "internal://vast/pricing",
        fetchedAt,
        staleAfter,
        metadata: {
          perMillionTokens,
          overrideableBy: "VAST_PRICING_PER_1M_JSON",
        },
      })),
    );
  });
}
