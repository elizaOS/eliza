/** Drives billing-suspension recovery through real ProvisioningJobService discovery, lifecycle-locked admission, job claim and execution-time recheck on PGlite. Funding is read through the real credit gate; only the provider-level resume effect is controlled. */

import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("billing-suspension-resume.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentBackupObjects } from "../../../db/schemas/agent-backup-catalog";
import { agentComputeFunding } from "../../../db/schemas/agent-compute-funding";
import { agentComputeStopIntents } from "../../../db/schemas/agent-compute-stop-intents";
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
import { organizations } from "../../../db/schemas/organizations";
import { providerAdmissions } from "../../../db/schemas/provider-admissions";
import { subscriptionAllowancePeriods } from "../../../db/schemas/subscription-allowance-periods";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import { AGENT_PRICING } from "../../constants/agent-pricing";

const TEST_TIMEOUT = 300_000;
const OWNER_ID = "10000000-0000-4000-8000-000000000042";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let ProvisioningJobService: typeof import("../provisioning-jobs").ProvisioningJobService;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ ProvisioningJobService } = await import("../provisioning-jobs"));
  ({ ElizaSandboxService } = await import("../eliza-sandbox"));
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
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  const migration = await readFile(
    join(import.meta.dir, "../../../db/migrations/0189_agent_sandbox_lifecycle_revision_scope.sql"),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  for (const [name, table] of [
    ["docker_nodes", dockerNodes],
    ["containers", containers],
    ["agent_compute_funding", agentComputeFunding],
    ["billing_subscriptions", billingSubscriptions],
    ["billing_subscription_revisions", billingSubscriptionRevisions],
    ["organization_subscription_authorities", organizationSubscriptionAuthorities],
    ["subscription_allowance_periods", subscriptionAllowancePeriods],
    ["credit_transactions", creditTransactions],
    ["org_rate_limit_overrides", orgRateLimitOverrides],
    ["organization_config", organizationConfig],
    ["org_storage_quota", orgStorageQuota],
    ["provider_admissions", providerAdmissions],
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

interface Suspended {
  orgId: string;
  userId: string;
  agentId: string;
  intentId: string;
}

async function seedBillingSuspendedAgent(balance: string): Promise<Suspended> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: unique("org"), credit_balance: balance })
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
      created_at: new Date(Date.now() - 60 * 60 * 1000),
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
      provider_confirmed_at: new Date(Date.now() - 50 * 60 * 1000),
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    })
    .returning();
  return { orgId: organization.id, userId: user.id, agentId: agent.id, intentId: intent.id };
}

const FUNDED = AGENT_PRICING.MINIMUM_DEPOSIT.toFixed(6);

async function resumeJobs(agentId: string) {
  return dbWrite
    .select()
    .from(jobs)
    .where(and(eq(jobs.agent_id, agentId), eq(jobs.type, "agent_resume")));
}

let service: InstanceType<typeof ProvisioningJobService>;
beforeEach(() => {
  service = new ProvisioningJobService({ executionOwnerId: OWNER_ID });
});

/** Reconcile every page so unrelated rows from other tests cannot hide a candidate. */
async function reconcileAll() {
  let cursor: string | undefined;
  const totals = { queued: 0, reused: 0, unfunded: 0, authorityChanged: 0, failures: 0 };
  for (;;) {
    const page = await service.reconcileBillingSuspendedResumes({
      limit: 50,
      afterIntentId: cursor,
    });
    totals.queued += page.queued;
    totals.reused += page.reused;
    totals.unfunded += page.unfunded;
    totals.authorityChanged += page.authorityChanged;
    totals.failures += page.failures.length;
    if (!page.nextCursor) return totals;
    cursor = page.nextCursor;
  }
}

test(
  "a funded provider-confirmed billing suspension converges on exactly one automatic resume",
  async () => {
    const suspended = await seedBillingSuspendedAgent(FUNDED);
    const [first, second] = await Promise.all([reconcileAll(), reconcileAll()]);
    expect(first.failures + second.failures).toBe(0);
    const again = await reconcileAll();
    expect(again.failures).toBe(0);
    const queued = await resumeJobs(suspended.agentId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "pending" });
    expect(queued[0].data).toMatchObject({
      agentId: suspended.agentId,
      automaticResume: { stopIntentId: suspended.intentId },
    });
  },
  TEST_TIMEOUT,
);

test(
  "unfunded, manually stopped, deleting, running and superseded agents are not resumed",
  async () => {
    const unfunded = await seedBillingSuspendedAgent("0.000000");

    const manual = await seedBillingSuspendedAgent(FUNDED);
    await dbWrite.insert(agentComputeStopIntents).values({
      organization_id: manual.orgId,
      agent_id: manual.agentId,
      lifecycle_revision: 999,
      authorization: "user_request",
      status: "provider_confirmed",
      provider_confirmed_at: new Date(),
    });

    const deleting = await seedBillingSuspendedAgent(FUNDED);
    await dbWrite
      .update(agentSandboxes)
      .set({ deletion_attempt_id: crypto.randomUUID(), deletion_started_at: new Date() })
      .where(eq(agentSandboxes.id, deleting.agentId));

    const running = await seedBillingSuspendedAgent(FUNDED);
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "running" })
      .where(eq(agentSandboxes.id, running.agentId));

    const laterLifecycle = await seedBillingSuspendedAgent(FUNDED);
    await dbWrite.insert(jobs).values({
      organization_id: laterLifecycle.orgId,
      agent_id: laterLifecycle.agentId,
      user_id: laterLifecycle.userId,
      type: "agent_sleep",
      status: "completed",
      data: {
        agentId: laterLifecycle.agentId,
        organizationId: laterLifecycle.orgId,
        userId: laterLifecycle.userId,
      },
    });

    const fenced = await seedBillingSuspendedAgent(FUNDED);
    await dbWrite
      .update(organizations)
      .set({ paid_work_fenced_at: new Date() })
      .where(eq(organizations.id, fenced.orgId));

    const totals = await reconcileAll();
    expect(totals.failures).toBe(0);
    expect(totals.unfunded).toBeGreaterThanOrEqual(1);
    for (const agent of [unfunded, manual, deleting, running, laterLifecycle, fenced]) {
      expect(await resumeJobs(agent.agentId)).toHaveLength(0);
    }

    // Funding returning later is picked up by the next scan without any
    // browser request: the unfunded suspension is repaired by reconciliation.
    await dbWrite
      .update(organizations)
      .set({ credit_balance: FUNDED })
      .where(eq(organizations.id, unfunded.orgId));
    await reconcileAll();
    expect(await resumeJobs(unfunded.agentId)).toHaveLength(1);
  },
  TEST_TIMEOUT,
);

test(
  "execution rechecks authority: a user stop after admission wins and funded execution resumes",
  async () => {
    const superseded = await seedBillingSuspendedAgent(FUNDED);
    const funded = await seedBillingSuspendedAgent(FUNDED);
    await reconcileAll();
    // The owner stops the agent again after the automatic job was admitted.
    await dbWrite.insert(agentComputeStopIntents).values({
      organization_id: superseded.orgId,
      agent_id: superseded.agentId,
      lifecycle_revision: 1_000,
      authorization: "user_request",
      status: "provider_confirmed",
      provider_confirmed_at: new Date(),
    });
    const resume = spyOn(ElizaSandboxService.prototype, "executeResume").mockResolvedValue({
      success: true,
      containerStarted: true,
      reprovisioned: false,
    });
    try {
      for (let pass = 0; pass < 5; pass++) {
        await service.processPendingJobs(20, { jobTypes: ["agent_resume"] });
        const pending = [
          ...(await resumeJobs(superseded.agentId)),
          ...(await resumeJobs(funded.agentId)),
        ].filter((job) => job.status === "pending" || job.status === "in_progress");
        if (pending.length === 0) break;
      }
      const resumedAgents = resume.mock.calls.map((call) => call[0]);
      expect(resumedAgents).toContain(funded.agentId);
      expect(resumedAgents).not.toContain(superseded.agentId);
      const [skipped] = await resumeJobs(superseded.agentId);
      expect(skipped).toMatchObject({ status: "completed" });
      expect(skipped.result).toMatchObject({
        skipped: "authority_changed",
        containerStarted: false,
      });
      const [completed] = await resumeJobs(funded.agentId);
      expect(completed).toMatchObject({ status: "completed" });
    } finally {
      resume.mockRestore();
    }
  },
  TEST_TIMEOUT,
);
