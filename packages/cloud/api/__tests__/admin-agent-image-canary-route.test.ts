/**
 * Exercises the admin canary HTTP trust boundary: strict input, super-admin
 * authorization, server-owned actor identity, zero-trigger preview, and one
 * worker nudge only after a durable execute result.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createAdminAgentImageCanaryRoute } from "../v1/admin/agent-image-canary/route";

type RouteDependencies = NonNullable<
  Parameters<typeof createAdminAgentImageCanaryRoute>[0]
>;

const ACTOR = "33333333-3333-4333-8333-333333333333";
const OTHER_ACTOR = "66666666-6666-4666-8666-666666666666";
const AGENT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ACTOR_ORG = "77777777-7777-4777-8777-777777777777";
const JOB = "44444444-4444-4444-8444-444444444444";
const ROLLOUT = "55555555-5555-4555-8555-555555555555";
const REQUEST = "88888888-8888-4888-8888-888888888888";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const PLAN_FINGERPRINT = `sha256:${"c".repeat(64)}`;
const REQUEST_HASH = `sha256:${"d".repeat(64)}`;
const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`;
const AUTH_USER = {
  id: ACTOR,
  organization_id: ACTOR_ORG,
  organization: { id: ACTOR_ORG, name: "Admin Actor Org", is_active: true },
};

const requireAdmin = mock<RouteDependencies["requireAdmin"]>(async () => ({
  user: AUTH_USER,
  role: "super_admin",
}));
const previewOrEnqueue = mock<
  RouteDependencies["rolloutService"]["previewOrEnqueue"]
>(async () => ({
  dryRun: true,
  operation: "upgrade" as const,
  requestId: REQUEST,
  planFingerprint: PLAN_FINGERPRINT,
  rolloutId: null,
  decisionAt: "2026-07-23T00:00:00.000Z",
  targets: [
    {
      operation: "upgrade" as const,
      agentId: AGENT,
      organizationId: ORG,
      targetOwnerUserId: ACTOR,
      sourceImage: "ghcr.io/elizaos/eliza:sha-production",
      sourceDigest: SOURCE_DIGEST,
      targetImage: TARGET_IMAGE,
      targetDigest: TARGET_DIGEST,
    },
  ],
}));
const recoverRequest = mock<
  RouteDependencies["rolloutService"]["recoverRequest"]
>(async () => ({
  dryRun: false,
  operation: "upgrade" as const,
  requestId: REQUEST,
  planFingerprint: PLAN_FINGERPRINT,
  rolloutId: ROLLOUT,
  decisionAt: "2026-07-23T00:00:00.000Z",
  targets: [
    {
      operation: "upgrade" as const,
      agentId: AGENT,
      organizationId: ORG,
      targetOwnerUserId: ACTOR,
      sourceImage: "ghcr.io/elizaos/eliza:sha-production",
      sourceDigest: SOURCE_DIGEST,
      targetImage: TARGET_IMAGE,
      targetDigest: TARGET_DIGEST,
      jobId: JOB,
      status: "pending",
    },
  ],
}));
const triggerImmediate = mock<
  RouteDependencies["jobService"]["triggerImmediate"]
>(async () => undefined);

type PolledJob = NonNullable<
  Awaited<ReturnType<RouteDependencies["jobService"]["getJob"]>>
>;

function canaryJob(overrides: Record<string, unknown> = {}): PolledJob {
  const now = new Date("2026-07-23T00:00:00.000Z");
  return {
    id: JOB,
    type: "agent_admin_canary_image",
    status: "pending",
    data: {
      operation: "upgrade",
      rolloutId: ROLLOUT,
      actorUserId: ACTOR,
      userId: ACTOR,
      decisionAt: now.toISOString(),
      agentId: AGENT,
      organizationId: ORG,
      targetOwnerUserId: OTHER_ACTOR,
      sourceImage: "ghcr.io/elizaos/eliza:sha-production",
      sourceDigest: SOURCE_DIGEST,
      targetImage: TARGET_IMAGE,
      targetDigest: TARGET_DIGEST,
      requestId: REQUEST,
      planFingerprint: PLAN_FINGERPRINT,
      canonicalRequestHash: REQUEST_HASH,
    },
    data_storage: "inline",
    data_key: null,
    result: null,
    result_storage: "inline",
    result_key: null,
    error: null,
    error_storage: "inline",
    error_key: null,
    organization_id: ORG,
    user_id: ACTOR,
    agent_id: AGENT,
    attempts: 0,
    max_attempts: 1,
    scheduled_for: null,
    estimated_completion_at: new Date("2026-07-23T00:03:00.000Z"),
    started_at: null,
    completed_at: null,
    webhook_url: null,
    webhook_status: null,
    webhook_attempts: 0,
    webhook_last_attempt_at: null,
    webhook_error: null,
    parent_job_id: null,
    worker_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as unknown as PolledJob;
}

const getJob = mock<RouteDependencies["jobService"]["getJob"]>(async () =>
  canaryJob(),
);
const route = createAdminAgentImageCanaryRoute({
  requireAdmin,
  rolloutService: { previewOrEnqueue, recoverRequest },
  jobService: { getJob, triggerImmediate },
  logger: {
    info: () => undefined,
    warn: () => undefined,
  },
});

afterEach(() => {
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue({
    user: AUTH_USER,
    role: "super_admin",
  });
  previewOrEnqueue.mockReset();
  previewOrEnqueue.mockResolvedValue({
    dryRun: true,
    operation: "upgrade",
    requestId: REQUEST,
    planFingerprint: PLAN_FINGERPRINT,
    rolloutId: null,
    decisionAt: "2026-07-23T00:00:00.000Z",
    targets: [
      {
        operation: "upgrade",
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: ACTOR,
        sourceImage: "ghcr.io/elizaos/eliza:sha-production",
        sourceDigest: SOURCE_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
      },
    ],
  });
  recoverRequest.mockReset();
  recoverRequest.mockResolvedValue({
    dryRun: false,
    operation: "upgrade",
    requestId: REQUEST,
    planFingerprint: PLAN_FINGERPRINT,
    rolloutId: ROLLOUT,
    decisionAt: "2026-07-23T00:00:00.000Z",
    targets: [
      {
        operation: "upgrade",
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: ACTOR,
        sourceImage: "ghcr.io/elizaos/eliza:sha-production",
        sourceDigest: SOURCE_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
        jobId: JOB,
        status: "pending",
      },
    ],
  });
  triggerImmediate.mockReset();
  triggerImmediate.mockResolvedValue(undefined);
  getJob.mockReset();
  getJob.mockResolvedValue(canaryJob());
});

function request(body: unknown): Request {
  return new Request("http://test.local/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function upgradeBody(extra: Record<string, unknown> = {}) {
  return {
    operation: "upgrade",
    requestId: REQUEST,
    dryRun: true,
    targetImage: TARGET_IMAGE,
    targets: [
      {
        agentId: AGENT,
        organizationId: ORG,
        expectedSourceImage: "ghcr.io/elizaos/eliza:sha-production",
        expectedSourceDigest: SOURCE_DIGEST,
      },
    ],
    ...extra,
  };
}

describe("POST /api/v1/admin/agent-image-canary", () => {
  test("rejects non-super admins before planning", async () => {
    requireAdmin.mockResolvedValue({
      user: AUTH_USER,
      role: "moderator",
    });
    const response = await route.fetch(request(upgradeBody()));
    expect(response.status).toBe(403);
    expect(previewOrEnqueue).not.toHaveBeenCalled();
  });

  test("strict schema rejects caller-supplied actor or rollout identity", async () => {
    const response = await route.fetch(
      request(upgradeBody({ actorUserId: ACTOR, rolloutId: ROLLOUT })),
    );
    expect(response.status).toBe(400);
    expect(previewOrEnqueue).not.toHaveBeenCalled();
    expect(triggerImmediate).not.toHaveBeenCalled();
  });

  test("dry-run passes the authenticated actor and never nudges the worker", async () => {
    const body = upgradeBody();
    const response = await route.fetch(request(body));
    expect(response.status).toBe(200);
    expect(previewOrEnqueue).toHaveBeenCalledWith(body, ACTOR);
    expect(triggerImmediate).not.toHaveBeenCalled();
  });

  test("execute returns per-target polling and nudges only after durable enqueue", async () => {
    previewOrEnqueue.mockResolvedValue({
      dryRun: false,
      operation: "upgrade",
      requestId: REQUEST,
      planFingerprint: PLAN_FINGERPRINT,
      rolloutId: ROLLOUT,
      decisionAt: "2026-07-23T00:00:00.000Z",
      targets: [
        {
          operation: "upgrade",
          agentId: AGENT,
          organizationId: ORG,
          targetOwnerUserId: ACTOR,
          sourceImage: "ghcr.io/elizaos/eliza:sha-production",
          sourceDigest: SOURCE_DIGEST,
          targetImage: TARGET_IMAGE,
          targetDigest: TARGET_DIGEST,
          jobId: JOB,
          status: "pending",
        },
      ],
    });
    const body = {
      ...upgradeBody(),
      dryRun: false,
      expectedPlanFingerprint: PLAN_FINGERPRINT,
    };
    const response = await route.fetch(request(body), {
      CRON_SECRET: "test",
    });
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      data: { rolloutId: string };
      polling: Array<{ jobId: string; endpoint: string }>;
      recovery: { endpoint: string };
    };
    expect(payload.data.rolloutId).toBe(ROLLOUT);
    expect(payload.polling).toEqual([
      expect.objectContaining({
        jobId: JOB,
        endpoint: `/api/v1/admin/agent-image-canary/jobs/${JOB}`,
      }),
    ]);
    expect(payload.recovery.endpoint).toBe(
      `/api/v1/admin/agent-image-canary/requests/${REQUEST}`,
    );
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("requires requestId for preview and the preview fingerprint for execute", async () => {
    const { requestId: _requestId, ...withoutRequestId } = upgradeBody();
    expect((await route.fetch(request(withoutRequestId))).status).toBe(400);
    expect(
      (
        await route.fetch(
          request({
            ...upgradeBody(),
            dryRun: false,
          }),
        )
      ).status,
    ).toBe(400);
    expect(previewOrEnqueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/admin/agent-image-canary/requests/:requestId", () => {
  function recoveryRequest(requestId = REQUEST): Request {
    return new Request(`http://test.local/requests/${requestId}`);
  }

  test("recovers the authenticated actor's durable rollout and polling jobs", async () => {
    const response = await route.fetch(recoveryRequest());
    expect(response.status).toBe(200);
    expect(recoverRequest).toHaveBeenCalledWith(ACTOR, REQUEST);
    const payload = (await response.json()) as {
      data: { requestId: string; rolloutId: string };
      polling: Array<{ jobId: string; shouldContinue: boolean }>;
    };
    expect(payload.data).toMatchObject({
      requestId: REQUEST,
      rolloutId: ROLLOUT,
    });
    expect(payload.polling).toEqual([
      expect.objectContaining({ jobId: JOB, shouldContinue: true }),
    ]);
  });

  test("authenticates before lookup and rejects invalid request IDs", async () => {
    requireAdmin.mockResolvedValue({ user: AUTH_USER, role: "moderator" });
    expect((await route.fetch(recoveryRequest())).status).toBe(403);
    expect(recoverRequest).not.toHaveBeenCalled();

    requireAdmin.mockResolvedValue({ user: AUTH_USER, role: "super_admin" });
    expect((await route.fetch(recoveryRequest("not-a-uuid"))).status).toBe(400);
    expect(recoverRequest).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/admin/agent-image-canary/jobs/:jobId", () => {
  function pollRequest(jobId = JOB): Request {
    return new Request(`http://test.local/jobs/${jobId}`);
  }

  test("the authenticated super-admin can poll their cross-org canary job", async () => {
    const response = await route.fetch(pollRequest());
    expect(response.status).toBe(200);
    expect(getJob).toHaveBeenCalledWith(JOB);
    const payload = (await response.json()) as {
      data: { id: string; status: string };
      polling: { shouldContinue: boolean };
    };
    expect(payload.data).toEqual(
      expect.objectContaining({ id: JOB, status: "pending" }),
    );
    expect(payload.polling.shouldContinue).toBe(true);
  });

  test("a different super-admin receives the same 404 as a missing job", async () => {
    requireAdmin.mockResolvedValue({
      user: { ...AUTH_USER, id: OTHER_ACTOR },
      role: "super_admin",
    });
    const response = await route.fetch(pollRequest());
    expect(response.status).toBe(404);
  });

  test("rejects non-super-admins before the unscoped lookup", async () => {
    requireAdmin.mockResolvedValue({ user: AUTH_USER, role: "moderator" });
    const response = await route.fetch(pollRequest());
    expect(response.status).toBe(403);
    expect(getJob).not.toHaveBeenCalled();
  });

  test("invalid UUIDs fail validation before the unscoped lookup", async () => {
    const response = await route.fetch(pollRequest("not-a-uuid"));
    expect(response.status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });

  test("ordinary jobs are indistinguishable from missing canary jobs", async () => {
    getJob.mockResolvedValue(canaryJob({ type: "agent_upgrade" }));
    const response = await route.fetch(pollRequest());
    expect(response.status).toBe(404);
  });

  test("own-row payload identity corruption fails closed", async () => {
    getJob.mockResolvedValue(
      canaryJob({
        data: {
          ...canaryJob().data,
          organizationId: ACTOR_ORG,
        },
      }),
    );
    const response = await route.fetch(pollRequest());
    expect(response.status).toBe(500);
  });
});
