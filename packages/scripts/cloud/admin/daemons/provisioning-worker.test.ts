// Exercises cloud admin daemons provisioning worker.test automation behavior with deterministic script fixtures.
import { describe, expect, it, mock } from "bun:test";
import {
  assertKmsBackendDurable,
  assertProvisioningWorkerPreflight,
  closeOpenHandles,
  databaseHostForLogs,
  evaluateJobsTableLiveness,
  evaluateSelfRestart,
  formatErrorWithCause,
  maybePublishHeartbeat,
  pollSleep,
  readWorkerConfig,
  requestShutdown,
  resetKmsBackendLogForTests,
  WORKER_TIMING,
} from "./provisioning-worker";

type WorkerLogger = Parameters<typeof maybePublishHeartbeat>[0];

function makeLogger(): WorkerLogger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as unknown as WorkerLogger;
}

describe("formatErrorWithCause (cycle-failure observability)", () => {
  it("surfaces the pg error hidden behind a Drizzle query-failure wrapper", () => {
    const pgError = new Error("self-signed certificate in certificate chain");
    const drizzleError = new Error(
      'Failed query: select "id" from "provisioning_jobs"',
      { cause: pgError },
    );

    expect(formatErrorWithCause(drizzleError)).toBe(
      'Failed query: select "id" from "provisioning_jobs"; caused by: self-signed certificate in certificate chain',
    );
  });

  it("walks nested causes and stringifies non-Error links", () => {
    const error = new Error("outer", {
      cause: new Error("middle", { cause: "ECONNREFUSED" }),
    });

    expect(formatErrorWithCause(error)).toBe(
      "outer; caused by: middle; caused by: ECONNREFUSED",
    );
  });

  it("leaves plain errors and non-Error throws unchanged, bounding deep chains", () => {
    expect(formatErrorWithCause(new Error("boom"))).toBe("boom");
    expect(formatErrorWithCause("boom")).toBe("boom");

    let chained: Error = new Error("depth-0");
    for (let i = 1; i <= 8; i++) {
      chained = new Error(`depth-${i}`, { cause: chained });
    }
    // Top message plus at most 5 causes — a self-referencing chain can't loop.
    expect(formatErrorWithCause(chained)).toBe(
      "depth-8; caused by: depth-7; caused by: depth-6; caused by: depth-5; caused by: depth-4; caused by: depth-3",
    );
  });
});

describe("assertProvisioningWorkerPreflight", () => {
  it("verifies KMS can create or load the preflight key", async () => {
    const getOrCreateKey = mock(async () => ({ keyId: "ok", version: 1 }));
    const createKmsClient = mock(() => ({ getOrCreateKey }));

    await assertProvisioningWorkerPreflight({
      env: { ELIZA_KMS_BACKEND: "local" } as NodeJS.ProcessEnv,
      createKmsClient,
    });

    expect(createKmsClient).toHaveBeenCalledWith({
      env: { ELIZA_KMS_BACKEND: "local" },
    });
    expect(getOrCreateKey).toHaveBeenCalledWith(
      "system:provisioning-worker-preflight/v1",
    );
  });

  it("fails before the worker can heartbeat or claim jobs when KMS config is missing", async () => {
    await expect(
      assertProvisioningWorkerPreflight({
        env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
        createKmsClient: () => {
          throw new Error(
            "ELIZA_KMS_BACKEND=steward requires steward.{baseUrl, tokenProvider}",
          );
        },
      }),
    ).rejects.toThrow(
      "Refusing to publish a healthy heartbeat or claim provisioning jobs",
    );
  });

  it("fails when the selected KMS backend exists but cannot service key operations", async () => {
    await expect(
      assertProvisioningWorkerPreflight({
        env: { ELIZA_KMS_BACKEND: "steward" } as NodeJS.ProcessEnv,
        createKmsClient: () => ({
          getOrCreateKey: async () => {
            throw new Error("Steward endpoint unavailable");
          },
        }),
      }),
    ).rejects.toThrow("Steward endpoint unavailable");
  });
});

describe("assertKmsBackendDurable (#15310 KMS preflight guard)", () => {
  it("throws on memory backend in production (the exact staging misconfig)", () => {
    // Staging ran ELIZA_KMS_BACKEND=memory. Every worker restart lost all org
    // DEKs, every pre-upgrade snapshot became permanently undecryptable, and
    // real users were stranded on "Setting up your cloud agent…". This guard
    // MUST refuse to boot on that shape.
    expect(() =>
      assertKmsBackendDurable("memory", {
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toThrow(/memory KMS loses all org DEKs on restart/);
    expect(() =>
      assertKmsBackendDurable("memory", {
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ELIZA_KMS_BACKEND=local/);
  });

  it("throws on memory backend in staging (NODE_ENV=staging or unset)", () => {
    // isProductionDeployment gates staging as NOT production — which is why the
    // existing getKmsClient guard MISSED tonight's outage. This preflight is
    // stricter: memory is only ever valid in test/development, so staging AND
    // a bare daemon launch (NODE_ENV=<unset>) are both refused.
    expect(() =>
      assertKmsBackendDurable("memory", {
        NODE_ENV: "staging",
      } as NodeJS.ProcessEnv),
    ).toThrow(/memory KMS loses all org DEKs/);
    expect(() =>
      assertKmsBackendDurable("memory", {} as NodeJS.ProcessEnv),
    ).toThrow(/NODE_ENV=<unset>/);
  });

  it("passes on memory backend in test / development (legitimate use)", () => {
    // Every test process is its own throwaway world; the existing security
    // package tests + kms-client.test.ts all rely on memory as the default.
    expect(() =>
      assertKmsBackendDurable("memory", {
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      assertKmsBackendDurable("memory", {
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("passes on durable backends (local / steward) in every env", () => {
    for (const nodeEnv of [
      "production",
      "staging",
      "test",
      "development",
      undefined,
    ]) {
      const env = { NODE_ENV: nodeEnv } as NodeJS.ProcessEnv;
      expect(() => assertKmsBackendDurable("local", env)).not.toThrow();
      expect(() => assertKmsBackendDurable("steward", env)).not.toThrow();
    }
  });
});

describe("assertProvisioningWorkerPreflight (#15310 memory-backend refusal)", () => {
  it("REFUSES to boot when the resolved backend is memory in production, BEFORE touching the KMS", async () => {
    // The old preflight would happily call getOrCreateKey() on a memory KMS
    // (it works in-process) and pass — the failure only surfaces on the NEXT
    // restart, by which point every backup is unreadable. The new guard runs
    // ahead of the KMS probe so a getOrCreateKey that would have succeeded
    // NEVER RUNS on a memory backend in production.
    resetKmsBackendLogForTests();
    const getOrCreateKey = mock(async () => ({ keyId: "ok", version: 1 }));
    const createKmsClient = mock(() => ({ getOrCreateKey }));

    await expect(
      assertProvisioningWorkerPreflight({
        env: {
          ELIZA_KMS_BACKEND: "memory",
          NODE_ENV: "production",
        } as NodeJS.ProcessEnv,
        createKmsClient,
        resolveKmsBackend: () => "memory",
      }),
    ).rejects.toThrow(/memory KMS loses all org DEKs on restart/);

    // Critical: the probe MUST NOT have run — memory backend passes
    // getOrCreateKey in-process, so touching it would have masked the failure.
    expect(createKmsClient).not.toHaveBeenCalled();
    expect(getOrCreateKey).not.toHaveBeenCalled();
  });

  it("proceeds through the KMS probe when the resolved backend is local", async () => {
    resetKmsBackendLogForTests();
    const getOrCreateKey = mock(async () => ({ keyId: "ok", version: 1 }));
    const createKmsClient = mock(() => ({ getOrCreateKey }));

    await assertProvisioningWorkerPreflight({
      env: {
        ELIZA_KMS_BACKEND: "local",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv,
      createKmsClient,
      resolveKmsBackend: () => "local",
    });

    expect(createKmsClient).toHaveBeenCalledTimes(1);
    expect(getOrCreateKey).toHaveBeenCalledWith(
      "system:provisioning-worker-preflight/v1",
    );
  });

  it("logs the active backend once through the worker logger", async () => {
    resetKmsBackendLogForTests();
    const logger = makeLogger();
    const getOrCreateKey = mock(async () => ({ keyId: "ok", version: 1 }));
    const createKmsClient = mock(() => ({ getOrCreateKey }));
    const env = {
      ELIZA_KMS_BACKEND: "local",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv;

    await assertProvisioningWorkerPreflight({
      env,
      createKmsClient,
      resolveKmsBackend: () => "local",
      logger,
    });
    await assertProvisioningWorkerPreflight({
      env,
      createKmsClient,
      resolveKmsBackend: () => "local",
      logger,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "[provisioning-worker] active KMS backend: local (NODE_ENV=production)",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("tolerates memory backend when NODE_ENV=test (existing tests must keep working)", async () => {
    resetKmsBackendLogForTests();
    const getOrCreateKey = mock(async () => ({ keyId: "ok", version: 1 }));
    const createKmsClient = mock(() => ({ getOrCreateKey }));

    await assertProvisioningWorkerPreflight({
      env: {
        ELIZA_KMS_BACKEND: "memory",
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv,
      createKmsClient,
      resolveKmsBackend: () => "memory",
    });

    expect(createKmsClient).toHaveBeenCalledTimes(1);
  });
});

describe("maybePublishHeartbeat (liveness gate)", () => {
  const fresh = Date.now();

  it("does NOT publish when preflight has not passed (preflightOk=false)", async () => {
    const publish = mock(async () => {});
    const result = await maybePublishHeartbeat(makeLogger(), {
      preflightOk: false,
      lastCycleCompletedAt: fresh,
      now: fresh,
      publish,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({ published: false, watchdogTripped: false });
  });

  it("DOES publish when preflight passed and the cycle is progressing", async () => {
    const publish = mock(async () => {});
    const result = await maybePublishHeartbeat(makeLogger(), {
      preflightOk: true,
      lastCycleCompletedAt: fresh,
      now: fresh,
      publish,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ published: true, watchdogTripped: false });
  });

  it("withholds the heartbeat when the watchdog trips, even if preflight is OK", async () => {
    const publish = mock(async () => {});
    const logger = makeLogger();
    // Last cycle completed > 5min ago → wedged.
    const stale = fresh - (5 * 60_000 + 1);
    const result = await maybePublishHeartbeat(logger, {
      preflightOk: true,
      lastCycleCompletedAt: stale,
      now: fresh,
      publish,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({ published: false, watchdogTripped: true });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("evaluateSelfRestart (FIX 1 — K-consecutive-tick trigger)", () => {
  it("resets the counter and never restarts while the cycle is progressing", () => {
    const result = evaluateSelfRestart({
      watchdogTripped: false,
      consecutiveTicks: 1,
      selfRestartEnabled: true,
      threshold: 2,
    });
    expect(result).toEqual({ nextConsecutiveTicks: 0, shouldRestart: false });
  });

  it("does NOT restart on the first wedged tick (K=2)", () => {
    const result = evaluateSelfRestart({
      watchdogTripped: true,
      consecutiveTicks: 0,
      selfRestartEnabled: true,
      threshold: 2,
    });
    expect(result).toEqual({ nextConsecutiveTicks: 1, shouldRestart: false });
  });

  it("restarts on the K-th consecutive wedged tick (K=2)", () => {
    const result = evaluateSelfRestart({
      watchdogTripped: true,
      consecutiveTicks: 1,
      selfRestartEnabled: true,
      threshold: 2,
    });
    expect(result).toEqual({ nextConsecutiveTicks: 2, shouldRestart: true });
  });

  it("a single wedged tick between healthy ticks never reaches the threshold", () => {
    // tick 1: wedged (counter 0 -> 1, no restart)
    let state = evaluateSelfRestart({
      watchdogTripped: true,
      consecutiveTicks: 0,
      selfRestartEnabled: true,
      threshold: 2,
    });
    expect(state.shouldRestart).toBe(false);
    // tick 2: progressing again -> counter resets
    state = evaluateSelfRestart({
      watchdogTripped: false,
      consecutiveTicks: state.nextConsecutiveTicks,
      selfRestartEnabled: true,
      threshold: 2,
    });
    expect(state.nextConsecutiveTicks).toBe(0);
    // tick 3: wedged again -> back to 1, still no restart
    state = evaluateSelfRestart({
      watchdogTripped: true,
      consecutiveTicks: state.nextConsecutiveTicks,
      selfRestartEnabled: true,
      threshold: 2,
    });
    expect(state).toEqual({ nextConsecutiveTicks: 1, shouldRestart: false });
  });

  it("never restarts when the feature is disabled, even past the threshold", () => {
    const result = evaluateSelfRestart({
      watchdogTripped: true,
      consecutiveTicks: 5,
      selfRestartEnabled: false,
      threshold: 2,
    });
    expect(result).toEqual({ nextConsecutiveTicks: 6, shouldRestart: false });
  });

  it("honors a higher threshold (K=3)", () => {
    expect(
      evaluateSelfRestart({
        watchdogTripped: true,
        consecutiveTicks: 1,
        selfRestartEnabled: true,
        threshold: 3,
      }).shouldRestart,
    ).toBe(false);
    expect(
      evaluateSelfRestart({
        watchdogTripped: true,
        consecutiveTicks: 2,
        selfRestartEnabled: true,
        threshold: 3,
      }).shouldRestart,
    ).toBe(true);
  });
});

describe("watchdog timing invariant (FIX E/F)", () => {
  // Pins the core safety property: the WORK cycle's wall-clock budget plus the
  // gap the loop sleeps between cycles must finish comfortably before the
  // watchdog declares the worker wedged. If this ever fails, a slow-but-
  // progressing cycle would self-restart — the exact false positive the design
  // claims to prevent. Bounding the WORK group ONCE (workCycleTimeoutMs) instead
  // of summing N per-phase 90s timeouts (4 × 90s = 360s > the 300s window) is
  // what keeps it true, and keeps it true when a 5th phase is added.
  it("SUM(work budget) + pollInterval < WATCHDOG_MAX_CYCLE_MS", () => {
    const { workCycleTimeoutMs, defaultPollIntervalMs, watchdogMaxCycleMs } =
      WORKER_TIMING;
    expect(workCycleTimeoutMs + defaultPollIntervalMs).toBeLessThan(
      watchdogMaxCycleMs,
    );
  });

  it("the work-cycle budget itself is below the watchdog window", () => {
    expect(WORKER_TIMING.workCycleTimeoutMs).toBeLessThan(
      WORKER_TIMING.watchdogMaxCycleMs,
    );
  });

  it("a per-phase timeout never exceeds the whole-cycle budget", () => {
    // A single phase must not be allowed to outlast the group bound that
    // protects the watchdog invariant.
    expect(WORKER_TIMING.phaseTimeoutMs).toBeLessThanOrEqual(
      WORKER_TIMING.workCycleTimeoutMs,
    );
  });

  it("documents the true headroom (defaults: 240s + 30s = 270s < 300s)", () => {
    expect(WORKER_TIMING.workCycleTimeoutMs).toBe(240_000);
    expect(WORKER_TIMING.defaultPollIntervalMs).toBe(30_000);
    expect(WORKER_TIMING.watchdogMaxCycleMs).toBe(300_000);
  });
});

describe("readWorkerConfig (resilience knobs)", () => {
  it("defaults: self-restart on, K=2, orphan reconciler off", () => {
    const c = readWorkerConfig({} as NodeJS.ProcessEnv, []);
    expect(c.selfRestartEnabled).toBe(true);
    expect(c.watchdogConsecutiveTicks).toBe(2);
    expect(c.orphanReconcilerEnabled).toBe(false);
  });

  it("PROVISIONING_WORKER_SELF_RESTART=0 / false disables self-restart", () => {
    expect(
      readWorkerConfig(
        { PROVISIONING_WORKER_SELF_RESTART: "0" } as NodeJS.ProcessEnv,
        [],
      ).selfRestartEnabled,
    ).toBe(false);
    expect(
      readWorkerConfig(
        { PROVISIONING_WORKER_SELF_RESTART: "false" } as NodeJS.ProcessEnv,
        [],
      ).selfRestartEnabled,
    ).toBe(false);
  });

  it("ORPHAN_RECONCILER_ENABLED=1 arms the reconciler; other values keep it off", () => {
    expect(
      readWorkerConfig(
        { ORPHAN_RECONCILER_ENABLED: "1" } as NodeJS.ProcessEnv,
        [],
      ).orphanReconcilerEnabled,
    ).toBe(true);
    expect(
      readWorkerConfig(
        { ORPHAN_RECONCILER_ENABLED: "true" } as NodeJS.ProcessEnv,
        [],
      ).orphanReconcilerEnabled,
    ).toBe(false);
  });

  it("PROVISIONING_WORKER_WATCHDOG_TICKS overrides K; garbage falls back to 2", () => {
    expect(
      readWorkerConfig(
        { PROVISIONING_WORKER_WATCHDOG_TICKS: "4" } as NodeJS.ProcessEnv,
        [],
      ).watchdogConsecutiveTicks,
    ).toBe(4);
    expect(
      readWorkerConfig(
        { PROVISIONING_WORKER_WATCHDOG_TICKS: "nope" } as NodeJS.ProcessEnv,
        [],
      ).watchdogConsecutiveTicks,
    ).toBe(2);
  });
});

describe("evaluateJobsTableLiveness (#15160 — abandoned-database signal)", () => {
  const now = new Date("2026-07-06T12:00:00Z");

  it("a recent jobs row is fresh", () => {
    const assessment = evaluateJobsTableLiveness({
      latestJobCreatedAt: new Date("2026-07-06T11:00:00Z"),
      maxAgeHours: 24,
      now,
    });
    expect(assessment.stale).toBe(false);
    expect(assessment.ageHours).toBeCloseTo(1, 5);
    expect(assessment.maxAgeHours).toBe(24);
  });

  it("a row older than the threshold is stale (the #15160 shape: weeks-old queue)", () => {
    const assessment = evaluateJobsTableLiveness({
      latestJobCreatedAt: new Date("2026-06-17T05:08:00Z"),
      maxAgeHours: 24,
      now,
    });
    expect(assessment.stale).toBe(true);
    expect(assessment.ageHours).toBeGreaterThan(24 * 19);
  });

  it("an EMPTY jobs table is stale — the API has never written here", () => {
    const assessment = evaluateJobsTableLiveness({
      latestJobCreatedAt: null,
      maxAgeHours: 24,
      now,
    });
    expect(assessment.stale).toBe(true);
    expect(assessment.ageHours).toBeNull();
    expect(assessment.latestJobCreatedAt).toBeNull();
  });

  it("exactly at the threshold is still fresh; one hour past is stale", () => {
    expect(
      evaluateJobsTableLiveness({
        latestJobCreatedAt: new Date("2026-07-05T12:00:00Z"),
        maxAgeHours: 24,
        now,
      }).stale,
    ).toBe(false);
    expect(
      evaluateJobsTableLiveness({
        latestJobCreatedAt: new Date("2026-07-05T11:00:00Z"),
        maxAgeHours: 24,
        now,
      }).stale,
    ).toBe(true);
  });

  it("a created_at in the future (clock skew) is fresh, not stale", () => {
    const assessment = evaluateJobsTableLiveness({
      latestJobCreatedAt: new Date("2026-07-06T13:00:00Z"),
      maxAgeHours: 24,
      now,
    });
    expect(assessment.stale).toBe(false);
    expect(assessment.ageHours).toBeLessThan(0);
  });

  it("honors a tightened threshold", () => {
    const assessment = evaluateJobsTableLiveness({
      latestJobCreatedAt: new Date("2026-07-06T09:00:00Z"),
      maxAgeHours: 2,
      now,
    });
    expect(assessment.stale).toBe(true);
    expect(assessment.maxAgeHours).toBe(2);
  });
});

describe("databaseHostForLogs (#15160 — name the DB host, never the credentials)", () => {
  it("extracts host:port from a Neon-style URL without leaking user or password", () => {
    const host = databaseHostForLogs(
      "postgresql://neondb_owner:sup3rs3cret@ep-wild-dawn-a4c7r311-pooler.us-east-1.aws.neon.tech:5432/neondb?sslmode=require",
    );
    expect(host).toBe(
      "ep-wild-dawn-a4c7r311-pooler.us-east-1.aws.neon.tech:5432",
    );
    expect(host).not.toContain("sup3rs3cret");
    expect(host).not.toContain("neondb_owner");
  });

  it("falls back to the data-dir path for host-less pglite URLs", () => {
    expect(databaseHostForLogs("pglite:///home/eliza/.eliza/.pgdata")).toBe(
      "/home/eliza/.eliza/.pgdata",
    );
  });

  it("labels missing and unparseable URLs instead of throwing", () => {
    expect(databaseHostForLogs(undefined)).toBe("<DATABASE_URL not set>");
    expect(databaseHostForLogs("not a url at all")).toBe(
      "<unparseable DATABASE_URL>",
    );
  });
});

describe("readWorkerConfig (db liveness threshold)", () => {
  it("defaults to 24h", () => {
    expect(
      readWorkerConfig({} as NodeJS.ProcessEnv, []).dbLivenessMaxAgeHours,
    ).toBe(24);
  });

  it("CONTAINERS_DB_LIVENESS_MAX_AGE_HOURS overrides; garbage falls back to 24", () => {
    expect(
      readWorkerConfig(
        { CONTAINERS_DB_LIVENESS_MAX_AGE_HOURS: "72" } as NodeJS.ProcessEnv,
        [],
      ).dbLivenessMaxAgeHours,
    ).toBe(72);
    expect(
      readWorkerConfig(
        { CONTAINERS_DB_LIVENESS_MAX_AGE_HOURS: "-3" } as NodeJS.ProcessEnv,
        [],
      ).dbLivenessMaxAgeHours,
    ).toBe(24);
    expect(
      readWorkerConfig(
        { CONTAINERS_DB_LIVENESS_MAX_AGE_HOURS: "soon" } as NodeJS.ProcessEnv,
        [],
      ).dbLivenessMaxAgeHours,
    ).toBe(24);
  });
});

describe("graceful shutdown (stop-sigterm → SIGKILL fix)", () => {
  it("requestShutdown wakes a pending poll sleep instead of waiting out the interval", async () => {
    const exit = mock((_code: number) => {}) as unknown as (
      code: number,
    ) => never;
    const sleeping = pollSleep(60_000);
    requestShutdown("SIGTERM", exit);
    // Resolves promptly; without the wake this would run the test into its
    // timeout (the sleep is 60s).
    await sleeping;
    // The force-exit backstop must not have fired on the clean path.
    expect(exit).not.toHaveBeenCalled();
  });

  it("closeOpenHandles closes every handle and never rejects when one closer fails", async () => {
    const logger = makeLogger();
    const sshPool = mock(async () => {});
    const dbPools = mock(async () => {
      throw new Error("pool.end() exploded");
    });

    await closeOpenHandles(logger, { sshPool, dbPools });

    expect(sshPool).toHaveBeenCalledTimes(1);
    expect(dbPools).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("closeOpenHandles is silent when every closer succeeds", async () => {
    const logger = makeLogger();
    await closeOpenHandles(logger, {
      sshPool: async () => {},
      dbPools: async () => {},
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
