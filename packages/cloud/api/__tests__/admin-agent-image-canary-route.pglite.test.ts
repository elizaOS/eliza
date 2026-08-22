/**
 * Drives the real admin-canary Hono boundary and rollout services against
 * PGlite, leaving only authenticated actor selection and worker nudging stubbed.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "@/db/client";
import { pushSchema } from "@/db/push-schema-for-tests";
import { agentNodeIncarnationHistories } from "@/db/schemas/agent-node-incarnation-histories";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { apiKeys } from "@/db/schemas/api-keys";
import { dockerNodes } from "@/db/schemas/docker-nodes";
import { generations } from "@/db/schemas/generations";
import { jobs } from "@/db/schemas/jobs";
import { organizations } from "@/db/schemas/organizations";
import { usageRecords } from "@/db/schemas/usage-records";
import { userCharacters } from "@/db/schemas/user-characters";
import { users } from "@/db/schemas/users";
import { adminAgentImageRolloutService } from "@/lib/services/admin-agent-image-rollout";
import { JOB_TYPES } from "@/lib/services/provisioning-job-types";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import type { AppEnv } from "@/types/cloud-worker-env";
import { createAdminAgentImageCanaryRoute } from "../v1/admin/agent-image-canary/route";

type RouteDependencies = NonNullable<
  Parameters<typeof createAdminAgentImageCanaryRoute>[0]
>;

const PGLITE_TIMEOUT = 90_000;
const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`;
const NEXT_DIGEST = `sha256:${"c".repeat(64)}`;
let pgliteReady = true;
let currentActorId = "";
let currentActorOrganizationId = "";
let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

function requestId(index: number): string {
  return `8abc0000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const requireAdmin = (async () => ({
  user: {
    id: currentActorId,
    organization_id: currentActorOrganizationId,
    organization: {
      id: currentActorOrganizationId,
      name: "Canary Admin",
      is_active: true,
    },
  },
  role: "super_admin" as const,
})) as RouteDependencies["requireAdmin"];

const route = createAdminAgentImageCanaryRoute({
  requireAdmin,
  rolloutService: adminAgentImageRolloutService,
  jobService: {
    getJob: (jobId) => provisioningJobService.getJob(jobId),
    triggerImmediate: async () => undefined,
  },
  logger: {
    info: () => undefined,
    warn: () => undefined,
  },
});
const api = new Hono<AppEnv>();
api.route("/api/v1/admin/agent-image-canary", route);
const ENV = {} as AppEnv["Bindings"];

async function seedActorsAndAgents(count: number) {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Admin Canary HTTP", slug: unique("canary-http") })
    .returning();
  const [actor] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: unique("canary-http-actor"),
      organization_id: organization.id,
    })
    .returning();
  const [otherActor] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: unique("canary-http-other"),
      organization_id: organization.id,
    })
    .returning();
  if (!organization || !actor || !otherActor) {
    throw new Error("Failed to seed admin canary HTTP actors");
  }

  const targets = [];
  for (let index = 1; index <= count; index += 1) {
    const agentId = `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: organization.id,
      user_id: actor.id,
      agent_name: `HTTP Canary ${index}`,
      status: "running",
      sandbox_id: `http-sandbox-${index}`,
      node_id: `http-node-${index}`,
      container_name: `http-agent-${index}`,
      docker_image: SOURCE_IMAGE,
      image_digest: SOURCE_DIGEST,
    });
    targets.push({
      agentId,
      organizationId: organization.id,
      expectedSourceImage: SOURCE_IMAGE,
      expectedSourceDigest: SOURCE_DIGEST,
    });
  }
  currentActorId = actor.id;
  currentActorOrganizationId = organization.id;
  return { actor, otherActor, organization, targets };
}

async function post(body: unknown): Promise<Response> {
  return await api.request(
    "/api/v1/admin/agent-image-canary",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

async function recover(id: string): Promise<Response> {
  return await api.request(
    `/api/v1/admin/agent-image-canary/requests/${id}`,
    {},
    ENV,
  );
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        apiKeys,
        usageRecords,
        generations,
        agentNodeIncarnationHistories,
        dockerNodes,
        agentSandboxes,
        jobs,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("admin canary HTTP idempotency and recovery on PGlite", () => {
  test("GET recovers a lost execute response before re-preview and stays actor-bound", async () => {
    const seeded = await seedActorsAndAgents(2);
    const id = requestId(1);
    const previewBody = {
      operation: "upgrade" as const,
      requestId: id,
      dryRun: true as const,
      targetImage: TARGET_IMAGE,
      targets: seeded.targets,
    };
    const previewResponse = await post(previewBody);
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      data: { planFingerprint: string };
    };
    const executeBody = {
      ...previewBody,
      dryRun: false as const,
      expectedPlanFingerprint: preview.data.planFingerprint,
    };

    const lostResponse = await post(executeBody);
    expect(lostResponse.status).toBe(202);
    const executed = (await lostResponse.json()) as {
      data: {
        rolloutId: string;
        targets: Array<{ jobId: string; status: string }>;
      };
    };
    const durableBeforeUppercaseAlias = await dbWrite
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    expect(
      (
        await post({
          ...executeBody,
          requestId: id.toUpperCase(),
        })
      ).status,
    ).toBe(400);
    expect((await recover(id.toUpperCase())).status).toBe(400);
    expect(
      await dbWrite
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE)),
    ).toEqual(durableBeforeUppercaseAlias);

    await dbWrite
      .update(agentSandboxes)
      .set({ image_digest: NEXT_DIGEST })
      .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));

    const recoveredResponse = await recover(id);
    expect(recoveredResponse.status).toBe(200);
    const recovered = (await recoveredResponse.json()) as typeof executed;
    expect(recovered.data).toEqual(executed.data);
    expect((await post(executeBody)).status).toBe(202);
    expect((await post(previewBody)).status).toBe(409);
    expect(
      (
        await post({
          ...executeBody,
          expectedPlanFingerprint: `sha256:${"f".repeat(64)}`,
        })
      ).status,
    ).toBe(409);

    currentActorId = seeded.otherActor.id;
    expect((await recover(id)).status).toBe(404);
  });

  test("concurrent same-key POSTs create one rollout and one job set", async () => {
    const seeded = await seedActorsAndAgents(2);
    const id = requestId(2);
    const previewBody = {
      operation: "upgrade" as const,
      requestId: id,
      dryRun: true as const,
      targetImage: TARGET_IMAGE,
      targets: [...seeded.targets].reverse(),
    };
    const previewResponse = await post(previewBody);
    const preview = (await previewResponse.json()) as {
      data: { planFingerprint: string };
    };
    const executeBody = {
      ...previewBody,
      dryRun: false as const,
      expectedPlanFingerprint: preview.data.planFingerprint,
    };

    const [left, right] = await Promise.all([
      post(executeBody),
      post({ ...executeBody, targets: seeded.targets }),
    ]);
    expect(left.status).toBe(202);
    expect(right.status).toBe(202);
    const [leftBody, rightBody] = (await Promise.all([
      left.json(),
      right.json(),
    ])) as Array<{
      data: { rolloutId: string; targets: Array<{ jobId: string }> };
    }>;
    expect(rightBody.data).toEqual(leftBody.data);

    const persisted = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    expect(persisted).toHaveLength(2);
    expect(new Set(persisted.map((job) => job.data.rolloutId))).toEqual(
      new Set([leftBody.data.rolloutId]),
    );
  });

  test("ordinary jobs and other request IDs remain indistinguishable from missing", async () => {
    const seeded = await seedActorsAndAgents(1);
    const id = requestId(3);
    await dbWrite.insert(jobs).values({
      type: JOB_TYPES.AGENT_UPGRADE,
      status: "pending",
      organization_id: seeded.organization.id,
      user_id: seeded.actor.id,
      agent_id: seeded.targets[0]!.agentId,
      data_storage: "inline",
      data: {
        requestId: id,
        agentId: seeded.targets[0]!.agentId,
        organizationId: seeded.organization.id,
        userId: seeded.actor.id,
      },
      max_attempts: 1,
    });
    expect((await recover(id)).status).toBe(404);
    expect((await recover(requestId(4))).status).toBe(404);
  });
});
