/**
 * A /v1/chat stream the client closes before the provider finishes is billed
 * for the output it delivered, not for the admitted 500-token estimate. Real
 * billing and pricing on PGlite; only the reservation settlers are observed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const MODEL = "anthropic/claude-sonnet-4-6";
const INPUT_PRICE = 3e-6;
const OUTPUT_PRICE = 15e-6;
let closeDb: typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb } = await import(
    "@elizaos/cloud-shared/db/client"
  ));
  const { pushSchemaToTestDb } = await import(
    "../../shared/src/db/push-schema-for-tests"
  );
  const { aiPricingEntries } = await import(
    "../../shared/src/db/schemas/ai-pricing"
  );
  await pushSchemaToTestDb({ aiPricingEntries });
  const { aiPricingRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/ai-pricing"
  );
  for (const [chargeType, unitPrice] of [
    ["input", INPUT_PRICE],
    ["output", OUTPUT_PRICE],
  ] as const) {
    await aiPricingRepository.createManualOverride({
      billingSource: "bitrouter",
      provider: "anthropic",
      model: MODEL,
      productFamily: "language",
      chargeType,
      unit: "token",
      unitPrice,
      dimensionKey: "*",
      dimensions: {},
      reason: "test: isolated prices",
      updatedBy: "test",
    });
  }
});

afterAll(async () => {
  await closeDb?.();
});

const billingContext = {
  organizationId: "00000000-0000-0000-0000-00000000c001",
  userId: "00000000-0000-0000-0000-00000000c002",
  apiKeyId: undefined,
  model: MODEL,
  provider: "anthropic",
  billingSource: "bitrouter" as const,
  affiliateCode: null,
  requestId: "chat-abort-delivered",
};

test("an aborted stream is billed for the output it delivered", async () => {
  const { __chatStreamSettlementTestHooks } = await import("../v1/chat/route");
  const { estimateTokens } = await import("@elizaos/cloud-shared/lib/pricing");
  // Far more than the 500-token admission estimate.
  const deliveredText = "The quick brown fox jumps over the lazy dog. ".repeat(
    400,
  );
  const deliveredTokens = estimateTokens(deliveredText);
  expect(deliveredTokens).toBeGreaterThan(2_000);

  const charges: number[] = [];
  let unknownSettlements = 0;
  await __chatStreamSettlementTestHooks.settleChatStreamAbort({
    billingContext,
    estimatedInputTokens: 20,
    admittedOutputTokens: 500,
    deliveredText,
    billingReservation: undefined,
    settleReservation: async (amount) => {
      charges.push(amount);
      return null;
    },
    settleUnknown: async () => {
      unknownSettlements += 1;
      return null;
    },
  });

  expect(unknownSettlements).toBe(0);
  expect(charges).toHaveLength(1);
  // At least the delivered output at the output price: the 500-token estimate
  // would have been 500 * OUTPUT_PRICE.
  expect(charges[0]).toBeGreaterThanOrEqual(deliveredTokens * OUTPUT_PRICE);
  expect(charges[0]).toBeGreaterThan(500 * OUTPUT_PRICE * 4);
});

test("an abort before any output keeps the admitted estimate", async () => {
  const { __chatStreamSettlementTestHooks } = await import("../v1/chat/route");
  const charges: number[] = [];
  let unknownSettlements = 0;
  await __chatStreamSettlementTestHooks.settleChatStreamAbort({
    billingContext,
    estimatedInputTokens: 20,
    admittedOutputTokens: 500,
    deliveredText: "",
    billingReservation: undefined,
    settleReservation: async (amount) => {
      charges.push(amount);
      return null;
    },
    settleUnknown: async () => {
      unknownSettlements += 1;
      return null;
    },
  });
  expect(charges).toEqual([]);
  expect(unknownSettlements).toBe(1);
});

test.each([
  // A thinking request reserves its reasoning budget; a short visible answer
  // must not settle below that reservation.
  {
    label: "a short answer under a large reservation",
    deliveredChars: 680,
    admittedOutputTokens: 12_096,
  },
  {
    label: "a long answer still under the reservation",
    deliveredChars: 19_200,
    admittedOutputTokens: 20_096,
  },
])(
  "an abort keeps the reservation for $label",
  async ({ deliveredChars, admittedOutputTokens }) => {
    const { __chatStreamSettlementTestHooks } = await import(
      "../v1/chat/route"
    );
    const charges: number[] = [];
    let unknownSettlements = 0;
    await __chatStreamSettlementTestHooks.settleChatStreamAbort({
      billingContext,
      estimatedInputTokens: 20,
      admittedOutputTokens,
      deliveredText: "x".repeat(deliveredChars),
      billingReservation: undefined,
      settleReservation: async (amount) => {
        charges.push(amount);
        return null;
      },
      settleUnknown: async () => {
        unknownSettlements += 1;
        return null;
      },
    });
    expect(charges).toEqual([]);
    expect(unknownSettlements).toBe(1);
  },
);
