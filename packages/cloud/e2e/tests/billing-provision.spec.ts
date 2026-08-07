/** Covers the billing provision cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import {
  createCloudAgent,
  listActiveBillingResources,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

/**
 * Billing contract for dedicated (non-shared) agents.
 *
 * Grounded on real source:
 *   • AGENT_PRICING.RUNNING_HOURLY_RATE = 0.01 and AGENT_PRICING.MINIMUM_DEPOSIT
 *     = 0.1 — packages/cloud/shared/src/lib/constants/agent-pricing.ts:16,32.
 *   • The active-billing reader reports a running dedicated agent as
 *     resourceType "agent_sandbox" / billingInterval "hour" / unitPrice
 *     RUNNING_HOURLY_RATE — active-billing.ts:164-197.
 *   • The hourly cron (/api/cron/agent-billing) deducts exactly hourlyCost from
 *     organizations.credit_balance and stamps last_billed_at — the SQL
 *     `credit_balance - hourlyCost` + `last_billed_at: now` in
 *     packages/cloud/shared/src/db/repositories/agent-billing.ts:215,256.
 *   • The provision route 402s below MINIMUM_DEPOSIT with requiredBalance /
 *     currentBalance and never enqueues a job — provision/route.ts:151-171,
 *     gated by checkAgentCreditGate (agent-billing-gate.ts:37, balance <=
 *     MINIMUM_DEPOSIT).
 */

const CRON_SECRET = "test-cron-secret";
const RUNNING_HOURLY_RATE = 0.01;
const MINIMUM_DEPOSIT = 0.1;

async function readOrgBalance(organizationId: string): Promise<number> {
  const { organizationsRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/organizations"
  );
  const org = await organizationsRepository.findById(organizationId);
  expect(org, `expected organization ${organizationId}`).toBeTruthy();
  return Number(org?.credit_balance);
}

async function setOrgBalance(
  organizationId: string,
  target: number,
): Promise<void> {
  const { organizationsRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/organizations"
  );
  const current = await readOrgBalance(organizationId);
  // updateCreditBalance applies a signed delta atomically.
  await organizationsRepository.updateCreditBalance(
    organizationId,
    target - current,
  );
}

test.describe("billing — provision lifecycle", () => {
  test("running dedicated agent is billed exactly the hourly rate", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    // The seeded org starts at 1000.000000 — comfortably above MINIMUM_DEPOSIT.
    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-billing-running-agent",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      intervalMs: 250,
      onTick: processJobs,
    });

    // The running dedicated agent now shows up as an hourly agent_sandbox
    // billable at RUNNING_HOURLY_RATE.
    const activeResources = await listActiveBillingResources(
      api,
      seededUser.apiKey,
    );
    const agentResource = activeResources.find(
      (resource) =>
        resource.resourceType === "agent_sandbox" &&
        resource.resourceId === sandboxId,
    );
    expect(
      agentResource,
      `expected agent_sandbox ${sandboxId} in active billing`,
    ).toBeTruthy();
    expect(agentResource).toMatchObject({
      resourceType: "agent_sandbox",
      billingInterval: "hour",
      unitPrice: RUNNING_HOURLY_RATE,
      status: "running",
    });

    const balanceBefore = await readOrgBalance(seededUser.organizationId);

    // Run the hourly billing cron (CRON_SECRET-protected). last_billed_at is
    // NULL after provisioning, so this first run bills the running agent.
    const cronRes = await fetch(`${stack.urls.api}/api/cron/agent-billing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        "Content-Type": "application/json",
      },
    });
    expect(
      cronRes.status,
      `agent-billing cron returned ${cronRes.status}: ${await cronRes.clone().text()}`,
    ).toBe(200);
    const cronBody = (await cronRes.json()) as {
      success?: boolean;
      data?: { sandboxesBilled?: number };
    };
    expect(cronBody.success).toBe(true);
    expect(cronBody.data?.sandboxesBilled).toBeGreaterThanOrEqual(1);

    const balanceAfter = await readOrgBalance(seededUser.organizationId);
    // Decreased by exactly the running hourly rate (numeric(12,6) precision).
    expect(Number((balanceBefore - balanceAfter).toFixed(6))).toBe(
      RUNNING_HOURLY_RATE,
    );

    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    const billedRow = await agentSandboxesRepository.findByIdAndOrg(
      sandboxId,
      seededUser.organizationId,
    );
    expect(
      billedRow?.last_billed_at,
      "expected last_billed_at stamped",
    ).toBeTruthy();
  });

  test("provision below the minimum deposit returns 402 and enqueues nothing", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };

    // A dedicated agent below the minimum deposit. Creating the row is allowed;
    // provisioning is the gated step.
    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-billing-broke-agent",
      { alwaysOn: true, autoProvision: false },
    );

    // Drop the org below MINIMUM_DEPOSIT ($0.10). The gate rejects when
    // balance <= MINIMUM_DEPOSIT, so 0.05 is firmly below.
    await setOrgBalance(seededUser.organizationId, 0.05);
    expect(await readOrgBalance(seededUser.organizationId)).toBeLessThan(
      MINIMUM_DEPOSIT,
    );

    const res = await fetch(
      `${stack.urls.api}/api/v1/eliza/agents/${sandboxId}/provision`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${seededUser.apiKey}` },
      },
    );
    expect(
      res.status,
      `provision below minimum should 402, got ${res.status}: ${await res.clone().text()}`,
    ).toBe(402);
    const body = (await res.json()) as {
      success?: boolean;
      requiredBalance?: number;
      currentBalance?: number;
    };
    expect(body.success).toBe(false);
    expect(body.requiredBalance).toBe(MINIMUM_DEPOSIT);
    expect(body.currentBalance).toBeCloseTo(0.05, 6);

    // No agent_provision job was enqueued for this agent.
    const { jobsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/jobs"
    );
    const { JOB_TYPES } = await import(
      "@elizaos/cloud-shared/lib/services/provisioning-job-types"
    );
    const provisionJobs = await jobsRepository.findByDataField({
      type: JOB_TYPES.AGENT_PROVISION,
      organizationId: seededUser.organizationId,
      dataField: "agentId",
      dataValue: sandboxId,
    });
    expect(
      provisionJobs.length,
      `expected no agent_provision job, found ${provisionJobs.length}`,
    ).toBe(0);

    // Sandbox stays pending — provisioning never started.
    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );
    const row = await agentSandboxesRepository.findByIdAndOrg(
      sandboxId,
      seededUser.organizationId,
    );
    expect(row?.status).toBe("pending");
  });
});
