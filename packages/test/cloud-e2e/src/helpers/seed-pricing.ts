/**
 * Seed a persisted `ai_pricing` catalog entry for a model so the booted stack
 * can price (and therefore bill) real inference WITHOUT a live BitRouter key.
 *
 * The pricing lookup (`ai-pricing/lookup.ts`) checks persisted DB rows for the
 * requested billing source BEFORE falling back to the live BitRouter catalog
 * loader (which throws `BITROUTER_API_KEY environment variable is required` in
 * the local stack). `/api/v1/messages` resolves `billingSource="openai"` for an
 * `openai/<model>` id (`resolveAiProviderSource`), and that maps to the
 * `["openai", "bitrouter"]` source order — so an `openai`-source persisted row
 * short-circuits the lookup and real billing works locally.
 *
 * Prices are realistic per-token rates (gpt-4o-mini-ish): the point is a real,
 * non-zero, markup-applied debit — not fabricated earnings.
 */
export async function seedModelPricing(opts: {
  model: string;
  inputPerToken?: number;
  outputPerToken?: number;
  billingSource?: string;
  provider?: string;
}): Promise<void> {
  const { aiPricingRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/ai-pricing"
  );

  const base = {
    billing_source: opts.billingSource ?? "openai",
    provider: opts.provider ?? "openai",
    model: opts.model,
    product_family: "language" as const,
    unit: "tokens" as const,
    currency: "USD" as const,
    dimension_key: "*" as const,
    dimensions: {},
    source_kind: "manual" as const,
    source_url: "test://seed-pricing",
    is_active: true,
    // The lookup gates rows on `effective_from <= now()`. The column is a
    // `timestamp` (no tz), and PGlite's `defaultNow()` writes the session-local
    // wall clock, which drizzle reads back as UTC — so in a non-UTC test box the
    // default `effective_from` lands a few hours in the FUTURE and the row is
    // silently filtered out (no pricing → 500 / degraded billing). Stamp it a day
    // in the past so the seeded row is active regardless of the runner's zone.
    effective_from: new Date(Date.now() - 86_400_000),
  };

  await aiPricingRepository.createMany([
    {
      ...base,
      charge_type: "input",
      unit_price: String(opts.inputPerToken ?? 0.00000015),
    },
    {
      ...base,
      charge_type: "output",
      unit_price: String(opts.outputPerToken ?? 0.0000006),
    },
  ]);
}
