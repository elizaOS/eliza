/**
 * DELETE /api/v1/eliza/agents/:agentId — sync-vs-async routing (#15802).
 *
 * The Worker can never SSH (ssh2 is stubbed in workerd), so a shared agent
 * that carries a `sandbox_id` must NOT be deleted synchronously — the sync
 * attempt could only ever fail (#15275). The contract pinned here:
 *   - shared agent WITH a sandbox_id → 202 + real agent_delete job enqueued,
 *     row flipped to deletion_pending, sync deleteAgent never attempted;
 *   - second DELETE while the job is pending is idempotent (202, same job);
 *   - the async path itself (what the provisioning daemon runs) completes and
 *     removes the row;
 *   - shared agent WITHOUT a sandbox_id keeps the immediate sync delete (200,
 *     row gone, no job);
 *   - a genuine sync failure on that sandbox-less path falls back to the
 *     async job (202) with the underlying error preserved in the [agent-api]
 *     warn log — never swallowed behind an opaque 500;
 *   - dedicated agents keep the async 202 contract; provisioning → 409,
 *     unknown id → 404.
 *
 * Real route module + real elizaSandboxService/provisioningJobService against
 * in-process PGlite; the only mocked seam is `requireUserOrApiKeyWithOrg`
 * (same pattern as eliza-agents-restore-body-guard).
 */

import {
  afterAll,
  beforeAll,
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
// The daemon-path assertion runs elizaSandboxService.executeDeletion for real;
// the memory provider treats an unknown sandbox as already-gone, which is the
// same observable outcome as a successful node-side stop.
process.env.ELIZA_TEST_SANDBOX_PROVIDER = "memory";

import { Hono } from "hono";
import * as realWorkersAuth from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-1111-4111-8111-111111111111";
const AGENT_SHARED_SANDBOXED = "cccccccc-1111-4111-8111-111111111111";
const AGENT_SHARED_PLAIN = "cccccccc-2222-4222-8222-222222222222";
const AGENT_SHARED_PLAIN_2 = "cccccccc-3333-4333-8333-333333333333";
const AGENT_DEDICATED = "cccccccc-4444-4444-8444-444444444444";
const AGENT_PROVISIONING = "cccccccc-5555-4555-8555-555555555555";
const AGENT_UNKNOWN = "cccccccc-9999-4999-8999-999999999999";

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realWorkersAuth,
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: USER,
    email: "owner@test.test",
    organization_id: ORG,
    organization: { id: ORG, name: "Org", is_active: true },
    is_active: true,
    role: "owner",
  })),
}));

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

beforeAll(async () => {
  try {
    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;

    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { jobs } = await import("@/db/schemas/jobs");
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { generations } = await import("@/db/schemas/generations");
    const { usageRecords } = await import("@/db/schemas/usage-records");
    const { sharedRuntimeHistory } = await import(
      "@/db/schemas/shared-runtime-history"
    );
    const { pushSchema } = await import("@/db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentSandboxes,
        jobs,
        apiKeys,
        generations,
        usageRecords,
        sharedRuntimeHistory,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite
      .insert(organizations)
      .values([{ id: ORG, name: "Org", slug: "org" }]);
    await dbWrite.insert(users).values([
      {
        id: USER,
        email: "owner@test.test",
        organization_id: ORG,
        role: "owner",
        steward_user_id: `steward-${USER}`,
      },
    ]);

    await dbWrite.insert(agentSandboxes).values([
      // The #15275 shape: shared tier but backed by a real container the
      // Worker cannot tear down.
      {
        id: AGENT_SHARED_SANDBOXED,
        organization_id: ORG,
        user_id: USER,
        agent_name: "Shared with sandbox",
        execution_tier: "shared",
        status: "running",
        sandbox_id: "sandbox-shared-1",
      },
      // Pure Tier-0 shared rows (no container) — sync delete must keep working.
      {
        id: AGENT_SHARED_PLAIN,
        organization_id: ORG,
        user_id: USER,
        agent_name: "Shared plain",
        execution_tier: "shared",
        status: "running",
      },
      {
        id: AGENT_SHARED_PLAIN_2,
        organization_id: ORG,
        user_id: USER,
        agent_name: "Shared plain 2",
        execution_tier: "shared",
        status: "running",
      },
      {
        id: AGENT_DEDICATED,
        organization_id: ORG,
        user_id: USER,
        agent_name: "Dedicated",
        execution_tier: "dedicated-lazy",
        status: "running",
        sandbox_id: "sandbox-dedicated-1",
      },
      {
        id: AGENT_PROVISIONING,
        organization_id: ORG,
        user_id: USER,
        agent_name: "Provisioning",
        execution_tier: "shared",
        status: "provisioning",
      },
    ]);

    const agentRoute = (await import("../v1/eliza/agents/[agentId]/route"))
      .default;
    app = new Hono<AppEnv>();
    app.route("/api/v1/eliza/agents/:agentId", agentRoute);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[eliza-agents-delete-async-fallback.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
});

function del(agentId: string) {
  return app.request(
    `/api/v1/eliza/agents/${agentId}`,
    { method: "DELETE" },
    ENV,
  );
}

async function agentRow(agentId: string) {
  const { dbWrite } = await import("@/db/client");
  const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
  const { eq } = await import("drizzle-orm");
  const rows = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId))
    .limit(1);
  return rows[0];
}

async function deleteJobsFor(agentId: string) {
  const { dbWrite } = await import("@/db/client");
  const { jobs } = await import("@/db/schemas/jobs");
  const { and, eq } = await import("drizzle-orm");
  return dbWrite
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "agent_delete"), eq(jobs.agent_id, agentId)));
}

describe("DELETE /api/v1/eliza/agents/:agentId — async fallback for sandboxed shared agents (#15275)", () => {
  let firstJobId: string;

  test("shared agent WITH sandbox_id enqueues an agent_delete job and returns 202 (no sync attempt)", async () => {
    expect(pgliteReady).toBe(true);
    const { elizaSandboxService } = await import(
      "@/lib/services/eliza-sandbox"
    );
    const deleteSpy = spyOn(elizaSandboxService, "deleteAgent");
    try {
      const res = await del(AGENT_SHARED_SANDBOXED);
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        success: boolean;
        created: boolean;
        alreadyInProgress: boolean;
        data: { jobId: string; agentId: string; status: string };
      };
      expect(body.success).toBe(true);
      expect(body.created).toBe(true);
      expect(body.alreadyInProgress).toBe(false);
      expect(body.data.agentId).toBe(AGENT_SHARED_SANDBOXED);
      firstJobId = body.data.jobId;

      // The Worker never attempted the (impossible) sync teardown.
      expect(deleteSpy).not.toHaveBeenCalled();

      // Real DB effects: one pending agent_delete job, row marked deleting.
      const jobRows = await deleteJobsFor(AGENT_SHARED_SANDBOXED);
      expect(jobRows.length).toBe(1);
      expect(jobRows[0].status).toBe("pending");
      expect(jobRows[0].id).toBe(firstJobId);
      const row = await agentRow(AGENT_SHARED_SANDBOXED);
      expect(row?.status).toBe("deletion_pending");
    } finally {
      deleteSpy.mockRestore();
    }
  });

  test("second DELETE while the job is pending is idempotent (202, same job, no duplicate)", async () => {
    expect(pgliteReady).toBe(true);
    const res = await del(AGENT_SHARED_SANDBOXED);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      success: boolean;
      created: boolean;
      alreadyInProgress: boolean;
      data: { jobId: string };
    };
    expect(body.success).toBe(true);
    expect(body.created).toBe(false);
    expect(body.alreadyInProgress).toBe(true);
    expect(body.data.jobId).toBe(firstJobId);

    const jobRows = await deleteJobsFor(AGENT_SHARED_SANDBOXED);
    expect(jobRows.length).toBe(1);
  });

  test("the async path (daemon executeDeletion) completes the enqueued delete and removes the row", async () => {
    expect(pgliteReady).toBe(true);
    const { elizaSandboxService } = await import(
      "@/lib/services/eliza-sandbox"
    );
    const outcome = await elizaSandboxService.executeDeletion(
      AGENT_SHARED_SANDBOXED,
      ORG,
    );
    expect(outcome.success).toBe(true);
    expect(outcome.containerStopped).toBe(true);
    expect(await agentRow(AGENT_SHARED_SANDBOXED)).toBeUndefined();
  });

  test("shared agent WITHOUT sandbox_id keeps the immediate sync delete (200, row gone, no job)", async () => {
    expect(pgliteReady).toBe(true);
    const res = await del(AGENT_SHARED_PLAIN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      deleted: boolean;
      source: string;
      data: { agentId: string; status: string };
    };
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(true);
    expect(body.source).toBe("shared_runtime");
    expect(body.data.status).toBe("deleted");

    expect(await agentRow(AGENT_SHARED_PLAIN)).toBeUndefined();
    expect((await deleteJobsFor(AGENT_SHARED_PLAIN)).length).toBe(0);
  });

  test("a genuine sandbox-less sync failure falls back to the async job (202) and logs the underlying error", async () => {
    expect(pgliteReady).toBe(true);
    const { elizaSandboxService } = await import(
      "@/lib/services/eliza-sandbox"
    );
    const { logger } = await import("@/lib/utils/logger");
    const underlying =
      "Failed to delete sandbox: ssh2 is not available on Cloudflare Workers — proxy to the Node sidecar (cloud/INFRA.md).";
    const deleteSpy = spyOn(
      elizaSandboxService,
      "deleteAgent",
    ).mockResolvedValueOnce({
      success: false,
      error: underlying,
    });
    const warnSpy = spyOn(logger, "warn");
    try {
      const res = await del(AGENT_SHARED_PLAIN_2);
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        success: boolean;
        created: boolean;
        data: { jobId: string; agentId: string };
      };
      expect(body.success).toBe(true);
      expect(body.created).toBe(true);
      expect(body.data.agentId).toBe(AGENT_SHARED_PLAIN_2);

      // The sandbox-less path still attempts the sync delete, and its
      // underlying error surfaces in the fallback warn — never swallowed
      // behind an opaque 500.
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-api] Shared-runtime agent delete failed synchronously; falling back to async delete job",
        expect.objectContaining({
          agentId: AGENT_SHARED_PLAIN_2,
          orgId: ORG,
          error: underlying,
        }),
      );

      // Real DB effects: the fallback enqueued a genuine agent_delete job and
      // flipped the row so the failure is observable, not a silent success.
      const jobRows = await deleteJobsFor(AGENT_SHARED_PLAIN_2);
      expect(jobRows.length).toBe(1);
      expect(jobRows[0].status).toBe("pending");
      expect((await agentRow(AGENT_SHARED_PLAIN_2))?.status).toBe(
        "deletion_pending",
      );
    } finally {
      deleteSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("dedicated agent keeps the async 202 job contract", async () => {
    expect(pgliteReady).toBe(true);
    const res = await del(AGENT_DEDICATED);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      success: boolean;
      created: boolean;
      data: { jobId: string };
    };
    expect(body.success).toBe(true);
    expect(body.created).toBe(true);

    const jobRows = await deleteJobsFor(AGENT_DEDICATED);
    expect(jobRows.length).toBe(1);
    expect((await agentRow(AGENT_DEDICATED))?.status).toBe("deletion_pending");
  });

  test("provisioning agent → 409; unknown agent → 404", async () => {
    expect(pgliteReady).toBe(true);
    const provisioning = await del(AGENT_PROVISIONING);
    expect(provisioning.status).toBe(409);
    expect(((await provisioning.json()) as { error: string }).error).toBe(
      "Agent provisioning is in progress",
    );

    const missing = await del(AGENT_UNKNOWN);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "Agent not found",
    );
  });
});
