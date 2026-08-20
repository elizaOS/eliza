/**
 * Cron wiring test for #22508: /api/cron/cleanup-cli-sessions existed and was
 * mounted by the route codegen but was absent from `CRON_FANOUT` — the only
 * map `makeCronHandler` reads — so nothing ever called it and expired CLI auth sessions
 * accumulated forever. It also only registered GET, while the Worker's
 * `scheduled()` dispatcher fans out with POST.
 *
 * The scheduled handler is driven for real (makeCronHandler + the real
 * CRON_FANOUT + the real route module); only the service function is spied.
 * Dropping the CRON_FANOUT entry, or dropping the route's `app.post`, turns
 * these red.
 */

import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Hono } from "hono";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import type { Bindings } from "@/types/cloud-worker-env";

const cleanupExpiredSessions = mock(async () => {});
const cleanupSpy = spyOn(
  cliAuthSessionsService,
  "cleanupExpiredSessions",
).mockImplementation(cleanupExpiredSessions);

afterAll(() => cleanupSpy.mockRestore());

const { CRON_FANOUT, makeCronHandler } = await import(
  "@/lib/cron/cloudflare-cron"
);
const cleanupRoute = (await import("../cron/cleanup-cli-sessions/route"))
  .default;

const CLEANUP_PATH = "/api/cron/cleanup-cli-sessions";
const SCHEDULE = "0 */6 * * *";
const CRON_SECRET = "test-cron-secret";

function makeEnv(): Bindings {
  return { CRON_SECRET } as Bindings;
}

function mountCleanupApp(): Hono {
  const app = new Hono();
  app.route(CLEANUP_PATH, cleanupRoute);
  return app;
}

/** Fire the real scheduled() handler at SCHEDULE against an app hosting the cleanup route. */
async function fireScheduled(env: Bindings): Promise<void> {
  const app = mountCleanupApp();
  const scheduled = makeCronHandler((req, e, ctx) => app.fetch(req, e, ctx));
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  };
  await scheduled(
    { cron: SCHEDULE, scheduledTime: Date.now() },
    env,
    ctx as never,
  );
  await Promise.all(pending);
}

beforeEach(() => {
  cleanupExpiredSessions.mockClear();
});

describe("cleanup-cli-sessions cron wiring (#22508)", () => {
  test("CRON_FANOUT registers the cleanup path on the 6-hourly schedule", () => {
    expect(CRON_FANOUT[SCHEDULE]).toContain(CLEANUP_PATH);
  });

  test("scheduled() reaches the route and sweeps expired CLI sessions", async () => {
    await fireScheduled(makeEnv());
    expect(cleanupExpiredSessions).toHaveBeenCalledTimes(1);
  });

  test("the route answers the dispatcher's POST as well as GET", async () => {
    const app = mountCleanupApp();
    for (const method of ["GET", "POST"] as const) {
      const res = await app.fetch(
        new Request(`http://internal${CLEANUP_PATH}`, {
          method,
          headers: { "x-cron-secret": CRON_SECRET },
        }),
        makeEnv(),
      );
      expect(res.status).toBe(200);
    }
    expect(cleanupExpiredSessions).toHaveBeenCalledTimes(2);
  });

  test("a request without the cron secret is rejected and never reaches the service", async () => {
    const app = mountCleanupApp();
    const res = await app.fetch(
      new Request(`http://internal${CLEANUP_PATH}`, { method: "POST" }),
      makeEnv(),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(cleanupExpiredSessions).not.toHaveBeenCalled();
  });
});
