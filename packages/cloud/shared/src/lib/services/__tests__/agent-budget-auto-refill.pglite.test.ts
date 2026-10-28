/** Auto-refill of an agent budget through the real AgentBudgetService and credit reservation on PGlite: one low-balance event refills once, even when two refills start together. */

import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("agent-budget-auto-refill.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { agentBudgets, agentBudgetTransactions } from "../../../db/schemas/agent-budgets";
import { autoTopUpAttempts } from "../../../db/schemas/auto-top-up-attempts";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let agentBudgetService: typeof import("../agent-budgets").agentBudgetService;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ agentBudgetService } = await import("../agent-budgets"));
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      userCharacters,
      agentBudgets,
      agentBudgetTransactions,
      creditTransactions,
      autoTopUpAttempts,
    } as never,
    dbWrite as never,
  );
  await apply();
}, 120_000);

afterAll(async () => {
  await closeDb();
});

async function lowBudgetAgent(): Promise<{ agentId: string; orgId: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: `Org ${suffix}`, slug: `org-${suffix}`, credit_balance: "100.000000" } as never)
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      email: `owner-${suffix}@example.com`,
      organization_id: org.id,
      steward_user_id: `steward-${suffix}`,
    } as never)
    .returning();
  const [agent] = await dbWrite
    .insert(userCharacters)
    .values({
      name: `Agent ${suffix}`,
      user_id: user.id,
      organization_id: org.id,
      bio: ["Budget test agent"],
      character_data: {},
    } as never)
    .returning();
  const budget = await agentBudgetService.getOrCreateBudget(agent.id);
  if (!budget) throw new Error("budget not created");
  // Threshold $5, refill $20, balance $4: below the threshold, never refilled.
  await dbWrite
    .update(agentBudgets)
    .set({
      allocated_budget: "4.0000",
      auto_refill_enabled: true,
      auto_refill_threshold: "5.0000",
      auto_refill_amount: "20.0000",
    })
    .where(eq(agentBudgets.id, budget.id));
  return { agentId: agent.id, orgId: org.id };
}

async function state(agentId: string, orgId: string) {
  const [budget] = await dbWrite
    .select()
    .from(agentBudgets)
    .where(eq(agentBudgets.agent_id, agentId));
  const [org] = await dbWrite.select().from(organizations).where(eq(organizations.id, orgId));
  return {
    allocated: Number(budget.allocated_budget),
    orgCredits: Number(org.credit_balance),
    refilledAt: budget.last_refill_at,
  };
}

test("two overlapping deduction-triggered refills move the refill amount once", async () => {
  const { agentId, orgId } = await lowBudgetAgent();
  const results = await Promise.all([
    agentBudgetService.triggerAutoRefill(agentId),
    agentBudgetService.triggerAutoRefill(agentId),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const after = await state(agentId, orgId);
  expect(after.allocated).toBe(24);
  expect(after.orgCredits).toBe(80);
  expect(after.refilledAt).not.toBeNull();
}, 60_000);

test("the cron does not refill again after a deduction-triggered refill", async () => {
  const { agentId, orgId } = await lowBudgetAgent();
  await Promise.all([
    agentBudgetService.triggerAutoRefill(agentId),
    agentBudgetService.processAutoRefills(),
  ]);
  const after = await state(agentId, orgId);
  expect(after.allocated).toBe(24);
  expect(after.orgCredits).toBe(80);
}, 60_000);
