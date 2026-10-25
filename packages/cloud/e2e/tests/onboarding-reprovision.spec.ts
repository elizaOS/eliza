/**
 * Proves against the real local repositories that onboarding provisioning is
 * observation-only and that newer Shared rows do not mask Dedicated lifecycle state.
 */
import { expect, test } from "../src/helpers/test-fixtures";

test.use({ stackOptions: { frontend: false } });

async function repositories() {
  const { agentSandboxesRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
  );
  const { jobsRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/jobs"
  );
  const { getElizaAppProvisioningStatus } = await import(
    "@elizaos/cloud-shared/lib/services/eliza-app/provisioning"
  );
  return {
    agentSandboxesRepository,
    jobsRepository,
    getElizaAppProvisioningStatus,
  };
}

async function countProvisionJobs(
  jobsRepository: {
    findByFilters: (filters: Record<string, unknown>) => Promise<unknown[]>;
  },
  organizationId: string,
): Promise<number> {
  const rows = await jobsRepository.findByFilters({
    type: "agent_provision",
    organizationId,
    limit: 100,
  });
  return rows.length;
}

test.describe("eliza-app onboarding Dedicated status is observation-only", () => {
  test("repeated reads expose a failed Dedicated row without re-arming it", async ({
    seededUser,
  }) => {
    const {
      agentSandboxesRepository,
      jobsRepository,
      getElizaAppProvisioningStatus,
    } = await repositories();

    const failed = await agentSandboxesRepository.create({
      organization_id: seededUser.organizationId,
      user_id: seededUser.userId,
      sandbox_id: `failed-${Date.now()}`,
      status: "error",
      execution_tier: "dedicated-always",
      agent_name: "observation-only-failed-agent",
      error_message: "Provisioning failed",
      database_status: "none",
      environment_vars: {},
    });
    const jobsBefore = await countProvisionJobs(
      jobsRepository,
      seededUser.organizationId,
    );

    const first = await getElizaAppProvisioningStatus(
      seededUser.organizationId,
      seededUser.userId,
    );
    const second = await getElizaAppProvisioningStatus(
      seededUser.organizationId,
      seededUser.userId,
    );

    expect(first).toMatchObject({ status: "error", agentId: failed.id });
    expect(second).toMatchObject({ status: "error", agentId: failed.id });
    expect(
      await countProvisionJobs(jobsRepository, seededUser.organizationId),
    ).toBe(jobsBefore);

    const persisted = await agentSandboxesRepository.findByIdAndOrg(
      failed.id,
      seededUser.organizationId,
    );
    expect(persisted).toMatchObject({
      status: "error",
      execution_tier: "dedicated-always",
    });
  });

  test("a newer Shared row does not mask the Dedicated target or enqueue work", async ({
    seededUser,
  }) => {
    const {
      agentSandboxesRepository,
      jobsRepository,
      getElizaAppProvisioningStatus,
    } = await repositories();
    const now = Date.now();

    const dedicated = await agentSandboxesRepository.create({
      organization_id: seededUser.organizationId,
      user_id: seededUser.userId,
      sandbox_id: `dedicated-${now}`,
      status: "running",
      execution_tier: "dedicated-lazy",
      agent_name: "observation-only-dedicated-agent",
      bridge_url: "http://127.0.0.1:65535",
      health_url: "http://127.0.0.1:65535/health",
      database_status: "ready",
      environment_vars: {},
      created_at: new Date(now - 60_000),
    });
    await agentSandboxesRepository.create({
      organization_id: seededUser.organizationId,
      user_id: seededUser.userId,
      status: "running",
      execution_tier: "shared",
      agent_name: "newer-shared-agent",
      database_status: "none",
      environment_vars: {},
      created_at: new Date(now),
    });
    const jobsBefore = await countProvisionJobs(
      jobsRepository,
      seededUser.organizationId,
    );

    const status = await getElizaAppProvisioningStatus(
      seededUser.organizationId,
      seededUser.userId,
    );

    expect(status).toMatchObject({
      status: "running",
      agentId: dedicated.id,
      bridgeUrl: "http://127.0.0.1:65535",
    });
    expect(
      await countProvisionJobs(jobsRepository, seededUser.organizationId),
    ).toBe(jobsBefore);
  });
});
