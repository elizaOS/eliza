/**
 * Agent Budgets Service Tests
 *
 * Sociable unit tests for the Agent Budgets Service.
 * Tests use real PostgreSQL database (no mocks).
 *
 * Key test scenarios:
 * - getOrCreateBudget: creates for new agent, returns existing
 * - checkBudget: canProceed scenarios, daily limit, paused state
 * - deductBudget: atomic deduction, race conditions, pause on depleted
 * - allocateBudget: transfers from org credits
 * - triggerAutoRefill: threshold-based refill with cooldown
 *
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { dbWrite } from "@/db/client";
import { agentBudgets, agentBudgetTransactions } from "@/db/schemas/agent-budgets";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { getConnectionString } from "@/tests/infrastructure/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/infrastructure/test-data-factory";

describe("AgentBudgetService", () => {
  let connectionString: string;
  let testData: TestDataSet;

  beforeAll(async () => {
    connectionString = getConnectionString();
  });

  beforeEach(async () => {
    // Create fresh test data for each test (org with character)
    testData = await createTestDataSet(connectionString, {
      creditBalance: 100,
      includeCharacter: true,
      characterName: "Test Agent",
    });
  });

  afterAll(async () => {
    // Cleanup is handled per-test, but ensure final cleanup
    if (testData?.organization?.id) {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  });

  // Helper to cleanup budget for a specific agent
  async function cleanupBudget(agentId: string): Promise<void> {
    await dbWrite
      .delete(agentBudgetTransactions)
      .where(eq(agentBudgetTransactions.agent_id, agentId));
    await dbWrite.delete(agentBudgets).where(eq(agentBudgets.agent_id, agentId));
  }

  // ===========================================================================
  // getOrCreateBudget Tests
  // ===========================================================================

  describe("getOrCreateBudget", () => {
    test("creates budget for new agent", async () => {
      // Arrange
      const agentId = testData.character!.id;

      // Act
      const budget = await agentBudgetService.getOrCreateBudget(agentId);

      // Assert
      expect(budget).not.toBeNull();
      expect(budget!.agent_id).toBe(agentId);
      expect(budget!.owner_org_id).toBe(testData.organization.id);
      expect(Number(budget!.allocated_budget)).toBe(0);
      expect(Number(budget!.spent_budget)).toBe(0);
      expect(budget!.is_paused).toBe(false);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns existing budget on subsequent calls", async () => {
      // Arrange
      const agentId = testData.character!.id;

      // Act - First call creates
      const budget1 = await agentBudgetService.getOrCreateBudget(agentId);

      // Act - Second call returns existing
      const budget2 = await agentBudgetService.getOrCreateBudget(agentId);

      // Assert - Same budget returned
      expect(budget2!.id).toBe(budget1!.id);
      expect(budget2!.agent_id).toBe(budget1!.agent_id);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns null for non-existent agent", async () => {
      // Arrange
      const fakeAgentId = uuidv4();

      // Act
      const budget = await agentBudgetService.getOrCreateBudget(fakeAgentId);

      // Assert
      expect(budget).toBeNull();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getBudget Tests
  // ===========================================================================

  describe("getBudget", () => {
    test("returns budget for existing agent", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act
      const budget = await agentBudgetService.getBudget(agentId);

      // Assert
      expect(budget).not.toBeNull();
      expect(budget!.agent_id).toBe(agentId);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns null when no budget exists", async () => {
      // Arrange - Don't create budget
      const agentId = testData.character!.id;

      // Act
      const budget = await agentBudgetService.getBudget(agentId);

      // Assert
      expect(budget).toBeNull();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // checkBudget Tests
  // ===========================================================================

  describe("checkBudget", () => {
    test("returns canProceed=true when sufficient budget", async () => {
      // Arrange
      const agentId = testData.character!.id;
      const _budget = await agentBudgetService.getOrCreateBudget(agentId);

      // Allocate $50 to the budget
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 50,
        fromOrgCredits: true,
      });

      // Act
      const result = await agentBudgetService.checkBudget(agentId, 10);

      // Assert
      expect(result.canProceed).toBe(true);
      expect(result.availableBudget).toBe(50);
      expect(result.isPaused).toBe(false);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns canProceed=false when insufficient budget", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Allocate only $5
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 5,
        fromOrgCredits: true,
      });

      // Act - Try to check for $10
      const result = await agentBudgetService.checkBudget(agentId, 10);

      // Assert
      expect(result.canProceed).toBe(false);
      expect(result.availableBudget).toBe(5);
      expect(result.reason).toContain("Insufficient budget");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns canProceed=false when agent is paused", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Allocate budget then pause
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 50,
        fromOrgCredits: true,
      });
      await agentBudgetService.pauseBudget(agentId, "Manual pause for testing");

      // Act
      const result = await agentBudgetService.checkBudget(agentId, 5);

      // Assert
      expect(result.canProceed).toBe(false);
      expect(result.isPaused).toBe(true);
      expect(result.reason).toContain("pause"); // Contains "pause" in reason

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("enforces daily limit", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Allocate $50 and set daily limit of $10
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 50,
        fromOrgCredits: true,
      });
      await agentBudgetService.updateSettings(agentId, { dailyLimit: 10 });

      // Spend $8 today
      await agentBudgetService.deductBudget({
        agentId,
        amount: 8,
        description: "Test spending",
      });

      // Act - Try to check for $5 (would exceed daily limit)
      const result = await agentBudgetService.checkBudget(agentId, 5);

      // Assert
      expect(result.canProceed).toBe(false);
      expect(result.dailyRemaining).toBe(2); // $10 - $8 = $2
      expect(result.reason).toContain("Daily limit");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns agent not found for invalid agent", async () => {
      // Arrange
      const fakeAgentId = uuidv4();

      // Act
      const result = await agentBudgetService.checkBudget(fakeAgentId, 10);

      // Assert
      expect(result.canProceed).toBe(false);
      expect(result.reason).toBe("Agent not found");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // deductBudget Tests
  // ===========================================================================

  describe("deductBudget", () => {
    test("deducts from budget and updates spent counters", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 50,
        fromOrgCredits: true,
      });

      // Act
      const result = await agentBudgetService.deductBudget({
        agentId,
        amount: 15,
        description: "Test deduction",
        operationType: "inference",
        model: "gpt-5.5",
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(35); // 50 - 15
      expect(result.dailySpent).toBe(15);
      expect(result.transactionId).toBeDefined();

      // Verify in database
      const budget = await agentBudgetService.getBudget(agentId);
      expect(Number(budget!.spent_budget)).toBe(15);
      expect(Number(budget!.daily_spent)).toBe(15);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates transaction record with metadata", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 50,
        fromOrgCredits: true,
      });

      // Act
      const result = await agentBudgetService.deductBudget({
        agentId,
        amount: 10,
        description: "Test operation",
        operationType: "image_gen",
        model: "dall-e-3",
        tokensUsed: 1000,
        metadata: { requestId: "req-123" },
      });

      // Assert
      expect(result.success).toBe(true);

      // Verify transaction exists
      const transactions = await agentBudgetService.getTransactions(agentId, 1);
      expect(transactions.length).toBeGreaterThan(0);
      const txn = transactions[0];
      expect(txn.type).toBe("deduction");
      expect(txn.operation_type).toBe("image_gen");
      expect(txn.model).toBe("dall-e-3");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("fails when budget is insufficient", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 10,
        fromOrgCredits: true,
      });

      // Act - Try to deduct more than available
      const result = await agentBudgetService.deductBudget({
        agentId,
        amount: 50,
        description: "Should fail",
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("Insufficient budget");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("fails when daily limit is exceeded", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 100,
        fromOrgCredits: true,
      });
      await agentBudgetService.updateSettings(agentId, { dailyLimit: 20 });

      // Spend $15 first
      await agentBudgetService.deductBudget({
        agentId,
        amount: 15,
        description: "First deduction",
      });

      // Act - Try to spend $10 more (would exceed $20 daily limit)
      const result = await agentBudgetService.deductBudget({
        agentId,
        amount: 10,
        description: "Should fail",
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("Daily limit exceeded");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("pauses agent when depleted and pauseOnDepleted is true", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 10,
        fromOrgCredits: true,
      });

      // Act - Try to deduct $15 from $10 budget
      const result = await agentBudgetService.deductBudget({
        agentId,
        amount: 15,
        description: "Should pause agent",
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.shouldPause).toBe(true);
      expect(result.error).toContain("paused");

      // Verify agent is paused
      const budget = await agentBudgetService.getBudget(agentId);
      expect(budget!.is_paused).toBe(true);
      expect(budget!.pause_reason).toBe("Budget depleted");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("rejects non-positive amount", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act
      const result = await agentBudgetService.deductBudget({
        agentId,
        amount: 0,
        description: "Should fail",
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Amount must be positive");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    // ===========================================================================
    // CRITICAL: Race Condition Test (P0)
    // ===========================================================================

    test("handles 20 concurrent deductions safely - balance never goes negative", async () => {
      // Arrange: Create a dedicated test org and character for race test
      const raceTestData = await createTestDataSet(connectionString, {
        creditBalance: 100,
        includeCharacter: true,
        characterName: "Race Test Agent",
      });

      const agentId = raceTestData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Allocate exactly $10 to the agent budget
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 10,
        fromOrgCredits: true,
      });

      const numConcurrent = 20;
      const amountPerDeduction = 1;

      // Act: Fire 20 concurrent $1 deductions
      const promises = Array.from({ length: numConcurrent }, (_, i) =>
        agentBudgetService.deductBudget({
          agentId,
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
      const budget = await agentBudgetService.getBudget(agentId);
      const finalBalance = Number(budget!.allocated_budget) - Number(budget!.spent_budget);
      expect(finalBalance).toBe(0);
      expect(finalBalance).toBeGreaterThanOrEqual(0);

      // Verify transaction count
      const transactions = await agentBudgetService.getTransactions(agentId);
      const deductionTxns = transactions.filter((t) => t.type === "deduction");
      expect(deductionTxns.length).toBe(10);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, raceTestData.organization.id);
      await cleanupTestData(connectionString, testData.organization.id);
    }, 30000);
  });

  // ===========================================================================
  // allocateBudget Tests
  // ===========================================================================

  describe("allocateBudget", () => {
    test("allocates budget from organization credits", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act
      const result = await agentBudgetService.allocateBudget({
        agentId,
        amount: 30,
        fromOrgCredits: true,
        description: "Initial allocation",
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(30);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("fails when organization has insufficient credits", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act - Try to allocate more than org has
      const result = await agentBudgetService.allocateBudget({
        agentId,
        amount: 500, // Org only has 100
        fromOrgCredits: true,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Insufficient organization credits");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("unpauses agent that was paused due to depletion", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Allocate initial budget, then deplete it
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 10,
        fromOrgCredits: true,
      });

      // Deplete and trigger pause
      await agentBudgetService.deductBudget({
        agentId,
        amount: 15,
        description: "Deplete budget",
      });

      // Verify paused
      let budget = await agentBudgetService.getBudget(agentId);
      expect(budget!.is_paused).toBe(true);

      // Act - Allocate more budget
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 20,
        fromOrgCredits: true,
      });

      // Assert - Should be unpaused
      budget = await agentBudgetService.getBudget(agentId);
      expect(budget!.is_paused).toBe(false);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates allocation transaction record", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 25,
        fromOrgCredits: true,
        description: "Test allocation",
      });

      // Assert
      const transactions = await agentBudgetService.getTransactions(agentId, 1);
      expect(transactions.length).toBeGreaterThan(0);
      expect(transactions[0].type).toBe("allocation");
      expect(Number(transactions[0].amount)).toBe(25);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("rejects non-positive amount", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act
      const result = await agentBudgetService.allocateBudget({
        agentId,
        amount: -10,
        fromOrgCredits: true,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Amount must be positive");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // triggerAutoRefill Tests
  // ===========================================================================

  describe("triggerAutoRefill", () => {
    test("refills when below threshold", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Allocate initial budget
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 20,
        fromOrgCredits: true,
      });

      // Spend to get below threshold BEFORE enabling auto-refill
      // This avoids the async auto-refill triggered by deductBudget
      await agentBudgetService.deductBudget({
        agentId,
        amount: 15,
        description: "Reduce balance",
      });

      // Verify balance is below threshold before auto-refill
      let budget = await agentBudgetService.getBudget(agentId);
      let balance = Number(budget!.allocated_budget) - Number(budget!.spent_budget);
      expect(balance).toBe(5); // 20 - 15 = 5

      // Enable auto-refill AFTER the deduction
      await agentBudgetService.updateSettings(agentId, {
        autoRefillEnabled: true,
        autoRefillAmount: 30,
        autoRefillThreshold: 10,
      });

      // Manually trigger auto-refill (balance 5 is below threshold 10)
      const refillResult = await agentBudgetService.triggerAutoRefill(agentId);
      expect(refillResult).toBe(true);

      // Assert - Budget should be refilled
      budget = await agentBudgetService.getBudget(agentId);
      balance = Number(budget!.allocated_budget) - Number(budget!.spent_budget);
      // Balance: 20 - 15 + 30 (auto-refill) = 35
      expect(balance).toBe(35);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("respects 1-hour cooldown", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Allocate initial budget
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 50,
        fromOrgCredits: true,
      });

      // Enable auto-refill
      await agentBudgetService.updateSettings(agentId, {
        autoRefillEnabled: true,
        autoRefillAmount: 20,
        autoRefillThreshold: 25,
      });

      // Spend to trigger refill
      await agentBudgetService.deductBudget({
        agentId,
        amount: 30,
        description: "Reduce balance",
      });

      // First refill should succeed
      const firstRefill = await agentBudgetService.triggerAutoRefill(agentId);
      expect(firstRefill).toBe(true);

      // Spend more to go below threshold again
      await agentBudgetService.deductBudget({
        agentId,
        amount: 25,
        description: "Reduce more",
      });

      // Act - Second refill should be blocked by cooldown
      const secondRefill = await agentBudgetService.triggerAutoRefill(agentId);

      // Assert
      expect(secondRefill).toBe(false);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns false when auto-refill is disabled", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act
      const refilled = await agentBudgetService.triggerAutoRefill(agentId);

      // Assert
      expect(refilled).toBe(false);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // pauseBudget / resumeBudget Tests
  // ===========================================================================

  describe("pauseBudget / resumeBudget", () => {
    test("pauses and resumes budget correctly", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act - Pause
      await agentBudgetService.pauseBudget(agentId, "Manual pause");

      // Assert - Paused
      let budget = await agentBudgetService.getBudget(agentId);
      expect(budget!.is_paused).toBe(true);
      expect(budget!.pause_reason).toBe("Manual pause");
      expect(budget!.paused_at).not.toBeNull();

      // Act - Resume
      await agentBudgetService.resumeBudget(agentId);

      // Assert - Resumed
      budget = await agentBudgetService.getBudget(agentId);
      expect(budget!.is_paused).toBe(false);
      expect(budget!.pause_reason).toBeNull();

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // updateSettings Tests
  // ===========================================================================

  describe("updateSettings", () => {
    test("updates daily limit", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act
      const result = await agentBudgetService.updateSettings(agentId, {
        dailyLimit: 50,
      });

      // Assert
      expect(result.success).toBe(true);
      const budget = await agentBudgetService.getBudget(agentId);
      expect(Number(budget!.daily_limit)).toBe(50);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("enables auto-refill with threshold and amount", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Act
      const result = await agentBudgetService.updateSettings(agentId, {
        autoRefillEnabled: true,
        autoRefillThreshold: 10,
        autoRefillAmount: 25,
      });

      // Assert
      expect(result.success).toBe(true);
      const budget = await agentBudgetService.getBudget(agentId);
      expect(budget!.auto_refill_enabled).toBe(true);
      expect(Number(budget!.auto_refill_threshold)).toBe(10);
      expect(Number(budget!.auto_refill_amount)).toBe(25);

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns error for non-existent budget", async () => {
      // Arrange
      const fakeAgentId = uuidv4();

      // Act
      const result = await agentBudgetService.updateSettings(fakeAgentId, {
        dailyLimit: 100,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe("Budget not found");

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getTransactions Tests
  // ===========================================================================

  describe("getTransactions", () => {
    test("returns transactions ordered by date descending", async () => {
      // Arrange
      const agentId = testData.character!.id;
      await agentBudgetService.getOrCreateBudget(agentId);

      // Create some transactions
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 50,
        fromOrgCredits: true,
      });
      await agentBudgetService.deductBudget({
        agentId,
        amount: 10,
        description: "First deduction",
      });
      await agentBudgetService.deductBudget({
        agentId,
        amount: 5,
        description: "Second deduction",
      });

      // Act
      const transactions = await agentBudgetService.getTransactions(agentId);

      // Assert
      expect(transactions.length).toBeGreaterThanOrEqual(3);
      // Most recent first
      expect(transactions[0].description).toBe("Second deduction");

      // Cleanup
      await cleanupBudget(agentId);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns empty array for agent without budget", async () => {
      // Arrange
      const fakeAgentId = uuidv4();

      // Act
      const transactions = await agentBudgetService.getTransactions(fakeAgentId);

      // Assert
      expect(transactions).toEqual([]);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });
});
