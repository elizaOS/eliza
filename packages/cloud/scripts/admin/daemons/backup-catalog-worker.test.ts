/** Lifecycle, retry, cancellation, timeout, and replay tests for the daemon. */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentBackupCatalogRuntimeSummary } from "@elizaos/cloud-shared/lib/services/agent-backup-catalog-runtime";
import {
  type BackupCatalogWorkerDependencies,
  type BackupCatalogWorkerHealth,
  formatBackupCatalogFatalMessage,
  readBackupCatalogWorkerConfig,
  runBackupCatalogWorker,
  safeBackupCatalogConfigurationNames,
  waitForShutdownBound,
} from "./backup-catalog-worker";

function minimalSubprocessEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: tmpdir(),
    NODE_ENV: "test",
    ...overrides,
  };
}

async function waitForSubprocess(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs = 25_000,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(-1), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function summary(overrides: Partial<AgentBackupCatalogRuntimeSummary> = {}) {
  return {
    enabled: true,
    scheduleEnrolled: 0,
    scheduleProtected: 0,
    scheduleRecycled: 0,
    scheduleClaimed: 0,
    scheduleReserved: 0,
    scheduleDeferred: 0,
    scheduleIndeterminate: 0,
    scheduleOverdue: 0,
    operationClaimed: 0,
    operationCaptured: 0,
    operationCaptureRetryScheduled: 0,
    operationCaptureTerminal: 0,
    operationProtected: 0,
    operationPublicationRetryScheduled: 0,
    operationDeferred: 0,
    operationIndeterminate: 0,
    spoolCleanup: {
      discovered: 0,
      authorized: 0,
      completed: 0,
      pending: 0,
      skippedUnprotected: 0,
      indeterminate: 0,
    },
    deletionCandidates: 0,
    deletionEnqueued: 0,
    deletionEnqueueIndeterminate: 0,
    gcClaimed: 0,
    gcCompleted: 0,
    gcFailed: 0,
    gcIndeterminate: 0,
    deletionFinalized: 0,
    deletionFinalizeIndeterminate: 0,
    alertCodes: [] as string[],
    ...overrides,
  } satisfies AgentBackupCatalogRuntimeSummary;
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS: "5000",
    AGENT_BACKUP_CATALOG_WORKER_RETRY_MS: "5000",
    AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS: "1000",
    AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE:
      "/run/test-backup-catalog/health.json",
    ...overrides,
  };
}

function dependencies(
  params: {
    enabled?: boolean;
    runCycle?: (
      signal?: AbortSignal,
    ) => Promise<AgentBackupCatalogRuntimeSummary>;
    createError?: Error;
  } = {},
) {
  const health: BackupCatalogWorkerHealth[] = [];
  let clock = Date.parse("2026-08-21T00:00:00.000Z");
  const deps: BackupCatalogWorkerDependencies = {
    createComposition: mock(async () => {
      if (params.createError) throw params.createError;
      return {
        enabled: params.enabled ?? true,
        runCycle: params.runCycle ?? mock(async () => summary()),
      };
    }),
    writeHealth: mock(async (_filePath, value) => {
      health.push(structuredClone(value));
    }),
    sleep: mock(async () => undefined),
    now: mock(() => clock++),
    logger: {
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    } as never,
  };
  return { deps, health };
}

describe("backup catalogue worker config", () => {
  test("keeps cadence no slower than 60 seconds and supports --once", () => {
    expect(readBackupCatalogWorkerConfig({}, ["--once"])).toMatchObject({
      runOnce: true,
      intervalMs: 60_000,
    });
    expect(() =>
      readBackupCatalogWorkerConfig(
        { AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS: "60001" },
        [],
      ),
    ).toThrow(/60000/);
    expect(() =>
      readBackupCatalogWorkerConfig(
        { AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS: "4999" },
        [],
      ),
    ).toThrow(/5000/);
    expect(() =>
      readBackupCatalogWorkerConfig(
        { AGENT_BACKUP_CATALOG_WORKER_RETRY_MS: "4999" },
        [],
      ),
    ).toThrow(/5000/);
    expect(() =>
      readBackupCatalogWorkerConfig(
        { AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS: "999" },
        [],
      ),
    ).toThrow(/1000/);
    expect(() =>
      readBackupCatalogWorkerConfig(
        { AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS: "25001" },
        [],
      ),
    ).toThrow(/25000/);
  });

  test("redacts arbitrary fatal messages and admits only closed known codes", () => {
    const error = Object.assign(
      new Error("provider reflected DO_NOT_LEAK_FATAL_SECRET"),
      { code: "BACKUP_PROVIDER_UNAVAILABLE" },
    );
    expect(formatBackupCatalogFatalMessage(error)).toBe(
      "[backup-catalog-worker] fatal: AGENT_BACKUP_CATALOG_CYCLE_FAILED\n",
    );
    expect(formatBackupCatalogFatalMessage(error)).not.toContain(
      "DO_NOT_LEAK_FATAL_SECRET",
    );
    expect(
      formatBackupCatalogFatalMessage({
        code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
      }),
    ).toContain("AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE");
    expect(
      formatBackupCatalogFatalMessage({ code: "AKIA_DO_NOT_LEAK_SECRET" }),
    ).not.toContain("AKIA_DO_NOT_LEAK_SECRET");

    const throwingCode = {};
    Object.defineProperty(throwingCode, "code", {
      get() {
        throw new Error("DO_NOT_LEAK_THROWING_CODE_GETTER");
      },
    });
    expect(formatBackupCatalogFatalMessage(throwingCode)).toBe(
      "[backup-catalog-worker] fatal: AGENT_BACKUP_CATALOG_CYCLE_FAILED\n",
    );
  });

  test("extracts only closed configuration names without invoking message getters", () => {
    expect(
      safeBackupCatalogConfigurationNames(
        new Error(
          "DATABASE_URL and AGENT_BACKUP_OPERATION_LEASE_MS invalid; " +
            "AGENT_BACKUP_DO_NOT_LEAK_SECRET and AKIA_DO_NOT_LEAK_SECRET ignored",
        ),
      ),
    ).toEqual(["AGENT_BACKUP_OPERATION_LEASE_MS", "DATABASE_URL"]);

    const throwingMessage = {};
    Object.defineProperty(throwingMessage, "message", {
      get() {
        throw new Error("AGENT_BACKUP_DO_NOT_LEAK_SECRET");
      },
    });
    expect(safeBackupCatalogConfigurationNames(throwingMessage)).toEqual([]);
  });
});

describe("backup catalogue worker lifecycle", () => {
  test("runs the production entrypoint once and exits disabled without credentials", async () => {
    const root = path.resolve(import.meta.dir, "../../../../..");
    const proofDirectory = await mkdtemp(
      path.join(tmpdir(), "eliza-backup-catalog-entrypoint-"),
    );
    const healthFile = path.join(proofDirectory, "health.json");
    try {
      const child = Bun.spawn(
        [
          path.join(root, "node_modules/.bin/tsx"),
          "--tsconfig",
          path.join(root, "packages/cloud/shared/tsconfig.json"),
          path.join(import.meta.dir, "backup-catalog-worker.ts"),
          "--once",
        ],
        {
          cwd: root,
          env: minimalSubprocessEnv({
            AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "0",
            AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
            AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE: healthFile,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await waitForSubprocess(child);
      if (exitCode === -1) {
        child.kill();
        await child.exited;
      }
      expect(exitCode).toBe(0);
      expect(JSON.parse(await readFile(healthFile, "utf8"))).toMatchObject({
        format: "elizaos.agent-backup.catalog-worker-health.v1",
        state: "disabled",
        enabled: false,
        cycles: 0,
        failures: 0,
        lastCycleMetrics: null,
      });
    } finally {
      await rm(proofDirectory, { recursive: true, force: true });
    }
  });

  test("production entrypoint rejects malformed enabled config without leaking values", async () => {
    const root = path.resolve(import.meta.dir, "../../../../..");
    const proofDirectory = await mkdtemp(
      path.join(tmpdir(), "eliza-backup-catalog-malformed-"),
    );
    const healthFile = path.join(proofDirectory, "health.json");
    const secretSentinel = "DO_NOT_LEAK_BACKUP_SECRET";
    try {
      const child = Bun.spawn(
        [
          path.join(root, "node_modules/.bin/tsx"),
          "--tsconfig",
          path.join(root, "packages/cloud/shared/tsconfig.json"),
          path.join(import.meta.dir, "backup-catalog-worker.ts"),
          "--once",
        ],
        {
          cwd: root,
          env: minimalSubprocessEnv({
            AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1",
            AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
            AGENT_BACKUP_CATALOG_WORKER_ID: "",
            AGENT_BACKUP_R2_SECRET_ACCESS_KEY: secretSentinel,
            AGENT_BACKUP_STEWARD_KMS_TOKEN: secretSentinel,
            AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE: healthFile,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await waitForSubprocess(child);
      if (exitCode === -1) {
        child.kill();
        await child.exited;
      }
      const stderr = await new Response(child.stderr).text();
      expect(exitCode).toBe(78);
      expect(stderr).toContain("AGENT_BACKUP_CATALOG_WORKER_ID");
      expect(stderr).not.toContain(secretSentinel);
      expect(JSON.parse(await readFile(healthFile, "utf8"))).toMatchObject({
        state: "terminal-configuration-failure",
        enabled: false,
        cycles: 0,
        failures: 1,
        lastCycleMetrics: null,
      });
    } finally {
      await rm(proofDirectory, { recursive: true, force: true });
    }
  });

  test("runs exactly one production-composition cycle in --once mode", async () => {
    const runCycle = mock(async () =>
      summary({ operationClaimed: 1, operationCaptured: 1 }),
    );
    const { deps, health } = dependencies({ runCycle });
    const controller = new AbortController();
    const result = await runBackupCatalogWorker({
      env: env(),
      argv: ["--once"],
      signal: controller.signal,
      dependencies: deps,
    });
    expect(result).toEqual({
      state: "idle",
      exitCode: 0,
      cycles: 1,
      failures: 0,
    });
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(runCycle).toHaveBeenCalledWith(controller.signal);
    expect(health.map((entry) => entry.state)).toEqual([
      "idle",
      "running",
      "idle",
    ]);
    expect(health.at(-1)?.lastCycleMetrics).toMatchObject({
      operationClaimed: 1,
      operationCaptured: 1,
      operationProtected: 0,
    });
    expect(deps.logger.info).toHaveBeenCalledWith(
      "[backup-catalog-worker] cycle complete",
      expect.objectContaining({ operationClaimed: 1, operationCaptured: 1 }),
    );
  });

  test("marks a resolved cycle with alerts degraded and uses retry cadence", async () => {
    const controller = new AbortController();
    const runCycle = mock(async () =>
      summary({
        scheduleIndeterminate: 10_000,
        alertCodes: ["BACKUP_SCHEDULE_RECONCILE_REQUIRED"],
      }),
    );
    const { deps, health } = dependencies({ runCycle });
    deps.sleep = mock(async (ms) => {
      expect(ms).toBe(5_000);
      controller.abort(new Error("test complete"));
    });
    const result = await runBackupCatalogWorker({
      env: env(),
      signal: controller.signal,
      dependencies: deps,
    });
    expect(result).toMatchObject({
      state: "bounded-shutdown",
      cycles: 1,
      failures: 1,
    });
    expect(health.map((entry) => entry.state)).toContain("degraded");
    expect(health.every((entry) => "lastCycleMetrics" in entry)).toBe(true);
    expect(
      health.find((entry) => entry.state === "degraded")?.lastCycleMetrics,
    ).toMatchObject({ scheduleIndeterminate: 10_000 });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "[backup-catalog-worker] cycle degraded",
      expect.objectContaining({
        failures: 1,
        alertCodes: ["BACKUP_SCHEDULE_RECONCILE_REQUIRED"],
      }),
    );
  });

  test("keeps hostile alert codes degraded while exposing only bounded metrics", async () => {
    const hostile = "AKIA_DO_NOT_LEAK_ALERT_CODE";
    const { deps, health } = dependencies({
      runCycle: mock(async () =>
        summary({
          scheduleClaimed: -1,
          operationClaimed: Number.MAX_SAFE_INTEGER,
          alertCodes: [hostile],
        }),
      ),
    });
    const result = await runBackupCatalogWorker({
      env: env(),
      argv: ["--once"],
      signal: new AbortController().signal,
      dependencies: deps,
    });
    const final = health.at(-1);
    expect(result.state).toBe("degraded");
    expect(final?.state).toBe("degraded");
    expect(final?.lastAlertCodes).toEqual(["BACKUP_ALERT_REDACTED"]);
    expect(final?.lastCycleMetrics).toMatchObject({
      scheduleClaimed: 0,
      operationClaimed: 1_000_000_000,
    });
    expect(JSON.stringify(final)).not.toContain(hostile);
  });

  test("reports disabled without invoking any runtime cycle", async () => {
    const runCycle = mock(async () => summary());
    const { deps, health } = dependencies({ enabled: false, runCycle });
    const result = await runBackupCatalogWorker({
      env: env(),
      argv: ["--once"],
      signal: new AbortController().signal,
      dependencies: deps,
    });
    expect(result.state).toBe("disabled");
    expect(runCycle).not.toHaveBeenCalled();
    expect(health.at(-1)?.state).toBe("disabled");
    expect(health.at(-1)?.lastCycleMetrics).toBeNull();
  });

  test("classifies malformed enabled composition as terminal configuration failure", async () => {
    const { deps, health } = dependencies({
      createError: new Error("AGENT_BACKUP_R2_ENDPOINT must be configured"),
    });
    const result = await runBackupCatalogWorker({
      env: env(),
      argv: ["--once"],
      signal: new AbortController().signal,
      dependencies: deps,
    });
    expect(result).toMatchObject({
      state: "terminal-configuration-failure",
      exitCode: 78,
      failures: 1,
    });
    expect(health.at(-1)?.state).toBe("terminal-configuration-failure");
  });

  test("keeps exit 78 when invalid daemon config health publication fails", async () => {
    const { deps } = dependencies();
    const healthFailure = "DO_NOT_LEAK_CONFIG_HEALTH_FAILURE";
    const errorLogs: unknown[] = [];
    deps.writeHealth = mock(async () => {
      throw new Error(healthFailure);
    });
    deps.logger.error = mock((message: unknown, context?: unknown) => {
      errorLogs.push([message, context]);
    }) as never;

    const result = await runBackupCatalogWorker({
      env: env({ AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS: "invalid-value" }),
      argv: ["--once"],
      signal: new AbortController().signal,
      dependencies: deps,
    });

    expect(result).toEqual({
      state: "terminal-configuration-failure",
      exitCode: 78,
      cycles: 0,
      failures: 1,
    });
    expect(deps.createComposition).not.toHaveBeenCalled();
    expect(deps.writeHealth).toHaveBeenCalledTimes(1);
    expect(errorLogs).toEqual([
      [
        "[backup-catalog-worker] configuration rejected",
        {
          code: "AGENT_BACKUP_CATALOG_CONFIGURATION_INVALID",
          configurationNames: ["AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS"],
        },
      ],
      [
        "[backup-catalog-worker] configuration health publication failed",
        { code: "AGENT_BACKUP_CATALOG_HEALTH_WRITE_FAILED" },
      ],
    ]);
    expect(JSON.stringify(errorLogs)).not.toContain(healthFailure);
    expect(JSON.stringify(errorLogs)).not.toContain("invalid-value");
  });

  test("keeps exit 78 when invalid composition health publication fails", async () => {
    const { deps } = dependencies({
      createError: new Error(
        "AGENT_BACKUP_R2_ENDPOINT rejects DO_NOT_LEAK_PROVIDER_VALUE",
      ),
    });
    const healthFailure = "DO_NOT_LEAK_COMPOSITION_HEALTH_FAILURE";
    const errorLogs: unknown[] = [];
    deps.writeHealth = mock(async () => {
      throw new Error(healthFailure);
    });
    deps.logger.error = mock((message: unknown, context?: unknown) => {
      errorLogs.push([message, context]);
    }) as never;

    const result = await runBackupCatalogWorker({
      env: env(),
      argv: ["--once"],
      signal: new AbortController().signal,
      dependencies: deps,
    });

    expect(result).toEqual({
      state: "terminal-configuration-failure",
      exitCode: 78,
      cycles: 0,
      failures: 1,
    });
    expect(deps.createComposition).toHaveBeenCalledTimes(1);
    expect(deps.writeHealth).toHaveBeenCalledTimes(1);
    expect(errorLogs).toEqual([
      [
        "[backup-catalog-worker] configuration rejected",
        {
          code: "AGENT_BACKUP_CATALOG_CONFIGURATION_INVALID",
          configurationNames: ["AGENT_BACKUP_R2_ENDPOINT"],
        },
      ],
      [
        "[backup-catalog-worker] configuration health publication failed",
        { code: "AGENT_BACKUP_CATALOG_HEALTH_WRITE_FAILED" },
      ],
    ]);
    expect(JSON.stringify(errorLogs)).not.toContain(healthFailure);
    expect(JSON.stringify(errorLogs)).not.toContain(
      "DO_NOT_LEAK_PROVIDER_VALUE",
    );
  });

  test("retries a transient cycle and stops claiming after cancellation", async () => {
    const controller = new AbortController();
    let attempt = 0;
    const runCycle = mock(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient provider outage");
      controller.abort(new Error("test shutdown"));
      return summary({ operationProtected: 1 });
    });
    const { deps, health } = dependencies({ runCycle });
    const result = await runBackupCatalogWorker({
      env: env(),
      signal: controller.signal,
      dependencies: deps,
    });
    expect(runCycle).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: "bounded-shutdown",
      cycles: 1,
      failures: 1,
    });
    expect(health.map((entry) => entry.state)).toContain("retryable-failure");
    expect(
      health.find((entry) => entry.state === "retryable-failure")
        ?.lastCycleMetrics,
    ).toBeNull();
  });

  test("clears prior-cycle metrics before publishing a later retryable failure", async () => {
    const controller = new AbortController();
    let attempt = 0;
    const runCycle = mock(async () => {
      attempt += 1;
      if (attempt === 1) return summary({ operationProtected: 1 });
      throw new Error("transient provider outage");
    });
    const { deps, health } = dependencies({ runCycle });
    deps.sleep = mock(async () => {
      if (attempt > 1) controller.abort(new Error("test complete"));
    });
    await runBackupCatalogWorker({
      env: env(),
      signal: controller.signal,
      dependencies: deps,
    });
    expect(
      health.findLast((entry) => entry.state === "retryable-failure")
        ?.lastCycleMetrics,
    ).toBeNull();
  });

  test("propagates SIGTERM-style cancellation into the in-flight executor", async () => {
    const controller = new AbortController();
    const runCycle = mock(
      async (signal?: AbortSignal) =>
        new Promise<AgentBackupCatalogRuntimeSummary>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const { deps, health } = dependencies({ runCycle });
    const running = runBackupCatalogWorker({
      env: env(),
      signal: controller.signal,
      dependencies: deps,
    });
    while (runCycle.mock.calls.length === 0) await Bun.sleep(0);
    controller.abort(new Error("SIGTERM"));
    const result = await running;
    expect(runCycle.mock.calls[0]?.[0]).toBe(controller.signal);
    expect(result.state).toBe("bounded-shutdown");
    expect(health.at(-1)?.state).toBe("bounded-shutdown");
    expect(health.at(-1)?.lastCycleMetrics).toBeNull();
  });

  test("clears the shutdown timer when an already-aborted execution settles", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      const result = await waitForShutdownBound({
        pending: Promise.resolve("settled"),
        signal: controller.signal,
        timeoutMs: 25_000,
      });
      expect(result).toEqual({ kind: "settled", value: "settled" });
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  test("bounds shutdown when an executor ignores cancellation", async () => {
    const controller = new AbortController();
    const runCycle = mock(
      async () =>
        new Promise<AgentBackupCatalogRuntimeSummary>(() => undefined),
    );
    const { deps, health } = dependencies({
      runCycle,
    });
    const running = runBackupCatalogWorker({
      env: env({ AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS: "1000" }),
      signal: controller.signal,
      dependencies: deps,
    });
    while (runCycle.mock.calls.length === 0) await Bun.sleep(0);
    controller.abort(new Error("SIGTERM"));
    const result = await running;
    expect(result).toMatchObject({ state: "bounded-shutdown", exitCode: 0 });
    expect(health.at(-1)?.state).toBe("bounded-shutdown");
    expect(health.at(-1)?.lastCycleMetrics).toBeNull();
  });

  test("models durable replay ownership after a timed-out predecessor", async () => {
    const firstController = new AbortController();
    let durableProtected = false;
    const firstCycle = mock(
      async () =>
        new Promise<AgentBackupCatalogRuntimeSummary>(() => undefined),
    );
    const first = dependencies({
      runCycle: firstCycle,
    });
    const firstRun = runBackupCatalogWorker({
      env: env({ AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS: "1000" }),
      signal: firstController.signal,
      dependencies: first.deps,
    });
    while (firstCycle.mock.calls.length === 0) await Bun.sleep(0);
    firstController.abort(new Error("host restart"));
    await firstRun;
    expect(durableProtected).toBe(false);

    const replay = dependencies({
      runCycle: mock(async () => {
        durableProtected = true;
        return summary({ operationClaimed: 1, operationProtected: 1 });
      }),
    });
    const second = await runBackupCatalogWorker({
      env: env(),
      argv: ["--once"],
      signal: new AbortController().signal,
      dependencies: replay.deps,
    });
    expect(second).toMatchObject({ state: "idle", cycles: 1, failures: 0 });
    expect(durableProtected).toBe(true);
  });
});
