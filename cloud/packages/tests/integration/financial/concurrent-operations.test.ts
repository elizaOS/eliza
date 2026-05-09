/**
 * Cross-Service Concurrent Operations Tests
 *
 * Tests race conditions BETWEEN different services.
 *
 * Note: Single-service race conditions are tested in unit tests:
 * - credits.service.test.ts (20 concurrent deductions)
 * - agent-budgets.service.test.ts (20 concurrent deductions)
 * - redeemable-earnings.service.test.ts (double redemption)
 *
 * This file focuses on CROSS-SERVICE scenarios only.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { creditsService } from "@/lib/services/credits";
import { organizationsService } from "@/lib/services/organizations";
import { getConnectionString } from "@/tests/infrastructure/local-database";
import { cleanupTestData, createTestDataSet } from "@/tests/infrastructure/test-data-factory";

const STRESS_BATCH_SIZE = 8;
const STRESS_OPERATION_TIMEOUT_MS = 10_000;

type StressOperation = {
  label: string;
  run: () => Promise<unknown>;
};

function deterministicShuffle<T>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, sortKey: (index * 17) % 31 }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ item }) => item);
}

async function settleStressOperation(
  operation: StressOperation,
): Promise<PromiseSettledResult<unknown>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation.run().then(
        (value): PromiseFulfilledResult<unknown> => ({ status: "fulfilled", value }),
        (reason): PromiseRejectedResult => ({ status: "rejected", reason }),
      ),
      new Promise<PromiseRejectedResult>((resolve) => {
        timeout = setTimeout(() => {
          resolve({
            status: "rejected",
            reason: new Error(
              `${operation.label} timed out after ${STRESS_OPERATION_TIMEOUT_MS}ms`,
            ),
          });
        }, STRESS_OPERATION_TIMEOUT_MS);
        (timeout as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runStressOperations(
  operations: StressOperation[],
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];

  for (let index = 0; index < operations.length; index += STRESS_BATCH_SIZE) {
    const batch = operations.slice(index, index + STRESS_BATCH_SIZE);
    results.push(...(await Promise.all(batch.map(settleStressOperation))));
  }

  return results;
}

describe("Cross-Service Concurrent Operations", () => {
  let connectionString: string;

  beforeAll(async () => {
    connectionString = getConnectionString();
  });

  test("concurrent org credit deduction AND budget allocation compete fairly", async () => {
    const testData = await createTestDataSet(connectionString, {
      creditBalance: 50,
      includeCharacter: true,
    });
    const agentId = testData.character!.id;
    const orgId = testData.organization.id;

    try {
      await agentBudgetService.getOrCreateBudget(agentId);

      // Race: direct credit deduction vs budget allocation
      // Both want $40 from $50 available
      const [directDeduct, budgetAllocation] = await Promise.allSettled([
        creditsService.reserveAndDeductCredits({
          organizationId: orgId,
          amount: 40,
          description: "Direct deduction",
        }),
        agentBudgetService.allocateBudget({
          agentId,
          amount: 40,
          fromOrgCredits: true,
          description: "Budget allocation",
        }),
      ]);

      const directSuccess = directDeduct.status === "fulfilled" && directDeduct.value.success;
      const allocSuccess =
        budgetAllocation.status === "fulfilled" && budgetAllocation.value.success;

      // At most one can succeed with full $40
      // (both could partially succeed if one gets less)
      const finalOrg = await organizationsService.getById(orgId);
      expect(Number(finalOrg!.credit_balance)).toBeGreaterThanOrEqual(0);

      expect(directSuccess || allocSuccess).toBe(true);
    } finally {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  });

  test("multiple agents competing for same org credits", async () => {
    // Create two agents in different orgs but we'll test with one org
    const testData1 = await createTestDataSet(connectionString, {
      creditBalance: 100,
      includeCharacter: true,
    });
    const testData2 = await createTestDataSet(connectionString, {
      creditBalance: 100,
      includeCharacter: true,
    });

    const agent1Id = testData1.character!.id;
    const agent2Id = testData2.character!.id;
    const _orgId = testData1.organization.id;

    try {
      // Setup both agents with budgets linked to org1
      await agentBudgetService.getOrCreateBudget(agent1Id);

      // Note: agent2 is in a different org, so this tests
      // concurrent allocations from DIFFERENT orgs (no conflict expected)
      await agentBudgetService.getOrCreateBudget(agent2Id);

      // Concurrent allocations from their respective orgs
      const [alloc1, alloc2] = await Promise.allSettled([
        agentBudgetService.allocateBudget({
          agentId: agent1Id,
          amount: 60,
          fromOrgCredits: true,
        }),
        agentBudgetService.allocateBudget({
          agentId: agent2Id,
          amount: 60,
          fromOrgCredits: true,
        }),
      ]);

      // Both should succeed (different orgs)
      expect(alloc1.status === "fulfilled" && alloc1.value.success).toBe(true);
      expect(alloc2.status === "fulfilled" && alloc2.value.success).toBe(true);

      // Verify no negative balances
      const org1 = await organizationsService.getById(testData1.organization.id);
      const org2 = await organizationsService.getById(testData2.organization.id);
      expect(Number(org1!.credit_balance)).toBeGreaterThanOrEqual(0);
      expect(Number(org2!.credit_balance)).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanupTestData(connectionString, testData1.organization.id);
      await cleanupTestData(connectionString, testData2.organization.id);
    }
  });

  test("stress: 30 mixed cross-service operations maintain invariants", async () => {
    const testData = await createTestDataSet(connectionString, {
      creditBalance: 2000,
      includeCharacter: true,
    });
    const agentId = testData.character!.id;
    const orgId = testData.organization.id;

    try {
      await agentBudgetService.getOrCreateBudget(agentId);
      await agentBudgetService.allocateBudget({
        agentId,
        amount: 200,
        fromOrgCredits: true,
      });

      // Mix of operations that touch BOTH credits AND budgets
      const operations: StressOperation[] = [
        // Direct credit operations
        // Note: source field intentionally omitted - addCredits API no longer requires it
        ...Array.from({ length: 5 }, (_, index) => ({
          label: `credit add ${index + 1}`,
          run: () =>
            creditsService.addCredits({
              organizationId: orgId,
              amount: 10,
              description: "Stress add",
            }),
        })),
        ...Array.from({ length: 10 }, (_, index) => ({
          label: `credit deduct ${index + 1}`,
          run: () =>
            creditsService.reserveAndDeductCredits({
              organizationId: orgId,
              amount: 5,
              description: "Stress deduct",
            }),
        })),
        // Budget operations
        ...Array.from({ length: 10 }, (_, index) => ({
          label: `budget deduct ${index + 1}`,
          run: () =>
            agentBudgetService.deductBudget({
              agentId,
              amount: 5,
              description: "Budget deduct",
            }),
        })),
        // Cross-service: allocations (touches both org credits AND budget)
        ...Array.from({ length: 5 }, (_, index) => ({
          label: `budget allocation ${index + 1}`,
          run: () =>
            agentBudgetService.allocateBudget({
              agentId,
              amount: 10,
              fromOrgCredits: true,
              description: "Cross-service allocation",
            }),
        })),
      ];

      // Keep concurrent overlap without saturating the local PGlite TCP pool in CI.
      const shuffled = deterministicShuffle(operations);
      const results = await runStressOperations(shuffled);
      const timedOut = results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          result.reason.message.includes("timed out after"),
      );
      expect(timedOut.length).toBe(0);

      // Verify invariants
      const finalOrg = await organizationsService.getById(orgId);
      const finalBudget = await agentBudgetService.getOrCreateBudget(agentId);

      // Invariant 1: Org balance >= 0
      expect(Number(finalOrg!.credit_balance)).toBeGreaterThanOrEqual(0);

      // Invariant 2: Budget spent <= allocated
      expect(Number(finalBudget!.spent_budget)).toBeLessThanOrEqual(
        Number(finalBudget!.allocated_budget),
      );

      // Invariant 3: Available budget >= 0
      const available = Number(finalBudget!.allocated_budget) - Number(finalBudget!.spent_budget);
      expect(available).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  }, 30000);
});
