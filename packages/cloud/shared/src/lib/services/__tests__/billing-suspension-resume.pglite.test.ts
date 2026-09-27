/** Drives billing-suspension recovery and the Dedicated-to-Shared fallback authority through real ProvisioningJobService discovery, lifecycle-locked admission, job claim and execution-time recheck on PGlite. Funding is read through the real credit gate; only the provider-level resume effect is controlled. */

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
    creditTransactions,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  // The reversal-hold migrations are replayed to prove they are idempotent.
  for (const name of [
    "0189_agent_sandbox_lifecycle_revision_scope.sql",
    "0479_organization_payment_reversal_holds.sql",
    "0479_organization_payment_reversal_holds.sql",
    "0486_payment_reversal_shortfall_holds.sql",
    "0486_payment_reversal_shortfall_holds.sql",
    "0480_personal_dedicated_fallbacks.sql",
    "0480_personal_dedicated_fallbacks.sql",
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

test(
  "an underfunding reversal hold fails paid admission and automatic resume closed until repaid",
  async () => {
    const held = await seedBillingSuspendedAgent(FUNDED);
    const { creditsService } = await import("../credits");
    const { billingHoldService } = await import("../billing-hold");
    const { checkAgentCreditGate } = await import("../agent-billing-gate");
    const clawback = await creditsService.clawbackCredits({
      organizationId: held.orgId,
      amount: AGENT_PRICING.MINIMUM_DEPOSIT + 5,
      description: "refund clawback",
      stripePaymentIntentId: `stripe:refund:${unique("ch")}:1`,
    });
    expect(clawback.shortfallAmount).toBeCloseTo(5, 6);

    // Funds that land without settling the shortfall do not lift the hold.
    await creditsService.addCredits({
      organizationId: held.orgId,
      amount: (AGENT_PRICING.MINIMUM_DEPOSIT + 5).toFixed(6),
      description: "grant",
    });
    const gate = await checkAgentCreditGate(held.orgId);
    expect(gate).toMatchObject({
      allowed: false,
      paymentReversalHold: true,
      paymentReversalOutstandingUsd: "5.000000",
    });
    await reconcileAll();
    expect(await resumeJobs(held.agentId)).toHaveLength(0);

    const settled = await billingHoldService.settleOutstandingShortfalls(held.orgId);
    expect(settled).toMatchObject({ appliedUsd: "5.000000", outstandingUsd: "0.000000" });
    expect(await checkAgentCreditGate(held.orgId)).toMatchObject({ allowed: true });
    await reconcileAll();
    expect(await resumeJobs(held.agentId)).toHaveLength(1);
  },
  TEST_TIMEOUT,
);

test(
  "Dedicated access is withdrawn only by a confirmed unfunded billing stop, into a scoped reversible journal",
  async () => {
    const fallback = await import("../personal-dedicated-fallback");
    const suspended = await seedBillingSuspendedAgent("0.000000");
    const sourceAgentId = `personal:${crypto.randomUUID()}`;
    const target = { id: suspended.agentId, status: "stopped" as const };
    const input = {
      dedicated: target,
      organizationId: suspended.orgId,
      userId: suspended.userId,
      sourceAgentId,
    };

    // Transient and non-billing states never withdraw access.
    for (const status of ["running", "provisioning", "sleeping", "error"] as const) {
      expect(
        await fallback.resolvePersonalDedicatedAccess({ ...target, status }, suspended.orgId),
      ).toEqual({ access: "dedicated" });
    }
    // A different organization cannot read this agent's suspension.
    expect(
      await fallback.resolvePersonalDedicatedAccess(
        target,
        (await seedBillingSuspendedAgent(FUNDED)).orgId,
      ),
    ).toEqual({ access: "dedicated" });

    const first = await fallback.preparePersonalSharedFallback(input);
    const replay = await fallback.preparePersonalSharedFallback(input);
    if (!first || !replay) throw new Error("Expected an active Shared fallback");
    expect(first.accountState).toEqual({
      access: "shared_fallback",
      reason: "billing_suspended",
      dedicatedMemory: "unavailable",
      generation: 1,
      recoveryAction: { kind: "billing", path: "/cloud/billing" },
    });
    // The journal is a new scoped room, never the canonical conversation.
    expect(first.journalRoomId).toStartWith("fallback:");
    expect(first.journalRoomId).not.toBe(sourceAgentId);
    expect(replay.journalRoomId).toBe(first.journalRoomId);
    const concurrent = await Promise.all([
      fallback.preparePersonalSharedFallback(input),
      fallback.preparePersonalSharedFallback(input),
    ]);
    expect(concurrent.map((entry) => entry?.journalRoomId)).toEqual([
      first.journalRoomId,
      first.journalRoomId,
    ]);

    // Funding returning keeps Dedicated authority (automatic resume owns it).
    await dbWrite
      .update(organizations)
      .set({ credit_balance: FUNDED })
      .where(eq(organizations.id, suspended.orgId));
    expect(await fallback.preparePersonalSharedFallback(input)).toBeNull();
    const recovered = await fallback.recoverPersonalSharedFallback({
      organizationId: suspended.orgId,
      userId: suspended.userId,
      sourceAgentId,
      dedicatedAgentId: suspended.agentId,
    });
    expect(recovered).toMatchObject({ state: "recovered", generation: 1 });
    expect(
      await fallback.recoverPersonalSharedFallback({
        organizationId: suspended.orgId,
        userId: suspended.userId,
        sourceAgentId,
        dedicatedAgentId: suspended.agentId,
      }),
    ).toBeNull();

    // A later withdrawal opens a new generation and journal; the recovered
    // interval is never reopened.
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "0.000000" })
      .where(eq(organizations.id, suspended.orgId));
    const second = await fallback.preparePersonalSharedFallback(input);
    expect(second?.accountState.generation).toBe(2);
    expect(second?.journalRoomId).not.toBe(first.journalRoomId);

    // A later user stop wins: the billing suspension no longer withdraws access.
    await dbWrite.insert(agentComputeStopIntents).values({
      organization_id: suspended.orgId,
      agent_id: suspended.agentId,
      lifecycle_revision: 2_000,
      authorization: "user_request",
      status: "provider_confirmed",
      provider_confirmed_at: new Date(),
    });
    expect(await fallback.resolvePersonalDedicatedAccess(target, suspended.orgId)).toEqual({
      access: "dedicated",
    });
  },
  TEST_TIMEOUT,
);
