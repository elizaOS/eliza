/** Proves active billing excludes pool capacity while retaining claimed Dedicated resources. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { containers } from "../../db/schemas/containers";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { organizations } from "../../db/schemas/organizations";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";

const { activeBillingService } = await import("./active-billing");

const PGLITE_TIMEOUT = 60_000;
let organizationId = "";
let userId = "";

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

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedAgent(
  options: {
    executionTier?: string;
    poolStatus?: "unclaimed" | null;
    deletedAt?: Date | null;
    deletionAttemptId?: string | null;
    deletionStartedAt?: Date | null;
  } = {},
): Promise<string> {
  const {
    executionTier = "dedicated-always",
    poolStatus = null,
    deletedAt = null,
    deletionAttemptId = null,
    deletionStartedAt = null,
  } = options;
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organizationId,
      user_id: userId,
      agent_name: poolStatus === null ? `${executionTier}-agent` : "sentinel-capacity",
      status: "running",
      execution_tier: executionTier as never,
      pool_status: poolStatus,
      deleted_at: deletedAt,
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: deletionStartedAt,
      billing_status: "active",
      last_billed_at: new Date("2026-08-20T00:00:00.000Z"),
      node_id: "node-1",
      container_name: `agent-${crypto.randomUUID()}`,
    })
    .returning();
  return row.id;
}

describe("active billing warm-pool authority", () => {
  test("lists the claimed Dedicated resource but never its pool-owned sibling", async () => {
    const poolId = await seedAgent({ poolStatus: "unclaimed" });
    const claimedId = await seedAgent();

    const ids = (await activeBillingService.listActiveResources(organizationId)).map(
      (resource) => resource.resourceId,
    );
    expect(ids).toContain(claimedId);
    expect(ids).not.toContain(poolId);
  });

  test("lists every canonical container-backed tier", async () => {
    const seeded = await Promise.all(
      CONTAINER_BACKED_EXECUTION_TIERS.map((executionTier) => seedAgent({ executionTier })),
    );

    const ids = (await activeBillingService.listActiveResources(organizationId)).map(
      (resource) => resource.resourceId,
    );
    for (const id of seeded) expect(ids).toContain(id);
  });

  test("excludes shared and unknown execution tiers", async () => {
    const sharedId = await seedAgent({ executionTier: "shared" });
    const unknownId = await seedAgent({ executionTier: "future-container-tier" });

    const ids = (await activeBillingService.listActiveResources(organizationId)).map(
      (resource) => resource.resourceId,
    );
    expect(ids).not.toContain(sharedId);
    expect(ids).not.toContain(unknownId);
  });

  test("excludes soft-deleted and deletion-owned rows", async () => {
    const deletedId = await seedAgent({ deletedAt: new Date("2026-08-22T10:00:00.000Z") });
    const deletionOwnedId = await seedAgent({
      deletionAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletionStartedAt: new Date("2026-08-22T10:00:00.000Z"),
    });

    const ids = (await activeBillingService.listActiveResources(organizationId)).map(
      (resource) => resource.resourceId,
    );
    expect(ids).not.toContain(deletedId);
    expect(ids).not.toContain(deletionOwnedId);
  });
});
