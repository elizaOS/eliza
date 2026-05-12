/**
 * Affiliate System Integration Tests
 *
 * Verifies that:
 * 1. Codes can be generated automatically
 * 2. Markup limits (0-1000%) are respected
 * 3. Users can be linked to other users' codes
 * 4. We can successfully trace a referrer from an end-user
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { dbWrite } from "@/db/client";
import { affiliateCodes, userAffiliates } from "@/db/schemas/affiliates";
import { users } from "@/db/schemas/users";
import { affiliatesService } from "@/lib/services/affiliates";

let userA: { id: string; email: string };
let userB: { id: string; email: string };

async function setupFixtures() {
  const now = new Date();

  const idA = crypto.randomUUID();
  const emailA = `test-affiliate-a-${Date.now()}@test.local`;
  await dbWrite.insert(users).values({
    id: idA,
    steward_user_id: `test-affiliate-a-${idA}`,
    email: emailA,
    name: "Affiliate Test User A",
    created_at: now,
    updated_at: now,
  });

  const idB = crypto.randomUUID();
  const emailB = `test-affiliate-b-${Date.now()}@test.local`;
  await dbWrite.insert(users).values({
    id: idB,
    steward_user_id: `test-affiliate-b-${idB}`,
    email: emailB,
    name: "Affiliate Test User B",
    created_at: now,
    updated_at: now,
  });

  return {
    userA: { id: idA, email: emailA },
    userB: { id: idB, email: emailB },
  };
}

async function cleanupFixtures() {
  if (userA) {
    await dbWrite
      .delete(userAffiliates)
      .where(eq(userAffiliates.user_id, userA.id))
      .catch(() => {});
    await dbWrite
      .delete(affiliateCodes)
      .where(eq(affiliateCodes.user_id, userA.id))
      .catch(() => {});
    await dbWrite
      .delete(users)
      .where(eq(users.id, userA.id))
      .catch(() => {});
  }
  if (userB) {
    await dbWrite
      .delete(userAffiliates)
      .where(eq(userAffiliates.user_id, userB.id))
      .catch(() => {});
    await dbWrite
      .delete(affiliateCodes)
      .where(eq(affiliateCodes.user_id, userB.id))
      .catch(() => {});
    await dbWrite
      .delete(users)
      .where(eq(users.id, userB.id))
      .catch(() => {});
  }
}

describe("Affiliate System Services", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    const fixtures = await setupFixtures();
    userA = fixtures.userA;
    userB = fixtures.userB;
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  test("can generate a new affiliate code with default 20% markup", async () => {
    const code = await affiliatesService.getOrCreateAffiliateCode(userA.id);

    expect(code).toBeDefined();
    expect(code.user_id).toBe(userA.id);
    expect(code.code.startsWith("AFF-")).toBe(true);
    // Returns as numeric string '20.00' due to numeric DB type
    expect(Number(code.markup_percent)).toBe(20.0);
  });

  test("can retrieve an existing code", async () => {
    const code1 = await affiliatesService.getOrCreateAffiliateCode(userA.id);
    const code2 = await affiliatesService.getOrCreateAffiliateCode(userA.id);

    expect(code1.id).toBe(code2.id);
    expect(code1.code).toBe(code2.code);
  });

  test("can update markup percentage within limits (0 - 1000%)", async () => {
    const defaultCode = await affiliatesService.getOrCreateAffiliateCode(userA.id);
    expect(Number(defaultCode.markup_percent)).toBe(20.0);

    const updated = await affiliatesService.updateMarkup(userA.id, 150.5);
    expect(Number(updated.markup_percent)).toBe(150.5);

    await expect(affiliatesService.updateMarkup(userA.id, 1001)).rejects.toThrow();
    await expect(affiliatesService.updateMarkup(userA.id, -1)).rejects.toThrow();
  });

  test("can link User B to User A's affiliate code", async () => {
    const affiliateOfA = await affiliatesService.getOrCreateAffiliateCode(userA.id);

    const link = await affiliatesService.linkUserToAffiliateCode(userB.id, affiliateOfA.code);
    expect(link).toBeDefined();
    expect(link.user_id).toBe(userB.id);
    expect(link.affiliate_code_id).toBe(affiliateOfA.id);
  });

  test("cannot link user to their own code", async () => {
    const affiliateOfA = await affiliatesService.getOrCreateAffiliateCode(userA.id);

    await expect(
      affiliatesService.linkUserToAffiliateCode(userA.id, affiliateOfA.code),
    ).rejects.toThrow("Users cannot refer themselves");
  });

  test("reuses an existing link for the same affiliate code", async () => {
    const affiliateOfA = await affiliatesService.getOrCreateAffiliateCode(userA.id);

    const firstLink = await affiliatesService.linkUserToAffiliateCode(userB.id, affiliateOfA.code);
    const secondLink = await affiliatesService.linkUserToAffiliateCode(userB.id, affiliateOfA.code);

    expect(secondLink.id).toBe(firstLink.id);
    expect(secondLink.user_id).toBe(userB.id);
    expect(secondLink.affiliate_code_id).toBe(affiliateOfA.id);
  });

  test("can retrieve the referrer for a user correctly", async () => {
    const affiliateOfA = await affiliatesService.getOrCreateAffiliateCode(userA.id);
    await affiliatesService.updateMarkup(userA.id, 150.5);

    try {
      await affiliatesService.linkUserToAffiliateCode(userB.id, affiliateOfA.code);
    } catch {
      // Ignore if the link already exists.
    }

    const referrer = await affiliatesService.getReferrer(userB.id);

    expect(referrer).toBeDefined();
    expect(referrer?.user_id).toBe(userA.id);
    expect(Number(referrer?.markup_percent)).toBe(150.5);
  });

  test("getReferrer returns null for unlinked user", async () => {
    const referrer = await affiliatesService.getReferrer(userA.id);
    expect(referrer).toBeNull();
  });
});
