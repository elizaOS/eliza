/**
 * Core Loop E2E: place bet -> resolve market -> verify PnL/portfolio
 *
 * Exercises the full prediction-market core loop end to end against a live
 * Next.js server, with all DB state seeded deterministically:
 *
 *   1. Buy YES shares       POST /api/markets/predictions/{id}/buy
 *   2. Read back position   GET  /api/markets/positions/{userId}
 *                           GET  /api/markets/predictions?userId={userId}
 *   3. Resolve market YES   POST /api/admin/markets/{id}  (admin cookie)
 *   4. Verify the win       GET  /api/markets/positions/{userId}?status=closed
 *                           GET  /api/users/{userId}/pnl-history?range=ALL
 *
 * Because the game engine generates markets autonomously and there is NO admin
 * "create market" endpoint, this spec seeds its own controllable Market +
 * Question row pair (sharing the same id, per the resolve route which updates
 * both `Market` and `Question` keyed by `marketId`), funds the dev user's
 * `users.virtualBalance` (the wallet ledger WalletService reads), and inserts a
 * losing NO position from a throwaway user so the YES winner's payout strictly
 * exceeds its cost basis (pool-proportional settlement: winners split losers'
 * deposits). All seeded rows are tracked and torn down in afterAll.
 *
 * Prerequisites:
 * - Server running at PLAYWRIGHT_BASE_URL (api-e2e project boots it via webServer).
 * - Dev auth enabled (ALLOW_TEST_STEWARD_AUTH=true) and NODE_ENV !== production.
 * - Reachable Postgres (the same DB the server uses).
 *
 * Run with: npx playwright test core-flow-bet-resolve-pnl.e2e.test.ts
 */

import {
  actorState,
  adminAuditLogs,
  and,
  balanceTransactions,
  db,
  eq,
  inArray,
  markets,
  notInArray,
  notifications,
  pointsTransactions,
  positions,
  predictionPriceHistories,
  questions,
  sql,
  tradingFees,
  userAchievements,
  userChallengeProgress,
  users,
} from "@feed/db";
import { expect, test } from "@playwright/test";
import {
  type BrowserDevAuthSession,
  installPlaywrightDevAuth,
} from "./dev-auth";

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  "http://127.0.0.1:3400";

const BET_AMOUNT = 50;
const STARTING_BALANCE = 100_000;
/** A losing NO stake (deposited directly as a Position) so YES wins strictly. */
const LOSER_NO_SHARES = 200;
const LOSER_NO_AVG_PRICE = 0.5;
const SNOWFLAKE_EPOCH = 1_704_067_200_000n;
const E2E_WORKER_ID = 911n;
let e2eSnowflakeSequence = 0n;

let serverAvailable = false;
let authSession: BrowserDevAuthSession | null = null;
let authHeaders: Record<string, string> = {};
let buyPlaced = false;
let marketResolved = false;

/** Snowflake ids of rows this spec created, deleted in reverse order in afterAll. */
const seeded = {
  marketId: "",
  questionId: "",
  loserUserId: "",
  loserPositionId: "",
};

type UserWalletSnapshot = {
  virtualBalance: string;
  totalDeposited: string;
  totalWithdrawn: string;
  lifetimePnL: string;
  invitePoints: number;
  earnedPoints: number;
  bonusPoints: number;
  reputationPoints: number;
  referralCode: string | null;
  referralCount: number;
  referredBy: string | null;
  totalFeesEarned: string;
  totalFeesPaid: string;
};

let originalUserWallet: UserWalletSnapshot | null = null;

type UserSideEffectSnapshot = {
  notificationIds: string[];
  pointsTransactionIds: string[];
  userAchievementIds: string[];
  userChallengeProgressIds: string[];
};

let originalUserSideEffects: UserSideEffectSnapshot | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateE2eSnowflakeId(): Promise<string> {
  e2eSnowflakeSequence = (e2eSnowflakeSequence + 1n) & 4095n;
  const timestamp = BigInt(Date.now()) - SNOWFLAKE_EPOCH;
  return (
    (timestamp << 22n) |
    (E2E_WORKER_ID << 12n) |
    e2eSnowflakeSequence
  ).toString();
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { ...authHeaders, accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `GET ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function captureUserSideEffects(
  userId: string,
): Promise<UserSideEffectSnapshot> {
  const [
    notificationRows,
    pointsTransactionRows,
    userAchievementRows,
    userChallengeProgressRows,
  ] = await Promise.all([
    db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, userId)),
    db
      .select({ id: pointsTransactions.id })
      .from(pointsTransactions)
      .where(eq(pointsTransactions.userId, userId)),
    db
      .select({ id: userAchievements.id })
      .from(userAchievements)
      .where(eq(userAchievements.userId, userId)),
    db
      .select({ id: userChallengeProgress.id })
      .from(userChallengeProgress)
      .where(eq(userChallengeProgress.userId, userId)),
  ]);

  return {
    notificationIds: notificationRows.map((row) => row.id),
    pointsTransactionIds: pointsTransactionRows.map((row) => row.id),
    userAchievementIds: userAchievementRows.map((row) => row.id),
    userChallengeProgressIds: userChallengeProgressRows.map((row) => row.id),
  };
}

async function waitForAsyncSideEffects(userId: string): Promise<void> {
  await sleep(250);

  const deadline = Date.now() + 1_500;

  while (Date.now() < deadline) {
    const observed: boolean[] = [];

    if (buyPlaced) {
      const priceHistoryRows = await db
        .select({ id: predictionPriceHistories.id })
        .from(predictionPriceHistories)
        .where(eq(predictionPriceHistories.marketId, seeded.marketId))
        .limit(1);
      const achievementRows = await db
        .select({ id: userAchievements.id })
        .from(userAchievements)
        .where(eq(userAchievements.userId, userId))
        .limit(1);
      observed.push(priceHistoryRows.length > 0, achievementRows.length > 0);
    }

    if (marketResolved) {
      const auditRows = await db
        .select({ id: adminAuditLogs.id })
        .from(adminAuditLogs)
        .where(eq(adminAuditLogs.resourceId, seeded.marketId))
        .limit(1);
      const resolutionNotificationRows = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, "market_resolved"),
            sql`${notifications.data}->>'marketId' = ${seeded.marketId}`,
          ),
        )
        .limit(1);
      observed.push(
        auditRows.length > 0,
        resolutionNotificationRows.length > 0,
      );
    }

    if (observed.length === 0 || observed.every(Boolean)) {
      return;
    }

    await sleep(100);
  }
}

// ---- Response shapes (verified against the live route source) ----

/** POST /api/markets/predictions/[id]/buy -> successResponse(..., 201) */
interface PredictionBuyResponse {
  position: {
    id: string;
    marketId: string;
    side: "yes" | "no";
    shares: number;
    avgPrice: number;
    totalCost: number;
  };
  market: { yesPrice: number; noPrice: number };
  fee: { amount: number; referrerPaid: number };
  newBalance: number;
}

/** GET /api/markets/positions/[userId] -> getUserPositionsSnapshot() */
interface UserPredictionPositionSnapshot {
  id: string;
  marketId: string;
  question: string;
  side: "YES" | "NO";
  shares: number;
  avgPrice: number;
  currentPrice: number;
  currentProbability: number;
  currentValue: number;
  costBasis: number;
  unrealizedPnL: number;
  resolved: boolean;
  resolution: boolean | null;
  closesAt: string | null;
  status: string;
  createdAt: string | null;
  outcome: boolean | string | null;
  pnl: number | null;
  resolvedAt: string | null;
}

interface UserPositionsSnapshot {
  predictions: {
    positions: UserPredictionPositionSnapshot[];
    stats: { totalPositions: number };
    total: number;
    hasMore: boolean;
  };
  timestamp: string;
}

/** GET /api/markets/predictions -> list of markets, optionally w/ user positions */
interface PredictionMarketListItem {
  id: string;
  question: string;
  status: string;
  resolved: boolean;
  resolution: boolean | null;
  yesShares: number;
  noShares: number;
  liquidity: number;
  userPosition: { side: "YES" | "NO"; shares: number } | null;
}

/** POST /api/admin/markets/[marketId] {action:"resolve"} -> successResponse(...) */
interface AdminResolveResponse {
  success?: boolean;
  action?: string;
  resolution?: boolean;
  marketId?: string;
  notificationsCreated?: number;
  error?: string;
}

/** GET /api/users/[userId]/pnl-history -> successResponse({ metric, points, scope }) */
interface PnlHistoryPoint {
  timestamp?: string;
  value?: number;
  [key: string]: unknown;
}
interface PnlHistoryResponse {
  metric?: string;
  scope?: string;
  points: PnlHistoryPoint[];
}

function requireSession(): BrowserDevAuthSession {
  if (!authSession) {
    throw new Error("Auth session was not established in beforeAll");
  }
  return authSession;
}

/**
 * Seed a fresh, controllable Market + Question pair plus a losing NO position.
 * Market.id === Question.id so the admin resolve route can update both with a
 * single marketId. The user's wallet balance is funded on `users.virtualBalance`
 * (the column WalletService.getBalance/debit/credit actually read & write).
 */
async function seedFixtures(userId: string): Promise<void> {
  const now = new Date();
  const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day out

  seeded.marketId = await generateE2eSnowflakeId();
  seeded.questionId = seeded.marketId; // shared id convention
  seeded.loserUserId = await generateE2eSnowflakeId();
  seeded.loserPositionId = await generateE2eSnowflakeId();

  const [userBeforeTest] = await db
    .select({
      virtualBalance: users.virtualBalance,
      totalDeposited: users.totalDeposited,
      totalWithdrawn: users.totalWithdrawn,
      lifetimePnL: users.lifetimePnL,
      invitePoints: users.invitePoints,
      earnedPoints: users.earnedPoints,
      bonusPoints: users.bonusPoints,
      reputationPoints: users.reputationPoints,
      referralCode: users.referralCode,
      referralCount: users.referralCount,
      referredBy: users.referredBy,
      totalFeesEarned: users.totalFeesEarned,
      totalFeesPaid: users.totalFeesPaid,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!userBeforeTest) {
    throw new Error(`Dev auth user not found before seeding: ${userId}`);
  }
  originalUserWallet = {
    virtualBalance: String(userBeforeTest.virtualBalance),
    totalDeposited: String(userBeforeTest.totalDeposited),
    totalWithdrawn: String(userBeforeTest.totalWithdrawn),
    lifetimePnL: String(userBeforeTest.lifetimePnL),
    invitePoints: userBeforeTest.invitePoints,
    earnedPoints: userBeforeTest.earnedPoints,
    bonusPoints: userBeforeTest.bonusPoints,
    reputationPoints: userBeforeTest.reputationPoints,
    referralCode: userBeforeTest.referralCode,
    referralCount: userBeforeTest.referralCount,
    referredBy: userBeforeTest.referredBy,
    totalFeesEarned: String(userBeforeTest.totalFeesEarned),
    totalFeesPaid: String(userBeforeTest.totalFeesPaid),
  };
  originalUserSideEffects = await captureUserSideEffects(userId);

  // Fund the trading user. WalletService reads users.virtualBalance.
  // Clear referredBy during the spec so FeeService cannot credit a real
  // referrer; teardown restores the user's referral fields from the snapshot.
  await db
    .update(users)
    .set({
      virtualBalance: String(STARTING_BALANCE),
      totalDeposited: String(STARTING_BALANCE),
      referredBy: null,
      updatedAt: now,
    })
    .where(eq(users.id, userId));

  // Provision a throwaway user to own the losing NO position.
  await db
    .insert(users)
    .values({
      id: seeded.loserUserId,
      username: `e2e-core-loser-${seeded.loserUserId}`,
      displayName: "E2E Core Loop Loser",
      virtualBalance: String(STARTING_BALANCE),
      updatedAt: now,
    })
    .onConflictDoNothing();

  // ActorState upsert: keeps NPC-style trading state consistent for the
  // throwaway actor (the table the prompt referenced for actor funds).
  await db
    .insert(actorState)
    .values({
      id: seeded.loserUserId,
      tradingBalance: String(STARTING_BALANCE),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: actorState.id,
      set: { tradingBalance: String(STARTING_BALANCE), updatedAt: now },
    });

  // Question row (same id as the market). questionNumber must be unique.
  const [maxResult] = await db
    .select({ max: sql<number>`COALESCE(MAX("questionNumber"), 0)` })
    .from(questions);
  const nextQuestionNumber = (maxResult?.max ?? 0) + 1;

  await db.insert(questions).values({
    id: seeded.questionId,
    questionNumber: nextQuestionNumber,
    text: "E2E core loop: will the bet resolve YES?",
    scenarioId: 1,
    outcome: true,
    rank: 1,
    createdDate: now,
    resolutionDate: endDate,
    status: "active",
    updatedAt: now,
  });

  // Market row: unresolved, future endDate, seeded liquidity, balanced shares.
  await db.insert(markets).values({
    id: seeded.marketId,
    question: "E2E core loop: will the bet resolve YES?",
    description: "Seeded by core-flow-bet-resolve-pnl.e2e.test.ts",
    yesShares: "1000",
    noShares: "1000",
    liquidity: "1000",
    resolved: false,
    endDate,
    updatedAt: now,
  });

  // Losing NO position (direct insert; listPositionsForMarket reads all rows
  // for the market regardless of status, so this counts as loser deposits at
  // resolution and guarantees the YES winner's payout > cost basis).
  await db.insert(positions).values({
    id: seeded.loserPositionId,
    userId: seeded.loserUserId,
    marketId: seeded.marketId,
    side: false, // NO
    shares: String(LOSER_NO_SHARES),
    avgPrice: String(LOSER_NO_AVG_PRICE),
    amount: String(LOSER_NO_SHARES * LOSER_NO_AVG_PRICE),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

async function deleteNewUserSideEffects(userId: string): Promise<void> {
  const snapshot = originalUserSideEffects;
  if (!snapshot) {
    return;
  }

  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.type, [
          "achievement_unlocked",
          "challenge_completed",
        ]),
        snapshot.notificationIds.length > 0
          ? notInArray(notifications.id, snapshot.notificationIds)
          : sql`true`,
      ),
    );

  await db
    .delete(pointsTransactions)
    .where(
      and(
        eq(pointsTransactions.userId, userId),
        inArray(pointsTransactions.reason, [
          "achievement_unlock",
          "challenge_complete",
        ]),
        snapshot.pointsTransactionIds.length > 0
          ? notInArray(pointsTransactions.id, snapshot.pointsTransactionIds)
          : sql`true`,
      ),
    );

  await db
    .delete(userChallengeProgress)
    .where(
      and(
        eq(userChallengeProgress.userId, userId),
        snapshot.userChallengeProgressIds.length > 0
          ? notInArray(
              userChallengeProgress.id,
              snapshot.userChallengeProgressIds,
            )
          : sql`true`,
      ),
    );

  await db
    .delete(userAchievements)
    .where(
      and(
        eq(userAchievements.userId, userId),
        snapshot.userAchievementIds.length > 0
          ? notInArray(userAchievements.id, snapshot.userAchievementIds)
          : sql`true`,
      ),
    );
}

async function teardownFixtures(userId: string): Promise<void> {
  await waitForAsyncSideEffects(userId);

  await deleteNewUserSideEffects(userId);

  if (seeded.marketId) {
    await db
      .delete(predictionPriceHistories)
      .where(eq(predictionPriceHistories.marketId, seeded.marketId));
    await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.type, "market_resolved"),
          sql`${notifications.data}->>'marketId' = ${seeded.marketId}`,
        ),
      );
    await db
      .delete(adminAuditLogs)
      .where(eq(adminAuditLogs.resourceId, seeded.marketId));
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.relatedId, seeded.marketId));
    await db
      .delete(tradingFees)
      .where(eq(tradingFees.marketId, seeded.marketId));
    await db
      .delete(pointsTransactions)
      .where(
        sql`${pointsTransactions.metadata} LIKE ${`%"relatedId":"${seeded.marketId}"%`}`,
      );
  }

  // Positions first (FK-free but logically owned by market + users).
  if (seeded.marketId) {
    await db.delete(positions).where(eq(positions.marketId, seeded.marketId));
    await db.delete(markets).where(eq(markets.id, seeded.marketId));
  }
  if (seeded.questionId) {
    await db.delete(questions).where(eq(questions.id, seeded.questionId));
  }
  if (seeded.loserUserId) {
    await db
      .delete(notifications)
      .where(eq(notifications.userId, seeded.loserUserId));
    await db.delete(positions).where(eq(positions.userId, seeded.loserUserId));
    await db.delete(actorState).where(eq(actorState.id, seeded.loserUserId));
    await db.delete(users).where(inArray(users.id, [seeded.loserUserId]));
  }

  // Achievement/challenge checks and admin audit writes are deliberately
  // fire-and-forget in the API route. Give any late user-scoped writes one more
  // short drain after market-specific cleanup, then restore the shared dev user
  // last so leaked points/referral fields cannot survive teardown.
  await sleep(250);
  await deleteNewUserSideEffects(userId);

  if (originalUserWallet) {
    await db
      .update(users)
      .set({
        virtualBalance: originalUserWallet.virtualBalance,
        totalDeposited: originalUserWallet.totalDeposited,
        totalWithdrawn: originalUserWallet.totalWithdrawn,
        lifetimePnL: originalUserWallet.lifetimePnL,
        invitePoints: originalUserWallet.invitePoints,
        earnedPoints: originalUserWallet.earnedPoints,
        bonusPoints: originalUserWallet.bonusPoints,
        reputationPoints: originalUserWallet.reputationPoints,
        referralCode: originalUserWallet.referralCode,
        referralCount: originalUserWallet.referralCount,
        referredBy: originalUserWallet.referredBy,
        totalFeesEarned: originalUserWallet.totalFeesEarned,
        totalFeesPaid: originalUserWallet.totalFeesPaid,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }
}

test.describe("Core loop: bet -> resolve -> PnL", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      serverAvailable = response.ok;
    } catch {
      serverAvailable = false;
    }

    if (!serverAvailable) {
      return;
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    authSession = await installPlaywrightDevAuth(page, BASE_URL);

    const cookies = await context.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    authHeaders = { cookie: cookieHeader };

    await page.close();
    await context.close();

    await seedFixtures(authSession.userId);
  });

  test.afterAll(async () => {
    if (!serverAvailable || !authSession) {
      return;
    }
    await teardownFixtures(authSession.userId);
  });

  test("(1) places a YES bet and debits the wallet", async () => {
    test.skip(!serverAvailable, "Server not available");

    const result = await apiPost<PredictionBuyResponse>(
      `/api/markets/predictions/${seeded.marketId}/buy`,
      { side: "yes", amount: BET_AMOUNT },
    );
    buyPlaced = true;

    expect(result.position).toBeDefined();
    expect(result.position.marketId).toBe(seeded.marketId);
    expect(result.position.side).toMatch(/yes/i);
    expect(result.position.shares).toBeGreaterThan(0);
    expect(result.position.avgPrice).toBeGreaterThan(0);
    expect(result.position.totalCost).toBeGreaterThan(0);
    expect(result.fee.amount).toBeGreaterThanOrEqual(0);

    // Wallet was debited: new balance is strictly below the seeded starting
    // balance and the drop is at least the bet amount.
    expect(typeof result.newBalance).toBe("number");
    expect(result.newBalance).toBeLessThan(STARTING_BALANCE);
    expect(STARTING_BALANCE - result.newBalance).toBeGreaterThanOrEqual(
      BET_AMOUNT - 0.000001,
    );
  });

  test("(2) reflects the open YES position in portfolio + market list", async () => {
    test.skip(!serverAvailable, "Server not available");
    const session = requireSession();

    // Positions snapshot (open).
    const snapshot = await apiGet<UserPositionsSnapshot>(
      `/api/markets/positions/${session.userId}?type=prediction&status=open`,
    );
    expect(snapshot.predictions).toBeDefined();
    const open = snapshot.predictions.positions.find(
      (p) => p.marketId === seeded.marketId,
    );
    expect(
      open,
      "seeded YES position should be in open portfolio",
    ).toBeTruthy();
    if (!open) throw new Error("unreachable");
    expect(open.side).toBe("YES");
    expect(open.shares).toBeGreaterThan(0);
    expect(open.resolved).toBe(false);
    expect(typeof open.costBasis).toBe("number");
    expect(typeof open.unrealizedPnL).toBe("number");

    // Market list with userId surfaces the same position inline.
    const list = await apiGet<{
      questions: PredictionMarketListItem[];
      count: number;
    }>(`/api/markets/predictions?userId=${session.userId}`);
    const market = list.questions.find((q) => q.id === seeded.marketId);
    expect(market, "seeded market should appear in list").toBeTruthy();
    if (!market) throw new Error("unreachable");
    expect(market.resolved).toBe(false);
    expect(market.userPosition).not.toBeNull();
    expect(market.userPosition?.side).toBe("YES");
    expect(market.userPosition?.shares).toBeGreaterThan(0);
  });

  test("(3) resolves the market YES via the admin endpoint", async () => {
    test.skip(!serverAvailable, "Server not available");

    // The admin cookie (feed-dev-admin-token) is part of authHeaders.
    const result = await apiPost<AdminResolveResponse>(
      `/api/admin/markets/${seeded.marketId}`,
      { action: "resolve", resolution: true },
    );
    marketResolved = true;

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.action).toBe("resolve");
    expect(result.resolution).toBe(true);
    expect(result.marketId).toBe(seeded.marketId);

    // Verify settlement landed at the data layer: market is resolved YES.
    const [market] = await db
      .select({ resolved: markets.resolved, resolution: markets.resolution })
      .from(markets)
      .where(eq(markets.id, seeded.marketId))
      .limit(1);
    expect(market?.resolved).toBe(true);
    expect(market?.resolution).toBe(true);
  });

  test("(4) reflects the resolved YES win in portfolio + PnL history", async () => {
    test.skip(!serverAvailable, "Server not available");
    const session = requireSession();

    // Closed/resolved portfolio shows the winning YES position.
    const snapshot = await apiGet<UserPositionsSnapshot>(
      `/api/markets/positions/${session.userId}?type=prediction&status=closed`,
    );
    const resolved = snapshot.predictions.positions.find(
      (p) => p.marketId === seeded.marketId,
    );
    expect(
      resolved,
      "resolved YES position should appear in closed portfolio",
    ).toBeTruthy();
    if (!resolved) throw new Error("unreachable");

    expect(resolved.resolved).toBe(true);
    expect(resolved.resolution).toBe(true);
    // Settlement marks the winning side's outcome true and records realized pnl.
    expect(resolved.outcome).toBe(true);
    expect(typeof resolved.pnl).toBe("number");
    // Losers deposited into the pool, so the YES winner's realized pnl is > 0.
    expect(resolved.pnl ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(0);
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.status).toMatch(/resolved|closed/i);

    // PnL history endpoint returns a structurally valid series for the user.
    const pnl = await apiGet<PnlHistoryResponse>(
      `/api/users/${session.userId}/pnl-history?range=ALL`,
    );
    expect(Array.isArray(pnl.points)).toBe(true);
    for (const point of pnl.points) {
      if (point.value !== undefined) {
        expect(typeof point.value).toBe("number");
      }
    }
  });
});
