import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { dbWrite } from "@/db/client";
import { referralSignupsRepository } from "@/db/repositories/referrals";
import { organizations } from "@/db/schemas/organizations";
import { users } from "@/db/schemas/users";

let userA: any;
let userB: any;
let userC: any; // Editor
let userD: any; // Creator
let unreferredUser: any;
let buyer: any;
let appOwner: any;
let referralsService: typeof import("@/lib/services/referrals").referralsService;

const allUserIds: string[] = [];
const allOrganizationIds: string[] = [];

async function createUser(name: string, email: string) {
  const id = crypto.randomUUID();
  const organization_id = crypto.randomUUID();
  const now = new Date();

  await dbWrite.insert(organizations).values({
    id: organization_id,
    name: `${name} Org`,
    slug: `revenue-splits-${organization_id.slice(0, 12)}`,
    created_at: now,
    updated_at: now,
  });

  await dbWrite.insert(users).values({
    id,
    steward_user_id: `test-revenue-splits-${id}`,
    email,
    name,
    organization_id,
    created_at: now,
    updated_at: now,
  });

  allUserIds.push(id);
  allOrganizationIds.push(organization_id);
  return { id, organization_id, email };
}

async function cleanupUser(id: string) {
  await dbWrite
    .delete(users)
    .where(eq(users.id, id))
    .catch(() => {});
}

async function cleanupOrganization(id: string) {
  await dbWrite
    .delete(organizations)
    .where(eq(organizations.id, id))
    .catch(() => {});
}

describe("Revenue Splits & Multi-Tier Referrals", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    mock.restore();
    ({ referralsService } = await import("../../lib/services/referrals"));

    userA = await createUser("User A", `usera-${Date.now()}@test.com`);
    userB = await createUser("User B", `userb-${Date.now()}@test.com`);
    userC = await createUser("Editor C", `userc-${Date.now()}@test.com`);
    userD = await createUser("Creator D", `userd-${Date.now()}@test.com`);
    unreferredUser = await createUser("Unreferred", `unref-${Date.now()}@test.com`);
    buyer = await createUser("Buyer", `buyer-${Date.now()}@test.com`);
    appOwner = await createUser("App Owner", `owner-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    for (const id of allUserIds) {
      await cleanupUser(id);
    }
    for (const id of allOrganizationIds) {
      await cleanupOrganization(id);
    }
  });

  it("Test 1: First-Touch Immutability", async () => {
    const codeX = await referralsService.getOrCreateCode(userB.id);
    const codeY = await referralsService.getOrCreateCode(userC.id);

    // Apply Code X to User A
    const res1 = await referralsService.applyReferralCode(
      userA.id,
      userA.organization_id,
      codeX.code,
    );
    expect(res1.success).toBe(true);

    // Verify it was correctly recorded
    const signup = await referralSignupsRepository.findByReferredUserId(userA.id);
    expect(signup?.referrer_user_id).toBe(userB.id);

    // Attempt to apply Code Y to User A (Should Fail)
    const res2 = await referralsService.applyReferralCode(
      userA.id,
      userA.organization_id,
      codeY.code,
    );
    expect(res2.success).toBe(false);
    expect(res2.message).toBe("Already used a referral code");

    // Verify standard 50/40/10 split calculates properly
    const { splits } = await referralsService.calculateRevenueSplits(userA.id, 100);
    expect(splits).toContainEqual({
      userId: userB.id,
      role: "creator",
      amount: 10,
    });
  });

  it("Test 2: No Referrer (100% Platform)", async () => {
    const { elizaCloudAmount, splits } = await referralsService.calculateRevenueSplits(
      unreferredUser.id,
      100,
    );

    expect(elizaCloudAmount).toBe(100);
    expect(splits.length).toBe(0);
  });

  it("Test 3: Multi-Tier Referrals (Nano Banana flow)", async () => {
    // Editor code
    const editorCode = await referralsService.getOrCreateCode(userC.id);

    // Creator code, linked to editor code via parent_referral_id
    const creatorCode = await referralsService.getOrCreateCode(userD.id);

    // Update creator code to have the parent
    const { referralCodes } = await import("@/db/schemas/referrals");
    await dbWrite
      .update(referralCodes)
      .set({ parent_referral_id: editorCode.id })
      .where(eq(referralCodes.id, creatorCode.id));

    // Buyer signs up using Creator's nano banana code, context passes App Owner
    const res = await referralsService.applyReferralCode(
      buyer.id,
      buyer.organization_id,
      creatorCode.code,
      {
        appOwnerId: appOwner.id,
      },
    );
    expect(res.success).toBe(true);

    // Calculate splits on $100
    const { elizaCloudAmount, splits } = await referralsService.calculateRevenueSplits(
      buyer.id,
      100,
    );

    // Exact requested math:
    // ElizaCloud: 50
    // App Owner: 40
    // Editor: 2
    // Creator: 8

    expect(elizaCloudAmount).toBe(50);

    // Find app owner split
    const appOwnerSplit = splits.find((s) => s.role === "app_owner");
    expect(appOwnerSplit!.userId).toBe(appOwner.id);
    expect(appOwnerSplit!.amount).toBe(40);

    // Find editor split
    const editorSplit = splits.find((s) => s.role === "editor");
    expect(editorSplit!.userId).toBe(userC.id);
    expect(editorSplit!.amount).toBe(2);

    // Find creator split
    const creatorSplit = splits.find((s) => s.role === "creator");
    expect(creatorSplit!.userId).toBe(userD.id);
    expect(creatorSplit!.amount).toBe(8);
  });

  it("Test 4: Concurrent referral code creation is idempotent", async () => {
    const concurrentUser = await createUser(
      "Concurrent Referral",
      `concurrent-referral-${Date.now()}@test.com`,
    );

    const rows = await Promise.all(
      Array.from({ length: 6 }, () => referralsService.getOrCreateCode(concurrentUser.id)),
    );

    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    expect(new Set(rows.map((row) => row.code)).size).toBe(1);
    expect(rows.every((row) => row.user_id === concurrentUser.id)).toBe(true);
  });
});
