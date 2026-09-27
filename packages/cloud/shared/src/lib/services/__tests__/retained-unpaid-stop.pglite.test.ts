/** Exercises the unpaid stop-in-place path over real PostgreSQL semantics (PGlite): stop intents, lifecycle rows, node protections and exact resume are real; provider effects and billing settlement are controlled. This is not physical Docker evidence. */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("retained-unpaid-stop.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentBillingRepository } from "../../../db/repositories/agent-billing";
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
import { containers } from "../../../db/schemas/containers";
import { dockerNodes } from "../../../db/schemas/docker-nodes";
import { generations } from "../../../db/schemas/generations";
import { jobExecutionLeases } from "../../../db/schemas/job-execution-leases";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import { SandboxBackup } from "../eliza-sandbox/backup/service";
import type { SandboxProvider } from "../sandbox-provider-types";
import type { SandboxRuntimeIdentity } from "../sandbox-runtime-observation";

const TEST_TIMEOUT = 300_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;
let workloads: typeof import("../docker-node-workloads");

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runMigration(name: string): Promise<void> {
  const migration = await readFile(join(import.meta.dir, `../../../db/migrations/${name}`), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ ElizaSandboxService } = await import("../eliza-sandbox"));
  workloads = await import("../docker-node-workloads");
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
  await runMigration("0189_agent_sandbox_lifecycle_revision_scope.sql");
  // Apply the real additive migration from a pre-column schema, then replay it.
  await dbWrite.execute(
    sql.raw(
      "ALTER TABLE agent_sandboxes DROP CONSTRAINT IF EXISTS agent_sandboxes_retained_runtime_object",
    ),
  );
  await dbWrite.execute(sql.raw("ALTER TABLE agent_sandboxes DROP COLUMN retained_runtime"));
  for (let replay = 0; replay < 2; replay++) {
    await runMigration("0478_agent_sandbox_retained_runtime.sql");
  }
  for (const [name, table] of [
    ["docker_nodes", dockerNodes],
    ["containers", containers],
    ["agent_compute_funding", agentComputeFunding],
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

interface Scenario {
  orgId: string;
  userId: string;
  agentId: string;
  jobId: string;
  nodeId: string;
  identity: SandboxRuntimeIdentity;
}

async function seedRunningUnpaidAgent(): Promise<Scenario> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: unique("org"), credit_balance: "0.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: unique("steward"), organization_id: organization.id })
    .returning();
  const nodeId = unique("retained-node");
  const nodeRecordId = crypto.randomUUID();
  await dbWrite.insert(dockerNodes).values({
    id: nodeRecordId,
    node_id: nodeId,
    hostname: "127.0.0.1",
    allocated_count: 1,
  });
  const [agent] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organization.id,
      user_id: user.id,
      agent_name: unique("agent"),
      status: "running",
      execution_tier: "dedicated-always",
      environment_vars: { ELIZA_API_TOKEN: "test-agent-token" },
    })
    .returning();
  const containerName = `agent-${agent.id}`;
  await dbWrite
    .update(agentSandboxes)
    .set({
      sandbox_id: containerName,
      node_id: nodeId,
      container_name: containerName,
      bridge_url: "http://127.0.0.1:1",
      health_url: "http://127.0.0.1:1/api",
    })
    .where(eq(agentSandboxes.id, agent.id));
  const [current] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agent.id));
  const [job] = await dbWrite
    .insert(jobs)
    .values({
      organization_id: organization.id,
      agent_id: agent.id,
      user_id: user.id,
      type: "agent_suspend",
      status: "pending",
      data: {
        agentId: agent.id,
        organizationId: organization.id,
        userId: user.id,
        authorization: "billing_request",
      },
    })
    .returning();
  await dbWrite.insert(agentComputeStopIntents).values({
    organization_id: organization.id,
    agent_id: agent.id,
    job_id: job.id,
    lifecycle_revision: current.lifecycle_revision,
    authorization: "billing_request",
  });
  return {
    orgId: organization.id,
    userId: user.id,
    agentId: agent.id,
    jobId: job.id,
    nodeId,
    identity: {
      organizationId: organization.id,
      agentId: agent.id,
      nodeId,
      nodeRecordId,
      nodeIncarnation: "10000000-0000-4000-8000-000000000002",
      nodeHistoryId: "10000000-0000-4000-8000-000000000003",
      hostname: "127.0.0.1",
      sshPort: 22,
      sshUser: "root",
      hostKeyFingerprint: "SHA256:controlledfixture",
      containerName,
      containerId: "b".repeat(64),
    },
  };
}

interface RuntimeLog {
  present: boolean;
  running: boolean;
  retainedStops: SandboxRuntimeIdentity[];
  retainedStarts: SandboxRuntimeIdentity[];
  removals: string[];
  creates: number;
}

/** Any removal or replacement create would destroy the only copy of unbacked writes. */
function retainingProvider(scenario: Scenario, log: RuntimeLog): SandboxProvider {
  return {
    async observeRuntime(input) {
      expect(input.agentId).toBe(scenario.agentId);
      if (!log.present) return { kind: "absent", identity: scenario.identity };
      return { kind: "present", identity: scenario.identity, running: log.running };
    },
    async retainObservedRuntimeStopped(identity) {
      expect(identity).toEqual(scenario.identity);
      if (!log.present) throw new Error("retained runtime absent");
      log.retainedStops.push(identity);
      log.running = false;
    },
    async startRetainedRuntime(identity) {
      expect(identity).toEqual(scenario.identity);
      if (!log.present) throw new Error("retained runtime absent");
      log.retainedStarts.push(identity);
      log.running = true;
    },
    async create() {
      log.creates++;
      throw new Error("A replacement container would discard retained state");
    },
    async checkHealth() {
      return log.present && log.running;
    },
    async stopForDeletion(sandboxId) {
      log.removals.push(`delete:${sandboxId}`);
      throw new Error("unexpected deletion");
    },
    async stopForReplacement(sandboxId) {
      log.removals.push(`replace:${sandboxId}`);
      throw new Error("Removal is forbidden for a retained unpaid stop");
    },
    async stopObservedRuntime(sandboxId) {
      log.removals.push(`exact:${sandboxId}`);
      throw new Error("Removal is forbidden for a retained unpaid stop");
    },
  };
}

async function readAgent(agentId: string) {
  const [row] = await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, agentId));
  return row;
}

async function readIntent(jobId: string) {
  const [row] = await dbWrite
    .select()
    .from(agentComputeStopIntents)
    .where(eq(agentComputeStopIntents.job_id, jobId));
  return row;
}

async function retainUnpaidAgent(scenario: Scenario, log: RuntimeLog) {
  const service = new ElizaSandboxService(retainingProvider(scenario, log));
  const capture = spyOn(SandboxBackup.prototype, "fetchSnapshotState").mockRejectedValue(
    new Error("snapshot endpoint unreachable"),
  );
  const billing = spyOn(
    agentBillingRepository,
    "settleAccruedBillingBeforeLifecycleInTransaction",
  ).mockResolvedValue({ status: "insufficient_credits" });
  try {
    const intent = await readIntent(scenario.jobId);
    const result = await service.executeSuspend(
      scenario.agentId,
      scenario.orgId,
      scenario.jobId,
      "billing_request",
      intent.lifecycle_revision,
    );
    return { service, result };
  } finally {
    capture.mockRestore();
    billing.mockRestore();
  }
}

test(
  "an unpaid stop without a current backup stops in place, protects the runtime and resumes it exactly",
  async () => {
    const scenario = await seedRunningUnpaidAgent();
    const log: RuntimeLog = {
      present: true,
      running: true,
      retainedStops: [],
      retainedStarts: [],
      removals: [],
      creates: 0,
    };
    const { service, result } = await retainUnpaidAgent(scenario, log);
    expect(result).toMatchObject({ success: true, containerStopped: true, retained: true });
    expect(log.running).toBe(false);
    expect(log.retainedStops).toHaveLength(1);
    expect(log.removals).toEqual([]);

    const stopped = await readAgent(scenario.agentId);
    expect(stopped.status).toBe("stopped");
    expect(stopped.bridge_url).toBeNull();
    expect(stopped.sandbox_id).toBe(scenario.identity.containerName);
    expect(stopped.retained_runtime).toMatchObject({
      runtime: scenario.identity,
      bridgeUrl: "http://127.0.0.1:1",
      healthUrl: "http://127.0.0.1:1/api",
    });
    expect(await readIntent(scenario.jobId)).toMatchObject({ status: "provider_confirmed" });

    // Node retirement and the orphan reaper both see the retained state.
    expect(await workloads.countRetainedWorkloadsOnNodeWithDatabase(dbWrite, scenario.nodeId)).toBe(
      1,
    );
    const placements = await workloads.loadSandboxStatusesByIdsWithDatabase(dbWrite, [
      scenario.agentId,
    ]);
    expect(placements).toContainEqual({
      key: scenario.agentId,
      status: "retained_runtime_owned",
      nodeId: scenario.nodeId,
    });

    // Replaying the same confirmed job is a no-op.
    const replay = await retainUnpaidAgent(scenario, log);
    expect(replay.result).toMatchObject({ success: true, containerStopped: true });
    expect(log.retainedStops).toHaveLength(1);

    // Nothing may provision or sleep around the retained runtime.
    const provision = await service.provision(scenario.agentId, scenario.orgId);
    expect(provision.success).toBe(false);
    expect(provision.error).toContain("retains an unbacked runtime");
    const sleep = await service.executeSleep(scenario.agentId, scenario.orgId);
    expect(sleep.success).toBe(false);
    expect(log.creates).toBe(0);
    expect(log.removals).toEqual([]);

    // Insufficient funding keeps the runtime stopped and retained.
    const unfunded = spyOn(
      agentBillingRepository,
      "settleAccruedBillingBeforeLifecycle",
    ).mockResolvedValue({ status: "insufficient_credits" });
    try {
      const refused = await service.executeResume(scenario.agentId, scenario.orgId);
      expect(refused.success).toBe(false);
      expect(log.retainedStarts).toEqual([]);
      expect((await readAgent(scenario.agentId)).status).toBe("stopped");
    } finally {
      unfunded.mockRestore();
    }

    const funded = spyOn(
      agentBillingRepository,
      "settleAccruedBillingBeforeLifecycle",
    ).mockResolvedValue({ status: "already_billed_recently" });
    try {
      const resumed = await service.executeResume(scenario.agentId, scenario.orgId);
      expect(resumed).toEqual({ success: true, containerStarted: true, reprovisioned: false });
    } finally {
      funded.mockRestore();
    }
    expect(log.retainedStarts).toEqual([scenario.identity]);
    expect(log.creates).toBe(0);
    const running = await readAgent(scenario.agentId);
    expect(running.status).toBe("running");
    expect(running.retained_runtime).toBeNull();
    expect(running.bridge_url).toBe("http://127.0.0.1:1");
    expect(running.health_url).toBe("http://127.0.0.1:1/api");
  },
  TEST_TIMEOUT,
);

test(
  "a missing retained runtime is a visible recovery failure, never a fresh boot",
  async () => {
    const scenario = await seedRunningUnpaidAgent();
    const log: RuntimeLog = {
      present: true,
      running: true,
      retainedStops: [],
      retainedStarts: [],
      removals: [],
      creates: 0,
    };
    const { service, result } = await retainUnpaidAgent(scenario, log);
    expect(result).toMatchObject({ success: true, retained: true });
    log.present = false;
    const funded = spyOn(
      agentBillingRepository,
      "settleAccruedBillingBeforeLifecycle",
    ).mockResolvedValue({ status: "already_billed_recently" });
    try {
      const resumed = await service.executeResume(scenario.agentId, scenario.orgId);
      expect(resumed.success).toBe(false);
      expect(resumed.error).toContain("Retained runtime is missing");
    } finally {
      funded.mockRestore();
    }
    expect(log.creates).toBe(0);
    const row = await readAgent(scenario.agentId);
    expect(row.status).toBe("stopped");
    expect(row.retained_runtime).not.toBeNull();
  },
  TEST_TIMEOUT,
);

test(
  "a failed in-place stop leaves a retryable intent and never removes the runtime",
  async () => {
    const scenario = await seedRunningUnpaidAgent();
    const log: RuntimeLog = {
      present: true,
      running: true,
      retainedStops: [],
      retainedStarts: [],
      removals: [],
      creates: 0,
    };
    const provider = retainingProvider(scenario, log);
    provider.retainObservedRuntimeStopped = async () => {
      throw new Error("docker stop timed out");
    };
    const service = new ElizaSandboxService(provider);
    const capture = spyOn(SandboxBackup.prototype, "fetchSnapshotState").mockRejectedValue(
      new Error("snapshot endpoint unreachable"),
    );
    const billing = spyOn(
      agentBillingRepository,
      "settleAccruedBillingBeforeLifecycleInTransaction",
    ).mockResolvedValue({ status: "insufficient_credits" });
    try {
      const intent = await readIntent(scenario.jobId);
      const result = await service.executeSuspend(
        scenario.agentId,
        scenario.orgId,
        scenario.jobId,
        "billing_request",
        intent.lifecycle_revision,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("docker stop timed out");
    } finally {
      capture.mockRestore();
      billing.mockRestore();
    }
    expect(log.removals).toEqual([]);
    expect(await readIntent(scenario.jobId)).toMatchObject({
      status: "retry",
      last_error: "docker stop timed out",
    });
    const row = await readAgent(scenario.agentId);
    expect(row.status).toBe("running");
    expect(row.retained_runtime).toBeNull();
  },
  TEST_TIMEOUT,
);
