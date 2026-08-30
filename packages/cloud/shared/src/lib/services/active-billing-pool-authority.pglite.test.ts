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
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import {
  type AgentBillingStatus,
  type AgentSandboxStatus,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { containerComputeStopIntents } from "../../db/schemas/compute-stop-intents";
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
let enqueueSuspendMutation: (() => Promise<void>) | null = null;
let enqueueSuspendFailure: Error | null = null;
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
  await dbWrite.execute(
    sql.raw(`CREATE TABLE container_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      container_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      "authorization" text NOT NULL DEFAULT 'billing_request',
      status text NOT NULL DEFAULT 'pending',
      job_id uuid,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      provider_started_at timestamptz,
      provider_confirmed_at timestamptz,
      provider_node_id text,
      slot_released_at timestamptz,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
  );
  await dbWrite.execute(
    sql.raw(`CREATE TABLE agent_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      "authorization" text NOT NULL DEFAULT 'billing_request',
      status text NOT NULL DEFAULT 'pending',
      job_id uuid,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      provider_started_at timestamptz,
      provider_confirmed_at timestamptz,
      retained_backup_billing boolean NOT NULL DEFAULT false,
      retained_backup_rate_per_hour numeric(18, 6),
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
  );
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  enqueueSuspendCalls = 0;
  enqueueDeleteCalls = 0;
  triggerImmediateCalls = 0;
  enqueueSuspendMutation = null;
  enqueueSuspendFailure = null;
  restoredSpies = [
    spyOn(provisioningJobService, "enqueueAgentSuspendOnce").mockImplementation(async () => {
      enqueueSuspendCalls += 1;
      await enqueueSuspendMutation?.();
      if (enqueueSuspendFailure) throw enqueueSuspendFailure;
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
  await dbWrite.delete(containerComputeStopIntents);
  await dbWrite.delete(agentComputeStopIntents);
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

async function seedAgent(
  options: {
    id?: string;
    lifecycleRevision?: number;
    executionTier?: string;
    poolStatus?: "unclaimed" | null;
    deletedAt?: Date | null;
    deletionAttemptId?: string | null;
    deletionStartedAt?: Date | null;
    status?: AgentSandboxStatus;
    billingStatus?: AgentBillingStatus;
    lastBackupAt?: Date | null;
  } = {},
): Promise<string> {
  const {
    id,
    lifecycleRevision = 0,
    executionTier = "dedicated-always",
    poolStatus = null,
    deletedAt = null,
    deletionAttemptId = null,
    deletionStartedAt = null,
    status = "running",
    billingStatus = "active",
    lastBackupAt = null,
  } = options;
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      ...(id ? { id } : {}),
      organization_id: organizationId,
      user_id: userId,
      agent_name: poolStatus === null ? `${executionTier}-agent` : "sentinel-capacity",
      status,
      execution_tier: executionTier as never,
      pool_status: poolStatus,
      deleted_at: deletedAt,
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: deletionStartedAt,
      billing_status: billingStatus,
      lifecycle_revision: lifecycleRevision,
      last_backup_at: lastBackupAt,
      last_billed_at: new Date("2026-08-20T00:00:00.000Z"),
      node_id: "node-1",
      container_name: `agent-${crypto.randomUUID()}`,
    })
    .returning();
  return row.id;
}

async function seedContainer(
  options: {
    id?: string;
    lifecycleRevision?: number;
    status?: string;
    billingStatus?: string;
  } = {},
): Promise<string> {
  const [row] = await dbWrite
    .insert(containers)
    .values({
      ...(options.id ? { id: options.id } : {}),
      organization_id: organizationId,
      user_id: userId,
      name: `container-${crypto.randomUUID()}`,
      project_name: `project-${crypto.randomUUID()}`,
      status: options.status ?? "running",
      billing_status: options.billingStatus ?? "active",
      lifecycle_revision: options.lifecycleRevision ?? 0,
    })
    .returning();
  return row.id;
}

async function seedDedicated(poolStatus: "unclaimed" | null): Promise<string> {
  return seedAgent({ poolStatus });
}

async function expectSuspendAuthorityConflict(
  agentId: string,
  mutateAuthority: () => Promise<void>,
): Promise<void> {
  enqueueSuspendMutation = mutateAuthority;

  await expect(
    activeBillingService.cancelResource({
      organizationId,
      resourceId: agentId,
      resourceType: "agent_sandbox",
      authorizeInfrastructureMutation: async () => undefined,
    }),
  ).rejects.toMatchObject({ status: 409, code: "session_not_ready" });

  expect(enqueueSuspendCalls).toBe(1);
  expect(triggerImmediateCalls).toBe(1);
  const [stored] = await dbWrite
    .select({ billing_status: agentSandboxes.billing_status })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  expect(stored.billing_status).toBe("active");
  expect(
    (await activeBillingService.listActiveResources(organizationId)).map(
      (resource) => resource.resourceId,
    ),
  ).not.toContain(agentId);
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
        authorizeInfrastructureMutation: async () => undefined,
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
        authorizeInfrastructureMutation: async () => undefined,
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

  test("all canonical container-backed tiers remain listed and cancellable", async () => {
    const seeded = await Promise.all(
      CONTAINER_BACKED_EXECUTION_TIERS.map(async (executionTier) => ({
        executionTier,
        id: await seedAgent({ executionTier }),
      })),
    );

    const listedIds = (await activeBillingService.listActiveResources(organizationId)).map(
      (resource) => resource.resourceId,
    );
    for (const { id } of seeded) expect(listedIds).toContain(id);

    for (const { id } of seeded) {
      await expect(
        activeBillingService.cancelResource({
          organizationId,
          resourceId: id,
          resourceType: "agent_sandbox",
          authorizeInfrastructureMutation: async () => undefined,
        }),
      ).resolves.toMatchObject({ stoppedBilling: true });
    }
    expect(enqueueSuspendCalls).toBe(CONTAINER_BACKED_EXECUTION_TIERS.length);
    expect(triggerImmediateCalls).toBe(CONTAINER_BACKED_EXECUTION_TIERS.length);

    for (const { id } of seeded) {
      const [stored] = await dbWrite
        .select({ billing_status: agentSandboxes.billing_status })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, id));
      expect(stored.billing_status).toBe("suspended");
    }
  });

  test("shared and unknown execution tiers are neither listed nor cancellable", async () => {
    const sharedId = await seedAgent({ executionTier: "shared" });
    const unknownId = await seedAgent({ executionTier: "future-container-tier" });

    const listedIds = (await activeBillingService.listActiveResources(organizationId)).map(
      (resource) => resource.resourceId,
    );
    expect(listedIds).not.toContain(sharedId);
    expect(listedIds).not.toContain(unknownId);

    for (const resourceId of [sharedId, unknownId]) {
      await expect(
        activeBillingService.cancelResource({
          organizationId,
          resourceId,
          resourceType: "agent_sandbox",
          authorizeInfrastructureMutation: async () => undefined,
        }),
      ).rejects.toThrow("Billable resource not found");
    }
    expect(enqueueSuspendCalls).toBe(0);
    expect(triggerImmediateCalls).toBe(0);
    for (const resourceId of [sharedId, unknownId]) {
      const [stored] = await dbWrite
        .select({ billing_status: agentSandboxes.billing_status })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, resourceId));
      expect(stored.billing_status).toBe("active");
    }
  });

  test("soft-deleted and deletion-owned rows are neither listed nor cancellable", async () => {
    const deletedId = await seedAgent({ deletedAt: new Date("2026-08-22T10:00:00.000Z") });
    const deletionOwnedId = await seedAgent({
      deletionAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletionStartedAt: new Date("2026-08-22T10:00:00.000Z"),
    });

    const listedIds = (await activeBillingService.listActiveResources(organizationId)).map(
      (resource) => resource.resourceId,
    );
    expect(listedIds).not.toContain(deletedId);
    expect(listedIds).not.toContain(deletionOwnedId);

    for (const resourceId of [deletedId, deletionOwnedId]) {
      await expect(
        activeBillingService.cancelResource({
          organizationId,
          resourceId,
          resourceType: "agent_sandbox",
          authorizeInfrastructureMutation: async () => undefined,
        }),
      ).rejects.toThrow("Billable resource not found");
    }
    expect(enqueueSuspendCalls).toBe(0);
    expect(triggerImmediateCalls).toBe(0);
    for (const resourceId of [deletedId, deletionOwnedId]) {
      const [stored] = await dbWrite
        .select({ billing_status: agentSandboxes.billing_status })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, resourceId));
      expect(stored.billing_status).toBe("active");
    }
  });

  test("a concurrent transition to Shared wins over billing suspension", async () => {
    const agentId = await seedDedicated(null);

    await expectSuspendAuthorityConflict(agentId, async () => {
      await dbWrite
        .update(agentSandboxes)
        .set({ execution_tier: "shared" })
        .where(eq(agentSandboxes.id, agentId));
    });
  });

  test("a concurrent transition back to pool authority wins over billing suspension", async () => {
    const agentId = await seedDedicated(null);

    await expectSuspendAuthorityConflict(agentId, async () => {
      await dbWrite
        .update(agentSandboxes)
        .set({ pool_status: "unclaimed" })
        .where(eq(agentSandboxes.id, agentId));
    });
  });

  test("a concurrent deletion attempt wins over billing suspension", async () => {
    const agentId = await seedDedicated(null);

    await expectSuspendAuthorityConflict(agentId, async () => {
      await dbWrite
        .update(agentSandboxes)
        .set({
          deletion_attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          deletion_started_at: new Date("2026-08-22T10:00:00.000Z"),
        })
        .where(eq(agentSandboxes.id, agentId));
    });
  });

  test("a concurrent soft deletion wins over billing suspension", async () => {
    const agentId = await seedDedicated(null);

    await expectSuspendAuthorityConflict(agentId, async () => {
      await dbWrite
        .update(agentSandboxes)
        .set({ deleted_at: new Date("2026-08-22T10:00:00.000Z") })
        .where(eq(agentSandboxes.id, agentId));
    });
  });

  test("a row deleted concurrently retains the explicit deleted result", async () => {
    const agentId = await seedDedicated(null);
    enqueueSuspendMutation = async () => {
      await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, agentId));
    };

    await expect(
      activeBillingService.cancelResource({
        organizationId,
        resourceId: agentId,
        resourceType: "agent_sandbox",
        authorizeInfrastructureMutation: async () => undefined,
      }),
    ).resolves.toMatchObject({
      stoppedBilling: true,
      message: "Managed agent was deleted while billing cancellation was in progress.",
      resource: { resourceId: agentId, status: "deleted", billingStatus: "suspended" },
    });
    expect(enqueueSuspendCalls).toBe(1);
    expect(triggerImmediateCalls).toBe(1);
  });

  test("an enqueue failure still suspends billing while authority remains valid", async () => {
    const agentId = await seedDedicated(null);
    enqueueSuspendFailure = new Error("queue unavailable");

    await expect(
      activeBillingService.cancelResource({
        organizationId,
        resourceId: agentId,
        resourceType: "agent_sandbox",
        authorizeInfrastructureMutation: async () => undefined,
      }),
    ).resolves.toMatchObject({
      stoppedBilling: true,
      infrastructureAction: { attempted: true, status: "failed", error: "queue unavailable" },
    });
    expect(enqueueSuspendCalls).toBe(1);
    expect(triggerImmediateCalls).toBe(0);
    const [stored] = await dbWrite
      .select({ billing_status: agentSandboxes.billing_status })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    expect(stored.billing_status).toBe("suspended");
  });

  test("resolves the legacy container target and current lifecycle revision", async () => {
    const containerId = await seedContainer({ lifecycleRevision: 17 });

    await expect(
      activeBillingService.resolveCancellationTarget(organizationId, containerId),
    ).resolves.toEqual({
      resourceType: "container",
      lifecycleRevision: 17,
    });
  });

  test("resolves the requested agent type without probing a sibling table", async () => {
    const agentId = await seedAgent({ lifecycleRevision: 23 });

    await expect(
      activeBillingService.resolveCancellationTarget(organizationId, agentId, "agent_sandbox"),
    ).resolves.toEqual({
      resourceType: "agent_sandbox",
      lifecycleRevision: 23,
    });
  });

  test("uses the provider-confirmed container generation for lost-ack replay, then rotates after resume", async () => {
    const containerId = await seedContainer({
      lifecycleRevision: 32,
      status: "stopped",
      billingStatus: "suspended",
    });
    await dbWrite.insert(containerComputeStopIntents).values({
      organization_id: organizationId,
      container_id: containerId,
      lifecycle_revision: 31,
      authorization: "user_request",
      status: "provider_confirmed",
      provider_confirmed_at: new Date("2026-08-22T09:00:00.000Z"),
      created_at: new Date("2026-08-22T08:00:00.000Z"),
    });

    await expect(
      activeBillingService.resolveCancellationTarget(organizationId, containerId),
    ).resolves.toEqual({
      resourceType: "container",
      lifecycleRevision: 31,
    });

    await dbWrite
      .update(containers)
      .set({ status: "running", billing_status: "active", lifecycle_revision: 33 })
      .where(eq(containers.id, containerId));
    await expect(
      activeBillingService.resolveCancellationTarget(organizationId, containerId),
    ).resolves.toEqual({
      resourceType: "container",
      lifecycleRevision: 33,
    });
  });

  test("uses the provider-confirmed agent generation for lost-ack replay, then rotates after resume", async () => {
    const agentId = await seedAgent({
      lifecycleRevision: 38,
      status: "stopped",
      billingStatus: "suspended",
      lastBackupAt: new Date("2026-08-22T10:00:00.000Z"),
    });
    await dbWrite.insert(agentComputeStopIntents).values({
      organization_id: organizationId,
      agent_id: agentId,
      lifecycle_revision: 37,
      authorization: "user_request",
      status: "provider_confirmed",
      provider_confirmed_at: new Date("2026-08-22T09:00:00.000Z"),
      created_at: new Date("2026-08-22T08:00:00.000Z"),
    });

    await expect(
      activeBillingService.resolveCancellationTarget(organizationId, agentId, "agent_sandbox"),
    ).resolves.toEqual({
      resourceType: "agent_sandbox",
      lifecycleRevision: 37,
    });

    await dbWrite
      .update(agentSandboxes)
      .set({ status: "running", billing_status: "active", lifecycle_revision: 39 })
      .where(eq(agentSandboxes.id, agentId));
    await expect(
      activeBillingService.resolveCancellationTarget(organizationId, agentId, "agent_sandbox"),
    ).resolves.toEqual({
      resourceType: "agent_sandbox",
      lifecycleRevision: 39,
    });
  });

  test("ignores unproved, stale, and cross-tenant cancellation intents", async () => {
    const containerId = await seedContainer({
      lifecycleRevision: 43,
      status: "stopped",
      billingStatus: "suspended",
    });
    await dbWrite.insert(containerComputeStopIntents).values([
      {
        organization_id: organizationId,
        container_id: containerId,
        lifecycle_revision: 42,
        authorization: "user_request",
        status: "provider_confirmed",
        provider_confirmed_at: null,
        created_at: new Date("2026-08-22T10:00:00.000Z"),
      },
      {
        organization_id: organizationId,
        container_id: containerId,
        lifecycle_revision: 40,
        authorization: "user_request",
        status: "provider_confirmed",
        provider_confirmed_at: new Date("2026-08-22T09:00:00.000Z"),
        created_at: new Date("2026-08-22T09:00:00.000Z"),
      },
      {
        organization_id: crypto.randomUUID(),
        container_id: containerId,
        lifecycle_revision: 42,
        authorization: "user_request",
        status: "provider_confirmed",
        provider_confirmed_at: new Date("2026-08-22T11:00:00.000Z"),
        created_at: new Date("2026-08-22T11:00:00.000Z"),
      },
    ]);

    await expect(
      activeBillingService.resolveCancellationTarget(organizationId, containerId),
    ).resolves.toEqual({
      resourceType: "container",
      lifecycleRevision: 43,
    });
  });

  test("fails closed when an omitted resource type is ambiguous", async () => {
    const sharedId = crypto.randomUUID();
    await seedContainer({ id: sharedId, lifecycleRevision: 3 });
    await seedAgent({ id: sharedId, lifecycleRevision: 9 });

    await expect(
      activeBillingService.resolveCancellationTarget(organizationId, sharedId),
    ).rejects.toMatchObject({
      status: 409,
      code: "billing_state_conflict",
    });
  });
});
