/**
 * Redeemable Earnings Service Tests
 *
 * Sociable unit tests for the Redeemable Earnings Service.
 * Tests use real PostgreSQL database (no mocks).
 *
 * Key test scenarios:
 * - getBalance: returns null for new user, returns breakdown
 * - addEarnings: creates record, increments balance, source tracking
 * - lockForRedemption: moves to pending, idempotency, insufficient balance
 * - completeRedemption: moves from pending to redeemed
 * - refundRedemption: returns from pending to available
 * - Double-redemption prevention (P0 critical)
 *
 * @see https://martinfowler.com/bliki/UnitTest.html (Sociable vs Solitary)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { dbWrite } from "@/db/client";
import { redeemableEarnings, redeemableEarningsLedger } from "@/db/schemas/redeemable-earnings";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { getConnectionString } from "@/tests/infrastructure/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/infrastructure/test-data-factory";

describe("RedeemableEarningsService", () => {
  let connectionString: string;
  let testData: TestDataSet;

  beforeAll(async () => {
    connectionString = getConnectionString();
  });

  beforeEach(async () => {
    // Create fresh test data for each test
    testData = await createTestDataSet(connectionString, {
      creditBalance: 100,
    });
  });

  afterAll(async () => {
    // Cleanup is handled per-test, but ensure final cleanup
    if (testData?.organization?.id) {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  });

  // Helper to cleanup earnings for a specific user
  async function cleanupEarnings(userId: string): Promise<void> {
    await dbWrite
      .delete(redeemableEarningsLedger)
      .where(eq(redeemableEarningsLedger.user_id, userId));
    await dbWrite.delete(redeemableEarnings).where(eq(redeemableEarnings.user_id, userId));
  }

  // ===========================================================================
  // getBalance Tests
  // ===========================================================================

  describe("getBalance", () => {
    test("returns null for user without earnings", async () => {
      // Arrange
      const userId = testData.user.id;

      // Act
      const balance = await redeemableEarningsService.getBalance(userId);

      // Assert
      expect(balance).toBeNull();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns balance breakdown by source", async () => {
      // Arrange
      const userId = testData.user.id;

      // Add earnings from different sources
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 10,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "App earnings",
      });
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 15,
        source: "agent",
        sourceId: uuidv4(),
        description: "Agent earnings",
      });
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 5,
        source: "mcp",
        sourceId: uuidv4(),
        description: "MCP earnings",
      });

      // Act
      const balance = await redeemableEarningsService.getBalance(userId);

      // Assert
      expect(balance).not.toBeNull();
      expect(balance!.availableBalance).toBe(30);
      expect(balance!.totalEarned).toBe(30);
      expect(balance!.totalRedeemed).toBe(0);
      expect(balance!.totalPending).toBe(0);
      expect(balance!.breakdown.miniapps).toBe(10);
      expect(balance!.breakdown.agents).toBe(15);
      expect(balance!.breakdown.mcps).toBe(5);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // addEarnings Tests
  // ===========================================================================

  describe("addEarnings", () => {
    test("creates record for new user", async () => {
      // Arrange
      const userId = testData.user.id;
      const sourceId = uuidv4();

      // Act
      const result = await redeemableEarningsService.addEarnings({
        userId,
        amount: 25,
        source: "miniapp",
        sourceId,
        description: "First earning",
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(25);
      expect(result.ledgerEntryId).toBeDefined();

      // Verify in database
      const balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(25);
      expect(balance!.breakdown.miniapps).toBe(25);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("increments balance for existing user", async () => {
      // Arrange
      const userId = testData.user.id;

      // Add first earning
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 20,
        source: "agent",
        sourceId: uuidv4(),
        description: "First earning",
      });

      // Act - Add second earning
      const result = await redeemableEarningsService.addEarnings({
        userId,
        amount: 15,
        source: "agent",
        sourceId: uuidv4(),
        description: "Second earning",
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(35); // 20 + 15

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("updates correct source counter", async () => {
      // Arrange
      const userId = testData.user.id;

      // Add miniapp earnings
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 10,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Miniapp earning",
      });

      // Act - Add MCP earnings
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 20,
        source: "mcp",
        sourceId: uuidv4(),
        description: "MCP earning",
      });

      // Assert
      const balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.breakdown.miniapps).toBe(10);
      expect(balance!.breakdown.mcps).toBe(20);
      expect(balance!.breakdown.agents).toBe(0);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("rejects non-positive amount", async () => {
      // Arrange
      const userId = testData.user.id;

      // Act
      const result = await redeemableEarningsService.addEarnings({
        userId,
        amount: 0,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Should fail",
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Amount must be positive");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates ledger entry with metadata", async () => {
      // Arrange
      const userId = testData.user.id;
      const sourceId = uuidv4();
      const metadata = { transactionId: "tx-123" };

      // Act
      const result = await redeemableEarningsService.addEarnings({
        userId,
        amount: 50,
        source: "agent",
        sourceId,
        description: "Test earning with metadata",
        metadata,
      });

      // Assert
      expect(result.success).toBe(true);

      // Verify ledger entry
      const history = await redeemableEarningsService.getLedgerHistory(userId, 1);
      expect(history.length).toBe(1);
      expect(history[0].type).toBe("earning");
      expect(history[0].amount).toBe(50);
      expect(history[0].source).toBe("agent");

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // lockForRedemption Tests
  // ===========================================================================

  describe("lockForRedemption", () => {
    test("moves balance from available to pending", async () => {
      // Arrange
      const userId = testData.user.id;
      const redemptionId = uuidv4();

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 100,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Initial earnings",
      });

      // Act
      const result = await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 50,
        redemptionId,
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.lockedAmount).toBe(50);

      // Verify balances
      const balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(50); // 100 - 50
      expect(balance!.totalPending).toBe(50);
      expect(balance!.totalRedeemed).toBe(0);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("fails when balance is insufficient", async () => {
      // Arrange
      const userId = testData.user.id;

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 30,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Small earnings",
      });

      // Act - Try to lock more than available (service throws an error)
      await expect(
        redeemableEarningsService.lockForRedemption({
          userId,
          amount: 50,
          redemptionId: uuidv4(),
        }),
      ).rejects.toThrow("Insufficient redeemable balance");

      // Balance should be unchanged
      const balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(30);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("is idempotent with same redemptionId", async () => {
      // Arrange
      const userId = testData.user.id;
      const redemptionId = uuidv4();

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 100,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Initial earnings",
      });

      // Act - First lock
      const result1 = await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 50,
        redemptionId,
      });

      // Act - Second lock with same redemptionId
      const result2 = await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 50,
        redemptionId,
      });

      // Assert - Both succeed, but only one lock occurred
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result2.ledgerEntryId).toBe(result1.ledgerEntryId);

      // Balance should reflect only one lock
      const balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(50); // Not 0
      expect(balance!.totalPending).toBe(50); // Not 100

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("rejects non-positive amount", async () => {
      // Arrange
      const userId = testData.user.id;

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 50,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Initial earnings",
      });

      // Act
      const result = await redeemableEarningsService.lockForRedemption({
        userId,
        amount: -10,
        redemptionId: uuidv4(),
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Amount must be positive");

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    // ===========================================================================
    // CRITICAL: Double-Redemption Prevention Test (P0)
    // ===========================================================================

    test("prevents double redemption with concurrent requests", async () => {
      // Arrange: User with $10 in earnings
      const userId = testData.user.id;

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 10,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Initial earnings",
      });

      // Act: Fire 20 concurrent $1 lock requests (should only allow 10)
      const promises = Array.from({ length: 20 }, (_, i) =>
        redeemableEarningsService.lockForRedemption({
          userId,
          amount: 1,
          redemptionId: uuidv4(), // Each is a unique redemption
        }),
      );

      const results = await Promise.allSettled(promises);

      // Assert
      // Successes: fulfilled promises with success: true
      const successes = results.filter((r) => r.status === "fulfilled" && r.value.success);

      // Failures: Either rejected promises (thrown errors) OR fulfilled with success: false
      const failures = results.filter(
        (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.success),
      );

      // Should have exactly 10 successful locks (10 x $1 = $10)
      expect(successes.length).toBe(10);
      expect(failures.length).toBe(10);

      // CRITICAL: Available balance must be exactly $0
      const balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(0);
      expect(balance!.availableBalance).toBeGreaterThanOrEqual(0);
      expect(balance!.totalPending).toBe(10);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    }, 30000);
  });

  // ===========================================================================
  // completeRedemption Tests
  // ===========================================================================

  describe("completeRedemption", () => {
    test("moves from pending to redeemed", async () => {
      // Arrange
      const userId = testData.user.id;
      const redemptionId = uuidv4();

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 100,
        source: "agent",
        sourceId: uuidv4(),
        description: "Initial earnings",
      });

      await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 40,
        redemptionId,
      });

      // Act
      const result = await redeemableEarningsService.completeRedemption({
        userId,
        redemptionId,
        amount: 40,
      });

      // Assert
      expect(result.success).toBe(true);

      // Verify balances
      const balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(60); // 100 - 40
      expect(balance!.totalPending).toBe(0); // Moved out of pending
      expect(balance!.totalRedeemed).toBe(40); // Added to redeemed

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates completion ledger entry", async () => {
      // Arrange
      const userId = testData.user.id;
      const redemptionId = uuidv4();

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 50,
        source: "mcp",
        sourceId: uuidv4(),
        description: "MCP earnings",
      });

      await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 30,
        redemptionId,
      });

      // Act
      await redeemableEarningsService.completeRedemption({
        userId,
        redemptionId,
        amount: 30,
      });

      // Assert - Check ledger has completion entry
      const history = await redeemableEarningsService.getLedgerHistory(userId);
      const completionEntry = history.find(
        (e) => e.redemptionId === redemptionId && e.description.includes("completed"),
      );
      expect(completionEntry).toBeDefined();

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // refundRedemption Tests
  // ===========================================================================

  describe("refundRedemption", () => {
    test("returns earnings from pending to available", async () => {
      // Arrange
      const userId = testData.user.id;
      const redemptionId = uuidv4();

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 80,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Initial earnings",
      });

      await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 50,
        redemptionId,
      });

      // Verify state before refund
      let balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(30);
      expect(balance!.totalPending).toBe(50);

      // Act
      const result = await redeemableEarningsService.refundRedemption({
        userId,
        redemptionId,
        amount: 50,
        reason: "Blockchain transaction failed",
      });

      // Assert
      expect(result.success).toBe(true);

      // Verify balances restored
      balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(80); // Fully restored
      expect(balance!.totalPending).toBe(0);
      expect(balance!.totalRedeemed).toBe(0);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates refund ledger entry with reason", async () => {
      // Arrange
      const userId = testData.user.id;
      const redemptionId = uuidv4();
      const refundReason = "User requested cancellation";

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 100,
        source: "agent",
        sourceId: uuidv4(),
        description: "Earnings",
      });

      await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 60,
        redemptionId,
      });

      // Act
      await redeemableEarningsService.refundRedemption({
        userId,
        redemptionId,
        amount: 60,
        reason: refundReason,
      });

      // Assert
      const history = await redeemableEarningsService.getLedgerHistory(userId);
      const refundEntry = history.find((e) => e.type === "refund");
      expect(refundEntry).toBeDefined();
      expect(refundEntry!.amount).toBe(60);
      expect(refundEntry!.description).toContain(refundReason);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getLedgerHistory Tests
  // ===========================================================================

  describe("getLedgerHistory", () => {
    test("returns entries ordered by date descending", async () => {
      // Arrange
      const userId = testData.user.id;

      // Create multiple entries
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 10,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "First earning",
      });

      await new Promise((r) => setTimeout(r, 10)); // Small delay for ordering

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 20,
        source: "agent",
        sourceId: uuidv4(),
        description: "Second earning",
      });

      await new Promise((r) => setTimeout(r, 10));

      await redeemableEarningsService.addEarnings({
        userId,
        amount: 5,
        source: "mcp",
        sourceId: uuidv4(),
        description: "Third earning",
      });

      // Act
      const history = await redeemableEarningsService.getLedgerHistory(userId);

      // Assert - Most recent first
      expect(history.length).toBe(3);
      expect(history[0].description).toBe("Third earning");
      expect(history[1].description).toBe("Second earning");
      expect(history[2].description).toBe("First earning");

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("respects limit parameter", async () => {
      // Arrange
      const userId = testData.user.id;

      // Create 5 entries
      for (let i = 0; i < 5; i++) {
        await redeemableEarningsService.addEarnings({
          userId,
          amount: 10,
          source: "miniapp",
          sourceId: uuidv4(),
          description: `Earning ${i + 1}`,
        });
      }

      // Act
      const history = await redeemableEarningsService.getLedgerHistory(userId, 3);

      // Assert
      expect(history.length).toBe(3);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // hasBeenRedeemed Tests
  // ===========================================================================

  describe("hasBeenRedeemed", () => {
    test("returns false for non-redeemed entry", async () => {
      // Arrange
      const userId = testData.user.id;

      const result = await redeemableEarningsService.addEarnings({
        userId,
        amount: 50,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "Test earning",
      });

      // Act
      const isRedeemed = await redeemableEarningsService.hasBeenRedeemed(result.ledgerEntryId);

      // Assert
      expect(isRedeemed).toBe(false);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // Full Redemption Flow Integration Test
  // ===========================================================================

  describe("Full Redemption Flow", () => {
    test("earn → lock → complete flow works correctly", async () => {
      // Arrange
      const userId = testData.user.id;
      const redemptionId = uuidv4();

      // Step 1: Earn
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 100,
        source: "agent",
        sourceId: uuidv4(),
        description: "Creator earnings",
      });

      let balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(100);
      expect(balance!.totalEarned).toBe(100);

      // Step 2: Lock for redemption
      await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 75,
        redemptionId,
      });

      balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(25);
      expect(balance!.totalPending).toBe(75);

      // Step 3: Complete redemption
      await redeemableEarningsService.completeRedemption({
        userId,
        redemptionId,
        amount: 75,
      });

      balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(25);
      expect(balance!.totalPending).toBe(0);
      expect(balance!.totalRedeemed).toBe(75);
      expect(balance!.totalEarned).toBe(100);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("earn → lock → refund flow restores balance", async () => {
      // Arrange
      const userId = testData.user.id;
      const redemptionId = uuidv4();

      // Earn
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 50,
        source: "mcp",
        sourceId: uuidv4(),
        description: "MCP creator earnings",
      });

      // Lock
      await redeemableEarningsService.lockForRedemption({
        userId,
        amount: 50,
        redemptionId,
      });

      let balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(0);
      expect(balance!.totalPending).toBe(50);

      // Refund
      await redeemableEarningsService.refundRedemption({
        userId,
        redemptionId,
        amount: 50,
        reason: "Transaction failed",
      });

      // Verify fully restored
      balance = await redeemableEarningsService.getBalance(userId);
      expect(balance!.availableBalance).toBe(50);
      expect(balance!.totalPending).toBe(0);
      expect(balance!.totalRedeemed).toBe(0);

      // Cleanup
      await cleanupEarnings(userId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // convertToCredits Tests (used by container daily-billing pay-as-you-go path)
  // ===========================================================================

  describe("convertToCredits", () => {
    test("debits available_balance, leaves total_earned and total_redeemed alone", async () => {
      const userId = testData.user.id;
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 20,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "earnings",
      });

      const result = await redeemableEarningsService.convertToCredits({
        userId,
        amount: 5,
        organizationId: testData.organization.id,
        description: "test conversion",
      });

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(15);

      const [row] = await dbWrite
        .select()
        .from(redeemableEarnings)
        .where(eq(redeemableEarnings.user_id, userId));

      expect(Number(row.available_balance)).toBe(15);
      expect(Number(row.total_earned)).toBe(20);
      expect(Number(row.total_redeemed)).toBe(0);
      expect(Number(row.total_pending)).toBe(0);
      expect(Number(row.total_converted_to_credits)).toBe(5);

      await cleanupEarnings(userId);
    });

    test("rejects when amount exceeds available balance", async () => {
      const userId = testData.user.id;
      await redeemableEarningsService.addEarnings({
        userId,
        amount: 5,
        source: "miniapp",
        sourceId: uuidv4(),
        description: "earnings",
      });

      await expect(
        redeemableEarningsService.convertToCredits({
          userId,
          amount: 10,
          organizationId: testData.organization.id,
          description: "overdraft",
        }),
      ).rejects.toThrow(/Insufficient/);

      await cleanupEarnings(userId);
    });

    test("rejects when no earnings record exists", async () => {
      const userId = testData.user.id;
      await expect(
        redeemableEarningsService.convertToCredits({
          userId,
          amount: 1,
          organizationId: testData.organization.id,
          description: "no record",
        }),
      ).rejects.toThrow(/No earnings record/);
    });
  });
});
