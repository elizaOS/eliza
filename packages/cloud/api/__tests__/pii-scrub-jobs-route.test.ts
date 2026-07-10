// Exercises cloud API PII scrub job routes (#14808 CLOUD lane) with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as piiScrubJobsActual from "@/lib/services/pii-scrub-jobs";
import { createPiiScrubCronRoute } from "../cron/process-pii-scrub-jobs/route";
import { createPiiScrubJobRoute } from "../v1/pii-scrub/jobs/[id]/route";
import { createPiiScrubJobsRoute } from "../v1/pii-scrub/jobs/route";

const ORG = "00000000-0000-4000-8000-0000000014aa";
const USER = "00000000-0000-4000-8000-0000000014bb";
const JOB_ID = "00000000-0000-4000-8000-0000000014cc";
const CRON_SECRET = "test-cron-secret";

const requireUserOrApiKeyWithOrg = mock();
const enqueuePiiScrubBatch = mock();
const getPiiScrubJobForOrg = mock();
const processPendingPiiScrubJobs = mock();
const bypassRateLimit = () => async (_c: unknown, next: () => Promise<void>) =>
  next();

const jobsRoute = createPiiScrubJobsRoute({
  requireUserOrApiKeyWithOrg,
  rateLimit: bypassRateLimit,
  enqueuePiiScrubBatch,
});
const jobRoute = createPiiScrubJobRoute({
  requireUserOrApiKeyWithOrg,
  rateLimit: bypassRateLimit,
  getPiiScrubJobForOrg,
});
const jobRouteWithParam = new Hono().route("/:id", jobRoute);
const cronRoute = createPiiScrubCronRoute({ processPendingPiiScrubJobs });

function jobRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    type: piiScrubJobsActual.PII_SCRUB_JOB_TYPE,
    status: "pending",
    data: {},
    data_storage: "inline",
    data_key: null,
    agent_id: null,
    character_id: null,
    result: null,
    result_storage: "inline",
    result_key: null,
    error: null,
    error_storage: "inline",
    error_key: null,
    attempts: 0,
    max_attempts: 3,
    organization_id: ORG,
    user_id: USER,
    api_key_id: null,
    generation_id: null,
    webhook_url: null,
    webhook_status: null,
    estimated_completion_at: null,
    scheduled_for: new Date("2026-07-09T00:00:00Z"),
    started_at: null,
    completed_at: null,
    created_at: new Date("2026-07-09T00:00:00Z"),
    updated_at: new Date("2026-07-09T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  enqueuePiiScrubBatch.mockReset();
  getPiiScrubJobForOrg.mockReset();
  processPendingPiiScrubJobs.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async () => ({
    id: USER,
    organization_id: ORG,
    organization: { id: ORG, name: "Org", is_active: true },
    is_active: true,
  }));
});

describe("POST /api/v1/pii-scrub/jobs", () => {
  test("enqueues under the AUTHENTICATED org and answers 202 with the job DTO", async () => {
    enqueuePiiScrubBatch.mockResolvedValue(jobRecord());

    const res = await jobsRoute.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test",
      },
      body: JSON.stringify({
        rulesetVersion: "2026.07",
        stage: "llm-pass",
        // A body can NEVER choose its org — only the session decides.
        organizationId: "99999999-9999-4999-8999-999999999999",
        items: [{ itemRef: "m-1", content: "note with jane@example.com" }],
      }),
    });

    expect(res.status).toBe(202);
    expect(enqueuePiiScrubBatch).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER,
      rulesetVersion: "2026.07",
      stage: "llm-pass",
      items: [{ itemRef: "m-1", content: "note with jane@example.com" }],
    });
    const body = (await res.json()) as {
      success: boolean;
      job: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.job).toMatchObject({
      id: JOB_ID,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      progress: null,
      error: null,
    });
  });

  test("rejects a structurally-invalid body without touching the service", async () => {
    const res = await jobsRoute.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test",
      },
      body: JSON.stringify({ rulesetVersion: "2026.07", items: [] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(enqueuePiiScrubBatch).not.toHaveBeenCalled();
  });

  test("maps service-level PiiScrubJobDataError to a 400", async () => {
    enqueuePiiScrubBatch.mockRejectedValue(
      new piiScrubJobsActual.PiiScrubJobDataError(
        "duplicate itemRef in batch: m-1",
      ),
    );
    const res = await jobsRoute.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test",
      },
      body: JSON.stringify({
        rulesetVersion: "2026.07",
        items: [
          { itemRef: "m-1", content: "a" },
          { itemRef: "m-1", content: "b" },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/pii-scrub/jobs/:id", () => {
  test("returns the tenant-scoped job with progress", async () => {
    getPiiScrubJobForOrg.mockResolvedValue(
      jobRecord({
        status: "in_progress",
        result: {
          itemsTotal: 4,
          itemsCompleted: 2,
          itemsSkipped: 1,
          itemsFailed: 0,
        },
      }),
    );

    const res = await jobRouteWithParam.request(`/${JOB_ID}`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(res.status).toBe(200);
    expect(getPiiScrubJobForOrg).toHaveBeenCalledWith(JOB_ID, ORG);
    const body = (await res.json()) as { job: Record<string, unknown> };
    expect(body.job).toMatchObject({
      status: "in_progress",
      progress: {
        itemsTotal: 4,
        itemsCompleted: 2,
        itemsSkipped: 1,
        itemsFailed: 0,
      },
    });
  });

  test("another org's job reads as 404 (never leaked)", async () => {
    getPiiScrubJobForOrg.mockResolvedValue(undefined);
    const res = await jobRouteWithParam.request(`/${JOB_ID}`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/cron/process-pii-scrub-jobs", () => {
  test("refuses without the cron secret (real requireCronSecret gate)", async () => {
    const res = await cronRoute.request("/", { method: "POST" }, {
      CRON_SECRET,
    } as never);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(processPendingPiiScrubJobs).not.toHaveBeenCalled();
  });

  test("drains with a tier-0 executor when the secret matches", async () => {
    processPendingPiiScrubJobs.mockResolvedValue({
      claimed: 1,
      succeeded: 1,
      requeued: 0,
      failed: 0,
      recovered: 0,
      errors: [],
    });

    const res = await cronRoute.request(
      "/",
      { method: "POST", headers: { "x-cron-secret": CRON_SECRET } },
      { CRON_SECRET } as never,
    );

    expect(res.status).toBe(200);
    expect(processPendingPiiScrubJobs).toHaveBeenCalledTimes(1);
    const args = processPendingPiiScrubJobs.mock.calls[0][0] as {
      executor: { scrubItem: (input: unknown) => Promise<unknown> };
    };
    expect(typeof args.executor.scrubItem).toBe("function");
    const body = (await res.json()) as {
      success: boolean;
      stats: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.stats).toMatchObject({ claimed: 1, succeeded: 1 });
  });
});
