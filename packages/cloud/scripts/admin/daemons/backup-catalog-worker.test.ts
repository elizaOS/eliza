/** Lifecycle, retry, cancellation, timeout, and replay tests for the daemon. */

import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentBackupCatalogRuntimeSummary } from "@elizaos/cloud-shared/lib/services/agent-backup-catalog-runtime";
import {
  type BackupCatalogWorkerDependencies,
  type BackupCatalogWorkerHealth,
  readBackupCatalogWorkerConfig,
  runBackupCatalogWorker,
} from "./backup-catalog-worker";

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
    AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS: "10",
    AGENT_BACKUP_CATALOG_WORKER_RETRY_MS: "1",
    AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS: "5",
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
          env: {
            ...process.env,
            AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "0",
            AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
            AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE: healthFile,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(5_000).then(() => {
          child.kill();
          return -1;
        }),
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(await readFile(healthFile, "utf8"))).toMatchObject({
        format: "elizaos.agent-backup.catalog-worker-health.v1",
        state: "disabled",
        enabled: false,
        cycles: 0,
        failures: 0,
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
          env: {
            ...process.env,
            AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1",
            AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
            AGENT_BACKUP_CATALOG_WORKER_ID: "",
            AGENT_BACKUP_R2_SECRET_ACCESS_KEY: secretSentinel,
            AGENT_BACKUP_STEWARD_KMS_TOKEN: secretSentinel,
            AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE: healthFile,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(5_000).then(() => {
          child.kill();
          return -1;
        }),
      ]);
      const stderr = await new Response(child.stderr).text();
      expect(exitCode).toBe(78);
      expect(stderr).toContain("AGENT_BACKUP_CATALOG_WORKER_ID");
      expect(stderr).not.toContain(secretSentinel);
      expect(JSON.parse(await readFile(healthFile, "utf8"))).toMatchObject({
        state: "terminal-configuration-failure",
        enabled: false,
        cycles: 0,
        failures: 1,
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
      env: env({ AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS: "1" }),
      signal: controller.signal,
      dependencies: deps,
    });
    while (runCycle.mock.calls.length === 0) await Bun.sleep(0);
    controller.abort(new Error("SIGTERM"));
    const result = await running;
    expect(result).toMatchObject({ state: "bounded-shutdown", exitCode: 0 });
    expect(health.at(-1)?.state).toBe("bounded-shutdown");
  });

  test("a fresh process replays work left unacknowledged by a timed-out predecessor", async () => {
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
      env: env({ AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS: "1" }),
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
