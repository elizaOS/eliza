/** Exercises payment-resume queue admission and rollback through real PGlite and billing SQL. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import {
  type AgentPaymentResumeExecutionAuthority,
  listAgentPaymentResumeCandidates,
  lockPaymentResumeProviderAuthorityInTransaction,
} from "../../db/repositories/agent-compute-stop-intents";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { jobsRepository } from "../../db/repositories/jobs";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import { agentSandboxBackups, agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { computeBillingRateSegments } from "../../db/schemas/compute-billing-rate-segments";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import { type Job, jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { PROVISIONING_JOB_TEST_TABLES } from "./__tests__/tier-upgrade-pglite-schema";
import { ElizaSandboxService, elizaSandboxService } from "./eliza-sandbox";
import { ProvisioningJobService } from "./provisioning-jobs";
import type { SandboxHandle, SandboxProvider } from "./sandbox-provider";

const service = new ProvisioningJobService();

beforeAll(async () => {
  for (const statement of PROVISIONING_JOB_TEST_TABLES) await dbWrite.execute(sql.raw(statement));
  const migration = await readFile(
    new URL("../../db/migrations/0189_agent_sandbox_lifecycle_revision_scope.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    await dbWrite.execute(sql.raw(statement));
}, 60_000);
beforeEach(async () => {
  await dbWrite.execute(sql.raw("DROP TRIGGER IF EXISTS reject_resume_job ON jobs"));
  await dbWrite.execute(
    sql.raw(
      "TRUNCATE agent_compute_stop_intents, jobs, agent_sandboxes, compute_billing_rate_segments, credit_transactions, agent_billing_records, users, organizations CASCADE",
    ),
  );
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seed(balance = "10.000000") {
  const [org] = await dbWrite
    .insert(organizations)
    .values({
      name: "Resume fixture",
      slug: crypto.randomUUID(),
      credit_balance: balance,
    })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      organization_id: org.id,
      steward_user_id: crypto.randomUUID(),
    })
    .returning();
  const start = new Date(Date.now() - 3_600_000);
  const [agent] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: org.id,
      user_id: user.id,
      status: "stopped",
      execution_tier: "dedicated-always",
      lifecycle_revision: 1,
      billing_status: "suspended",
      last_billed_at: start,
    })
    .returning();
  await dbWrite.insert(computeBillingRateSegments).values({
    organization_id: org.id,
    workload_kind: "agent",
    workload_id: agent.id,
    lifecycle_revision: 1,
    billing_state: "running",
    rate_per_hour: "0.010000",
    effective_at: start,
  });
  await dbWrite.insert(agentComputeStopIntents).values({
    organization_id: org.id,
    agent_id: agent.id,
    lifecycle_revision: 0,
    status: "provider_confirmed",
    provider_confirmed_at: start,
    provider_confirmed_lifecycle_revision: 1n,
  });
  let afterIntentId: string | undefined;
  for (;;) {
    const [candidate] = await listAgentPaymentResumeCandidates({ limit: 1, afterIntentId });
    if (!candidate) throw new Error("Payment stop fixture was not discoverable");
    if (candidate.agentId === agent.id) return candidate;
    afterIntentId = candidate.intentId;
  }
}

test("refill admission reuses one durable job and persists its exact stop authority", async () => {
  const candidate = await seed();
  const first = await service.enqueueFundedAgentResumeOnce(candidate);
  const second = await service.enqueueFundedAgentResumeOnce(candidate);
  expect(first.status).toBe("queued");
  expect(second.status).toBe("queued");
  if (first.status !== "queued" || second.status !== "queued")
    throw new Error("Expected queued resume");
  expect(first.job.id).toBe(second.job.id);
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(first.job.data.paymentResume).toEqual({
    stopIntentId: candidate.intentId,
    stoppedLifecycleRevision: candidate.lifecycleRevision,
  });
  expect(await dbWrite.select({ id: jobs.id }).from(jobs)).toHaveLength(1);
});

test("an unfunded receipt creates no job", async () => {
  const candidate = await seed("0.000000");
  expect(await service.enqueueFundedAgentResumeOnce(candidate)).toEqual({ status: "unfunded" });
  expect(await dbWrite.select({ id: jobs.id }).from(jobs)).toHaveLength(0);
});

test("job insertion failure rolls back the actual accrued-charge debit", async () => {
  const candidate = await seed();
  await dbWrite.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION reject_resume_job_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected resume insert failure'; END $$`),
  );
  await dbWrite.execute(
    sql.raw(`CREATE TRIGGER reject_resume_job BEFORE INSERT ON jobs
    FOR EACH ROW EXECUTE FUNCTION reject_resume_job_insert()`),
  );
  await expect(service.enqueueFundedAgentResumeOnce(candidate)).rejects.toThrow();
  const [org] = await dbWrite
    .select({ balance: organizations.credit_balance })
    .from(organizations)
    .where(eq(organizations.id, candidate.organizationId));
  expect(Number(org.balance)).toBe(10);
  expect(await dbWrite.select({ id: creditTransactions.id }).from(creditTransactions)).toHaveLength(
    0,
  );
  expect(await dbWrite.select({ id: jobs.id }).from(jobs)).toHaveLength(0);
});

test("replayed confirmed stop survives real execution claim and settlement", async () => {
  const candidate = await seed();
  const ownerId = crypto.randomUUID();
  await dbWrite.insert(jobs).values({
    type: "agent_suspend",
    status: "pending",
    agent_id: candidate.agentId,
    organization_id: candidate.organizationId,
    user_id: candidate.userId,
    data: {
      agentId: candidate.agentId,
      organizationId: candidate.organizationId,
      userId: candidate.userId,
      authorization: "billing_request",
    },
  });
  const [job] = await jobsRepository.claimPendingJobs({
    type: "agent_suspend",
    organizationId: candidate.organizationId,
    limit: 1,
    executionOwnerId: ownerId,
    executionLeaseMs: 60_000,
  });
  if (!job?.execution_generation) throw new Error("Expected a real claimed stop job");
  await dbWrite
    .update(agentComputeStopIntents)
    .set({ job_id: job.id })
    .where(eq(agentComputeStopIntents.id, candidate.intentId));
  const executionService = new ProvisioningJobService({ executionOwnerId: ownerId });
  const executionBoundary = executionService as unknown as {
    assertNoConflictingLifecycleExecution(job: Job): Promise<void>;
  };
  await executionBoundary.assertNoConflictingLifecycleExecution(job);
  const [afterClaim] = await listAgentPaymentResumeCandidates({ limit: 1 });
  expect(afterClaim?.intentId).toBe(candidate.intentId);
  expect(afterClaim?.lifecycleRevision).not.toBe(candidate.lifecycleRevision);
  expect(await jobsRepository.settleExecution(job, "completed", undefined, ownerId)).toBe(true);
  const [after] = await listAgentPaymentResumeCandidates({ limit: 1 });
  expect(after?.intentId).toBe(candidate.intentId);
  if (!after) throw new Error("Completed stop lost its resume receipt");
  expect((await service.enqueueFundedAgentResumeOnce(after)).status).toBe("queued");
});

test("a later manual resume revokes the old automatic job grant", async () => {
  const candidate = await seed();
  const automatic = await service.enqueueFundedAgentResumeOnce(candidate);
  if (automatic.status !== "queued") throw new Error("Expected automatic resume job");
  await dbWrite
    .update(jobs)
    .set({ status: "failed", execution_quiesced_at: new Date() })
    .where(eq(jobs.id, automatic.job.id));
  const manual = await service.enqueueAgentResumeOnce(candidate);
  expect(manual.job.id).not.toBe(automatic.job.id);
  const [intent] = await dbWrite
    .select()
    .from(agentComputeStopIntents)
    .where(eq(agentComputeStopIntents.id, candidate.intentId));
  expect(intent.status).toBe("superseded");
  expect(await service.enqueueFundedAgentResumeOnce(candidate)).toEqual({
    status: "authority_changed",
  });
});

test("automatic admission cannot replace an execution that has not quiesced", async () => {
  const candidate = await seed();
  const first = await service.enqueueFundedAgentResumeOnce(candidate);
  if (first.status !== "queued") throw new Error("Expected automatic resume job");
  await dbWrite
    .update(jobs)
    .set({ status: "failed", execution_quiesced_at: null })
    .where(eq(jobs.id, first.job.id));
  expect(await service.enqueueFundedAgentResumeOnce(candidate)).toEqual({
    status: "authority_changed",
  });
  expect(await dbWrite.select({ id: jobs.id }).from(jobs)).toHaveLength(1);
});

async function claimResume(organizationId: string) {
  const ownerId = crypto.randomUUID();
  const [job] = await jobsRepository.claimPendingJobs({
    type: "agent_resume",
    organizationId,
    limit: 1,
    executionOwnerId: ownerId,
    executionLeaseMs: 60_000,
  });
  if (!job?.execution_generation) throw new Error("Expected claimed automatic resume");
  const worker = new ProvisioningJobService({ executionOwnerId: ownerId }) as unknown as {
    assertNoConflictingLifecycleExecution(job: Job): Promise<void>;
  };
  return { job, ownerId, bind: () => worker.assertNoConflictingLifecycleExecution(job) };
}

test("automatic execution rechecks funding and leaves no binding when funds disappeared", async () => {
  const candidate = await seed();
  await service.enqueueFundedAgentResumeOnce(candidate);
  const claim = await claimResume(candidate.organizationId);
  await dbWrite
    .update(organizations)
    .set({ credit_balance: "0" })
    .where(eq(organizations.id, candidate.organizationId));
  await expect(claim.bind()).rejects.toMatchObject({ code: "PAYMENT_RESUME_EXECUTION_NOT_FUNDED" });
  const [agent] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, candidate.agentId));
  const [intent] = await dbWrite
    .select()
    .from(agentComputeStopIntents)
    .where(eq(agentComputeStopIntents.id, candidate.intentId));
  expect(agent.lifecycle_job_id).toBeNull();
  expect(intent.resume_started_at).toBeNull();
});

test("automatic execution survives its own claim and retry revisions", async () => {
  const candidate = await seed();
  await service.enqueueFundedAgentResumeOnce(candidate);
  const first = await claimResume(candidate.organizationId);
  await first.bind();
  const [started] = await dbWrite
    .select()
    .from(agentComputeStopIntents)
    .where(eq(agentComputeStopIntents.id, candidate.intentId));
  expect(started.resume_started_at).not.toBeNull();
  await jobsRepository.incrementAttempt(
    first.job.id,
    "transient provider failure",
    3,
    undefined,
    first.job.execution_generation!,
    first.ownerId,
  );
  await dbWrite
    .update(jobs)
    .set({ scheduled_for: new Date(Date.now() - 1000) })
    .where(eq(jobs.id, first.job.id));
  const retry = await claimResume(candidate.organizationId);
  expect(retry.job.id).toBe(first.job.id);
  expect(retry.job.execution_generation).not.toBe(first.job.execution_generation);
  await retry.bind();
  const [agent] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, candidate.agentId));
  expect(agent.lifecycle_job_id).toBe(retry.job.id);
  expect(agent.lifecycle_execution_generation).toBe(retry.job.execution_generation);
  const [after] = await dbWrite
    .select()
    .from(agentComputeStopIntents)
    .where(eq(agentComputeStopIntents.id, candidate.intentId));
  expect(after.resume_started_at).toEqual(started.resume_started_at);
});

test("a revoked automatic grant cannot claim the agent", async () => {
  const candidate = await seed();
  await service.enqueueFundedAgentResumeOnce(candidate);
  const claim = await claimResume(candidate.organizationId);
  await dbWrite
    .update(agentComputeStopIntents)
    .set({ status: "superseded" })
    .where(eq(agentComputeStopIntents.id, candidate.intentId));
  await expect(claim.bind()).rejects.toMatchObject({
    code: "PAYMENT_RESUME_EXECUTION_AUTHORITY_CHANGED",
  });
  const [agent] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, candidate.agentId));
  expect(agent.lifecycle_job_id).toBeNull();
});

async function providerAuthority(): Promise<AgentPaymentResumeExecutionAuthority> {
  const candidate = await seed();
  await service.enqueueFundedAgentResumeOnce(candidate);
  const claim = await claimResume(candidate.organizationId);
  await claim.bind();
  return {
    ...candidate,
    jobId: claim.job.id,
    executionGeneration: claim.job.execution_generation!,
    executionOwnerId: claim.ownerId,
  };
}

test("provider admission atomically enters provisioning for the owned funded execution", async () => {
  const authority = await providerAuthority();
  const admission = await agentSandboxesRepository.admitPaymentResumeProvisioning(authority);
  expect(admission.previousStatus).toBe("stopped");
  expect(admission.sandbox.status).toBe("provisioning");
  expect(admission.sandbox.lifecycle_execution_generation).toBe(authority.executionGeneration);
});

test("an expired execution lease cannot admit a provider replacement", async () => {
  const authority = await providerAuthority();
  await dbWrite
    .update(jobExecutionLeases)
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where(eq(jobExecutionLeases.job_id, authority.jobId));
  await expect(
    agentSandboxesRepository.admitPaymentResumeProvisioning(authority),
  ).rejects.toMatchObject({ code: "PAYMENT_RESUME_PROVIDER_LEASE_LOST" });
  const [agent] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, authority.agentId));
  expect(agent.status).toBe("stopped");
});

test("funding loss permits owned cleanup but blocks creation admission", async () => {
  const authority = await providerAuthority();
  await dbWrite
    .update(organizations)
    .set({ credit_balance: "0" })
    .where(eq(organizations.id, authority.organizationId));
  const cleanup = await dbWrite.transaction((tx) =>
    lockPaymentResumeProviderAuthorityInTransaction(tx, authority, "cleanup"),
  );
  expect(cleanup.id).toBe(authority.agentId);
  await expect(
    agentSandboxesRepository.admitPaymentResumeProvisioning(authority),
  ).rejects.toMatchObject({ code: "PAYMENT_RESUME_EXECUTION_NOT_FUNDED" });
  const [agent] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, authority.agentId));
  expect(agent.status).toBe("stopped");
});

test("a retry reports existing running recovery without claiming another reprovision", async () => {
  const authority = await providerAuthority();
  await dbWrite
    .update(agentSandboxes)
    .set({
      status: "running",
      bridge_url: "https://agent.example.invalid",
      health_url: "https://agent.example.invalid/api",
    })
    .where(eq(agentSandboxes.id, authority.agentId));
  expect(
    await elizaSandboxService.executeResume(authority.agentId, authority.organizationId, authority),
  ).toEqual({
    success: true,
    containerStarted: true,
    reprovisioned: false,
  });
  await expect(
    elizaSandboxService.executeResume(authority.agentId, authority.organizationId, {
      ...authority,
      executionOwnerId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "PAYMENT_RESUME_PROVIDER_LEASE_LOST" });
});

async function publishRestoredReplacement(authority: AgentPaymentResumeExecutionAuthority) {
  const [agent] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, authority.agentId));
  const handle = {
    sandboxId: "restored-payment-resume",
    bridgeUrl: "https://restored.example.invalid",
    healthUrl: "https://restored.example.invalid/health",
  };
  return elizaSandboxService["transferReplacementToPrimary"](
    authority.agentId,
    authority.organizationId,
    handle,
    agent.environment_revision,
    {
      status: "running",
      sandbox_id: handle.sandboxId,
      bridge_url: handle.bridgeUrl,
      health_url: handle.healthUrl,
    },
    authority,
  );
}

test("restored replacement publication atomically activates billing", async () => {
  const authority = await providerAuthority();
  await agentSandboxesRepository.admitPaymentResumeProvisioning(authority);
  const completed = await publishRestoredReplacement(authority);
  expect(completed.status).toBe("running");
  expect(completed.billing_status).toBe("active");
  const [persisted] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, authority.agentId));
  expect(persisted.sandbox_id).toBe(completed.sandbox_id);
  expect(persisted.billing_status).toBe("active");
});

for (const change of ["funding", "lease", "grant"] as const) {
  test(`restoration cannot publish after ${change} authority is lost`, async () => {
    const authority = await providerAuthority();
    const admission = await agentSandboxesRepository.admitPaymentResumeProvisioning(authority);
    if (change === "funding") {
      await dbWrite
        .update(organizations)
        .set({ credit_balance: "0" })
        .where(eq(organizations.id, authority.organizationId));
    } else if (change === "lease") {
      await dbWrite
        .update(jobExecutionLeases)
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where(eq(jobExecutionLeases.job_id, authority.jobId));
    } else {
      await dbWrite
        .update(agentComputeStopIntents)
        .set({ status: "superseded" })
        .where(eq(agentComputeStopIntents.id, authority.intentId));
    }
    await expect(publishRestoredReplacement(authority)).rejects.toMatchObject({
      code:
        change === "funding"
          ? "PAYMENT_RESUME_EXECUTION_NOT_FUNDED"
          : change === "lease"
            ? "PAYMENT_RESUME_PROVIDER_LEASE_LOST"
            : "PAYMENT_RESUME_EXECUTION_AUTHORITY_CHANGED",
    });
    const [persisted] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, authority.agentId));
    expect(persisted.status).toBe("provisioning");
    expect(persisted.sandbox_id).toBeNull();
    expect(persisted.billing_status).toBe(admission.sandbox.billing_status);
  });
}

test("billing activation failure rolls back replacement publication", async () => {
  const authority = await providerAuthority();
  await agentSandboxesRepository.admitPaymentResumeProvisioning(authority);
  await dbWrite.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION reject_resume_activation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'activation persistence unavailable'; END $$;
  `),
  );
  await dbWrite.execute(
    sql.raw(`
    CREATE TRIGGER reject_resume_activation BEFORE UPDATE OF billing_status ON agent_sandboxes
    FOR EACH ROW WHEN (NEW.status = 'running') EXECUTE FUNCTION reject_resume_activation();
  `),
  );
  try {
    await expect(publishRestoredReplacement(authority)).rejects.toThrow();
    const [persisted] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, authority.agentId));
    expect(persisted.status).toBe("provisioning");
    expect(persisted.sandbox_id).toBeNull();
    expect(persisted.bridge_url).toBeNull();
  } finally {
    await dbWrite.execute(sql.raw("DROP TRIGGER reject_resume_activation ON agent_sandboxes"));
  }
});

for (const change of ["lease", "grant"] as const) {
  test(`failed resume cleanup preserves the replacement after ${change} loss`, async () => {
    const authority = await providerAuthority();
    await agentSandboxesRepository.admitPaymentResumeProvisioning(authority);
    const replacementId = crypto.randomUUID();
    await dbWrite
      .update(agentSandboxes)
      .set({
        replacement_cleanup_sandbox_id: replacementId,
        replacement_cleanup_node_id: "retained-node",
        replacement_cleanup_container_name: "retained-container",
        replacement_cleanup_container_id: "immutable-container",
        replacement_cleanup_allocation_counted: false,
        replacement_cleanup_created_at: new Date(),
      })
      .where(eq(agentSandboxes.id, authority.agentId));
    if (change === "lease") {
      await dbWrite
        .update(jobExecutionLeases)
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where(eq(jobExecutionLeases.job_id, authority.jobId));
    } else {
      await dbWrite
        .update(agentComputeStopIntents)
        .set({ status: "superseded" })
        .where(eq(agentComputeStopIntents.id, authority.intentId));
    }
    await expect(
      elizaSandboxService["retirePersistedReplacementCleanup"](
        authority.agentId,
        authority.organizationId,
        undefined,
        undefined,
        "lifecycle",
        { authority },
      ),
    ).rejects.toMatchObject({
      code:
        change === "lease"
          ? "PAYMENT_RESUME_PROVIDER_LEASE_LOST"
          : "PAYMENT_RESUME_EXECUTION_AUTHORITY_CHANGED",
    });
    const [retained] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, authority.agentId));
    expect(retained.replacement_cleanup_sandbox_id).toBe(replacementId);
    expect(retained.replacement_cleanup_container_id).toBe("immutable-container");
    expect(retained.lifecycle_execution_generation).toBe(authority.executionGeneration);
  });
}

test("failed resume without a cleanup receipt refuses primary-handle deletion", async () => {
  const authority = await providerAuthority();
  await agentSandboxesRepository.admitPaymentResumeProvisioning(authority);
  await expect(
    elizaSandboxService["retirePersistedReplacementCleanup"](
      authority.agentId,
      authority.organizationId,
      undefined,
      undefined,
      "lifecycle",
      {
        authority,
        expectedHandle: {
          sandboxId: "unproven-primary",
          bridgeUrl: "https://agent.example.invalid",
          healthUrl: "https://agent.example.invalid/health",
        },
      },
    ),
  ).rejects.toMatchObject({ code: "PAYMENT_RESUME_CLEANUP_REQUIRED" });
});

test("an expired resume worker cannot overwrite a newer agent status with its error", async () => {
  const authority = await providerAuthority();
  const admission = await agentSandboxesRepository.admitPaymentResumeProvisioning(authority);
  await dbWrite
    .update(jobExecutionLeases)
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where(eq(jobExecutionLeases.job_id, authority.jobId));
  await dbWrite
    .update(agentSandboxes)
    .set({ status: "running", error_message: null })
    .where(eq(agentSandboxes.id, authority.agentId));
  await expect(
    elizaSandboxService["markError"](admission.sandbox, "obsolete provider error", authority),
  ).rejects.toMatchObject({ code: "PAYMENT_RESUME_PROVIDER_LEASE_LOST" });
  const [agent] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, authority.agentId));
  expect(agent.status).toBe("running");
  expect(agent.error_message).toBeNull();
});

test("a quiesced failed recovery remains discoverable and can claim a new retry job", async () => {
  const candidate = await seed();
  await service.enqueueFundedAgentResumeOnce(candidate);
  const claim = await claimResume(candidate.organizationId);
  await claim.bind();
  await dbWrite
    .update(agentSandboxes)
    .set({ status: "error", error_message: "provider unavailable" })
    .where(eq(agentSandboxes.id, candidate.agentId));
  expect(await jobsRepository.settleExecution(claim.job, "failed", undefined, claim.ownerId)).toBe(
    true,
  );
  expect(await listAgentPaymentResumeCandidates({ limit: 10 })).toEqual([]);
  await dbWrite
    .update(jobs)
    .set({
      completed_at: sql`clock_timestamp() - interval '3 minutes'`,
      execution_quiesced_at: sql`clock_timestamp() - interval '3 minutes'`,
    })
    .where(eq(jobs.id, claim.job.id));
  const [retryCandidate] = await listAgentPaymentResumeCandidates({ limit: 10 });
  expect(retryCandidate).toEqual(candidate);
  const retry = await service.enqueueFundedAgentResumeOnce(retryCandidate);
  if (retry.status !== "queued") throw new Error("Expected a replacement retry job");
  expect(retry.job.id).not.toBe(claim.job.id);
  const next = await claimResume(candidate.organizationId);
  await next.bind();
  const [agent] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, candidate.agentId));
  expect(agent.lifecycle_job_id).toBe(next.job.id);
  expect(agent.lifecycle_execution_generation).toBe(next.job.execution_generation);
});

test("failed recovery discovery excludes an execution that has not quiesced", async () => {
  const candidate = await seed();
  await service.enqueueFundedAgentResumeOnce(candidate);
  const claim = await claimResume(candidate.organizationId);
  await claim.bind();
  await dbWrite
    .update(agentSandboxes)
    .set({ status: "error" })
    .where(eq(agentSandboxes.id, candidate.agentId));
  await dbWrite
    .update(jobs)
    .set({ status: "failed", execution_quiesced_at: null })
    .where(eq(jobs.id, claim.job.id));
  expect(await listAgentPaymentResumeCandidates({ limit: 10 })).toEqual([]);
});

test("funded discovery pages past unfunded accounts and reuses an admitted job", async () => {
  const candidates = [await seed(), await seed()].sort((a, b) =>
    a.intentId.localeCompare(b.intentId),
  );
  await dbWrite
    .update(organizations)
    .set({ credit_balance: "0" })
    .where(eq(organizations.id, candidates[0].organizationId));
  const first = await service.reconcileFundedAgentResumes({ limit: 1 });
  expect(first.unfunded).toBe(1);
  expect(first.queued).toBe(0);
  const second = await service.reconcileFundedAgentResumes({
    limit: 1,
    afterIntentId: first.nextCursor!,
  });
  expect(second.queued).toBe(1);
  const end = await service.reconcileFundedAgentResumes({
    limit: 1,
    afterIntentId: second.nextCursor!,
  });
  expect(end.total).toBe(0);
  expect(end.nextCursor).toBeNull();
  const replay = await service.reconcileFundedAgentResumes({ limit: 10 });
  expect(replay.reused).toBe(1);
  expect(replay.queued).toBe(0);
  const persisted = await dbWrite.select().from(jobs);
  expect(persisted).toHaveLength(1);
  expect(persisted[0].organization_id).toBe(candidates[1].organizationId);
});

test("a failed admission is reported while other funded accounts still receive jobs", async () => {
  const broken = await seed();
  const healthy = await seed();
  await dbWrite.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION reject_selected_resume() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id = '${broken.organizationId}'::uuid THEN
        RAISE EXCEPTION 'queue insertion unavailable';
      END IF;
      RETURN NEW;
    END $$`),
  );
  await dbWrite.execute(
    sql.raw(`CREATE TRIGGER reject_resume_job BEFORE INSERT ON jobs
    FOR EACH ROW EXECUTE FUNCTION reject_selected_resume()`),
  );
  const result = await service.reconcileFundedAgentResumes({ limit: 10 });
  expect(result.queued).toBe(1);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0].agentId).toBe(broken.agentId);
  const persisted = await dbWrite.select().from(jobs);
  expect(persisted).toHaveLength(1);
  expect(persisted[0].organization_id).toBe(healthy.organizationId);
  const [org] = await dbWrite
    .select()
    .from(organizations)
    .where(eq(organizations.id, broken.organizationId));
  expect(Number(org.credit_balance)).toBe(10);
});

test("the daemon cursor reaches funded accounts and revisits an account after refill", async () => {
  const worker = await import("../../../../scripts/admin/daemons/provisioning-worker");
  worker.__setDepsForTests(null);
  try {
    const candidates = [await seed(), await seed()].sort((a, b) =>
      a.intentId.localeCompare(b.intentId),
    );
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "0" })
      .where(eq(organizations.id, candidates[0].organizationId));
    expect((await worker.processFundedResumeReconcileCycle(1)).unfunded).toBe(1);
    expect((await worker.processFundedResumeReconcileCycle(1)).queued).toBe(1);
    expect((await worker.processFundedResumeReconcileCycle(1)).total).toBe(0);
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "10" })
      .where(eq(organizations.id, candidates[0].organizationId));
    expect((await worker.processFundedResumeReconcileCycle(1)).queued).toBe(1);
    const persisted = await dbWrite.select().from(jobs);
    expect(persisted).toHaveLength(2);
    expect(new Set(persisted.map((job) => job.organization_id))).toEqual(
      new Set(candidates.map((candidate) => candidate.organizationId)),
    );
  } finally {
    worker.__setDepsForTests(null);
  }
});

for (const restoreOutcome of ["success", "funding-lost", "lease-lost", "grant-lost"] as const) {
  test(`automatic resume restores retained state before publication: ${restoreOutcome}`, async () => {
    const authority = await providerAuthority();
    await dbWrite
      .update(agentSandboxes)
      .set({
        database_status: "ready",
        database_uri: "postgres://fixture.invalid/retained",
        claimed_at: new Date(),
        environment_vars: { ELIZA_API_TOKEN: "fixture-only-token" },
      })
      .where(eq(agentSandboxes.id, authority.agentId));
    const state = {
      memories: [],
      config: { retained: authority.agentId },
      workspaceFiles: { "state.txt": "retained user state" },
    };
    const [backup] = await dbWrite
      .insert(agentSandboxBackups)
      .values({
        sandbox_record_id: authority.agentId,
        snapshot_type: "manual",
        state_data: state,
        state_data_storage: "inline",
        backup_kind: "full",
        size_bytes: Buffer.byteLength(JSON.stringify(state)),
      })
      .returning();
    const handle: SandboxHandle = {
      sandboxId: crypto.randomUUID(),
      bridgeUrl: "http://127.0.0.1:38719",
      healthUrl: "http://127.0.0.1:38719/health",
      metadata: {
        provider: "docker",
        nodeId: "fixture-node",
        hostname: "fixture.invalid",
        containerName: "fixture-container",
        replacementAttemptId: crypto.randomUUID(),
        allocationCounted: false,
        containerId: "exact-fixture-container",
      },
    };
    let creates = 0;
    let stops = 0;
    let restored = false;
    const provider: SandboxProvider = {
      async create(config) {
        creates += 1;
        await config.onReplacementCreateIntent!({
          ...handle,
          metadata: { ...handle.metadata, containerId: undefined },
        });
        await config.onReplacementCreated!(handle);
        return handle;
      },
      async checkHealth() {
        return true;
      },
      async stopForDeletion() {
        throw new Error("Unexpected deletion path");
      },
      async stopOnSpecificNodeForReplacement(nodeId, containerName, _vpnNodeId, locator) {
        expect(nodeId).toBe(handle.metadata!.nodeId);
        expect(containerName).toBe(handle.metadata!.containerName);
        expect(locator?.containerId).toBe("exact-fixture-container");
        stops += 1;
      },
    };
    const runtime = new ElizaSandboxService(provider);
    // External agent bootstrap HTTP boundary; the restore request remains real service serialization below.
    runtime["fetchAgentApi"] = async () => new Response(null, { status: 404 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe(`${handle.bridgeUrl}/api/restore`);
      expect(JSON.parse(String(init?.body))).toEqual(state);
      const [during] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, authority.agentId));
      expect(during.status).toBe("provisioning");
      expect(during.sandbox_id).toBeNull();
      expect(during.replacement_cleanup_container_id).toBe("exact-fixture-container");
      if (restoreOutcome === "funding-lost") {
        await dbWrite
          .update(organizations)
          .set({ credit_balance: "0" })
          .where(eq(organizations.id, authority.organizationId));
      }
      if (restoreOutcome === "lease-lost") {
        await dbWrite
          .update(jobExecutionLeases)
          .set({ expires_at: new Date(Date.now() - 1000) })
          .where(eq(jobExecutionLeases.job_id, authority.jobId));
      }
      if (restoreOutcome === "grant-lost") {
        await dbWrite
          .update(agentComputeStopIntents)
          .set({ status: "superseded" })
          .where(eq(agentComputeStopIntents.id, authority.intentId));
      }
      restored = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const result = await runtime.executeResume(
        authority.agentId,
        authority.organizationId,
        authority,
      );
      expect(restored).toBe(true);
      expect(creates).toBe(1);
      const [after] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, authority.agentId));
      expect(result.success).toBe(restoreOutcome === "success");
      if (restoreOutcome === "success") {
        expect(stops).toBe(0);
        expect(after.status).toBe("running");
        expect(after.sandbox_id).toBe(handle.sandboxId);
      } else if (restoreOutcome === "funding-lost") {
        expect(stops).toBe(1);
        expect(after.status).toBe("error");
        expect(after.sandbox_id).toBeNull();
      } else {
        expect(stops).toBe(0);
        expect(after.status).toBe("provisioning");
        expect(after.sandbox_id).toBeNull();
      }
      expect(after.replacement_cleanup_sandbox_id).toBe(
        restoreOutcome === "lease-lost" || restoreOutcome === "grant-lost"
          ? handle.sandboxId
          : null,
      );
      const [retained] = await dbWrite
        .select()
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.id, backup.id));
      expect(retained.state_data).toEqual(state);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const expireBeforeIntent of [true, false]) {
  test(`provider callback ${expireBeforeIntent ? "rejects expired creation" : "retains admitted receipt after lease loss"}`, async () => {
    const authority = await providerAuthority();
    const { sandbox } = await agentSandboxesRepository.admitPaymentResumeProvisioning(authority);
    const callbacks = elizaSandboxService["replacementCleanupCallbacks"](
      authority.agentId,
      authority.organizationId,
      {
        status: "provisioning",
        environmentRevision: sandbox.environment_revision,
        sandboxId: sandbox.sandbox_id,
        nodeId: sandbox.node_id,
        containerName: sandbox.container_name,
      },
      authority,
    );
    const handle: SandboxHandle = {
      sandboxId: crypto.randomUUID(),
      bridgeUrl: "http://fixture.invalid",
      healthUrl: "http://fixture.invalid/health",
      metadata: {
        provider: "docker",
        nodeId: "fixture-node",
        hostname: "fixture.invalid",
        containerName: "fixture-container",
        replacementAttemptId: crypto.randomUUID(),
        allocationCounted: false,
      },
    };
    if (!expireBeforeIntent) await callbacks.onReplacementCreateIntent(handle);
    await dbWrite
      .update(jobExecutionLeases)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(jobExecutionLeases.job_id, authority.jobId));
    if (expireBeforeIntent) {
      await expect(callbacks.onReplacementCreateIntent(handle)).rejects.toMatchObject({
        code: "PAYMENT_RESUME_PROVIDER_LEASE_LOST",
      });
    } else {
      await callbacks.onReplacementCreated({
        ...handle,
        metadata: { ...handle.metadata, containerId: "created-before-response" },
      });
    }
    const [current] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, authority.agentId));
    expect(current.sandbox_id).toBeNull();
    expect(current.status).toBe("provisioning");
    expect(current.replacement_cleanup_sandbox_id).toBe(
      expireBeforeIntent ? null : handle.sandboxId,
    );
    expect(current.replacement_cleanup_container_id).toBe(
      expireBeforeIntent ? null : "created-before-response",
    );
  });
}

test("a failed job that never claimed the stopped agent also waits before readmission", async () => {
  const candidate = await seed();
  const first = await service.enqueueFundedAgentResumeOnce(candidate);
  if (first.status !== "queued") throw new Error("Expected first automatic admission");
  await dbWrite
    .update(jobs)
    .set({
      status: "failed",
      completed_at: sql`clock_timestamp()`,
      execution_quiesced_at: sql`clock_timestamp()`,
    })
    .where(eq(jobs.id, first.job.id));
  expect(await service.enqueueFundedAgentResumeOnce(candidate)).toEqual({
    status: "authority_changed",
  });
  await dbWrite
    .update(jobs)
    .set({
      completed_at: sql`clock_timestamp() - interval '3 minutes'`,
      execution_quiesced_at: sql`clock_timestamp() - interval '3 minutes'`,
    })
    .where(eq(jobs.id, first.job.id));
  const retry = await service.enqueueFundedAgentResumeOnce(candidate);
  if (retry.status !== "queued") throw new Error("Expected due automatic retry");
  expect(retry.job.id).not.toBe(first.job.id);
  const pending = await dbWrite.select().from(jobs).where(eq(jobs.status, "pending"));
  expect(pending).toHaveLength(1);
  expect(pending[0].id).toBe(retry.job.id);
});
