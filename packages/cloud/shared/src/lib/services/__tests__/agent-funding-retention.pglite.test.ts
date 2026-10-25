/**
 * Funding-stop retention (#22967) on PGlite with a fake clock. Discovery reads
 * the real billing-stop and plan-fallback authorities, the sleep job is
 * enqueued through the real ProvisioningJobService, and paying is proven with
 * the real automatic-resume reconciler. Only the provider effect of a sleep
 * (container removal) and the email transport are simulated.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("agent-funding-retention.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { AGENT_PRICING } from "@elizaos/cloud-sdk/browser-contracts";
import { pushSchema } from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentBackupObjects } from "../../../db/schemas/agent-backup-catalog";
import { agentComputeFunding } from "../../../db/schemas/agent-compute-funding";
import { agentComputeStopIntents } from "../../../db/schemas/agent-compute-stop-intents";
import { agentFundingRetentions } from "../../../db/schemas/agent-funding-retentions";
import { agentNodeIncarnationHistories } from "../../../db/schemas/agent-node-incarnation-histories";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../../db/schemas/api-keys";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../../../db/schemas/billing-subscriptions";
import { containers } from "../../../db/schemas/containers";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import { dockerNodes } from "../../../db/schemas/docker-nodes";
import { generations } from "../../../db/schemas/generations";
import { jobExecutionLeases } from "../../../db/schemas/job-execution-leases";
import { jobs } from "../../../db/schemas/jobs";
import { orgRateLimitOverrides } from "../../../db/schemas/org-rate-limit-overrides";
import { orgStorageQuota } from "../../../db/schemas/org-storage-quota";
import { organizationConfig } from "../../../db/schemas/organization-config";
import { organizationEntitlements } from "../../../db/schemas/organization-entitlements";
import { organizations } from "../../../db/schemas/organizations";
import { personalDedicatedFallbacks } from "../../../db/schemas/personal-dedicated-fallbacks";
import { personalDedicatedUpgradeAuthorities } from "../../../db/schemas/personal-dedicated-upgrade-authorities";
import { providerAdmissions } from "../../../db/schemas/provider-admissions";
import { subscriptionAllowancePeriods } from "../../../db/schemas/subscription-allowance-periods";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import type { AgentRetentionNotice } from "../agent-funding-retention";

const TEST_TIMEOUT = 300_000;
const OWNER_ID = "10000000-0000-4000-8000-000000000067";
const DAY = 24 * 60 * 60 * 1000;
const FUNDED = AGENT_PRICING.MINIMUM_DEPOSIT.toFixed(6);

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let ProvisioningJobService: typeof import("@elizaos/cloud-shared/node").ProvisioningJobService;
let AgentFundingRetentionService: typeof import("../agent-funding-retention").AgentFundingRetentionService;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ ProvisioningJobService } = await import("@elizaos/cloud-shared/node"));
  ({ AgentFundingRetentionService } = await import("../agent-funding-retention"));
  const schema = {
    organizations,
    users,
    userCharacters,
    agentSandboxes,
    agentNodeIncarnationHistories,
    agentSandboxBackups,
    agentBackupCatalogAuthorities,
    agentBackupObjects,
    agentComputeStopIntents,
    apiKeys,
    generations,
    usageRecords,
    jobs,
    jobExecutionLeases,
    creditTransactions,
    personalDedicatedUpgradeAuthorities,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  // The retention migration is replayed twice to prove it is idempotent.
  for (const name of [
    "0189_agent_sandbox_lifecycle_revision_scope.sql",
    "0479_organization_payment_reversal_holds.sql",
    "0480_personal_dedicated_fallbacks.sql",
    "0490_personal_dedicated_fallback_entitlement.sql",
    "0494_payment_reversal_shortfall_holds.sql",
    "0501_agent_funding_retention.sql",
    "0501_agent_funding_retention.sql",
  ]) {
    const migration = await readFile(
      join(import.meta.dir, `../../../db/migrations/${name}`),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(sql.raw(statement));
    }
  }
  for (const [name, table] of [
    ["docker_nodes", dockerNodes],
    ["containers", containers],
    ["agent_compute_funding", agentComputeFunding],
    ["billing_subscriptions", billingSubscriptions],
    ["billing_subscription_revisions", billingSubscriptionRevisions],
    ["organization_subscription_authorities", organizationSubscriptionAuthorities],
    ["subscription_allowance_periods", subscriptionAllowancePeriods],
    ["org_rate_limit_overrides", orgRateLimitOverrides],
    ["organization_config", organizationConfig],
    ["org_storage_quota", orgStorageQuota],
    ["provider_admissions", providerAdmissions],
    ["organization_entitlements", organizationEntitlements],
  ] as const) {
    await dbWrite.execute(
      sql.raw(
        `CREATE TABLE ${name} (${getTableConfig(table)
          .columns.map((c) => `"${c.name}" ${c.getSQLType()}`)
          .join(",")})`,
      ),
    );
  }
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

interface Seeded {
  orgId: string;
  userId: string;
  agentId: string;
  intentId: string;
}

/** An agent stopped by a provider-confirmed billing stop at `stoppedAt`. */
async function seedCreditStoppedAgent(balance: string, stoppedAt: Date): Promise<Seeded> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({
      name: "Retention Org",
      slug: unique("org"),
      credit_balance: balance,
      billing_email: `${unique("billing")}@example.test`,
    })
    .returning();
  await dbWrite.execute(
    sql`INSERT INTO organization_subscription_authorities (organization_id, state, policy_generation) VALUES (${organization.id}, 'none', 1)`,
  );
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: unique("steward"), organization_id: organization.id })
    .returning();
  const [agent] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organization.id,
      user_id: user.id,
      agent_name: unique("agent"),
      status: "stopped",
      billing_status: "suspended",
      execution_tier: "dedicated-always",
    })
    .returning();
  const [stopJob] = await dbWrite
    .insert(jobs)
    .values({
      organization_id: organization.id,
      agent_id: agent.id,
      user_id: user.id,
      type: "agent_suspend",
      status: "completed",
      data: {
        agentId: agent.id,
        organizationId: organization.id,
        userId: user.id,
        authorization: "billing_request",
      },
      created_at: new Date(stoppedAt.getTime() - 10 * 60 * 1000),
    })
    .returning();
  const [intent] = await dbWrite
    .insert(agentComputeStopIntents)
    .values({
      organization_id: organization.id,
      agent_id: agent.id,
      job_id: stopJob.id,
      lifecycle_revision: agent.lifecycle_revision,
      authorization: "billing_request",
      status: "provider_confirmed",
      provider_confirmed_at: stoppedAt,
      created_at: new Date(stoppedAt.getTime() - 10 * 60 * 1000),
    })
    .returning();
  return { orgId: organization.id, userId: user.id, agentId: agent.id, intentId: intent.id };
}

/** Fake clock plus a recording mail transport and the real sleep enqueue. */
function harness(start: Date, transport?: (notice: AgentRetentionNotice) => Promise<boolean>) {
  let now = start;
  const notices: AgentRetentionNotice[] = [];
  const jobService = new ProvisioningJobService({ executionOwnerId: OWNER_ID });
  const retention = new AgentFundingRetentionService({
    now: () => now,
    sendNotice: async (notice) => {
      notices.push(notice);
      return transport ? transport(notice) : true;
    },
    enqueueSleep: async (input) => {
      const { job } = await jobService.enqueueAgentSleepOnce(input);
      return { jobId: job.id };
    },
  });
  return {
    notices,
    jobService,
    retention,
    at(date: Date) {
      now = date;
    },
  };
}

async function retentionFor(agentId: string) {
  return dbWrite
    .select()
    .from(agentFundingRetentions)
    .where(eq(agentFundingRetentions.agent_id, agentId));
}

async function jobsFor(agentId: string, type: string) {
  return dbWrite
    .select()
    .from(jobs)
    .where(and(eq(jobs.agent_id, agentId), eq(jobs.type, type)));
}

test(
  "an unfunded agent is kept 30 days, notified at 7 and 1 days, then its container is removed and the latest backup kept 90 days",
  async () => {
    const stoppedAt = new Date();
    const seeded = await seedCreditStoppedAgent("0.000000", stoppedAt);
    const [backup] = await dbWrite
      .insert(agentSandboxBackups)
      .values({
        sandbox_record_id: seeded.agentId,
        snapshot_type: "pre-shutdown",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        size_bytes: 128,
      })
      .returning();
    const h = harness(new Date(stoppedAt.getTime() + 60 * 60 * 1000));

    const first = await h.retention.reconcile();
    expect(first.failures).toEqual([]);
    let [row] = await retentionFor(seeded.agentId);
    expect(row).toMatchObject({
      reason: "credits_exhausted",
      stop_intent_id: seeded.intentId,
      state: "retained",
    });
    expect(row.delete_after.getTime()).toBe(stoppedAt.getTime() + 30 * DAY);

    // Nothing is sent before the 7-day window.
    h.at(new Date(stoppedAt.getTime() + 22 * DAY));
    await h.retention.reconcile();
    expect(h.notices).toHaveLength(0);

    // 7 days before deletion: exactly one notice, even across repeated runs.
    h.at(new Date(stoppedAt.getTime() + 23 * DAY + 60_000));
    await h.retention.reconcile();
    await h.retention.reconcile();
    expect(h.notices.map((n) => n.daysRemaining)).toEqual([7]);
    expect(h.notices[0]).toMatchObject({
      agentName: expect.any(String),
      reason: "credits_exhausted",
    });
    expect(h.notices[0]?.deleteAfter.getTime()).toBe(stoppedAt.getTime() + 30 * DAY + 60_000);

    // 1 day before deletion.
    h.at(new Date(stoppedAt.getTime() + 29 * DAY + 60_000));
    await h.retention.reconcile();
    expect(h.notices.map((n) => n.daysRemaining)).toEqual([7, 1]);
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);

    // Past the deadline: the container is removed through the sleep lifecycle.
    h.at(new Date(stoppedAt.getTime() + 30 * DAY + 60_000));
    const expiry = await h.retention.reconcile();
    expect(expiry.containerDeletionsQueued).toBe(1);
    const sleeps = await jobsFor(seeded.agentId, "agent_sleep");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toMatchObject({ status: "pending" });
    [row] = await retentionFor(seeded.agentId);
    expect(row).toMatchObject({ state: "container_deletion_pending", sleep_job_id: sleeps[0]?.id });

    // Provider effect of the sleep job: container removed, backup kept.
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "sleeping", lifecycle_job_id: null })
      .where(eq(agentSandboxes.id, seeded.agentId));
    const removedAt = new Date(stoppedAt.getTime() + 30 * DAY + 2 * 60 * 60 * 1000);
    h.at(removedAt);
    const settled = await h.retention.reconcile();
    expect(settled.containersDeleted).toBe(1);
    [row] = await retentionFor(seeded.agentId);
    expect(row).toMatchObject({ state: "container_deleted", retained_backup_id: backup.id });
    expect(row.container_deleted_at?.getTime()).toBe(removedAt.getTime());
    expect(row.backup_retain_until?.getTime()).toBe(removedAt.getTime() + 90 * DAY);
    const [kept] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backup.id));
    expect(kept).toBeDefined();
    expect(h.notices).toHaveLength(2);
  },
  TEST_TIMEOUT,
);

test(
  "paying before the deadline resumes the same agent and nothing is deleted",
  async () => {
    const stoppedAt = new Date();
    const seeded = await seedCreditStoppedAgent("0.000000", stoppedAt);
    const h = harness(new Date(stoppedAt.getTime() + 60 * 60 * 1000));
    await h.retention.reconcile();
    expect(await retentionFor(seeded.agentId)).toHaveLength(1);

    // The customer pays on day 20; the existing automatic resume admits a
    // resume for the same agent id.
    await dbWrite
      .update(organizations)
      .set({ credit_balance: FUNDED })
      .where(eq(organizations.id, seeded.orgId));
    const resumed = await h.jobService.reconcileBillingSuspendedResumes({ limit: 500 });
    expect(resumed.failures).toEqual([]);
    const resumeJobs = await jobsFor(seeded.agentId, "agent_resume");
    expect(resumeJobs).toHaveLength(1);
    expect(resumeJobs[0]?.data).toMatchObject({ agentId: seeded.agentId });

    // While that resume is in flight, the deadline passing never deletes.
    h.at(new Date(stoppedAt.getTime() + 31 * DAY));
    await h.retention.reconcile();
    await h.retention.reconcile();
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);

    // The resume completes: the same agent runs again and the clock closes.
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "running", billing_status: "active" })
      .where(eq(agentSandboxes.id, seeded.agentId));
    const closed = await h.retention.reconcile();
    expect(closed.closed).toBe(1);
    const [row] = await retentionFor(seeded.agentId);
    expect(row).toMatchObject({ state: "closed", closed_reason: "funding_restored" });
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);
  },
  TEST_TIMEOUT,
);

test(
  "a stop discovered late still gets the full notice schedule before deletion",
  async () => {
    const stoppedAt = new Date(Date.now() - 45 * DAY);
    const seeded = await seedCreditStoppedAgent("0.000000", stoppedAt);
    const now = new Date();
    const h = harness(now);
    await h.retention.reconcile();
    const [row] = await retentionFor(seeded.agentId);
    expect(row.delete_after.getTime()).toBe(now.getTime() + 7 * DAY);
    expect(h.notices.map((n) => n.daysRemaining)).toEqual([7]);
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);

    // Without the 1-day notice the deadline moves instead of deleting.
    await dbWrite
      .update(agentFundingRetentions)
      .set({ delete_after: new Date(now.getTime() + DAY) })
      .where(eq(agentFundingRetentions.id, row.id));
    h.at(new Date(now.getTime() + 2 * DAY));
    await h.retention.reconcile();
    expect(h.notices.map((n) => n.daysRemaining)).toEqual([7, 1]);
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);
    const [moved] = await retentionFor(seeded.agentId);
    expect(moved.delete_after.getTime()).toBe(now.getTime() + 3 * DAY);
  },
  TEST_TIMEOUT,
);

test(
  "a lapsed Plus/Pro plan uses the fallback retention deadline and closes on recovery",
  async () => {
    const stoppedAt = new Date();
    const seeded = await seedCreditStoppedAgent(FUNDED, stoppedAt);
    // This agent was stopped by the plan withdrawal, not by credits.
    await dbWrite
      .update(agentComputeStopIntents)
      .set({ authorization: "user_request" })
      .where(eq(agentComputeStopIntents.id, seeded.intentId));
    const retainUntil = new Date(stoppedAt.getTime() + 30 * DAY);
    const [fallback] = await dbWrite
      .insert(personalDedicatedFallbacks)
      .values({
        organization_id: seeded.orgId,
        user_id: seeded.userId,
        source_agent_id: `personal:${seeded.userId}`,
        dedicated_agent_id: seeded.agentId,
        generation: 1,
        state: "shared_active",
        reason: "subscription_ended",
        entitlement_revision: 3,
        retain_until: retainUntil,
        journal_room_id: unique("fallback-journal"),
        activated_at: stoppedAt,
      })
      .returning();

    const h = harness(new Date(stoppedAt.getTime() + 60 * 60 * 1000));
    await h.retention.reconcile();
    const [row] = await retentionFor(seeded.agentId);
    expect(row).toMatchObject({
      reason: "subscription_lapsed",
      fallback_id: fallback.id,
      state: "retained",
    });
    expect(row.delete_after.getTime()).toBe(retainUntil.getTime());

    // Restored entitlement moves the interval to recovery; the clock closes.
    await dbWrite
      .update(personalDedicatedFallbacks)
      .set({ state: "recovery_pending", recovery_requested_at: new Date() })
      .where(eq(personalDedicatedFallbacks.id, fallback.id));
    h.at(new Date(stoppedAt.getTime() + 31 * DAY));
    const closed = await h.retention.reconcile();
    expect(closed.closed).toBe(1);
    const [after] = await retentionFor(seeded.agentId);
    expect(after).toMatchObject({ state: "closed", closed_reason: "funding_restored" });
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);
  },
  TEST_TIMEOUT,
);

for (const [fallbackState, runtimeStatus] of [
  ["shared_active", "running"],
  ["fallback_pending", "provisioning"],
] as const) {
  test(
    `a lapsed plan found while the Dedicated runtime is still ${runtimeStatus} (${fallbackState}) keeps its clock until the plan is restored`,
    async () => {
      const stoppedAt = new Date();
      const seeded = await seedCreditStoppedAgent(FUNDED, stoppedAt);
      await dbWrite
        .update(agentComputeStopIntents)
        .set({ authorization: "user_request" })
        .where(eq(agentComputeStopIntents.id, seeded.intentId));
      // Fallback activation commits `shared_active` in the same transaction
      // that only enqueues the suspend, and a lifecycle-admission conflict
      // leaves it `fallback_pending`: either way the runtime is still live.
      await dbWrite
        .update(agentSandboxes)
        .set({ status: runtimeStatus, billing_status: "active" })
        .where(eq(agentSandboxes.id, seeded.agentId));
      const [fallback] = await dbWrite
        .insert(personalDedicatedFallbacks)
        .values({
          organization_id: seeded.orgId,
          user_id: seeded.userId,
          source_agent_id: `personal:${seeded.userId}`,
          dedicated_agent_id: seeded.agentId,
          generation: 1,
          state: fallbackState,
          reason: "subscription_payment_failed",
          entitlement_revision: 4,
          retain_until: new Date(stoppedAt.getTime() + 30 * DAY),
          journal_room_id: unique("fallback-journal"),
          activated_at: stoppedAt,
        })
        .returning();

      const h = harness(new Date(stoppedAt.getTime() + 60 * 1000));
      const first = await h.retention.reconcile();
      expect(first).toMatchObject({ discovered: 1, closed: 0 });
      const [open] = await retentionFor(seeded.agentId);
      expect(open).toMatchObject({ fallback_id: fallback.id, state: "retained" });

      // The suspend lands; the plan is still withdrawn, so the clock runs on.
      await dbWrite
        .update(agentSandboxes)
        .set({ status: "stopped" })
        .where(eq(agentSandboxes.id, seeded.agentId));
      h.at(new Date(stoppedAt.getTime() + 2 * DAY));
      expect(await h.retention.reconcile()).toMatchObject({ discovered: 0, closed: 0 });
      expect((await retentionFor(seeded.agentId))[0]?.state).toBe("retained");

      // Only the plan's own recovery closes it.
      await dbWrite
        .update(personalDedicatedFallbacks)
        .set({ state: "recovery_pending", recovery_requested_at: new Date() })
        .where(eq(personalDedicatedFallbacks.id, fallback.id));
      h.at(new Date(stoppedAt.getTime() + 3 * DAY));
      expect(await h.retention.reconcile()).toMatchObject({ closed: 1 });
      expect((await retentionFor(seeded.agentId))[0]).toMatchObject({
        state: "closed",
        closed_reason: "funding_restored",
      });
    },
    TEST_TIMEOUT,
  );
}

test(
  "failed notice delivery never becomes deletion authority and can retry",
  async () => {
    const stoppedAt = new Date();
    const seeded = await seedCreditStoppedAgent("0.000000", stoppedAt);
    let accepted = false;
    const now = new Date(stoppedAt.getTime() + 23 * DAY);
    const h = harness(now, async () => accepted);
    const failed = await h.retention.reconcile();
    expect(failed.failures).toHaveLength(1);
    const [unsent] = await retentionFor(seeded.agentId);
    expect(unsent.notice_7d_sent_at).toBeNull();
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);
    accepted = true;
    const retry = await h.retention.reconcile();
    expect(retry.failures).toEqual([]);
    expect(retry.noticesSent).toBe(1);
    const [sent] = await retentionFor(seeded.agentId);
    expect(sent.notice_7d_sent_at?.getTime()).toBe(now.getTime());
  },
  TEST_TIMEOUT,
);

test(
  "a removed container without a backup remains an actionable failure",
  async () => {
    const stoppedAt = new Date();
    const seeded = await seedCreditStoppedAgent("0.000000", stoppedAt);
    const h = harness(stoppedAt);
    await h.retention.reconcile();
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "sleeping" })
      .where(eq(agentSandboxes.id, seeded.agentId));
    h.at(new Date(stoppedAt.getTime() + 31 * DAY));
    const result = await h.retention.reconcile();
    expect(result.failures).toHaveLength(1);
    expect(result.containersDeleted).toBe(0);
    const [row] = await retentionFor(seeded.agentId);
    expect(row.state).toBe("retained");
    expect(row.retained_backup_id).toBeNull();
  },
  TEST_TIMEOUT,
);

test(
  "retention cannot sleep an agent that resumed after its state was read",
  async () => {
    const stoppedAt = new Date();
    const seeded = await seedCreditStoppedAgent("0.000000", stoppedAt);
    const h = harness(stoppedAt);
    const [observed] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, seeded.agentId));
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "running", lifecycle_revision: observed.lifecycle_revision + 1 })
      .where(eq(agentSandboxes.id, seeded.agentId));
    await expect(
      h.jobService.enqueueAgentSleepOnce({
        agentId: seeded.agentId,
        organizationId: seeded.orgId,
        userId: seeded.userId,
        expectedLifecycleRevision: observed.lifecycle_revision,
      }),
    ).rejects.toMatchObject({ code: "AGENT_SLEEP_AUTHORITY_CHANGED" });
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);
  },
  TEST_TIMEOUT,
);

test(
  "a missed first notice postpones deletion for the full seven days",
  async () => {
    const stoppedAt = new Date();
    const seeded = await seedCreditStoppedAgent("0.000000", stoppedAt);
    const h = harness(stoppedAt);
    await h.retention.reconcile();
    const late = new Date(stoppedAt.getTime() + 31 * DAY);
    h.at(late);
    await h.retention.reconcile();
    expect(h.notices.map((n) => n.daysRemaining)).toEqual([7]);
    const [row] = await retentionFor(seeded.agentId);
    expect(row.delete_after.getTime()).toBe(late.getTime() + 7 * DAY);
    expect(await jobsFor(seeded.agentId, "agent_sleep")).toHaveLength(0);
  },
  TEST_TIMEOUT,
);
