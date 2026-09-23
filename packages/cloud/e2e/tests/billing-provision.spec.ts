/** Covers the billing provision cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import {
  DEDICATED_COMPUTE_PRICE_HEADER,
  getDedicatedComputePriceAcceptance,
} from "@elizaos/cloud-sdk/browser-contracts";
import { sql } from "drizzle-orm";
import {
  createCloudAgent,
  listActiveBillingResources,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

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
  test("running dedicated agent settles accrued usage at the hourly rate", async ({
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

    const { dbWrite } = await import("@elizaos/cloud-shared/db/helpers");
    // The mock worker provisions an unreserved sandbox. Seed one earlier
    // running hour without rewriting the immutable transitions from provision;
    // the real cron must meter those transitions and debit the matching amount.
    await dbWrite.transaction(async (tx) => {
      const aged = await tx.execute(sql`UPDATE agent_sandboxes
        SET last_billed_at=(SELECT min(effective_at) - interval '1 hour'
          FROM compute_billing_rate_segments
          WHERE workload_id=${sandboxId} AND organization_id=${seededUser.organizationId})
        WHERE id=${sandboxId} AND organization_id=${seededUser.organizationId}
        RETURNING id`);
      expect(aged.rows).toHaveLength(1);
      await tx.execute(sql`INSERT INTO compute_billing_rate_segments
        (organization_id, workload_kind, workload_id, lifecycle_revision,
         billing_state, rate_per_hour, effective_at)
        SELECT organization_id, 'agent', id, lifecycle_revision, 'running',
          ${RUNNING_HOURLY_RATE}, last_billed_at
        FROM agent_sandboxes WHERE id=${sandboxId}
          AND organization_id=${seededUser.organizationId}`);
    });
    const balanceBefore = await readOrgBalance(seededUser.organizationId);

    // Exercise the actual protected cron, credit debit, and receipt writer.
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
    const receipts = await dbWrite.execute<{
      amount: string;
      credit_transaction_id: string;
      rate_segments: Array<{
        state: string;
        ratePerHour: string;
        startedAt: string;
        endedAt: string;
      }>;
    }>(sql`SELECT amount, credit_transaction_id, rate_segments FROM agent_billing_records
      WHERE sandbox_id=${sandboxId} AND organization_id=${seededUser.organizationId}`);
    expect(receipts.rows).toHaveLength(1);
    const receipt = receipts.rows[0];
    if (!receipt) throw new Error("Missing billing receipt");
    expect(receipt.credit_transaction_id).toBeTruthy();
    let runningMs = 0;
    for (const segment of receipt.rate_segments) {
      if (segment.state === "running") {
        expect(Number(segment.ratePerHour)).toBe(RUNNING_HOURLY_RATE);
        runningMs +=
          new Date(segment.endedAt).getTime() -
          new Date(segment.startedAt).getTime();
      } else {
        expect(Number(segment.ratePerHour)).toBe(0);
      }
    }
    expect(runningMs).toBeGreaterThanOrEqual(3_600_000);
    const meteredAmount = Number(
      ((runningMs / 3_600_000) * RUNNING_HOURLY_RATE).toFixed(6),
    );
    expect(Number(receipt.amount)).toBe(meteredAmount);
    expect(Number((balanceBefore - balanceAfter).toFixed(6))).toBe(
      meteredAmount,
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
        headers: {
          Authorization: `Bearer ${seededUser.apiKey}`,
          [DEDICATED_COMPUTE_PRICE_HEADER]:
            getDedicatedComputePriceAcceptance(),
        },
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
