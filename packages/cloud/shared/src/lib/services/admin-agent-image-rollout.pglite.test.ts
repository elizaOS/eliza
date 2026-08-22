/**
 * Drives the admin canary planner and atomic enqueue against real PGlite DDL.
 * The suite proves zero-write preview, five-target atomicity, durable rollback
 * derivation, and fleet-reconciler exclusion for the distinct demo repository.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { type Job, jobsRepository } from "../../db/repositories/jobs";
import { agentNodeIncarnationHistories } from "../../db/schemas/agent-node-incarnation-histories";
import {
  type AgentSandboxBackup,
  agentSandboxes,
  WARM_POOL_ORG_ID,
  WARM_POOL_USER_ID,
} from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { generations } from "../../db/schemas/generations";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { usageRecords } from "../../db/schemas/usage-records";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { ApiError } from "../api/cloud-worker-errors";
import { adminAgentImageRolloutService } from "./admin-agent-image-rollout";
import {
  type AdminCanaryImageJobData,
  type AdminCanaryTargetExpectation,
} from "./admin-canary-image";
import { apiKeysService } from "./api-keys";
import { type DockerSandboxMetadata, DockerSandboxProvider } from "./docker-sandbox-provider";
import {
  ElizaSandboxService,
  elizaSandboxService,
  SNAPSHOT_ENDPOINT_UNSUPPORTED,
} from "./eliza-sandbox";
import { JOB_TYPES } from "./provisioning-job-types";
import { provisioningJobService, readAdminCanaryImageJobData } from "./provisioning-jobs";
import type { SandboxCreateConfig, SandboxHandle, SandboxProvider } from "./sandbox-provider-types";

const PGLITE_TIMEOUT = 60_000;
const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`;
const SAME_REPO_TARGET_IMAGE = `ghcr.io/elizaos/eliza@${TARGET_DIGEST}`;
const NEXT_DIGEST = `sha256:${"c".repeat(64)}`;
const REPLACEMENT_ATTEMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPLACEMENT_STARTED_AT = "2026-07-23T12:00:00.000Z";
let pgliteReady = true;
let seq = 0;
let requestSeq = 0;

type ReplacementStageService = {
  persistReplacementCleanupStage(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expected: {
      status: "running" | "provisioning";
      environmentRevision: number;
      sandboxId: string | null;
      nodeId: string | null;
      containerName: string | null;
    },
    stage: "intent" | "created" | "vpn",
  ): Promise<void>;
};

type ReplacementCleanupService = {
  retirePersistedReplacementCleanup(
    agentId: string,
    orgId: string,
    expectation?: undefined,
    onConvergedInTx?: undefined,
    source?: "lifecycle" | "background-reconcile" | "admin-converge",
  ): Promise<"missing" | "clean" | "deferred" | "retired">;
};

function replacementHandle(params: {
  agentId: string;
  nodeId: string;
  containerName: string;
  imageDigest?: string;
  dockerImage?: string;
  containerId?: string;
  vpnNodeId?: string;
  previousVpnNodeId?: string;
  allocationCounted?: boolean;
}): SandboxHandle {
  const metadata: DockerSandboxMetadata = {
    provider: "docker",
    nodeId: params.nodeId,
    hostname: `${params.nodeId}.internal`,
    containerName: params.containerName,
    bridgePort: 21_080,
    webUiPort: 23_950,
    agentId: params.agentId,
    volumePath: `/var/lib/eliza/${params.containerName}`,
    dockerImage: params.dockerImage ?? TARGET_IMAGE,
    imageDigest: params.imageDigest ?? TARGET_DIGEST,
    replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
    allocationCounted: params.allocationCounted ?? true,
    vpnNodeName: `${params.containerName}-vpn`,
    vpnRegistrationStartedAt: REPLACEMENT_STARTED_AT,
    ...(params.containerId ? { containerId: params.containerId } : {}),
    ...(params.vpnNodeId ? { vpnNodeId: params.vpnNodeId } : {}),
    ...(params.previousVpnNodeId ? { previousVpnNodeId: params.previousVpnNodeId } : {}),
  };
  return {
    sandboxId: params.containerName,
    bridgeUrl: `https://${params.containerName}.example`,
    healthUrl: `https://${params.containerName}.example/api`,
    metadata,
  };
}

function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

function nextRequestId(): string {
  requestSeq += 1;
  return `9abc0000-0000-4000-8000-${String(requestSeq).padStart(12, "0")}`;
}

async function expireExecutionLease(jobId: string): Promise<void> {
  await dbWrite
    .update(jobExecutionLeases)
    .set({ expires_at: new Date(0) })
    .where(eq(jobExecutionLeases.job_id, jobId));
}

async function executeUpgradeCanary(params: {
  actorUserId: string;
  targets: AdminCanaryTargetExpectation[];
  targetImage?: string;
  requestId?: string;
}) {
  const requestId = params.requestId ?? nextRequestId();
  const targetImage = params.targetImage ?? TARGET_IMAGE;
  const preview = await adminAgentImageRolloutService.previewOrEnqueue(
    {
      operation: "upgrade",
      requestId,
      dryRun: true,
      targetImage,
      targets: params.targets,
    },
    params.actorUserId,
  );
  return await adminAgentImageRolloutService.previewOrEnqueue(
    {
      operation: "upgrade",
      requestId,
      dryRun: false,
      expectedPlanFingerprint: preview.planFingerprint,
      targetImage,
      targets: params.targets,
    },
    params.actorUserId,
  );
}

async function executeRollbackCanary(params: {
  actorUserId: string;
  source: { rolloutId: string } | { jobId: string };
  requestId?: string;
}) {
  const requestId = params.requestId ?? nextRequestId();
  const preview = await adminAgentImageRolloutService.previewOrEnqueue(
    {
      operation: "rollback",
      requestId,
      dryRun: true,
      source: params.source,
    },
    params.actorUserId,
  );
  return await adminAgentImageRolloutService.previewOrEnqueue(
    {
      operation: "rollback",
      requestId,
      dryRun: false,
      expectedPlanFingerprint: preview.planFingerprint,
      source: params.source,
    },
    params.actorUserId,
  );
}

async function seedAgents(count: number): Promise<{
  actorUserId: string;
  organizationId: string;
  targets: AdminCanaryTargetExpectation[];
}> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Admin Canary Org", slug: uniq("canary-org") })
    .returning();
  const [actor] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("canary-actor"), organization_id: org.id })
    .returning();
  const targets: AdminCanaryTargetExpectation[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    await dbWrite.insert(agentSandboxes).values({
      id,
      organization_id: org.id,
      user_id: actor.id,
      agent_name: `Canary ${index}`,
      status: "running",
      sandbox_id: `sandbox-${index}`,
      node_id: `node-${index}`,
      container_name: `agent-${index}`,
      docker_image: SOURCE_IMAGE,
      image_digest: SOURCE_DIGEST,
    });
    targets.push({
      agentId: id,
      organizationId: org.id,
      expectedSourceImage: SOURCE_IMAGE,
      expectedSourceDigest: SOURCE_DIGEST,
    });
  }
  return { actorUserId: actor.id, organizationId: org.id, targets };
}

async function completeUpgradeJob(job: Job): Promise<void> {
  const data = readAdminCanaryImageJobData(job);
  const startedAt = new Date("2026-07-23T00:00:00.000Z");
  const finishedAt = new Date("2026-07-23T00:01:00.000Z");
  await dbWrite
    .update(jobs)
    .set({
      status: "completed",
      started_at: startedAt,
      completed_at: finishedAt,
      result_storage: "inline",
      result: {
        success: true,
        jobId: job.id,
        operation: "upgrade",
        rolloutId: data.rolloutId,
        actorUserId: data.actorUserId,
        decisionAt: data.decisionAt,
        agentId: data.agentId,
        organizationId: data.organizationId,
        targetOwnerUserId: data.targetOwnerUserId,
        sourceImage: data.sourceImage,
        sourceDigest: data.sourceDigest,
        targetImage: data.targetImage,
        targetDigest: data.targetDigest,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      },
    })
    .where(eq(jobs.id, job.id));
  await dbWrite
    .update(agentSandboxes)
    .set({
      docker_image: data.targetImage,
      image_digest: data.targetDigest,
      previous_docker_image: data.sourceImage,
      previous_image_digest: data.sourceDigest,
    })
    .where(eq(agentSandboxes.id, data.agentId));
}

function pendingCutoverAuditFor(
  job: Job,
  data: AdminCanaryImageJobData,
  params: {
    startedAt: Date;
    cutoverAt: Date;
    oldNodeId?: string;
    oldContainerName?: string;
    newNodeId?: string;
    newContainerName?: string;
  },
) {
  return {
    success: false,
    cleanupPending: true,
    cutoverAt: params.cutoverAt.toISOString(),
    jobId: job.id,
    operation: data.operation,
    rolloutId: data.rolloutId,
    actorUserId: data.actorUserId,
    decisionAt: data.decisionAt,
    agentId: data.agentId,
    organizationId: data.organizationId,
    targetOwnerUserId: data.targetOwnerUserId,
    sourceImage: data.sourceImage,
    sourceDigest: data.sourceDigest,
    targetImage: data.targetImage,
    targetDigest: data.targetDigest,
    startedAt: params.startedAt.toISOString(),
    finishedAt: params.cutoverAt.toISOString(),
    oldNodeId: params.oldNodeId ?? "node-1",
    oldContainerName: params.oldContainerName ?? "agent-1",
    newNodeId: params.newNodeId ?? "node-blue",
    newContainerName: params.newContainerName ?? "agent-blue",
  };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
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
      jobExecutionLeases,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
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

describe("admin agent image rollout on primary PGlite", () => {
  test("stuck reconciliation cannot flip a row owned by an active restart", async () => {
    const seeded = await seedAgents(0);
    const agentId = "00000000-0000-4000-8000-000000000090";
    const oldUpdatedAt = new Date("2026-07-22T00:00:00.000Z");
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: seeded.organizationId,
      user_id: seeded.actorUserId,
      agent_name: "Restart-owned provisioning row",
      status: "provisioning",
      sandbox_id: "restart-owned-sandbox",
      node_id: "restart-owned-node",
      container_name: "restart-owned-container",
      updated_at: oldUpdatedAt,
    });
    await dbWrite.insert(jobs).values({
      type: JOB_TYPES.AGENT_RESTART,
      status: "in_progress",
      organization_id: seeded.organizationId,
      user_id: seeded.actorUserId,
      agent_id: agentId,
      data: {
        agentId,
        organizationId: seeded.organizationId,
        userId: seeded.actorUserId,
      },
    });

    expect(
      await agentSandboxesRepository.listStuckProvisioningWithContainer(
        new Date("2026-07-23T00:00:00.000Z"),
      ),
    ).toEqual([]);
    expect(await agentSandboxesRepository.markRunningFromProvisioning(agentId)).toBeUndefined();
    expect(await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId)).toEqual(
      expect.objectContaining({ status: "provisioning" }),
    );
  });

  test("warm-claim state constraint and recovery indexes exist in generated schema", async () => {
    const seeded = await seedAgents(0);
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxes).values({
          id: "00000000-0000-4000-8000-000000000089",
          organization_id: seeded.organizationId,
          user_id: seeded.actorUserId,
          status: "pending",
          warm_claim_credential_state: "invalid" as never,
        });
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxes).values({
          id: "00000000-0000-4000-8000-000000000088",
          organization_id: seeded.organizationId,
          user_id: seeded.actorUserId,
          status: "pending",
          replacement_cleanup_sandbox_id: "unpaired-cleanup-handle",
        });
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxes).values({
          id: "00000000-0000-4000-8000-000000000087",
          organization_id: seeded.organizationId,
          user_id: seeded.actorUserId,
          status: "pending",
          replacement_cleanup_vpn_node_id: "unpaired-vpn-node",
        });
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxes).values({
          id: "00000000-0000-4000-8000-000000000086",
          organization_id: seeded.organizationId,
          user_id: seeded.actorUserId,
          status: "pending",
          replacement_cleanup_allocation_counted: true,
        });
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxes).values({
          id: "00000000-0000-4000-8000-000000000085",
          organization_id: seeded.organizationId,
          user_id: seeded.actorUserId,
          status: "pending",
          replacement_cleanup_sandbox_id: "candidate",
          replacement_cleanup_node_id: "node-a",
          replacement_cleanup_container_name: "candidate",
          replacement_cleanup_vpn_node_name: "candidate-vpn",
          replacement_cleanup_allocation_counted: false,
          replacement_cleanup_created_at: new Date(),
        });
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxes).values({
          id: "00000000-0000-4000-8000-000000000084",
          organization_id: seeded.organizationId,
          user_id: seeded.actorUserId,
          status: "pending",
          replacement_cleanup_sandbox_id: "candidate-without-attempt",
          replacement_cleanup_node_id: "node-a",
          replacement_cleanup_container_name: "candidate-without-attempt",
          replacement_cleanup_container_id: "sha256:container",
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date(),
        });
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxes).values({
          id: "00000000-0000-4000-8000-000000000083",
          organization_id: seeded.organizationId,
          user_id: seeded.actorUserId,
          status: "pending",
          replacement_cleanup_sandbox_id: "old-primary",
          replacement_cleanup_node_id: "node-a",
          replacement_cleanup_container_name: "old-primary",
          replacement_cleanup_preserved_vpn_node_id: "stale-candidate-identity",
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date(),
        });
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxes).values({
          id: "00000000-0000-4000-8000-000000000080",
          organization_id: seeded.organizationId,
          user_id: seeded.actorUserId,
          status: "pending",
          replacement_cleanup_sandbox_id: "candidate-vpn-id-without-registration",
          replacement_cleanup_node_id: "node-a",
          replacement_cleanup_container_name: "candidate-vpn-id-without-registration",
          replacement_cleanup_attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          replacement_cleanup_vpn_node_id: "orphan-candidate-vpn-id",
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date(),
        });
      })(),
    ).rejects.toThrow();
    await dbWrite.insert(agentSandboxes).values([
      {
        id: "00000000-0000-4000-8000-000000000082",
        organization_id: seeded.organizationId,
        user_id: seeded.actorUserId,
        status: "pending",
        replacement_cleanup_sandbox_id: "owned-candidate",
        replacement_cleanup_node_id: "node-a",
        replacement_cleanup_container_name: "owned-candidate",
        replacement_cleanup_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        replacement_cleanup_allocation_counted: false,
        replacement_cleanup_created_at: new Date(),
      },
      {
        id: "00000000-0000-4000-8000-000000000081",
        organization_id: seeded.organizationId,
        user_id: seeded.actorUserId,
        status: "pending",
        replacement_cleanup_sandbox_id: "owned-old-primary",
        replacement_cleanup_node_id: "node-a",
        replacement_cleanup_container_name: "owned-old-primary",
        replacement_cleanup_vpn_node_id: "exact-old-vpn-id",
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date(),
      },
    ]);

    const constraints = await dbWrite.execute<{ conname: string; definition: string }>(sql`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'public.agent_sandboxes'::regclass
        AND conname IN (
          'agent_sandboxes_warm_claim_credential_state_check',
          'agent_sandboxes_replacement_cleanup_locator_check'
        )
      ORDER BY conname
    `);
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "agent_sandboxes_replacement_cleanup_locator_check",
      "agent_sandboxes_warm_claim_credential_state_check",
    ]);
    const replacementConstraint = constraints.rows.find(
      (row) => row.conname === "agent_sandboxes_replacement_cleanup_locator_check",
    )?.definition;
    expect(replacementConstraint).toContain("replacement_cleanup_attempt_id");
    expect(replacementConstraint).toContain("replacement_cleanup_container_id");
    expect(replacementConstraint).toContain("replacement_cleanup_allocation_counted");

    const indexes = await dbWrite.execute<{ indexname: string }>(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'agent_sandboxes'
        AND indexname IN (
          'agent_sandboxes_warm_claim_pending_idx',
          'agent_sandboxes_warm_claim_cleanup_idx',
          'agent_sandboxes_replacement_cleanup_pending_idx'
        )
      ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "agent_sandboxes_replacement_cleanup_pending_idx",
      "agent_sandboxes_warm_claim_cleanup_idx",
      "agent_sandboxes_warm_claim_pending_idx",
    ]);
  });

  test("replacement intent reserves capacity exactly once and rejects unaccounted fleet placement", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-new",
      hostname: "node-new.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 2,
    });
    const service = new ElizaSandboxService() as unknown as ReplacementStageService;
    const expected = {
      status: "running" as const,
      environmentRevision: 0,
      sandboxId: "sandbox-1",
      nodeId: "node-1",
      containerName: "agent-1",
    };
    const intent = replacementHandle({
      agentId,
      nodeId: "node-new",
      containerName: "agent-new",
      previousVpnNodeId: "vpn-old",
    });

    await service.persistReplacementCleanupStage(
      agentId,
      seeded.organizationId,
      intent,
      expected,
      "intent",
    );
    const afterFirst = await agentSandboxesRepository.findByIdAndOrg(
      agentId,
      seeded.organizationId,
    );
    const firstCreatedAt = afterFirst?.replacement_cleanup_created_at;
    expect(firstCreatedAt).toBeInstanceOf(Date);

    await service.persistReplacementCleanupStage(
      agentId,
      seeded.organizationId,
      intent,
      expected,
      "intent",
    );
    const afterRetry = await agentSandboxesRepository.findByIdAndOrg(
      agentId,
      seeded.organizationId,
    );
    expect(afterRetry).toMatchObject({
      replacement_cleanup_sandbox_id: "agent-new",
      replacement_cleanup_node_id: "node-new",
      replacement_cleanup_container_name: "agent-new",
      replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
      replacement_cleanup_allocation_counted: true,
    });
    expect(afterRetry?.replacement_cleanup_created_at?.getTime()).toBe(firstCreatedAt?.getTime());
    const [newNode] = await dbWrite
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.node_id, "node-new"));
    expect(newNode?.allocated_count).toBe(3);

    const otherAgent = "00000000-0000-4000-8000-000000000079";
    await dbWrite.insert(agentSandboxes).values({
      id: otherAgent,
      organization_id: seeded.organizationId,
      user_id: seeded.actorUserId,
      status: "running",
      sandbox_id: "sandbox-unaccounted",
      node_id: "node-1",
      container_name: "agent-unaccounted",
    });
    const unaccounted = replacementHandle({
      agentId: otherAgent,
      nodeId: "env-fallback-node",
      containerName: "agent-env-fallback",
      allocationCounted: false,
    });
    await expect(
      service.persistReplacementCleanupStage(
        otherAgent,
        seeded.organizationId,
        unaccounted,
        {
          status: "running",
          environmentRevision: 0,
          sandboxId: "sandbox-unaccounted",
          nodeId: "node-1",
          containerName: "agent-unaccounted",
        },
        "intent",
      ),
    ).rejects.toThrow("durable node capacity ownership");
    expect(
      await agentSandboxesRepository.findByIdAndOrg(otherAgent, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_attempt_id: null,
    });
  });

  test("replacement enrichment and cleanup preserve a PostgreSQL microsecond fence", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-new",
      hostname: "node-new.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 2,
    });
    const provider = new DockerSandboxProvider();
    const cleanup = spyOn(provider, "stopOnSpecificNodeForReplacement").mockResolvedValue(
      undefined,
    );
    const service = new ElizaSandboxService(
      provider as unknown as SandboxProvider,
    ) as unknown as ElizaSandboxService & ReplacementStageService;
    const expected = {
      status: "running" as const,
      environmentRevision: 0,
      sandboxId: "sandbox-1",
      nodeId: "node-1",
      containerName: "agent-1",
    };
    const intent = replacementHandle({
      agentId,
      nodeId: "node-new",
      containerName: "agent-new",
      previousVpnNodeId: "vpn-old",
    });
    const created = replacementHandle({
      agentId,
      nodeId: "node-new",
      containerName: "agent-new",
      containerId: "sha256:container-new",
      previousVpnNodeId: "vpn-old",
    });
    const registered = replacementHandle({
      agentId,
      nodeId: "node-new",
      containerName: "agent-new",
      containerId: "sha256:container-new",
      vpnNodeId: "vpn-new",
      previousVpnNodeId: "vpn-old",
    });

    await service.persistReplacementCleanupStage(
      agentId,
      seeded.organizationId,
      intent,
      expected,
      "intent",
    );
    await dbWrite.execute(sql`
      UPDATE ${agentSandboxes}
      SET replacement_cleanup_created_at =
        TIMESTAMPTZ '2026-07-23 12:01:00.123456+00'
      WHERE id = ${agentId}
    `);
    const precision = await dbWrite.execute<{ fractional: string }>(sql`
      SELECT to_char(replacement_cleanup_created_at, 'US') AS fractional
      FROM ${agentSandboxes}
      WHERE id = ${agentId}
    `);
    expect(precision.rows[0]?.fractional).toBe("123456");

    await service.persistReplacementCleanupStage(
      agentId,
      seeded.organizationId,
      created,
      expected,
      "created",
    );
    const afterCreated = await agentSandboxesRepository.findByIdAndOrg(
      agentId,
      seeded.organizationId,
    );
    expect(afterCreated).toMatchObject({
      replacement_cleanup_container_id: "sha256:container-new",
      replacement_cleanup_vpn_node_id: null,
      replacement_cleanup_allocation_counted: true,
    });
    const createdAt = afterCreated?.replacement_cleanup_created_at;
    expect(createdAt).toBeInstanceOf(Date);
    const createdPrecision = await dbWrite.execute<{ fractional: string }>(sql`
      SELECT to_char(replacement_cleanup_created_at, 'US') AS fractional
      FROM ${agentSandboxes}
      WHERE id = ${agentId}
    `);
    expect(createdPrecision.rows[0]?.fractional).toBe("123456");
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-new")))[0]
        ?.allocated_count,
    ).toBe(3);

    await service.persistReplacementCleanupStage(
      agentId,
      seeded.organizationId,
      created,
      expected,
      "created",
    );
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_container_id: "sha256:container-new",
      replacement_cleanup_vpn_node_id: null,
      replacement_cleanup_created_at: createdAt,
    });
    await service.persistReplacementCleanupStage(
      agentId,
      seeded.organizationId,
      registered,
      expected,
      "vpn",
    );
    await service.persistReplacementCleanupStage(
      agentId,
      seeded.organizationId,
      registered,
      expected,
      "vpn",
    );
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_container_id: "sha256:container-new",
      replacement_cleanup_vpn_node_id: "vpn-new",
      replacement_cleanup_created_at: createdAt,
      replacement_cleanup_allocation_counted: true,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-new")))[0]
        ?.allocated_count,
    ).toBe(3);

    await service.convergeReplacementCleanupFence(agentId, seeded.organizationId);
    await service.convergeReplacementCleanupFence(agentId, seeded.organizationId);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_container_id: null,
      replacement_cleanup_allocation_counted: null,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-new")))[0]
        ?.allocated_count,
    ).toBe(2);
  });

  test("replacement cleanup proves absence outside the transaction and fences a changed locator", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-new",
      hostname: "node-new.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 3,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        replacement_cleanup_sandbox_id: "agent-new",
        replacement_cleanup_node_id: "node-new",
        replacement_cleanup_container_name: "agent-new",
        replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
        replacement_cleanup_container_id: "sha256:container-before",
        replacement_cleanup_vpn_node_id: "vpn-new",
        replacement_cleanup_vpn_node_name: "agent-new-vpn",
        replacement_cleanup_preserved_vpn_node_id: "vpn-old",
        replacement_cleanup_vpn_registration_started_at: new Date(REPLACEMENT_STARTED_AT),
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date("2026-07-23T12:01:00.000Z"),
      })
      .where(eq(agentSandboxes.id, agentId));

    const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
    const provider = new DockerSandboxProvider();
    const cleanup = spyOn(provider, "stopOnSpecificNodeForReplacement").mockImplementation(
      async () => {
        await dbWrite
          .update(agentSandboxes)
          .set({ replacement_cleanup_container_id: "sha256:container-after" })
          .where(eq(agentSandboxes.id, agentId));
      },
    );
    const service = new ElizaSandboxService(provider as unknown as SandboxProvider);
    await expect(
      service.convergeReplacementCleanupFence(agentId, seeded.organizationId),
    ).rejects.toThrow("fence changed after remote absence proof");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_container_id: "sha256:container-after",
      replacement_cleanup_allocation_counted: true,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-new")))[0]
        ?.allocated_count,
    ).toBe(3);

    cleanup.mockImplementation(async () => {});
    await service.convergeReplacementCleanupFence(agentId, seeded.organizationId);
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_allocation_counted: null,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-new")))[0]
        ?.allocated_count,
    ).toBe(2);
  });

  test("replacement cleanup sweep waits for lifecycle completion and candidate grace", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-candidate",
      hostname: "node-candidate.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 3,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        replacement_cleanup_sandbox_id: "agent-old",
        replacement_cleanup_node_id: "node-candidate",
        replacement_cleanup_container_name: "agent-old",
        replacement_cleanup_attempt_id: null,
        replacement_cleanup_container_id: null,
        replacement_cleanup_vpn_node_id: "vpn-old",
        replacement_cleanup_vpn_node_name: null,
        replacement_cleanup_preserved_vpn_node_id: null,
        replacement_cleanup_vpn_registration_started_at: null,
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date(),
      })
      .where(eq(agentSandboxes.id, agentId));
    const [job] = await dbWrite
      .insert(jobs)
      .values({
        type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
        status: "pending",
        organization_id: seeded.organizationId,
        user_id: seeded.actorUserId,
        agent_id: agentId,
        data: {},
      })
      .returning();

    const provider = new DockerSandboxProvider();
    const cleanup = spyOn(provider, "stopOnSpecificNodeForReplacement").mockResolvedValue(
      undefined,
    );
    const service = new ElizaSandboxService(provider as unknown as SandboxProvider);

    expect(await service.reconcileReplacementCleanupFences()).toEqual({
      total: 0,
      retired: 0,
      failed: 0,
    });
    await dbWrite.update(jobs).set({ status: "in_progress" }).where(eq(jobs.id, job!.id));
    expect(await service.reconcileReplacementCleanupFences()).toEqual({
      total: 0,
      retired: 0,
      failed: 0,
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: "agent-old",
      replacement_cleanup_vpn_node_id: "vpn-old",
      replacement_cleanup_allocation_counted: true,
    });

    await dbWrite.update(jobs).set({ status: "completed" }).where(eq(jobs.id, job!.id));
    expect(await service.reconcileReplacementCleanupFences()).toEqual({
      total: 1,
      retired: 1,
      failed: 0,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_vpn_node_id: null,
      replacement_cleanup_allocation_counted: null,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-candidate")))[0]
        ?.allocated_count,
    ).toBe(2);

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 3 })
      .where(eq(dockerNodes.node_id, "node-candidate"));
    await dbWrite
      .update(agentSandboxes)
      .set({
        replacement_cleanup_sandbox_id: "agent-candidate",
        replacement_cleanup_node_id: "node-candidate",
        replacement_cleanup_container_name: "agent-candidate",
        replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
        replacement_cleanup_container_id: "sha256:container-candidate",
        replacement_cleanup_vpn_node_id: "vpn-candidate",
        replacement_cleanup_vpn_node_name: "agent-candidate-vpn",
        replacement_cleanup_preserved_vpn_node_id: "vpn-live",
        replacement_cleanup_vpn_registration_started_at: new Date(REPLACEMENT_STARTED_AT),
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date(),
      })
      .where(eq(agentSandboxes.id, agentId));
    expect(await service.reconcileReplacementCleanupFences()).toEqual({
      total: 0,
      retired: 0,
      failed: 0,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: "agent-candidate",
      replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
      replacement_cleanup_allocation_counted: true,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-candidate")))[0]
        ?.allocated_count,
    ).toBe(3);

    await dbWrite.execute(sql`
      UPDATE ${agentSandboxes}
      SET replacement_cleanup_created_at = NOW() - INTERVAL '31 minutes'
      WHERE id = ${agentId}
    `);
    expect(await service.reconcileReplacementCleanupFences()).toEqual({
      total: 1,
      retired: 1,
      failed: 0,
    });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_allocation_counted: null,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-candidate")))[0]
        ?.allocated_count,
    ).toBe(2);

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 3 })
      .where(eq(dockerNodes.node_id, "node-candidate"));
    await dbWrite
      .update(agentSandboxes)
      .set({
        replacement_cleanup_sandbox_id: "agent-failed",
        replacement_cleanup_node_id: "node-candidate",
        replacement_cleanup_container_name: "agent-failed",
        replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
        replacement_cleanup_container_id: "sha256:container-failed",
        replacement_cleanup_vpn_node_id: "vpn-failed",
        replacement_cleanup_vpn_node_name: "agent-failed-vpn",
        replacement_cleanup_preserved_vpn_node_id: "vpn-live",
        replacement_cleanup_vpn_registration_started_at: new Date(REPLACEMENT_STARTED_AT),
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date(),
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.execute(sql`
      UPDATE ${agentSandboxes}
      SET replacement_cleanup_created_at = NOW() - INTERVAL '31 minutes'
      WHERE id = ${agentId}
    `);
    cleanup.mockRejectedValueOnce(new Error("remote cleanup unavailable"));
    expect(await service.reconcileReplacementCleanupFences()).toEqual({
      total: 1,
      retired: 0,
      failed: 1,
    });
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: "agent-failed",
      replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
      replacement_cleanup_allocation_counted: true,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-candidate")))[0]
        ?.allocated_count,
    ).toBe(3);
  });

  test("replacement cleanup rechecks lifecycle jobs after candidate selection", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-race",
      hostname: "node-race.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 3,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        replacement_cleanup_sandbox_id: "agent-race-old",
        replacement_cleanup_node_id: "node-race",
        replacement_cleanup_container_name: "agent-race-old",
        replacement_cleanup_attempt_id: null,
        replacement_cleanup_container_id: null,
        replacement_cleanup_vpn_node_id: "vpn-race-old",
        replacement_cleanup_vpn_node_name: null,
        replacement_cleanup_preserved_vpn_node_id: null,
        replacement_cleanup_vpn_registration_started_at: null,
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date(),
      })
      .where(eq(agentSandboxes.id, agentId));

    const provider = new DockerSandboxProvider();
    const cleanup = spyOn(provider, "stopOnSpecificNodeForReplacement").mockResolvedValue(
      undefined,
    );
    const service = new ElizaSandboxService(provider as unknown as SandboxProvider);
    const cleanupService = service as unknown as ReplacementCleanupService;
    const retire = cleanupService.retirePersistedReplacementCleanup.bind(service);
    let insertedJobId: string | null = null;
    spyOn(cleanupService, "retirePersistedReplacementCleanup").mockImplementation(
      async (...args) => {
        if (!insertedJobId) {
          const [job] = await dbWrite
            .insert(jobs)
            .values({
              type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
              status: "pending",
              organization_id: seeded.organizationId,
              user_id: seeded.actorUserId,
              agent_id: agentId,
              data: {},
            })
            .returning({ id: jobs.id });
          insertedJobId = job!.id;
        }
        return retire(...args);
      },
    );

    expect(await service.reconcileReplacementCleanupFences()).toEqual({
      total: 1,
      retired: 0,
      failed: 0,
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: "agent-race-old",
      replacement_cleanup_vpn_node_id: "vpn-race-old",
      replacement_cleanup_allocation_counted: true,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-race")))[0]
        ?.allocated_count,
    ).toBe(3);

    await dbWrite.update(jobs).set({ status: "completed" }).where(eq(jobs.id, insertedJobId!));
    expect(await service.reconcileReplacementCleanupFences()).toEqual({
      total: 1,
      retired: 1,
      failed: 0,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_vpn_node_id: null,
      replacement_cleanup_allocation_counted: null,
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-race")))[0]
        ?.allocated_count,
    ).toBe(2);
  });

  test("admin canary safe-clean rejects a stale owner before its completion callback", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite
      .update(agentSandboxes)
      .set({
        node_id: "node-blue",
        container_name: "agent-blue",
        docker_image: TARGET_IMAGE,
        image_digest: TARGET_DIGEST,
      })
      .where(eq(agentSandboxes.id, agentId));

    let completed = false;
    const service = new ElizaSandboxService(new DockerSandboxProvider() as SandboxProvider);
    await expect(
      service.convergeReplacementCleanupFence(
        agentId,
        seeded.organizationId,
        {
          targetOwnerUserId: "00000000-0000-4000-8000-000000000099",
          targetImage: TARGET_IMAGE,
          targetDigest: TARGET_DIGEST,
          newNodeId: "node-blue",
          newContainerName: "agent-blue",
          oldNodeId: "node-1",
          oldContainerName: "agent-1",
        },
        async () => {
          completed = true;
        },
      ),
    ).rejects.toThrow("serving generation changed");
    expect(completed).toBe(false);
  });

  test("admin canary cleanup rejects a locator from a later replacement generation", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-later",
      hostname: "node-later.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 1,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        node_id: "node-blue",
        container_name: "agent-blue",
        docker_image: TARGET_IMAGE,
        image_digest: TARGET_DIGEST,
        replacement_cleanup_sandbox_id: "sandbox-later",
        replacement_cleanup_node_id: "node-later",
        replacement_cleanup_container_name: "agent-later",
        replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
        replacement_cleanup_container_id: "sha256:container-later",
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date("2026-07-23T13:00:00.000Z"),
      })
      .where(eq(agentSandboxes.id, agentId));

    const provider = new DockerSandboxProvider();
    const remoteCleanup = spyOn(provider, "stopOnSpecificNodeForReplacement").mockResolvedValue(
      undefined,
    );
    const service = new ElizaSandboxService(provider as unknown as SandboxProvider);
    await expect(
      service.convergeReplacementCleanupFence(agentId, seeded.organizationId, {
        targetOwnerUserId: seeded.actorUserId,
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
        newNodeId: "node-blue",
        newContainerName: "agent-blue",
        oldNodeId: "node-1",
        oldContainerName: "agent-1",
      }),
    ).rejects.toThrow("locator does not match");
    expect(remoteCleanup).not.toHaveBeenCalled();
    expect(
      await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
    ).toMatchObject({
      replacement_cleanup_node_id: "node-later",
      replacement_cleanup_container_name: "agent-later",
    });
    expect(
      (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-later")))[0]
        ?.allocated_count,
    ).toBe(1);
  });

  test("blue-green cutover transfers only old-primary identity and retains new capacity", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite
      .update(agentSandboxes)
      .set({
        docker_image: SOURCE_IMAGE,
        image_digest: SOURCE_DIGEST,
        environment_vars: { ELIZA_API_TOKEN: "agent-token" },
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(dockerNodes).values([
      {
        node_id: "node-1",
        hostname: "node-1.internal",
        status: "healthy",
        enabled: true,
        capacity: 8,
        allocated_count: 1,
      },
      {
        node_id: "node-new",
        hostname: "node-new.internal",
        status: "healthy",
        enabled: true,
        capacity: 8,
        allocated_count: 0,
      },
    ]);

    const provider = new DockerSandboxProvider();
    const create = spyOn(provider, "create").mockImplementation(
      async (config: SandboxCreateConfig) => {
        const intent = replacementHandle({
          agentId,
          nodeId: "node-new",
          containerName: "agent-new",
          dockerImage: SAME_REPO_TARGET_IMAGE,
          previousVpnNodeId: "vpn-old",
        });
        const created = replacementHandle({
          agentId,
          nodeId: "node-new",
          containerName: "agent-new",
          dockerImage: SAME_REPO_TARGET_IMAGE,
          containerId: "sha256:container-new",
          previousVpnNodeId: "vpn-old",
        });
        const registered = replacementHandle({
          agentId,
          nodeId: "node-new",
          containerName: "agent-new",
          dockerImage: SAME_REPO_TARGET_IMAGE,
          containerId: "sha256:container-new",
          vpnNodeId: "vpn-new",
          previousVpnNodeId: "vpn-old",
        });
        await config.onReplacementCreateIntent?.(intent);
        await config.onReplacementCreated?.(created);
        await config.onReplacementVpnRegistered?.(registered);
        return registered;
      },
    );
    spyOn(provider, "checkHealth").mockResolvedValue(true);
    const cleanup = spyOn(provider, "stopOnSpecificNodeForReplacement").mockImplementation(
      async () => {
        throw new Error("hold old-primary fence for assertion");
      },
    );
    const service = new ElizaSandboxService(provider as unknown as SandboxProvider);
    const snapshot = spyOn(service, "snapshot").mockResolvedValue({ success: true });
    const originalFetch = globalThis.fetch;
    const runtimeRequests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      runtimeRequests.push({ url, headers: new Headers(init?.headers) });
      return new Response(
        JSON.stringify(
          url.endsWith("/api/status")
            ? {
                state: "running",
                canRespond: true,
                startup: { phase: "running", attempt: 0 },
              }
            : {
                ready: true,
                canRespond: true,
                runtime: "ok",
                database: "ok",
                plugins: { loaded: 18, failed: 0 },
                startup: { phase: "running", attempt: 0 },
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = await service.executeUpgrade(
        agentId,
        seeded.organizationId,
        TARGET_DIGEST,
        SAME_REPO_TARGET_IMAGE,
        SOURCE_DIGEST,
      );
      expect(result).toMatchObject({
        success: true,
        cleanupPending: true,
        newNodeId: "node-new",
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(runtimeRequests.map((request) => request.url)).toEqual([
        "https://agent-new.example/api/status",
        "https://agent-new.example/api/health",
      ]);
      for (const request of runtimeRequests) {
        expect(request.headers.get("authorization")).toBe("Bearer agent-token");
      }
      const cutover = await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId);
      expect(cutover).toMatchObject({
        sandbox_id: "agent-new",
        node_id: "node-new",
        container_name: "agent-new",
        image_digest: TARGET_DIGEST,
        previous_image_digest: SOURCE_DIGEST,
        replacement_cleanup_sandbox_id: "sandbox-1",
        replacement_cleanup_node_id: "node-1",
        replacement_cleanup_container_name: "agent-1",
        replacement_cleanup_attempt_id: null,
        replacement_cleanup_container_id: null,
        replacement_cleanup_vpn_node_id: "vpn-old",
        replacement_cleanup_vpn_node_name: null,
        replacement_cleanup_preserved_vpn_node_id: null,
        replacement_cleanup_vpn_registration_started_at: null,
        replacement_cleanup_allocation_counted: true,
      });
      const nodeCounts = await dbWrite
        .select({
          nodeId: dockerNodes.node_id,
          allocatedCount: dockerNodes.allocated_count,
        })
        .from(dockerNodes);
      expect(
        Object.fromEntries(nodeCounts.map((node) => [node.nodeId, node.allocatedCount])),
      ).toEqual({
        "node-1": 1,
        "node-new": 1,
      });
    } finally {
      globalThis.fetch = originalFetch;
      snapshot.mockRestore();
    }
  });

  test("blue-green rollback transfers only current-primary identity and retains rollback capacity", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite
      .update(agentSandboxes)
      .set({
        sandbox_id: "agent-current",
        node_id: "node-current",
        container_name: "agent-current",
        docker_image: SAME_REPO_TARGET_IMAGE,
        image_digest: TARGET_DIGEST,
        previous_docker_image: SOURCE_IMAGE,
        previous_image_digest: SOURCE_DIGEST,
        environment_vars: { ELIZA_API_TOKEN: "agent-token" },
      })
      .where(eq(agentSandboxes.id, agentId));
    await dbWrite.insert(dockerNodes).values([
      {
        node_id: "node-current",
        hostname: "node-current.internal",
        status: "healthy",
        enabled: true,
        capacity: 8,
        allocated_count: 1,
      },
      {
        node_id: "node-rollback",
        hostname: "node-rollback.internal",
        status: "healthy",
        enabled: true,
        capacity: 8,
        allocated_count: 0,
      },
    ]);

    const provider = new DockerSandboxProvider();
    const create = spyOn(provider, "create").mockImplementation(
      async (config: SandboxCreateConfig) => {
        const intent = replacementHandle({
          agentId,
          nodeId: "node-rollback",
          containerName: "agent-rollback",
          dockerImage: SOURCE_IMAGE,
          imageDigest: SOURCE_DIGEST,
          previousVpnNodeId: "vpn-current",
        });
        const created = replacementHandle({
          agentId,
          nodeId: "node-rollback",
          containerName: "agent-rollback",
          dockerImage: SOURCE_IMAGE,
          imageDigest: SOURCE_DIGEST,
          containerId: "sha256:container-rollback",
          previousVpnNodeId: "vpn-current",
        });
        const registered = replacementHandle({
          agentId,
          nodeId: "node-rollback",
          containerName: "agent-rollback",
          dockerImage: SOURCE_IMAGE,
          imageDigest: SOURCE_DIGEST,
          containerId: "sha256:container-rollback",
          vpnNodeId: "vpn-rollback",
          previousVpnNodeId: "vpn-current",
        });
        await config.onReplacementCreateIntent?.(intent);
        await config.onReplacementCreated?.(created);
        await config.onReplacementVpnRegistered?.(registered);
        return registered;
      },
    );
    spyOn(provider, "checkHealth").mockResolvedValue(true);
    const cleanup = spyOn(provider, "stopOnSpecificNodeForReplacement").mockImplementation(
      async () => {
        throw new Error("hold current-primary fence for assertion");
      },
    );
    const backup = {
      id: "00000000-0000-4000-8000-000000000091",
      sandbox_record_id: agentId,
      snapshot_type: "pre-upgrade",
    } as unknown as AgentSandboxBackup;
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      backup,
    );
    const reconstructSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: { restored: true }, workspaceFiles: {} });
    const service = new ElizaSandboxService(provider as unknown as SandboxProvider);
    const restoreSpy = spyOn(
      service as unknown as {
        pushState: (...args: unknown[]) => Promise<void>;
      },
      "pushState",
    ).mockResolvedValue(undefined);
    const originalFetch = globalThis.fetch;
    const runtimeRequests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      runtimeRequests.push({ url, headers: new Headers(init?.headers) });
      return new Response(
        JSON.stringify(
          url.endsWith("/api/status")
            ? {
                state: "running",
                canRespond: true,
                startup: { phase: "running", attempt: 0 },
              }
            : {
                ready: true,
                canRespond: true,
                runtime: "ok",
                database: "ok",
                plugins: { loaded: 18, failed: 0 },
                startup: { phase: "running", attempt: 0 },
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = await service.executeDowngrade(
        agentId,
        seeded.organizationId,
        SAME_REPO_TARGET_IMAGE,
        TARGET_DIGEST,
      );
      expect(result).toMatchObject({
        success: true,
        cleanupPending: true,
        oldNodeId: "node-current",
        newNodeId: "node-rollback",
        newDigest: SOURCE_DIGEST,
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(restoreSpy).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(runtimeRequests.map((request) => request.url)).toEqual([
        "https://agent-rollback.example/api/status",
        "https://agent-rollback.example/api/health",
        "https://agent-rollback.example/api/status",
        "https://agent-rollback.example/api/health",
      ]);
      for (const request of runtimeRequests) {
        expect(request.headers.get("authorization")).toBe("Bearer agent-token");
      }
      expect(
        await agentSandboxesRepository.findByIdAndOrg(agentId, seeded.organizationId),
      ).toMatchObject({
        sandbox_id: "agent-rollback",
        node_id: "node-rollback",
        container_name: "agent-rollback",
        image_digest: SOURCE_DIGEST,
        previous_image_digest: null,
        previous_docker_image: null,
        replacement_cleanup_sandbox_id: "agent-current",
        replacement_cleanup_node_id: "node-current",
        replacement_cleanup_container_name: "agent-current",
        replacement_cleanup_attempt_id: null,
        replacement_cleanup_container_id: null,
        replacement_cleanup_vpn_node_id: "vpn-current",
        replacement_cleanup_vpn_node_name: null,
        replacement_cleanup_preserved_vpn_node_id: null,
        replacement_cleanup_vpn_registration_started_at: null,
        replacement_cleanup_allocation_counted: true,
      });
      const nodeCounts = await dbWrite
        .select({
          nodeId: dockerNodes.node_id,
          allocatedCount: dockerNodes.allocated_count,
        })
        .from(dockerNodes);
      expect(
        Object.fromEntries(nodeCounts.map((node) => [node.nodeId, node.allocatedCount])),
      ).toEqual({
        "node-current": 1,
        "node-rollback": 1,
      });
    } finally {
      globalThis.fetch = originalFetch;
      backupSpy.mockRestore();
      reconstructSpy.mockRestore();
      restoreSpy.mockRestore();
    }
  });

  test("warm claim atomically transfers the digest used by canary and reconciler decisions", async () => {
    const seeded = await seedAgents(0);
    const userAgentId = "00000000-0000-4000-8000-000000000091";
    const poolRowId = "00000000-0000-4000-8000-000000000092";
    const poolEnv = { ELIZA_API_TOKEN: "transport-token" };
    await dbWrite.insert(organizations).values({
      id: WARM_POOL_ORG_ID,
      name: "Warm Pool (system)",
      slug: uniq("warm-pool-org"),
      is_active: false,
    });
    await dbWrite.insert(users).values({
      id: WARM_POOL_USER_ID,
      steward_user_id: uniq("warm-pool-user"),
      organization_id: WARM_POOL_ORG_ID,
    });
    await dbWrite.insert(agentSandboxes).values([
      {
        id: userAgentId,
        organization_id: seeded.organizationId,
        user_id: seeded.actorUserId,
        agent_name: "Warm Claim Canary",
        status: "pending",
        execution_tier: "dedicated-always",
      },
      {
        id: poolRowId,
        organization_id: WARM_POOL_ORG_ID,
        user_id: WARM_POOL_USER_ID,
        agent_name: "Warm Pool",
        status: "running",
        pool_status: "unclaimed",
        pool_ready_at: new Date("2026-07-23T00:00:00.000Z"),
        sandbox_id: "warm-pool-sandbox",
        node_id: "warm-node",
        container_name: "warm-container",
        bridge_url: "http://100.64.0.91:3000",
        health_url: "http://100.64.0.91:3000/api",
        docker_image: SOURCE_IMAGE,
        image_digest: SOURCE_DIGEST,
        environment_vars: poolEnv,
      },
    ]);
    const targetOrgId = seeded.organizationId;

    const claimed = await agentSandboxesRepository.claimWarmContainer({
      userAgentId,
      organizationId: targetOrgId,
      image: SOURCE_IMAGE,
      agentName: "Warm Claim Canary",
    });
    expect(claimed).toMatchObject({
      id: userAgentId,
      docker_image: SOURCE_IMAGE,
      image_digest: SOURCE_DIGEST,
      warm_pool_row_id: poolRowId,
    });
    if (!claimed) throw new Error("expected warm claim");

    expect(
      await agentSandboxesRepository.listRunningWithDigestOtherThan(NEXT_DIGEST, SOURCE_IMAGE, 10),
    ).toEqual([]);
    await expect(
      adminAgentImageRolloutService.previewOrEnqueue(
        {
          operation: "upgrade",
          requestId: nextRequestId(),
          dryRun: true,
          targetImage: TARGET_IMAGE,
          targets: [
            {
              agentId: userAgentId,
              organizationId: targetOrgId,
              expectedSourceImage: SOURCE_IMAGE,
              expectedSourceDigest: SOURCE_DIGEST,
            },
          ],
        },
        seeded.actorUserId,
      ),
    ).rejects.toMatchObject({ status: 409 });

    await agentSandboxesRepository.update(userAgentId, {
      warm_claim_credential_state: "ready",
      warm_claim_key_fingerprint: "deadbeefdeadbeef",
      warm_claim_attested_at: new Date("2026-07-23T12:00:01.000Z"),
      warm_claim_attested_environment_revision: claimed.environment_revision,
      warm_claim_source_pool_id: null,
      status: "running",
    });

    const preview = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        requestId: nextRequestId(),
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: [
          {
            agentId: userAgentId,
            organizationId: targetOrgId,
            expectedSourceImage: SOURCE_IMAGE,
            expectedSourceDigest: SOURCE_DIGEST,
          },
        ],
      },
      seeded.actorUserId,
    );
    expect(preview.targets).toEqual([
      expect.objectContaining({
        sourceImage: SOURCE_IMAGE,
        sourceDigest: SOURCE_DIGEST,
      }),
    ]);

    expect(
      await agentSandboxesRepository.listRunningWithDigestOtherThan(
        SOURCE_DIGEST,
        SOURCE_IMAGE,
        10,
      ),
    ).toEqual([]);
    expect(
      await agentSandboxesRepository.listRunningWithDigestOtherThan(NEXT_DIGEST, SOURCE_IMAGE, 10),
    ).toEqual([expect.objectContaining({ id: userAgentId, image_digest: SOURCE_DIGEST })]);
  });

  test("legacy claimed rows cold-recover from missing handles before image rollout", async () => {
    const seeded = await seedAgents(0);
    const agentId = "00000000-0000-4000-8000-000000000093";
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: seeded.organizationId,
      user_id: seeded.actorUserId,
      agent_name: "Legacy Warm Claim",
      status: "stopped",
      claimed_at: new Date("2026-07-20T00:00:00.000Z"),
      docker_image: SOURCE_IMAGE,
      image_digest: null,
      sandbox_id: null,
      node_id: null,
      container_name: null,
      warm_claim_credential_state: null,
      warm_claim_source_pool_id: null,
    });

    expect(
      await agentSandboxesRepository.listRunningWithDigestOtherThan(
        TARGET_DIGEST,
        SOURCE_IMAGE,
        10,
      ),
    ).toEqual([]);

    const reconciled = await provisioningJobService.reconcileWarmClaimCredentialFences(5);
    expect(reconciled).toMatchObject({
      legacyFound: 1,
      strandedFound: 0,
      recoveryEnqueued: 1,
      cleanupFound: 0,
    });
    const [prepared] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    expect(prepared).toMatchObject({
      status: "provisioning",
      warm_claim_credential_state: "pending",
      warm_claim_source_pool_id: null,
    });

    const restart = spyOn(elizaSandboxService, "executeRestart").mockImplementation(
      async (requestedAgentId, requestedOrgId) => {
        expect(requestedAgentId).toBe(agentId);
        expect(requestedOrgId).toBe(seeded.organizationId);
        await dbWrite
          .update(agentSandboxes)
          .set({
            status: "running",
            sandbox_id: "fresh-sandbox",
            node_id: "fresh-node",
            container_name: "fresh-container",
            docker_image: SOURCE_IMAGE,
            image_digest: NEXT_DIGEST,
            warm_claim_credential_state: "ready",
            warm_claim_source_pool_id: null,
            warm_claim_key_fingerprint: "freshfencefresh",
            warm_claim_attested_at: new Date("2026-07-23T12:00:00.000Z"),
            warm_claim_attested_environment_revision: 0,
          })
          .where(eq(agentSandboxes.id, agentId));
        return {
          success: true,
          containerStopped: true,
          containerStarted: true,
          bridgeUrl: "http://100.64.0.93:3000",
          healthUrl: "http://100.64.0.93:3000/api",
        };
      },
    );
    try {
      expect(
        await provisioningJobService.processPendingJobs(5, {
          jobTypes: [JOB_TYPES.AGENT_RESTART],
        }),
      ).toMatchObject({ succeeded: 1, failed: 0 });
    } finally {
      restart.mockRestore();
    }

    const preview = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        requestId: nextRequestId(),
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: [
          {
            agentId,
            organizationId: seeded.organizationId,
            expectedSourceImage: SOURCE_IMAGE,
            expectedSourceDigest: NEXT_DIGEST,
          },
        ],
      },
      seeded.actorUserId,
    );
    expect(preview.targets).toEqual([
      expect.objectContaining({
        agentId,
        sourceDigest: NEXT_DIGEST,
        targetDigest: TARGET_DIGEST,
      }),
    ]);
  });

  test("a crashed claim-time enqueue is durably rediscovered without duplicating restart jobs", async () => {
    const seeded = await seedAgents(0);
    const agentId = "00000000-0000-4000-8000-000000000094";
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: seeded.organizationId,
      user_id: seeded.actorUserId,
      agent_name: "Stranded Warm Claim",
      status: "provisioning",
      claimed_at: new Date("2026-07-20T00:00:00.000Z"),
      updated_at: new Date("2026-07-20T00:00:00.000Z"),
      sandbox_id: "stranded-sandbox",
      node_id: "stranded-node",
      container_name: "stranded-container",
      docker_image: SOURCE_IMAGE,
      image_digest: SOURCE_DIGEST,
      warm_claim_credential_state: "pending",
      warm_claim_source_pool_id: "00000000-0000-4000-8000-000000000095",
      warm_claim_key_fingerprint: "pendingpending1",
    });

    const first = await provisioningJobService.reconcileWarmClaimCredentialFences(5);
    expect(first).toMatchObject({
      legacyFound: 0,
      strandedFound: 1,
      recoveryEnqueued: 1,
      recoveryInFlight: 0,
    });
    const active = await dbWrite.select().from(jobs).where(eq(jobs.type, JOB_TYPES.AGENT_RESTART));
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      status: "pending",
      agent_id: agentId,
      organization_id: seeded.organizationId,
    });

    const second = await provisioningJobService.reconcileWarmClaimCredentialFences(5);
    expect(second).toMatchObject({
      strandedFound: 0,
      recoveryEnqueued: 0,
      recoveryInFlight: 0,
    });
    expect(
      await dbWrite.select().from(jobs).where(eq(jobs.type, JOB_TYPES.AGENT_RESTART)),
    ).toHaveLength(1);
  });

  test("an allowed ready-claim environment edit re-arms and re-attests the exact revision", async () => {
    const seeded = await seedAgents(0);
    const agentId = "00000000-0000-4000-8000-000000000098";
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: seeded.organizationId,
      user_id: seeded.actorUserId,
      agent_name: "Ready Environment Claim",
      status: "running",
      claimed_at: new Date("2026-07-20T00:00:00.000Z"),
      sandbox_id: "ready-env-sandbox",
      node_id: "ready-env-node",
      container_name: "ready-env-container",
      bridge_url: "http://100.64.0.98:3000",
      health_url: "http://100.64.0.98:3000/api",
      docker_image: SOURCE_IMAGE,
      image_digest: SOURCE_DIGEST,
      environment_revision: 4,
      environment_vars: { ELIZA_API_TOKEN: "transport-token" },
      warm_claim_credential_state: "ready",
      warm_claim_source_pool_id: null,
      warm_claim_key_fingerprint: "readyreadyready1",
      warm_claim_attested_at: new Date("2026-07-20T00:00:01.000Z"),
      warm_claim_attested_environment_revision: 4,
    });

    const updated = await elizaSandboxService.updateAgentEnvironment(
      agentId,
      seeded.organizationId,
      { FEATURE_FLAG: "enabled" },
    );
    expect(updated).toMatchObject({
      environment_revision: 5,
      warm_claim_credential_state: "pending",
      warm_claim_key_fingerprint: null,
      warm_claim_attested_at: null,
      warm_claim_attested_environment_revision: null,
    });
    const restartJobs = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_RESTART));
    expect(restartJobs).toHaveLength(1);

    const restart = spyOn(elizaSandboxService, "executeRestart").mockImplementation(async () => {
      const [current] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      if (!current) throw new Error("expected edited agent");
      await dbWrite
        .update(agentSandboxes)
        .set({
          status: "running",
          warm_claim_credential_state: "ready",
          warm_claim_source_pool_id: null,
          warm_claim_key_fingerprint: "reattestedready",
          warm_claim_attested_at: new Date("2026-07-23T12:30:00.000Z"),
          warm_claim_attested_environment_revision: current.environment_revision,
        })
        .where(eq(agentSandboxes.id, agentId));
      return {
        success: true,
        containerStopped: true,
        containerStarted: true,
      };
    });
    try {
      expect(
        await provisioningJobService.processPendingJobs(5, {
          jobTypes: [JOB_TYPES.AGENT_RESTART],
        }),
      ).toMatchObject({ succeeded: 1, failed: 0 });
    } finally {
      restart.mockRestore();
    }

    const [ready] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    expect(ready).toMatchObject({
      status: "running",
      warm_claim_credential_state: "ready",
      environment_revision: 5,
      warm_claim_attested_environment_revision: 5,
    });
  });

  test("failed cleanup blocks a concurrent pool reclaim until an explicit retry resets it", async () => {
    const seeded = await seedAgents(0);
    const agentId = "00000000-0000-4000-8000-000000000099";
    const sourcePoolId = "00000000-0000-4000-8000-000000000100";
    const availablePoolId = "00000000-0000-4000-8000-000000000101";
    await dbWrite.insert(agentSandboxes).values([
      {
        id: agentId,
        organization_id: seeded.organizationId,
        user_id: seeded.actorUserId,
        agent_name: "Cleanup Race",
        status: "error",
        claimed_at: new Date("2026-07-20T00:00:00.000Z"),
        warm_claim_credential_state: "failed",
        warm_claim_source_pool_id: sourcePoolId,
        warm_claim_cleanup_completed_at: null,
      },
      {
        id: availablePoolId,
        organization_id: seeded.organizationId,
        user_id: seeded.actorUserId,
        agent_name: "Available Pool",
        status: "running",
        pool_status: "unclaimed",
        pool_ready_at: new Date("2026-07-20T00:00:00.000Z"),
        sandbox_id: "available-pool-sandbox",
        node_id: "available-pool-node",
        container_name: "available-pool-container",
        bridge_url: "http://100.64.0.101:3000",
        health_url: "http://100.64.0.101:3000/api",
        docker_image: SOURCE_IMAGE,
        image_digest: SOURCE_DIGEST,
      },
    ]);

    let releaseFirstRevoke: (() => void) | undefined;
    let firstRevokeStarted: (() => void) | undefined;
    const firstRevoke = new Promise<void>((resolve) => {
      releaseFirstRevoke = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstRevokeStarted = resolve;
    });
    const revoke = spyOn(apiKeysService, "revokeForAgent")
      .mockImplementationOnce(async () => {
        firstRevokeStarted?.();
        await firstRevoke;
      })
      .mockResolvedValue(undefined);
    try {
      const cleanup = elizaSandboxService.cleanupFailedWarmClaimCredentialHandoff(
        agentId,
        seeded.organizationId,
      );
      await started;
      expect(
        await agentSandboxesRepository.claimWarmContainer({
          userAgentId: agentId,
          organizationId: seeded.organizationId,
          image: SOURCE_IMAGE,
          agentName: "Cleanup Race",
        }),
      ).toBeNull();
      releaseFirstRevoke?.();
      expect(await cleanup).toBe(true);
      expect(
        await agentSandboxesRepository.claimWarmContainer({
          userAgentId: agentId,
          organizationId: seeded.organizationId,
          image: SOURCE_IMAGE,
          agentName: "Cleanup Race",
        }),
      ).toBeNull();
      const [poolStillAvailable] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, availablePoolId));
      expect(poolStillAvailable?.pool_status).toBe("unclaimed");
      expect(new Set(revoke.mock.calls.map(([owner]) => owner))).toEqual(
        new Set([agentId, sourcePoolId]),
      );
    } finally {
      releaseFirstRevoke?.();
      revoke.mockRestore();
    }
  });

  test("every exhausted warm restart becomes a durable idempotent credential cleanup", async () => {
    const seeded = await seedAgents(0);
    const agentId = "00000000-0000-4000-8000-000000000096";
    const sourcePoolId = "00000000-0000-4000-8000-000000000097";
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: seeded.organizationId,
      user_id: seeded.actorUserId,
      agent_name: "Failed Warm Recovery",
      status: "provisioning",
      claimed_at: new Date("2026-07-20T00:00:00.000Z"),
      sandbox_id: "failed-sandbox",
      node_id: "failed-node",
      container_name: "failed-container",
      docker_image: SOURCE_IMAGE,
      image_digest: SOURCE_DIGEST,
      warm_claim_credential_state: "pending",
      warm_claim_source_pool_id: sourcePoolId,
      warm_claim_key_fingerprint: "targettarget123",
    });
    const restartJob = await provisioningJobService.enqueueAgentRestartOnce({
      agentId,
      organizationId: seeded.organizationId,
      userId: seeded.actorUserId,
    });
    await dbWrite
      .update(jobs)
      .set({ attempts: restartJob.job.max_attempts - 1 })
      .where(eq(jobs.id, restartJob.job.id));

    const restart = spyOn(elizaSandboxService, "executeRestart").mockResolvedValue({
      success: false,
      containerStopped: true,
      containerStarted: false,
      error: "Container readiness failed after key persistence",
    });
    try {
      expect(
        await provisioningJobService.processPendingJobs(5, {
          jobTypes: [JOB_TYPES.AGENT_RESTART],
        }),
      ).toMatchObject({ succeeded: 0, failed: 1 });
    } finally {
      restart.mockRestore();
    }

    const [failedRow] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    expect(failedRow).toMatchObject({
      status: "error",
      warm_claim_credential_state: "failed",
      warm_claim_source_pool_id: sourcePoolId,
      warm_claim_cleanup_completed_at: null,
    });
    const [failedJob] = await dbWrite.select().from(jobs).where(eq(jobs.id, restartJob.job.id));
    expect(failedJob).toMatchObject({ status: "failed", attempts: 3 });

    const revoke = spyOn(apiKeysService, "revokeForAgent")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("temporary revocation outage"));
    try {
      expect(await provisioningJobService.reconcileWarmClaimCredentialFences(5)).toMatchObject({
        cleanupFound: 1,
        cleanupCompleted: 0,
        cleanupFailed: 1,
      });
      const [retained] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(retained).toMatchObject({
        warm_claim_source_pool_id: sourcePoolId,
        warm_claim_cleanup_completed_at: null,
      });

      revoke.mockResolvedValue(undefined);
      expect(await provisioningJobService.reconcileWarmClaimCredentialFences(5)).toMatchObject({
        cleanupFound: 1,
        cleanupCompleted: 1,
        cleanupFailed: 0,
      });
      const [cleaned] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(cleaned?.warm_claim_source_pool_id).toBeNull();
      expect(cleaned?.warm_claim_cleanup_completed_at).toBeInstanceOf(Date);
      expect(new Set(revoke.mock.calls.map(([owner]) => owner))).toEqual(
        new Set([agentId, sourcePoolId]),
      );

      expect(await provisioningJobService.reconcileWarmClaimCredentialFences(5)).toMatchObject({
        cleanupFound: 0,
        cleanupCompleted: 0,
        cleanupFailed: 0,
      });
    } finally {
      revoke.mockRestore();
    }
  });

  test("dry-run preserves requested targets exactly and writes no jobs; execute inserts all five", async () => {
    const seeded = await seedAgents(5);
    const requested = [...seeded.targets].reverse();
    const requestId = nextRequestId();
    const dryRun = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        requestId,
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: requested,
      },
      seeded.actorUserId,
    );

    expect(dryRun.rolloutId).toBeNull();
    expect(dryRun.targets.map((target) => target.agentId)).toEqual(
      requested.map((target) => target.agentId),
    );
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);

    const executed = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        requestId,
        dryRun: false,
        expectedPlanFingerprint: dryRun.planFingerprint,
        targetImage: TARGET_IMAGE,
        targets: requested,
      },
      seeded.actorUserId,
    );
    expect(executed.rolloutId).toMatch(/^[0-9a-f-]{36}$/);
    expect(executed.targets.map((target) => target.agentId)).toEqual(
      seeded.targets.map((target) => target.agentId),
    );
    const persisted = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    expect(persisted).toHaveLength(5);
    for (const job of persisted) {
      expect(job.status).toBe("pending");
      expect(job.user_id).toBe(seeded.actorUserId);
      expect(job.data_storage).toBe("inline");
      const data = readAdminCanaryImageJobData(job);
      expect(data.rolloutId).toBe(executed.rolloutId);
      expect(data.actorUserId).toBe(seeded.actorUserId);
      expect(data.targetImage).toBe(TARGET_IMAGE);
      expect(data.targetDigest).toBe(TARGET_DIGEST);
    }
  });

  test("a reentrant canary rolls back to its recorded demo source pair", async () => {
    const seeded = await seedAgents(1);
    const firstTarget = seeded.targets[0]!;
    const nextImage = `ghcr.io/elizaos/eliza-demo@${NEXT_DIGEST}`;
    const first = await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const [firstJob] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.id, first.targets[0]!.jobId!));
    await completeUpgradeJob(firstJob!);

    const second = await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targetImage: nextImage,
      targets: [
        {
          ...firstTarget,
          expectedSourceImage: TARGET_IMAGE,
          expectedSourceDigest: TARGET_DIGEST,
        },
      ],
    });

    expect(second.targets).toEqual([
      expect.objectContaining({
        sourceImage: TARGET_IMAGE,
        sourceDigest: TARGET_DIGEST,
        targetImage: nextImage,
        targetDigest: NEXT_DIGEST,
      }),
    ]);
    const [secondJob] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.id, second.targets[0]!.jobId!));
    expect(readAdminCanaryImageJobData(secondJob!)).toMatchObject({
      sourceImage: TARGET_IMAGE,
      sourceDigest: TARGET_DIGEST,
      targetImage: nextImage,
      targetDigest: NEXT_DIGEST,
    });
    await completeUpgradeJob(secondJob!);

    const rollback = await executeRollbackCanary({
      actorUserId: seeded.actorUserId,
      source: { jobId: secondJob!.id },
    });

    expect(rollback.targets).toEqual([
      expect.objectContaining({
        operation: "rollback",
        sourceImage: nextImage,
        sourceDigest: NEXT_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
      }),
    ]);
  });

  test("one conflicting fifth target rolls back every canary insert", async () => {
    const seeded = await seedAgents(5);
    const blocked = seeded.targets[4]!;
    await dbWrite.insert(jobs).values({
      type: JOB_TYPES.AGENT_RESTART,
      status: "pending",
      organization_id: blocked.organizationId,
      user_id: seeded.actorUserId,
      agent_id: blocked.agentId,
      data_storage: "inline",
      data: {
        agentId: blocked.agentId,
        organizationId: blocked.organizationId,
        userId: seeded.actorUserId,
      },
      max_attempts: 1,
    });

    const attempt = executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    const persisted = await dbWrite.select().from(jobs);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type).toBe(JOB_TYPES.AGENT_RESTART);
    const agents = await dbWrite.select().from(agentSandboxes);
    expect(agents).toHaveLength(5);
    for (const agent of agents) {
      expect(agent.docker_image).toBe(SOURCE_IMAGE);
      expect(agent.image_digest).toBe(SOURCE_DIGEST);
      expect(agent.previous_docker_image).toBeNull();
      expect(agent.previous_image_digest).toBeNull();
    }
  });

  test("ordinary upgrade first blocks a canary for the same agent under the lifecycle lock", async () => {
    const seeded = await seedAgents(1);
    const target = seeded.targets[0]!;
    const ordinary = await provisioningJobService.enqueueAgentUpgradeOnce({
      agentId: target.agentId,
      organizationId: target.organizationId,
      userId: seeded.actorUserId,
      dockerImage: SOURCE_IMAGE,
      fromDigest: SOURCE_DIGEST,
      toDigest: NEXT_DIGEST,
    });
    expect(ordinary.created).toBe(true);

    await expect(
      executeUpgradeCanary({
        actorUserId: seeded.actorUserId,
        targets: seeded.targets,
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        conflictingJobId: ordinary.job.id,
        conflictingJobType: JOB_TYPES.AGENT_UPGRADE,
      },
    });

    const persisted = await dbWrite.select().from(jobs);
    expect(persisted).toEqual([
      expect.objectContaining({ id: ordinary.job.id, type: JOB_TYPES.AGENT_UPGRADE }),
    ]);
  });

  test("canary first blocks an ordinary upgrade for the same agent under the lifecycle lock", async () => {
    const seeded = await seedAgents(1);
    const target = seeded.targets[0]!;
    const canary = await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const canaryJobId = canary.targets[0]?.jobId;
    expect(canaryJobId).toBeDefined();

    await expect(
      provisioningJobService.enqueueAgentUpgradeOnce({
        agentId: target.agentId,
        organizationId: target.organizationId,
        userId: seeded.actorUserId,
        dockerImage: SOURCE_IMAGE,
        fromDigest: SOURCE_DIGEST,
        toDigest: NEXT_DIGEST,
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        conflictingJobId: canaryJobId,
        conflictingJobType: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      },
    });

    const persisted = await dbWrite.select().from(jobs);
    expect(persisted).toEqual([
      expect.objectContaining({
        id: canaryJobId,
        type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      }),
    ]);
  });

  test("concurrent execute requests serialize to exactly one durable rollout", async () => {
    const seeded = await seedAgents(5);
    const requestId = nextRequestId();
    const preview = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        requestId,
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    const input = {
      operation: "upgrade" as const,
      requestId,
      dryRun: false as const,
      expectedPlanFingerprint: preview.planFingerprint,
      targetImage: TARGET_IMAGE,
      targets: seeded.targets,
    };

    const attempts = await Promise.allSettled([
      adminAgentImageRolloutService.previewOrEnqueue(input, seeded.actorUserId),
      adminAgentImageRolloutService.previewOrEnqueue(input, seeded.actorUserId),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(2);
    const fulfilled = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );
    expect(fulfilled[1]).toEqual(fulfilled[0]);
    const persisted = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    expect(persisted).toHaveLength(5);
    expect(new Set(persisted.map((job) => readAdminCanaryImageJobData(job).rolloutId)).size).toBe(
      1,
    );
  });

  test("request recovery replays across target ordering and source drift while changed requests conflict", async () => {
    const seeded = await seedAgents(2);
    const requestId = nextRequestId();
    const preview = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        requestId,
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    const executeInput = {
      operation: "upgrade" as const,
      requestId,
      dryRun: false as const,
      expectedPlanFingerprint: preview.planFingerprint,
      targetImage: TARGET_IMAGE,
      targets: seeded.targets,
    };
    const executed = await adminAgentImageRolloutService.previewOrEnqueue(
      executeInput,
      seeded.actorUserId,
    );
    const recovered = await adminAgentImageRolloutService.recoverRequest(
      seeded.actorUserId,
      requestId,
    );
    expect(recovered).toEqual(executed);

    await dbWrite
      .update(agentSandboxes)
      .set({ image_digest: NEXT_DIGEST })
      .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
    const reordered = await adminAgentImageRolloutService.previewOrEnqueue(
      { ...executeInput, targets: [...executeInput.targets].reverse() },
      seeded.actorUserId,
    );
    expect(reordered).toEqual(executed);

    await expect(
      adminAgentImageRolloutService.previewOrEnqueue(
        {
          operation: "upgrade",
          requestId,
          dryRun: true,
          targetImage: TARGET_IMAGE,
          targets: seeded.targets,
        },
        seeded.actorUserId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      adminAgentImageRolloutService.previewOrEnqueue(
        {
          ...executeInput,
          expectedPlanFingerprint: `sha256:${"f".repeat(64)}`,
        },
        seeded.actorUserId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      adminAgentImageRolloutService.previewOrEnqueue(
        { ...executeInput, targets: [seeded.targets[0]!] },
        seeded.actorUserId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      adminAgentImageRolloutService.recoverRequest(
        "88888888-8888-4888-8888-888888888888",
        requestId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      adminAgentImageRolloutService.recoverRequest(seeded.actorUserId, requestId.toUpperCase()),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("a post-commit source mutation cannot defeat catch-time replay after a missed prelookup", async () => {
    const seeded = await seedAgents(1);
    const requestId = nextRequestId();
    const preview = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        requestId,
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    const input = {
      operation: "upgrade" as const,
      requestId,
      dryRun: false as const,
      expectedPlanFingerprint: preview.planFingerprint,
      targetImage: TARGET_IMAGE,
      targets: seeded.targets,
    };
    const executed = await adminAgentImageRolloutService.previewOrEnqueue(
      input,
      seeded.actorUserId,
    );
    await dbWrite
      .update(agentSandboxes)
      .set({ image_digest: NEXT_DIGEST })
      .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));

    const originalLookup = jobsRepository.findAdminCanaryRequestForWrite.bind(jobsRepository);
    let missFirstLookup = true;
    const lookup = spyOn(jobsRepository, "findAdminCanaryRequestForWrite").mockImplementation(
      async (...args) => {
        if (missFirstLookup) {
          missFirstLookup = false;
          return [];
        }
        return await originalLookup(...args);
      },
    );
    try {
      expect(
        await adminAgentImageRolloutService.previewOrEnqueue(input, seeded.actorUserId),
      ).toEqual(executed);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      lookup.mockRestore();
    }
  });

  test("execute rejects tampered fingerprints and owner, warm-fence, or source drift", async () => {
    const cases = ["fingerprint", "owner", "warm", "source"] as const;
    for (const drift of cases) {
      const seeded = await seedAgents(1);
      const requestId = nextRequestId();
      const preview = await adminAgentImageRolloutService.previewOrEnqueue(
        {
          operation: "upgrade",
          requestId,
          dryRun: true,
          targetImage: TARGET_IMAGE,
          targets: seeded.targets,
        },
        seeded.actorUserId,
      );
      if (drift === "owner") {
        const [replacementOwner] = await dbWrite
          .insert(users)
          .values({
            steward_user_id: uniq("canary-owner-drift"),
            organization_id: seeded.organizationId,
          })
          .returning();
        if (!replacementOwner) throw new Error("expected replacement canary owner");
        await dbWrite
          .update(agentSandboxes)
          .set({ user_id: replacementOwner.id })
          .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      } else if (drift === "warm") {
        await dbWrite
          .update(agentSandboxes)
          .set({
            claimed_at: new Date(),
            warm_claim_credential_state: "pending",
          })
          .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      } else if (drift === "source") {
        await dbWrite
          .update(agentSandboxes)
          .set({ image_digest: NEXT_DIGEST })
          .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      }

      await expect(
        adminAgentImageRolloutService.previewOrEnqueue(
          {
            operation: "upgrade",
            requestId,
            dryRun: false,
            expectedPlanFingerprint:
              drift === "fingerprint" ? `sha256:${"e".repeat(64)}` : preview.planFingerprint,
            targetImage: TARGET_IMAGE,
            targets: seeded.targets,
          },
          seeded.actorUserId,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await dbWrite.select().from(jobs)).toHaveLength(0);

      await dbWrite.delete(agentSandboxes);
      await dbWrite.delete(users);
      await dbWrite.delete(organizations);
    }
  });

  test("recovery fails closed when durable targets or request metadata are missing or changed", async () => {
    const seeded = await seedAgents(2);
    const requestId = nextRequestId();
    const executed = await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      requestId,
      targets: seeded.targets,
    });
    const persisted = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE))
      .orderBy(jobs.id);
    expect(persisted).toHaveLength(2);

    await dbWrite.delete(jobs).where(eq(jobs.id, persisted[0]!.id));
    await expect(
      adminAgentImageRolloutService.recoverRequest(seeded.actorUserId, requestId),
    ).rejects.toThrow("incomplete or changed target set");

    await dbWrite.insert(jobs).values(persisted[0]!);
    const restored = await adminAgentImageRolloutService.recoverRequest(
      seeded.actorUserId,
      requestId,
    );
    expect(restored.rolloutId).toBe(executed.rolloutId);

    await dbWrite
      .update(jobs)
      .set({
        data: {
          ...persisted[0]!.data,
          targetOwnerUserId: "77777777-7777-4777-8777-777777777777",
        },
      })
      .where(eq(jobs.id, persisted[0]!.id));
    await expect(
      adminAgentImageRolloutService.recoverRequest(seeded.actorUserId, requestId),
    ).rejects.toThrow("incomplete or changed target set");

    await dbWrite
      .update(jobs)
      .set({
        data: {
          ...persisted[0]!.data,
          canonicalRequestHash: 42,
        },
      })
      .where(eq(jobs.id, persisted[0]!.id));
    await expect(
      adminAgentImageRolloutService.recoverRequest(seeded.actorUserId, requestId),
    ).rejects.toThrow("Invalid admin canary image job data");
  });

  test("legacy canary rows without recovery metadata still execute and remain rollback evidence", async () => {
    const seeded = await seedAgents(1);
    const upgradeRequestId = nextRequestId();
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      requestId: upgradeRequestId,
      targets: seeded.targets,
    });
    const [queuedUpgrade] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    if (!queuedUpgrade) throw new Error("expected queued upgrade job");

    const legacyData = { ...queuedUpgrade.data };
    delete legacyData.requestId;
    delete legacyData.planFingerprint;
    delete legacyData.canonicalRequestHash;
    await dbWrite.update(jobs).set({ data: legacyData }).where(eq(jobs.id, queuedUpgrade.id));

    const execution = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockImplementation(
      async (params) => {
        await dbWrite.transaction(async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              node_id: "node-legacy-blue",
              container_name: "agent-legacy-blue",
              docker_image: params.targetImage,
              image_digest: params.targetDigest,
              previous_docker_image: params.sourceImage,
              previous_image_digest: params.sourceDigest,
            })
            .where(eq(agentSandboxes.id, params.agentId));
          await params.onCutoverInTx(tx, {
            oldNodeId: "node-legacy-old",
            oldContainerName: "agent-legacy-old",
            newNodeId: "node-legacy-blue",
            newContainerName: "agent-legacy-blue",
            newDigest: params.targetDigest,
          });
        });
        await dbWrite.transaction(params.onConvergedInTx);
        return {
          success: true,
          oldNodeId: "node-legacy-old",
          oldContainerName: "agent-legacy-old",
          newNodeId: "node-legacy-blue",
          newContainerName: "agent-legacy-blue",
          newDigest: params.targetDigest,
        };
      },
    );
    try {
      const processed = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed).toMatchObject({ succeeded: 1, failed: 0 });
    } finally {
      execution.mockRestore();
    }

    const completedUpgrade = await jobsRepository.findByIdForWrite(queuedUpgrade.id);
    expect(completedUpgrade).toMatchObject({ status: "completed" });
    expect(completedUpgrade?.data).not.toHaveProperty("requestId");
    await expect(
      adminAgentImageRolloutService.recoverRequest(seeded.actorUserId, upgradeRequestId),
    ).rejects.toMatchObject({ status: 404 });

    const rollback = await executeRollbackCanary({
      actorUserId: seeded.actorUserId,
      source: { jobId: queuedUpgrade.id },
    });
    expect(rollback.targets).toEqual([
      expect.objectContaining({
        operation: "rollback",
        sourceJobId: queuedUpgrade.id,
        sourceImage: TARGET_IMAGE,
        targetImage: SOURCE_IMAGE,
      }),
    ]);
  });

  test("rollback target pair comes only from one successful durable upgrade audit", async () => {
    const seeded = await seedAgents(1);
    const upgrade = await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const [upgradeJob] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    if (!upgradeJob) throw new Error("expected durable upgrade job");
    await completeUpgradeJob(upgradeJob);

    const rollbackRequestId = nextRequestId();
    const preview = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "rollback",
        requestId: rollbackRequestId,
        dryRun: true,
        source: { jobId: upgradeJob.id },
      },
      seeded.actorUserId,
    );
    expect(preview.targets).toEqual([
      expect.objectContaining({
        operation: "rollback",
        sourceImage: TARGET_IMAGE,
        sourceDigest: TARGET_DIGEST,
        targetImage: SOURCE_IMAGE,
        targetDigest: SOURCE_DIGEST,
        sourceRolloutId: upgrade.rolloutId,
        sourceJobId: upgradeJob.id,
      }),
    ]);
    expect(await dbWrite.select().from(jobs)).toHaveLength(1);

    const rollback = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "rollback",
        requestId: rollbackRequestId,
        dryRun: false,
        expectedPlanFingerprint: preview.planFingerprint,
        source: { jobId: upgradeJob.id },
      },
      seeded.actorUserId,
    );
    expect(rollback.targets[0]).toMatchObject({
      sourceImage: TARGET_IMAGE,
      targetImage: SOURCE_IMAGE,
      sourceJobId: upgradeJob.id,
    });
    expect(await dbWrite.select().from(jobs)).toHaveLength(2);
  });

  test("rollout rollback resolves every target from primary durable jobs", async () => {
    const seeded = await seedAgents(2);
    const upgrade = await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const upgradeJobs = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    for (const job of upgradeJobs) {
      await completeUpgradeJob(job);
    }
    if (!upgrade.rolloutId) {
      throw new Error("Expected upgrade rollout ID");
    }

    const rollback = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "rollback",
        requestId: nextRequestId(),
        dryRun: true,
        source: { rolloutId: upgrade.rolloutId },
      },
      seeded.actorUserId,
    );
    expect(rollback.targets).toHaveLength(2);
    expect(rollback.targets.map((target) => target.agentId).sort()).toEqual(
      seeded.targets.map((target) => target.agentId).sort(),
    );
    for (const target of rollback.targets) {
      expect(target).toMatchObject({
        operation: "rollback",
        sourceImage: TARGET_IMAGE,
        sourceDigest: TARGET_DIGEST,
        targetImage: SOURCE_IMAGE,
        targetDigest: SOURCE_DIGEST,
        sourceRolloutId: upgrade.rolloutId,
      });
      expect(target.sourceJobId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await dbWrite.select().from(jobs)).toHaveLength(2);
  });

  test("demo-repository agents stay outside canonical reconcile and re-enter after rollback", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite
      .update(agentSandboxes)
      .set({ docker_image: TARGET_IMAGE, image_digest: TARGET_DIGEST })
      .where(eq(agentSandboxes.id, agentId));

    expect(
      await agentSandboxesRepository.listRunningWithDigestOtherThan(NEXT_DIGEST, SOURCE_IMAGE, 10),
    ).toHaveLength(0);

    await dbWrite
      .update(agentSandboxes)
      .set({ docker_image: SOURCE_IMAGE, image_digest: SOURCE_DIGEST })
      .where(eq(agentSandboxes.id, agentId));
    expect(
      await agentSandboxesRepository.listRunningWithDigestOtherThan(NEXT_DIGEST, SOURCE_IMAGE, 10),
    ).toEqual([
      expect.objectContaining({
        id: agentId,
        docker_image: SOURCE_IMAGE,
        image_digest: SOURCE_DIGEST,
      }),
    ]);
  });

  test("ordinary and canary claims share one transaction-locked three-running budget", async () => {
    const seeded = await seedAgents(5);
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    for (let index = 0; index < 2; index += 1) {
      await dbWrite.insert(jobs).values({
        type: JOB_TYPES.AGENT_UPGRADE,
        status: "in_progress",
        organization_id: seeded.targets[index]!.organizationId,
        user_id: seeded.actorUserId,
        data_storage: "inline",
        data: {
          agentId: seeded.targets[index]!.agentId,
          organizationId: seeded.targets[index]!.organizationId,
          userId: seeded.actorUserId,
          dockerImage: SOURCE_IMAGE,
          fromDigest: SOURCE_DIGEST,
          toDigest: NEXT_DIGEST,
        },
        max_attempts: 1,
      });
    }

    const claimed = await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      maxRunning: 3,
      limit: 5,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("in_progress");

    const secondClaim = await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      maxRunning: 3,
      limit: 5,
    });
    expect(secondClaim).toHaveLength(0);
  });

  test("primary audit queries preserve identity and interrupted canaries fail closed", async () => {
    const seeded = await seedAgents(1);
    const rollout = await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    if (!rollout.rolloutId) throw new Error("expected durable rollout ID");
    const [persisted] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    if (!persisted) throw new Error("expected durable canary job");

    const primary = await jobsRepository.findByIdForWrite(persisted.id);
    expect(primary?.id).toBe(persisted.id);
    expect(await jobsRepository.findById(persisted.id)).toMatchObject({
      id: persisted.id,
      organization_id: seeded.targets[0]!.organizationId,
    });
    expect(
      await jobsRepository.findByIdAndOrg(persisted.id, seeded.targets[0]!.organizationId),
    ).toMatchObject({ id: persisted.id });
    expect(
      await jobsRepository.findByIdAndOrg(persisted.id, "00000000-0000-4000-8000-000000000099"),
    ).toBeUndefined();
    expect(
      await jobsRepository.findAdminCanaryRolloutForWrite(
        JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
        rollout.rolloutId,
      ),
    ).toEqual([expect.objectContaining({ id: persisted.id })]);
    expect(
      await jobsRepository.findByFilters({
        type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
        status: "pending",
        organizationId: seeded.targets[0]!.organizationId,
        limit: 5,
        orderBy: "desc",
      }),
    ).toEqual([expect.objectContaining({ id: persisted.id })]);
    expect(
      await jobsRepository.findByDataField({
        type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
        organizationId: seeded.targets[0]!.organizationId,
        dataField: "agentId",
        dataValue: seeded.targets[0]!.agentId,
      }),
    ).toEqual([expect.objectContaining({ id: persisted.id })]);
    expect(
      await jobsRepository.findByDataFieldForWrite({
        type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
        organizationId: seeded.targets[0]!.organizationId,
        dataField: "agentId",
        dataValue: seeded.targets[0]!.agentId,
        orderBy: "desc",
      }),
    ).toEqual([expect.objectContaining({ id: persisted.id })]);
    expect(await jobsRepository.countInFlightByType(JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE)).toBe(1);
    expect(await jobsRepository.findLatestCreatedAt()).toBeInstanceOf(Date);
    expect(
      await jobsRepository.countInFlightByTypes([
        JOB_TYPES.AGENT_UPGRADE,
        JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      ]),
    ).toBe(1);
    expect(await jobsRepository.countInFlightByTypes([])).toBe(0);

    expect(
      await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
        type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
        sharedTypes: [],
        maxRunning: 3,
        limit: 1,
      }),
    ).toEqual([]);
    const claimed = await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      maxRunning: 3,
      limit: 1,
      organizationId: seeded.targets[0]!.organizationId,
    });
    expect(claimed).toEqual([expect.objectContaining({ id: persisted.id })]);

    await dbWrite
      .update(jobs)
      .set({
        started_at: new Date("2026-07-22T00:00:00.000Z"),
        // An uncommitted canary at the interruption bound must fail closed
        // rather than recover forever (#17473).
        execution_interruptions: 5,
      })
      .where(eq(jobs.id, persisted.id));
    await expireExecutionLease(persisted.id);
    expect(
      (
        await jobsRepository.recoverInProgressJobsStartedBefore({
          type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
          organizationId: seeded.targets[0]!.organizationId,
          startedBefore: new Date("2026-07-23T00:00:00.000Z"),
        })
      ).retried,
    ).toBe(0);
    expect(await jobsRepository.findByIdForWrite(persisted.id)).toMatchObject({
      status: "failed",
      attempts: 0,
      execution_interruptions: 6,
      error: expect.stringContaining("interruption bound reached"),
    });
  });

  test("a post-cutover worker restart resumes cleanup, completes the audit, and stays rollback-readable", async () => {
    const seeded = await seedAgents(1);
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-1",
      hostname: "node-1.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 1,
    });
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const [claimed] = await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      maxRunning: 3,
      limit: 1,
      organizationId: seeded.organizationId,
    });
    if (!claimed) throw new Error("expected claimed canary job");
    const data = readAdminCanaryImageJobData(claimed);
    const startedAt = new Date("2026-07-23T00:00:00.000Z");
    const cutoverAt = new Date("2026-07-23T00:01:00.000Z");
    const pendingCutover = {
      success: false,
      cleanupPending: true,
      cutoverAt: cutoverAt.toISOString(),
      jobId: claimed.id,
      operation: data.operation,
      rolloutId: data.rolloutId,
      actorUserId: data.actorUserId,
      decisionAt: data.decisionAt,
      agentId: data.agentId,
      organizationId: data.organizationId,
      targetOwnerUserId: data.targetOwnerUserId,
      sourceImage: data.sourceImage,
      sourceDigest: data.sourceDigest,
      targetImage: data.targetImage,
      targetDigest: data.targetDigest,
      startedAt: startedAt.toISOString(),
      finishedAt: cutoverAt.toISOString(),
      oldNodeId: "node-1",
      oldContainerName: "agent-1",
      newNodeId: "node-blue",
      newContainerName: "agent-blue",
    };
    await dbWrite.transaction(async (tx) => {
      await tx
        .update(agentSandboxes)
        .set({
          sandbox_id: "sandbox-blue",
          node_id: "node-blue",
          container_name: "agent-blue",
          docker_image: data.targetImage,
          image_digest: data.targetDigest,
          previous_docker_image: data.sourceImage,
          previous_image_digest: data.sourceDigest,
          replacement_cleanup_sandbox_id: "sandbox-1",
          replacement_cleanup_node_id: "node-1",
          replacement_cleanup_container_name: "agent-1",
          replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
          replacement_cleanup_container_id: "sha256:container-old",
          replacement_cleanup_vpn_node_id: "vpn-old",
          replacement_cleanup_vpn_node_name: "agent-old-vpn",
          replacement_cleanup_preserved_vpn_node_id: null,
          replacement_cleanup_vpn_registration_started_at: new Date(REPLACEMENT_STARTED_AT),
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: cutoverAt,
        })
        .where(eq(agentSandboxes.id, data.agentId));
      await tx
        .update(jobs)
        .set({
          result: pendingCutover,
          result_storage: "inline",
          result_key: null,
          error: null,
          error_storage: "inline",
          error_key: null,
          started_at: startedAt,
          completed_at: null,
          updated_at: cutoverAt,
        })
        .where(eq(jobs.id, claimed.id));
    });
    await expireExecutionLease(claimed.id);

    expect(
      (
        await jobsRepository.recoverInProgressJobsStartedBefore({
          type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
          organizationId: seeded.organizationId,
          startedBefore: new Date("2026-07-23T00:02:00.000Z"),
        })
      ).retried,
    ).toBe(1);
    expect(await jobsRepository.findByIdForWrite(claimed.id)).toMatchObject({
      status: "pending",
      attempts: 0,
      result: pendingCutover,
      error: expect.stringContaining("without consuming a terminal attempt"),
    });

    const cleanupProvider = new DockerSandboxProvider();
    const remoteCleanup = spyOn(
      cleanupProvider,
      "stopOnSpecificNodeForReplacement",
    ).mockImplementation(async () => {
      expect(await jobsRepository.findByIdForWrite(claimed.id)).toMatchObject({
        status: "in_progress",
        result: { cleanupPending: true },
      });
      expect(
        await agentSandboxesRepository.findByIdAndOrg(data.agentId, data.organizationId),
      ).toMatchObject({
        replacement_cleanup_sandbox_id: "sandbox-1",
        replacement_cleanup_allocation_counted: true,
      });
    });
    const cleanupService = new ElizaSandboxService(cleanupProvider as unknown as SandboxProvider);
    const converge = spyOn(
      elizaSandboxService,
      "convergeReplacementCleanupFence",
    ).mockImplementation((agentId, organizationId, expectation, onConvergedInTx) =>
      cleanupService.convergeReplacementCleanupFence(
        agentId,
        organizationId,
        expectation,
        onConvergedInTx,
      ),
    );
    const duplicateExecution = spyOn(
      elizaSandboxService,
      "executeAdminCanaryUpgrade",
    ).mockImplementation(async () => {
      throw new Error("post-cutover recovery must not execute a second image swap");
    });
    try {
      const processed = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed).toMatchObject({
        claimed: 1,
        succeeded: 1,
        retried: 0,
        failed: 0,
      });
      expect(converge).toHaveBeenCalledWith(
        data.agentId,
        data.organizationId,
        expect.objectContaining({
          targetOwnerUserId: data.targetOwnerUserId,
          targetDigest: data.targetDigest,
          oldNodeId: "node-1",
          newNodeId: "node-blue",
        }),
        expect.any(Function),
      );
      expect(remoteCleanup).toHaveBeenCalledWith(
        "node-1",
        "agent-1",
        "vpn-old",
        expect.objectContaining({
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
          containerId: "sha256:container-old",
          allocationCounted: true,
        }),
      );
      expect(duplicateExecution).not.toHaveBeenCalled();
      expect(
        await agentSandboxesRepository.findByIdAndOrg(data.agentId, data.organizationId),
      ).toMatchObject({
        replacement_cleanup_sandbox_id: null,
        replacement_cleanup_node_id: null,
        replacement_cleanup_container_name: null,
        replacement_cleanup_attempt_id: null,
        replacement_cleanup_container_id: null,
        replacement_cleanup_allocation_counted: null,
      });
      expect(
        (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-1")))[0]
          ?.allocated_count,
      ).toBe(0);
      expect(await jobsRepository.findByIdForWrite(claimed.id)).toMatchObject({
        status: "completed",
        attempts: 0,
        error: null,
        result: {
          success: true,
          cleanupPending: false,
          jobId: claimed.id,
          operation: "upgrade",
          rolloutId: data.rolloutId,
          agentId: data.agentId,
          sourceImage: SOURCE_IMAGE,
          sourceDigest: SOURCE_DIGEST,
          targetImage: TARGET_IMAGE,
          targetDigest: TARGET_DIGEST,
        },
      });

      const rollback = await adminAgentImageRolloutService.previewOrEnqueue(
        {
          operation: "rollback",
          requestId: nextRequestId(),
          dryRun: true,
          source: { jobId: claimed.id },
        },
        seeded.actorUserId,
      );
      expect(rollback.targets).toEqual([
        expect.objectContaining({
          operation: "rollback",
          agentId: data.agentId,
          sourceImage: TARGET_IMAGE,
          sourceDigest: TARGET_DIGEST,
          targetImage: SOURCE_IMAGE,
          targetDigest: SOURCE_DIGEST,
          sourceRolloutId: data.rolloutId,
          sourceJobId: claimed.id,
        }),
      ]);
    } finally {
      converge.mockRestore();
      remoteCleanup.mockRestore();
      duplicateExecution.mockRestore();
    }
  });

  test("post-cutover cleanup failure requeues immediately, then a scheduled claim converges exactly once", async () => {
    const seeded = await seedAgents(1);
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-1",
      hostname: "node-1.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 1,
    });
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });

    const execution = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockImplementation(
      async (params) => {
        await dbWrite.transaction(async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              sandbox_id: "sandbox-blue",
              node_id: "node-blue",
              container_name: "agent-blue",
              docker_image: params.targetImage,
              image_digest: params.targetDigest,
              previous_docker_image: params.sourceImage,
              previous_image_digest: params.sourceDigest,
              replacement_cleanup_sandbox_id: "sandbox-1",
              replacement_cleanup_node_id: "node-1",
              replacement_cleanup_container_name: "agent-1",
              replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
              replacement_cleanup_container_id: "sha256:container-old",
              replacement_cleanup_vpn_node_id: "vpn-old",
              replacement_cleanup_vpn_node_name: "agent-old-vpn",
              replacement_cleanup_preserved_vpn_node_id: null,
              replacement_cleanup_vpn_registration_started_at: new Date(REPLACEMENT_STARTED_AT),
              replacement_cleanup_allocation_counted: true,
              replacement_cleanup_created_at: new Date(),
            })
            .where(eq(agentSandboxes.id, params.agentId));
          await params.onCutoverInTx(tx, {
            oldNodeId: "node-1",
            oldContainerName: "agent-1",
            newNodeId: "node-blue",
            newContainerName: "agent-blue",
            newDigest: params.targetDigest,
          });
        });
        return {
          success: true,
          cleanupPending: true,
          oldNodeId: "node-1",
          oldContainerName: "agent-1",
          newNodeId: "node-blue",
          newContainerName: "agent-blue",
          newDigest: params.targetDigest,
          error: "old placement cleanup transport unavailable",
        };
      },
    );

    try {
      const first = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(first).toMatchObject({ claimed: 1, succeeded: 0, retried: 1, failed: 0 });
      expect(execution).toHaveBeenCalledTimes(1);

      const [pending] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      if (!pending) throw new Error("expected requeued canary job");
      expect(pending).toMatchObject({
        status: "pending",
        attempts: 0,
        result: {
          success: false,
          cleanupPending: true,
          oldNodeId: "node-1",
          newNodeId: "node-blue",
        },
        error: "old placement cleanup transport unavailable",
      });
      await dbWrite
        .update(jobs)
        .set({ scheduled_for: new Date(0) })
        .where(eq(jobs.id, pending.id));

      const cleanupProvider = new DockerSandboxProvider();
      const remoteCleanup = spyOn(
        cleanupProvider,
        "stopOnSpecificNodeForReplacement",
      ).mockResolvedValue(undefined);
      const cleanupService = new ElizaSandboxService(cleanupProvider as unknown as SandboxProvider);
      const converge = spyOn(
        elizaSandboxService,
        "convergeReplacementCleanupFence",
      ).mockImplementation((agentId, organizationId, expectation, onConvergedInTx) =>
        cleanupService.convergeReplacementCleanupFence(
          agentId,
          organizationId,
          expectation,
          onConvergedInTx,
        ),
      );
      try {
        const second = await provisioningJobService.processPendingJobs(1, {
          jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
        });
        expect(second).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, failed: 0 });
        expect(execution).toHaveBeenCalledTimes(1);
        expect(remoteCleanup).toHaveBeenCalledTimes(1);
        expect(await jobsRepository.findByIdForWrite(pending.id)).toMatchObject({
          status: "completed",
          attempts: 0,
          error: null,
          result: {
            success: true,
            cleanupPending: false,
            oldNodeId: "node-1",
            newNodeId: "node-blue",
          },
        });
        expect(
          await agentSandboxesRepository.findByIdAndOrg(
            seeded.targets[0]!.agentId,
            seeded.organizationId,
          ),
        ).toMatchObject({
          replacement_cleanup_sandbox_id: null,
          replacement_cleanup_node_id: null,
          replacement_cleanup_container_name: null,
        });
        expect(
          (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-1")))[0]
            ?.allocated_count,
        ).toBe(0);
      } finally {
        converge.mockRestore();
        remoteCleanup.mockRestore();
      }
    } finally {
      execution.mockRestore();
    }
  });

  test("an already-cleaned cutover completes only while the exact serving generation remains active", async () => {
    const seeded = await seedAgents(1);
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const [claimed] = await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      maxRunning: 3,
      limit: 1,
      organizationId: seeded.organizationId,
    });
    if (!claimed) throw new Error("expected claimed canary job");
    const data = readAdminCanaryImageJobData(claimed);
    const startedAt = new Date("2026-07-23T02:00:00.000Z");
    const cutoverAt = new Date("2026-07-23T02:01:00.000Z");
    const pendingCutover = pendingCutoverAuditFor(claimed, data, {
      startedAt,
      cutoverAt,
    });
    await dbWrite.transaction(async (tx) => {
      await tx
        .update(agentSandboxes)
        .set({
          sandbox_id: "sandbox-blue",
          node_id: "node-blue",
          container_name: "agent-blue",
          docker_image: data.targetImage,
          image_digest: data.targetDigest,
          previous_docker_image: data.sourceImage,
          previous_image_digest: data.sourceDigest,
        })
        .where(eq(agentSandboxes.id, data.agentId));
      await tx
        .update(jobs)
        .set({
          result: pendingCutover,
          result_storage: "inline",
          result_key: null,
          started_at: startedAt,
          completed_at: null,
          updated_at: cutoverAt,
        })
        .where(eq(jobs.id, claimed.id));
    });
    await expireExecutionLease(claimed.id);
    expect(
      (
        await jobsRepository.recoverInProgressJobsStartedBefore({
          type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
          organizationId: seeded.organizationId,
          startedBefore: new Date("2026-07-23T02:02:00.000Z"),
        })
      ).retried,
    ).toBe(1);

    const duplicateExecution = spyOn(
      elizaSandboxService,
      "executeAdminCanaryUpgrade",
    ).mockImplementation(async () => {
      throw new Error("already-cleaned recovery must not execute a second image swap");
    });
    try {
      expect(
        await provisioningJobService.processPendingJobs(1, {
          jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
        }),
      ).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, failed: 0 });
      expect(duplicateExecution).not.toHaveBeenCalled();
      expect(await jobsRepository.findByIdForWrite(claimed.id)).toMatchObject({
        status: "completed",
        attempts: 0,
        result: {
          success: true,
          cleanupPending: false,
          jobId: claimed.id,
          targetDigest: TARGET_DIGEST,
        },
      });
    } finally {
      duplicateExecution.mockRestore();
    }
  });

  test("a stale cutover audit cannot retire cleanup or publish success after serving generation changes", async () => {
    const seeded = await seedAgents(1);
    await dbWrite.insert(dockerNodes).values({
      node_id: "node-later",
      hostname: "node-later.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 1,
    });
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const [claimed] = await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      maxRunning: 3,
      limit: 1,
      organizationId: seeded.organizationId,
    });
    if (!claimed) throw new Error("expected claimed canary job");
    const data = readAdminCanaryImageJobData(claimed);
    const startedAt = new Date("2026-07-23T03:00:00.000Z");
    const cutoverAt = new Date("2026-07-23T03:01:00.000Z");
    const pendingCutover = pendingCutoverAuditFor(claimed, data, {
      startedAt,
      cutoverAt,
    });
    await dbWrite.transaction(async (tx) => {
      await tx
        .update(agentSandboxes)
        .set({
          sandbox_id: "sandbox-next",
          node_id: "node-next",
          container_name: "agent-next",
          docker_image: data.sourceImage,
          image_digest: data.sourceDigest,
          previous_docker_image: data.sourceImage,
          previous_image_digest: data.sourceDigest,
          replacement_cleanup_sandbox_id: "sandbox-later",
          replacement_cleanup_node_id: "node-later",
          replacement_cleanup_container_name: "agent-later",
          replacement_cleanup_attempt_id: REPLACEMENT_ATTEMPT_ID,
          replacement_cleanup_container_id: "sha256:container-later",
          replacement_cleanup_vpn_node_id: null,
          replacement_cleanup_vpn_node_name: null,
          replacement_cleanup_preserved_vpn_node_id: null,
          replacement_cleanup_vpn_registration_started_at: null,
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: cutoverAt,
        })
        .where(eq(agentSandboxes.id, data.agentId));
      await tx
        .update(jobs)
        .set({
          result: pendingCutover,
          result_storage: "inline",
          result_key: null,
          started_at: startedAt,
          completed_at: null,
          updated_at: cutoverAt,
        })
        .where(eq(jobs.id, claimed.id));
    });
    await expireExecutionLease(claimed.id);
    expect(
      (
        await jobsRepository.recoverInProgressJobsStartedBefore({
          type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
          organizationId: seeded.organizationId,
          startedBefore: new Date("2026-07-23T03:02:00.000Z"),
        })
      ).retried,
    ).toBe(1);

    const cleanupProvider = new DockerSandboxProvider();
    const remoteCleanup = spyOn(
      cleanupProvider,
      "stopOnSpecificNodeForReplacement",
    ).mockResolvedValue(undefined);
    const cleanupService = new ElizaSandboxService(cleanupProvider as unknown as SandboxProvider);
    const converge = spyOn(
      elizaSandboxService,
      "convergeReplacementCleanupFence",
    ).mockImplementation((agentId, organizationId, expectation, onConvergedInTx) =>
      cleanupService.convergeReplacementCleanupFence(
        agentId,
        organizationId,
        expectation,
        onConvergedInTx,
      ),
    );
    const duplicateExecution = spyOn(
      elizaSandboxService,
      "executeAdminCanaryUpgrade",
    ).mockImplementation(async () => {
      throw new Error("stale recovery must not execute a second image swap");
    });
    try {
      expect(
        await provisioningJobService.processPendingJobs(1, {
          jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
        }),
      ).toMatchObject({ claimed: 1, succeeded: 0, retried: 0, failed: 1 });
      expect(remoteCleanup).not.toHaveBeenCalled();
      expect(duplicateExecution).not.toHaveBeenCalled();
      expect(
        await agentSandboxesRepository.findByIdAndOrg(data.agentId, data.organizationId),
      ).toMatchObject({
        replacement_cleanup_sandbox_id: "sandbox-later",
        replacement_cleanup_node_id: "node-later",
        replacement_cleanup_container_name: "agent-later",
        replacement_cleanup_allocation_counted: true,
      });
      expect(
        (await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, "node-later")))[0]
          ?.allocated_count,
      ).toBe(1);
      expect(await jobsRepository.findByIdForWrite(claimed.id)).toMatchObject({
        status: "failed",
        attempts: 1,
        result: {
          success: false,
          jobId: claimed.id,
          error: expect.stringContaining("serving generation changed"),
        },
      });
    } finally {
      converge.mockRestore();
      remoteCleanup.mockRestore();
      duplicateExecution.mockRestore();
    }
  });

  test("direct canary enqueue rejects empty and duplicate target sets without writes", async () => {
    const seeded = await seedAgents(1);
    const decisionAt = new Date("2026-07-23T00:00:00.000Z").toISOString();

    await expect(
      provisioningJobService.enqueueAdminCanaryImageRollout({
        rolloutId: "00000000-0000-4000-8000-000000000020",
        actorUserId: seeded.actorUserId,
        decisionAt,
        requestId: "00000000-0000-4000-8000-000000000120",
        planFingerprint: `sha256:${"1".repeat(64)}`,
        canonicalRequestHash: `sha256:${"2".repeat(64)}`,
        targets: [],
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const target = {
      operation: "upgrade" as const,
      agentId: seeded.targets[0]!.agentId,
      organizationId: seeded.targets[0]!.organizationId,
      targetOwnerUserId: seeded.actorUserId,
      sourceImage: SOURCE_IMAGE,
      sourceDigest: SOURCE_DIGEST,
      targetImage: TARGET_IMAGE,
      targetDigest: TARGET_DIGEST,
    };
    await expect(
      provisioningJobService.enqueueAdminCanaryImageRollout({
        rolloutId: "00000000-0000-4000-8000-000000000021",
        actorUserId: seeded.actorUserId,
        decisionAt,
        requestId: "00000000-0000-4000-8000-000000000121",
        planFingerprint: `sha256:${"3".repeat(64)}`,
        canonicalRequestHash: `sha256:${"4".repeat(64)}`,
        targets: [target, target],
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("only replacement-worker recovery re-arms an interrupted ordinary image swap", async () => {
    const seeded = await seedAgents(1);
    const enqueued = await provisioningJobService.enqueueAgentUpgradeOnce({
      agentId: seeded.targets[0]!.agentId,
      organizationId: seeded.targets[0]!.organizationId,
      userId: seeded.actorUserId,
      dockerImage: SOURCE_IMAGE,
      fromDigest: SOURCE_DIGEST,
      toDigest: NEXT_DIGEST,
    });
    const claimed = await jobsRepository.claimPendingJobs({
      type: JOB_TYPES.AGENT_UPGRADE,
      organizationId: seeded.targets[0]!.organizationId,
      limit: 1,
    });
    expect(claimed).toEqual([expect.objectContaining({ id: enqueued.job.id })]);
    await dbWrite
      .update(jobs)
      .set({ started_at: new Date(Date.now() - 60_000) })
      .where(eq(jobs.id, enqueued.job.id));

    expect(
      (
        await jobsRepository.recoverStaleJobs({
          type: JOB_TYPES.AGENT_UPGRADE,
          organizationId: seeded.targets[0]!.organizationId,
          staleThresholdMs: 1_000,
          maxAttempts: 3,
        })
      ).retried,
    ).toBe(0);
    await expireExecutionLease(enqueued.job.id);
    expect(
      (
        await provisioningJobService.recoverInterruptedJobsOnStartup(new Date(), [
          JOB_TYPES.AGENT_UPGRADE,
        ])
      ).retried,
    ).toBe(1);
    expect(await jobsRepository.findByIdForWrite(enqueued.job.id)).toMatchObject({
      status: "pending",
      // Restart recovery spends the interruption budget, never an attempt
      // (#17473).
      attempts: 0,
      execution_interruptions: 1,
      error: expect.stringContaining("recovered for retry (interruption 1/5)"),
    });
    expect(
      await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
        type: JOB_TYPES.AGENT_UPGRADE,
        sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
        maxRunning: 3,
        limit: 1,
        organizationId: seeded.targets[0]!.organizationId,
      }),
    ).toEqual([expect.objectContaining({ id: enqueued.job.id })]);
  });

  test("one worker cycle drains ordinary and canary image changes through their distinct policies", async () => {
    const seeded = await seedAgents(2);
    await provisioningJobService.enqueueAgentUpgradeOnce({
      agentId: seeded.targets[0]!.agentId,
      organizationId: seeded.targets[0]!.organizationId,
      userId: seeded.actorUserId,
      dockerImage: SOURCE_IMAGE,
      fromDigest: SOURCE_DIGEST,
      toDigest: NEXT_DIGEST,
    });
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: [seeded.targets[1]!],
    });

    const ordinaryExecution = spyOn(elizaSandboxService, "executeUpgrade").mockResolvedValue({
      success: true,
      oldNodeId: "ordinary-old-node",
      oldContainerName: "ordinary-old",
      newNodeId: "ordinary-new-node",
      newContainerName: "ordinary-new",
      newDigest: NEXT_DIGEST,
    });
    const canaryExecution = spyOn(
      elizaSandboxService,
      "executeAdminCanaryUpgrade",
    ).mockImplementation(async (params) => {
      await dbWrite.transaction(async (tx) => {
        await tx
          .update(agentSandboxes)
          .set({
            node_id: "canary-new-node",
            container_name: "canary-new",
            docker_image: params.targetImage,
            image_digest: params.targetDigest,
            previous_docker_image: params.sourceImage,
            previous_image_digest: params.sourceDigest,
          })
          .where(eq(agentSandboxes.id, params.agentId));
        await params.onCutoverInTx(tx, {
          oldNodeId: "canary-old-node",
          oldContainerName: "canary-old",
          newNodeId: "canary-new-node",
          newContainerName: "canary-new",
          newDigest: params.targetDigest,
        });
      });
      await dbWrite.transaction(params.onConvergedInTx);
      return {
        success: true,
        oldNodeId: "canary-old-node",
        oldContainerName: "canary-old",
        newNodeId: "canary-new-node",
        newContainerName: "canary-new",
        newDigest: params.targetDigest,
      };
    });
    try {
      const processed = await provisioningJobService.processPendingJobs(2, {
        jobTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed).toMatchObject({
        claimed: 2,
        succeeded: 2,
        failed: 0,
      });
      expect(ordinaryExecution).toHaveBeenCalledTimes(1);
      expect(canaryExecution).toHaveBeenCalledTimes(1);
      const persisted = await dbWrite.select().from(jobs);
      expect(persisted).toHaveLength(2);
      expect(persisted.every((job) => job.status === "completed")).toBe(true);
      expect(persisted.find((job) => job.type === JOB_TYPES.AGENT_UPGRADE)?.result).toMatchObject({
        oldNodeId: "ordinary-old-node",
        newNodeId: "ordinary-new-node",
        newDigest: NEXT_DIGEST,
      });
      expect(
        persisted.find((job) => job.type === JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE)?.result,
      ).toMatchObject({
        operation: "upgrade",
        oldNodeId: "canary-old-node",
        newNodeId: "canary-new-node",
        targetDigest: TARGET_DIGEST,
      });
    } finally {
      ordinaryExecution.mockRestore();
      canaryExecution.mockRestore();
    }
  });

  test("a canary does not block sibling lifecycle, diagnostics, or backup policy", async () => {
    const seeded = await seedAgents(5);
    await provisioningJobService.enqueueAgentRestartOnce({
      agentId: seeded.targets[0]!.agentId,
      organizationId: seeded.targets[0]!.organizationId,
      userId: seeded.actorUserId,
    });
    await provisioningJobService.enqueueAgentDowngradeOnce({
      agentId: seeded.targets[1]!.agentId,
      organizationId: seeded.targets[1]!.organizationId,
      userId: seeded.actorUserId,
      dockerImage: SOURCE_IMAGE,
      fromDigest: TARGET_DIGEST,
    });
    await provisioningJobService.enqueueAgentLogsOnce({
      agentId: seeded.targets[2]!.agentId,
      organizationId: seeded.targets[2]!.organizationId,
      userId: seeded.actorUserId,
      tail: 200,
    });
    await provisioningJobService.enqueueAgentSnapshotOnce({
      agentId: seeded.targets[3]!.agentId,
      organizationId: seeded.targets[3]!.organizationId,
      userId: seeded.actorUserId,
      snapshotType: "auto",
    });
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: [seeded.targets[4]!],
    });

    const restartExecution = spyOn(elizaSandboxService, "executeRestart").mockResolvedValue({
      success: true,
      containerStopped: true,
      containerStarted: true,
      bridgeUrl: "http://10.0.0.10:3000",
      healthUrl: "http://10.0.0.10:3000/health",
    });
    const downgradeExecution = spyOn(elizaSandboxService, "executeDowngrade").mockResolvedValue({
      success: true,
      oldNodeId: "rollback-old-node",
      oldContainerName: "rollback-old",
      newNodeId: "rollback-new-node",
      newContainerName: "rollback-new",
      newDigest: SOURCE_DIGEST,
    });
    const logsExecution = spyOn(elizaSandboxService, "executeLogs").mockResolvedValue({
      success: true,
      status: "running",
      logs: "[agent] ready for demo",
    });
    const snapshotExecution = spyOn(elizaSandboxService, "executeSnapshot").mockResolvedValue({
      success: false,
      error: SNAPSHOT_ENDPOINT_UNSUPPORTED,
    });
    const canaryExecution = spyOn(
      elizaSandboxService,
      "executeAdminCanaryUpgrade",
    ).mockImplementation(async (params) => {
      await dbWrite.transaction(async (tx) => {
        await params.onCutoverInTx(tx, {
          oldNodeId: "canary-old-node",
          oldContainerName: "canary-old",
          newNodeId: "canary-new-node",
          newContainerName: "canary-new",
          newDigest: params.targetDigest,
        });
      });
      await dbWrite.transaction(params.onConvergedInTx);
      return {
        success: true,
        oldNodeId: "canary-old-node",
        oldContainerName: "canary-old",
        newNodeId: "canary-new-node",
        newContainerName: "canary-new",
        newDigest: params.targetDigest,
      };
    });
    // This contract exercises coexistence when operators explicitly enable the
    // snapshot lane; its production default remains fail-closed.
    const previousSnapshotGate = process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
    process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = "true";
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [
          JOB_TYPES.AGENT_RESTART,
          JOB_TYPES.AGENT_DOWNGRADE,
          JOB_TYPES.AGENT_LOGS,
          JOB_TYPES.AGENT_SNAPSHOT,
          JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
        ],
      });
      expect(processed).toMatchObject({
        claimed: 5,
        succeeded: 5,
        failed: 0,
      });
      expect(restartExecution).toHaveBeenCalledTimes(1);
      expect(downgradeExecution).toHaveBeenCalledTimes(1);
      expect(logsExecution).toHaveBeenCalledWith(
        seeded.targets[2]!.agentId,
        seeded.targets[2]!.organizationId,
        200,
      );
      expect(snapshotExecution).toHaveBeenCalledWith(
        seeded.targets[3]!.agentId,
        seeded.targets[3]!.organizationId,
        "auto",
      );
      expect(canaryExecution).toHaveBeenCalledTimes(1);
      const persisted = await dbWrite.select().from(jobs);
      expect(persisted).toHaveLength(5);
      expect(persisted.every((job) => job.status === "completed")).toBe(true);
      expect(persisted.find((job) => job.type === JOB_TYPES.AGENT_SNAPSHOT)?.result).toMatchObject({
        skipped: true,
        reason: SNAPSHOT_ENDPOINT_UNSUPPORTED,
      });
    } finally {
      restartExecution.mockRestore();
      downgradeExecution.mockRestore();
      logsExecution.mockRestore();
      snapshotExecution.mockRestore();
      canaryExecution.mockRestore();
      if (previousSnapshotGate === undefined) {
        delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
      } else {
        process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = previousSnapshotGate;
      }
    }
  });

  test("a queued canary does not block a real chat job for that same running agent", async () => {
    const seeded = await seedAgents(1);
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const chat = await provisioningJobService.enqueueAgentMessage({
      agentId: seeded.targets[0]!.agentId,
      organizationId: seeded.targets[0]!.organizationId,
      userId: seeded.actorUserId,
      text: "Confirm the demo agent remains responsive.",
      senderId: seeded.actorUserId,
      sessionId: "demo-rehearsal",
      roomId: "main",
    });
    const bridge = spyOn(elizaSandboxService, "bridge").mockResolvedValue({
      jsonrpc: "2.0",
      id: 1,
      result: { text: "Ready for the demo." },
    });
    const canaryExecution = spyOn(
      elizaSandboxService,
      "executeAdminCanaryUpgrade",
    ).mockImplementation(async (params) => {
      await dbWrite.transaction(async (tx) => {
        await params.onCutoverInTx(tx, {
          oldNodeId: "canary-old-node",
          oldContainerName: "canary-old",
          newNodeId: "canary-new-node",
          newContainerName: "canary-new",
          newDigest: params.targetDigest,
        });
      });
      await dbWrite.transaction(params.onConvergedInTx);
      return {
        success: true,
        oldNodeId: "canary-old-node",
        oldContainerName: "canary-old",
        newNodeId: "canary-new-node",
        newContainerName: "canary-new",
        newDigest: params.targetDigest,
      };
    });
    try {
      const processed = await provisioningJobService.processPendingJobs(2, {
        jobTypes: [JOB_TYPES.AGENT_MESSAGE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed).toMatchObject({
        claimed: 2,
        succeeded: 2,
        failed: 0,
      });
      expect(bridge).toHaveBeenCalledWith(
        seeded.targets[0]!.agentId,
        seeded.targets[0]!.organizationId,
        {
          jsonrpc: "2.0",
          method: "message.send",
          params: {
            text: "Confirm the demo agent remains responsive.",
            userId: seeded.actorUserId,
            sessionId: "demo-rehearsal",
            roomId: "main",
          },
        },
      );
      expect(await jobsRepository.findByIdForWrite(chat.job.id)).toMatchObject({
        status: "completed",
        result: {
          cloudAgentId: seeded.targets[0]!.agentId,
          text: "Ready for the demo.",
        },
      });
      expect(canaryExecution).toHaveBeenCalledTimes(1);
    } finally {
      bridge.mockRestore();
      canaryExecution.mockRestore();
    }
  });

  test("a chat 401 is durably failed while the independent canary still completes", async () => {
    const seeded = await seedAgents(1);
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const chat = await provisioningJobService.enqueueAgentMessage({
      agentId: seeded.targets[0]!.agentId,
      organizationId: seeded.targets[0]!.organizationId,
      userId: seeded.actorUserId,
      text: "This request has an expired bridge credential.",
    });
    const bridge = spyOn(elizaSandboxService, "bridge").mockResolvedValue({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "401 unauthorized" },
    });
    const canaryExecution = spyOn(
      elizaSandboxService,
      "executeAdminCanaryUpgrade",
    ).mockImplementation(async (params) => {
      await dbWrite.transaction(async (tx) => {
        await params.onCutoverInTx(tx, {
          oldNodeId: "canary-old-node",
          oldContainerName: "canary-old",
          newNodeId: "canary-new-node",
          newContainerName: "canary-new",
          newDigest: params.targetDigest,
        });
      });
      await dbWrite.transaction(params.onConvergedInTx);
      return {
        success: true,
        oldNodeId: "canary-old-node",
        oldContainerName: "canary-old",
        newNodeId: "canary-new-node",
        newContainerName: "canary-new",
        newDigest: params.targetDigest,
      };
    });
    try {
      const processed = await provisioningJobService.processPendingJobs(2, {
        jobTypes: [JOB_TYPES.AGENT_MESSAGE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed).toMatchObject({
        claimed: 2,
        succeeded: 1,
        failed: 1,
      });
      expect(await jobsRepository.findByIdForWrite(chat.job.id)).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "401 unauthorized",
        result: {
          cloudAgentId: seeded.targets[0]!.agentId,
          error: "401 unauthorized",
        },
      });
      const canaryJobs = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(canaryJobs).toEqual([expect.objectContaining({ status: "completed" })]);
    } finally {
      bridge.mockRestore();
      canaryExecution.mockRestore();
    }
  });

  test("terminal execution failure retains actor, decision, error, and result timestamps", async () => {
    const seeded = await seedAgents(1);
    const rollout = await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const execution = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockResolvedValue({
      success: false,
      error: "blue digest unavailable",
    });
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed.failed).toBe(1);
      const [failed] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(failed?.status).toBe("failed");
      expect(Date.parse(String(failed?.completed_at))).toBeFinite();
      expect(failed?.error).toContain("blue digest unavailable");
      expect(failed?.result).toMatchObject({
        success: false,
        jobId: failed?.id,
        rolloutId: rollout.rolloutId,
        actorUserId: seeded.actorUserId,
        decisionAt: rollout.decisionAt,
        error: "blue digest unavailable",
      });
      if (!failed?.result) throw new Error("expected failed canary audit result");
      const audit = failed.result as { startedAt: string; finishedAt: string };
      expect(Date.parse(audit.startedAt)).toBeFinite();
      expect(Date.parse(audit.finishedAt)).toBeFinite();
    } finally {
      execution.mockRestore();
    }
  });

  test("successful upgrade commits agent cutover and completed audit in one transaction", async () => {
    const seeded = await seedAgents(1);
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const execution = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockImplementation(
      async (params) => {
        await dbWrite.transaction(async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              node_id: "node-blue",
              container_name: "agent-blue",
              docker_image: params.targetImage,
              image_digest: params.targetDigest,
              previous_docker_image: params.sourceImage,
              previous_image_digest: params.sourceDigest,
            })
            .where(eq(agentSandboxes.id, params.agentId));
          await params.onCutoverInTx(tx, {
            oldNodeId: "node-old",
            oldContainerName: "agent-old",
            newNodeId: "node-blue",
            newContainerName: "agent-blue",
            newDigest: params.targetDigest,
          });
        });
        await dbWrite.transaction(params.onConvergedInTx);
        return {
          success: true,
          oldNodeId: "node-old",
          oldContainerName: "agent-old",
          newNodeId: "node-blue",
          newContainerName: "agent-blue",
          newDigest: params.targetDigest,
        };
      },
    );
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed).toMatchObject({ succeeded: 1, failed: 0 });
      const [agent] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      expect(agent).toMatchObject({
        node_id: "node-blue",
        container_name: "agent-blue",
        docker_image: TARGET_IMAGE,
        image_digest: TARGET_DIGEST,
        previous_docker_image: SOURCE_IMAGE,
        previous_image_digest: SOURCE_DIGEST,
      });
      const [completed] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(completed).toMatchObject({
        status: "completed",
        result_storage: "inline",
        error: null,
      });
      expect(completed?.result).toMatchObject({
        success: true,
        operation: "upgrade",
        agentId: seeded.targets[0]!.agentId,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: SOURCE_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
        oldNodeId: "node-old",
        newNodeId: "node-blue",
      });
    } finally {
      execution.mockRestore();
    }
  });

  test("upgrade audit CAS failure rolls back agent cutover before terminal failure audit", async () => {
    const seeded = await seedAgents(1);
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    let blueTornDown = false;
    const execution = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockImplementation(
      async (params) => {
        try {
          await dbWrite.transaction(async (tx) => {
            await tx
              .update(agentSandboxes)
              .set({
                docker_image: params.targetImage,
                image_digest: params.targetDigest,
                previous_docker_image: params.sourceImage,
                previous_image_digest: params.sourceDigest,
              })
              .where(eq(agentSandboxes.id, params.agentId));
            await tx
              .update(jobs)
              .set({ status: "pending" })
              .where(
                and(
                  eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
                  eq(jobs.agent_id, params.agentId),
                  eq(jobs.status, "in_progress"),
                ),
              );
            await params.onCutoverInTx(tx, {
              oldNodeId: "node-old",
              oldContainerName: "agent-old",
              newNodeId: "node-blue",
              newContainerName: "agent-blue",
              newDigest: params.targetDigest,
            });
          });
          return { success: true };
        } catch (error) {
          blueTornDown = true;
          return {
            success: false,
            rolledBack: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed.failed).toBe(1);
      expect(blueTornDown).toBe(true);
      const [agent] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      expect(agent).toMatchObject({
        docker_image: SOURCE_IMAGE,
        image_digest: SOURCE_DIGEST,
        previous_docker_image: null,
        previous_image_digest: null,
      });
      const [failed] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(failed).toMatchObject({
        status: "failed",
        attempts: 1,
      });
      expect(failed?.result).toMatchObject({
        success: false,
        operation: "upgrade",
      });
    } finally {
      execution.mockRestore();
    }
  });

  test("rollback audit CAS failure preserves demo image and completed upgrade source", async () => {
    const seeded = await seedAgents(1);
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const [upgradeJob] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    if (!upgradeJob) throw new Error("expected source upgrade job");
    await completeUpgradeJob(upgradeJob);
    await executeRollbackCanary({
      actorUserId: seeded.actorUserId,
      source: { jobId: upgradeJob.id },
    });

    let blueTornDown = false;
    const execution = spyOn(elizaSandboxService, "executeAdminCanaryRollback").mockImplementation(
      async (params) => {
        try {
          await dbWrite.transaction(async (tx) => {
            await tx
              .update(agentSandboxes)
              .set({
                docker_image: params.targetImage,
                image_digest: params.targetDigest,
                previous_docker_image: null,
                previous_image_digest: null,
              })
              .where(eq(agentSandboxes.id, params.agentId));
            await tx
              .update(jobs)
              .set({ status: "pending" })
              .where(
                and(
                  eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
                  eq(jobs.agent_id, params.agentId),
                  eq(jobs.status, "in_progress"),
                ),
              );
            await params.onCutoverInTx(tx, {
              oldNodeId: "node-demo",
              oldContainerName: "agent-demo",
              newNodeId: "node-canonical",
              newContainerName: "agent-canonical",
              newDigest: params.targetDigest,
            });
          });
          return { success: true };
        } catch (error) {
          blueTornDown = true;
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed.failed).toBe(1);
      expect(blueTornDown).toBe(true);
      const [agent] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      expect(agent).toMatchObject({
        docker_image: TARGET_IMAGE,
        image_digest: TARGET_DIGEST,
        previous_docker_image: SOURCE_IMAGE,
        previous_image_digest: SOURCE_DIGEST,
      });
      const canaryJobs = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(canaryJobs.find((job) => job.id === upgradeJob.id)?.status).toBe("completed");
      const rollbackJob = canaryJobs.find((job) => job.id !== upgradeJob.id);
      expect(rollbackJob).toMatchObject({
        status: "failed",
        attempts: 1,
      });
      expect(rollbackJob?.result).toMatchObject({
        success: false,
        operation: "rollback",
      });
    } finally {
      execution.mockRestore();
    }
  });

  test("successful rollback commits the canonical pair and durable audit atomically", async () => {
    const seeded = await seedAgents(1);
    await executeUpgradeCanary({
      actorUserId: seeded.actorUserId,
      targets: seeded.targets,
    });
    const [upgradeJob] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    if (!upgradeJob) throw new Error("expected source upgrade job");
    await completeUpgradeJob(upgradeJob);
    await executeRollbackCanary({
      actorUserId: seeded.actorUserId,
      source: { jobId: upgradeJob.id },
    });

    const execution = spyOn(elizaSandboxService, "executeAdminCanaryRollback").mockImplementation(
      async (params) => {
        await dbWrite.transaction(async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              node_id: "node-canonical",
              container_name: "agent-canonical",
              docker_image: params.targetImage,
              image_digest: params.targetDigest,
              previous_docker_image: null,
              previous_image_digest: null,
            })
            .where(eq(agentSandboxes.id, params.agentId));
          await params.onCutoverInTx(tx, {
            oldNodeId: "node-demo",
            oldContainerName: "agent-demo",
            newNodeId: "node-canonical",
            newContainerName: "agent-canonical",
            newDigest: params.targetDigest,
          });
        });
        await dbWrite.transaction(params.onConvergedInTx);
        return {
          success: true,
          oldNodeId: "node-demo",
          oldContainerName: "agent-demo",
          newNodeId: "node-canonical",
          newContainerName: "agent-canonical",
          newDigest: params.targetDigest,
        };
      },
    );
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed).toMatchObject({ succeeded: 1, failed: 0 });
      const [agent] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      expect(agent).toMatchObject({
        node_id: "node-canonical",
        container_name: "agent-canonical",
        docker_image: SOURCE_IMAGE,
        image_digest: SOURCE_DIGEST,
        previous_docker_image: null,
        previous_image_digest: null,
      });
      const canaryJobs = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      const rollbackJob = canaryJobs.find((job) => job.id !== upgradeJob.id);
      expect(rollbackJob).toMatchObject({
        status: "completed",
        result_storage: "inline",
        error: null,
      });
      expect(rollbackJob?.result).toMatchObject({
        success: true,
        operation: "rollback",
        sourceImage: TARGET_IMAGE,
        sourceDigest: TARGET_DIGEST,
        targetImage: SOURCE_IMAGE,
        targetDigest: SOURCE_DIGEST,
        oldNodeId: "node-demo",
        newNodeId: "node-canonical",
      });
    } finally {
      execution.mockRestore();
    }
  });
});
