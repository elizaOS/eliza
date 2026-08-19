/**
 * Pins the provisioning daemon's shared ordinary/canary image-change budget
 * and drives its real one-shot entrypoint through deterministic infrastructure
 * boundaries. Primary transaction behavior is covered by the PGlite repository
 * suite.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_WARM_POOL_POLICY } from "@elizaos/cloud-shared/lib/services/containers/agent-warm-pool-forecast";
import {
  __setDepsForTests,
  prePullAllowsPoolImageRollout,
  processFleetUpgradeCycle,
  processPoolImageRolloutCycle,
  readWorkerConfig,
} from "./provisioning-worker";

const configuredImage = "ghcr.io/elizaos/eliza:stable";
const targetDigest = `sha256:${"a".repeat(64)}`;

function installDeps(
  inFlight: number,
  candidates: Array<Record<string, string>> = [],
  maxInflightUpgrades = 3,
) {
  const countInFlightByTypes = mock(async () => inFlight);
  const listRunningWithDigestOtherThan = mock(async () => candidates);
  const enqueueAgentUpgradeOnce = mock(async () => ({
    created: true,
    job: { id: "upgrade-job" },
  }));
  __setDepsForTests({
    containersEnv: {
      defaultAgentImage: () => configuredImage,
      maxInflightUpgrades: () => maxInflightUpgrades,
    },
    resolveImageDigest: async () => targetDigest,
    jobsRepository: { countInFlightByTypes },
    agentSandboxesRepository: { listRunningWithDigestOtherThan },
    provisioningJobService: { enqueueAgentUpgradeOnce },
    envWarmPoolPolicy: () => DEFAULT_WARM_POOL_POLICY,
    logger: { warn: mock(() => {}) },
  } as unknown as Parameters<typeof __setDepsForTests>[0]);
  return {
    countInFlightByTypes,
    listRunningWithDigestOtherThan,
    enqueueAgentUpgradeOnce,
  };
}

afterEach(() => {
  __setDepsForTests(null);
});

describe("processFleetUpgradeCycle shared image-change capacity", () => {
  test("pending or running admin canaries consume ordinary fleet rollout capacity", async () => {
    const deps = installDeps(3);

    const result = await processFleetUpgradeCycle();

    expect(result).toMatchObject({ action: "skip_capacity", inFlight: 3 });
    expect(deps.countInFlightByTypes).toHaveBeenCalledWith([
      "agent_upgrade",
      "agent_admin_canary_image",
    ]);
    expect(deps.listRunningWithDigestOtherThan).not.toHaveBeenCalled();
    expect(deps.enqueueAgentUpgradeOnce).not.toHaveBeenCalled();
  });

  test("an env-configured zero limit pauses rollouts without a source hot patch", async () => {
    const deps = installDeps(0, [], 0);

    const result = await processFleetUpgradeCycle();

    expect(result).toMatchObject({ action: "skip_capacity", inFlight: 0 });
    expect(deps.listRunningWithDigestOtherThan).not.toHaveBeenCalled();
    expect(deps.enqueueAgentUpgradeOnce).not.toHaveBeenCalled();
  });

  test("ordinary reconcile enqueues only the one slot left by shared canary load", async () => {
    const candidate = {
      id: "00000000-0000-4000-8000-000000000001",
      organization_id: "00000000-0000-4000-8000-000000000002",
      user_id: "00000000-0000-4000-8000-000000000003",
      image_digest: `sha256:${"b".repeat(64)}`,
    };
    const deps = installDeps(2, [candidate]);

    const result = await processFleetUpgradeCycle();

    expect(deps.listRunningWithDigestOtherThan).toHaveBeenCalledWith(
      targetDigest,
      configuredImage,
      1,
    );
    expect(deps.enqueueAgentUpgradeOnce).toHaveBeenCalledTimes(1);
    expect(deps.enqueueAgentUpgradeOnce).toHaveBeenCalledWith({
      agentId: candidate.id,
      organizationId: candidate.organization_id,
      userId: candidate.user_id,
      fromDigest: candidate.image_digest,
      toDigest: targetDigest,
      dockerImage: configuredImage,
    });
    expect(result).toMatchObject({
      action: "enqueued",
      candidates: 1,
      enqueued: 1,
      inFlight: 2,
    });
  });
});

describe("warm-pool image rollout admission", () => {
  test("only a completed zero-failure pre-pull authorizes rollout", () => {
    expect(prePullAllowsPoolImageRollout(null)).toBe(false);
    expect(
      prePullAllowsPoolImageRollout({
        attempted: 2,
        failed: 1,
        configuredImage,
        targetDigest,
      }),
    ).toBe(false);
    expect(
      prePullAllowsPoolImageRollout({
        attempted: 0,
        failed: 0,
        configuredImage,
        targetDigest: null,
      }),
    ).toBe(false);
    expect(
      prePullAllowsPoolImageRollout({
        attempted: 0,
        failed: 0,
        configuredImage,
        targetDigest,
      }),
    ).toBe(false);
    expect(
      prePullAllowsPoolImageRollout({
        attempted: 1,
        failed: 0,
        configuredImage,
        targetDigest,
      }),
    ).toBe(true);
  });

  test("passes one resolved immutable digest into the manager and exposes counts", async () => {
    const rollout = mock(async () => ({
      decision: {
        toFence: ["old-a", "old-b"],
        toReplace: ["old-a"],
        counts: {
          target: 1,
          targetReady: 1,
          stale: 2,
          selected: 1,
          deferred: 1,
        },
      },
      reserved: ["old-a", "old-b"],
      replaced: ["old-a"],
      deferred: [
        {
          id: "old-b",
          reason: "generation changed before non-selected reservation",
        },
      ],
      failed: [],
    }));
    class TestWarmPoolManager {
      rollout = rollout;
    }
    __setDepsForTests({
      containersEnv: { defaultAgentImage: () => configuredImage },
      resolveImageDigest: async () => targetDigest,
      WarmPoolManager: TestWarmPoolManager,
      getHetznerPoolContainerCreator: () => ({}),
      envWarmPoolPolicy: () => DEFAULT_WARM_POOL_POLICY,
    } as unknown as Parameters<typeof __setDepsForTests>[0]);

    const result = await processPoolImageRolloutCycle();

    expect(rollout).toHaveBeenCalledWith(configuredImage, targetDigest);
    expect(result).toEqual({
      action: "completed",
      configuredImage,
      targetDigest,
      target: 1,
      targetReady: 1,
      stale: 2,
      selected: 1,
      reserved: 2,
      replaced: 1,
      deferred: 1,
      failed: 0,
    });
  });
});

const oneShotModuleSpecifiers = [
  "@elizaos/cloud-shared/lib/services/provisioning-jobs",
  "@elizaos/cloud-shared/lib/utils/logger",
  "@elizaos/cloud-shared/lib/services/docker-node-manager",
  "@elizaos/cloud-shared/lib/services/containers/node-autoscaler",
  "@elizaos/cloud-shared/lib/services/containers/agent-warm-pool",
  "@elizaos/cloud-shared/lib/services/containers/agent-warm-pool-creator",
  "@elizaos/cloud-shared/lib/config/containers-env",
  "@elizaos/cloud-shared/lib/services/containers/registry-probe",
  "@elizaos/cloud-shared/db/repositories/agent-sandboxes",
  "@elizaos/cloud-shared/db/repositories/jobs",
  "@elizaos/cloud-shared/lib/services/docker-node-workloads",
  "@elizaos/cloud-shared/lib/services/app-container-orphan-reconciler",
  "@elizaos/cloud-shared/lib/utils/with-timeout",
  "@elizaos/cloud-shared/lib/services/node-disk-manager",
  "@elizaos/cloud-shared/lib/services/agent-backup-verifier",
  "@elizaos/core/security/kms",
  "@elizaos/cloud-shared/lib/services/cloud-api-db-heartbeat",
  "@elizaos/cloud-shared/lib/services/provisioning-worker-health",
  "@elizaos/cloud-shared/lib/services/docker-ssh",
  "@elizaos/cloud-shared/db/client",
] as const;

async function withOneShotModuleMocks(
  replacements: Readonly<Record<string, object>>,
  run: () => Promise<void>,
): Promise<void> {
  const originals = new Map<string, object>();
  for (const specifier of oneShotModuleSpecifiers) {
    originals.set(specifier, await import(specifier));
  }
  try {
    for (const [specifier, replacement] of Object.entries(replacements)) {
      mock.module(specifier, () => replacement);
    }
    await run();
  } finally {
    for (const [specifier, original] of originals) {
      mock.module(specifier, () => original);
    }
  }
}

describe("real one-shot daemon entrypoint", () => {
  test("runs one complete canary-aware cycle, closes owned handles, and exits cleanly", async () => {
    const warmPoolPhaseOrder: string[] = [];
    const logger = {
      info: mock((..._args: unknown[]) => {}),
      warn: mock((..._args: unknown[]) => {}),
      error: mock((..._args: unknown[]) => {}),
      debug: mock((..._args: unknown[]) => {}),
    };
    const processPendingJobs = mock(async () => ({
      claimed: 1,
      succeeded: 1,
      retried: 0,
      failed: 0,
      errors: [],
    }));
    const processRunningHeartbeats = mock(async () => ({
      total: 1,
      succeeded: 1,
      failed: 0,
    }));
    const processDisconnectedRecovery = mock(async () => ({
      total: 1,
      recovered: 1,
      reprovisioned: 0,
      failed: 0,
    }));
    const recoverInterruptedJobsOnStartup = mock(async () => 1);
    const reconcileStuckProvisioning = mock(async () => ({
      total: 1,
      recovered: 1,
      unresolved: 0,
      failed: 0,
    }));
    const reconcileWarmClaimCredentialFences = mock(async () => ({
      legacyFound: 0,
      legacyRecovered: 0,
      cleanupFound: 0,
      cleanupCompleted: 0,
      failed: 0,
    }));
    const reconcileReplacementCleanupFences = mock(async () => ({
      total: 0,
      cleaned: 0,
      failed: 0,
    }));
    const enqueueAgentUpgradeOnce = mock(async () => ({
      created: true,
      job: { id: "canary-safe-upgrade" },
    }));
    const reEnqueueFailedDeletions = mock(async () => ({
      scanned: 1,
      reEnqueued: 1,
      failed: 0,
      abandoned: 0,
    }));
    const healthCheckAll = mock(
      async () =>
        new Map([
          ["node-a", "healthy"],
          ["node-b", "unhealthy"],
        ]),
    );
    const syncAllocatedCounts = mock(
      async () => new Map([["node-a", { previous: 0, actual: 1 }]]),
    );
    const prePullAgentImageOnAvailableNodes = mock(async () => {
      warmPoolPhaseOrder.push("pre-pull");
      return [
        { nodeId: "node-a", status: "pulled" },
        { nodeId: "node-b", status: "pulled" },
      ];
    });
    const evaluateCapacity = mock(async () => ({
      shouldScaleUp: true,
      shouldScaleDownNodeIds: [],
    }));
    const provisionNode = mock(async () => ({
      nodeId: "node-c",
      hostname: "demo-node-c",
    }));
    const drainNode = mock(async () => {});
    const drainIdle = mock(async () => ({ drained: ["warm-agent"] }));
    const healthCheck = mock(async () => ({
      probed: 2,
      alive: 2,
      reconciliation: {},
      removed: [],
    }));
    const replenish = mock(async () => {
      warmPoolPhaseOrder.push("replenish");
      return {
        created: ["warm-agent-next"],
        failed: [],
        decision: { reason: "forecast deficit" },
      };
    });
    const rollout = mock(async () => {
      warmPoolPhaseOrder.push("rollout");
      return {
        decision: {
          toFence: ["warm-agent-old"],
          toReplace: ["warm-agent-old"],
          counts: {
            target: 1,
            targetReady: 1,
            stale: 1,
            selected: 1,
            deferred: 0,
          },
        },
        reserved: ["warm-agent-old"],
        replaced: ["warm-agent-old"],
        deferred: [],
        failed: [],
      };
    });
    const countInFlightByTypes = mock(async () => 1);
    const listRunningWithDigestOtherThan = mock(async () => [
      {
        id: "00000000-0000-4000-8000-000000000011",
        organization_id: "00000000-0000-4000-8000-000000000012",
        user_id: "00000000-0000-4000-8000-000000000013",
        image_digest: `sha256:${"b".repeat(64)}`,
      },
    ]);
    const publishProvisioningWorkerHeartbeat = mock(async () => {});
    const disconnectAll = mock(async () => {});
    const closeDatabaseConnectionsForTests = mock(async () => {});
    const getOrCreateKey = mock(async () => ({
      keyId: "system:provisioning-worker-preflight/v1",
      version: 1,
    }));
    const reconcileOrphanContainersOnNodes = mock(async () => ({
      nodesScanned: 2,
      nodesSkipped: 0,
      reaped: 1,
      reapFailed: 0,
    }));
    const reconcileOrphanAppContainersOnNodes = mock(async () => ({
      nodesScanned: 2,
      nodesSkipped: 0,
      reaped: 1,
      reapFailed: 0,
    }));
    const cleanupExpiredPreDeleteRecoveryBackups = mock(async () => ({
      scanned: 1,
      deletedRows: 1,
      deletedObjects: 1,
      failedRows: 0,
      invalidRows: 0,
    }));
    const resolveImageDigest = mock(async () => targetDigest);

    class OneShotWarmPoolManager {
      drainIdle = drainIdle;
      healthCheck = healthCheck;
      replenish = replenish;
      rollout = rollout;
    }

    const replacements: Readonly<Record<string, object>> = {
      "@elizaos/cloud-shared/lib/services/provisioning-jobs": {
        provisioningJobService: {
          processPendingJobs,
          processRunningHeartbeats,
          processDisconnectedRecovery,
          recoverInterruptedJobsOnStartup,
          reconcileStuckProvisioning,
          reconcileWarmClaimCredentialFences,
          reconcileReplacementCleanupFences,
          enqueueAgentUpgradeOnce,
          reEnqueueFailedDeletions,
        },
      },
      "@elizaos/cloud-shared/lib/utils/logger": { logger },
      "@elizaos/cloud-shared/lib/services/docker-node-manager": {
        dockerNodeManager: {
          healthCheckAll,
          syncAllocatedCounts,
          prePullAgentImageOnAvailableNodes,
        },
      },
      "@elizaos/cloud-shared/lib/services/containers/node-autoscaler": {
        getNodeAutoscaler: () => ({
          evaluateCapacity,
          provisionNode,
          drainNode,
        }),
      },
      "@elizaos/cloud-shared/lib/services/containers/agent-warm-pool": {
        WarmPoolManager: OneShotWarmPoolManager,
        envWarmPoolPolicy: () => DEFAULT_WARM_POOL_POLICY,
        immutableImageReference: (_image: string, digest: string) =>
          `ghcr.io/elizaos/eliza@${digest}`,
      },
      "@elizaos/cloud-shared/lib/services/containers/agent-warm-pool-creator": {
        getHetznerPoolContainerCreator: () => ({ kind: "deterministic" }),
      },
      "@elizaos/cloud-shared/lib/config/containers-env": {
        containersEnv: {
          defaultAgentImage: () => configuredImage,
          maxInflightUpgrades: () => 3,
        },
        assertSSHKeyAvailable: () => {},
      },
      "@elizaos/cloud-shared/lib/services/containers/registry-probe": {
        resolveImageDigest,
      },
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes": {
        agentSandboxesRepository: {
          listRunningWithDigestOtherThan,
          cleanupExpiredPreDeleteRecoveryBackups,
        },
      },
      "@elizaos/cloud-shared/db/repositories/jobs": {
        jobsRepository: {
          findLatestCreatedAt: async () =>
            new Date(Date.now() - 48 * 60 * 60 * 1_000),
          countInFlightByTypes,
        },
      },
      "@elizaos/cloud-shared/lib/services/docker-node-workloads": {
        reconcileOrphanContainersOnNodes,
      },
      "@elizaos/cloud-shared/lib/services/app-container-orphan-reconciler": {
        reconcileOrphanAppContainersOnNodes,
      },
      "@elizaos/cloud-shared/lib/utils/with-timeout": {
        withTimeout: async <T>(operation: Promise<T>) => operation,
      },
      "@elizaos/cloud-shared/lib/services/node-disk-manager": {
        processNodeDiskCleanup: async () => ({
          nodesScanned: 2,
          nodesSkipped: 0,
          pruned: 1,
          pruneFailed: 0,
        }),
      },
      "@elizaos/cloud-shared/lib/services/agent-backup-verifier": {
        runBackupVerificationCycle: async () => ({
          sampled: 1,
          verified: 1,
          failed: 0,
          errored: 0,
          oversizeSkipped: 0,
          budgetDeferred: 0,
          escalated: 0,
        }),
      },
      "@elizaos/core/security/kms": {
        resolveKmsBackend: () => "memory",
        createKmsClient: () => ({ getOrCreateKey }),
        systemKey: (name: string) => `system:${name}/v1`,
      },
      "@elizaos/cloud-shared/lib/services/cloud-api-db-heartbeat": {
        readCloudApiDbHeartbeatAt: async () => new Date(),
      },
      "@elizaos/cloud-shared/lib/services/provisioning-worker-health": {
        publishProvisioningWorkerHeartbeat,
      },
      "@elizaos/cloud-shared/lib/services/docker-ssh": {
        DockerSSHClient: { disconnectAll },
      },
      "@elizaos/cloud-shared/db/client": {
        closeDatabaseConnectionsForTests,
      },
    };

    const envKeys = [
      "NODE_ENV",
      "ELIZA_KMS_BACKEND",
      "WORKER_RUN_ONCE",
      "ORPHAN_RECONCILER_ENABLED",
      "ELIZA_AGENT_HOT_POOL_PREPULL",
      "CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY",
      "APPS_DEPLOY_ENABLED",
      "PROVISIONING_JOB_LANES",
      "DATABASE_URL",
    ] as const;
    const previousEnv = new Map(
      envKeys.map((key) => [key, process.env[key]] as const),
    );
    const previousArgv = [...process.argv];
    const workerPath = fileURLToPath(
      new URL("./provisioning-worker.ts", import.meta.url),
    );
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
      resolveExit(typeof code === "number" ? code : Number(code ?? 0));
      return undefined as never;
    });

    process.env.NODE_ENV = "test";
    process.env.ELIZA_KMS_BACKEND = "memory";
    process.env.WORKER_RUN_ONCE = "1";
    process.env.ORPHAN_RECONCILER_ENABLED = "1";
    process.env.ELIZA_AGENT_HOT_POOL_PREPULL = "true";
    process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY =
      "ssh-ed25519 deterministic-demo-key";
    process.env.APPS_DEPLOY_ENABLED = "0";
    process.env.PROVISIONING_JOB_LANES = "agent";
    process.env.DATABASE_URL = "postgres://demo:redacted@db.demo.invalid/eliza";
    process.argv.splice(0, process.argv.length, process.execPath, workerPath);

    try {
      await withOneShotModuleMocks(replacements, async () => {
        await import(`./provisioning-worker.ts?one-shot-canary=${Date.now()}`);
        const timeout = setTimeout(() => {
          resolveExit(99);
        }, 10_000);
        const exitCode = await exited;
        clearTimeout(timeout);

        expect(exitCode).toBe(0);
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(processPendingJobs).toHaveBeenCalledTimes(1);
        expect(processRunningHeartbeats).toHaveBeenCalledTimes(1);
        expect(processDisconnectedRecovery).toHaveBeenCalledTimes(1);
        expect(recoverInterruptedJobsOnStartup).toHaveBeenCalledTimes(1);
        expect(reconcileStuckProvisioning).toHaveBeenCalledTimes(1);
        expect(reconcileWarmClaimCredentialFences).toHaveBeenCalledTimes(1);
        expect(reconcileReplacementCleanupFences).toHaveBeenCalledTimes(1);
        expect(countInFlightByTypes).toHaveBeenCalledWith([
          "agent_upgrade",
          "agent_admin_canary_image",
        ]);
        expect(enqueueAgentUpgradeOnce).toHaveBeenCalledTimes(1);
        expect(reEnqueueFailedDeletions).toHaveBeenCalledTimes(1);
        expect(reEnqueueFailedDeletions).toHaveBeenCalledWith({
          minAgeMs: 10 * 60_000,
          maxAgents: 200,
        });
        expect(healthCheckAll).toHaveBeenCalledTimes(1);
        expect(syncAllocatedCounts).toHaveBeenCalledTimes(1);
        expect(prePullAgentImageOnAvailableNodes).toHaveBeenCalledWith(
          `ghcr.io/elizaos/eliza@${targetDigest}`,
        );
        expect(resolveImageDigest).toHaveBeenCalledTimes(2);
        expect(evaluateCapacity).toHaveBeenCalledTimes(1);
        expect(provisionNode).toHaveBeenCalledTimes(1);
        expect(drainNode).not.toHaveBeenCalled();
        expect(drainIdle).toHaveBeenCalledWith(configuredImage);
        expect(healthCheck).toHaveBeenCalledTimes(1);
        expect(rollout).toHaveBeenCalledWith(configuredImage, targetDigest);
        expect(replenish).toHaveBeenCalledWith(configuredImage, targetDigest);
        expect(warmPoolPhaseOrder).toEqual([
          "pre-pull",
          "rollout",
          "replenish",
        ]);
        expect(reconcileOrphanContainersOnNodes).toHaveBeenCalledTimes(1);
        expect(reconcileOrphanAppContainersOnNodes).toHaveBeenCalledTimes(1);
        expect(cleanupExpiredPreDeleteRecoveryBackups).toHaveBeenCalledTimes(1);
        expect(publishProvisioningWorkerHeartbeat).toHaveBeenCalledTimes(1);
        expect(disconnectAll).toHaveBeenCalledTimes(1);
        expect(closeDatabaseConnectionsForTests).toHaveBeenCalledTimes(1);
        expect(getOrCreateKey).toHaveBeenCalledTimes(2);
        expect(logger.error).not.toHaveBeenCalled();
      });
    } finally {
      exitSpy.mockRestore();
      process.argv.splice(0, process.argv.length, ...previousArgv);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(readWorkerConfig({}, []).runOnce).toBe(false);
  }, 20_000);
});
