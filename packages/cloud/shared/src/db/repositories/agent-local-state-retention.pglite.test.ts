/** Exercises durable payment retention admission, lease fences and rollback against real PGlite SQL. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.MOCK_REDIS = "1";

import { PROVISIONING_JOB_TEST_TABLES } from "../../lib/services/__tests__/tier-upgrade-pglite-schema";
import { ElizaSandboxService } from "../../lib/services/eliza-sandbox";
import type { SandboxProvider } from "../../lib/services/sandbox-provider";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { agentComputeStopIntents } from "../schemas/agent-compute-stop-intents";
import { type AgentLocalStateRetention, agentSandboxes } from "../schemas/agent-sandboxes";
import { jobExecutionLeases } from "../schemas/job-execution-leases";
import { jobs } from "../schemas/jobs";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";
import {
  carryConfirmedStopReceiptAcrossClaimInTransaction,
  releaseAgentLifecycleBindingInTransaction,
} from "./agent-compute-stop-intents";
import {
  admitLocalRetentionInTransaction,
  assertRetainedNodePublicationAuthorityInTransaction,
} from "./agent-local-state-retention";

beforeAll(async () => {
  for (const statement of PROVISIONING_JOB_TEST_TABLES) await dbWrite.execute(sql.raw(statement));
  await dbWrite.execute(
    sql.raw(
      `CREATE TABLE docker_nodes (
        id uuid PRIMARY KEY, node_id text, hostname text, ssh_port integer, ssh_user text, host_key_fingerprint text,
        capacity integer DEFAULT 8, enabled boolean DEFAULT true, placement_state text DEFAULT 'open',
        status text DEFAULT 'healthy', allocated_count integer DEFAULT 0, last_health_check timestamptz,
        fleet_kind text, infrastructure_provider text, provider_server_id text, node_incarnation uuid,
        current_node_history_id uuid, backup_admission_xid xid8 DEFAULT pg_current_xact_id(),
        metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      )`,
    ),
  );
  const migration = await readFile(
    new URL("../migrations/0189_agent_sandbox_lifecycle_revision_scope.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    await dbWrite.execute(sql.raw(statement));
}, 60_000);
beforeEach(async () => {
  await dbWrite.execute(
    sql.raw(
      "TRUNCATE agent_compute_stop_intents, jobs, job_execution_leases, agent_sandboxes, docker_nodes, compute_billing_rate_segments, credit_transactions, agent_billing_records, users, organizations CASCADE",
    ),
  );
});
afterAll(closeDatabaseConnectionsForTests);

async function seed(balance = "0.000000") {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "retention", slug: crypto.randomUUID(), credit_balance: balance })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ organization_id: org.id, steward_user_id: crypto.randomUUID() })
    .returning();
  const jobId = crypto.randomUUID();
  const generation = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const [agent] = await dbWrite
    .insert(agentSandboxes)
    .values({
      id: agentId,
      organization_id: org.id,
      user_id: user.id,
      status: "running",
      execution_tier: "dedicated-always",
      node_id: "retention-node",
      container_name: `agent-${agentId}`,
      sandbox_id: `agent-${agentId}`,
      lifecycle_job_id: jobId,
      lifecycle_execution_generation: generation,
      lifecycle_revision: 7,
      billing_status: "suspended",
    })
    .returning();
  await dbWrite.execute(sql`INSERT INTO compute_billing_rate_segments
    (organization_id, workload_kind, workload_id, lifecycle_revision, billing_state, rate_per_hour, effective_at)
    VALUES (${org.id}, 'agent', ${agent.id}, 7, 'running', '0.010000', '2026-01-01T00:00:00Z')`);
  await dbWrite.insert(jobs).values({
    id: jobId,
    type: "agent_suspend",
    status: "in_progress",
    data: {},
    agent_id: agent.id,
    organization_id: org.id,
    user_id: user.id,
    execution_generation: generation,
  });
  await dbWrite.insert(jobExecutionLeases).values({
    job_id: jobId,
    execution_generation: generation,
    owner_id: owner,
    expires_at: new Date(Date.now() + 60_000),
  });
  const [intent] = await dbWrite
    .insert(agentComputeStopIntents)
    .values({
      agent_id: agent.id,
      organization_id: org.id,
      job_id: jobId,
      lifecycle_revision: 7,
      authorization: "billing_request",
    })
    .returning();
  const nodeRecordId = crypto.randomUUID();
  await dbWrite.execute(
    sql`INSERT INTO docker_nodes (id, node_id, hostname, ssh_port, ssh_user, host_key_fingerprint) VALUES (${nodeRecordId}, 'retention-node', '192.0.2.1', 22, 'operator', 'SHA256:fixture')`,
  );
  const captured: AgentLocalStateRetention = {
    version: 1,
    stopIntentId: intent.id,
    agentId: agent.id,
    nodeId: "retention-node",
    nodeRecordId,
    containerId: "a".repeat(64),
    containerName: `agent-${agent.id}`,
    hostname: "192.0.2.1",
    sshPort: 22,
    sshUser: "operator",
    hostKeyFingerprint: "SHA256:fixture",
    bridgeUrl: "http://192.0.2.1:3000",
    healthUrl: "http://192.0.2.1:3000/api",
    capturedAt: new Date().toISOString(),
    state: "stop_pending",
  };
  const authority = {
    agentId: agent.id,
    organizationId: org.id,
    jobId,
    executionGeneration: generation,
    executionOwnerId: owner,
  };
  return { authority, captured };
}

test("commits protection and carries the stop intent across its own revision", async () => {
  const { authority, captured } = await seed();
  expect(
    (await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured)))
      .kind,
  ).toBe("retained");
  const [row] = await dbWrite.select().from(agentSandboxes);
  const [intent] = await dbWrite.select().from(agentComputeStopIntents);
  expect(row.local_state_retention?.containerId).toBe(captured.containerId);
  expect(row.lifecycle_revision).toBe(8);
  expect(intent.lifecycle_revision).toBe(row.lifecycle_revision);
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  expect((await dbWrite.select().from(agentSandboxes))[0].lifecycle_revision).toBe(8);
});
test("funded accounts acquire no stop protection, including refill after admission", async () => {
  const { authority, captured } = await seed("10.000000");
  expect(
    (await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured)))
      .kind,
  ).toBe("funded");
  expect((await dbWrite.select().from(agentSandboxes))[0].local_state_retention).toBeNull();
  await dbWrite.update(organizations).set({ credit_balance: "0" });
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  await dbWrite.update(organizations).set({ credit_balance: "10" });
  expect(
    (await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured)))
      .kind,
  ).toBe("funded");
  expect((await dbWrite.select().from(agentSandboxes))[0].local_state_retention).not.toBeNull();
});
test("expired lease cannot create retention", async () => {
  const { authority, captured } = await seed();
  await dbWrite.update(jobExecutionLeases).set({ expires_at: new Date(0) });
  await expect(
    dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured)),
  ).rejects.toThrow("no longer owns");
  expect((await dbWrite.select().from(agentSandboxes))[0].local_state_retention).toBeNull();
});
test("a different container cannot overwrite the only retained state", async () => {
  const { authority, captured } = await seed();
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  await expect(
    dbWrite.transaction((tx) =>
      admitLocalRetentionInTransaction(tx, authority, {
        ...captured,
        containerId: "b".repeat(64),
      }),
    ),
  ).rejects.toThrow("cannot be replaced");
  expect((await dbWrite.select().from(agentSandboxes))[0].local_state_retention?.containerId).toBe(
    captured.containerId,
  );
});
test("a newer lifecycle mutation wins before retention admission", async () => {
  const { authority, captured } = await seed();
  await dbWrite
    .update(agentSandboxes)
    .set({ status: "disconnected" })
    .where(eq(agentSandboxes.id, authority.agentId));
  await expect(
    dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured)),
  ).rejects.toThrow("no longer owns");
});

test("the real suspension service commits a retained stop and its confirmation", async () => {
  const { authority, captured } = await seed();
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  let stopped = false;
  const provider: SandboxProvider = {
    async create() {
      throw new Error("Must not replace retained state");
    },
    async checkRetainedContainerHealth() {
      return true;
    },
    async checkHealth() {
      return !stopped;
    },
    async stopForDeletion() {
      throw new Error("Must not delete retained state");
    },
    async captureRetainedContainer() {
      return captured.containerId;
    },
    async stopRetainingState(locator) {
      expect(locator.containerId).toBe(captured.containerId);
      stopped = true;
      return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
    },
  };
  const service = new ElizaSandboxService(provider);
  const result = await service.executeSuspend(
    authority.agentId,
    authority.organizationId,
    authority.jobId,
    "billing_request",
    8,
    authority,
  );
  expect(result.containerStopped).toBe(true);
  const [row] = await dbWrite.select().from(agentSandboxes);
  const [intent] = await dbWrite.select().from(agentComputeStopIntents);
  expect(row.status).toBe("stopped");
  expect(row.local_state_retention?.state).toBe("stopped");
  expect(intent.status).toBe("provider_confirmed");
  expect(intent.provider_confirmed_lifecycle_revision).toBe(BigInt(row.lifecycle_revision));
});

test("a lost stop result preserves pending state and a retry confirms the same container", async () => {
  const { authority, captured } = await seed();
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  let attempts = 0;
  const provider: SandboxProvider = {
    async create() {
      throw new Error("Unexpected replacement");
    },
    async checkRetainedContainerHealth() {
      return true;
    },
    async checkHealth() {
      return false;
    },
    async stopForDeletion() {
      throw new Error("Unexpected deletion");
    },
    async captureRetainedContainer() {
      throw new Error("Must reuse persisted capture");
    },
    async stopRetainingState(locator) {
      expect(locator.containerId).toBe(captured.containerId);
      if (++attempts === 1) throw new Error("lost provider response after stop");
      return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
    },
  };
  const service = new ElizaSandboxService(provider);
  await expect(
    service.executeSuspend(
      authority.agentId,
      authority.organizationId,
      authority.jobId,
      "billing_request",
      8,
      authority,
    ),
  ).rejects.toThrow("lost provider response");
  const [pending] = await dbWrite.select().from(agentSandboxes);
  expect(pending.local_state_retention?.state).toBe("stop_pending");
  expect(
    (await dbWrite.select().from(agentComputeStopIntents))[0].provider_confirmed_at,
  ).toBeNull();
  const result = await service.executeSuspend(
    authority.agentId,
    authority.organizationId,
    authority.jobId,
    "billing_request",
    8,
    authority,
  );
  expect(result.containerStopped).toBe(true);
  expect((await dbWrite.select().from(agentSandboxes))[0].local_state_retention?.containerId).toBe(
    captured.containerId,
  );
});

async function suspendedResumeFixture() {
  const { authority, captured } = await seed();
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  const provider: SandboxProvider = {
    async create() {
      throw new Error("Retained recovery must not create");
    },
    async checkRetainedContainerHealth() {
      return true;
    },
    async checkHealth() {
      return true;
    },
    async stopForDeletion() {
      throw new Error("Retained recovery must not delete");
    },
    async captureRetainedContainer() {
      return captured.containerId;
    },
    async stopRetainingState() {
      return { containerId: captured.containerId, state: "exited", restartPolicy: "no" };
    },
    async resumeRetainedContainer(locator) {
      expect(locator.containerId).toBe(captured.containerId);
      return { containerId: captured.containerId, state: "running", restartPolicy: "no" };
    },
  };
  const service = new ElizaSandboxService(provider);
  await service.executeSuspend(
    authority.agentId,
    authority.organizationId,
    authority.jobId,
    "billing_request",
    8,
    authority,
  );
  const [agent] = await dbWrite.select().from(agentSandboxes);
  const [intent] = await dbWrite.select().from(agentComputeStopIntents);
  const jobId = crypto.randomUUID();
  const generation = crypto.randomUUID();
  await dbWrite.update(jobs).set({ status: "completed", execution_quiesced_at: new Date() });
  await dbWrite.insert(jobs).values({
    id: jobId,
    type: "agent_resume",
    status: "in_progress",
    data: {},
    agent_id: agent.id,
    organization_id: agent.organization_id,
    user_id: agent.user_id,
    execution_generation: generation,
  });
  await dbWrite.insert(jobExecutionLeases).values({
    job_id: jobId,
    execution_generation: generation,
    owner_id: authority.executionOwnerId,
    expires_at: new Date(Date.now() + 60_000),
  });
  await dbWrite
    .update(agentComputeStopIntents)
    .set({ resume_job_id: jobId, resume_started_at: new Date() })
    .where(eq(agentComputeStopIntents.id, intent.id));
  await dbWrite
    .update(agentSandboxes)
    .set({ lifecycle_job_id: jobId, lifecycle_execution_generation: generation })
    .where(eq(agentSandboxes.id, agent.id));
  await dbWrite.update(organizations).set({ credit_balance: "10" });
  return {
    service,
    provider,
    captured,
    authority: {
      ...authority,
      jobId,
      executionGeneration: generation,
      userId: agent.user_id,
      intentId: intent.id,
      lifecycleRevision: String(intent.provider_confirmed_lifecycle_revision),
    },
  };
}

test("funded recovery publishes the same retained container and keeps local state protected", async () => {
  const { service, captured, authority } = await suspendedResumeFixture();
  const result = await service.executeResume(
    authority.agentId,
    authority.organizationId,
    authority,
  );
  expect(result.reprovisioned).toBe(false);
  expect(result.containerStarted).toBe(true);
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.status).toBe("running");
  expect(agent.bridge_url).toBe(captured.bridgeUrl);
  expect(agent.billing_status).toBe("active");
  expect(agent.local_state_retention?.containerId).toBe(captured.containerId);
  expect(agent.local_state_retention?.state).toBe("resumed");
});

test("funding lost during retained readiness prevents publication and stops the exact container", async () => {
  const { service, provider, authority, captured } = await suspendedResumeFixture();
  let stopped = false;
  provider.checkHealth = async () => {
    await dbWrite.update(organizations).set({ credit_balance: "0" });
    return true;
  };
  provider.stopRetainingState = async (locator) => {
    expect(locator.containerId).toBe(captured.containerId);
    stopped = true;
    return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
  };
  await expect(
    service.executeResume(authority.agentId, authority.organizationId, authority),
  ).rejects.toThrow("Retained container recovery failed");
  expect(stopped).toBe(true);
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.status).toBe("stopped");
  expect(agent.bridge_url).toBeNull();
  expect(agent.local_state_retention?.containerId).toBe(captured.containerId);
});

test("refill after a lost stop response resumes the same container under the owning stop job", async () => {
  const { authority, captured } = await seed();
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  let running = true;
  const provider: SandboxProvider = {
    async create() {
      throw new Error("Must not create during pending-stop refill");
    },
    async checkRetainedContainerHealth() {
      return true;
    },
    async checkHealth() {
      return running;
    },
    async captureRetainedContainer() {
      throw new Error("Must keep the committed identity");
    },
    async stopForDeletion() {
      throw new Error("Must not delete retained state");
    },
    async stopRetainingState() {
      running = false;
      throw new Error("stop acknowledgement lost");
    },
    async resumeRetainedContainer(locator) {
      expect(locator.containerId).toBe(captured.containerId);
      running = true;
      return { containerId: locator.containerId, state: "running", restartPolicy: "no" };
    },
  };
  const service = new ElizaSandboxService(provider);
  await expect(
    service.executeSuspend(
      authority.agentId,
      authority.organizationId,
      authority.jobId,
      "billing_request",
      8,
      authority,
    ),
  ).rejects.toThrow("acknowledgement lost");
  expect(running).toBe(false);
  await dbWrite.update(organizations).set({ credit_balance: "10" });
  const result = await service.executeSuspend(
    authority.agentId,
    authority.organizationId,
    authority.jobId,
    "billing_request",
    8,
    authority,
  );
  expect(result.success).toBe(true);
  expect(result.reason).toBe("billing_recovered");
  expect(running).toBe(true);
  const [agent] = await dbWrite.select().from(agentSandboxes);
  const [intent] = await dbWrite.select().from(agentComputeStopIntents);
  expect(agent.status).toBe("running");
  expect(agent.local_state_retention?.containerId).toBe(captured.containerId);
  expect(agent.local_state_retention?.state).toBe("resumed");
  expect(intent.status).toBe("superseded");
  expect(intent.provider_confirmed_at).toBeNull();
});

test("pending-stop refill cannot publish after its worker lease expires during readiness", async () => {
  const { authority, captured } = await seed();
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  await dbWrite.update(organizations).set({ credit_balance: "10" });
  const provider: SandboxProvider = {
    async create() {
      throw new Error("Unexpected create");
    },
    async checkRetainedContainerHealth() {
      return true;
    },
    async checkHealth() {
      await dbWrite.update(jobExecutionLeases).set({ expires_at: new Date(0) });
      return true;
    },
    async captureRetainedContainer() {
      throw new Error("Unexpected recapture");
    },
    async stopForDeletion() {
      throw new Error("Unexpected deletion");
    },
    async stopRetainingState() {
      throw new Error("Expired worker must not stop a successor");
    },
    async resumeRetainedContainer(locator) {
      return { containerId: locator.containerId, state: "running", restartPolicy: "no" };
    },
  };
  const service = new ElizaSandboxService(provider);
  await expect(
    service.executeSuspend(
      authority.agentId,
      authority.organizationId,
      authority.jobId,
      "billing_request",
      8,
      authority,
    ),
  ).rejects.toThrow("no longer owns");
  const [agent] = await dbWrite.select().from(agentSandboxes);
  const [intent] = await dbWrite.select().from(agentComputeStopIntents);
  expect(agent.local_state_retention?.state).toBe("stop_pending");
  expect(agent.bridge_url).toBeNull();
  expect(intent.status).toBe("pending");
});

test("a later payment lapse transfers retained ownership without changing the container", async () => {
  const { service, authority: resume, captured } = await suspendedResumeFixture();
  await service.executeResume(resume.agentId, resume.organizationId, resume);
  const jobId = crypto.randomUUID();
  const generation = crypto.randomUUID();
  await dbWrite.update(jobs).set({ status: "completed", execution_quiesced_at: new Date() });
  await dbWrite.insert(jobs).values({
    id: jobId,
    type: "agent_suspend",
    status: "in_progress",
    data: {},
    agent_id: resume.agentId,
    organization_id: resume.organizationId,
    user_id: resume.userId,
    execution_generation: generation,
  });
  await dbWrite.insert(jobExecutionLeases).values({
    job_id: jobId,
    execution_generation: generation,
    owner_id: resume.executionOwnerId,
    expires_at: new Date(Date.now() + 60_000),
  });
  const [agent] = await dbWrite
    .update(agentSandboxes)
    .set({ lifecycle_job_id: jobId, lifecycle_execution_generation: generation })
    .where(eq(agentSandboxes.id, resume.agentId))
    .returning();
  const [intent] = await dbWrite
    .insert(agentComputeStopIntents)
    .values({
      agent_id: agent.id,
      organization_id: agent.organization_id,
      job_id: jobId,
      lifecycle_revision: agent.lifecycle_revision,
      authorization: "billing_request",
    })
    .returning();
  await dbWrite.update(organizations).set({ credit_balance: "0" });
  const result = await service.executeSuspend(
    agent.id,
    agent.organization_id,
    jobId,
    "billing_request",
    agent.lifecycle_revision,
    { executionGeneration: generation, executionOwnerId: resume.executionOwnerId },
  );
  expect(result.containerStopped).toBe(true);
  const [stopped] = await dbWrite.select().from(agentSandboxes);
  expect(stopped.local_state_retention?.stopIntentId).toBe(intent.id);
  expect(stopped.local_state_retention?.containerId).toBe(captured.containerId);
  expect(stopped.local_state_retention?.nodeRecordId).toBe(captured.nodeRecordId);
  expect(stopped.local_state_retention?.state).toBe("stopped");
});

test("pending retention survives release and a new execution claim without accepting unrelated revisions", async () => {
  const { authority, captured } = await seed();
  await dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured));
  await dbWrite.transaction((tx) =>
    releaseAgentLifecycleBindingInTransaction(tx, { ...authority, preserveConfirmedStop: true }),
  );
  const [released] = await dbWrite.select().from(agentSandboxes);
  expect((await dbWrite.select().from(agentComputeStopIntents))[0].lifecycle_revision).toBe(
    released.lifecycle_revision,
  );
  const newGeneration = crypto.randomUUID();
  await dbWrite.transaction(async (tx) => {
    const [claimed] = await tx
      .update(agentSandboxes)
      .set({ lifecycle_job_id: authority.jobId, lifecycle_execution_generation: newGeneration })
      .where(eq(agentSandboxes.id, authority.agentId))
      .returning();
    await carryConfirmedStopReceiptAcrossClaimInTransaction(tx, {
      ...authority,
      previousRevision: String(released.lifecycle_revision),
      claimedRevision: String(claimed.lifecycle_revision),
    });
  });
  await dbWrite.update(jobs).set({ execution_generation: newGeneration });
  await dbWrite.update(jobExecutionLeases).set({ execution_generation: newGeneration });
  const retried = await dbWrite.transaction((tx) =>
    admitLocalRetentionInTransaction(
      tx,
      { ...authority, executionGeneration: newGeneration },
      captured,
    ),
  );
  expect(retried.kind).toBe("retained");
  await expect(
    dbWrite.transaction((tx) => admitLocalRetentionInTransaction(tx, authority, captured)),
  ).rejects.toThrow("no longer owns");
  expect(
    (await dbWrite.select().from(agentComputeStopIntents))[0].provider_confirmed_at,
  ).toBeNull();
});

test("backup failure captures and commits exact local retention before uncertain stop, then retries without recapture", async () => {
  const { authority, captured } = await seed();
  const [running] = await dbWrite
    .update(agentSandboxes)
    .set({ bridge_url: captured.bridgeUrl, health_url: captured.healthUrl })
    .where(eq(agentSandboxes.id, authority.agentId))
    .returning();
  await dbWrite
    .update(agentComputeStopIntents)
    .set({ lifecycle_revision: running.lifecycle_revision });
  let snapshots = 0;
  let captures = 0;
  let stops = 0;
  const provider: SandboxProvider = {
    async create() {
      throw new Error("Unexpected replacement");
    },
    async checkRetainedContainerHealth() {
      return true;
    },
    async checkHealth() {
      return true;
    },
    async stopForDeletion() {
      throw new Error("Unexpected destructive stop");
    },
    async captureRetainedContainer(locator) {
      captures++;
      expect(locator.hostname).toBe(captured.hostname);
      expect(locator.hostKeyFingerprint).toBe(captured.hostKeyFingerprint);
      return captured.containerId;
    },
    async stopRetainingState(locator) {
      expect(locator.containerId).toBe(captured.containerId);
      if (++stops === 1) throw new Error("stop response lost");
      return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
    },
  };
  const service = new ElizaSandboxService(provider);
  service["fetchAgentApi"] = async (_record, path) => {
    expect(path).toBe("/api/snapshot");
    snapshots++;
    return Response.json({ code: "PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT" }, { status: 503 });
  };
  await expect(
    service.executeSuspend(
      authority.agentId,
      authority.organizationId,
      authority.jobId,
      "billing_request",
      running.lifecycle_revision,
      authority,
    ),
  ).rejects.toThrow("stop response lost");
  const [pending] = await dbWrite.select().from(agentSandboxes);
  expect(pending.local_state_retention?.state).toBe("stop_pending");
  expect(pending.local_state_retention?.bridgeUrl).toBe(captured.bridgeUrl);
  expect(pending.local_state_retention?.containerId).toBe(captured.containerId);
  const result = await service.executeSuspend(
    authority.agentId,
    authority.organizationId,
    authority.jobId,
    "billing_request",
    pending.lifecycle_revision,
    authority,
  );
  expect(result.containerStopped).toBe(true);
  expect(snapshots).toBe(1);
  expect(captures).toBe(1);
  expect(stops).toBe(2);
});

test("node metadata changing during readiness cannot publish retained recovery elsewhere", async () => {
  const { service, provider, authority, captured } = await suspendedResumeFixture();
  provider.checkHealth = async () => {
    await dbWrite.execute(
      sql`UPDATE docker_nodes SET hostname='192.0.2.99' WHERE id=${captured.nodeRecordId}`,
    );
    return true;
  };
  await expect(
    service.executeResume(authority.agentId, authority.organizationId, authority),
  ).rejects.toThrow("Retained container recovery failed");
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.status).toBe("stopped");
  expect(agent.bridge_url).toBeNull();
  expect(agent.local_state_retention?.hostname).toBe(captured.hostname);
});

async function manualResumeFixture() {
  const fixture = await suspendedResumeFixture();
  const { intentId: _intentId, lifecycleRevision: _revision, ...authority } = fixture.authority;
  await dbWrite
    .update(agentComputeStopIntents)
    .set({ resume_job_id: null, resume_started_at: null });
  return { ...fixture, authority };
}

test("manual resume publishes the same protected container without automatic payment authority", async () => {
  const { service, authority, captured } = await manualResumeFixture();
  const result = await service.executeResume(
    authority.agentId,
    authority.organizationId,
    authority,
  );
  expect(result).toEqual({ success: true, containerStarted: true, reprovisioned: false });
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.status).toBe("running");
  expect(agent.billing_status).toBe("active");
  expect(agent.bridge_url).toBe(captured.bridgeUrl);
  expect(agent.local_state_retention?.containerId).toBe(captured.containerId);
  expect(agent.local_state_retention?.state).toBe("resumed");
});

for (const rejection of ["expired lease", "unfunded", "new stop", "missing authority"] as const) {
  test(`manual retained resume rejects ${rejection} before starting compute`, async () => {
    const { service, provider, authority } = await manualResumeFixture();
    let starts = 0;
    provider.resumeRetainedContainer = async (locator) => {
      starts++;
      return { containerId: locator.containerId, state: "running", restartPolicy: "no" };
    };
    if (rejection === "expired lease")
      await dbWrite.update(jobExecutionLeases).set({ expires_at: new Date(0) });
    if (rejection === "unfunded") await dbWrite.update(organizations).set({ credit_balance: "0" });
    if (rejection === "new stop") {
      const [agent] = await dbWrite.select().from(agentSandboxes);
      await dbWrite.insert(agentComputeStopIntents).values({
        agent_id: authority.agentId,
        organization_id: authority.organizationId,
        lifecycle_revision: agent.lifecycle_revision,
        authorization: "user_request",
      });
    }
    await expect(
      service.executeResume(
        authority.agentId,
        authority.organizationId,
        rejection === "missing authority" ? undefined : authority,
      ),
    ).rejects.toThrow();
    expect(starts).toBe(0);
    expect((await dbWrite.select().from(agentSandboxes))[0].status).toBe("stopped");
  });
}

test("manual resume loses funding during readiness and stops its exact container", async () => {
  const { service, provider, authority, captured } = await manualResumeFixture();
  let stopped = false;
  provider.checkHealth = async () => {
    await dbWrite.update(organizations).set({ credit_balance: "0" });
    return true;
  };
  provider.stopRetainingState = async (locator) => {
    expect(locator.containerId).toBe(captured.containerId);
    stopped = true;
    return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
  };
  await expect(
    service.executeResume(authority.agentId, authority.organizationId, authority),
  ).rejects.toThrow("Retained container recovery failed");
  expect(stopped).toBe(true);
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.status).toBe("stopped");
  expect(agent.bridge_url).toBeNull();
  expect(agent.local_state_retention?.containerId).toBe(captured.containerId);
});

test("manual resume cannot publish or tear down after losing its execution during readiness", async () => {
  const { service, provider, authority } = await manualResumeFixture();
  let stops = 0;
  provider.checkHealth = async () => {
    await dbWrite.update(jobExecutionLeases).set({ expires_at: new Date(0) });
    return true;
  };
  provider.stopRetainingState = async (locator) => {
    stops++;
    return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
  };
  await expect(
    service.executeResume(authority.agentId, authority.organizationId, authority),
  ).rejects.toThrow("Retained container recovery failed");
  expect(stops).toBe(0);
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.status).toBe("stopped");
  expect(agent.bridge_url).toBeNull();
});

async function manualStopFixture(resume = true) {
  const fixture = await manualResumeFixture();
  if (resume)
    await fixture.service.executeResume(
      fixture.authority.agentId,
      fixture.authority.organizationId,
      fixture.authority,
    );
  const jobId = crypto.randomUUID();
  const executionGeneration = crypto.randomUUID();
  await dbWrite.update(jobs).set({ status: "completed", execution_quiesced_at: new Date() });
  await dbWrite.insert(jobs).values({
    id: jobId,
    type: "agent_suspend",
    status: "in_progress",
    data: {},
    agent_id: fixture.authority.agentId,
    organization_id: fixture.authority.organizationId,
    user_id: fixture.authority.userId,
    execution_generation: executionGeneration,
  });
  await dbWrite.insert(jobExecutionLeases).values({
    job_id: jobId,
    execution_generation: executionGeneration,
    owner_id: fixture.authority.executionOwnerId,
    expires_at: new Date(Date.now() + 60_000),
  });
  const [agent] = await dbWrite
    .update(agentSandboxes)
    .set({ lifecycle_job_id: jobId, lifecycle_execution_generation: executionGeneration })
    .returning();
  const [intent] = await dbWrite
    .insert(agentComputeStopIntents)
    .values({
      agent_id: agent.id,
      organization_id: agent.organization_id,
      job_id: jobId,
      lifecycle_revision: agent.lifecycle_revision,
      authorization: "user_request",
    })
    .returning();
  return {
    ...fixture,
    intent,
    revision: agent.lifecycle_revision,
    authority: { ...fixture.authority, jobId, executionGeneration },
  };
}

for (const resume of [true, false]) {
  test(`manual stop preserves ${resume ? "resumed" : "already stopped"} state despite positive funding`, async () => {
    const { service, provider, authority, captured, revision, intent } =
      await manualStopFixture(resume);
    let stops = 0;
    provider.stopRetainingState = async (locator) => {
      expect(locator.containerId).toBe(captured.containerId);
      stops++;
      return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
    };
    provider.resumeRetainedContainer = async () => {
      throw new Error("User stop must not restart funded compute");
    };
    const result = await service.executeSuspend(
      authority.agentId,
      authority.organizationId,
      authority.jobId,
      "user_request",
      revision,
      authority,
    );
    expect(result.containerStopped).toBe(true);
    expect(stops).toBe(1);
    const [agent] = await dbWrite.select().from(agentSandboxes);
    expect(agent.status).toBe("stopped");
    expect(agent.bridge_url).toBeNull();
    expect(agent.local_state_retention?.containerId).toBe(captured.containerId);
    expect(agent.local_state_retention?.stopIntentId).toBe(intent.id);
    expect(agent.local_state_retention?.state).toBe("stopped");
    const [confirmed] = await dbWrite
      .select()
      .from(agentComputeStopIntents)
      .where(eq(agentComputeStopIntents.id, intent.id));
    expect(confirmed.authorization).toBe("user_request");
    expect(confirmed.status).toBe("provider_confirmed");
  });
}

test("manual retained stop retains ownership after a lost provider response and retries the same identity", async () => {
  const { service, provider, authority, captured, revision, intent } = await manualStopFixture();
  provider.stopRetainingState = async () => {
    throw new Error("Lost SSH response");
  };
  await expect(
    service.executeSuspend(
      authority.agentId,
      authority.organizationId,
      authority.jobId,
      "user_request",
      revision,
      authority,
    ),
  ).rejects.toThrow("Lost SSH response");
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.local_state_retention?.state).toBe("stop_pending");
  expect(agent.local_state_retention?.stopIntentId).toBe(intent.id);
  expect(agent.local_state_retention?.containerId).toBe(captured.containerId);
  provider.stopRetainingState = async (locator) => {
    expect(locator.containerId).toBe(captured.containerId);
    return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
  };
  const [currentIntent] = await dbWrite
    .select()
    .from(agentComputeStopIntents)
    .where(eq(agentComputeStopIntents.id, intent.id));
  const result = await service.executeSuspend(
    authority.agentId,
    authority.organizationId,
    authority.jobId,
    "user_request",
    currentIntent.lifecycle_revision,
    authority,
  );
  expect(result.containerStopped).toBe(true);
});

test("expired manual stop lease cannot stop the retained container or take its ownership", async () => {
  const { service, provider, authority, captured, revision } = await manualStopFixture();
  let stops = 0;
  provider.stopRetainingState = async (locator) => {
    stops++;
    return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
  };
  await dbWrite.update(jobExecutionLeases).set({ expires_at: new Date(0) });
  await expect(
    service.executeSuspend(
      authority.agentId,
      authority.organizationId,
      authority.jobId,
      "user_request",
      revision,
      authority,
    ),
  ).rejects.toThrow();
  expect(stops).toBe(0);
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.status).toBe("running");
  expect(agent.local_state_retention?.stopIntentId).toBe(captured.stopIntentId);
});

test("successful ingress cannot publish an unhealthy retained container", async () => {
  const { service, provider, authority, captured } = await manualResumeFixture();
  let stopped = false;
  provider.checkRetainedContainerHealth = async (locator) => {
    expect(locator.containerId).toBe(captured.containerId);
    return false;
  };
  provider.stopRetainingState = async (locator) => {
    stopped = true;
    return { containerId: locator.containerId, state: "exited", restartPolicy: "no" };
  };
  await expect(
    service.executeResume(authority.agentId, authority.organizationId, authority),
  ).rejects.toThrow("Retained container recovery failed");
  expect(stopped).toBe(true);
  const [agent] = await dbWrite.select().from(agentSandboxes);
  expect(agent.status).toBe("stopped");
  expect(agent.bridge_url).toBeNull();
  expect(agent.local_state_retention?.containerId).toBe(captured.containerId);
});

test.each(["current", "replacement-node", "changed-ssh"] as const)(
  "retained publication commits only against captured physical host authority (%s)",
  async (scenario) => {
    const { authority, captured } = await seed();
    if (scenario === "replacement-node") {
      await dbWrite.execute(
        sql`UPDATE docker_nodes SET id = ${crypto.randomUUID()} WHERE node_id = ${captured.nodeId}`,
      );
    } else if (scenario === "changed-ssh") {
      await dbWrite.execute(
        sql`UPDATE docker_nodes SET host_key_fingerprint = 'SHA256:replacement' WHERE id = ${captured.nodeRecordId}`,
      );
    }
    const publication = dbWrite.transaction(async (tx) => {
      await tx
        .update(agentSandboxes)
        .set({ status: "stopped" })
        .where(eq(agentSandboxes.id, authority.agentId));
      await assertRetainedNodePublicationAuthorityInTransaction(tx, captured);
    });
    if (scenario === "current") await publication;
    else
      await expect(publication).rejects.toThrow(
        "Retained node authority changed before publication",
      );
    const [observed] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, authority.agentId));
    expect(observed.status).toBe(scenario === "current" ? "stopped" : "running");
  },
);
