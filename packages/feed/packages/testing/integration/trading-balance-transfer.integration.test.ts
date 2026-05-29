import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  TradingBalanceTransferService,
  TradingPerformanceService,
} from "@feed/api";
import { balanceTransactions, db, eq, inArray, sql, users } from "@feed/db";
import {
  calculatePortfolioBreakdown,
  calculatePortfolioPnL,
} from "@feed/engine";
import {
  generateSnowflakeId,
  PEER_TRANSFER_IN_TRANSACTION_TYPE,
  PEER_TRANSFER_OUT_TRANSACTION_TYPE,
} from "@feed/shared";

setDefaultTimeout(30000);

let dbAvailable = false;
const testUserIds: string[] = [];

async function checkDatabaseHealth(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;

  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

async function createTestUser(params: {
  usernamePrefix: string;
  initialBalance: number;
  totalDeposited: number;
  isActor?: boolean;
  isAgent?: boolean;
}): Promise<{ id: string; username: string }> {
  const id = await generateSnowflakeId();
  const username = `${params.usernamePrefix}-${id}`;

  await db.insert(users).values({
    id,
    privyId: `steward:test:test-${id}`,
    username,
    displayName: username,
    virtualBalance: params.initialBalance.toFixed(2),
    totalDeposited: params.totalDeposited.toFixed(2),
    totalWithdrawn: "0",
    reputationPoints: 1000,
    isActor: params.isActor ?? false,
    isAgent: params.isAgent ?? false,
    profileComplete: true,
    updatedAt: new Date(),
  });

  if (params.totalDeposited > 0) {
    await db.insert(balanceTransactions).values({
      id: await generateSnowflakeId(),
      userId: id,
      type: "deposit",
      amount: params.totalDeposited.toFixed(2),
      balanceBefore: "0",
      balanceAfter: params.initialBalance.toFixed(2),
      description: "integration seed deposit",
    });
  }

  testUserIds.push(id);
  return { id, username };
}

describe("TradingBalanceTransferService - Integration", () => {
  beforeAll(async () => {
    dbAvailable = await checkDatabaseHealth();

    if (!dbAvailable) {
      console.warn(
        "⚠️  Database not available - trading balance transfer integration tests will be skipped",
      );
    }
  });

  afterAll(async () => {
    if (!dbAvailable || testUserIds.length === 0) {
      return;
    }

    await db
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, testUserIds));
    await db.delete(users).where(inArray(users.id, testUserIds));
  });

  test("moves trading balance atomically without polluting funding totals or PnL", async () => {
    if (!dbAvailable) {
      return;
    }

    const sender = await createTestUser({
      usernamePrefix: "tb-transfer-sender",
      initialBalance: 500,
      totalDeposited: 500,
    });
    const receiver = await createTestUser({
      usernamePrefix: "tb-transfer-receiver",
      initialBalance: 0,
      totalDeposited: 0,
    });

    const result = await TradingBalanceTransferService.transfer({
      senderUserId: sender.id,
      recipientIdentifier: receiver.username,
      amount: 200,
      note: "integration test",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    const [senderUser] = await db
      .select({
        virtualBalance: users.virtualBalance,
        totalDeposited: users.totalDeposited,
        totalWithdrawn: users.totalWithdrawn,
      })
      .from(users)
      .where(eq(users.id, sender.id))
      .limit(1);
    const [receiverUser] = await db
      .select({
        virtualBalance: users.virtualBalance,
        totalDeposited: users.totalDeposited,
        totalWithdrawn: users.totalWithdrawn,
      })
      .from(users)
      .where(eq(users.id, receiver.id))
      .limit(1);

    expect(Number(senderUser?.virtualBalance ?? 0)).toBe(300);
    expect(Number(senderUser?.totalDeposited ?? 0)).toBe(500);
    expect(Number(senderUser?.totalWithdrawn ?? 0)).toBe(0);
    expect(Number(receiverUser?.virtualBalance ?? 0)).toBe(200);
    expect(Number(receiverUser?.totalDeposited ?? 0)).toBe(0);
    expect(Number(receiverUser?.totalWithdrawn ?? 0)).toBe(0);

    const transferRows = await db
      .select({
        userId: balanceTransactions.userId,
        type: balanceTransactions.type,
        amount: balanceTransactions.amount,
        relatedId: balanceTransactions.relatedId,
      })
      .from(balanceTransactions)
      .where(inArray(balanceTransactions.userId, [sender.id, receiver.id]));

    const peerTransferRows = transferRows.filter((row) =>
      [
        PEER_TRANSFER_OUT_TRANSACTION_TYPE,
        PEER_TRANSFER_IN_TRANSACTION_TYPE,
      ].includes(row.type),
    );

    expect(peerTransferRows).toHaveLength(2);
    expect(
      peerTransferRows.some(
        (row) =>
          row.userId === sender.id &&
          row.type === PEER_TRANSFER_OUT_TRANSACTION_TYPE &&
          Number(row.amount) === -200 &&
          row.relatedId === result.transferId,
      ),
    ).toBe(true);
    expect(
      peerTransferRows.some(
        (row) =>
          row.userId === receiver.id &&
          row.type === PEER_TRANSFER_IN_TRANSACTION_TYPE &&
          Number(row.amount) === 200 &&
          row.relatedId === result.transferId,
      ),
    ).toBe(true);

    const senderBreakdown = await calculatePortfolioBreakdown(sender.id);
    const receiverBreakdown = await calculatePortfolioBreakdown(receiver.id);
    const senderPnL = await calculatePortfolioPnL(sender.id);
    const receiverPnL = await calculatePortfolioPnL(receiver.id);
    const senderTrading = await TradingPerformanceService.getWalletEntry(
      sender.id,
    );
    const receiverTrading = await TradingPerformanceService.getWalletEntry(
      receiver.id,
    );

    expect(senderBreakdown?.netPeerTransfers).toBe(-200);
    expect(senderBreakdown?.originalAmount).toBe(300);
    expect(senderBreakdown?.totalPnL).toBe(0);
    expect(receiverBreakdown?.netPeerTransfers).toBe(200);
    expect(receiverBreakdown?.originalAmount).toBe(200);
    expect(receiverBreakdown?.totalPnL).toBe(0);

    expect(senderPnL?.netPeerTransfers).toBe(-200);
    expect(senderPnL?.netContributions).toBe(300);
    expect(senderPnL?.accountEquity).toBe(300);
    expect(receiverPnL?.netPeerTransfers).toBe(200);
    expect(receiverPnL?.netContributions).toBe(200);
    expect(receiverPnL?.accountEquity).toBe(200);

    expect(Number(senderTrading?.capitalBase ?? 0)).toBe(500);
    expect(Number(receiverTrading?.capitalBase ?? 0)).toBe(200);
  });

  test("rejects actor recipients", async () => {
    if (!dbAvailable) {
      return;
    }

    const sender = await createTestUser({
      usernamePrefix: "tb-transfer-human",
      initialBalance: 100,
      totalDeposited: 100,
    });
    const actor = await createTestUser({
      usernamePrefix: "tb-transfer-actor",
      initialBalance: 0,
      totalDeposited: 0,
      isActor: true,
    });

    const result = await TradingBalanceTransferService.transfer({
      senderUserId: sender.id,
      recipientIdentifier: actor.username,
      amount: 10,
    });

    expect(result).toEqual({
      success: false,
      errorCode: "RECIPIENT_NOT_ALLOWED",
      error: "Recipient must be a Feed user, not an actor or agent",
    });
  });
});
