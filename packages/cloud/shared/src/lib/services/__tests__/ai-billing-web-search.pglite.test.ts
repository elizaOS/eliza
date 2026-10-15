/**
 * Real-catalog contract for Anthropic server-side web searches in the central
 * AI meter. Anthropic bills each search ($10 per 1,000) on top of tokens and
 * reports the count only in the provider's raw usage, so billUsage must read it
 * from there. Seeds the token prices through the same repository call the admin
 * override route uses, in in-process PGlite; pricing and billUsage are real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const MODEL = "claude-sonnet-4-6";
const INPUT_USD_PER_TOKEN = 3e-6;
const OUTPUT_USD_PER_TOKEN = 15e-6;
const SEARCH_USD = 0.01;

let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let billUsage: typeof import("../ai-billing").billUsage;
let markup: number;

const context = {
  organizationId: "00000000-0000-0000-0000-00000000c001",
  userId: "00000000-0000-0000-0000-00000000c002",
  apiKeyId: null,
  model: `anthropic/${MODEL}`,
  provider: "anthropic",
  billingSource: "bitrouter",
  requestId: "req-web-search",
} satisfies import("../ai-billing").BillingContext;

function reservation() {
  const reconciled: number[] = [];
  return {
    reconciled,
    handle: {
      reservedAmount: 0.05,
      reservationTransactionId: "00000000-0000-0000-0000-00000000c003",
      reconcile: async (actualCost: number) => {
        reconciled.push(actualCost);
      },
    } satisfies import("../ai-billing").CreditReservation,
  };
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb } = await import("../../../db/client"));
  const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
  const { aiPricingEntries } = await import("../../../db/schemas/ai-pricing");
  await pushSchemaToTestDb({ aiPricingEntries });
  const { aiPricingRepository } = await import("../../../db/repositories/ai-pricing");
  for (const [chargeType, unitPrice] of [
    ["input", INPUT_USD_PER_TOKEN],
    ["output", OUTPUT_USD_PER_TOKEN],
  ] as const) {
    await aiPricingRepository.createManualOverride({
      billingSource: "bitrouter",
      provider: "anthropic",
      model: `anthropic/${MODEL}`,
      productFamily: "language",
      chargeType,
      unit: "token",
      unitPrice,
      dimensionKey: "*",
      dimensions: {},
      reason: "test: Anthropic list price",
      updatedBy: "test",
    });
  }
  ({ billUsage } = await import("../ai-billing"));
  ({ PLATFORM_MARKUP_MULTIPLIER: markup } = await import("../../pricing-constants"));
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

const tokens = { inputTokens: 10_058, outputTokens: 90, totalTokens: 10_148 };
const tokenOnlyCost = () =>
  (tokens.inputTokens * INPUT_USD_PER_TOKEN + tokens.outputTokens * OUTPUT_USD_PER_TOKEN) * markup;

describe("billUsage with Anthropic server-side web searches", () => {
  test("a call without searches is billed on tokens only", async () => {
    const held = reservation();
    const billing = await billUsage(context, { ...tokens, raw: {} }, held.handle);
    expect(billing.totalCost).toBeCloseTo(tokenOnlyCost(), 6);
    expect(billing.webSearchRequests).toBeUndefined();
    expect(held.reconciled).toEqual([billing.totalCost]);
  });

  test("searches reported in usage.raw are added with the platform markup", async () => {
    const held = reservation();
    const raw = { server_tool_use: { web_search_requests: 10 } };
    const billing = await billUsage(context, { ...tokens, raw }, held.handle);
    const searchCost = 10 * SEARCH_USD * markup;
    expect(billing.webSearchRequests).toBe(10);
    expect(billing.totalCost).toBeCloseTo(tokenOnlyCost() + searchCost, 6);
    expect(billing.baseTotalCost).toBeCloseTo(billing.totalCost / markup, 6);
    expect(billing.inputCost + billing.outputCost).toBeCloseTo(billing.totalCost, 6);
    // The reconciled amount (what the organization is charged) includes the searches.
    expect(held.reconciled).toEqual([billing.totalCost]);
    expect(held.reconciled[0]).toBeGreaterThan(tokenOnlyCost() + searchCost - 1e-6);
  });

  test("an explicit search count (aborted stream) is billed the same way", async () => {
    const billing = await billUsage(context, { ...tokens, webSearchRequests: 3 });
    expect(billing.webSearchRequests).toBe(3);
    expect(billing.totalCost).toBeCloseTo(tokenOnlyCost() + 3 * SEARCH_USD * markup, 6);
  });
});
