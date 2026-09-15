/** Exercises real PostgreSQL rollback, encrypted backup persistence and same-job suspend recovery. Snapshot transport, provider effects and unrelated billing settlement are controlled; this is not physical provider evidence. */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("suspend-backup-durability.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentBillingRepository } from "../../../db/repositories/agent-billing";
import { jobsRepository } from "../../../db/repositories/jobs";
import { agentBackupObjects } from "../../../db/schemas/agent-backup-catalog";
import { agentComputeFunding } from "../../../db/schemas/agent-compute-funding";
import { agentComputeStopIntents } from "../../../db/schemas/agent-compute-stop-intents";
import { agentNodeIncarnationHistories } from "../../../db/schemas/agent-node-incarnation-histories";
import {
  type AgentSandbox,
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../../db/schemas/api-keys";
import { containers } from "../../../db/schemas/containers";
import { dockerNodes } from "../../../db/schemas/docker-nodes";
import { generations } from "../../../db/schemas/generations";
import { jobExecutionLeases } from "../../../db/schemas/job-execution-leases";
import { type Job, jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import { SandboxBackup } from "../eliza-sandbox/backup/service";
import { ProvisioningJobService } from "../provisioning-jobs";
import type { SandboxProvider } from "../sandbox-provider-types";

const TEST_TIMEOUT = 300_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;
let agentSandboxesRepository: typeof import("../../../db/repositories/agent-sandboxes").agentSandboxesRepository;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ orgId: string; userId: string }> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: unique("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: unique("steward"), organization_id: organization.id })
    .returning();
  return { orgId: organization.id, userId: user.id };
}

async function seedRunningAgent(orgId: string, userId: string): Promise<AgentSandbox> {
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: orgId,
      user_id: userId,
      agent_name: unique("agent"),
      status: "running",
      execution_tier: "dedicated-always",
      environment_vars: { ELIZA_API_TOKEN: "test-agent-token" },
    })
    .returning();
  return sandbox;
}

async function applyLifecycleRevisionMigration(): Promise<void> {
  const migration = await readFile(
    join(import.meta.dir, "../../../db/migrations/0189_agent_sandbox_lifecycle_revision_scope.sql"),
    "utf8",
  );
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await dbWrite.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ ElizaSandboxService } = await import("../eliza-sandbox"));
  ({ agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes"));
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
  await applyLifecycleRevisionMigration();
  // Apply the real additive migration from a pre-column schema, then replay it.
  await dbWrite.execute(
    sql.raw("ALTER TABLE agent_compute_stop_intents DROP COLUMN prepared_backup CASCADE"),
  );
  const preparationMigration = await readFile(
    join(import.meta.dir, "../../../db/migrations/0396_prepared_stop_backup.sql"),
    "utf8",
  );
  for (let replay = 0; replay < 2; replay++) {
    for (const statement of preparationMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(sql.raw(statement));
    }
  }
  for (const [name, table] of [
    ["docker_nodes", dockerNodes],
    ["containers", containers],
  ] as const)
    await dbWrite.execute(
      sql.raw(
        `CREATE TABLE ${name} (${getTableConfig(table)
          .columns.map((c) => `"${c.name}" ${c.getSQLType()}`)
          .join(",")})`,
      ),
    );
  await dbWrite.execute(
    sql.raw(
      `CREATE TABLE agent_compute_funding (${getTableConfig(agentComputeFunding)
        .columns.map((c) => `"${c.name}" ${c.getSQLType()}`)
        .join(",")})`,
    ),
  );
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

test(
  "committed backup survives publication rollback and the same job recovers without recapturing a removed runtime",
  async () => {
    const { orgId, userId } = await seedOwner();
    const agent = await seedRunningAgent(orgId, userId);
    const sibling = await seedRunningAgent(orgId, userId);
    await dbWrite
      .update(agentSandboxes)
      .set({ node_id: "owned-node" })
      .where(eq(agentSandboxes.id, sibling.id));
    await dbWrite.insert(dockerNodes).values({
      id: "10000000-0000-4000-8000-000000000001",
      node_id: "owned-node",
      hostname: "127.0.0.1",
      allocated_count: 2,
    });
    const allocation = async () => {
      const [node] = await dbWrite
        .select()
        .from(dockerNodes)
        .where(eq(dockerNodes.node_id, "owned-node"));
      return node.allocated_count;
    };
    await dbWrite
      .update(agentSandboxes)
      .set({
        sandbox_id: "owned-original",
        node_id: "owned-node",
        container_name: "owned-container",
        bridge_url: "http://127.0.0.1:1",
      })
      .where(eq(agentSandboxes.id, agent.id));
    const [current] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agent.id));
    const [job] = await dbWrite
      .insert(jobs)
      .values({
        organization_id: orgId,
        agent_id: agent.id,
        user_id: userId,
        type: "agent_suspend",
        status: "pending",
        data: {
          agentId: agent.id,
          organizationId: orgId,
          userId,
          authorization: "billing_request",
        },
      })
      .returning();
    const [intent] = await dbWrite
      .insert(agentComputeStopIntents)
      .values({
        organization_id: orgId,
        agent_id: agent.id,
        job_id: job.id,
        lifecycle_revision: current.lifecycle_revision,
        authorization: "billing_request",
      })
      .returning();
    await expect(
      Promise.resolve(
        dbWrite.execute(
          sql`UPDATE agent_compute_stop_intents SET prepared_backup = '[]'::jsonb WHERE id = ${intent.id}`,
        ),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "agent_compute_stop_intents_prepared_backup_object" },
    });
    const ownerId = "10000000-0000-4000-8000-000000000010";
    const foreignOwnerId = "10000000-0000-4000-8000-000000000011";
    const dispatcher = new ProvisioningJobService({ executionOwnerId: ownerId });
    // Exercise the actual pre-dispatch lease/identity/fence boundary without starting unrelated dispatcher loops.
    const claimFence = (claimed: Job) =>
      (
        dispatcher as unknown as {
          assertNoConflictingLifecycleExecution(job: Job): Promise<void>;
        }
      ).assertNoConflictingLifecycleExecution(claimed);
    const claim = async () => {
      const [claimed] = await jobsRepository.claimPendingJobs({
        type: "agent_suspend",
        organizationId: orgId,
        limit: 1,
        executionOwnerId: ownerId,
        executionLeaseMs: 300_000,
      });
      if (!claimed) throw new Error("Original suspend job was not claimed");
      expect(claimed.id).toBe(job.id);
      await claimFence(claimed);
      return claimed;
    };
    const claimed = await claim();
    const readIntent = async () => {
      const [row] = await dbWrite
        .select()
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.id, intent.id));
      return row;
    };
    let present = true;
    let observationUnavailable = false;
    let captureUnavailable = false;
    let stops = 0;
    let captures = 0;
    const provider: SandboxProvider = {
      async observeRuntime(input) {
        if (observationUnavailable)
          return { kind: "unavailable", reason: "controlled transport unavailable" };
        const identity = input.expected ?? {
          organizationId: orgId,
          agentId: agent.id,
          nodeId: "owned-node",
          nodeRecordId: "10000000-0000-4000-8000-000000000001",
          nodeIncarnation: "10000000-0000-4000-8000-000000000002",
          nodeHistoryId: "10000000-0000-4000-8000-000000000003",
          hostname: "127.0.0.1",
          sshPort: 22,
          sshUser: "root",
          hostKeyFingerprint: "SHA256:controlledfixture",
          containerName: "owned-container",
          containerId: "a".repeat(64),
        };
        return present
          ? { kind: "present", identity, running: true }
          : { kind: "absent", identity };
      },
      async create() {
        throw new Error("unexpected create");
      },
      async checkHealth() {
        return present;
      },
      async stopForDeletion() {
        throw new Error("unexpected deletion");
      },
      async stopForReplacement() {
        throw new Error("Name-based stop is forbidden for a prepared runtime");
      },
      async stopObservedRuntime(_sandboxId, identity) {
        expect(identity.containerId).toBe("a".repeat(64));
        stops++;
        present = false;
      },
    };
    const service = new ElizaSandboxService(provider);
    const state = {
      memories: [],
      config: {},
      workspaceFiles: { "proof.txt": "complete café 日本語 🦊" },
    };
    const capture = spyOn(SandboxBackup.prototype, "fetchSnapshotState").mockImplementation(
      async () => {
        captures++;
        if (captureUnavailable) throw new Error("current runtime cannot be captured");
        if (!present) throw new Error("original runtime is absent");
        return {
          stateData: state,
          sizeBytes: Buffer.byteLength(JSON.stringify(state)),
          bridgeUrl: current.bridge_url!,
        };
      },
    );
    const billing = spyOn(
      agentBillingRepository,
      "settleAccruedBillingBeforeLifecycleInTransaction",
    ).mockResolvedValue({ status: "insufficient_credits" });
    try {
      await dbWrite.execute(
        sql.raw(
          `CREATE FUNCTION reject_stop_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'injected_provider_publication_failure'; END IF; RETURN NEW; END $$`,
        ),
      );
      await dbWrite.execute(
        sql.raw(
          `CREATE TRIGGER reject_stop_publication BEFORE UPDATE ON agent_compute_stop_intents FOR EACH ROW EXECUTE FUNCTION reject_stop_publication();`,
        ),
      );
      await expect(
        service.executeSuspend(
          agent.id,
          orgId,
          job.id,
          "billing_request",
          (await readIntent()).lifecycle_revision,
        ),
      ).rejects.toMatchObject({ cause: { message: "injected_provider_publication_failure" } });
      expect(present).toBe(false);
      expect(stops).toBe(1);
      expect(await allocation()).toBe(2);
      const backups = await dbWrite
        .select()
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.sandbox_record_id, agent.id));
      await dbWrite.execute(
        sql.raw("DROP TRIGGER reject_stop_publication ON agent_compute_stop_intents"),
      );
      const prepared = await readIntent();
      if (!prepared.prepared_backup) throw new Error("Missing prepared proof after rollback");
      const retryPrepared = () =>
        service.executeSuspend(
          agent.id,
          orgId,
          job.id,
          "billing_request",
          prepared.lifecycle_revision,
        );
      observationUnavailable = true;
      await expect(retryPrepared()).rejects.toMatchObject({
        code: "AGENT_STOP_OBSERVATION_UNAVAILABLE",
      });
      observationUnavailable = false;
      present = true;
      captureUnavailable = true;
      const refusedLive = await retryPrepared();
      expect(refusedLive.success).toBe(false);
      expect(refusedLive.error).toContain("current runtime cannot be captured");
      expect(stops).toBe(1);
      present = false;
      captureUnavailable = false;
      const proof = prepared.prepared_backup;
      for (const [changedProof, code] of [
        [
          { ...proof, source: { ...proof.source, organization_id: crypto.randomUUID() } },
          "AGENT_STOP_BACKUP_AUTHORITY_CHANGED",
        ],
        [{ ...proof, jobId: crypto.randomUUID() }, "AGENT_STOP_BACKUP_AUTHORITY_CHANGED"],
        [
          {
            ...proof,
            source: {
              ...proof.source,
              environment_revision: proof.source.environment_revision + 1,
            },
          },
          "AGENT_STOP_BACKUP_AUTHORITY_CHANGED",
        ],
        [{ ...proof, backupId: crypto.randomUUID() }, "AGENT_STOP_BACKUP_UNAVAILABLE"],
        [{ ...proof, contentHash: "0".repeat(64) }, "AGENT_STOP_BACKUP_CHANGED"],
      ] as const) {
        await dbWrite
          .update(agentComputeStopIntents)
          .set({ prepared_backup: changedProof })
          .where(eq(agentComputeStopIntents.id, intent.id));
        await expect(retryPrepared()).rejects.toMatchObject({ code });
        expect(stops).toBe(1);
        expect(await allocation()).toBe(2);
      }
      await dbWrite
        .update(agentComputeStopIntents)
        .set({ prepared_backup: proof })
        .where(eq(agentComputeStopIntents.id, intent.id));
      await dbWrite
        .update(jobExecutionLeases)
        .set({ owner_id: foreignOwnerId })
        .where(eq(jobExecutionLeases.job_id, job.id));
      await expect(claimFence(claimed)).rejects.toMatchObject({ name: "StaleJobExecutionError" });
      expect((await readIntent()).prepared_backup).toEqual(proof);
      await dbWrite
        .update(jobExecutionLeases)
        .set({ owner_id: ownerId })
        .where(eq(jobExecutionLeases.job_id, job.id));
      if (!claimed.execution_generation) throw new Error("Missing claimed generation");
      expect(
        await jobsRepository.incrementAttempt(
          job.id,
          "foreign release",
          3,
          undefined,
          claimed.execution_generation,
          foreignOwnerId,
        ),
      ).toBeUndefined();
      expect((await readIntent()).prepared_backup).toEqual(prepared.prepared_backup);
      await dbWrite
        .update(jobExecutionLeases)
        .set({ expires_at: new Date(0) })
        .where(eq(jobExecutionLeases.job_id, job.id));
      expect(
        await jobsRepository.incrementAttempt(
          job.id,
          "expired release",
          3,
          undefined,
          claimed.execution_generation,
          ownerId,
        ),
      ).toBeUndefined();
      expect((await readIntent()).prepared_backup).toEqual(prepared.prepared_backup);
      await dbWrite
        .update(jobExecutionLeases)
        .set({ expires_at: new Date(Date.now() + 300_000) })
        .where(eq(jobExecutionLeases.job_id, job.id));
      const released = await jobsRepository.incrementAttempt(
        job.id,
        "provider publication failed",
        3,
        undefined,
        claimed.execution_generation,
        ownerId,
      );
      expect(released?.status).toBe("pending");
      await dbWrite
        .update(jobs)
        .set({ scheduled_for: new Date(0) })
        .where(eq(jobs.id, job.id));
      const reclaimed = await claim();
      expect(reclaimed.execution_generation).not.toBe(claimed.execution_generation);
      const retryIntent = await readIntent();
      expect(retryIntent.prepared_backup?.backupId).toBe(prepared.prepared_backup?.backupId);
      expect(retryIntent.prepared_backup?.source.lifecycle_execution_generation).toBe(
        reclaimed.execution_generation,
      );
      expect(retryIntent.provider_confirmed_at).toBeNull();
      const result = await service.executeSuspend(
        agent.id,
        orgId,
        job.id,
        "billing_request",
        retryIntent.lifecycle_revision,
      );
      process.stdout.write(
        JSON.stringify({
          observedBackupRows: backups.length,
          sameJobRetry: result,
          controlledProviderPresent: present,
          controlledStops: stops,
          snapshotCaptures: captures,
        }) + "\n",
      );
      expect(backups.length).toBeGreaterThan(0);
      if (!retryIntent.prepared_backup) throw new Error("Missing exact prepared backup proof");
      const restored = await agentSandboxesRepository.getBackupById(
        retryIntent.prepared_backup.backupId,
      );
      expect(restored?.state_data).toEqual(state);
      expect(result.success).toBe(true);
      expect(result.containerStopped).toBe(true);
      expect(stops).toBe(1);
      expect(captures).toBe(2);
      expect(await allocation()).toBe(1);
      const replay = await service.executeSuspend(
        agent.id,
        orgId,
        job.id,
        "billing_request",
        (await readIntent()).lifecycle_revision,
      );
      expect(replay.success).toBe(true);
      expect(await allocation()).toBe(1);
      expect(stops).toBe(1);
    } finally {
      capture.mockRestore();
      billing.mockRestore();
      await dbWrite.execute(
        sql.raw("DROP TRIGGER IF EXISTS reject_stop_publication ON agent_compute_stop_intents"),
      );
      await dbWrite.execute(sql.raw("DROP FUNCTION IF EXISTS reject_stop_publication()"));
    }
  },
  TEST_TIMEOUT,
);
