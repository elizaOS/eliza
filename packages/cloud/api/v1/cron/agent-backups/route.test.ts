/**
 * Exercises the scheduled-backup route's bounded object-reconciliation wiring.
 *
 * The route owns the production cadence and failure boundary while the shared
 * storage service owns exact-key deletion and durable retry semantics.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

interface ReconciliationParams {
  before: Date;
  limit: number;
  signal: AbortSignal;
}

const enqueueScheduledBackups = mock(async () => ({
  enqueued: 2,
  skipped: 3,
}));
const reEnqueueFailedDeletions = mock(async () => ({
  recovered: 1,
  skipped: 0,
}));
const reconcileIncomplete = mock(async (_params: ReconciliationParams) => ({
  deleted: 1,
  retained: 1,
}));
const verifyCronSecret = mock((): Response | null => null);
const loggerError = mock(() => undefined);

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueScheduledBackups,
    reEnqueueFailedDeletions,
  },
}));

mock.module("@/lib/services/agent-backup-v2-storage", () => ({
  agentBackupV2StorageService: {
    reconcileIncomplete,
  },
}));

mock.module("@/lib/auth/cron", () => ({
  verifyCronSecret,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: loggerError,
  },
}));

const { default: app } = await import("./route");

function postCron() {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: { "x-cron-secret": "cron-secret" },
    }),
    { CRON_SECRET: "cron-secret" },
  );
}

describe("scheduled agent-backup cron", () => {
  beforeEach(() => {
    enqueueScheduledBackups.mockClear();
    reEnqueueFailedDeletions.mockClear();
    reconcileIncomplete.mockClear();
    verifyCronSecret.mockClear();
    loggerError.mockClear();
    enqueueScheduledBackups.mockResolvedValue({ enqueued: 2, skipped: 3 });
    reEnqueueFailedDeletions.mockResolvedValue({ recovered: 1, skipped: 0 });
    reconcileIncomplete.mockResolvedValue({ deleted: 1, retained: 1 });
    verifyCronSecret.mockReturnValue(null);
  });

  test("runs one bounded object-reconciliation page after the primary sweeps", async () => {
    const beforeRequest = Date.now();
    const response = await postCron();
    const afterRequest = Date.now();

    expect(response.status).toBe(200);
    expect(reconcileIncomplete).toHaveBeenCalledTimes(1);
    const params = reconcileIncomplete.mock.calls[0]?.[0];
    expect(params).toBeDefined();
    if (!params) throw new Error("Expected reconciliation parameters");
    expect(params.limit).toBe(1);
    expect(params.signal).toBeInstanceOf(AbortSignal);
    expect(params.signal.aborted).toBe(false);
    expect(params.before.getTime()).toBeGreaterThanOrEqual(
      beforeRequest - 15 * 60 * 1_000 - 100,
    );
    expect(params.before.getTime()).toBeLessThanOrEqual(
      afterRequest - 15 * 60 * 1_000 + 100,
    );

    const body = (await response.json()) as unknown;
    expect(body).toEqual({
      success: true,
      enqueued: 2,
      skipped: 3,
      deletionRecovery: { recovered: 1, skipped: 0 },
      storageReconciliation: { deleted: 1, retained: 1 },
    });
  });

  test("keeps a reconciliation failure observable without masking backup scheduling", async () => {
    reconcileIncomplete.mockRejectedValueOnce(
      new Error("object store unavailable"),
    );

    const response = await postCron();

    expect(response.status).toBe(200);
    expect(enqueueScheduledBackups).toHaveBeenCalledTimes(1);
    expect(reEnqueueFailedDeletions).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({
      success: true,
      enqueued: 2,
      skipped: 3,
      deletionRecovery: { recovered: 1, skipped: 0 },
      storageReconciliation: null,
    });
    expect(loggerError).toHaveBeenCalledWith(
      "[Agent Backups] object reconciliation failed",
      { error: "object store unavailable" },
    );
  });

  test("rejects invalid cron authentication before any mutation or reconciliation", async () => {
    verifyCronSecret.mockReturnValueOnce(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await postCron();

    expect(response.status).toBe(401);
    expect(enqueueScheduledBackups).not.toHaveBeenCalled();
    expect(reEnqueueFailedDeletions).not.toHaveBeenCalled();
    expect(reconcileIncomplete).not.toHaveBeenCalled();
  });
});
