/**
 * Integration Tests: Stripe Trading Balance Funding Service
 *
 * Tests the TradingBalanceFundingService methods used by Stripe integration:
 * - fundPurchase (with 'stripe' payment provider)
 * - reversePurchaseFunding
 * - creditDisputeWon
 *
 * These tests interact with the real database to verify:
 * - Points are correctly added to virtualBalance
 * - Transaction records are created correctly
 * - Idempotency works as expected
 * - Balance floor at 0 for reversals
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { TradingBalanceFundingService } from '@feed/api';
import { and, balanceTransactions, db, eq, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { TestScenarios } from '../unit/stripe/test-fixtures';

// Test user ID prefix for cleanup
const TEST_USER_PREFIX = 'stripe-test-';

describe('TradingBalanceFundingService Stripe Integration', () => {
  // Track created test users for cleanup
  const testUserIds: string[] = [];

  /**
   * Create a test user in the database
   */
  async function createDbUser(
    initialBalance = 0,
    initialDeposited = initialBalance,
    initialWithdrawn = 0
  ): Promise<string> {
    const userId = `${TEST_USER_PREFIX}${await generateSnowflakeId()}`;
    testUserIds.push(userId);

    await db.insert(users).values({
      id: userId,
      username: `test_${userId.slice(-8)}`,
      virtualBalance: initialBalance.toFixed(2),
      totalDeposited: initialDeposited.toFixed(2),
      totalWithdrawn: initialWithdrawn.toFixed(2),
      reputationPoints: 0,
      invitePoints: 0,
      earnedPoints: 0,
      bonusPoints: 0,
      isActor: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return userId;
  }

  /**
   * Get user's current virtual balance
   */
  async function getUserBalance(userId: string): Promise<number> {
    const [user] = await db
      .select({ virtualBalance: users.virtualBalance })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return Number(user?.virtualBalance ?? 0);
  }

  async function getUserFundingTotals(userId: string): Promise<{
    totalDeposited: number;
    totalWithdrawn: number;
  }> {
    const [user] = await db
      .select({
        totalDeposited: users.totalDeposited,
        totalWithdrawn: users.totalWithdrawn,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return {
      totalDeposited: Number(user?.totalDeposited ?? 0),
      totalWithdrawn: Number(user?.totalWithdrawn ?? 0),
    };
  }

  /**
   * Clean up test data after all tests
   */
  afterAll(async () => {
    // Delete balance transactions first
    for (const userId of testUserIds) {
      await db
        .delete(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));
    }

    // Then delete users
    for (const userId of testUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  describe('fundPurchase with Stripe', () => {
    it('should credit correct points for $10 purchase', async () => {
      const userId = await createDbUser();
      const scenario = TestScenarios.simplePurchase;

      const result = await TradingBalanceFundingService.fundPurchase(
        userId,
        scenario.amountUSD,
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(scenario.expectedPoints);
      expect(result.newBalance).toBe(scenario.expectedPoints);

      // Verify database
      const balance = await getUserBalance(userId);
      expect(balance).toBe(scenario.expectedPoints);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(scenario.expectedPoints);
      expect(totals.totalWithdrawn).toBe(0);
    });

    it('should credit correct points for minimum $1 purchase', async () => {
      const userId = await createDbUser();
      const scenario = TestScenarios.minimumPurchase;

      const result = await TradingBalanceFundingService.fundPurchase(
        userId,
        scenario.amountUSD,
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(scenario.expectedPoints);

      const balance = await getUserBalance(userId);
      expect(balance).toBe(scenario.expectedPoints);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(scenario.expectedPoints);
      expect(totals.totalWithdrawn).toBe(0);
    });

    it('should credit correct points for maximum $1000 purchase', async () => {
      const userId = await createDbUser();
      const scenario = TestScenarios.maximumPurchase;

      const result = await TradingBalanceFundingService.fundPurchase(
        userId,
        scenario.amountUSD,
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(scenario.expectedPoints);

      const balance = await getUserBalance(userId);
      expect(balance).toBe(scenario.expectedPoints);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(scenario.expectedPoints);
      expect(totals.totalWithdrawn).toBe(0);
    });

    it('should add to existing balance', async () => {
      const initialBalance = 5000;
      const userId = await createDbUser(initialBalance);

      const result = await TradingBalanceFundingService.fundPurchase(
        userId,
        10, // $10 = 1000 points
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(1000);
      expect(result.newBalance).toBe(initialBalance + 1000);

      const balance = await getUserBalance(userId);
      expect(balance).toBe(6000);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(6000);
      expect(totals.totalWithdrawn).toBe(0);
    });

    it('should return the original funding result on idempotent replays', async () => {
      const userId = await createDbUser();
      const sessionId = `cs_test_${Date.now()}`;
      const paymentIntentId = `pi_test_${Date.now()}`;

      const result1 = await TradingBalanceFundingService.fundPurchase(
        userId,
        10,
        sessionId,
        paymentIntentId,
        'stripe'
      );

      expect(result1.success).toBe(true);
      expect(result1.balanceDelta).toBe(1000);
      expect(result1.newBalance).toBe(1000);

      const result2 = await TradingBalanceFundingService.fundPurchase(
        userId,
        10,
        sessionId,
        paymentIntentId,
        'stripe'
      );

      expect(result2.success).toBe(true);
      expect(result2.alreadyProcessed).toBe(true);
      expect(result2.balanceDelta).toBe(1000);
      expect(result2.newBalance).toBe(1000);
      expect(result2.transactionId).toBe(result1.transactionId);
    });

    it('should create transaction record with correct metadata', async () => {
      const userId = await createDbUser();
      const sessionId = `cs_test_${Date.now()}`;
      const paymentIntentId = `pi_test_${Date.now()}`;

      await TradingBalanceFundingService.fundPurchase(
        userId,
        25,
        sessionId,
        paymentIntentId,
        'stripe'
      );

      // Get the transaction from balanceTransactions
      // relatedId stores the paymentIntentId (payment intent ID) for stripe purchases
      const txResult = await db
        .select()
        .from(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.userId, userId),
            eq(balanceTransactions.relatedId, paymentIntentId),
            eq(balanceTransactions.type, 'stripe_purchase')
          )
        )
        .limit(1);

      expect(txResult.length).toBe(1);
      const tx = txResult[0]!;
      expect(tx.userId).toBe(userId);
      expect(Number(tx.amount)).toBe(2500);
      expect(tx.type).toBe('stripe_purchase');
      // Verify description contains payment info
      const description = JSON.parse(tx.description || '{}');
      expect(description.paymentProvider).toBe('stripe');
      expect(description.paymentTxHash).toBe(paymentIntentId);
      expect(description.paymentRequestId).toBe(sessionId);
    });

    it('should fail for non-existent user', async () => {
      const result = await TradingBalanceFundingService.fundPurchase(
        'non-existent-user-id',
        10,
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('User not found');
    });
  });

  describe('reversePurchaseFunding', () => {
    it('should deduct full amount for refund with sufficient balance', async () => {
      // First create and fund user
      const userId = await createDbUser();
      await TradingBalanceFundingService.fundPurchase(
        userId,
        50, // $50 = 5000 points
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      const balanceBeforeRefund = await getUserBalance(userId);
      expect(balanceBeforeRefund).toBe(5000);

      // Now refund
      const refundEventId = `evt_refund_${Date.now()}`;
      const result = await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_original_${Date.now()}`,
        'refund',
        50, // Full refund
        refundEventId
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(-5000); // Negative for deduction
      expect(result.newBalance).toBe(0);

      const balance = await getUserBalance(userId);
      expect(balance).toBe(0);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(5000);
      expect(totals.totalWithdrawn).toBe(5000);
    });

    it('should floor balance at 0 when refund exceeds balance', async () => {
      // Create user with some points
      const userId = await createDbUser(1000); // 1000 points

      // Attempt to refund $50 (5000 points) when user only has 1000
      const result = await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_test_${Date.now()}`,
        'refund',
        50,
        `evt_refund_${Date.now()}`
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(-1000); // Only deducted what was available
      expect(result.newBalance).toBe(0);

      const balance = await getUserBalance(userId);
      expect(balance).toBe(0);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(1000);
      expect(totals.totalWithdrawn).toBe(5000);
    });

    it('should be idempotent - same event processed twice', async () => {
      const userId = await createDbUser(5000);
      const eventId = `evt_refund_idempotent_${Date.now()}`;

      // First call
      const result1 = await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_test_${Date.now()}`,
        'refund',
        20,
        eventId
      );

      expect(result1.success).toBe(true);
      expect(result1.balanceDelta).toBe(-2000);

      const balanceAfterFirst = await getUserBalance(userId);
      expect(balanceAfterFirst).toBe(3000);
      const totalsAfterFirst = await getUserFundingTotals(userId);
      expect(totalsAfterFirst.totalDeposited).toBe(5000);
      expect(totalsAfterFirst.totalWithdrawn).toBe(2000);

      // Second call with same event ID - should be no-op
      const result2 = await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_test_${Date.now()}`,
        'refund',
        20,
        eventId
      );

      expect(result2.success).toBe(true);
      expect(result2.alreadyProcessed).toBe(true);
      expect(result2.balanceDelta).toBe(-2000);
      expect(result2.newBalance).toBe(3000);
      expect(result2.transactionId).toBe(result1.transactionId);

      // Balance should not change
      const balanceAfterSecond = await getUserBalance(userId);
      expect(balanceAfterSecond).toBe(3000);
      const totalsAfterSecond = await getUserFundingTotals(userId);
      expect(totalsAfterSecond.totalDeposited).toBe(5000);
      expect(totalsAfterSecond.totalWithdrawn).toBe(2000);
    });

    it('should handle dispute deduction correctly', async () => {
      const userId = await createDbUser();
      await TradingBalanceFundingService.fundPurchase(
        userId,
        100, // $100 = 10000 points
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      const result = await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_test_${Date.now()}`,
        'dispute',
        100,
        `evt_dispute_${Date.now()}`
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(-10000);
      expect(result.newBalance).toBe(0);

      // Check transaction has correct type in balanceTransactions
      const transactions = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));

      const disputeTx = transactions.find((tx) => tx.type === 'stripe_dispute');
      expect(disputeTx).toBeDefined();
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(10000);
      expect(totals.totalWithdrawn).toBe(10000);
    });

    it('should fail for non-existent user', async () => {
      const result = await TradingBalanceFundingService.reversePurchaseFunding(
        'non-existent-user',
        `pi_test_${Date.now()}`,
        'refund',
        10,
        `evt_test_${Date.now()}`
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('User not found');
    });
  });

  describe('creditDisputeWon', () => {
    it('should re-credit points after winning dispute', async () => {
      const userId = await createDbUser();

      // Simulate: purchase -> dispute -> win
      // 1. Purchase $50
      await TradingBalanceFundingService.fundPurchase(
        userId,
        50,
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      // 2. Dispute created - points deducted
      await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_dispute_${Date.now()}`,
        'dispute',
        50,
        `evt_dispute_created_${Date.now()}`
      );

      const balanceAfterDispute = await getUserBalance(userId);
      expect(balanceAfterDispute).toBe(0);

      // 3. Dispute won - re-credit
      const result = await TradingBalanceFundingService.creditDisputeWon(
        userId,
        `dp_test_${Date.now()}`,
        50,
        `evt_dispute_won_${Date.now()}`
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(5000);
      expect(result.newBalance).toBe(5000);

      const balance = await getUserBalance(userId);
      expect(balance).toBe(5000);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(5000);
      expect(totals.totalWithdrawn).toBe(0);
    });

    it('should add to existing balance when re-crediting', async () => {
      // User earned some points between dispute and winning
      const userId = await createDbUser(2000, 2000, 5000);

      const result = await TradingBalanceFundingService.creditDisputeWon(
        userId,
        `dp_test_${Date.now()}`,
        50,
        `evt_dispute_won_${Date.now()}`
      );

      expect(result.success).toBe(true);
      expect(result.balanceDelta).toBe(5000);
      expect(result.newBalance).toBe(7000); // 2000 + 5000

      const balance = await getUserBalance(userId);
      expect(balance).toBe(7000);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(2000);
      expect(totals.totalWithdrawn).toBe(0);
    });

    it('should be idempotent - same event processed twice', async () => {
      const userId = await createDbUser(0);
      const eventId = `evt_dispute_won_idempotent_${Date.now()}`;

      // First call
      const result1 = await TradingBalanceFundingService.creditDisputeWon(
        userId,
        `dp_test_${Date.now()}`,
        30,
        eventId
      );

      expect(result1.success).toBe(true);
      expect(result1.balanceDelta).toBe(3000);

      // Second call with same event ID
      const result2 = await TradingBalanceFundingService.creditDisputeWon(
        userId,
        `dp_test_${Date.now()}`,
        30,
        eventId
      );

      expect(result2.success).toBe(true);
      expect(result2.alreadyProcessed).toBe(true);
      expect(result2.balanceDelta).toBe(3000);
      expect(result2.newBalance).toBe(3000);
      expect(result2.transactionId).toBe(result1.transactionId);

      // Balance should only have been credited once
      const balance = await getUserBalance(userId);
      expect(balance).toBe(3000);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(0);
      expect(totals.totalWithdrawn).toBe(0);
    });

    it('should fail for non-existent user', async () => {
      const result = await TradingBalanceFundingService.creditDisputeWon(
        'non-existent-user',
        `dp_test_${Date.now()}`,
        50,
        `evt_test_${Date.now()}`
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('User not found');
    });
  });

  describe('Full Lifecycle Scenarios', () => {
    it('should handle purchase -> full refund correctly', async () => {
      const userId = await createDbUser();
      const scenario = TestScenarios.fullRefund;

      // Purchase
      await TradingBalanceFundingService.fundPurchase(
        userId,
        scenario.purchaseAmountUSD,
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      // Refund
      await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_test_${Date.now()}`,
        'refund',
        scenario.refundAmountUSD,
        `evt_refund_${Date.now()}`
      );

      const balance = await getUserBalance(userId);
      expect(balance).toBe(scenario.expectedPointsAfter);
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(5000);
      expect(totals.totalWithdrawn).toBe(5000);
    });

    it('should handle purchase -> partial refund correctly', async () => {
      const userId = await createDbUser();
      const scenario = TestScenarios.partialRefund;

      // Purchase $100 = 10000 points
      await TradingBalanceFundingService.fundPurchase(
        userId,
        scenario.purchaseAmountUSD,
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      // Partial refund $30 = 3000 points
      await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_test_${Date.now()}`,
        'refund',
        scenario.refundAmountUSD,
        `evt_refund_${Date.now()}`
      );

      const balance = await getUserBalance(userId);
      expect(balance).toBe(scenario.expectedPointsAfter); // 7000
      const totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(10000);
      expect(totals.totalWithdrawn).toBe(3000);
    });

    it('should handle purchase -> dispute -> dispute won correctly', async () => {
      const userId = await createDbUser();
      const scenario = TestScenarios.disputeWon;

      // Purchase
      await TradingBalanceFundingService.fundPurchase(
        userId,
        scenario.purchaseAmountUSD,
        `cs_test_${Date.now()}`,
        `pi_test_${Date.now()}`,
        'stripe'
      );

      // Dispute created
      await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_test_${Date.now()}`,
        'dispute',
        scenario.purchaseAmountUSD,
        `evt_dispute_${Date.now()}`
      );

      const balanceAfterDispute = await getUserBalance(userId);
      expect(balanceAfterDispute).toBe(scenario.expectedPointsAfterDispute);
      const totalsAfterDispute = await getUserFundingTotals(userId);
      expect(totalsAfterDispute.totalDeposited).toBe(5000);
      expect(totalsAfterDispute.totalWithdrawn).toBe(5000);

      // Dispute won
      await TradingBalanceFundingService.creditDisputeWon(
        userId,
        `dp_test_${Date.now()}`,
        scenario.purchaseAmountUSD,
        `evt_dispute_won_${Date.now()}`
      );

      const balanceAfterWin = await getUserBalance(userId);
      expect(balanceAfterWin).toBe(scenario.expectedPointsAfterWin);
      const totalsAfterWin = await getUserFundingTotals(userId);
      expect(totalsAfterWin.totalDeposited).toBe(5000);
      expect(totalsAfterWin.totalWithdrawn).toBe(0);
    });

    it('should handle multiple purchases and refunds', async () => {
      const userId = await createDbUser();

      // Multiple purchases
      await TradingBalanceFundingService.fundPurchase(
        userId,
        10,
        `cs_1_${Date.now()}`,
        `pi_1`,
        'stripe'
      );
      await TradingBalanceFundingService.fundPurchase(
        userId,
        20,
        `cs_2_${Date.now()}`,
        `pi_2`,
        'stripe'
      );
      await TradingBalanceFundingService.fundPurchase(
        userId,
        30,
        `cs_3_${Date.now()}`,
        `pi_3`,
        'stripe'
      );

      let balance = await getUserBalance(userId);
      expect(balance).toBe(6000); // 1000 + 2000 + 3000
      let totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(6000);
      expect(totals.totalWithdrawn).toBe(0);

      // Refund one purchase
      await TradingBalanceFundingService.reversePurchaseFunding(
        userId,
        `pi_2`,
        'refund',
        20,
        `evt_refund_${Date.now()}`
      );

      balance = await getUserBalance(userId);
      expect(balance).toBe(4000); // 6000 - 2000
      totals = await getUserFundingTotals(userId);
      expect(totals.totalDeposited).toBe(6000);
      expect(totals.totalWithdrawn).toBe(2000);
    });
  });

  describe('Payment Provider Tracking', () => {
    it('should store crypto as payment provider when not specified', async () => {
      const userId = await createDbUser();
      const txHash = `tx_${Date.now()}`;

      // Call without paymentProvider (defaults to 'crypto')
      await TradingBalanceFundingService.fundPurchase(
        userId,
        10,
        `x402_${Date.now()}`,
        txHash
      );

      const txResult = await db
        .select()
        .from(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.userId, userId),
            eq(balanceTransactions.type, 'crypto_purchase')
          )
        )
        .limit(1);

      expect(txResult.length).toBe(1);
      const description = JSON.parse(txResult[0]!.description || '{}');
      expect(description.paymentProvider).toBe('crypto');
    });

    it('should store stripe as payment provider when specified', async () => {
      const userId = await createDbUser();
      const paymentIntentId = `pi_${Date.now()}`;

      await TradingBalanceFundingService.fundPurchase(
        userId,
        10,
        `cs_test_${Date.now()}`,
        paymentIntentId,
        'stripe'
      );

      const txResult = await db
        .select()
        .from(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.userId, userId),
            eq(balanceTransactions.type, 'stripe_purchase')
          )
        )
        .limit(1);

      expect(txResult.length).toBe(1);
      const description = JSON.parse(txResult[0]!.description || '{}');
      expect(description.paymentProvider).toBe('stripe');
    });
  });
});
