/**
 * DELETE /api/v1/eliza/agents/:agentId sandbox branching against a real
 * database (#15802). A shared agent without a sandbox_id keeps the fast
 * synchronous Worker-side delete; a shared agent WITH a sandbox_id has
 * container-era state whose teardown cannot run in workerd, so the route must
 * skip the doomed synchronous attempt and go straight to the idempotent
 * agent_delete job. Real route module + real sandbox/provisioning services +
 * real repositories against in-process PGlite; the only mocked seam is
 * `requireUserOrApiKeyWithOrg` (same pattern as eliza-agents-restore-body-guard).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.TEST_DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import * as realWorkersAuth from "@/lib/auth/workers-hono-auth";
import { PROVISIONING_JOB_TEST_TABLES } from "@/lib/services/__tests__/tier-upgrade-pglite-schema";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SHARED_PLAIN = "cccccccc-1111-4111-8111-111111111111";
const SHARED_SANDBOXED = "cccccccc-2222-4222-8222-222222222222";
const SHARED_PROVISIONING = "cccccccc-3333-4333-8333-333333333333";
const MISSING = "dddddddd-9999-4999-8999-999999999999";

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realWorkersAuth,
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: USER_A,
    email: "owner@test.test",
    organization_id: ORG_A,
    organization: { id: ORG_A, name: "Org A", is_active: true },
    is_active: true,
    role: "owner",
  })),
}));

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];
const PGLITE_TIMEOUT = 90_000;

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let dbWrite: typeof import("@/db/client").dbWrite;
let agentSandboxes: typeof import("@/db/schemas/agent-sandboxes").agentSandboxes;
let jobs: typeof import("@/db/schemas/jobs").jobs;
let app: Hono<AppEnv>;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const dbClient = await import("@/db/client");
    dbWrite = dbClient.dbWrite;
    closeDb = dbClient.closeDatabaseConnectionsForTests;
    ({ agentSandboxes } = await import("@/db/schemas/agent-sandboxes"));
    ({ jobs } = await import("@/db/schemas/jobs"));
    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");

    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      await dbWrite.execute(ddl);
    }
    // deleteAgent purges shared-runtime history after a committed row delete;
    // the table must exist even when the agent under test has none.
    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS "shared_runtime_history" (
      "agent_id" text NOT NULL,
      "channel_id" text NOT NULL,
      "messages" jsonb NOT NULL,
      "updated_at" timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY ("agent_id", "channel_id")
    )`);

    await dbWrite.insert(organizations).values({
      id: ORG_A,
      name: "Org A",
      slug: "org-a-delete-branch",
      credit_balance: "5.000000",
    });
    await dbWrite.insert(users).values({
      id: USER_A,
      email: "owner@test.test",
      organization_id: ORG_A,
      role: "owner",
      steward_user_id: `steward-${USER_A}`,
    });
    await dbWrite.insert(agentSandboxes).values([
      {
        id: SHARED_PLAIN,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Shared Plain",
        execution_tier: "shared",
        status: "running",
        sandbox_id: null,
      },
      {
        id: SHARED_SANDBOXED,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Shared Sandboxed",
        execution_tier: "shared",
        status: "error",
        sandbox_id: "sandbox-shared-2222",
      },
      {
        id: SHARED_PROVISIONING,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Shared Provisioning",
        execution_tier: "shared",
        status: "provisioning",
        sandbox_id: null,
      },
    ]);

    const agentRoute = (await import("../v1/eliza/agents/[agentId]/route"))
      .default;
    app = new Hono<AppEnv>();
    app.route("/api/v1/eliza/agents/:agentId", agentRoute);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[eliza-agents-delete-sandbox-branch.test] setup failed — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

async function deleteAgentRequest(agentId: string): Promise<Response> {
  return await app.request(
    `/api/v1/eliza/agents/${agentId}`,
    { method: "DELETE" },
    ENV,
  );
}

describe("DELETE /agents/:agentId sandbox branching (PGlite)", () => {
  test("returns 404 for an unknown agent", async () => {
    expect(pgliteReady).toBe(true);
    const response = await deleteAgentRequest(MISSING);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Agent not found",
    });
  });

  test("returns 409 while the agent is still provisioning", async () => {
    expect(pgliteReady).toBe(true);
    const response = await deleteAgentRequest(SHARED_PROVISIONING);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Agent provisioning is in progress",
    });
    const rows = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, SHARED_PROVISIONING));
    expect(rows).toHaveLength(0);
  });

  test("deletes a sandbox-less shared agent synchronously without enqueueing a job", async () => {
    expect(pgliteReady).toBe(true);
    const response = await deleteAgentRequest(SHARED_PLAIN);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      deleted: true,
      source: "shared_runtime",
      data: { agentId: SHARED_PLAIN, status: "deleted" },
    });
    const remaining = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, SHARED_PLAIN));
    expect(remaining).toHaveLength(0);
    const deleteJobs = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, SHARED_PLAIN));
    expect(deleteJobs).toHaveLength(0);
  });

  test("routes a sandbox-backed shared delete to the async job and repeats idempotently", async () => {
    expect(pgliteReady).toBe(true);
    const first = await deleteAgentRequest(SHARED_SANDBOXED);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      success: boolean;
      created: boolean;
      alreadyInProgress: boolean;
      data: { jobId: string; agentId: string };
    };
    expect(firstBody.success).toBe(true);
    expect(firstBody.created).toBe(true);
    expect(firstBody.alreadyInProgress).toBe(false);
    expect(firstBody.data.agentId).toBe(SHARED_SANDBOXED);

    // No synchronous teardown happened: the row survives, stamped for the
    // provisioning worker instead of half-deleted by a workerd-side attempt.
    const [row] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, SHARED_SANDBOXED));
    expect(row).toBeDefined();
    expect(row?.status).toBe("deletion_pending");
    expect(row?.sandbox_id).toBe("sandbox-shared-2222");

    const jobRows = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, SHARED_SANDBOXED));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.type).toBe("agent_delete");
    expect(jobRows[0]?.id).toBe(firstBody.data.jobId);

    const second = await deleteAgentRequest(SHARED_SANDBOXED);
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as {
      success: boolean;
      created: boolean;
      alreadyInProgress: boolean;
      data: { jobId: string };
    };
    expect(secondBody.success).toBe(true);
    expect(secondBody.created).toBe(false);
    expect(secondBody.alreadyInProgress).toBe(true);
    expect(secondBody.data.jobId).toBe(firstBody.data.jobId);

    const jobRowsAfter = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, SHARED_SANDBOXED));
    expect(jobRowsAfter).toHaveLength(1);
  });
});
