/**
 * Credits-Budget Flow Integration Tests
 *
 * Tests the complete flow from organization credits
 * to agent budget allocation and usage.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { creditsService } from "@/lib/services/credits";
import { organizationsService } from "@/lib/services/organizations";
import { getConnectionString } from "@/tests/infrastructure/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/infrastructure/test-data-factory";

describe("Credits-Budget Flow Integration", () => {
  let connectionString: string;
  let testData: TestDataSet;

  beforeAll(async () => {
    connectionString = getConnectionString();
    testData = await createTestDataSet(connectionString, {
      creditBalance: 500,
      includeCharacter: true,
    });
  });

  afterAll(async () => {
    if (testData?.organization?.id) {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  });

  test("complete flow: org credits → agent budget → usage → refill", async () => {
    const agentId = testData.character!.id;
    const orgId = testData.organization.id;

    // Step 1: Verify initial org credits
    const initialOrg = await organizationsService.getById(orgId);
    expect(Number(initialOrg!.credit_balance)).toBe(500);

    // Step 2: Create agent budget
    const budget = await agentBudgetService.getOrCreateBudget(agentId);
    expect(budget).toBeDefined();
    expect(budget!.owner_org_id).toBe(orgId);

    // Step 3: Allocate budget from org credits
    const allocation = await agentBudgetService.allocateBudget({
      agentId,
      amount: 100,
      fromOrgCredits: true,
      description: "Initial allocation",
    });
    expect(allocation.success).toBe(true);
    expect(allocation.newBalance).toBe(100);

    // Step 4: Check budget allows operations
    const checkResult = await agentBudgetService.checkBudget(agentId, 10);
    expect(checkResult.canProceed).toBe(true);
    expect(checkResult.availableBudget).toBeGreaterThanOrEqual(90);

    // Step 5: Deduct from budget (simulating usage)
    const deduction1 = await agentBudgetService.deductBudget({
      agentId,
      amount: 25,
      description: "API call 1",
    });
    expect(deduction1.success).toBe(true);

    const deduction2 = await agentBudgetService.deductBudget({
      agentId,
      amount: 25,
      description: "API call 2",
    });
    expect(deduction2.success).toBe(true);

    // Step 6: Verify budget decreased
    const updatedBudget = await agentBudgetService.getOrCreateBudget(agentId);
    const remaining = Number(updatedBudget!.allocated_budget) - Number(updatedBudget!.spent_budget);
    expect(remaining).toBe(50); // 100 - 25 - 25

    // Step 7: Allocate more budget
    const secondAllocation = await agentBudgetService.allocateBudget({
      agentId,
      amount: 50,
      fromOrgCredits: true,
      description: "Top-up allocation",
    });
    expect(secondAllocation.success).toBe(true);
    expect(secondAllocation.newBalance).toBe(100); // 50 remaining + 50 new
  });

  test("budget depletion pauses agent and allocation resumes it", async () => {
    const separateTestData = await createTestDataSet(connectionString, {
      creditBalance: 200,
      includeCharacter: true,
    });
    const agentId = separateTestData.character!.id;

    try {
      // Create budget with small amount
      await agentBudgetService.getOrCreateBudget(agentId);
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 10,
        fromOrgCredits: true,
      });

      // Deplete the budget
      await agentBudgetService.deductBudget({
        agentId,
        amount: 10,
        description: "Deplete budget",
      });

      // Check budget - should not allow operations
      const checkAfterDepletion = await agentBudgetService.checkBudget(agentId, 1);
      expect(checkAfterDepletion.canProceed).toBe(false);

      // Allocate more budget
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 20,
        fromOrgCredits: true,
      });

      // Check budget again - should now allow operations
      const checkAfterRefill = await agentBudgetService.checkBudget(agentId, 1);
      expect(checkAfterRefill.canProceed).toBe(true);
    } finally {
      await cleanupTestData(connectionString, separateTestData.organization.id);
    }
  });

  test("insufficient org credits prevents budget allocation", async () => {
    const lowCreditTestData = await createTestDataSet(connectionString, {
      creditBalance: 5,
      includeCharacter: true,
    });
    const agentId = lowCreditTestData.character!.id;

    try {
      await agentBudgetService.getOrCreateBudget(agentId);

      const result = await agentBudgetService.allocateBudget({
        agentId,
        amount: 100,
        fromOrgCredits: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Insufficient organization credits");
    } finally {
      await cleanupTestData(connectionString, lowCreditTestData.organization.id);
    }
  });

  test("adding credits to org enables new allocations", async () => {
    const testDataLow = await createTestDataSet(connectionString, {
      creditBalance: 10,
      includeCharacter: true,
    });
    const agentId = testDataLow.character!.id;
    const orgId = testDataLow.organization.id;

    try {
      await agentBudgetService.getOrCreateBudget(agentId);

      // First allocation should work
      const first = await agentBudgetService.allocateBudget({
        agentId,
        amount: 10,
        fromOrgCredits: true,
      });
      expect(first.success).toBe(true);

      // Second should fail (no more credits)
      const second = await agentBudgetService.allocateBudget({
        agentId,
        amount: 10,
        fromOrgCredits: true,
      });
      expect(second.success).toBe(false);

      // Add credits to org
      await creditsService.addCredits({
        organizationId: orgId,
        amount: 100,
        description: "Manual top-up",
      });

      // Now allocation should work
      const third = await agentBudgetService.allocateBudget({
        agentId,
        amount: 50,
        fromOrgCredits: true,
      });
      expect(third.success).toBe(true);
    } finally {
      await cleanupTestData(connectionString, testDataLow.organization.id);
    }
  });
});
