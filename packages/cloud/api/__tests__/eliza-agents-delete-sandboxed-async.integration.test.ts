/**
 * Exercises the organization-scoped agent lifecycle route through real services and PGlite.
 * Delete cases pin sandbox handoff; authentication is the sole deterministic seam.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import * as realWorkersAuth from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-158020000001";
const ORG_B = "22222222-2222-4222-8222-158020000002";
const USER_A = "aaaaaaaa-1111-4111-8111-158020000001";
const USER_B = "bbbbbbbb-2222-4222-8222-158020000002";
const SANDBOXED_SHARED_AGENT = "cccccccc-1111-4111-8111-158020000001";
const DATABASE_ONLY_SHARED_AGENT = "cccccccc-2222-4222-8222-158020000002";
const PROVISIONING_AGENT = "cccccccc-3333-4333-8333-158020000003";
const FALLBACK_SHARED_AGENT = "cccccccc-4444-4444-8444-158020000004";
const RACING_SHARED_AGENT = "cccccccc-5555-4555-8555-158020000005";
const TRIGGER_FAILURE_AGENT = "cccccccc-6666-4666-8666-158020000006";
const DETAIL_AGENT = "cccccccc-7777-4777-8777-158020000007";
const PROFILE_AGENT = "cccccccc-8888-4888-8888-158020000008";

const acceptedDeleteSchema = z.object({
  success: z.literal(true),
  created: z.boolean(),
  alreadyInProgress: z.boolean(),
  data: z.object({
    jobId: z.string().uuid(),
    agentId: z.string().uuid(),
    status: z.string(),
  }),
});

const immediateDeleteSchema = z.object({
  success: z.literal(true),
  deleted: z.literal(true),
  source: z.literal("shared_runtime"),
  data: z.object({
    agentId: z.string().uuid(),
    status: z.literal("deleted"),
  }),
});

const errorSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

const detailSchema = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.string().uuid(),
    agentName: z.string(),
    status: z.string(),
    executionTier: z.string(),
    walletStatus: z.string(),
    adminDetails: z.null(),
  }),
});

const profileEditSchema = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.string().uuid(),
    agentName: z.string(),
    executionTier: z.string(),
    updatedAt: z.string().datetime(),
  }),
});

const authIdentity = {
  userId: USER_A,
  organizationId: ORG_A,
};
const realWorkersAuthSnapshot = { ...realWorkersAuth };

let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

beforeAll(async () => {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    ...realWorkersAuthSnapshot,
    requireUserOrApiKeyWithOrg: mock(async () => ({
      id: authIdentity.userId,
      email: `${authIdentity.userId}@test.invalid`,
      organization_id: authIdentity.organizationId,
      organization: {
        id: authIdentity.organizationId,
        name: "Delete Route Test",
        is_active: true,
      },
      is_active: true,
      role: "owner",
    })),
  }));

  const { closeDatabaseConnectionsForTests, dbWrite } = await import(
    "@/db/client"
  );
  closeDb = closeDatabaseConnectionsForTests;

  const { TIER_UPGRADE_TEST_TABLES } = await import(
    "@/lib/services/__tests__/tier-upgrade-pglite-schema"
  );
  for (const ddl of TIER_UPGRADE_TEST_TABLES) {
    await dbWrite.execute(ddl);
  }
  await dbWrite.execute(`CREATE TABLE IF NOT EXISTS "shared_runtime_history" (
    "agent_id" text NOT NULL,
    "channel_id" text NOT NULL,
    "messages" jsonb NOT NULL,
    "updated_at" timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY ("agent_id", "channel_id")
  )`);

  const { organizations } = await import("@/db/schemas/organizations");
  const { users } = await import("@/db/schemas/users");
  const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");

  await dbWrite.insert(organizations).values([
    { id: ORG_A, name: "Delete Route Org A", slug: "delete-route-org-a" },
    { id: ORG_B, name: "Delete Route Org B", slug: "delete-route-org-b" },
  ]);
  await dbWrite.insert(users).values([
    {
      id: USER_A,
      email: "delete-route-a@test.invalid",
      organization_id: ORG_A,
      role: "owner",
      steward_user_id: `steward-${USER_A}`,
    },
    {
      id: USER_B,
      email: "delete-route-b@test.invalid",
      organization_id: ORG_B,
      role: "owner",
      steward_user_id: `steward-${USER_B}`,
    },
  ]);
  await dbWrite.insert(agentSandboxes).values([
    {
      id: SANDBOXED_SHARED_AGENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Sandbox-backed shared agent",
      execution_tier: "shared",
      status: "running",
      sandbox_id: "sandbox-15802",
    },
    {
      id: DATABASE_ONLY_SHARED_AGENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Database-only shared agent",
      execution_tier: "shared",
      status: "running",
    },
    {
      id: PROVISIONING_AGENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Provisioning shared agent",
      execution_tier: "shared",
      status: "provisioning",
      sandbox_id: "sandbox-provisioning-15802",
    },
    {
      id: FALLBACK_SHARED_AGENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Fallback shared agent",
      execution_tier: "shared",
      status: "running",
    },
    {
      id: RACING_SHARED_AGENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Racing shared agent",
      execution_tier: "shared",
      status: "running",
    },
    {
      id: TRIGGER_FAILURE_AGENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Trigger failure shared agent",
      execution_tier: "shared",
      status: "running",
      sandbox_id: "sandbox-trigger-failure-15802",
    },
    {
      id: DETAIL_AGENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Detail shared agent",
      execution_tier: "shared",
      status: "running",
      database_status: "ready",
    },
    {
      id: PROFILE_AGENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Profile shared agent",
      agent_config: { existing: "preserved" },
      execution_tier: "shared",
      status: "running",
    },
  ]);

  const agentRoute = (await import("../v1/eliza/agents/[agentId]/route"))
    .default;
  app = new Hono<AppEnv>();
  app.route("/api/v1/eliza/agents/:agentId", agentRoute);
}, 120_000);

beforeEach(() => {
  authIdentity.userId = USER_A;
  authIdentity.organizationId = ORG_A;
});

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
  mock.module("@/lib/auth/workers-hono-auth", () => realWorkersAuthSnapshot);
});

async function deleteRequest(agentId: string): Promise<Response> {
  return app.request(`/api/v1/eliza/agents/${agentId}`, {
    method: "DELETE",
  });
}

async function getRequest(agentId: string): Promise<Response> {
  return app.request(`/api/v1/eliza/agents/${agentId}`);
}

async function patchRequest(
  agentId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/v1/eliza/agents/${agentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteJobsFor(agentId: string) {
  const { dbWrite } = await import("@/db/client");
  const { jobs } = await import("@/db/schemas/jobs");
  return dbWrite
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "agent_delete"), eq(jobs.agent_id, agentId)));
}

async function sandboxStatus(agentId: string): Promise<string | undefined> {
  const { dbWrite } = await import("@/db/client");
  const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
  const [row] = await dbWrite
    .select({ status: agentSandboxes.status })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId))
    .limit(1);
  return row?.status;
}

describe("agent detail and profile boundaries", () => {
  test("returns the persisted shared-agent detail without fabricating admin or wallet state", async () => {
    const response = await getRequest(DETAIL_AGENT);
    expect(response.status).toBe(200);
    const body = detailSchema.parse(await response.json());
    expect(body.data).toMatchObject({
      id: DETAIL_AGENT,
      agentName: "Detail shared agent",
      status: "running",
      executionTier: "shared",
      walletStatus: "none",
      adminDetails: null,
    });
  });

  test("edits profile fields through the real repository while preserving existing config", async () => {
    const response = await patchRequest(PROFILE_AGENT, {
      agentName: "Renamed profile agent",
      agentConfig: { system: "Updated system prompt" },
    });
    expect(response.status).toBe(200);
    const body = profileEditSchema.parse(await response.json());
    expect(body.data).toMatchObject({
      id: PROFILE_AGENT,
      agentName: "Renamed profile agent",
      executionTier: "shared",
    });

    const { elizaSandboxService } = await import(
      "@/lib/services/eliza-sandbox"
    );
    const persisted = await elizaSandboxService.getAgent(PROFILE_AGENT, ORG_A);
    expect(persisted?.agent_name).toBe("Renamed profile agent");
    expect(persisted?.agent_config).toEqual({
      existing: "preserved",
      system: "Updated system prompt",
    });
  });
});

describe("sandbox-backed shared-agent deletion", () => {
  test("enqueues one real delete job without invoking Worker-side sandbox teardown", async () => {
    const { elizaSandboxService } = await import(
      "@/lib/services/eliza-sandbox"
    );
    const deleteAgentSpy = spyOn(elizaSandboxService, "deleteAgent");
    try {
      const response = await deleteRequest(SANDBOXED_SHARED_AGENT);
      expect(response.status).toBe(202);
      const body = acceptedDeleteSchema.parse(await response.json());
      expect(body).toMatchObject({
        created: true,
        alreadyInProgress: false,
        data: {
          agentId: SANDBOXED_SHARED_AGENT,
          status: "pending",
        },
      });
      expect(deleteAgentSpy).not.toHaveBeenCalled();

      const jobs = await deleteJobsFor(SANDBOXED_SHARED_AGENT);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe(body.data.jobId);
      expect(jobs[0]?.status).toBe("pending");
      expect(await sandboxStatus(SANDBOXED_SHARED_AGENT)).toBe(
        "deletion_pending",
      );
    } finally {
      deleteAgentSpy.mockRestore();
    }
  });

  test("repeated DELETE reuses the in-flight job", async () => {
    const response = await deleteRequest(SANDBOXED_SHARED_AGENT);
    expect(response.status).toBe(202);
    const body = acceptedDeleteSchema.parse(await response.json());
    expect(body.created).toBe(false);
    expect(body.alreadyInProgress).toBe(true);
    expect(await deleteJobsFor(SANDBOXED_SHARED_AGENT)).toHaveLength(1);
  });

  test("database-only shared agents retain immediate synchronous deletion", async () => {
    const response = await deleteRequest(DATABASE_ONLY_SHARED_AGENT);
    expect(response.status).toBe(200);
    const body = immediateDeleteSchema.parse(await response.json());
    expect(body.data.agentId).toBe(DATABASE_ONLY_SHARED_AGENT);
    expect(await sandboxStatus(DATABASE_ONLY_SHARED_AGENT)).toBeUndefined();
    expect(await deleteJobsFor(DATABASE_ONLY_SHARED_AGENT)).toHaveLength(0);
  });

  test("a database-only teardown failure remains observable and queues a retry", async () => {
    const { elizaSandboxService } = await import(
      "@/lib/services/eliza-sandbox"
    );
    const { logger } = await import("@/lib/utils/logger");
    const deleteAgentSpy = spyOn(
      elizaSandboxService,
      "deleteAgent",
    ).mockResolvedValueOnce({
      success: false,
      error: "Failed to delete sandbox",
    });
    const warnSpy = spyOn(logger, "warn");
    try {
      const response = await deleteRequest(FALLBACK_SHARED_AGENT);
      expect(response.status).toBe(202);
      const body = acceptedDeleteSchema.parse(await response.json());
      expect(body.data.agentId).toBe(FALLBACK_SHARED_AGENT);
      expect(deleteAgentSpy).toHaveBeenCalledWith(FALLBACK_SHARED_AGENT, ORG_A);
      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-api] Shared-runtime agent delete failed synchronously; falling back to async delete job",
        {
          agentId: FALLBACK_SHARED_AGENT,
          orgId: ORG_A,
          error: "Failed to delete sandbox",
        },
      );
      expect(await deleteJobsFor(FALLBACK_SHARED_AGENT)).toHaveLength(1);
      expect(await sandboxStatus(FALLBACK_SHARED_AGENT)).toBe(
        "deletion_pending",
      );
    } finally {
      deleteAgentSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("a concurrent provisioning transition is returned as 409 without a job", async () => {
    const { elizaSandboxService } = await import(
      "@/lib/services/eliza-sandbox"
    );
    const deleteAgentSpy = spyOn(
      elizaSandboxService,
      "deleteAgent",
    ).mockResolvedValueOnce({
      success: false,
      error: "Agent provisioning is in progress",
    });
    try {
      const response = await deleteRequest(RACING_SHARED_AGENT);
      expect(response.status).toBe(409);
      expect(errorSchema.parse(await response.json()).error).toBe(
        "Agent provisioning is in progress",
      );
      expect(await deleteJobsFor(RACING_SHARED_AGENT)).toHaveLength(0);
    } finally {
      deleteAgentSpy.mockRestore();
    }
  });

  test("an eager worker-wake rejection is logged while the durable job stays accepted", async () => {
    const { provisioningJobService } = await import(
      "@/lib/services/provisioning-jobs"
    );
    const { logger } = await import("@/lib/utils/logger");
    const triggerError = new Error("control plane wake unavailable");
    const triggerSpy = spyOn(
      provisioningJobService,
      "triggerImmediate",
    ).mockRejectedValueOnce(triggerError);
    const warnSpy = spyOn(logger, "warn");
    try {
      const response = await deleteRequest(TRIGGER_FAILURE_AGENT);
      expect(response.status).toBe(202);
      acceptedDeleteSchema.parse(await response.json());
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-api] Immediate delete worker trigger rejected",
        {
          agentId: TRIGGER_FAILURE_AGENT,
          orgId: ORG_A,
          error: triggerError,
        },
      );
      expect(await deleteJobsFor(TRIGGER_FAILURE_AGENT)).toHaveLength(1);
      expect(await sandboxStatus(TRIGGER_FAILURE_AGENT)).toBe(
        "deletion_pending",
      );
    } finally {
      triggerSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("tenant and provisioning guards run before enqueue", async () => {
    authIdentity.userId = USER_B;
    authIdentity.organizationId = ORG_B;
    const foreignResponse = await deleteRequest(PROVISIONING_AGENT);
    expect(foreignResponse.status).toBe(404);
    expect(errorSchema.parse(await foreignResponse.json()).error).toBe(
      "Agent not found",
    );

    authIdentity.userId = USER_A;
    authIdentity.organizationId = ORG_A;
    const provisioningResponse = await deleteRequest(PROVISIONING_AGENT);
    expect(provisioningResponse.status).toBe(409);
    expect(errorSchema.parse(await provisioningResponse.json()).error).toBe(
      "Agent provisioning is in progress",
    );
    expect(await deleteJobsFor(PROVISIONING_AGENT)).toHaveLength(0);
  });
});
