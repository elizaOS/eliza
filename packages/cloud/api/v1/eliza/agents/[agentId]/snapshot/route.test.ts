/**
 * Route authority for manual agent snapshots. The route reads a tenant-scoped
 * primary snapshot before refusing non-container, pool-owned, or deleting
 * capacity; enqueue/worker claim-time fencing remains separate work.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  type AgentSandboxPoolStatus,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "@/db/schemas/agent-sandboxes";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const FOREIGN_AGENT_ID = "44444444-4444-4444-8444-444444444444";
const DELETION_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

type SnapshotAgent = {
  id: string;
  organization_id: string;
  execution_tier: string;
  status: string;
  pool_status: AgentSandboxPoolStatus | null;
  deleted_at: Date | null;
  deletion_attempt_id: string | null;
};

function snapshotAgent(overrides: Partial<SnapshotAgent> = {}): SnapshotAgent {
  return {
    id: AGENT_ID,
    organization_id: ORG_A,
    execution_tier: "dedicated-lazy",
    status: "running",
    pool_status: null,
    deleted_at: null,
    deletion_attempt_id: null,
    ...overrides,
  };
}

const getAgentForWrite = mock(
  async (): Promise<SnapshotAgent | null> => snapshotAgent(),
);
const enqueueAgentSnapshotOnce = mock(async () => ({
  job: { id: "job-snapshot-1", status: "queued" },
  created: true,
}));
const triggerImmediate = mock(async () => undefined);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: ORG_A },
  }),
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgentForWrite },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentSnapshotOnce,
    triggerImmediate,
  },
}));
mock.module("@/lib/api/errors", () => ({
  errorToResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "error" },
      { status: 500 },
    ),
}));

const { default: snapshotRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/eliza/agents/:agentId/snapshot", snapshotRoute);
  return app;
}

function post(agentId = AGENT_ID) {
  return buildApp().request(
    `/api/v1/eliza/agents/${agentId}/snapshot`,
    { method: "POST" },
    ENV,
  );
}

function expectCors(response: Response) {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-methods")).toBe(
    "POST, OPTIONS",
  );
}

function expectNoSnapshotEffects() {
  expect(enqueueAgentSnapshotOnce).not.toHaveBeenCalled();
  expect(triggerImmediate).not.toHaveBeenCalled();
}

async function expectSnapshotConflict(
  agent: SnapshotAgent,
  expectedError: string,
) {
  getAgentForWrite.mockImplementationOnce(async () => agent);

  const response = await post();
  const body = (await response.json()) as {
    success: boolean;
    error: string;
  };

  expect(response.status).toBe(409);
  expect(body).toEqual({ success: false, error: expectedError });
  expectCors(response);
  expect(getAgentForWrite).toHaveBeenCalledTimes(1);
  expect(getAgentForWrite).toHaveBeenCalledWith(AGENT_ID, ORG_A);
  expectNoSnapshotEffects();
}

describe("POST /api/v1/eliza/agents/:id/snapshot authority", () => {
  beforeEach(() => {
    getAgentForWrite.mockClear();
    enqueueAgentSnapshotOnce.mockClear();
    triggerImmediate.mockClear();
  });

  test("returns a tenant-safe 404 for a missing agent", async () => {
    getAgentForWrite.mockImplementationOnce(async () => null);

    const response = await post();
    const body = (await response.json()) as {
      success: boolean;
      error: string;
    };

    expect(response.status).toBe(404);
    expect(body).toEqual({ success: false, error: "Agent not found" });
    expectCors(response);
    expect(getAgentForWrite).toHaveBeenCalledWith(AGENT_ID, ORG_A);
    expectNoSnapshotEffects();
  });

  test("hides a foreign agent behind the tenant-scoped primary lookup", async () => {
    getAgentForWrite.mockImplementationOnce(async () => null);

    const response = await post(FOREIGN_AGENT_ID);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Agent not found" });
    expectCors(response);
    expect(getAgentForWrite).toHaveBeenCalledWith(FOREIGN_AGENT_ID, ORG_A);
    expectNoSnapshotEffects();
  });

  test("rejects a stopped Shared agent before the status fast refusal", async () => {
    await expectSnapshotConflict(
      snapshotAgent({ execution_tier: "shared", status: "stopped" }),
      "Agent snapshot requires a container-backed execution tier",
    );
  });

  test("gives an unknown tier precedence over every other bad field", async () => {
    await expectSnapshotConflict(
      snapshotAgent({
        execution_tier: "future-container",
        status: "stopped",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      }),
      "Agent snapshot requires a container-backed execution tier",
    );
  });

  test("gives pool ownership precedence over deletion state", async () => {
    await expectSnapshotConflict(
      snapshotAgent({
        execution_tier: "dedicated-lazy",
        status: "stopped",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      }),
      "Agent snapshot cannot target pool-owned capacity",
    );
  });

  test("gives deletion precedence over a deletion attempt", async () => {
    await expectSnapshotConflict(
      snapshotAgent({
        execution_tier: "dedicated-always",
        status: "stopped",
        deleted_at: new Date("2026-08-22T00:00:00.000Z"),
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      }),
      "Agent snapshot cannot target a deleted agent",
    );
  });

  test("rejects an agent with deletion in progress", async () => {
    await expectSnapshotConflict(
      snapshotAgent({
        execution_tier: "custom",
        status: "deletion_pending",
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      }),
      "Agent snapshot cannot start while agent deletion is in progress",
    );
  });

  test("keeps the existing stopped-agent refusal for canonical capacity", async () => {
    getAgentForWrite.mockImplementationOnce(async () =>
      snapshotAgent({
        execution_tier: "dedicated-lazy",
        status: "stopped",
        pool_status: null,
        deleted_at: null,
        deletion_attempt_id: null,
      }),
    );

    const response = await post();
    const body = (await response.json()) as {
      success: boolean;
      error: string;
    };

    expect(response.status).toBe(409);
    expect(body).toEqual({ success: false, error: "Sandbox is not running" });
    expectCors(response);
    expect(getAgentForWrite).toHaveBeenCalledWith(AGENT_ID, ORG_A);
    expectNoSnapshotEffects();
  });

  test.each([...CONTAINER_BACKED_EXECUTION_TIERS])(
    "enqueues a manual snapshot for canonical running %s capacity",
    async (executionTier) => {
      getAgentForWrite.mockImplementationOnce(async () =>
        snapshotAgent({
          execution_tier: executionTier,
          status: "running",
          pool_status: null,
          deleted_at: null,
          deletion_attempt_id: null,
        }),
      );

      const response = await post();
      const body = (await response.json()) as {
        success: boolean;
        created: boolean;
        alreadyInProgress: boolean;
        data: {
          agentId: string;
          action: string;
          jobId: string;
          status: string;
        };
        polling: {
          endpoint: string;
          intervalMs: number;
          expectedDurationMs: number;
        };
      };

      expect(response.status).toBe(202);
      expect(body).toEqual({
        success: true,
        created: true,
        alreadyInProgress: false,
        data: {
          agentId: AGENT_ID,
          action: "snapshot",
          jobId: "job-snapshot-1",
          status: "queued",
        },
        polling: {
          endpoint: "/api/v1/jobs/job-snapshot-1",
          intervalMs: 5_000,
          expectedDurationMs: 45_000,
        },
      });
      expectCors(response);
      expect(getAgentForWrite).toHaveBeenCalledTimes(1);
      expect(getAgentForWrite).toHaveBeenCalledWith(AGENT_ID, ORG_A);
      expect(enqueueAgentSnapshotOnce).toHaveBeenCalledTimes(1);
      expect(enqueueAgentSnapshotOnce).toHaveBeenCalledWith({
        agentId: AGENT_ID,
        organizationId: ORG_A,
        userId: "user-1",
        snapshotType: "manual",
      });
      expect(triggerImmediate).toHaveBeenCalledTimes(1);
      expect(triggerImmediate).toHaveBeenCalledWith(ENV);
    },
  );
});
