import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { affiliateCodes } from "@/db/schemas/affiliates";
import { aiPricingEntries } from "@/db/schemas/ai-pricing";
import { organizations } from "@/db/schemas/organizations";
import { redeemableEarnings } from "@/db/schemas/redeemable-earnings";
import { users } from "@/db/schemas/users";
import { affiliatesService } from "@/lib/services/affiliates";
import { billUsage } from "@/lib/services/ai-billing";

let affiliateUser: { id: string; email: string };
let callerUser: { id: string; email: string; organizationId: string };
let codeString = "";
const testPricingProvider = "affiliate-test-provider";
const testPricingModel = `affiliate-test-model-${Date.now()}`;
const canonicalTestPricingModel = `${testPricingProvider}/${testPricingModel}`;

async function setupFixtures() {
  const now = new Date();

  const idA = crypto.randomUUID();
  const emailA = `test-affiliate-skus-${Date.now()}@test.local`;
  await dbWrite.insert(users).values({
    id: idA,
    steward_user_id: `test-affiliate-skus-${idA}`,
    email: emailA,
    name: "Affiliate SKU Owner",
    created_at: now,
    updated_at: now,
  });

  const affiliateCode = await affiliatesService.getOrCreateAffiliateCode(idA);
  // Set 50% checkout markup
  await affiliatesService.updateMarkup(idA, 50);
  codeString = affiliateCode.code;

  const idB = crypto.randomUUID();
  const orgId = crypto.randomUUID();

  await dbWrite.insert(organizations).values({
    id: orgId,
    name: "Test Org",
    slug: `test-org-${Date.now()}`,
    credit_balance: "1000",
    is_active: true,
  });

  const emailB = `test-caller-${Date.now()}@test.local`;
  await dbWrite.insert(users).values({
    id: idB,
    steward_user_id: `test-caller-${idB}`,
    email: emailB,
    name: "Caller User",
    organization_id: orgId,
    created_at: now,
    updated_at: now,
  });

  await dbWrite.insert(aiPricingEntries).values([
    {
      billing_source: "openrouter",
      provider: testPricingProvider,
      model: canonicalTestPricingModel,
      product_family: "language",
      charge_type: "input",
      unit: "token",
      unit_price: "0.01",
      source_kind: "manual_override",
      source_url: "test://ai-billing-affiliates",
      is_override: true,
      updated_by: "ai-billing-affiliates.test.ts",
    },
    {
      billing_source: "openrouter",
      provider: testPricingProvider,
      model: canonicalTestPricingModel,
      product_family: "language",
      charge_type: "output",
      unit: "token",
      unit_price: "0.02",
      source_kind: "manual_override",
      source_url: "test://ai-billing-affiliates",
      is_override: true,
      updated_by: "ai-billing-affiliates.test.ts",
    },
  ]);

  return {
    userA: { id: idA, email: emailA },
    userB: { id: idB, email: emailB, organizationId: orgId },
  };
}

async function cleanupFixtures() {
  await dbWrite
    .delete(aiPricingEntries)
    .where(eq(aiPricingEntries.model, canonicalTestPricingModel))
    .catch(() => {});
  if (affiliateUser) {
    await dbWrite
      .delete(affiliateCodes)
      .where(eq(affiliateCodes.user_id, affiliateUser.id))
      .catch(() => {});
    await dbWrite
      .delete(users)
      .where(eq(users.id, affiliateUser.id))
      .catch(() => {});
  }
  if (callerUser) {
    await dbWrite
      .delete(users)
      .where(eq(users.id, callerUser.id))
      .catch(() => {});
    await dbWrite
      .delete(organizations)
      .where(eq(organizations.id, callerUser.organizationId))
      .catch(() => {});
  }
}

describe("AI Billing: Affiliate SKUs", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    const fixtures = await setupFixtures();
    affiliateUser = fixtures.userA;
    callerUser = fixtures.userB;
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  test("billUsage applies affiliate markup and credits the affiliate owner", async () => {
    let reconciledCost = 0;

    const usageData = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      totalCost: 10, // Base platform cost
    };

    const result = await billUsage(
      {
        organizationId: callerUser.organizationId,
        userId: callerUser.id,
        model: testPricingModel,
        provider: testPricingProvider,
        description: "Test AI inference",
        affiliateCode: codeString, // Important!
      },
      usageData,
      {
        reservedAmount: 10,
        reconcile: async (cost: number) => {
          reconciledCost = cost;
        },
      },
    );

    // Ensure cost is greater than 0
    expect(result.totalCost).toBeGreaterThan(0);

    // Ensure reconcile matched total cost
    expect(reconciledCost).toBe(result.totalCost);

    // Ensure the affiliate got 50% of the platform cost added to their redeemable earnings
    // The total cost should be: platformCost + affiliateEarnings.
    // Therefore, affiliateEarnings = result.totalCost - result.platformCost
    // Wait, billUsage returns the markup numbers inside `result`! Let's check `affiliateMarkup` and `platformMarkup`.
    // Let's just retrieve the redeemable earnings from the DB.

    const finalAffiliateEarnings = await dbRead
      .select({ balance: redeemableEarnings.available_balance })
      .from(redeemableEarnings)
      .where(eq(redeemableEarnings.user_id, affiliateUser.id))
      .limit(1);

    // Because of float math, use toBeCloseTo
    const earned = Number(finalAffiliateEarnings[0]?.balance || 0);
    expect(earned).toBeGreaterThan(0);
    // earned should exactly match result.affiliateMarkup if it's exported, or roughly 50% of base.
    // But since we just want to ensure it credited properly:
    expect(earned).toBeCloseTo(result.totalCost - result.totalCost / 1.5, 4);
  });
});
