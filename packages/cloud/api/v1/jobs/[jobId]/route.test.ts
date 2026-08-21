// Exercises cloud API v1 jobs jobid route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const validateServiceKey = mock(
  async (): Promise<{ organizationId: string; userId: string } | null> => ({
    organizationId: "service-org",
    userId: "service-user",
  }),
);
const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const requireUserOrApiKeyWithOrg = mock(
  async (): Promise<{
    organization_id: string;
    role?: string;
  }> => ({
    organization_id: "user-org",
  }),
);
type JobFixture = {
  id: string;
  type: string;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  estimated_completion_at: Date | null;
  scheduled_for: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const getJob = mock(
  async (): Promise<JobFixture> => ({
    id: "job-1",
    type: "agent_logs",
    status: "completed",
    result: { logs: "ok" },
    error: null,
    attempts: 1,
    max_attempts: 2,
    estimated_completion_at: null,
    scheduled_for: null,
    started_at: null,
    completed_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:01Z"),
  }),
);
const getJobForOrg = mock(
  async (): Promise<JobFixture> => ({
    id: "job-1",
    type: "agent_logs",
    status: "pending",
    result: null,
    error: null,
    attempts: 0,
    max_attempts: 2,
    estimated_completion_at: null,
    scheduled_for: null,
    started_at: null,
    completed_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:01Z"),
  }),
);

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
  validateServiceKey,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    getJob,
    getJobForOrg,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { default: jobsRoute } = await import("./route");

describe("jobs route", () => {
  const app = new Hono();
  app.route("/api/v1/jobs/:jobId", jobsRoute);

  beforeEach(() => {
    validateServiceKey.mockClear();
    requireServiceKey.mockClear();
    validateServiceKey.mockResolvedValue({
      organizationId: "service-org",
      userId: "service-user",
    });
    requireUserOrApiKeyWithOrg.mockClear();
    getJob.mockClear();
    getJob.mockResolvedValue({
      id: "job-1",
      type: "agent_logs",
      status: "completed",
      result: { logs: "ok" },
      error: null,
      attempts: 1,
      max_attempts: 2,
      estimated_completion_at: null,
      scheduled_for: null,
      started_at: null,
      completed_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:01Z"),
    });
    getJobForOrg.mockClear();
    getJobForOrg.mockResolvedValue({
      id: "job-1",
      type: "agent_logs",
      status: "pending",
      result: null,
      error: null,
      attempts: 0,
      max_attempts: 2,
      estimated_completion_at: null,
      scheduled_for: null,
      started_at: null,
      completed_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:01Z"),
    });
  });

  test("a stored stack never reaches the owner's response (#23117)", async () => {
    // The stored value is the operator diagnostic — full frames. The API must
    // hand back the failure summary only: frames disclose absolute server
    // paths and internal module layout to a non-admin org member.
    const storedDiagnostic = [
      "Error: agent_delete failed",
      "    at deleteAgent (/srv/eliza/packages/cloud/shared/src/lib/services/eliza-sandbox.ts:2703:11)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "caused by: Error: ENOENT: no such file",
    ].join("\n");
    getJobForOrg.mockResolvedValue({
      id: "job-1",
      type: "agent_delete",
      status: "failed",
      result: null,
      error: storedDiagnostic,
      attempts: 2,
      max_attempts: 2,
      estimated_completion_at: null,
      scheduled_for: null,
      started_at: null,
      completed_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:01Z"),
    });

    validateServiceKey.mockResolvedValueOnce(null);

    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/jobs/job-1", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { error: string | null } };
    expect(body.data.error).toBe("Error: agent_delete failed");
    expect(body.data.error).not.toContain(" at ");
    expect(body.data.error).not.toContain("/srv/eliza");
    expect(body.data.error).not.toContain(".ts:");
  });

  test("service-key polling can read owner-org jobs by id", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/jobs/job-1", {
        method: "GET",
        headers: { "X-Service-Key": "svc" },
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        id: "job-1",
        status: "completed",
        result: { logs: "ok" },
      },
      polling: { shouldContinue: false },
    });
    expect(getJob).toHaveBeenCalledWith("job-1");
    expect(getJobForOrg).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("user/API-key polling stays scoped to the caller organization", async () => {
    validateServiceKey.mockResolvedValueOnce(null);

    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/jobs/job-1", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        id: "job-1",
        status: "pending",
      },
      polling: {
        shouldContinue: true,
        intervalMs: 5000,
      },
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalled();
    expect(getJobForOrg).toHaveBeenCalledWith("job-1", "user-org");
    expect(getJob).not.toHaveBeenCalled();
  });

  test("target-organization members cannot read admin canary jobs through the generic route", async () => {
    validateServiceKey.mockResolvedValueOnce(null);
    getJobForOrg.mockResolvedValueOnce({
      ...(await getJobForOrg()),
      type: "agent_admin_canary_image",
      status: "completed",
      result: { audit: "operator-only" },
    });

    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/jobs/job-1", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Job not found",
    });
    expect(getJobForOrg).toHaveBeenCalledWith("job-1", "user-org");
  });

  test("a different super-admin must use the actor-bound canary endpoint", async () => {
    validateServiceKey.mockResolvedValueOnce(null);
    requireUserOrApiKeyWithOrg.mockResolvedValueOnce({
      organization_id: "user-org",
      role: "super_admin",
    });
    getJobForOrg.mockResolvedValueOnce({
      ...(await getJobForOrg()),
      type: "agent_admin_canary_image",
      status: "completed",
      result: { actorUserId: "different-operator" },
    });

    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/jobs/job-1", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Job not found",
    });
  });

  test("trusted service-key orchestration may still read admin canary jobs", async () => {
    getJob.mockResolvedValueOnce({
      ...(await getJob()),
      type: "agent_admin_canary_image",
      result: { audit: "service-visible" },
    });

    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/jobs/job-1", {
        method: "GET",
        headers: { "X-Service-Key": "svc" },
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        type: "agent_admin_canary_image",
        result: { audit: "service-visible" },
      },
    });
  });
});
