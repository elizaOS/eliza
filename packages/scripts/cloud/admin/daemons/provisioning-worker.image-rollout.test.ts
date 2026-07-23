/**
 * Pins the provisioning daemon's shared ordinary/canary image-change budget.
 * Dependencies are deterministic stand-ins; primary transaction behavior is covered by the PGlite repository suite.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __setDepsForTests,
  processFleetUpgradeCycle,
} from "./provisioning-worker";

const configuredImage = "ghcr.io/elizaos/eliza:stable";
const targetDigest = `sha256:${"a".repeat(64)}`;

function installDeps(
  inFlight: number,
  candidates: Array<Record<string, string>> = [],
) {
  const countInFlightByTypes = mock(async () => inFlight);
  const listRunningWithDigestOtherThan = mock(async () => candidates);
  const enqueueAgentUpgradeOnce = mock(async () => ({
    created: true,
    job: { id: "upgrade-job" },
  }));
  __setDepsForTests({
    containersEnv: { defaultAgentImage: () => configuredImage },
    resolveImageDigest: async () => targetDigest,
    jobsRepository: { countInFlightByTypes },
    agentSandboxesRepository: { listRunningWithDigestOtherThan },
    provisioningJobService: { enqueueAgentUpgradeOnce },
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
