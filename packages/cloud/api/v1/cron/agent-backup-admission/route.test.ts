/**
 * Exercises the V3 backup-admission route through the real in-process cron
 * dispatcher while replacing only the admission runtime with a typed fake.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { CRON_FANOUT, makeCronHandler } from "@/lib/cron/cloudflare-cron";
import {
  AgentBackupAdmissionDeadlineError,
  type AgentBackupAdmissionRuntimeSummary,
} from "@/lib/services/agent-backup-admission-runtime";
import type { Bindings } from "@/types/cloud-worker-env";
import {
  AGENT_BACKUP_ADMISSION_CALLER_PATH,
  AGENT_BACKUP_ADMISSION_CALLER_SCHEDULE,
  type AgentBackupAdmissionCronDependencies,
  createAgentBackupAdmissionCronRoute,
} from "./route";

const CRON_SECRET = "backup-admission-test-secret";
const SCHEDULED_TIME = Date.UTC(2026, 7, 28, 12, 34, 0);

function summary(): AgentBackupAdmissionRuntimeSummary {
  return {
    enrollmentTurns: 64,
    enrollmentUnavailable: 0,
    enrollmentCompletedShards: 64,
    enrolled: 2,
    queued: 2,
    cohortsComplete: 64,
    claimTurns: 3,
    claimClaimedTurns: 1,
    claimProgressedTurns: 1,
    claimContendedTurns: 0,
    claimIdleTurns: 1,
    claimed: 1,
    reserved: 1,
    replayed: 0,
    deferred: 0,
    retryExhausted: 0,
    indeterminate: 0,
    stopReason: "idle",
    continuationRequired: false,
    retryAfterMs: null,
    alerts: [],
  };
}

function fakeDependencies(
  implementation: AgentBackupAdmissionCronDependencies["run"] = async () =>
    summary(),
) {
  const run = mock(implementation);
  return {
    run,
    dependencies: { run } satisfies AgentBackupAdmissionCronDependencies,
  };
}

function env(enabled?: string): Bindings {
  return {
    CRON_SECRET,
    NEXT_PUBLIC_APP_URL: "https://internal.example.test",
    AGENT_BACKUP_ADMISSION_CALLER_ENABLED: enabled,
  } as Bindings;
}

interface ScheduledDispatch {
  completion: Promise<void>;
  noRetry: () => boolean;
  response: () => Response | undefined;
}

async function dispatchScheduled(
  dependencies: AgentBackupAdmissionCronDependencies,
  bindings: Bindings,
  scheduledTime = SCHEDULED_TIME,
): Promise<ScheduledDispatch> {
  const app = new Hono();
  app.route(
    AGENT_BACKUP_ADMISSION_CALLER_PATH,
    createAgentBackupAdmissionCronRoute(dependencies),
  );

  let targetResponse: Response | undefined;
  let noRetry = false;
  const pending: Promise<unknown>[] = [];
  const scheduled = makeCronHandler(async (request, workerEnv, context) => {
    if (new URL(request.url).pathname !== AGENT_BACKUP_ADMISSION_CALLER_PATH) {
      return new Response(null, { status: 204 });
    }
    targetResponse = await app.fetch(request, workerEnv, context);
    return targetResponse;
  });

  await scheduled(
    {
      cron: AGENT_BACKUP_ADMISSION_CALLER_SCHEDULE,
      scheduledTime,
      noRetry: () => {
        noRetry = true;
      },
    },
    bindings,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => {},
    } as never,
  );
  if (pending.length !== 1) {
    throw new Error(
      `expected one fanout completion, received ${pending.length}`,
    );
  }
  return {
    completion: Promise.all(pending).then(() => undefined),
    noRetry: () => noRetry,
    response: () => targetResponse,
  };
}

async function fireScheduled(
  dependencies: AgentBackupAdmissionCronDependencies,
  bindings: Bindings,
  scheduledTime = SCHEDULED_TIME,
): Promise<Response> {
  const dispatch = await dispatchScheduled(
    dependencies,
    bindings,
    scheduledTime,
  );
  await dispatch.completion;
  const response = dispatch.response();
  if (!response) throw new Error("backup admission route was not fanned out");
  return response;
}

interface WranglerEnvironment {
  vars?: Record<string, unknown>;
}

interface WranglerConfig {
  vars?: Record<string, unknown>;
  env?: {
    staging?: WranglerEnvironment;
    production?: WranglerEnvironment;
  };
}

describe("V3 backup admission cron caller", () => {
  test("is minute-wired while the legacy six-hour caller remains intact", async () => {
    expect(CRON_FANOUT[AGENT_BACKUP_ADMISSION_CALLER_SCHEDULE]).toContain(
      AGENT_BACKUP_ADMISSION_CALLER_PATH,
    );
    expect(CRON_FANOUT["0 */6 * * *"]).toContain("/api/v1/cron/agent-backups");

    const router = await Bun.file(
      new URL("../../../src/_router.generated.ts", import.meta.url),
    ).text();
    expect(router).toContain('path: "/api/v1/cron/agent-backup-admission"');
  });

  test("commits an explicit OFF binding in every Worker environment", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../../../wrangler.toml", import.meta.url)).text(),
    ) as WranglerConfig;
    expect([
      config.vars?.AGENT_BACKUP_ADMISSION_CALLER_ENABLED,
      config.env?.staging?.vars?.AGENT_BACKUP_ADMISSION_CALLER_ENABLED,
      config.env?.production?.vars?.AGENT_BACKUP_ADMISSION_CALLER_ENABLED,
    ]).toEqual(["0", "0", "0"]);
  });

  test("authenticates before any work and exposes no GET caller", async () => {
    const { run, dependencies } = fakeDependencies();
    const app = new Hono();
    app.route(
      AGENT_BACKUP_ADMISSION_CALLER_PATH,
      createAgentBackupAdmissionCronRoute(dependencies),
    );

    for (const headers of [undefined, { "x-cron-secret": "incorrect" }]) {
      const response = await app.fetch(
        new Request(
          `https://internal.example.test${AGENT_BACKUP_ADMISSION_CALLER_PATH}`,
          { method: "POST", headers },
        ),
        env("1"),
      );
      expect(response.status).toBe(401);
    }

    const get = await app.fetch(
      new Request(
        `https://internal.example.test${AGENT_BACKUP_ADMISSION_CALLER_PATH}`,
        {
          method: "GET",
          headers: { "x-cron-secret": CRON_SECRET },
        },
      ),
      env("1"),
    );
    expect(get.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  test("rejects a signed external POST even with exact scheduler headers", async () => {
    const { run, dependencies } = fakeDependencies();
    const app = new Hono();
    app.route(
      AGENT_BACKUP_ADMISSION_CALLER_PATH,
      createAgentBackupAdmissionCronRoute(dependencies),
    );
    const response = await app.fetch(
      new Request(
        `https://internal.example.test${AGENT_BACKUP_ADMISSION_CALLER_PATH}`,
        {
          method: "POST",
          headers: {
            "x-cron-secret": CRON_SECRET,
            "x-cron-invocation-id": "forged",
            "x-cron-schedule": AGENT_BACKUP_ADMISSION_CALLER_SCHEDULE,
            "x-cron-scheduled-time": String(SCHEDULED_TIME),
          },
        },
      ),
      env("1"),
    );

    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  test("stays disabled unless the scheduler sees the exact value 1", async () => {
    for (const value of [undefined, "0", "true", "1 "]) {
      const { run, dependencies } = fakeDependencies();
      const response = await fireScheduled(dependencies, env(value));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        enabled: false,
        scheduledTime: SCHEDULED_TIME,
      });
      expect(run).not.toHaveBeenCalled();
    }
  });

  test("uses a deterministic scheduler-derived owner and returns accounting", async () => {
    const { run, dependencies } = fakeDependencies();
    const first = await fireScheduled(dependencies, env("1"));
    const retry = await fireScheduled(dependencies, env("1"));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
    for (const call of run.mock.calls) {
      expect(call[0]?.ownerId).toBe(`agent-backup-admission:${SCHEDULED_TIME}`);
      expect(call[0]?.scheduledTime).toBe(SCHEDULED_TIME);
      expect(call[0]?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(await first.json()).toMatchObject({
      success: true,
      enabled: true,
      scheduledTime: SCHEDULED_TIME,
      reserved: 1,
      stopReason: "idle",
      continuationRequired: false,
      alerts: [],
    });
  });

  test("records a runtime failure without replaying the shared fanout", async () => {
    const { dependencies } = fakeDependencies(async () => {
      throw new Error("database unavailable");
    });
    const dispatch = await dispatchScheduled(dependencies, env("1"));

    await expect(dispatch.completion).rejects.toThrow(
      `[Cron] ${AGENT_BACKUP_ADMISSION_CALLER_PATH} -> 500`,
    );
    expect(dispatch.noRetry()).toBe(true);
    const response = dispatch.response();
    if (!response) throw new Error("backup admission route was not fanned out");
    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(body).toEqual({
      success: false,
      error: "Backup admission caller failed",
    });
  });

  test("records an expired scheduled deadline without replaying the shared fanout", async () => {
    const deadlineAt = SCHEDULED_TIME + 45_000;
    const { dependencies } = fakeDependencies(async () => {
      throw new AgentBackupAdmissionDeadlineError(deadlineAt, deadlineAt);
    });
    const dispatch = await dispatchScheduled(dependencies, env("1"));

    await expect(dispatch.completion).rejects.toThrow(
      `[Cron] ${AGENT_BACKUP_ADMISSION_CALLER_PATH} -> 500`,
    );
    expect(dispatch.noRetry()).toBe(true);
    const response = dispatch.response();
    if (!response) throw new Error("backup admission route was not fanned out");
    expect(response.status).toBe(500);
  });
});
