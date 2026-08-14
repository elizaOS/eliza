/**
 * Real-database integration proof of the #18517 retention contract, run
 * against PGlite with the real repository, the real ElizaSandboxService, real
 * field encryption (memory KMS), and real offload to an in-memory R2 bucket.
 * Only the container-facing seams are stubbed: the bridge snapshot fetch and
 * the bounded provider stop. Covered end to end: `deleteAgent` traversal that
 * persists retention inside the deletion transaction and survives the row's
 * cascade delete; generation re-validation refusing a waiver observed on a
 * predecessor generation; supported-404 retry convergence without contacting
 * the dead bridge; recovery hydration (fetch + decrypt) after the parent row
 * is gone; and the bounded expiry purge including object-store cleanup.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
// Force offload for every non-waiver retention payload so the encrypt →
// offload → fetch → decrypt chain is exercised for real, not skipped by the
// size threshold.
process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES = "1";

import { spyOn } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import {
  agentSandboxesRepository,
  preparePredeletionBackupInsertData,
} from "../../db/repositories/agent-sandboxes";
import {
  agentSandboxBackups,
  agentSandboxes,
  agentSandboxPredeletionBackups,
} from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { generations } from "../../db/schemas/generations";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { sharedRuntimeHistory } from "../../db/schemas/shared-runtime-history";
import { usageRecords } from "../../db/schemas/usage-records";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { setRuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { ElizaSandboxService, SNAPSHOT_ENDPOINT_UNSUPPORTED } from "./eliza-sandbox";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

/** In-memory RuntimeR2Bucket standing in for the Worker binding. */
function makeFakeBucket() {
  const store = new Map<string, string>();
  let failNextDelete = false;
  return {
    store,
    failNextDelete: (v: boolean) => {
      failNextDelete = v;
    },
    bucket: {
      async get(key: string) {
        const value = store.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      async put(key: string, value: unknown) {
        store.set(key, String(value));
      },
      async delete(key: string) {
        if (failNextDelete) {
          failNextDelete = false;
          throw new Error("object store unavailable");
        }
        store.delete(key);
      },
    },
  };
}

const fake = makeFakeBucket();

type ServiceSpyTarget = {
  getAgentForWrite: (agentId: string, orgId: string) => Promise<unknown>;
  fetchSnapshotState: (rec: unknown) => Promise<unknown>;
  runBoundedSandboxStop: (sandboxId: string) => Promise<unknown>;
};

function makeSvc() {
  const svc = new ElizaSandboxService();
  return { svc, spyTarget: svc as unknown as ServiceSpyTarget };
}

async function seedOrgAndActor() {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Retention Org", slug: `retention-org-${Date.now()}-${Math.random()}` })
    .returning();
  const [actor] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: `retention-actor-${Date.now()}-${Math.random()}`,
      organization_id: org.id,
    })
    .returning();
  return { org, actor };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      apiKeys,
      usageRecords,
      generations,
      dockerNodes,
      agentSandboxes,
      agentSandboxBackups,
      agentSandboxPredeletionBackups,
      sharedRuntimeHistory,
      jobs,
      jobExecutionLeases,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    // The production lifecycle-revision trigger (ensureAgentSandboxSchema is
    // skipped under SKIP_AGENT_SANDBOX_ENSURE): every UPDATE bumps the
    // revision, which the generation checks under test must tolerate for
    // retained retries and enforce for fresh captures.
    await dbWrite.execute(sql`
      CREATE OR REPLACE FUNCTION advance_agent_sandbox_lifecycle_revision()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
        RETURN NEW;
      END;
      $$
    `);
    await dbWrite.execute(sql`
      DO $$ BEGIN
        CREATE TRIGGER agent_sandboxes_lifecycle_revision_trigger
        BEFORE UPDATE ON "agent_sandboxes"
        FOR EACH ROW
        EXECUTE FUNCTION advance_agent_sandbox_lifecycle_revision();
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    setRuntimeR2Bucket(fake.bucket);
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentSandboxPredeletionBackups);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(sharedRuntimeHistory);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  fake.store.clear();
});

afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

describe("pre-deletion retention survives a real parent delete (#18517)", () => {
  test("the sandbox row's deletion cascades agent_sandbox_backups but not the retention row", async () => {
    const { org, actor } = await seedOrgAndActor();
    const agentId = "00000000-0000-4000-8000-000000018517";
    const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: org.id,
      user_id: actor.id,
      agent_name: "Retention Agent",
      status: "deletion_pending",
      sandbox_id: "sandbox-18517",
      deletion_attempt_id: attemptId,
      deletion_started_at: new Date(),
    });
    await dbWrite.insert(agentSandboxBackups).values({
      sandbox_record_id: agentId,
      snapshot_type: "pre-shutdown",
      state_data: { tables: {} } as never,
    });
    await dbWrite.insert(agentSandboxPredeletionBackups).values({
      organization_id: org.id,
      agent_id: agentId,
      deletion_attempt_id: attemptId,
      lifecycle_revision: 1,
      sandbox_id: "sandbox-18517",
      bridge_url: "https://bridge-18517.example",
      capture_unsupported: false,
      state_data: { tables: {} } as never,
      size_bytes: 42,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    // The real parent delete — the exact statement commitAgentRowDelete runs.
    await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, agentId));

    const cascaded = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.sandbox_record_id, agentId));
    expect(cascaded).toEqual([]);

    const retained = await dbWrite
      .select()
      .from(agentSandboxPredeletionBackups)
      .where(eq(agentSandboxPredeletionBackups.agent_id, agentId));
    expect(retained).toHaveLength(1);
    expect(retained[0].deletion_attempt_id).toBe(attemptId);
    expect(retained[0].sandbox_id).toBe("sandbox-18517");
    expect(retained[0].size_bytes).toBe(42);
  });
});

describe("deleteAgent traversal persists, survives, and recovers the capture (#18517)", () => {
  test("the real delete path encrypts + offloads the capture, the row delete cascades around it, and recovery decrypts it", async () => {
    const { org, actor } = await seedOrgAndActor();
    const agentId = "00000000-0000-4000-8000-000000018518";
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: org.id,
      user_id: actor.id,
      agent_name: "Traversal Agent",
      status: "deletion_pending",
      execution_tier: "custom",
      sandbox_id: "sandbox-trav",
      bridge_url: "https://bridge-trav.example",
    });
    await dbWrite.insert(agentSandboxBackups).values({
      sandbox_record_id: agentId,
      snapshot_type: "pre-shutdown",
      state_data: { tables: {} } as never,
    });

    const stateData = { tables: { memories: 5, facts: 2 } };
    const { svc, spyTarget } = makeSvc();
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockResolvedValue({
      stateData,
      sizeBytes: 4096,
      bridgeUrl: "https://bridge-trav.example",
    });
    const stop = spyOn(spyTarget, "runBoundedSandboxStop").mockResolvedValue({
      kind: "not-running-proven",
    });
    try {
      const result = await svc.deleteAgent(agentId, org.id, { authorization: "user_request" });
      expect(result.success).toBe(true);
      expect(fetchSnap).toHaveBeenCalledTimes(1);

      const rows = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(rows).toEqual([]);
      const cascaded = await dbWrite
        .select()
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.sandbox_record_id, agentId));
      expect(cascaded).toEqual([]);

      const [retained] = await dbWrite
        .select()
        .from(agentSandboxPredeletionBackups)
        .where(eq(agentSandboxPredeletionBackups.agent_id, agentId));
      expect(retained).toBeDefined();
      expect(retained.sandbox_id).toBe("sandbox-trav");
      expect(retained.bridge_url).toBe("https://bridge-trav.example");
      expect(retained.capture_unsupported).toBe(false);
      expect(retained.deletion_attempt_id).toBeTruthy();
      // Offloaded for real: the stored column holds the inline placeholder,
      // the payload lives in the (fake) object store under the recorded key.
      expect(retained.state_data_storage).toBe("r2");
      expect(retained.state_data_key).toBeTruthy();
      expect(fake.store.has(retained.state_data_key as string)).toBe(true);
      // Bounded retention: the expiry stamp is the 30-day default window.
      expect(retained.expires_at.getTime() - retained.created_at.getTime()).toBe(
        30 * 24 * 60 * 60 * 1000,
      );

      // Recovery AFTER the sandbox row is gone: fetch from the object store
      // and decrypt back to the exact captured payload.
      const recovery = await svc.getPredeletionRecovery(agentId, org.id);
      expect(recovery).not.toBeNull();
      expect(recovery?.capture_unsupported).toBe(false);
      expect(recovery?.state_data).toEqual(stateData as never);
      // Org scope is the recovery authority: a different org sees nothing.
      expect(await svc.getPredeletionRecovery(agentId, actor.id)).toBeNull();
    } finally {
      fetchSnap.mockRestore();
      stop.mockRestore();
    }
  });
});

describe("generation re-validation under the lifecycle lock (#18517)", () => {
  test("a waiver observed on a predecessor generation refuses instead of stamping the replacement", async () => {
    const { org, actor } = await seedOrgAndActor();
    const agentId = "00000000-0000-4000-8000-000000018519";
    const [genA] = await dbWrite
      .insert(agentSandboxes)
      .values({
        id: agentId,
        organization_id: org.id,
        user_id: actor.id,
        agent_name: "Race Agent",
        status: "deletion_pending",
        execution_tier: "custom",
        sandbox_id: "sandbox-gen-a",
        bridge_url: "https://bridge-gen-a.example",
      })
      .returning();
    // The replacement completes while phase 0's unlocked fetch is in flight:
    // the DATABASE row is generation B before the lock is taken.
    await dbWrite
      .update(agentSandboxes)
      .set({ sandbox_id: "replacement-sandbox", bridge_url: "https://replacement-bridge.example" })
      .where(eq(agentSandboxes.id, agentId));

    const { svc, spyTarget } = makeSvc();
    const staleRead = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(genA);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED),
    );
    try {
      const result = await svc.deleteAgent(agentId, org.id, { authorization: "user_request" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toContain("lifecycle generation moved");

      const retained = await dbWrite
        .select()
        .from(agentSandboxPredeletionBackups)
        .where(eq(agentSandboxPredeletionBackups.agent_id, agentId));
      expect(retained).toEqual([]);
      const [row] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, agentId));
      expect(row.sandbox_id).toBe("replacement-sandbox");
    } finally {
      staleRead.mockRestore();
      fetchSnap.mockRestore();
    }
  });
});

describe("supported-404 retry convergence (#18517)", () => {
  test("a persisted waiver lets the retry complete without contacting the dead bridge", async () => {
    const { org, actor } = await seedOrgAndActor();
    const agentId = "00000000-0000-4000-8000-000000018520";
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: org.id,
      user_id: actor.id,
      agent_name: "Waiver Agent",
      status: "deletion_pending",
      execution_tier: "custom",
      sandbox_id: "sandbox-waiver",
      bridge_url: "https://bridge-waiver.example",
    });

    // Attempt 1: supported-404 waiver persisted in the prepare transaction;
    // the teardown then fails hard, leaving the deletion_pending tombstone.
    const first = makeSvc();
    const fetch1 = spyOn(first.spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED),
    );
    const stop1 = spyOn(first.spyTarget, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
      error: new Error("provider timeout"),
    });
    try {
      const attempt1 = await first.svc.deleteAgent(agentId, org.id, {
        authorization: "user_request",
      });
      expect(attempt1.success).toBe(false);
      expect(fetch1).toHaveBeenCalledTimes(1);
    } finally {
      fetch1.mockRestore();
      stop1.mockRestore();
    }
    const [afterFirst] = await dbWrite
      .select()
      .from(agentSandboxPredeletionBackups)
      .where(eq(agentSandboxPredeletionBackups.agent_id, agentId));
    expect(afterFirst).toBeDefined();
    expect(afterFirst.capture_unsupported).toBe(true);

    // Attempt 2: the container (and its bridge) are dead. The retained
    // waiver — same attempt, same placement — must satisfy the guarantee
    // with NO bridge contact, and the delete must complete.
    const second = makeSvc();
    const fetch2 = spyOn(second.spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error("bridge is dead and must not be contacted"),
    );
    const stop2 = spyOn(second.spyTarget, "runBoundedSandboxStop").mockResolvedValue({
      kind: "not-running-proven",
    });
    try {
      const attempt2 = await second.svc.deleteAgent(agentId, org.id, {
        authorization: "user_request",
      });
      expect(attempt2.success).toBe(true);
      expect(fetch2).not.toHaveBeenCalled();
    } finally {
      fetch2.mockRestore();
      stop2.mockRestore();
    }
    const rows = await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, agentId));
    expect(rows).toEqual([]);
    const retained = await dbWrite
      .select()
      .from(agentSandboxPredeletionBackups)
      .where(eq(agentSandboxPredeletionBackups.agent_id, agentId));
    expect(retained).toHaveLength(1);
    expect(retained[0].capture_unsupported).toBe(true);
  }, 30_000);
});

describe("bounded retention purge (#18517)", () => {
  test("expired rows are purged object-first; live rows and failed object deletes are kept", async () => {
    const { org } = await seedOrgAndActor();
    const agentId = "00000000-0000-4000-8000-000000018521";
    const base = {
      organization_id: org.id,
      agent_id: agentId,
      lifecycle_revision: 1,
      sandbox_id: "sandbox-purge",
      bridge_url: "https://bridge-purge.example",
      capture_unsupported: false,
      state_data: { tables: { memories: 9 } } as never,
      size_bytes: 128,
    };
    const expired = await preparePredeletionBackupInsertData({
      ...base,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
      created_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    const live = await preparePredeletionBackupInsertData({
      ...base,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
    });
    await dbWrite.insert(agentSandboxPredeletionBackups).values([expired, live]);
    expect(expired.state_data_key).toBeTruthy();
    expect(live.state_data_key).toBeTruthy();
    expect(fake.store.has(expired.state_data_key as string)).toBe(true);

    // Object-store outage: the expired row must survive the sweep so the
    // next tick can retry — a dropped row would leak its object forever.
    fake.failNextDelete(true);
    const failedSweep = await agentSandboxesRepository.purgeExpiredPredeletionBackups();
    expect(failedSweep).toEqual({ purged: 0, objectDeleteFailures: 1 });
    expect(fake.store.has(expired.state_data_key as string)).toBe(true);

    const sweep = await agentSandboxesRepository.purgeExpiredPredeletionBackups();
    expect(sweep).toEqual({ purged: 1, objectDeleteFailures: 0 });
    expect(fake.store.has(expired.state_data_key as string)).toBe(false);
    expect(fake.store.has(live.state_data_key as string)).toBe(true);

    const remaining = await dbWrite
      .select()
      .from(agentSandboxPredeletionBackups)
      .where(eq(agentSandboxPredeletionBackups.agent_id, agentId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(live.id as string);
  });
});
