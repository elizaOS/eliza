/** Drives real ElizaSandboxService provisioning over PGlite: durable cleanup fences, lifecycle rows and the retained backup chain are real. Provider effects, runtime bootstrap and the restore HTTP push are controlled fixtures; this is not physical Docker evidence. */

import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("provision-recovery.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { AGENT_PRICING } from "@elizaos/cloud-sdk/browser-contracts";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
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
import { personalDedicatedAdoptionSelections } from "../../../db/schemas/personal-dedicated-adoption-selections";
import { personalDedicatedUpgradeAuthorities } from "../../../db/schemas/personal-dedicated-upgrade-authorities";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import { SandboxBackup } from "../eliza-sandbox/backup/service";
import type { SandboxHandle, SandboxProvider } from "../sandbox-provider-types";

const TEST_TIMEOUT = 300_000;
const NODE_ID = "recovery-node";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function applyLifecycleRevisionMigration(): Promise<void> {
  const migration = await readFile(
    join(import.meta.dir, "../../../db/migrations/0189_agent_sandbox_lifecycle_revision_scope.sql"),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
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
    personalDedicatedUpgradeAuthorities,
    personalDedicatedAdoptionSelections,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  await applyLifecycleRevisionMigration();
  for (const [name, table] of [
    ["docker_nodes", dockerNodes],
    ["containers", containers],
    ["agent_compute_funding", agentComputeFunding],
    // Read-only joins of the organization billing snapshot.
    ["billing_subscriptions", billingSubscriptions],
    ["organization_subscription_authorities", organizationSubscriptionAuthorities],
    ["organization_entitlements", organizationEntitlements],
    ["credit_transactions", creditTransactions],
    ["org_rate_limit_overrides", orgRateLimitOverrides],
    ["organization_config", organizationConfig],
    ["org_storage_quota", orgStorageQuota],
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

interface Fixture {
  orgId: string;
  userId: string;
  agentId: string;
  containerName: string;
}

async function seedAgent(): Promise<Fixture> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: unique("org"), credit_balance: "5.000000" })
    .returning();
  // Legacy (non-subscription) account authority for the policy snapshot.
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
      status: "pending",
      execution_tier: "dedicated-always",
      database_status: "ready",
      database_uri: process.env.DATABASE_URL,
      environment_vars: { ELIZA_API_TOKEN: "test-agent-token" },
    })
    .returning();
  return {
    orgId: organization.id,
    userId: user.id,
    agentId: agent.id,
    containerName: `agent-${agent.id}`,
  };
}

async function seedNode(): Promise<void> {
  await dbWrite.execute(sql`DELETE FROM docker_nodes WHERE node_id = ${NODE_ID}`);
  await dbWrite.insert(dockerNodes).values({
    id: crypto.randomUUID(),
    node_id: NODE_ID,
    hostname: "127.0.0.1",
    ssh_port: 22,
    ssh_user: "root",
    capacity: 8,
    enabled: true,
    placement_state: "open",
    status: "healthy",
    allocated_count: 0,
    metadata: {},
  });
}

async function allocation(): Promise<number> {
  const [node] = await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.node_id, NODE_ID));
  return node.allocated_count;
}

async function readAgent(agentId: string) {
  const [row] = await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, agentId));
  return row;
}

interface ProviderLog {
  creates: number;
  exactStops: Array<{
    nodeId: string;
    containerName: string;
    replacementAttemptId: string | null | undefined;
    containerId: string | null | undefined;
  }>;
  nameStops: string[];
  lastHandle?: SandboxHandle;
}

/**
 * A Docker-shaped provider that runs the real durable intent/created fence
 * callbacks. Name-based teardown is forbidden: the reusable container name may
 * already belong to a healthy successor generation.
 */
function dockerProvider(fixture: Fixture, log: ProviderLog): SandboxProvider {
  return {
    async create(config) {
      log.creates++;
      const attemptId = crypto.randomUUID();
      const containerId = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
      const base = {
        provider: "docker" as const,
        nodeId: NODE_ID,
        hostname: "127.0.0.1",
        containerName: fixture.containerName,
        bridgePort: 20_000 + log.creates,
        webUiPort: 30_000 + log.creates,
        agentId: fixture.agentId,
        volumePath: `/data/${fixture.agentId}`,
        dockerImage: "ghcr.io/elizaos/agent:test",
        imageDigest: null,
        replacementAttemptId: attemptId,
        allocationCounted: true,
      };
      const handle = (containerIdValue?: string): SandboxHandle => ({
        sandboxId: fixture.containerName,
        bridgeUrl: "http://127.0.0.1:1",
        healthUrl: "http://127.0.0.1:1/health",
        metadata: containerIdValue ? { ...base, containerId: containerIdValue } : base,
      });
      await config.onReplacementCreateIntent?.(handle());
      await config.onReplacementCreated?.(handle(containerId));
      log.lastHandle = handle(containerId);
      return log.lastHandle;
    },
    async checkHealth() {
      return true;
    },
    async stopForDeletion() {
      throw new Error("unexpected deletion");
    },
    async stopForReplacement(sandboxId) {
      log.nameStops.push(sandboxId);
      throw new Error("Name-based Docker teardown can resolve a same-name successor");
    },
    async stopOnSpecificNodeForReplacement(nodeId, containerName, _vpnNodeId, identity) {
      log.exactStops.push({
        nodeId,
        containerName,
        replacementAttemptId: identity?.replacementAttemptId,
        containerId: identity?.containerId,
      });
    },
  };
}

function ensureRuntimeStub() {
  return spyOn(
    ElizaSandboxService.prototype as unknown as {
      ensureRuntimeAgentStarted: () => Promise<null>;
    },
    "ensureRuntimeAgentStarted",
  ).mockResolvedValue(null);
}

async function seedBackup(agentId: string, workspaceMarker: string): Promise<string> {
  const state = { memories: [], config: {}, workspaceFiles: { "marker.txt": workspaceMarker } };
  const [backup] = await dbWrite
    .insert(agentSandboxBackups)
    .values({
      sandbox_record_id: agentId,
      snapshot_type: "pre-shutdown",
      state_data: state,
      state_data_storage: "inline",
      size_bytes: Buffer.byteLength(JSON.stringify(state)),
      backup_kind: "full",
    })
    .returning();
  return backup.id;
}

async function backupIds(agentId: string): Promise<string[]> {
  const rows = await dbWrite
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.sandbox_record_id, agentId));
  return rows.map((row) => row.id).sort();
}

beforeEach(async () => {
  await seedNode();
});

test(
  "failed post-adoption provision retires the exact Docker candidate, never the reusable name",
  async () => {
    const fixture = await seedAgent();
    const backupId = await seedBackup(fixture.agentId, "exact-cleanup");
    const log: ProviderLog = { creates: 0, exactStops: [], nameStops: [] };
    const service = new ElizaSandboxService(dockerProvider(fixture, log));
    const ensure = ensureRuntimeStub();
    const push = spyOn(SandboxBackup.prototype, "pushState").mockRejectedValue(
      new Error("State restore failed: HTTP 503 upstream unavailable"),
    );
    try {
      const result = await service.provision(fixture.agentId, fixture.orgId);
      expect(result.success).toBe(false);
      expect(log.creates).toBe(1);
      expect(log.nameStops).toEqual([]);
      const handle = log.lastHandle;
      if (!handle || !handle.metadata || typeof handle.metadata !== "object")
        throw new Error("Missing created handle");
      const meta = handle.metadata as { replacementAttemptId: string; containerId: string };
      expect(log.exactStops).toEqual([
        {
          nodeId: NODE_ID,
          containerName: fixture.containerName,
          replacementAttemptId: meta.replacementAttemptId,
          containerId: meta.containerId,
        },
      ]);
      const row = await readAgent(fixture.agentId);
      // The row was never routable and reports the failed recovery.
      expect(row.status).toBe("error");
      expect(row.error_message).toContain("HTTP 503");
      // A transient failure keeps its original cause so the job can retry.
      expect((result.failureCause as Error).message).toContain("HTTP 503");
      expect(row.replacement_cleanup_sandbox_id).toBeNull();
      expect(row.replacement_cleanup_container_id).toBeNull();
      // The adopted slot is released exactly once by the fenced retirement.
      expect(await allocation()).toBe(0);
      // A transient restore failure never prunes the retained chain.
      expect(await backupIds(fixture.agentId)).toEqual([backupId]);
    } finally {
      push.mockRestore();
      ensure.mockRestore();
    }
  },
  TEST_TIMEOUT,
);

test(
  "incomplete Docker cleanup identity fails closed instead of tearing down by name",
  async () => {
    const fixture = await seedAgent();
    await seedBackup(fixture.agentId, "identity-incomplete");
    const log: ProviderLog = { creates: 0, exactStops: [], nameStops: [] };
    const base = dockerProvider(fixture, log);
    const provider: SandboxProvider = {
      ...base,
      async create(config) {
        // A partial provider response that never produced Docker's immutable
        // container ID: only the create intent is durable.
        const created = await base.create({ ...config, onReplacementCreated: undefined });
        const { containerId: _dropped, ...partial } = created.metadata as Record<string, unknown>;
        return { ...created, metadata: partial };
      },
    };
    const service = new ElizaSandboxService(provider);
    const ensure = ensureRuntimeStub();
    const push = spyOn(SandboxBackup.prototype, "pushState").mockRejectedValue(
      new Error("State restore failed: HTTP 503 upstream unavailable"),
    );
    try {
      const result = await service.provision(fixture.agentId, fixture.orgId);
      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toContain("replacement cleanup remains pending");
      expect(log.nameStops).toEqual([]);
      expect(log.exactStops).toEqual([]);
    } finally {
      push.mockRestore();
      ensure.mockRestore();
    }
  },
  TEST_TIMEOUT,
);

test(
  "first creation without a backup commits readiness only after the restore tail",
  async () => {
    const fixture = await seedAgent();
    const log: ProviderLog = { creates: 0, exactStops: [], nameStops: [] };
    const service = new ElizaSandboxService(dockerProvider(fixture, log));
    const ensure = ensureRuntimeStub();
    const push = spyOn(SandboxBackup.prototype, "pushState");
    try {
      const result = await service.provision(fixture.agentId, fixture.orgId);
      expect(result.success).toBe(true);
      expect(push).not.toHaveBeenCalled();
      const row = await readAgent(fixture.agentId);
      expect(row.status).toBe("running");
      expect(row.sandbox_id).toBe(fixture.containerName);
      expect(log.exactStops).toEqual([]);
      expect(await allocation()).toBe(1);
    } finally {
      push.mockRestore();
      ensure.mockRestore();
    }
  },
  TEST_TIMEOUT,
);

test(
  "a delayed restore keeps the row non-routable and background readiness cannot publish it",
  async () => {
    const fixture = await seedAgent();
    await seedBackup(fixture.agentId, "delayed-restore");
    const log: ProviderLog = { creates: 0, exactStops: [], nameStops: [] };
    const service = new ElizaSandboxService(dockerProvider(fixture, log));
    const ensure = ensureRuntimeStub();
    let releaseRestore!: () => void;
    const restoreReleased = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreStarted!: () => void;
    const restoreEntered = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    const applied: unknown[] = [];
    const push = spyOn(SandboxBackup.prototype, "pushState").mockImplementation(
      async (_bridgeUrl, state) => {
        restoreStarted();
        await restoreReleased;
        applied.push(state);
      },
    );
    try {
      const provisioning = service.provision(fixture.agentId, fixture.orgId);
      await restoreEntered;
      const during = await readAgent(fixture.agentId);
      expect(during.status).toBe("provisioning");
      expect(during.sandbox_id).toBe(fixture.containerName);
      // The daemon stuck-provisioning reconciler sees a healthy container but
      // cannot prove the backup was applied, so it must not open readiness.
      expect(await service.reconcileStuckProvisioning(fixture.agentId, fixture.orgId)).toBe(
        "unresolved",
      );
      expect((await readAgent(fixture.agentId)).status).toBe("provisioning");
      releaseRestore();
      const result = await provisioning;
      expect(result.success).toBe(true);
      expect(applied).toEqual([
        { memories: [], config: {}, workspaceFiles: { "marker.txt": "delayed-restore" } },
      ]);
      expect((await readAgent(fixture.agentId)).status).toBe("running");
    } finally {
      releaseRestore();
      push.mockRestore();
      ensure.mockRestore();
    }
  },
  TEST_TIMEOUT,
);

test(
  "background readiness still recovers a healthy first-creation row with no backup",
  async () => {
    const fixture = await seedAgent();
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "provisioning",
        sandbox_id: fixture.containerName,
        node_id: NODE_ID,
        container_name: fixture.containerName,
        bridge_url: "http://127.0.0.1:1",
        health_url: "http://127.0.0.1:1/health",
      })
      .where(eq(agentSandboxes.id, fixture.agentId));
    const log: ProviderLog = { creates: 0, exactStops: [], nameStops: [] };
    const service = new ElizaSandboxService(dockerProvider(fixture, log));
    expect(await service.reconcileStuckProvisioning(fixture.agentId, fixture.orgId)).toBe(
      "recovered",
    );
    expect((await readAgent(fixture.agentId)).status).toBe("running");
  },
  TEST_TIMEOUT,
);

const unrecoverable: Array<{
  name: string;
  error?: () => Error;
  reconstructNull?: true;
  executionTier?: "custom";
}> = [
  {
    name: "undecryptable snapshot",
    error: () => Object.assign(new Error("tag mismatch"), { name: "AeadError" }),
  },
  {
    name: "restore authentication failure",
    error: () => new Error("State restore failed: HTTP 401 {}"),
  },
  {
    name: "missing snapshot object",
    error: () => new Error("State restore failed: HTTP 410 gone"),
  },
  {
    name: "custom image without a restore endpoint",
    error: () => new Error("State restore failed: HTTP 404 not found"),
    executionTier: "custom",
  },
  { name: "null reconstruction", reconstructNull: true },
];

for (const scenario of unrecoverable) {
  test(
    `${scenario.name} fails closed, preserves the chain and never boots empty`,
    async () => {
      const fixture = await seedAgent();
      if (scenario.executionTier) {
        await dbWrite
          .update(agentSandboxes)
          .set({ execution_tier: scenario.executionTier })
          .where(eq(agentSandboxes.id, fixture.agentId));
      }
      const olderBackup = await seedBackup(fixture.agentId, `${scenario.name}-older`);
      const latestBackup = await seedBackup(fixture.agentId, `${scenario.name}-latest`);
      const log: ProviderLog = { creates: 0, exactStops: [], nameStops: [] };
      const service = new ElizaSandboxService(dockerProvider(fixture, log));
      const ensure = ensureRuntimeStub();
      const { agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes");
      const reconstruct = scenario.reconstructNull
        ? spyOn(agentSandboxesRepository, "getReconstructedBackupState").mockResolvedValue(
            undefined,
          )
        : undefined;
      const push = spyOn(SandboxBackup.prototype, "pushState").mockImplementation(async () => {
        if (scenario.error) throw scenario.error();
      });
      try {
        const result = await service.provision(fixture.agentId, fixture.orgId);
        expect(result.success).toBe(false);
        expect(result.failureCause).toMatchObject({
          code: "SNAPSHOT_RESTORE_REQUIRES_FRESH_BOOT_CONSENT",
        });
        expect(result.error).toContain("forceFreshBoot");
        const row = await readAgent(fixture.agentId);
        expect(row.status).toBe("error");
        // The failed candidate is retired by exact identity, never by name.
        expect(log.nameStops).toEqual([]);
        expect(log.exactStops).toHaveLength(1);
        expect(await allocation()).toBe(0);
        // Nothing prunes the retained chain on any unrecoverable shape.
        expect(await backupIds(fixture.agentId)).toEqual([olderBackup, latestBackup].sort());
      } finally {
        push.mockRestore();
        reconstruct?.mockRestore();
        ensure.mockRestore();
      }
    },
    TEST_TIMEOUT,
  );
}

test(
  "explicit fresh-boot consent boots without restore and still retains the chain",
  async () => {
    const fixture = await seedAgent();
    const backupId = await seedBackup(fixture.agentId, "consented");
    const log: ProviderLog = { creates: 0, exactStops: [], nameStops: [] };
    const service = new ElizaSandboxService(dockerProvider(fixture, log));
    const ensure = ensureRuntimeStub();
    const push = spyOn(SandboxBackup.prototype, "pushState");
    try {
      const result = await service.provision(fixture.agentId, fixture.orgId, {
        kind: "fresh-boot",
      });
      expect(result.success).toBe(true);
      expect(push).not.toHaveBeenCalled();
      expect((await readAgent(fixture.agentId)).status).toBe("running");
      expect(await backupIds(fixture.agentId)).toEqual([backupId]);
    } finally {
      push.mockRestore();
      ensure.mockRestore();
    }
  },
  TEST_TIMEOUT,
);

test(
  "a disconnected Dedicated upgrade target still owns the upgrade",
  async () => {
    const { findLiveTierUpgradeTarget } = await import("../agent-tier-upgrade-target");
    const source = await seedAgent();
    const [target] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: source.orgId,
        user_id: source.userId,
        agent_name: unique("dedicated"),
        status: "disconnected",
        execution_tier: "dedicated-always",
        database_status: "ready",
      })
      .returning();
    await dbWrite.insert(personalDedicatedUpgradeAuthorities).values({
      organization_id: source.orgId,
      user_id: source.userId,
      source_agent_id: source.agentId,
      dedicated_agent_id: target.id,
    });

    // Heartbeat loss before cutover keeps the container and node slot; the
    // upgrade must reattach to it, not report "available" and mint again.
    const live = await findLiveTierUpgradeTarget(source.orgId, source.agentId);
    expect(live?.id).toBe(target.id);
  },
  TEST_TIMEOUT,
);

test(
  "adopting a disconnected Dedicated target binds it without reprovisioning",
  async () => {
    const { adoptPersonalDedicatedTargetWithProvision, resolvePersonalDedicatedAdoption } =
      await import("../agent-tier-upgrade-target");
    const source = await seedAgent();
    const [target] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: source.orgId,
        user_id: source.userId,
        agent_name: unique("dedicated"),
        status: "disconnected",
        execution_tier: "dedicated-always",
        database_status: "ready",
      })
      .returning();

    const resolved = await resolvePersonalDedicatedAdoption({
      organizationId: source.orgId,
      userId: source.userId,
      sourceAgentId: source.agentId,
    });
    expect(resolved.state).toBe("available");

    const result = await adoptPersonalDedicatedTargetWithProvision({
      organizationId: source.orgId,
      userId: source.userId,
      sourceAgentId: source.agentId,
      expectedTargetId: target.id,
      expectedLifecycleRevision: target.lifecycle_revision,
      expectedStatus: "disconnected",
      expectedBalance: 5,
      expectedHourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
      expectedDailyRate: AGENT_PRICING.DAILY_RUNNING_COST,
      expectedMinimumBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE,
      expectedMinimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
      expectedActivationAuthorityKey: "unreviewed-auto",
    });

    // Disconnected recovery owns reconnecting the kept container; adoption
    // must not commit a same-id provision job that rebuilds it.
    expect(result.jobCreated).toBe(false);
    expect(result.job).toBeUndefined();
    expect(result.agent.status).toBe("disconnected");
    const targetJobs = await dbWrite.select().from(jobs).where(eq(jobs.agent_id, target.id));
    expect(targetJobs).toHaveLength(0);
    const authorities = await dbWrite
      .select()
      .from(personalDedicatedUpgradeAuthorities)
      .where(eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, target.id));
    expect(authorities).toHaveLength(1);
  },
  TEST_TIMEOUT,
);

test(
  "the orphaned-pending sweep leaves lazy and deferred agents waiting to be provisioned",
  async () => {
    const { agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes");
    const lazy = await seedAgent();
    const eager = await seedAgent();
    // `alwaysOn: true, autoProvision: false`: an eager tier waiting for the
    // caller's explicit provision call.
    const deferred = await seedAgent();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite
      .update(agentSandboxes)
      .set({ execution_tier: "dedicated-lazy", created_at: old })
      .where(eq(agentSandboxes.id, lazy.agentId));
    await dbWrite
      .update(agentSandboxes)
      .set({ created_at: old })
      .where(eq(agentSandboxes.id, eager.agentId));
    await dbWrite
      .update(agentSandboxes)
      .set({ created_at: old, agent_config: { __agentProvisioningDeferred: true } })
      .where(eq(agentSandboxes.id, deferred.agentId));

    const result = await agentSandboxesRepository.markOrphanedPendingWithoutJobAsError(
      new Date(Date.now() - 10 * 60 * 1000),
    );

    // The always-on agent was meant to provision at create and never got a job.
    expect(result.updated.map((row) => row.agentId)).toEqual([eager.agentId]);
    expect((await readAgent(eager.agentId)).status).toBe("error");
    // A lazy agent is pending without a job by design until its first message.
    expect((await readAgent(lazy.agentId)).status).toBe("pending");
    expect((await readAgent(deferred.agentId)).status).toBe("pending");
  },
  TEST_TIMEOUT,
);

test(
  "the deferred backfill keeps an unmarked eager agent created before the marker out of the sweep",
  async () => {
    const { agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes");
    // Created with `autoProvision: false` before the create route set the
    // marker: eager tier, pending, no provision job, no marker.
    const legacy = await seedAgent();
    const running = await seedAgent();
    // Pending with a live provision job: not deferred, so not marked.
    const queued = await seedAgent();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await dbWrite
      .update(agentSandboxes)
      .set({ created_at: old, agent_config: { theme: "dark" } })
      .where(eq(agentSandboxes.id, legacy.agentId));
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "running", created_at: old })
      .where(eq(agentSandboxes.id, running.agentId));

    const { provisioningJobService } = await import("../provisioning-job-queue");
    await provisioningJobService.enqueueAgentProvisionOnce({
      agentId: queued.agentId,
      organizationId: queued.orgId,
      userId: queued.userId,
      agentName: "queued",
    });

    const migration = await readFile(
      join(import.meta.dir, "../../../db/migrations/0548_agent_provisioning_deferred_backfill.sql"),
      "utf8",
    );
    await dbWrite.execute(sql.raw(migration));

    const result = await agentSandboxesRepository.markOrphanedPendingWithoutJobAsError(
      new Date(Date.now() - 10 * 60 * 1000),
    );

    expect(result.updated.map((row) => row.agentId)).not.toContain(legacy.agentId);
    const after = await readAgent(legacy.agentId);
    expect(after.status).toBe("pending");
    expect(after.agent_config).toEqual({ theme: "dark", __agentProvisioningDeferred: true });
    expect((await readAgent(running.agentId)).agent_config).not.toHaveProperty(
      "__agentProvisioningDeferred",
    );

    expect((await readAgent(queued.agentId)).agent_config).not.toHaveProperty(
      "__agentProvisioningDeferred",
    );

    // The backfill cannot tell this row from a real orphan whose enqueue was
    // lost. The normal create retry (default `autoProvision: true`) reuses the
    // pending row through the real reuse guard and must leave it provisioning.
    const retry = await new ElizaSandboxService(
      dockerProvider(legacy, { creates: 0, exactStops: [], nameStops: [] }),
    ).createAgent({
      organizationId: legacy.orgId,
      userId: legacy.userId,
      agentName: "legacy",
      // A default retry without `alwaysOn` names the shared tier; the reuse
      // guard still returns the org's pending dedicated agent, so the route
      // decides repair from the reused agent's tier.
      executionTier: "shared",
      reuseExistingNonTerminal: true,
    });
    expect({
      id: retry.agent.id,
      idempotent: retry.idempotent,
      tier: retry.agent.execution_tier,
    }).toEqual({ id: legacy.agentId, idempotent: true, tier: "dedicated-always" });
    const recovered = await provisioningJobService.enqueueReusedPendingAgentProvision({
      agent: retry.agent,
      organizationId: legacy.orgId,
      userId: legacy.userId,
    });
    expect(recovered?.created).toBe(true);
    const [job] = await dbWrite
      .select({ type: jobs.type, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, recovered?.job.id ?? ""));
    expect(job).toEqual({ type: "agent_provision", status: "pending" });
    // A second retry gets the same live job, not another one.
    const again = await provisioningJobService.enqueueReusedPendingAgentProvision({
      agent: retry.agent,
      organizationId: legacy.orgId,
      userId: legacy.userId,
    });
    expect({ created: again?.created, jobId: again?.job.id }).toEqual({
      created: false,
      jobId: recovered?.job.id,
    });
  },
  TEST_TIMEOUT,
);

test(
  "an eager agent created through createAgent with provisioning deferred stays out of the sweep",
  async () => {
    const { agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes");
    const fixture = await seedAgent();
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "running" })
      .where(eq(agentSandboxes.id, fixture.agentId));
    const service = new ElizaSandboxService(
      dockerProvider(fixture, { creates: 0, exactStops: [], nameStops: [] }),
    );
    // `alwaysOn: true, autoProvision: false` through the create route.
    const deferred = await service.createAgent({
      organizationId: fixture.orgId,
      userId: fixture.userId,
      agentName: "deferred",
      agentConfig: { theme: "dark" },
      executionTier: "dedicated-always",
      provisioningDeferred: true,
    });
    // A caller cannot set the marker through `agentConfig`.
    const unmarked = await service.createAgent({
      organizationId: fixture.orgId,
      userId: fixture.userId,
      agentName: "unmarked",
      agentConfig: { __agentProvisioningDeferred: true },
      executionTier: "dedicated-always",
    });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const id of [deferred.agent.id, unmarked.agent.id]) {
      await dbWrite
        .update(agentSandboxes)
        .set({ created_at: old })
        .where(eq(agentSandboxes.id, id));
    }

    const result = await agentSandboxesRepository.markOrphanedPendingWithoutJobAsError(
      new Date(Date.now() - 10 * 60 * 1000),
    );

    const swept = result.updated.map((row) => row.agentId);
    expect(swept).toContain(unmarked.agent.id);
    expect(swept).not.toContain(deferred.agent.id);
    const stored = await readAgent(deferred.agent.id);
    expect(stored.status).toBe("pending");
    expect(stored.agent_config).toMatchObject({
      theme: "dark",
      __agentProvisioningDeferred: true,
    });
    expect((await readAgent(unmarked.agent.id)).status).toBe("error");
  },
  TEST_TIMEOUT,
);
