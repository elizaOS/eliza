/** Proves active billing excludes pool capacity while retaining claimed Dedicated resources. */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { containers } from "../../db/schemas/containers";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { organizations } from "../../db/schemas/organizations";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { provisioningJobService } from "./provisioning-jobs";

const { activeBillingService } = await import("./active-billing");

const PGLITE_TIMEOUT = 60_000;
let organizationId = "";
let userId = "";
let enqueueSuspendCalls = 0;
let enqueueDeleteCalls = 0;
let triggerImmediateCalls = 0;
let restoredSpies: Array<{ mockRestore: () => void }> = [];

beforeAll(async () => {
  const schema = {
    organizations,
    users,
    userCharacters,
    apiKeys,
    agentSandboxes,
    containers,
    creditTransactions,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  enqueueSuspendCalls = 0;
  enqueueDeleteCalls = 0;
  triggerImmediateCalls = 0;
  restoredSpies = [
    spyOn(provisioningJobService, "enqueueAgentSuspendOnce").mockImplementation(async () => {
      enqueueSuspendCalls += 1;
      return { job: { id: crypto.randomUUID() } as never, created: true };
    }),
    spyOn(provisioningJobService, "enqueueAgentDeleteOnce").mockImplementation(async () => {
      enqueueDeleteCalls += 1;
      return { job: { id: crypto.randomUUID() } as never, created: true };
    }),
    spyOn(provisioningJobService, "triggerImmediate").mockImplementation(async () => {
      triggerImmediateCalls += 1;
    }),
  ];
  await dbWrite.delete(creditTransactions);
  await dbWrite.delete(containers);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(apiKeys);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);

  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Active Billing Pool", slug: `pool-${crypto.randomUUID()}` })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: `steward-${crypto.randomUUID()}`, organization_id: org.id })
    .returning();
  organizationId = org.id;
  userId = user.id;
});

afterEach(() => {
  for (const activeSpy of restoredSpies) activeSpy.mockRestore();
  restoredSpies = [];
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedDedicated(poolStatus: "unclaimed" | null): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organizationId,
      user_id: userId,
      agent_name: poolStatus === null ? "claimed-user-agent" : "sentinel-capacity",
      status: "running",
      execution_tier: "dedicated-always",
      pool_status: poolStatus,
      billing_status: "active",
      last_billed_at: new Date("2026-08-20T00:00:00.000Z"),
      node_id: "node-1",
      container_name: `agent-${crypto.randomUUID()}`,
    })
    .returning();
  return row.id;
}

describe("active billing warm-pool authority", () => {
  test("list exposes the claimed Dedicated resource but never its pool-owned sibling", async () => {
    const poolId = await seedDedicated("unclaimed");
    const claimedId = await seedDedicated(null);

    const resources = await activeBillingService.listActiveResources(organizationId);
    const ids = resources.map((resource) => resource.resourceId);
    expect(ids).toContain(claimedId);
    expect(ids).not.toContain(poolId);
  });

  test("pool capacity cannot be cancelled or mutated through the billing surface", async () => {
    const poolId = await seedDedicated("unclaimed");

    await expect(
      activeBillingService.cancelResource({
        organizationId,
        resourceId: poolId,
        resourceType: "agent_sandbox",
      }),
    ).rejects.toThrow("Billable resource not found");
    expect(enqueueSuspendCalls).toBe(0);
    expect(enqueueDeleteCalls).toBe(0);
    expect(triggerImmediateCalls).toBe(0);
    const [stored] = await dbWrite
      .select({ billing_status: agentSandboxes.billing_status })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, poolId));
    expect(stored.billing_status).toBe("active");
  });

  test("a claimed slot remains cancellable and billable once pool_status is null", async () => {
    const claimedId = await seedDedicated(null);

    await expect(
      activeBillingService.cancelResource({
        organizationId,
        resourceId: claimedId,
        resourceType: "agent_sandbox",
      }),
    ).resolves.toMatchObject({ stoppedBilling: true });
    expect(enqueueSuspendCalls).toBe(1);
    expect(triggerImmediateCalls).toBe(1);
    const [stored] = await dbWrite
      .select({ billing_status: agentSandboxes.billing_status })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, claimedId));
    expect(stored.billing_status).toBe("suspended");
  });
});
