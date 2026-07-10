/**
 * Drives the REAL job-execution dispatch of ProvisioningJobService end-to-end:
 * `processPendingJobs` → `processJobType` → `executeJob` → the per-type
 * `executeAgent*` handler, plus the failure path's `buildPermanentFailureWriteback`
 * construction. Every job type's success AND failure branch is exercised so the
 * dispatch table, the per-handler result-record shaping, and the terminal-vs-retry
 * disposition are all covered by real code, not asserted against a stand-in.
 *
 * The only stubs are the two genuine boundaries the daemon dispatch sits on:
 * `jobsRepository` (the Postgres job store) and `elizaSandboxService` (the
 * transport that SSHes the Hetzner cores / calls the container bridge). Mirrors
 * the harness in `provisioning-jobs-delete-lifecycle.test.ts`; no DB is touched,
 * so this file is process-isolated and safe to run alongside the DB-backed
 * suites in the same `bun test` invocation.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { jobsRepository } from "../../db/repositories/jobs";
import type { Job } from "../../db/schemas/jobs";
import { elizaSandboxService } from "./eliza-sandbox";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import { provisioningJobService } from "./provisioning-jobs";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
const USER = "33333333-3333-4333-8333-333333333333";

function makeJob(
  type: string,
  extraData: Record<string, unknown> = {},
  overrides: Partial<Job> = {},
): Job {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: "44444444-4444-4444-8444-444444444444",
    type: type as Job["type"],
    status: "in_progress",
    data: {
      agentId: AGENT,
      organizationId: ORG,
      userId: USER,
      agentName: "Test Agent",
      ...extraData,
    },
    data_storage: "inline",
    data_key: null,
    agent_id: AGENT,
    character_id: null,
    result: null,
    result_storage: "inline",
    result_key: null,
    error: null,
    error_storage: "inline",
    error_key: null,
    attempts: 1,
    max_attempts: 3,
    organization_id: ORG,
    user_id: USER,
    api_key_id: null,
    generation_id: null,
    webhook_url: null,
    webhook_status: null,
    estimated_completion_at: null,
    scheduled_for: now,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * Claim exactly one crafted job of `type` and stub the job-store writes so the
 * real dispatch runs against controlled repository responses. `incrementAttempt`
 * resolves undefined (attempts not yet exhausted) so the failure path stops after
 * building — but not invoking — the permanent-failure writeback, matching the
 * daemon's mid-retry behavior.
 */
function harness(job: Job) {
  const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockImplementation(
    async (f: { type: string }) => (f.type === job.type ? [job] : []),
  );
  const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
  const updateStatusSpy = spyOn(jobsRepository, "updateStatus").mockResolvedValue(undefined);
  const updateSpy = spyOn(jobsRepository, "update").mockResolvedValue(undefined as never);
  const incrementSpy = spyOn(jobsRepository, "incrementAttempt").mockResolvedValue(undefined);
  const retryLaterSpy = spyOn(
    jobsRepository,
    "retryLaterWithoutIncrementingAttempts",
  ).mockResolvedValue(undefined);
  return { job, claimSpy, recoverSpy, updateStatusSpy, updateSpy, incrementSpy, retryLaterSpy };
}

const serviceSpies: Array<{ mockRestore: () => void }> = [];
function stub<M extends keyof typeof elizaSandboxService>(method: M, value: unknown) {
  const spy = spyOn(elizaSandboxService, method).mockResolvedValue(value as never);
  serviceSpies.push(spy);
  return spy;
}

afterEach(() => {
  for (const s of serviceSpies.splice(0)) s.mockRestore();
});

async function run(type: string) {
  return provisioningJobService.processPendingJobs(1, {
    jobTypes: [type as ProvisioningJobType],
  });
}

function completedCall(ctx: ReturnType<typeof harness>) {
  return ctx.updateStatusSpy.mock.calls.find((c) => c[1] === "completed");
}

/**
 * One row per agent job type: the crafted job.data, the transport method the
 * handler delegates to, and a representative SUCCESS payload. Failure is a
 * uniform `{ success: false, error }` (bridge/message uses its own shape below).
 */
const AGENT_ARMS: Array<{
  name: string;
  type: ProvisioningJobType;
  data: Record<string, unknown>;
  method: keyof typeof elizaSandboxService;
  success: Record<string, unknown>;
}> = [
  {
    name: "provision",
    type: JOB_TYPES.AGENT_PROVISION,
    data: {},
    method: "provision",
    success: {
      success: true,
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "running" },
      bridgeUrl: "http://10.0.0.5:8080",
      healthUrl: "http://10.0.0.5:8081",
    },
  },
  {
    name: "delete",
    type: JOB_TYPES.AGENT_DELETE,
    data: {},
    method: "executeDeletion",
    success: { success: true, containerStopped: true },
  },
  {
    name: "suspend",
    type: JOB_TYPES.AGENT_SUSPEND,
    data: {},
    method: "executeSuspend",
    success: { success: true, containerStopped: true },
  },
  {
    name: "resume",
    type: JOB_TYPES.AGENT_RESUME,
    data: {},
    method: "executeResume",
    success: { success: true, containerStarted: true, reprovisioned: false },
  },
  {
    name: "sleep",
    type: JOB_TYPES.AGENT_SLEEP,
    data: {},
    method: "executeSleep",
    success: { success: true, containerRemoved: true, backupId: "backup-sleep" },
  },
  {
    name: "wake",
    type: JOB_TYPES.AGENT_WAKE,
    data: { restoreBackupId: "backup-sleep", forceFreshBoot: false },
    method: "executeWake",
    success: {
      success: true,
      reprovisioned: true,
      restoredBackupId: "backup-sleep",
      freshBoot: false,
    },
  },
  {
    name: "restart",
    type: JOB_TYPES.AGENT_RESTART,
    data: {},
    method: "executeRestart",
    success: {
      success: true,
      containerStopped: true,
      containerStarted: true,
      bridgeUrl: "http://10.0.0.5:8080",
      healthUrl: "http://10.0.0.5:8081",
    },
  },
  {
    name: "upgrade",
    type: JOB_TYPES.AGENT_UPGRADE,
    data: { dockerImage: "eliza/agent", fromDigest: "sha256:old", toDigest: "sha256:new" },
    method: "executeUpgrade",
    success: {
      success: true,
      oldNodeId: "node-a",
      oldContainerName: "c-old",
      newNodeId: "node-b",
      newContainerName: "c-new",
      newDigest: "sha256:new",
    },
  },
  {
    name: "downgrade",
    type: JOB_TYPES.AGENT_DOWNGRADE,
    data: { dockerImage: "eliza/agent", fromDigest: "sha256:cur" },
    method: "executeDowngrade",
    success: {
      success: true,
      oldNodeId: "node-b",
      oldContainerName: "c-new",
      newNodeId: "node-a",
      newContainerName: "c-old",
      newDigest: "sha256:old",
    },
  },
  {
    name: "logs",
    type: JOB_TYPES.AGENT_LOGS,
    data: { tail: 100 },
    method: "executeLogs",
    success: { success: true, status: "ok", logs: "line-1\nline-2", message: "collected" },
  },
  {
    name: "snapshot",
    type: JOB_TYPES.AGENT_SNAPSHOT,
    data: { snapshotType: "manual" },
    method: "executeSnapshot",
    success: {
      success: true,
      backup: {
        id: "backup-1",
        snapshot_type: "manual",
        size_bytes: 2048,
        created_at: new Date("2026-06-20T00:00:00.000Z").toISOString(),
      },
    },
  },
];

describe("executeJob dispatch — success path per job type marks the job completed", () => {
  for (const arm of AGENT_ARMS) {
    test(`${arm.name}: transport success → completed with a result record, no attempt burned`, async () => {
      const ctx = harness(makeJob(arm.type, arm.data));
      stub(arm.method, arm.success);
      try {
        const res = await run(arm.type);
        expect(res.claimed).toBe(1);
        expect(res.succeeded).toBe(1);
        expect(res.failed).toBe(0);
        expect(res.retried).toBe(0);
        const completed = completedCall(ctx);
        expect(completed).toBeDefined();
        expect(completed?.[2]?.result).toBeTruthy();
        expect(completed?.[2]?.completed_at).toBeInstanceOf(Date);
        expect(ctx.incrementSpy).not.toHaveBeenCalled();
      } finally {
        ctx.claimSpy.mockRestore();
        ctx.recoverSpy.mockRestore();
        ctx.updateStatusSpy.mockRestore();
        ctx.updateSpy.mockRestore();
        ctx.incrementSpy.mockRestore();
        ctx.retryLaterSpy.mockRestore();
      }
    });
  }

  test("message: bridge reply is stored on the job result and completes", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_MESSAGE, { text: "hello", nonce: "n-1" }));
    const bridgeSpy = spyOn(elizaSandboxService, "bridge").mockResolvedValue({
      jsonrpc: "2.0",
      id: null,
      result: { text: "hi there" },
    } as never);
    try {
      const res = await run(JOB_TYPES.AGENT_MESSAGE);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      const completed = completedCall(ctx);
      expect(completed?.[2]?.result).toMatchObject({ text: "hi there" });
    } finally {
      bridgeSpy.mockRestore();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });
});

describe("executeJob dispatch — failure path per job type retries (increments attempt)", () => {
  for (const arm of AGENT_ARMS) {
    test(`${arm.name}: transport failure → not completed, one attempt burned`, async () => {
      const ctx = harness(makeJob(arm.type, arm.data));
      stub(arm.method, { success: false, error: `${arm.name} transport boom` });
      try {
        const res = await run(arm.type);
        expect(res.claimed).toBe(1);
        expect(res.succeeded).toBe(0);
        expect(res.failed).toBe(1);
        expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
        expect(ctx.incrementSpy.mock.calls[0]?.[0]).toBe(ctx.job.id);
        expect(completedCall(ctx)).toBeUndefined();
      } finally {
        ctx.claimSpy.mockRestore();
        ctx.recoverSpy.mockRestore();
        ctx.updateStatusSpy.mockRestore();
        ctx.updateSpy.mockRestore();
        ctx.incrementSpy.mockRestore();
        ctx.retryLaterSpy.mockRestore();
      }
    });
  }

  test("message: bridge error is stored on the job result and the job fails", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_MESSAGE, { text: "hello", nonce: "n-1" }));
    const bridgeSpy = spyOn(elizaSandboxService, "bridge").mockResolvedValue({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "bridge unreachable" },
    } as never);
    try {
      const res = await run(JOB_TYPES.AGENT_MESSAGE);
      expect(res.failed).toBe(1);
      expect(ctx.updateSpy).toHaveBeenCalledWith(
        ctx.job.id,
        expect.objectContaining({
          result: expect.objectContaining({ error: "bridge unreachable" }),
        }),
      );
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
    } finally {
      bridgeSpy.mockRestore();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });
});

describe("executeJob dispatch — type-specific disposition rules", () => {
  test("agent_provision retryable transport → requeued without burning an attempt", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_PROVISION));
    stub("provision", {
      success: false,
      retryable: true,
      error: "readiness probe transport_unresolved",
      sandboxRecord: { id: AGENT, organization_id: ORG, user_id: USER, status: "provisioning" },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_PROVISION);
      expect(res.retried).toBe(1);
      expect(res.failed).toBe(0);
      expect(ctx.retryLaterSpy).toHaveBeenCalledTimes(1);
      expect(ctx.retryLaterSpy.mock.calls[0]?.[1]).toBe("readiness probe transport_unresolved");
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("auto snapshot of a stopped agent → completed-as-skipped, no retry", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_SNAPSHOT, { snapshotType: "auto" }));
    stub("executeSnapshot", { success: false, error: "Sandbox is not running" });
    try {
      const res = await run(JOB_TYPES.AGENT_SNAPSHOT);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      expect(completedCall(ctx)?.[2]?.result).toMatchObject({
        skipped: true,
        reason: "Sandbox is not running",
      });
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_wake integrity-gate refusal → fails and preserves the sleeping row (no writeback)", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_WAKE, { restoreBackupId: "b1" }));
    stub("executeWake", {
      success: false,
      error: "restore integrity check failed",
      integrityFailure: {
        backupId: "b1",
        kind: "digest_mismatch",
        message: "backup digest does not match",
      },
    });
    try {
      const res = await run(JOB_TYPES.AGENT_WAKE);
      expect(res.failed).toBe(1);
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
      // AGENT_WAKE has no permanent-failure writeback callback.
      expect(ctx.incrementSpy.mock.calls[0]?.[3]).toBeUndefined();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("permanent-failure writeback is built for provision (dependent row flip) but not for suspend", async () => {
    const provCtx = harness(makeJob(JOB_TYPES.AGENT_PROVISION));
    stub("provision", { success: false, error: "down", sandboxRecord: { status: "error" } });
    try {
      await run(JOB_TYPES.AGENT_PROVISION);
      // AGENT_PROVISION supplies an onFailedInTx callback (arg 4) so the sandbox
      // row can flip to `error` atomically with the job's terminal write.
      expect(typeof provCtx.incrementSpy.mock.calls[0]?.[3]).toBe("function");
    } finally {
      provCtx.claimSpy.mockRestore();
      provCtx.recoverSpy.mockRestore();
      provCtx.updateStatusSpy.mockRestore();
      provCtx.updateSpy.mockRestore();
      provCtx.incrementSpy.mockRestore();
      provCtx.retryLaterSpy.mockRestore();
    }

    const suspendCtx = harness(makeJob(JOB_TYPES.AGENT_SUSPEND));
    stub("executeSuspend", { success: false, error: "down" });
    try {
      await run(JOB_TYPES.AGENT_SUSPEND);
      // AGENT_SUSPEND has no dependent row to flip → no writeback callback.
      expect(suspendCtx.incrementSpy.mock.calls[0]?.[3]).toBeUndefined();
    } finally {
      suspendCtx.claimSpy.mockRestore();
      suspendCtx.recoverSpy.mockRestore();
      suspendCtx.updateStatusSpy.mockRestore();
      suspendCtx.updateSpy.mockRestore();
      suspendCtx.incrementSpy.mockRestore();
      suspendCtx.retryLaterSpy.mockRestore();
    }
  });

  test("agent_upgrade permanent failure classified genuinely-dead builds a terminal writeback", async () => {
    const ctx = harness(
      makeJob(JOB_TYPES.AGENT_UPGRADE, {
        dockerImage: "eliza/agent",
        fromDigest: "sha256:old",
        toDigest: "sha256:new",
      }),
    );
    // rolledBack:false → executeAgentUpgrade throws UpgradeFailedError({rolledBack:false}),
    // and buildPermanentFailureWriteback returns the terminal `status:error` branch.
    stub("executeUpgrade", { success: false, error: "agent not serving", rolledBack: false });
    try {
      const res = await run(JOB_TYPES.AGENT_UPGRADE);
      expect(res.failed).toBe(1);
      expect(typeof ctx.incrementSpy.mock.calls[0]?.[3]).toBe("function");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("agent-not-found from any lifecycle call → terminal no-op, attempt not burned", async () => {
    const ctx = harness(makeJob(JOB_TYPES.AGENT_RESTART));
    stub("executeRestart", { success: false, error: "Agent not found" });
    try {
      const res = await run(JOB_TYPES.AGENT_RESTART);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      expect(completedCall(ctx)?.[2]?.result).toMatchObject({
        skipped: true,
        reason: "Agent not found",
      });
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("organization-id mismatch between payload and column fails before any transport call", async () => {
    const ctx = harness(
      makeJob(JOB_TYPES.AGENT_SUSPEND, { organizationId: "99999999-9999-4999-8999-999999999999" }),
    );
    const svcSpy = spyOn(elizaSandboxService, "executeSuspend").mockResolvedValue({
      success: true,
    } as never);
    try {
      const res = await run(JOB_TYPES.AGENT_SUSPEND);
      expect(res.failed).toBe(1);
      // The guard throws before delegating to the transport.
      expect(svcSpy).not.toHaveBeenCalled();
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
    } finally {
      svcSpy.mockRestore();
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });

  test("an unrecognized job type hits the dispatch default and fails the job", async () => {
    const ctx = harness(makeJob("agent_teleport"));
    try {
      const res = await run("agent_teleport");
      expect(res.claimed).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.errors[0]?.error).toContain("Unknown job type");
    } finally {
      ctx.claimSpy.mockRestore();
      ctx.recoverSpy.mockRestore();
      ctx.updateStatusSpy.mockRestore();
      ctx.updateSpy.mockRestore();
      ctx.incrementSpy.mockRestore();
      ctx.retryLaterSpy.mockRestore();
    }
  });
});
