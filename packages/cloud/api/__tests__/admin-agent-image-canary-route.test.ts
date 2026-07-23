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
const AGENT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";
const ROLLOUT = "55555555-5555-4555-8555-555555555555";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`;
const AUTH_USER = {
  id: ACTOR,
  organization_id: ORG,
  organization: { id: ORG, name: "Canary Test Org", is_active: true },
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
const triggerImmediate = mock<
  RouteDependencies["jobService"]["triggerImmediate"]
>(async () => undefined);
const route = createAdminAgentImageCanaryRoute({
  requireAdmin,
  rolloutService: { previewOrEnqueue },
  jobService: { triggerImmediate },
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
  triggerImmediate.mockReset();
  triggerImmediate.mockResolvedValue(undefined);
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
    const body = { ...upgradeBody(), dryRun: false };
    const response = await route.fetch(request(body), {
      CRON_SECRET: "test",
    });
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      data: { rolloutId: string };
      polling: Array<{ jobId: string; endpoint: string }>;
    };
    expect(payload.data.rolloutId).toBe(ROLLOUT);
    expect(payload.polling).toEqual([
      expect.objectContaining({
        jobId: JOB,
        endpoint: `/api/v1/jobs/${JOB}`,
      }),
    ]);
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });
});
