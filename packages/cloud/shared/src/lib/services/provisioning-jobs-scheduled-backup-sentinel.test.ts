/**
 * Drives `enqueueScheduledBackups` end-to-end against the REAL enqueue pipeline
 * on in-process PGlite: the selection SQL, the per-row `enqueueAgentSnapshotOnce`
 * → `enqueueLifecycleJob` transaction (advisory lock, sandbox read, in-flight
 * idempotency lookup, `jobs` insert) all execute for real and the assertions
 * read back the actual `jobs` rows written. No mock stands in for the thing under
 * test; a single spy appears only in the failure-path case, to force the
 * downstream enqueue to throw so the scanner's per-row catch is exercised.
 *
 * The load-bearing behavior is the reachability carve-out (issue #15737): a
 * `running` row whose bridge_url is the unreachable loopback sentinel
 * (`http://127.0.0.1:65535`) must never be re-enqueued, alongside the other
 * exclusions the scan already enforces (non-running, warm-pool, null-bridge,
 * recently-backed-up) and the maxAgents cap.
 *
 * Harness mirrors `provisioning-jobs-wake-enqueue.test.ts`: drizzle-kit
 * `pushSchema` applies the real DDL (jobs + its FK closure) to the PGlite
 * connection the service queries through, and fails LOUDLY when the ambient
 * DATABASE_URL is a shared non-PGlite Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { generations } from "../../db/schemas/generations";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { usageRecords } from "../../db/schemas/usage-records";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { JOB_TYPES } from "./provisioning-job-types";
import { provisioningJobService } from "./provisioning-jobs";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

const SENTINEL_BRIDGE = "http://127.0.0.1:65535";
const REACHABLE_BRIDGE = "http://10.0.0.5:8080";
const OTHER_REACHABLE_BRIDGE = "http://10.0.0.6:8080";

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Sentinel Backup Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

interface SeedOpts {
  status?: string;
  bridgeUrl?: string | null;
  poolStatus?: string | null;
  lastBackupAt?: Date | null;
}

async function seedSandbox(opts: SeedOpts = {}): Promise<string> {
  const { orgId, userId } = await seedOwner();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: orgId,
      user_id: userId,
      agent_name: uniq("agent"),
      // Default to a due, reachable, user-owned running row so each test only
      // has to flip the one field it is exercising out of eligibility.
      status: (opts.status ?? "running") as never,
      bridge_url: opts.bridgeUrl === undefined ? REACHABLE_BRIDGE : opts.bridgeUrl,
      pool_status: (opts.poolStatus ?? null) as never,
      last_backup_at: opts.lastBackupAt ?? null,
    })
    .returning();
  return sandbox.id;
}

async function snapshotJobsFor(agentId: string): Promise<Array<Record<string, unknown>>> {
  return (await dbWrite
    .select()
    .from(jobs)
    .where(and(eq(jobs.agent_id, agentId), eq(jobs.type, "agent_snapshot")))) as Array<
    Record<string, unknown>
  >;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[provisioning-jobs-scheduled-backup-sentinel.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    // The jobs table's FK closure: jobs → apiKeys/generations, generations →
    // usageRecords, agentSandboxes → userCharacters.
    const schema = {
      organizations,
      users,
      userCharacters,
      apiKeys,
      usageRecords,
      generations,
      agentSandboxes,
      jobs,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[provisioning-jobs-scheduled-backup-sentinel.test] PGlite/pushSchema unavailable — cannot drive the scheduled-backup scan against a real DB. Failing all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("enqueueScheduledBackups — sentinel-bridge exclusion (#15737)", () => {
  test("a running sentinel-bridge row is skipped while a normal running row enqueues a real snapshot job", async () => {
    const reachableId = await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });
    const sentinelId = await seedSandbox({ bridgeUrl: SENTINEL_BRIDGE });

    const res = await provisioningJobService.enqueueScheduledBackups();

    // Both rows are `running` with a non-null bridge_url; only the reachable one
    // survives the scan predicate and gets a real `agent_snapshot` job row.
    expect(res).toEqual({ scanned: 1, enqueued: 1 });

    const reachableJobs = await snapshotJobsFor(reachableId);
    expect(reachableJobs).toHaveLength(1);
    expect(reachableJobs[0]?.status).toBe("pending");
    expect((reachableJobs[0]?.data as { snapshotType?: string })?.snapshotType).toBe("auto");

    expect(await snapshotJobsFor(sentinelId)).toHaveLength(0);
  });

  test("a fleet of only sentinel-bridge rows enqueues nothing", async () => {
    const a = await seedSandbox({ bridgeUrl: SENTINEL_BRIDGE });
    const b = await seedSandbox({ bridgeUrl: SENTINEL_BRIDGE });
    const c = await seedSandbox({ bridgeUrl: SENTINEL_BRIDGE });

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res).toEqual({ scanned: 0, enqueued: 0 });
    for (const id of [a, b, c]) {
      expect(await snapshotJobsFor(id)).toHaveLength(0);
    }
  });
});

describe("enqueueScheduledBackups — eligibility predicate", () => {
  test("non-running rows are excluded even with a reachable bridge", async () => {
    const running = await seedSandbox({ status: "running" });
    const sleeping = await seedSandbox({ status: "sleeping" });
    const pending = await seedSandbox({ status: "pending" });

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res).toEqual({ scanned: 1, enqueued: 1 });
    expect(await snapshotJobsFor(running)).toHaveLength(1);
    expect(await snapshotJobsFor(sleeping)).toHaveLength(0);
    expect(await snapshotJobsFor(pending)).toHaveLength(0);
  });

  test("warm-pool rows (pool_status set) are excluded — no user state to back up", async () => {
    const owned = await seedSandbox({ poolStatus: null });
    const warm = await seedSandbox({ poolStatus: "ready" });

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res).toEqual({ scanned: 1, enqueued: 1 });
    expect(await snapshotJobsFor(owned)).toHaveLength(1);
    expect(await snapshotJobsFor(warm)).toHaveLength(0);
  });

  test("rows with no bridge_url are excluded — nothing live to snapshot", async () => {
    const bridged = await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });
    const bridgeless = await seedSandbox({ bridgeUrl: null });

    const res = await provisioningJobService.enqueueScheduledBackups();

    expect(res).toEqual({ scanned: 1, enqueued: 1 });
    expect(await snapshotJobsFor(bridged)).toHaveLength(1);
    expect(await snapshotJobsFor(bridgeless)).toHaveLength(0);
  });

  test("only rows past the backup cutoff are due: never-backed-up and stale qualify, fresh does not", async () => {
    const minIntervalMs = 6 * 60 * 60 * 1000; // 6h, the production default
    const stale = new Date(Date.now() - minIntervalMs - 60_000);
    const fresh = new Date(Date.now() - 60_000);

    const neverBackedUp = await seedSandbox({ lastBackupAt: null });
    const staleBackup = await seedSandbox({ lastBackupAt: stale });
    const freshBackup = await seedSandbox({ lastBackupAt: fresh });

    const res = await provisioningJobService.enqueueScheduledBackups({ minIntervalMs });

    expect(res).toEqual({ scanned: 2, enqueued: 2 });
    expect(await snapshotJobsFor(neverBackedUp)).toHaveLength(1);
    expect(await snapshotJobsFor(staleBackup)).toHaveLength(1);
    expect(await snapshotJobsFor(freshBackup)).toHaveLength(0);
  });

  test("maxAgents caps how many due rows are scanned in a single tick", async () => {
    await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });
    await seedSandbox({ bridgeUrl: OTHER_REACHABLE_BRIDGE });
    await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });

    const res = await provisioningJobService.enqueueScheduledBackups({ maxAgents: 2 });

    // The LIMIT is applied in SQL, so `scanned` reflects the cap, not the fleet.
    expect(res.scanned).toBe(2);
    expect(res.enqueued).toBe(2);
    const total = await dbWrite.select().from(jobs).where(eq(jobs.type, "agent_snapshot"));
    expect(total).toHaveLength(2);
  });
});

describe("enqueueScheduledBackups — enqueue behavior", () => {
  test("a second tick reuses the still-pending snapshot job rather than duplicating it", async () => {
    const agentId = await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });

    const first = await provisioningJobService.enqueueScheduledBackups();
    expect(first).toEqual({ scanned: 1, enqueued: 1 });

    // The row is still due (last_backup_at unchanged) and the snapshot job is
    // still pending, so in-flight idempotency must reuse it — one job row total.
    const second = await provisioningJobService.enqueueScheduledBackups();
    expect(second).toEqual({ scanned: 1, enqueued: 1 });

    expect(await snapshotJobsFor(agentId)).toHaveLength(1);
  });

  test("a per-row enqueue failure is caught: scanned counts the row, enqueued does not, the scan finishes", async () => {
    const failing = await seedSandbox({ bridgeUrl: REACHABLE_BRIDGE });
    const succeeding = await seedSandbox({ bridgeUrl: OTHER_REACHABLE_BRIDGE });

    // Force the downstream enqueue to throw for the first agent only; the scan's
    // per-row try/catch must swallow it, keep `enqueued` accurate, and still
    // process the remaining due row.
    const spy = spyOn(provisioningJobService, "enqueueAgentSnapshotOnce").mockImplementation(
      (async (params: { agentId: string }) => {
        if (params.agentId === failing) {
          throw new Error("snapshot enqueue boom");
        }
        return { created: true, job: { id: "ok" } } as never;
      }) as never,
    );
    try {
      const res = await provisioningJobService.enqueueScheduledBackups();
      expect(res.scanned).toBe(2);
      expect(res.enqueued).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
      const succeedingCall = spy.mock.calls.find(
        (c) => (c[0] as { agentId?: string })?.agentId === succeeding,
      );
      expect(succeedingCall).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Enqueue side of the same service, driven against the real PGlite so the
 * shared `enqueueLifecycleJob` transaction (advisory lock, sandbox read,
 * in-flight idempotency, row insert) and every per-type wrapper's job-data
 * shaping actually run. The scheduled-backup scan above only exercises the
 * snapshot enqueue; these cover the lifecycle enqueue surface the route layer
 * calls into, so a regression in the job-data record shape or the reuse
 * predicate is a red test rather than a silent bad row on the queue.
 */
describe("enqueueAgent*Once — real lifecycle-job inserts", () => {
  async function seedAgent(): Promise<{ agentId: string; orgId: string; userId: string }> {
    const { orgId, userId } = await seedOwner();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: orgId,
        user_id: userId,
        agent_name: uniq("agent"),
        status: "running" as never,
        bridge_url: REACHABLE_BRIDGE,
      })
      .returning();
    return { agentId: sandbox.id, orgId, userId };
  }

  async function jobsOfType(
    agentId: string,
    type: string,
  ): Promise<Array<Record<string, unknown>>> {
    return (await dbWrite
      .select()
      .from(jobs)
      .where(and(eq(jobs.agent_id, agentId), eq(jobs.type, type as never)))) as Array<
      Record<string, unknown>
    >;
  }

  test("provision enqueues a single pending agent_provision job and reuses it on a second call", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const first = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId,
      organizationId: orgId,
      userId,
      agentName: "prov-agent",
    });
    expect(first.created).toBe(true);
    expect(first.job.type).toBe(JOB_TYPES.AGENT_PROVISION);
    expect(first.job.status).toBe("pending");

    // Second enqueue while the first is still pending reuses it (idempotent
    // enqueueLifecycleJob) rather than queuing a duplicate provision.
    const second = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId,
      organizationId: orgId,
      userId,
      agentName: "prov-agent",
    });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_PROVISION)).toHaveLength(1);
  });

  test("the enqueueAgentProvision convenience wrapper returns the queued job", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const job = await provisioningJobService.enqueueAgentProvision({
      agentId,
      organizationId: orgId,
      userId,
      agentName: "prov-agent",
    });
    expect(job.type).toBe(JOB_TYPES.AGENT_PROVISION);
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_PROVISION)).toHaveLength(1);
  });

  test("suspend/resume/sleep/restart each enqueue their own pending job", async () => {
    const cases: Array<{
      type: string;
      call: (a: { agentId: string; organizationId: string; userId: string }) => Promise<unknown>;
    }> = [
      {
        type: JOB_TYPES.AGENT_SUSPEND,
        call: (p) => provisioningJobService.enqueueAgentSuspendOnce(p),
      },
      {
        type: JOB_TYPES.AGENT_RESUME,
        call: (p) => provisioningJobService.enqueueAgentResumeOnce(p),
      },
      { type: JOB_TYPES.AGENT_SLEEP, call: (p) => provisioningJobService.enqueueAgentSleepOnce(p) },
      {
        type: JOB_TYPES.AGENT_RESTART,
        call: (p) => provisioningJobService.enqueueAgentRestartOnce(p),
      },
    ];
    for (const c of cases) {
      const { agentId, orgId, userId } = await seedAgent();
      const res = (await c.call({ agentId, organizationId: orgId, userId })) as {
        created: boolean;
        job: { type: string };
      };
      expect(res.created).toBe(true);
      expect(res.job.type).toBe(c.type);
      expect(await jobsOfType(agentId, c.type)).toHaveLength(1);
    }
  });

  test("wake echoes the applied restore params and records them on the job data", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const res = await provisioningJobService.enqueueAgentWakeOnce({
      agentId,
      organizationId: orgId,
      userId,
      restoreBackupId: "backup-xyz",
      forceFreshBoot: false,
    });
    expect(res.created).toBe(true);
    expect(res.job.type).toBe(JOB_TYPES.AGENT_WAKE);
    expect(res.appliedRestoreBackupId).toBe("backup-xyz");
    expect(res.appliedForceFreshBoot).toBe(false);
    expect((res.job.data as { restoreBackupId?: string }).restoreBackupId).toBe("backup-xyz");
  });

  test("upgrade and downgrade carry their image/digest job data", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const up = await provisioningJobService.enqueueAgentUpgradeOnce({
      agentId,
      organizationId: orgId,
      userId,
      dockerImage: "eliza/agent",
      fromDigest: "sha256:old",
      toDigest: "sha256:new",
    });
    expect(up.created).toBe(true);
    expect((up.job.data as { toDigest?: string }).toDigest).toBe("sha256:new");

    const down = await provisioningJobService.enqueueAgentDowngradeOnce({
      agentId,
      organizationId: orgId,
      userId,
      dockerImage: "eliza/agent",
      fromDigest: "sha256:new",
    });
    expect(down.created).toBe(true);
    expect(down.job.type).toBe(JOB_TYPES.AGENT_DOWNGRADE);
    expect((down.job.data as { fromDigest?: string }).fromDigest).toBe("sha256:new");
  });

  test("logs enqueues with the requested tail and dedupes on the tail predicate", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const first = await provisioningJobService.enqueueAgentLogsOnce({
      agentId,
      organizationId: orgId,
      userId,
      tail: 250,
    });
    expect(first.created).toBe(true);
    expect((first.job.data as { tail?: number }).tail).toBe(250);
    // Same tail while in-flight → reuse.
    const same = await provisioningJobService.enqueueAgentLogsOnce({
      agentId,
      organizationId: orgId,
      userId,
      tail: 250,
    });
    expect(same.created).toBe(false);
    expect(same.job.id).toBe(first.job.id);
  });

  test("each message turn is a fresh job (nonce idempotency never reuses)", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    const a = await provisioningJobService.enqueueAgentMessage({
      agentId,
      organizationId: orgId,
      userId,
      text: "hello",
    });
    const b = await provisioningJobService.enqueueAgentMessage({
      agentId,
      organizationId: orgId,
      userId,
      text: "hello again",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.job.id).not.toBe(b.job.id);
    expect(await jobsOfType(agentId, JOB_TYPES.AGENT_MESSAGE)).toHaveLength(2);
  });

  test("delete flips the sandbox to deletion_pending and cancels other in-flight jobs", async () => {
    const { agentId, orgId, userId } = await seedAgent();
    // A queued suspend that the delete must supersede.
    await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: orgId,
      userId,
    });

    const del = await provisioningJobService.enqueueAgentDeleteOnce({
      agentId,
      organizationId: orgId,
      userId,
    });
    expect(del.created).toBe(true);
    expect(del.job.type).toBe(JOB_TYPES.AGENT_DELETE);

    const [sandbox] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, agentId));
    expect(sandbox?.status).toBe("deletion_pending");

    // The superseded suspend is cancelled (delete wins), the delete itself is not.
    const suspendRows = await jobsOfType(agentId, JOB_TYPES.AGENT_SUSPEND);
    expect(suspendRows[0]?.status).toBe("cancelled");
    const deleteRows = await jobsOfType(agentId, JOB_TYPES.AGENT_DELETE);
    expect(deleteRows[0]?.status).toBe("pending");
  });

  test("enqueue against a missing agent throws Agent not found", async () => {
    const { orgId, userId } = await seedOwner();
    await expect(
      provisioningJobService.enqueueAgentSuspendOnce({
        agentId: "00000000-0000-4000-8000-000000000000",
        organizationId: orgId,
        userId,
      }),
    ).rejects.toThrow("Agent not found");
  });
});
