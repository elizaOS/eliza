/**
 * Delete-lifecycle hardening for ProvisioningJobService.
 *
 * Covers the daemon-side handler policy that keeps a deleted/idle agent from
 * masking real failures:
 *   - "Agent not found" from any lifecycle service call resolves the job as a
 *     terminal completed no-op (no retry-to-failed). A delete that landed first
 *     means the suspend/resume/restart/snapshot has nothing left to do.
 *   - An `auto` snapshot of a non-running agent ("Sandbox is not running") is a
 *     terminal SKIP (completed, not failed) — these were 40/45 hard-failures.
 *   - A `manual` snapshot of a non-running agent still errors (the user asked).
 *
 * Drives the real processPendingJobs loop with claimPendingJobs + the service
 * call spied, then asserts the job was marked completed (no-op/skip) vs the
 * error path (incrementAttempt). Pure spy-based, no DB.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import * as realHelpersNs from "../../db/helpers";
import { jobsRepository } from "../../db/repositories/jobs";
import type { Job } from "../../db/schemas/jobs";
import { elizaSandboxService, SNAPSHOT_ENDPOINT_UNSUPPORTED } from "./eliza-sandbox";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";

const realHelpers = { ...realHelpersNs };
const conflictQueryTx = {
  execute: async () => ({ rows: [] }),
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => [],
        }),
        limit: async () => [{ id: "44444444-4444-4444-8444-444444444444" }],
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        returning: async () => [{ id: AGENT }],
      }),
    }),
  }),
};
let suspendAuthorityRows: Array<{
  authorization: "user_request" | "billing_request";
  lifecycleRevision: number;
}> = [];
let suspendAuthoritySelectCount = 0;
let snapshotMarkerUpdateCount = 0;
const lifecycleDbWrite = {
  ...(realHelpers.dbWrite as unknown as Record<string, unknown>),
  select: () => {
    suspendAuthoritySelectCount += 1;
    return {
      from: () => ({
        where: () => ({
          limit: async () => suspendAuthorityRows,
        }),
      }),
    };
  },
  update: () => ({
    set: () => ({
      where: async () => {
        snapshotMarkerUpdateCount += 1;
        return [];
      },
    }),
  }),
  transaction: async <T>(fn: (tx: typeof conflictQueryTx) => Promise<T>): Promise<T> =>
    fn(conflictQueryTx),
};
let provisioningJobService: typeof import("./provisioning-jobs").provisioningJobService;
let resolveAgentSuspendAuthorization: typeof import("./provisioning-jobs").resolveAgentSuspendAuthorization;

beforeAll(async () => {
  mock.module("../../db/helpers", () => ({
    ...realHelpers,
    dbWrite: lifecycleDbWrite,
  }));
  const module = await import("./provisioning-jobs.ts?delete-lifecycle-harness");
  provisioningJobService = new module.ProvisioningJobService({
    acquireProviderAdmission: async () => true,
    releaseProviderAdmission: async () => undefined,
  });
  resolveAgentSuspendAuthorization = module.resolveAgentSuspendAuthorization;
});

afterAll(() => {
  mock.module("../../db/helpers", () => realHelpers);
});

beforeEach(() => {
  suspendAuthorityRows = [];
  suspendAuthoritySelectCount = 0;
  snapshotMarkerUpdateCount = 0;
});

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
const USER = "33333333-3333-4333-8333-333333333333";
const EMPTY_RECOVERY = {
  scanned: 0,
  retried: 0,
  permanentlyFailed: 0,
  unchanged: 0,
  failures: [],
};

function makeJob(type: ProvisioningJobType, extraData: Record<string, unknown> = {}): Job {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: "44444444-4444-4444-8444-444444444444",
    type,
    status: "in_progress",
    data: {
      agentId: AGENT,
      organizationId: ORG,
      userId: USER,
      agentName: "Test Agent",
      ...(type === JOB_TYPES.AGENT_SUSPEND ? { authorization: "user_request" } : {}),
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
    retryable_requeues: 0,
    execution_generation: "55555555-5555-4555-8555-555555555555",
    execution_quiesced_at: null,
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
  };
}

/**
 * Run processPendingJobs for exactly one job type, claiming a single crafted
 * job. Returns the spies so the caller can assert terminal disposition.
 */
function withClaimedJob(type: ProvisioningJobType, extraData: Record<string, unknown> = {}) {
  const job = makeJob(type, extraData);
  if (type === JOB_TYPES.AGENT_SUSPEND) {
    suspendAuthorityRows = [
      {
        authorization:
          job.data.authorization === "billing_request" ? "billing_request" : "user_request",
        lifecycleRevision:
          typeof job.data.lifecycleRevision === "number" ? job.data.lifecycleRevision : 0,
      },
    ];
  }
  // These handler-policy cases model a target disappearing only after a
  // successful common preflight. Missing-target rejection itself is exercised
  // against real PGlite state in provisioning-jobs-container-tier-guard.
  const preflightSpy = spyOn(
    provisioningJobService as unknown as {
      assertNoConflictingLifecycleExecution(job: Job): Promise<void>;
    },
    "assertNoConflictingLifecycleExecution",
  ).mockResolvedValue(undefined);
  const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockImplementation(
    async (f: { type: string }) => (f.type === type ? [job] : []),
  );
  const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(EMPTY_RECOVERY);
  const assertLeaseSpy = spyOn(jobsRepository, "assertExecutionLease").mockResolvedValue(undefined);
  const updateStatusSpy = spyOn(jobsRepository, "settleExecution").mockResolvedValue(undefined);
  const updateSpy = spyOn(jobsRepository, "updateForExecution").mockImplementation(
    async (claimedJob, updates) => ({ ...claimedJob, ...updates }),
  );
  const incrementSpy = spyOn(jobsRepository, "incrementAttempt").mockResolvedValue(undefined);
  const retryLaterSpy = spyOn(
    jobsRepository,
    "retryLaterWithoutIncrementingAttempts",
  ).mockImplementation(async (retrySnapshot) => ({
    ...retrySnapshot,
    status: "pending",
    retryable_requeues: retrySnapshot.retryable_requeues + 1,
  }));
  return {
    job,
    claimSpy,
    recoverSpy,
    assertLeaseSpy,
    updateStatusSpy,
    updateSpy,
    incrementSpy,
    retryLaterSpy,
    restore() {
      preflightSpy.mockRestore();
      claimSpy.mockRestore();
      recoverSpy.mockRestore();
      assertLeaseSpy.mockRestore();
      updateStatusSpy.mockRestore();
      updateSpy.mockRestore();
      incrementSpy.mockRestore();
      retryLaterSpy.mockRestore();
    },
  };
}

/** #16639: these suites exercise the snapshot EXECUTION path, which the
 *  fail-closed lane belt short-circuits unless the gate is exactly enabled.
 *  Armed per-suite with restore (never module-wide — composed/shared-process
 *  runs share the env); the gate itself is pinned in
 *  provisioning-jobs-snapshot-gate.test.ts. */
function armSnapshotGate(): () => void {
  const prev = process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
  process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = "true";
  return () => {
    if (prev === undefined) delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
    else process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = prev;
  };
}

describe("ProvisioningJobService — suspend authority compatibility", () => {
  test("legacy user-request fallback happens only after a durable-intent miss", async () => {
    const job = makeJob(JOB_TYPES.AGENT_SUSPEND);

    expect(await resolveAgentSuspendAuthorization(job)).toBe("user_request");
    expect(suspendAuthoritySelectCount).toBe(1);
  });
});

describe("ProvisioningJobService — Agent-not-found is a terminal no-op", () => {
  const cases: Array<{
    name: string;
    type: ProvisioningJobType;
    method: keyof typeof elizaSandboxService;
  }> = [
    { name: "suspend", type: JOB_TYPES.AGENT_SUSPEND, method: "executeSuspend" },
    { name: "resume", type: JOB_TYPES.AGENT_RESUME, method: "executeResume" },
    { name: "sleep", type: JOB_TYPES.AGENT_SLEEP, method: "executeSleep" },
    { name: "wake", type: JOB_TYPES.AGENT_WAKE, method: "executeWake" },
    { name: "restart", type: JOB_TYPES.AGENT_RESTART, method: "executeRestart" },
    { name: "snapshot", type: JOB_TYPES.AGENT_SNAPSHOT, method: "executeSnapshot" },
  ];

  for (const c of cases) {
    test(`${c.name}: completes (no-op) and never increments attempts`, async () => {
      const ctx = withClaimedJob(
        c.type,
        c.type === JOB_TYPES.AGENT_SNAPSHOT ? { snapshotType: "auto" } : {},
      );
      const svcSpy = spyOn(elizaSandboxService, c.method).mockResolvedValue({
        success: false,
        error: "Agent not found",
      } as never);
      const disarmGate = c.type === JOB_TYPES.AGENT_SNAPSHOT ? armSnapshotGate() : () => {};
      try {
        const res = await provisioningJobService.processPendingJobs(1, { jobTypes: [c.type] });
        expect(res.claimed).toBe(1);
        expect(res.errors).toEqual([]);
        expect(res.succeeded).toBe(1);
        expect(res.failed).toBe(0);
        // Marked completed as a no-op…
        const completed = ctx.updateStatusSpy.mock.calls.find((call) => call[1] === "completed");
        expect(completed).toBeDefined();
        expect(completed?.[2]?.result).toMatchObject({ skipped: true, reason: "Agent not found" });
        // …and NEVER counted as a failed attempt.
        expect(ctx.incrementSpy).not.toHaveBeenCalled();
      } finally {
        disarmGate();
        svcSpy.mockRestore();
        ctx.restore();
      }
    });
  }
});

describe("ProvisioningJobService — retryable readiness transport does not burn attempts", () => {
  test("agent_provision retryable false-negative is requeued without terminal failure", async () => {
    const ctx = withClaimedJob(JOB_TYPES.AGENT_PROVISION);
    const svcSpy = spyOn(elizaSandboxService, "provision").mockResolvedValue({
      success: false,
      retryable: true,
      error: "readiness probe transport_unresolved",
      sandboxRecord: {
        id: AGENT,
        organization_id: ORG,
        user_id: USER,
        status: "provisioning",
      },
    } as never);

    try {
      const res = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_PROVISION],
      });

      expect(res.claimed).toBe(1);
      expect(res.succeeded).toBe(0);
      expect(res.retried).toBe(1);
      expect(res.failed).toBe(0);
      expect(ctx.updateSpy).toHaveBeenCalledWith(
        ctx.job,
        expect.objectContaining({
          result: expect.objectContaining({
            cloudAgentId: AGENT,
            status: "provisioning",
            error: "readiness probe transport_unresolved",
          }),
        }),
        expect.any(String),
      );
      expect(ctx.retryLaterSpy).toHaveBeenCalledTimes(1);
      expect(ctx.retryLaterSpy.mock.calls[0]?.[0]).toMatchObject({
        id: ctx.job.id,
        result: expect.objectContaining({ error: "readiness probe transport_unresolved" }),
      });
      expect(ctx.retryLaterSpy.mock.calls[0]?.[1]).toContain(
        "readiness probe transport_unresolved",
      );
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
      expect(ctx.updateStatusSpy).not.toHaveBeenCalledWith(ctx.job, "completed", expect.anything());
    } finally {
      svcSpy.mockRestore();
      ctx.restore();
    }
  });
});

describe("ProvisioningJobService — auto snapshot of an idle agent is a terminal SKIP", () => {
  // #16639: every case in this suite drives the gated snapshot lane.
  let disarmGate: () => void = () => {};
  beforeEach(() => {
    disarmGate = armSnapshotGate();
  });
  afterEach(() => {
    disarmGate();
  });

  test("auto + 'Sandbox is not running' → completed-as-skipped, no retry", async () => {
    const ctx = withClaimedJob(JOB_TYPES.AGENT_SNAPSHOT, { snapshotType: "auto" });
    const svcSpy = spyOn(elizaSandboxService, "executeSnapshot").mockResolvedValue({
      success: false,
      error: "Sandbox is not running",
    } as never);
    try {
      const res = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_SNAPSHOT],
      });
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      const completed = ctx.updateStatusSpy.mock.calls.find((call) => call[1] === "completed");
      expect(completed).toBeDefined();
      expect(completed?.[2]?.result).toMatchObject({
        skipped: true,
        reason: "Sandbox is not running",
      });
      expect(snapshotMarkerUpdateCount).toBe(1);
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      svcSpy.mockRestore();
      ctx.restore();
    }
  });

  test("auto + snapshot-endpoint-unsupported (V2 image 404) → completed-as-skipped, no retry", async () => {
    const ctx = withClaimedJob(JOB_TYPES.AGENT_SNAPSHOT, { snapshotType: "auto" });
    const svcSpy = spyOn(elizaSandboxService, "executeSnapshot").mockResolvedValue({
      success: false,
      error: SNAPSHOT_ENDPOINT_UNSUPPORTED,
    } as never);
    try {
      const res = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_SNAPSHOT],
      });
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
      const completed = ctx.updateStatusSpy.mock.calls.find((call) => call[1] === "completed");
      expect(completed).toBeDefined();
      expect(completed?.[2]?.result).toMatchObject({
        skipped: true,
        reason: SNAPSHOT_ENDPOINT_UNSUPPORTED,
      });
      expect(snapshotMarkerUpdateCount).toBe(1);
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      svcSpy.mockRestore();
      ctx.restore();
    }
  });

  test("manual + 'Sandbox is not running' → still errors (the user asked for it)", async () => {
    const ctx = withClaimedJob(JOB_TYPES.AGENT_SNAPSHOT, { snapshotType: "manual" });
    const svcSpy = spyOn(elizaSandboxService, "executeSnapshot").mockResolvedValue({
      success: false,
      error: "Sandbox is not running",
    } as never);
    try {
      const res = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_SNAPSHOT],
      });
      // The handler throws → counted failed → incrementAttempt runs.
      expect(res.failed).toBe(1);
      expect(res.succeeded).toBe(0);
      expect(snapshotMarkerUpdateCount).toBe(1);
      expect(ctx.incrementSpy).toHaveBeenCalledTimes(1);
      // It is NOT silently completed.
      const completed = ctx.updateStatusSpy.mock.calls.find((call) => call[1] === "completed");
      expect(completed).toBeUndefined();
    } finally {
      svcSpy.mockRestore();
      ctx.restore();
    }
  });
});
