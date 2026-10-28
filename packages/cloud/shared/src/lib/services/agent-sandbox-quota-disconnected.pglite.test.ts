/**
 * A `disconnected` sandbox keeps its container and its node slot (its bridge
 * stopped answering; nothing tears it down), so it must count toward the
 * organization's sandbox ceiling like the other live states. Real PGlite:
 * the billing snapshot fixture seeds a Plus organization whose ceiling is 5.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const PLUS_ORG = "61000000-0000-4000-8000-000000000001";
const PLUS_SUB = "62000000-0000-4000-8000-000000000001";
const PLUS_SANDBOX_CEILING = 5;

let database: typeof import("../../db/client");
let assertOrgAgentQuota: typeof import("./eliza-sandbox/agent-config").assertOrgAgentQuota;
let AgentQuotaExceededError: typeof import("./eliza-sandbox/agent-config").AgentQuotaExceededError;

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}

async function seedSandbox(status: string): Promise<string> {
  const id = randomUUID();
  await exec(`INSERT INTO agent_sandboxes(id, organization_id, status, execution_tier, node_id, pool_status)
    VALUES ('${id}', '${PLUS_ORG}', '${status}', 'dedicated-always', 'node-1', NULL)`);
  return id;
}

function createIsAdmitted(): Promise<void> {
  return database.dbWrite.transaction((tx) =>
    assertOrgAgentQuota(tx, PLUS_ORG, PLUS_SANDBOX_CEILING),
  );
}

beforeAll(async () => {
  database = await import("../../db/client");
  await createBillingSnapshotFixture(exec, "");
  // Bring the fixture's Plus subscription into a current period and project
  // its entitlement, as the API-key ceiling test does.
  const { subscriptionAuthorityRepository } = await import(
    "../../db/repositories/subscription-authority"
  );
  const { subscriptionEntitlementsRepository } = await import(
    "../../db/repositories/subscription-entitlements"
  );
  const current = await subscriptionAuthorityRepository.findById(PLUS_ORG, PLUS_SUB);
  if (!current) throw new Error("Expected the Plus subscription fixture");
  const {
    id: _id,
    organization_id: _org,
    lifecycle_revision: _revision,
    created_at: _created,
    updated_at: _updated,
    ...values
  } = current;
  const advanced = await subscriptionAuthorityRepository.advance({
    organizationId: PLUS_ORG,
    subscriptionId: PLUS_SUB,
    expectedRevision: 1,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...values,
      current_period_start: new Date(Date.now() - 86_400_000),
      current_period_end: new Date(Date.now() + 86_400_000),
      provider_object_digest: "c".repeat(64),
    },
  });
  await subscriptionEntitlementsRepository.rebuild({
    organizationId: PLUS_ORG,
    sourceSubscriptionId: PLUS_SUB,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: 1,
  });
  ({ assertOrgAgentQuota, AgentQuotaExceededError } = await import("./eliza-sandbox/agent-config"));
}, 120_000);

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

test("a disconnected sandbox still occupies the organization's sandbox ceiling", async () => {
  for (let i = 0; i < PLUS_SANDBOX_CEILING - 1; i++) await seedSandbox("running");
  const disconnected = await seedSandbox("disconnected");

  // Four running plus the disconnected one: the ceiling of five is full.
  await expect(createIsAdmitted()).rejects.toBeInstanceOf(AgentQuotaExceededError);
  // The account limits snapshot reports the same five, so it shows no free slot.
  const { readPrimaryAccountBillingSnapshot } = await import(
    "../../db/repositories/account-billing-snapshot"
  );
  const snapshot = await readPrimaryAccountBillingSnapshot(PLUS_ORG);
  expect(snapshot.sandboxCounts).toMatchObject({ used: "5", reserved: "0" });

  // Once that sandbox is gone for good, the slot is free again.
  await exec(`UPDATE agent_sandboxes SET status = 'error' WHERE id = '${disconnected}'`);
  await expect(createIsAdmitted()).resolves.toBeUndefined();
});
