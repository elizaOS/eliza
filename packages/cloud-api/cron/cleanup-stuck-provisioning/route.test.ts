import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Wiring test for the cleanup-stuck-provisioning cron.
 *
 * The handler runs two scans on the write path: stuck-provisioning rows and
 * orphaned-`pending` rows (committed by createAgent but never enqueued). This
 * test pins the orphaned-pending scan: it must be called with the SAME
 * NOW−10min cutoff the stuck scan uses, and the recovered rows must surface in
 * the JSON response (count + agents) under the field names the route emits.
 */

const markStuckProvisioningWithoutActiveJobAsError = mock(
  async () =>
    [] as Array<{
      agentId: string;
      agentName: string | null;
      organizationId: string;
    }>,
);
const markOrphanedPendingWithoutJobAsError = mock(async () => [
  {
    agentId: "sandbox-orphan-1",
    agentName: "orphaned-agent",
    organizationId: "org-1",
    createdAt: new Date("2026-06-14T00:00:00.000Z"),
  },
]);

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

const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

function postCron() {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: { "x-cron-secret": "cron-secret" },
    }),
    { CRON_SECRET: "cron-secret" },
  );
}

describe("cleanup-stuck-provisioning cron — orphaned pending scan", () => {
  beforeEach(() => {
    markStuckProvisioningWithoutActiveJobAsError.mockClear();
    markOrphanedPendingWithoutJobAsError.mockClear();
    verifyCronSecret.mockClear();
    verifyCronSecret.mockReturnValue(null);
    markStuckProvisioningWithoutActiveJobAsError.mockResolvedValue([]);
    markOrphanedPendingWithoutJobAsError.mockResolvedValue([
      {
        agentId: "sandbox-orphan-1",
        agentName: "orphaned-agent",
        organizationId: "org-1",
        createdAt: new Date("2026-06-14T00:00:00.000Z"),
      },
    ]);
  });

  test("reconciles orphaned pending rows with a NOW−10min cutoff and exposes them", async () => {
    const before = Date.now();
    const response = await postCron();
    const after = Date.now();

    expect(response.status).toBe(200);

    // (a) The orphaned-pending scan ran with the same NOW−10min cutoff the
    // stuck scan uses (a Date roughly 10 minutes in the past).
    expect(markOrphanedPendingWithoutJobAsError).toHaveBeenCalledTimes(1);
    const cutoff = markOrphanedPendingWithoutJobAsError.mock
      .calls[0]?.[0] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(
      before - STUCK_THRESHOLD_MS - 1000,
    );
    expect(cutoff.getTime()).toBeLessThanOrEqual(
      after - STUCK_THRESHOLD_MS + 1000,
    );
    // Both scans share the exact same cutoff instance.
    const stuckCutoff =
      markStuckProvisioningWithoutActiveJobAsError.mock.calls[0]?.[0];
    expect(stuckCutoff).toBe(cutoff);

    // (b) The response exposes the orphaned count + the recovered agent.
    const body = (await response.json()) as {
      success: boolean;
      data: {
        cleanedOrphanedPending: number;
        orphanedPendingAgents: Array<{
          agentId: string;
          agentName: string;
          organizationId: string;
        }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.cleanedOrphanedPending).toBe(1);
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
