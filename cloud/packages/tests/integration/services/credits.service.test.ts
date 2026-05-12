/**
 * Credits Service Tests
 *
 * Sociable unit tests for the Credits Service.
 * Tests use real PostgreSQL database (no mocks).
 *
 * Key test scenarios:
 * - addCredits: balance updates, transaction records, idempotency
 * - reserveAndDeductCredits: atomic deduction, race conditions
 * - refundCredits: balance restoration
 * - reconcile: refund/overage calculations
 *
 * @see https://martinfowler.com/bliki/UnitTest.html (Sociable vs Solitary)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { dbRead } from "@/db/client";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { organizations } from "@/db/schemas/organizations";
import {
  COST_BUFFER,
  creditsService,
  InsufficientCreditsError,
  MIN_RESERVATION,
} from "@/lib/services/credits";
import { getConnectionString } from "@/tests/infrastructure/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/infrastructure/test-data-factory";

describe("CreditsService", () => {
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

  // ===========================================================================
  // addCredits Tests
  // ===========================================================================

  describe("addCredits", () => {
    test("adds credits to organization balance", async () => {
      // Arrange
      const initialBalance = testData.organization.creditBalance;
      const amountToAdd = 50;

      // Act
      const result = await creditsService.addCredits({
        organizationId: testData.organization.id,
        amount: amountToAdd,
        description: "Test credit addition",
      });

      // Assert
      expect(result.newBalance).toBe(initialBalance + amountToAdd);
      expect(result.transaction).toBeDefined();
      expect(result.transaction.type).toBe("credit");

      // Verify in database
      const org = await dbRead.query.organizations.findFirst({
        where: eq(organizations.id, testData.organization.id),
      });
      expect(Number(org?.credit_balance)).toBe(initialBalance + amountToAdd);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates transaction record with correct metadata", async () => {
      // Arrange
      const metadata = { source: "test", reference: "ref-123" };

      // Act
      const result = await creditsService.addCredits({
        organizationId: testData.organization.id,
        amount: 25,
        description: "Test with metadata",
        metadata,
      });

      // Assert
      expect(result.transaction.description).toBe("Test with metadata");
      expect(result.transaction.metadata).toEqual(metadata);
      expect(Number(result.transaction.amount)).toBe(25);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("handles idempotency with stripePaymentIntentId", async () => {
      // Arrange
      const paymentIntentId = `pi_test_${uuidv4()}`;
      const amount = 100;

      // Act - First call
      const result1 = await creditsService.addCredits({
        organizationId: testData.organization.id,
        amount,
        description: "First call",
        stripePaymentIntentId: paymentIntentId,
      });

      // Act - Second call with same payment intent
      const result2 = await creditsService.addCredits({
        organizationId: testData.organization.id,
        amount,
        description: "Duplicate call",
        stripePaymentIntentId: paymentIntentId,
      });

      // Assert - Should return same transaction, not create new one
      expect(result2.transaction.id).toBe(result1.transaction.id);

      // Balance should only be increased once
      const org = await dbRead.query.organizations.findFirst({
        where: eq(organizations.id, testData.organization.id),
      });
      expect(Number(org?.credit_balance)).toBe(testData.organization.creditBalance + amount);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("throws error for non-existent organization", async () => {
      // Arrange
      const fakeOrgId = uuidv4();

      // Act & Assert - Service throws DB error for FK violation
      await expect(
        creditsService.addCredits({
          organizationId: fakeOrgId,
          amount: 50,
          description: "Should fail",
        }),
      ).rejects.toThrow(); // Any error is acceptable for non-existent org

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // reserveAndDeductCredits Tests
  // ===========================================================================

  describe("reserveAndDeductCredits", () => {
    test("deducts credits atomically", async () => {
      // Arrange
      const initialBalance = testData.organization.creditBalance;
      const amountToDeduct = 30;

      // Act
      const result = await creditsService.reserveAndDeductCredits({
        organizationId: testData.organization.id,
        amount: amountToDeduct,
        description: "Test deduction",
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(initialBalance - amountToDeduct);
      expect(result.transaction).not.toBeNull();
      expect(result.transaction?.type).toBe("debit");
      expect(Number(result.transaction?.amount)).toBe(-amountToDeduct);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns insufficient_balance when balance too low", async () => {
      // Arrange - Try to deduct more than available
      const amountToDeduct = testData.organization.creditBalance + 100;

      // Act
      const result = await creditsService.reserveAndDeductCredits({
        organizationId: testData.organization.id,
        amount: amountToDeduct,
        description: "Should fail - insufficient",
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.reason).toBe("insufficient_balance");
      expect(result.transaction).toBeNull();

      // Balance should be unchanged
      const org = await dbRead.query.organizations.findFirst({
        where: eq(organizations.id, testData.organization.id),
      });
      expect(Number(org?.credit_balance)).toBe(testData.organization.creditBalance);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns below_minimum when below threshold", async () => {
      // Arrange
      const minimumRequired = 150;
      const amountToDeduct = 10;

      // Act
      const result = await creditsService.reserveAndDeductCredits({
        organizationId: testData.organization.id,
        amount: amountToDeduct,
        description: "Should fail - below minimum",
        minimumBalanceRequired: minimumRequired,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.reason).toBe("below_minimum");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns org_not_found for invalid organization", async () => {
      // Arrange
      const fakeOrgId = uuidv4();

      // Act
      const result = await creditsService.reserveAndDeductCredits({
        organizationId: fakeOrgId,
        amount: 10,
        description: "Should fail - no org",
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.reason).toBe("org_not_found");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("throws error for non-positive amount", async () => {
      // Act & Assert
      await expect(
        creditsService.reserveAndDeductCredits({
          organizationId: testData.organization.id,
          amount: 0,
          description: "Should fail",
        }),
      ).rejects.toThrow("Amount must be positive");

      await expect(
        creditsService.reserveAndDeductCredits({
          organizationId: testData.organization.id,
          amount: -10,
          description: "Should fail",
        }),
      ).rejects.toThrow("Amount must be positive");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    // ===========================================================================
    // CRITICAL: Race Condition Test (P0)
    // ===========================================================================

    test("handles 20 concurrent deductions safely - balance never goes negative", async () => {
      // Arrange: Create org with exactly $10
      const raceTestData = await createTestDataSet(connectionString, {
        creditBalance: 10,
        organizationName: "Race Test Org",
      });

      const numConcurrent = 20;
      const amountPerDeduction = 1;

      // Act: Fire 20 concurrent $1 deductions
      const promises = Array.from({ length: numConcurrent }, (_, i) =>
        creditsService.reserveAndDeductCredits({
          organizationId: raceTestData.organization.id,
          amount: amountPerDeduction,
          description: `Concurrent deduction ${i + 1}`,
        }),
      );

      const results = await Promise.allSettled(promises);

      // Assert: Count successes and failures
      const successes = results.filter((r) => r.status === "fulfilled" && r.value.success);
      const failures = results.filter((r) => r.status === "fulfilled" && !r.value.success);

      // Exactly 10 should succeed (we have $10, each deduction is $1)
      expect(successes.length).toBe(10);
      expect(failures.length).toBe(10);

      // CRITICAL: Final balance must be exactly $0, NEVER negative
      const org = await dbRead.query.organizations.findFirst({
        where: eq(organizations.id, raceTestData.organization.id),
      });
      expect(Number(org?.credit_balance)).toBe(0);
      expect(Number(org?.credit_balance)).toBeGreaterThanOrEqual(0);

      // Verify transaction count
      const transactions = await dbRead.query.creditTransactions.findMany({
        where: eq(creditTransactions.organization_id, raceTestData.organization.id),
      });
      const debitTransactions = transactions.filter((t) => t.type === "debit");
      expect(debitTransactions.length).toBe(10);

      // Cleanup (only raceTestData - testData is cleaned in afterAll)
      await cleanupTestData(connectionString, raceTestData.organization.id);
    }, 30000); // Extended timeout for concurrent test
  });

  // ===========================================================================
  // refundCredits Tests
  // ===========================================================================

  describe("refundCredits", () => {
    test("adds credits back to organization", async () => {
      // Arrange - First deduct some credits
      await creditsService.reserveAndDeductCredits({
        organizationId: testData.organization.id,
        amount: 30,
        description: "Initial deduction",
      });

      const balanceAfterDeduction = testData.organization.creditBalance - 30;
      const refundAmount = 15;

      // Act
      const result = await creditsService.refundCredits({
        organizationId: testData.organization.id,
        amount: refundAmount,
        description: "Test refund",
      });

      // Assert
      expect(result.newBalance).toBe(balanceAfterDeduction + refundAmount);
      expect(result.transaction.type).toBe("refund");
      expect(Number(result.transaction.amount)).toBe(refundAmount);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates refund transaction record", async () => {
      // Act
      const result = await creditsService.refundCredits({
        organizationId: testData.organization.id,
        amount: 10,
        description: "Refund for failed operation",
        metadata: { reason: "operation_failed" },
      });

      // Assert
      expect(result.transaction.type).toBe("refund");
      expect(result.transaction.description).toBe("Refund for failed operation");
      expect(result.transaction.metadata).toEqual({
        reason: "operation_failed",
      });

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("throws error for non-positive refund amount", async () => {
      // Act & Assert
      await expect(
        creditsService.refundCredits({
          organizationId: testData.organization.id,
          amount: 0,
          description: "Should fail",
        }),
      ).rejects.toThrow("Refund amount must be positive");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // reconcile Tests
  // ===========================================================================

  describe("reconcile", () => {
    test("refunds excess when actual cost < reserved", async () => {
      // Arrange
      const reserved = 10;
      const actual = 7;
      const expectedRefund = reserved - actual;

      // First deduct the reserved amount
      await creditsService.reserveAndDeductCredits({
        organizationId: testData.organization.id,
        amount: reserved,
        description: "Reserve for test",
      });

      const balanceAfterReservation = testData.organization.creditBalance - reserved;

      // Act
      await creditsService.reconcile({
        organizationId: testData.organization.id,
        reservedAmount: reserved,
        actualCost: actual,
        description: "Test reconciliation",
      });

      // Assert - Balance should have excess refunded
      const org = await dbRead.query.organizations.findFirst({
        where: eq(organizations.id, testData.organization.id),
      });
      expect(Number(org?.credit_balance)).toBe(balanceAfterReservation + expectedRefund);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("charges overage when actual cost > reserved", async () => {
      // Arrange
      const reserved = 5;
      const actual = 8;
      const expectedOverage = actual - reserved;

      // First deduct the reserved amount
      await creditsService.reserveAndDeductCredits({
        organizationId: testData.organization.id,
        amount: reserved,
        description: "Reserve for test",
      });

      const balanceAfterReservation = testData.organization.creditBalance - reserved;

      // Act
      await creditsService.reconcile({
        organizationId: testData.organization.id,
        reservedAmount: reserved,
        actualCost: actual,
        description: "Test reconciliation overage",
      });

      // Assert - Balance should have overage deducted
      const org = await dbRead.query.organizations.findFirst({
        where: eq(organizations.id, testData.organization.id),
      });
      expect(Number(org?.credit_balance)).toBe(balanceAfterReservation - expectedOverage);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("no-op when difference is within EPSILON", async () => {
      // Arrange
      const reserved = 5;
      const actual = 5.00000005; // Within EPSILON (0.0000001)

      // First deduct the reserved amount
      await creditsService.reserveAndDeductCredits({
        organizationId: testData.organization.id,
        amount: reserved,
        description: "Reserve for test",
      });

      const balanceAfterReservation = testData.organization.creditBalance - reserved;

      // Act
      await creditsService.reconcile({
        organizationId: testData.organization.id,
        reservedAmount: reserved,
        actualCost: actual,
        description: "Test reconciliation epsilon",
      });

      // Assert - Balance should be unchanged (within epsilon)
      const org = await dbRead.query.organizations.findFirst({
        where: eq(organizations.id, testData.organization.id),
      });
      expect(Number(org?.credit_balance)).toBe(balanceAfterReservation);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // reserve Tests
  // ===========================================================================

  describe("reserve", () => {
    test("reserves fixed amount when amount is provided", async () => {
      // Arrange
      const amountToReserve = 25;

      // Act
      const reservation = await creditsService.reserve({
        organizationId: testData.organization.id,
        description: "Test fixed reservation",
        amount: amountToReserve,
      });

      // Assert
      expect(reservation.reservedAmount).toBe(amountToReserve);
      expect(typeof reservation.reconcile).toBe("function");

      // Balance should be reduced
      const org = await dbRead.query.organizations.findFirst({
        where: eq(organizations.id, testData.organization.id),
      });
      expect(Number(org?.credit_balance)).toBe(
        testData.organization.creditBalance - amountToReserve,
      );

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("throws InsufficientCreditsError when balance too low", async () => {
      // Arrange - Try to reserve more than available
      const amountToReserve = testData.organization.creditBalance + 100;

      // Act & Assert
      await expect(
        creditsService.reserve({
          organizationId: testData.organization.id,
          description: "Should fail",
          amount: amountToReserve,
        }),
      ).rejects.toThrow(InsufficientCreditsError);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("throws error when neither amount nor model provided", async () => {
      // Act & Assert
      await expect(
        creditsService.reserve({
          organizationId: testData.organization.id,
          description: "Should fail",
        }),
      ).rejects.toThrow("reserve() requires either `amount` or `model`");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // createAnonymousReservation Tests
  // ===========================================================================

  describe("createAnonymousReservation", () => {
    test("returns reservation with zero amount", () => {
      // Act
      const reservation = creditsService.createAnonymousReservation();

      // Assert
      expect(reservation.reservedAmount).toBe(0);
    });

    test("reconcile is a no-op", async () => {
      // Act
      const reservation = creditsService.createAnonymousReservation();

      // Assert - Should not throw
      await expect(reservation.reconcile(100)).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // Constants Tests
  // ===========================================================================

  describe("Constants", () => {
    test("COST_BUFFER is defined and reasonable", () => {
      expect(COST_BUFFER).toBeGreaterThan(1);
      expect(COST_BUFFER).toBeLessThan(3);
    });

    test("MIN_RESERVATION is defined and small", () => {
      expect(MIN_RESERVATION).toBeGreaterThan(0);
      expect(MIN_RESERVATION).toBeLessThanOrEqual(0.01);
    });
  });
});
