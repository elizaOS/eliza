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
const requireUserOrApiKeyWithOrg = mock(async () => ({
  organization_id: "user-org",
}));
const getJob = mock(async () => ({
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
}));
const getJobForOrg = mock(async () => ({
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
}));

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

  test("service-key polling is SCOPED to the service org (M3) — never unscoped", async () => {
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
      data: { id: "job-1" },
    });
    // The route must scope the read to the org the service identity resolves to
    // and must NEVER call the unscoped getJob for a shared service key.
    expect(getJobForOrg).toHaveBeenCalledWith("job-1", "service-org");
    expect(getJob).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("service-key request for another org's job returns 404 with no row leak (M3)", async () => {
    // The job belongs to a different org, so the scoped read finds nothing.
    getJobForOrg.mockResolvedValueOnce(undefined as never);

    const response = await app.fetch(
      new Request("https://api.example.test/api/v1/jobs/other-org-job", {
        method: "GET",
        headers: { "X-Service-Key": "svc" },
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Job not found",
    });
    expect(getJobForOrg).toHaveBeenCalledWith("other-org-job", "service-org");
    expect(getJob).not.toHaveBeenCalled();
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
});
