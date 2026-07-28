// Exercises cloud API stuck provisioning sweep behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Wiring test for the cleanup-stuck-provisioning cron.
 *
 * The handler runs two scans on the write path: stuck-provisioning rows and
 * orphaned-`pending` rows (committed by createAgent but never enqueued). This
 * test pins their independent clocks: provisioning waits past the daemon's
 * cold-boot budget, while a pending row that never got a job keeps the shorter
 * recovery window.
 */

const markStuckProvisioningWithoutActiveJobAsError = mock(
  async (_cutoff: Date) => ({
    updated: [] as Array<{
      agentId: string;
      agentName: string | null;
      organizationId: string;
    }>,
    deferred: 0,
  }),
);
const markOrphanedPendingWithoutJobAsError = mock(async (_cutoff: Date) => ({
  updated: [
    {
      agentId: "sandbox-orphan-1",
      agentName: "orphaned-agent",
      organizationId: "org-1",
      createdAt: new Date("2026-06-14T00:00:00.000Z"),
    },
  ],
  deferred: 0,
}));

// verifyCronSecret returns null on success (auth passes), a Response otherwise.
const verifyCronSecret = mock((): Response | null => null);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    markStuckProvisioningWithoutActiveJobAsError,
    markOrphanedPendingWithoutJobAsError,
  },
}));

mock.module("@/lib/auth/cron", () => ({
  verifyCronSecret,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

const STUCK_PROVISIONING_THRESHOLD_MS = 20 * 60 * 1000;
const ORPHAN_PENDING_THRESHOLD_MS = 10 * 60 * 1000;

function postCron() {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: { "x-cron-secret": "cron-secret" },
    }),
    { CRON_SECRET: "cron-secret" },
  );
}

describe("cleanup-stuck-provisioning cron", () => {
  beforeEach(() => {
    markStuckProvisioningWithoutActiveJobAsError.mockClear();
    markOrphanedPendingWithoutJobAsError.mockClear();
    verifyCronSecret.mockClear();
    verifyCronSecret.mockReturnValue(null);
    markStuckProvisioningWithoutActiveJobAsError.mockResolvedValue({
      updated: [],
      deferred: 1,
    });
    markOrphanedPendingWithoutJobAsError.mockResolvedValue({
      updated: [
        {
          agentId: "sandbox-orphan-1",
          agentName: "orphaned-agent",
          organizationId: "org-1",
          createdAt: new Date("2026-06-14T00:00:00.000Z"),
        },
      ],
      deferred: 0,
    });
  });

  test("uses independent provisioning and orphan-pending cutoffs", async () => {
    const before = Date.now();
    const response = await postCron();
    const after = Date.now();

    expect(response.status).toBe(200);

    expect(markStuckProvisioningWithoutActiveJobAsError).toHaveBeenCalledTimes(
      1,
    );
    expect(markOrphanedPendingWithoutJobAsError).toHaveBeenCalledTimes(1);
    const stuckCutoff = markStuckProvisioningWithoutActiveJobAsError.mock
      .calls[0]?.[0] as Date;
    const orphanCutoff = markOrphanedPendingWithoutJobAsError.mock
      .calls[0]?.[0] as Date;
    expect(stuckCutoff).toBeInstanceOf(Date);
    expect(orphanCutoff).toBeInstanceOf(Date);
    expect(stuckCutoff.getTime()).toBeGreaterThanOrEqual(
      before - STUCK_PROVISIONING_THRESHOLD_MS - 1000,
    );
    expect(stuckCutoff.getTime()).toBeLessThanOrEqual(
      after - STUCK_PROVISIONING_THRESHOLD_MS + 1000,
    );
    expect(orphanCutoff.getTime()).toBeGreaterThanOrEqual(
      before - ORPHAN_PENDING_THRESHOLD_MS - 1000,
    );
    expect(orphanCutoff.getTime()).toBeLessThanOrEqual(
      after - ORPHAN_PENDING_THRESHOLD_MS + 1000,
    );
    expect(
      orphanCutoff.getTime() - stuckCutoff.getTime(),
    ).toBeGreaterThanOrEqual(9 * 60 * 1000);

    const body = (await response.json()) as {
      success: boolean;
      data: {
        cleanedOrphanedPending: number;
        deferredLockContended: number;
        deferredStuckProvisioning: number;
        deferredOrphanedPending: number;
        thresholdMinutes: number;
        stuckProvisioningThresholdMinutes: number;
        orphanPendingThresholdMinutes: number;
        orphanedPendingAgents: Array<{
          agentId: string;
          agentName: string;
          organizationId: string;
        }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.cleanedOrphanedPending).toBe(1);
    expect(body.data.deferredLockContended).toBe(1);
    expect(body.data.deferredStuckProvisioning).toBe(1);
    expect(body.data.deferredOrphanedPending).toBe(0);
    expect(body.data.thresholdMinutes).toBe(20);
    expect(body.data.stuckProvisioningThresholdMinutes).toBe(20);
    expect(body.data.orphanPendingThresholdMinutes).toBe(10);
    expect(body.data.orphanedPendingAgents).toEqual([
      {
        agentId: "sandbox-orphan-1",
        agentName: "orphaned-agent",
        organizationId: "org-1",
      },
    ]);
  });

  test("rejects an invalid cron secret and never touches the reconciler", async () => {
    verifyCronSecret.mockReturnValueOnce(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "wrong" },
      }),
      { CRON_SECRET: "cron-secret" },
    );

    expect(response.status).toBe(401);
    expect(markStuckProvisioningWithoutActiveJobAsError).not.toHaveBeenCalled();
    expect(markOrphanedPendingWithoutJobAsError).not.toHaveBeenCalled();
  });
});
