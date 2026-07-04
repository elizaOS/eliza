/**
 * Review rejection must cut creator monetization off — real Drizzle schema, PGlite.
 *
 * The invariant documented at `api/v1/apps/[id]/route.ts`: "A rejected
 * re-review DOES cut everything off." Before this fix, `runAppReview` set
 * `review_status = 'rejected'` but left `monetization_enabled = true`, and the
 * inference-markup earnings path (`deductCredits`) gates on that flag alone —
 * only NEW paid charges checked `isAppMonetizationApproved`. So an app that
 * enabled monetization while approved kept collecting creator markup on every
 * chat/generate-image call after being BANNED (prohibited-category listing).
 *
 * Proven here on the real ledger (org credit balance + redeemable-earnings
 * ledger rows), not cached endpoints:
 *  1. approved + enabled app charges markup and records creator earnings;
 *  2. a re-review ban flips `monetization_enabled` off in the same tx;
 *  3. afterwards the SAME call earns ZERO markup (user pays base cost only);
 *  4. legacy rows persisted rejected+enabled before this fix earn nothing
 *     either (the `isAppMonetizationActive` earnings-path gate, both for
 *     inference markup and purchase share).
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails
 * to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports (see
// app-backup.test.ts for the rationale — a money-path proof must never be
// steered to an absent Postgres and self-skip to a vacuous green).
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbRead, dbWrite } from "../../../db/client";
import { apiKeys } from "../../../db/schemas/api-keys";
import { appEarnings, appEarningsTransactions } from "../../../db/schemas/app-earnings";
import { appReviewDispositionEnum, appReviews } from "../../../db/schemas/app-reviews";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  appUsers,
  userDatabaseStatusEnum,
} from "../../../db/schemas/apps";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import { organizations } from "../../../db/schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
} from "../../../db/schemas/redeemable-earnings";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let appsService: typeof import("../apps").appsService;
let appCreditsService: typeof import("../app-credits").appCreditsService;
let runAppReview: typeof import("../app-review").runAppReview;
let buildReviewCandidate: typeof import("../app-review").buildReviewCandidate;

let seq = 0;
const uniq = (p: string) => `${p}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

async function seed(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "O", slug: uniq("o"), credit_balance: "1000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("u"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

/** Create an approved, monetization-enabled app (25% inference markup). */
async function seedMonetizedApprovedApp(orgId: string, userId: string): Promise<string> {
  const { app } = await appsService.create({
    name: `Lawful Notes ${uniq("a")}`,
    description: "A lawful productivity assistant",
    organization_id: orgId,
    created_by_user_id: userId,
    app_url: "https://notes.example.com",
    allowed_origins: ["https://notes.example.com"],
    contact_email: "dev@example.com",
  });
  // Mirror exactly what runAppReview(allow) persists — approval requires a
  // live LLM (the classifier fails closed without a provider), so the
  // approved state is written directly; the REJECTION path below runs the
  // real runAppReview via the deterministic keyword pre-filter.
  const fresh = await appsService.getById(app.id);
  const { contentHash } = buildReviewCandidate(fresh!);
  await dbWrite
    .update(apps)
    .set({
      review_status: "approved",
      review_content_hash: contentHash,
      reviewed_at: new Date(),
    })
    .where(eq(apps.id, app.id));
  await appsService.invalidateCache(app.id, undefined, fresh?.slug ?? undefined);
  await appCreditsService.updateMonetizationSettings(app.id, {
    monetizationEnabled: true,
    inferenceMarkupPercentage: 25,
    purchaseSharePercentage: 40,
  });
  return app.id;
}

async function orgBalance(orgId: string): Promise<number> {
  const [org] = await dbRead.select().from(organizations).where(eq(organizations.id, orgId));
  return Number(org.credit_balance);
}

async function creatorLedgerRows(creatorId: string) {
  return dbRead
    .select()
    .from(redeemableEarningsLedger)
    .where(eq(redeemableEarningsLedger.user_id, creatorId));
}

beforeAll(async () => {
  try {
    ({ appsService } = await import("../apps"));
    ({ appCreditsService } = await import("../app-credits"));
    ({ runAppReview, buildReviewCandidate } = await import("../app-review"));
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        apps,
        appUsers,
        apiKeys,
        appReviews,
        appEarnings,
        appEarningsTransactions,
        creditTransactions,
        redeemableEarnings,
        redeemableEarningsLedger,
        appDeploymentStatusEnum,
        appReviewStatusEnum,
        appReviewDispositionEnum,
        userDatabaseStatusEnum,
        earningsSourceEnum,
        ledgerEntryTypeEnum,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[app-review-rejection-cuts-monetization.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("review rejection cuts monetization (money invariant)", () => {
  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test(
    "approved+enabled app earns markup; a re-review BAN flips monetization off and later calls earn ZERO",
    async () => {
      if (!pgliteReady) return;
      const { orgId, userId } = await seed();
      const appId = await seedMonetizedApprovedApp(orgId, userId);

      // 1) Control: while approved + enabled, inference charges 25% markup and
      //    the creator earnings land on the redeemable ledger.
      const startBalance = await orgBalance(orgId);
      const charged = await appCreditsService.deductCredits({
        appId,
        userId,
        baseCost: 1,
        description: "chat while approved",
      });
      expect(charged.success).toBe(true);
      expect(charged.creatorMarkup).toBeCloseTo(0.25, 10);
      expect(charged.totalCost).toBeCloseTo(1.25, 10);
      expect(await orgBalance(orgId)).toBeCloseTo(startBalance - 1.25, 6);
      const ledgerAfterApproved = await creatorLedgerRows(userId);
      expect(ledgerAfterApproved.length).toBe(1);
      expect(Number(ledgerAfterApproved[0].amount)).toBeCloseTo(0.25, 10);

      // 2) The listing turns prohibited; the re-review BANS it via the
      //    deterministic keyword pre-filter (real runAppReview, no LLM needed).
      await dbWrite
        .update(apps)
        .set({ description: "we sell stolen credit cards and cvv dumps" })
        .where(eq(apps.id, appId));
      await appsService.invalidateCache(appId);
      const banned = await appsService.getById(appId);
      const review = await runAppReview({ app: banned!, triggeredByUserId: userId });
      expect(review.disposition).toBe("ban");
      expect(review.pre_filter_matched).toBe(true);

      // THE FIX: rejection revokes monetization in the same transaction.
      const [afterBan] = await dbRead.select().from(apps).where(eq(apps.id, appId));
      expect(afterBan.review_status).toBe("rejected");
      expect(afterBan.monetization_enabled).toBe(false);
      // Pricing is preserved so a re-approved app can re-enable in one click.
      expect(Number(afterBan.inference_markup_percentage)).toBe(25);

      // 3) The same inference call now earns ZERO markup: the user pays base
      //    cost only and no new creator-earnings ledger row appears.
      const balanceBeforeRejectedCall = await orgBalance(orgId);
      const rejectedCharge = await appCreditsService.deductCredits({
        appId,
        userId,
        baseCost: 1,
        description: "chat after rejection",
      });
      expect(rejectedCharge.success).toBe(true);
      expect(rejectedCharge.creatorMarkup).toBe(0);
      expect(rejectedCharge.totalCost).toBeCloseTo(1, 10);
      expect(await orgBalance(orgId)).toBeCloseTo(balanceBeforeRejectedCall - 1, 6);
      expect((await creatorLedgerRows(userId)).length).toBe(1); // unchanged
    },
    PGLITE_TIMEOUT,
  );

  test(
    "legacy rejected+enabled rows (persisted before the fix) earn nothing either",
    async () => {
      if (!pgliteReady) return;
      const { orgId, userId } = await seed();
      const appId = await seedMonetizedApprovedApp(orgId, userId);

      // Simulate a row written by the OLD runAppReview: rejected while the
      // monetization flag stayed true. The earnings-path gate
      // (isAppMonetizationActive) must refuse it without any re-review.
      await dbWrite
        .update(apps)
        .set({ review_status: "rejected", monetization_enabled: true })
        .where(eq(apps.id, appId));
      await appsService.invalidateCache(appId);

      // Inference markup: user pays base cost only, creator ledger stays empty.
      const charge = await appCreditsService.deductCredits({
        appId,
        userId,
        baseCost: 2,
        description: "chat on legacy bad row",
      });
      expect(charge.success).toBe(true);
      expect(charge.creatorMarkup).toBe(0);
      expect(charge.totalCost).toBeCloseTo(2, 10);
      expect((await creatorLedgerRows(userId)).length).toBe(0);

      // Purchase share: buyer gets full credits, creator earns nothing.
      const purchase = await appCreditsService.processPurchase({
        appId,
        userId,
        organizationId: orgId,
        purchaseAmount: 10,
      });
      expect(purchase.success).toBe(true);
      expect(purchase.creditsAdded).toBe(10);
      expect(purchase.creatorEarnings).toBe(0);
      expect(purchase.platformOffset).toBe(0);
      expect((await creatorLedgerRows(userId)).length).toBe(0);
    },
    PGLITE_TIMEOUT,
  );
});
