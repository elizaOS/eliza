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

import { AGENT_PRICING } from "@elizaos/cloud-sdk/browser-contracts";
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
import { organizationEntitlements } from "../../../db/schemas/organization-entitlements";
import { organizations } from "../../../db/schemas/organizations";
import { personalDedicatedFallbacks } from "../../../db/schemas/personal-dedicated-fallbacks";
import { personalDedicatedUpgradeAuthorities } from "../../../db/schemas/personal-dedicated-upgrade-authorities";
import { providerAdmissions } from "../../../db/schemas/provider-admissions";
import { subscriptionAllowancePeriods } from "../../../db/schemas/subscription-allowance-periods";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

const TEST_TIMEOUT = 300_000;
const OWNER_ID = "10000000-0000-4000-8000-000000000042";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let ProvisioningJobService: typeof import("@elizaos/cloud-shared/node").ProvisioningJobService;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ ProvisioningJobService } = await import("@elizaos/cloud-shared/node"));
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
    personalDedicatedUpgradeAuthorities,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  // The reversal-hold and fallback migrations are replayed to prove they are idempotent.
  for (const name of [
    "0189_agent_sandbox_lifecycle_revision_scope.sql",
    "0479_organization_payment_reversal_holds.sql",
    "0479_organization_payment_reversal_holds.sql",
    "0480_personal_dedicated_fallbacks.sql",
    "0480_personal_dedicated_fallbacks.sql",
    "0490_personal_dedicated_fallback_entitlement.sql",
    "0490_personal_dedicated_fallback_entitlement.sql",
    "0494_payment_reversal_shortfall_holds.sql",
    "0494_payment_reversal_shortfall_holds.sql",
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

    const shared = async () => {
      const route = await fallback.resolvePersonalDedicatedRoute(input);
      if (route.route !== "shared_fallback") throw new Error(`Expected Shared, got ${route.route}`);
      return route.delivery;
    };
    const first = await shared();
    const replay = await shared();
    expect(first.accountState).toEqual({
      access: "shared_fallback",
      state: "shared_active",
      reason: "billing_suspended",
      dedicatedMemory: "unavailable",
      generation: 1,
      dedicatedRetainedUntil: null,
      recoveryAction: { kind: "add_credits", path: "/cloud/billing" },
    });
    // The journal is a new scoped room, never the canonical conversation.
    expect(first.journalRoomId).toStartWith("fallback:");
    expect(first.journalRoomId).not.toBe(sourceAgentId);
    expect(replay.journalRoomId).toBe(first.journalRoomId);
    const concurrent = await Promise.all([shared(), shared()]);
    expect(concurrent.map((entry) => entry.journalRoomId)).toEqual([
      first.journalRoomId,
      first.journalRoomId,
    ]);
    // The runtime was already stopped by billing: no second stop is admitted.
    expect(first.fallback.suspend_job_id).toBeNull();

    // Funding returning restores Dedicated authority (automatic resume owns
    // the restart); the interval is reconciled before routing returns.
    await dbWrite
      .update(organizations)
      .set({ credit_balance: FUNDED })
      .where(eq(organizations.id, suspended.orgId));
    const recovering = await fallback.resolvePersonalDedicatedRoute(input);
    if (recovering.route !== "dedicated" || !recovering.reconcile) {
      throw new Error("Expected Dedicated routing with an interval to reconcile");
    }
    expect(recovering.reconcile).toMatchObject({ state: "recovery_pending", generation: 1 });
    const recovered = await fallback.completePersonalFallbackRecovery({
      fallback: recovering.reconcile,
      receipt: { sourceMessageCount: 0, inserted: 0 },
    });
    expect(recovered).toMatchObject({ state: "recovered", generation: 1 });
    // A stale retry of the same commit is fenced by the interval revision.
    await expect(
      fallback.completePersonalFallbackRecovery({
        fallback: recovering.reconcile,
        receipt: { sourceMessageCount: 0, inserted: 0 },
      }),
    ).rejects.toMatchObject({ code: "PERSONAL_DEDICATED_FALLBACK_CONFLICT" });
    expect(await fallback.resolvePersonalDedicatedRoute(input)).toEqual({
      route: "dedicated",
      reconcile: null,
    });

    // A later withdrawal opens a new generation and journal; the recovered
    // interval is never reopened.
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "0.000000" })
      .where(eq(organizations.id, suspended.orgId));
    const second = await shared();
    expect(second.accountState.generation).toBe(2);
    expect(second.journalRoomId).not.toBe(first.journalRoomId);

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

interface PlanAccount {
  orgId: string;
  userId: string;
  agentId: string;
  sourceAgentId: string;
  subscriptionId: string;
}

/**
 * Publishes one committed entitlement projection revision and the exact
 * subscription lifecycle revision it was derived from, as the subscription
 * finalizers do inside one organization-locked transaction.
 */
async function publishPlan(
  account: PlanAccount,
  projectionRevision: number,
  plan: {
    status: "active" | "grace" | "past_due" | "unpaid" | "canceled" | "incomplete_expired";
    effectiveUntil?: Date | null;
  },
) {
  const free = plan.status === "canceled" || plan.status === "incomplete_expired";
  const effectiveUntil =
    plan.effectiveUntil === undefined
      ? new Date(Date.now() + 20 * 86_400_000)
      : plan.effectiveUntil;
  const subscriptionRevision = projectionRevision + 1;
  await dbWrite.execute(sql`
    INSERT INTO billing_subscription_revisions (id, organization_id, subscription_id, revision, status, plan_key)
    VALUES (${crypto.randomUUID()}, ${account.orgId}, ${account.subscriptionId}, ${subscriptionRevision}, ${plan.status}, 'plus_monthly')`);
  await dbWrite.execute(
    sql`DELETE FROM organization_entitlements WHERE organization_id = ${account.orgId}`,
  );
  await dbWrite.execute(sql`
    INSERT INTO organization_entitlements (
      id, organization_id, billing_scope_id, plan_key, state, entitlement_effective,
      effective_until, projection_revision, source_subscription_id, source_subscription_revision)
    VALUES (
      ${crypto.randomUUID()}, ${account.orgId}, NULL, ${free ? "free" : "plus_monthly"},
      ${free ? "free" : plan.status},
      ${free || plan.status === "active" || plan.status === "grace"},
      ${free ? null : effectiveUntil}, ${projectionRevision}, ${account.subscriptionId},
      ${subscriptionRevision})`);
}

/** A funded Plus account whose running personal Dedicated agent completed cutover. */
async function seedPlanAccount(): Promise<PlanAccount> {
  const [organization] = await dbWrite
    .insert(organizations)
    // Purchased credits are present throughout: they never override plan policy.
    .values({ name: "Plan Org", slug: unique("plan-org"), credit_balance: FUNDED })
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
      agent_name: unique("plan-agent"),
      status: "running",
      billing_status: "active",
      execution_tier: "dedicated-always",
    })
    .returning();
  const sourceAgentId = `personal:${crypto.randomUUID()}`;
  await dbWrite.insert(personalDedicatedUpgradeAuthorities).values({
    organization_id: organization.id,
    user_id: user.id,
    source_agent_id: sourceAgentId,
    dedicated_agent_id: agent.id,
    cutover_token: unique("cutover"),
    shared_message_count: 3,
    shared_scheduled_task_count: 0,
    shared_todo_count: 0,
    shared_todo_mutation_count: 0,
    shared_todo_digest: "a".repeat(64),
    cutover_activated_at: new Date(Date.now() - 86_400_000),
  });
  const account = {
    orgId: organization.id,
    userId: user.id,
    agentId: agent.id,
    sourceAgentId,
    subscriptionId: crypto.randomUUID(),
  };
  await publishPlan(account, 0, { status: "active" });
  return account;
}

async function agentRow(agentId: string) {
  const [row] = await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, agentId));
  if (!row) throw new Error(`Agent ${agentId} is missing`);
  return row;
}

async function lifecycleJobs(agentId: string) {
  return dbWrite.select().from(jobs).where(eq(jobs.agent_id, agentId));
}

async function fallbackRows(account: PlanAccount) {
  return dbWrite
    .select()
    .from(personalDedicatedFallbacks)
    .where(eq(personalDedicatedFallbacks.source_agent_id, account.sourceAgentId));
}

test(
  "only confirmed paid-plan lapses withdraw Dedicated; allowance, grace and webhook lag keep it",
  async () => {
    const { classifyDedicatedPlanEntitlement } = await import("../personal-dedicated-fallback");
    const now = new Date("2026-09-27T00:00:00.000Z");
    const base = {
      plan_key: "plus_monthly",
      entitlement_effective: true,
      effective_until: new Date("2026-10-10T00:00:00.000Z"),
      projection_revision: 7,
      source_subscription_id: crypto.randomUUID(),
      source_status: "active" as const,
    };
    // Active plan (allowance may be spent; that is usage, not entitlement).
    expect(classifyDedicatedPlanEntitlement({ ...base, state: "active" }, now)).toEqual({
      kind: "entitled",
      revision: 7,
    });
    // Dunning grace keeps access until its confirmed end.
    expect(
      classifyDedicatedPlanEntitlement({ ...base, state: "grace", source_status: "grace" }, now),
    ).toEqual({ kind: "entitled", revision: 7 });
    // A passed deadline without a confirmed lifecycle event is webhook lag.
    expect(
      classifyDedicatedPlanEntitlement(
        { ...base, state: "active", effective_until: new Date("2026-09-01T00:00:00.000Z") },
        now,
      ),
    ).toEqual({ kind: "unconfirmed", revision: 7 });
    for (const state of ["past_due", "unpaid"] as const) {
      expect(
        classifyDedicatedPlanEntitlement(
          { ...base, state, entitlement_effective: false, source_status: state },
          now,
        ),
      ).toEqual({ kind: "withdrawn", revision: 7, reason: "subscription_payment_failed" });
    }
    // Canceled (including at period end, once confirmed) projects to Free.
    const ended = {
      ...base,
      plan_key: "free",
      state: "free" as const,
      effective_until: null,
    };
    expect(classifyDedicatedPlanEntitlement({ ...ended, source_status: "canceled" }, now)).toEqual({
      kind: "withdrawn",
      revision: 7,
      reason: "subscription_ended",
    });
    // A checkout that never paid never granted a plan to lapse.
    expect(
      classifyDedicatedPlanEntitlement({ ...ended, source_status: "incomplete_expired" }, now),
    ).toEqual({ kind: "not_plan_governed" });
    expect(classifyDedicatedPlanEntitlement(undefined, now)).toEqual({
      kind: "not_plan_governed",
    });
    expect(
      classifyDedicatedPlanEntitlement(
        { ...base, state: "active", source_subscription_id: null },
        now,
      ),
    ).toEqual({ kind: "not_plan_governed" });
  },
  TEST_TIMEOUT,
);

test(
  "a lapsed paid plan sleeps the same Dedicated agent, opens a scoped journal and payment restores it",
  async () => {
    const fallback = await import("../personal-dedicated-fallback");
    const account = await seedPlanAccount();
    const input = {
      organizationId: account.orgId,
      userId: account.userId,
      sourceAgentId: account.sourceAgentId,
    };
    const route = async () =>
      fallback.resolvePersonalDedicatedRoute({
        ...input,
        dedicated: await agentRow(account.agentId),
      });

    // Entitled: Dedicated owns routing and nothing is recorded.
    expect(await route()).toEqual({ route: "dedicated", reconcile: null });
    expect(await fallbackRows(account)).toHaveLength(0);

    // Payment fails past grace. Concurrent webhook-driven reconciles and
    // connector turns converge on one interval and one preserving stop.
    await publishPlan(account, 1, { status: "past_due" });
    const [first, second, third] = await Promise.all([route(), route(), route()]);
    for (const outcome of [first, second, third]) {
      if (outcome.route !== "shared_fallback") throw new Error(`Expected Shared: ${outcome.route}`);
    }
    if (first.route !== "shared_fallback" || second.route !== "shared_fallback") return;
    expect(second.delivery.journalRoomId).toBe(first.delivery.journalRoomId);
    expect(first.delivery.journalRoomId).toStartWith("fallback:");
    expect(first.delivery.journalRoomId).not.toBe(account.sourceAgentId);
    expect(first.delivery.accountState).toMatchObject({
      access: "shared_fallback",
      state: "shared_active",
      reason: "subscription_payment_failed",
      dedicatedMemory: "unavailable",
      generation: 1,
      recoveryAction: { kind: "restore_subscription", path: "/cloud/billing" },
    });
    const retainedUntil = Date.parse(first.delivery.accountState.dedicatedRetainedUntil ?? "");
    expect(retainedUntil).toBeGreaterThan(
      Date.now() + (fallback.PERSONAL_DEDICATED_FALLBACK_RETENTION_DAYS - 1) * 86_400_000,
    );
    const [withdrawn] = await fallbackRows(account);
    expect(withdrawn).toMatchObject({
      state: "shared_active",
      reason: "subscription_payment_failed",
      entitlement_revision: 1,
      dedicated_agent_id: account.agentId,
    });
    const stops = (await lifecycleJobs(account.agentId)).filter(
      (job) => job.type === "agent_suspend",
    );
    expect(stops).toHaveLength(1);
    expect(stops[0].id).toBe(withdrawn.suspend_job_id);
    const [stopIntent] = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.job_id, stops[0].id));
    expect(stopIntent).toMatchObject({ authorization: "user_request", status: "pending" });
    // Preserved, never deleted.
    expect((await lifecycleJobs(account.agentId)).some((job) => job.type === "agent_delete")).toBe(
      false,
    );

    // The stop settles: the runtime is stopped with the same identity.
    await dbWrite
      .update(jobs)
      .set({ status: "completed", completed_at: new Date() })
      .where(eq(jobs.id, stops[0].id));
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "stopped" })
      .where(eq(agentSandboxes.id, account.agentId));
    // Credits alone cannot restart a plan-withdrawn runtime, even through a
    // provider-confirmed billing stop the automatic resume would otherwise use.
    await dbWrite.insert(agentComputeStopIntents).values({
      organization_id: account.orgId,
      agent_id: account.agentId,
      lifecycle_revision: 5_000,
      authorization: "billing_request",
      status: "provider_confirmed",
      provider_confirmed_at: new Date(),
    });
    await reconcileAll();
    expect(await resumeJobs(account.agentId)).toHaveLength(0);
    expect((await route()).route).toBe("shared_fallback");

    // A stale, reordered projection cannot move the interval backwards.
    await publishPlan(account, 0, { status: "active" });
    expect((await route()).route).toBe("shared_fallback");
    expect((await fallbackRows(account))[0]).toMatchObject({ state: "shared_active" });

    // Payment is restored: the same agent id is resumed exactly once while
    // Shared keeps the scoped journal until Dedicated is running again.
    await publishPlan(account, 2, { status: "active" });
    const [recoveringA, recoveringB] = await Promise.all([route(), route()]);
    for (const outcome of [recoveringA, recoveringB]) {
      if (outcome.route !== "shared_fallback") throw new Error("Expected recovering Shared");
      expect(outcome.delivery.accountState.state).toBe("recovery_pending");
      expect(outcome.delivery.journalRoomId).toBe(first.delivery.journalRoomId);
    }
    expect(await route()).toMatchObject({ route: "shared_fallback" });
    const resumes = await resumeJobs(account.agentId);
    expect(resumes).toHaveLength(1);
    expect(resumes[0].data).toMatchObject({ agentId: account.agentId });
    const [recovering] = await fallbackRows(account);
    expect(recovering).toMatchObject({
      state: "recovery_pending",
      recovery_entitlement_revision: 2,
      resume_job_id: resumes[0].id,
    });

    // Dedicated is healthy again: routing returns only after the complete
    // interval is reconciled with a receipt under a fresh entitlement read.
    await dbWrite
      .update(jobs)
      .set({ status: "completed", completed_at: new Date() })
      .where(eq(jobs.id, resumes[0].id));
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "running" })
      .where(eq(agentSandboxes.id, account.agentId));
    const cutback = await route();
    if (cutback.route !== "dedicated" || !cutback.reconcile) {
      throw new Error("Expected a Dedicated cutback with an interval to reconcile");
    }
    expect(cutback.reconcile.dedicated_agent_id).toBe(account.agentId);
    const sealScope = {
      ...input,
      dedicatedAgentId: account.agentId,
      fallback: {
        id: cutback.reconcile.id,
        generation: cutback.reconcile.generation,
        revision: cutback.reconcile.revision,
        roomId: cutback.reconcile.journal_room_id,
      },
    };
    expect(await fallback.resolvePersonalFallbackCutoverRecovery(sealScope)).toBe("pending");
    expect(
      await fallback.resolvePersonalFallbackCutoverRecovery({
        ...sealScope,
        userId: crypto.randomUUID(),
      }),
    ).toBe("conflict");
    expect(
      await fallback.resolvePersonalFallbackCutoverRecovery({
        ...sealScope,
        fallback: { ...sealScope.fallback, roomId: "fallback:other" },
      }),
    ).toBe("conflict");
    const recovered = await fallback.completePersonalFallbackRecovery({
      fallback: cutback.reconcile,
      receipt: { sourceMessageCount: 4, inserted: 4 },
    });
    expect(await fallback.resolvePersonalFallbackCutoverRecovery(sealScope)).toBe("committed");
    expect(recovered).toMatchObject({
      state: "recovered",
      reconciled_message_count: 4,
      reconciled_inserted_count: 4,
    });
    expect(await route()).toEqual({ route: "dedicated", reconcile: null });
    expect((await agentRow(account.agentId)).id).toBe(account.agentId);

    // The plan ends later (cancel at period end, confirmed): a new generation
    // and journal, never the recovered interval.
    await publishPlan(account, 3, { status: "canceled" });
    const ended = await route();
    if (ended.route !== "shared_fallback") throw new Error("Expected Shared after plan end");
    expect(ended.delivery.accountState).toMatchObject({
      reason: "subscription_ended",
      generation: 2,
    });
    expect(ended.delivery.journalRoomId).not.toBe(first.delivery.journalRoomId);

    // Entitlement restored then lost again before the final route commit:
    // the commit is refused and the interval stays unrecovered.
    await dbWrite
      .update(jobs)
      .set({ status: "completed", completed_at: new Date() })
      .where(eq(jobs.agent_id, account.agentId));
    await publishPlan(account, 4, { status: "active" });
    const restoring = await route();
    expect(restoring.route).toBe("dedicated");
    if (restoring.route !== "dedicated" || !restoring.reconcile) return;
    await publishPlan(account, 5, { status: "unpaid" });
    await expect(
      fallback.completePersonalFallbackRecovery({
        fallback: restoring.reconcile,
        receipt: { sourceMessageCount: 0, inserted: 0 },
      }),
    ).rejects.toMatchObject({ code: "PERSONAL_DEDICATED_FALLBACK_CONFLICT" });
    expect((await route()).route).toBe("shared_fallback");
    expect(
      await fallback.resolvePersonalFallbackCutoverRecovery({
        ...input,
        dedicatedAgentId: account.agentId,
        fallback: {
          id: restoring.reconcile.id,
          generation: restoring.reconcile.generation,
          revision: restoring.reconcile.revision,
          roomId: restoring.reconcile.journal_room_id,
        },
      }),
    ).toBe("released");
    const rows = await fallbackRows(account);
    expect(rows.filter((row) => row.state !== "recovered")).toHaveLength(1);
  },
  TEST_TIMEOUT,
);

test(
  "the provisioning reconciler withdraws and restores plan entitlement without a connector turn",
  async () => {
    const fallback = await import("../personal-dedicated-fallback");
    const lapsed = await seedPlanAccount();
    const entitled = await seedPlanAccount();
    const lagging = await seedPlanAccount();
    await publishPlan(lapsed, 1, { status: "unpaid" });
    // Webhook lag: the period passed without a confirmed renewal or cancellation.
    await publishPlan(lagging, 1, {
      status: "active",
      effectiveUntil: new Date(Date.now() - 1_000),
    });

    const reconcilePages = async () => {
      let cursor: string | undefined;
      let failures = 0;
      for (;;) {
        const page = await service.reconcilePersonalDedicatedEntitlements({
          limit: 2,
          afterAuthorityId: cursor,
        });
        failures += page.failures.length;
        if (!page.nextCursor) return failures;
        cursor = page.nextCursor;
      }
    };
    expect(await reconcilePages()).toBe(0);
    expect(await reconcilePages()).toBe(0);

    const [lapsedRow] = await fallbackRows(lapsed);
    expect(lapsedRow).toMatchObject({
      state: "shared_active",
      reason: "subscription_payment_failed",
    });
    const lapsedStops = (await lifecycleJobs(lapsed.agentId)).filter(
      (job) => job.type === "agent_suspend",
    );
    expect(lapsedStops).toHaveLength(1);
    for (const account of [entitled, lagging]) {
      expect(await fallbackRows(account)).toHaveLength(0);
      expect(await lifecycleJobs(account.agentId)).toHaveLength(0);
    }

    // Payment restored: the reconciler admits the same agent's resume once
    // its stop settled; the final route commit waits for a connector turn.
    await dbWrite
      .update(jobs)
      .set({ status: "completed", completed_at: new Date() })
      .where(eq(jobs.id, lapsedStops[0].id));
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "stopped" })
      .where(eq(agentSandboxes.id, lapsed.agentId));
    await publishPlan(lapsed, 2, { status: "active" });
    expect(await reconcilePages()).toBe(0);
    expect(await reconcilePages()).toBe(0);
    expect(await resumeJobs(lapsed.agentId)).toHaveLength(1);
    expect((await fallbackRows(lapsed))[0]).toMatchObject({ state: "recovery_pending" });
    expect(fallback.PERSONAL_DEDICATED_FALLBACK_RETENTION_DAYS).toBeGreaterThan(0);
  },
  TEST_TIMEOUT,
);

/** Records which conversation-coordinator rooms a reconcile read, serving one fixed journal. */
function journalNamespace(history: Array<Record<string, unknown>>) {
  const rooms: string[] = [];
  return {
    rooms,
    namespace: {
      getByName(name: string) {
        rooms.push(name);
        return { fetch: async () => Response.json({ history }) };
      },
    },
  };
}

async function withRecoveryLinkSigning<T>(run: () => Promise<T>): Promise<T> {
  const { exportPKCS8, exportSPKI, generateKeyPair } = await import("jose");
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const saved = {
    JWT_SIGNING_PRIVATE_KEY: process.env.JWT_SIGNING_PRIVATE_KEY,
    JWT_SIGNING_PUBLIC_KEY: process.env.JWT_SIGNING_PUBLIC_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  process.env.JWT_SIGNING_PRIVATE_KEY = Buffer.from(await exportPKCS8(privateKey)).toString(
    "base64",
  );
  process.env.JWT_SIGNING_PUBLIC_KEY = Buffer.from(await exportSPKI(publicKey)).toString("base64");
  process.env.NEXT_PUBLIC_APP_URL = "https://cloud.example.test";
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test(
  "direct chat, groups and the shared gateway follow the entitlement route; recovery hands back the same Dedicated id",
  async () => {
    await withRecoveryLinkSigning(async () => {
      const direct = await import("../personal-direct-chat-route");
      const fallback = await import("../personal-dedicated-fallback");
      const links = await import("../personal-fallback-recovery-link");
      const { parsePersonalSharedFallbackAccountState } = await import(
        "../shared-runtime/personal-fallback-account-state"
      );
      const account = await seedPlanAccount();
      const agent = {
        id: account.sourceAgentId,
        organization_id: account.orgId,
        user_id: account.userId,
      };
      const idle = journalNamespace([]);
      const surface = (conversationId: string) =>
        direct.resolveSharedSurfaceTarget({
          agent,
          personal: true,
          conversationId,
          namespace: idle.namespace,
        });
      const traffic = () =>
        fallback.resolvePersonalDedicatedTrafficAccess({
          dedicatedAgentId: account.agentId,
          organizationId: account.orgId,
        });

      // Entitled: the identity hands out the Dedicated id and every Shared
      // chat surface refuses with it; group and gateway traffic reach it.
      const entitled = await direct.resolvePersonalDirectChatRoute({
        organizationId: account.orgId,
        userId: account.userId,
        sourceAgentId: account.sourceAgentId,
      });
      expect(entitled.route === "dedicated" && entitled.dedicated.id).toBe(account.agentId);
      expect(await surface(account.sourceAgentId)).toEqual({
        ok: false,
        refusal: direct.personalDedicatedOwnsConversation(account.agentId),
      });
      expect(await traffic()).toEqual({ access: "dedicated" });
      // Organization Shared agents and non-agent ids are untouched.
      expect(
        await direct.resolveSharedSurfaceTarget({
          agent,
          personal: false,
          conversationId: "room-1",
          namespace: idle.namespace,
        }),
      ).toEqual({ ok: true, roomId: "room-1" });
      expect(
        await fallback.resolvePersonalDedicatedTrafficAccess({
          dedicatedAgentId: "not-a-uuid",
          organizationId: account.orgId,
        }),
      ).toEqual({ access: "dedicated" });

      // The plan lapses: the canonical conversation is served from the scoped
      // journal with the account-state provider and a signed pay action.
      await publishPlan(account, 1, { status: "past_due" });
      const lapsed = await surface(account.sourceAgentId);
      if (!lapsed.ok || !lapsed.accountState) throw new Error("Expected the Shared fallback");
      expect(lapsed.roomId).toStartWith("fallback:");
      expect(lapsed.roomId).not.toBe(account.sourceAgentId);
      // ES256 signatures are randomized; every other field is stable.
      const byJournalId = await surface(lapsed.roomId);
      expect(byJournalId.ok && byJournalId.roomId).toBe(lapsed.roomId);
      expect(byJournalId.ok && byJournalId.accountState?.generation).toBe(
        lapsed.accountState.generation,
      );
      expect(await surface("another-room")).toMatchObject({
        ok: false,
        refusal: { status: 404, code: "conversation_not_found" },
      });
      const state = lapsed.accountState;
      expect(state).toMatchObject({
        access: "shared_fallback",
        reason: "subscription_payment_failed",
        dedicatedMemory: "unavailable",
        recoveryAction: { kind: "restore_subscription", path: "/cloud/billing" },
      });
      // The Durable Object boundary admits exactly this shape, link included.
      expect(parsePersonalSharedFallbackAccountState(state)).toEqual(state);
      expect(
        parsePersonalSharedFallbackAccountState({
          ...state,
          recoveryAction: {
            ...state.recoveryAction,
            link: { ...state.recoveryAction.link, url: "https://evil.test/pay?card=4242" },
          },
        }),
      ).toBeNull();

      // The link is signed, expiring, and resolves to billing with the
      // organization context only.
      const link = state.recoveryAction.link;
      if (!link) throw new Error("Expected a signed recovery link");
      expect(link.url).toStartWith("https://cloud.example.test/api/v1/eliza/personal/recovery/");
      expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
      const token = link.url.slice(link.url.lastIndexOf("/") + 1);
      const resolved = await links.resolvePersonalFallbackRecoveryLink(token, {
        appUrl: "https://cloud.example.test",
      });
      const billing = new URL(resolved.billingUrl);
      expect(billing.origin + billing.pathname).toBe("https://cloud.example.test/cloud/billing");
      expect(Object.fromEntries(billing.searchParams)).toEqual({
        organizationId: account.orgId,
        action: "restore_subscription",
      });
      expect(resolved.claims).toMatchObject({
        organizationId: account.orgId,
        userId: account.userId,
        generation: 1,
      });
      const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
      await expect(links.resolvePersonalFallbackRecoveryLink(tampered)).rejects.toMatchObject({
        code: "PERSONAL_FALLBACK_RECOVERY_LINK_INVALID",
      });
      await expect(
        links.resolvePersonalFallbackRecoveryLink(token, {
          now: new Date(Date.parse(link.expiresAt) + 60_000),
        }),
      ).rejects.toMatchObject({ code: "PERSONAL_FALLBACK_RECOVERY_LINK_EXPIRED" });

      // Group and shared-gateway traffic has no fallback of its own: it is
      // refused with the typed state and never reaches Dedicated memory.
      expect(await traffic()).toMatchObject({
        access: "withdrawn",
        status: 409,
        code: "personal_dedicated_access_withdrawn",
        retryable: false,
      });

      // Payment returns. While the same runtime restarts Shared keeps the
      // journal; once it is running, the interval is reconciled into it.
      const [stop] = (await lifecycleJobs(account.agentId)).filter(
        (job) => job.type === "agent_suspend",
      );
      await dbWrite
        .update(jobs)
        .set({ status: "completed", completed_at: new Date() })
        .where(eq(jobs.id, stop.id));
      await dbWrite
        .update(agentSandboxes)
        .set({ status: "stopped" })
        .where(eq(agentSandboxes.id, account.agentId));
      await publishPlan(account, 2, { status: "active" });
      const restarting = await surface(account.sourceAgentId);
      expect(restarting.ok && restarting.accountState?.state).toBe("recovery_pending");
      expect(await traffic()).toMatchObject({ access: "withdrawn" });
      const [resume] = await resumeJobs(account.agentId);
      await dbWrite
        .update(jobs)
        .set({ status: "completed", completed_at: new Date() })
        .where(eq(jobs.id, resume.id));
      await dbWrite
        .update(agentSandboxes)
        .set({ status: "running" })
        .where(eq(agentSandboxes.id, account.agentId));

      // A gateway or cached Dedicated client can arrive before the owner
      // reopens direct chat. Running compute alone must not admit that turn
      // while the fallback journal still awaits its canonical import.
      expect(await traffic()).toMatchObject({
        access: "withdrawn",
        status: 503,
        code: "dedicated_reconciling",
        retryable: true,
      });
      expect((await fallbackRows(account))[0]?.state).toBe("recovery_pending");

      // Without the conversation coordinator the handback waits.
      expect(
        await direct.resolvePersonalDirectChatRoute({
          organizationId: account.orgId,
          userId: account.userId,
          sourceAgentId: account.sourceAgentId,
        }),
      ).toMatchObject({ route: "refused", status: 503, code: "dedicated_reconciling" });

      const journal = journalNamespace([
        { id: "turn-user-1", role: "user", content: "Hi", createdAt: 1 },
        { id: "turn-assistant-1", role: "assistant", content: "Hello", createdAt: 2 },
      ]);
      const imported = spyOn(
        ElizaSandboxService.prototype,
        "importCanonicalConversation",
      ).mockResolvedValue({ complete: true, sourceMessageCount: 2, inserted: 2, skipped: 0 });
      try {
        const handback = await direct.resolvePersonalDirectChatRoute({
          organizationId: account.orgId,
          userId: account.userId,
          sourceAgentId: account.sourceAgentId,
          namespace: journal.namespace,
        });
        expect(handback.route === "dedicated" && handback.dedicated.id).toBe(account.agentId);
        // Only the scoped journal was read, and it moved into the same agent.
        expect(new Set(journal.rooms)).toEqual(
          new Set([`${account.sourceAgentId}:${lapsed.roomId}`]),
        );
        expect(imported).toHaveBeenCalledTimes(1);
        expect(imported.mock.calls[0]?.slice(0, 3)).toEqual([
          account.agentId,
          account.orgId,
          account.sourceAgentId,
        ]);
      } finally {
        imported.mockRestore();
      }
      expect((await fallbackRows(account))[0]).toMatchObject({
        state: "recovered",
        dedicated_agent_id: account.agentId,
        reconciled_message_count: 2,
      });
      expect(await traffic()).toEqual({ access: "dedicated" });
      expect(await surface(account.sourceAgentId)).toEqual({
        ok: false,
        refusal: direct.personalDedicatedOwnsConversation(account.agentId),
      });
      // The verified link of a recovered interval still only opens billing.
      await expect(links.resolvePersonalFallbackRecoveryLink(token)).resolves.toBeDefined();
    });
  },
  TEST_TIMEOUT,
);
