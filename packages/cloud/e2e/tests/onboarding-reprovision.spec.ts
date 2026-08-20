/**
 * Covers the eliza-app onboarding re-provision path against the real local
 * stack: an organization whose only sandbox has died must be able to get a new
 * container by talking to the onboarding chat, and must not be able to storm
 * the fleet by talking to it repeatedly.
 *
 * Real cloud-shared services and the real jobs table; only the container
 * infrastructure is mock-backed (in-memory sandbox provider).
 */
import { expect, test } from "../src/helpers/test-fixtures";

const DEAD_ERROR_MESSAGE =
  "Provisioning permanently failed after 3 attempts: Job timed out 3 times - max attempts reached";

async function repositories() {
  const { agentSandboxesRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
  );
  const { jobsRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/jobs"
  );
  const { ensureElizaAppProvisioning } = await import(
    "@elizaos/cloud-shared/lib/services/eliza-app/provisioning"
  );
  return {
    agentSandboxesRepository,
    jobsRepository,
    ensureElizaAppProvisioning,
  };
}

async function countProvisionJobs(
  jobsRepository: {
    findByFilters: (f: Record<string, unknown>) => Promise<unknown[]>;
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

test.describe("eliza-app onboarding re-provisions a dead sandbox", () => {
  test("a terminal row is re-armed once, and repeat turns do not queue more work", async ({
    seededUser,
  }) => {
    const {
      agentSandboxesRepository,
      jobsRepository,
      ensureElizaAppProvisioning,
    } = await repositories();

    // The state the reaper leaves behind after a provision exhausts its retries.
    // Before the fix this row made the organization permanently unable to get an
    // agent from the onboarding chat, with no self-service escape.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const dead = await agentSandboxesRepository.create({
      organization_id: seededUser.organizationId,
      user_id: seededUser.userId,
      sandbox_id: `dead-${Date.now()}`,
      status: "error",
      agent_name: "reprovision-e2e-agent",
      error_message: DEAD_ERROR_MESSAGE,
      database_status: "none",
      environment_vars: {},
      created_at: past,
      updated_at: past,
    });

    const before = await countProvisionJobs(
      jobsRepository,
      seededUser.organizationId,
    );

    const first = await ensureElizaAppProvisioning({
      organizationId: seededUser.organizationId,
      userId: seededUser.userId,
    });

    // Same row, not a second agent: minting a new one would orphan the first and
    // leave the organization holding two.
    expect(first.agentId).toBe(dead.id);
    // Still `error` — only the daemon claiming the job moves it to
    // `provisioning`. Reporting progress here would invent a state the database
    // does not have, and the stuck-provisioning reaper would never sweep it.
    expect(first.status).toBe("error");

    const afterFirst = await countProvisionJobs(
      jobsRepository,
      seededUser.organizationId,
    );
    expect(afterFirst).toBe(before + 1);

    const second = await ensureElizaAppProvisioning({
      organizationId: seededUser.organizationId,
      userId: seededUser.userId,
    });

    // A user who keeps typing must not keep queueing container builds. The
    // pending job dedup covers this turn; the cooldown covers the turn after
    // the job settles.
    expect(second.agentId).toBe(dead.id);
    const afterSecond = await countProvisionJobs(
      jobsRepository,
      seededUser.organizationId,
    );
    expect(afterSecond).toBe(afterFirst);

    const persisted = await agentSandboxesRepository.findByIdAndOrg(
      dead.id,
      seededUser.organizationId,
    );
    expect(persisted?.status).toBe("error");
  });

  test("a healthy sandbox is reused, never re-armed", async ({
    seededUser,
  }) => {
    const {
      agentSandboxesRepository,
      jobsRepository,
      ensureElizaAppProvisioning,
    } = await repositories();

    const live = await agentSandboxesRepository.create({
      organization_id: seededUser.organizationId,
      user_id: seededUser.userId,
      sandbox_id: `live-${Date.now()}`,
      status: "running",
      agent_name: "reuse-e2e-agent",
      bridge_url: "http://127.0.0.1:65535",
      health_url: "http://127.0.0.1:65535/health",
      database_status: "ready",
      environment_vars: {},
    });

    const before = await countProvisionJobs(
      jobsRepository,
      seededUser.organizationId,
    );

    const result = await ensureElizaAppProvisioning({
      organizationId: seededUser.organizationId,
      userId: seededUser.userId,
    });

    expect(result.agentId).toBe(live.id);
    expect(result.status).toBe("running");
    // The whole point of the guard: a working agent costs no new work.
    expect(
      await countProvisionJobs(jobsRepository, seededUser.organizationId),
    ).toBe(before);
  });
});
