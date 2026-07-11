/**
 * Cron wiring test for #16071: the Worker `scheduled()` handler must fan out
 * to /api/cron/gc-stranded-sandbox-keys on the 6-hourly schedule, whose handler
 * calls the stranded-key sweeper with a cutoff of
 * `now - graceMs` (6h default, STRANDED_SANDBOX_KEY_GRACE_MS override).
 *
 * The scheduled handler is driven for real (makeCronHandler + the real
 * CRON_FANOUT + the real route module); only the service function is spied.
 * Reverting either the CRON_FANOUT entry or the route's service call turns
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
import { strandedAgentKeySweeper } from "@/lib/services/stranded-agent-key-sweeper";
import type { Bindings } from "@/types/cloud-worker-env";

const sweepStrandedAgentKeys = mock(async (_olderThan: Date) => 2);
const sweepSpy = spyOn(strandedAgentKeySweeper, "sweep").mockImplementation(
  sweepStrandedAgentKeys,
);

afterAll(() => sweepSpy.mockRestore());

const { CRON_FANOUT, makeCronHandler } = await import(
  "@/lib/cron/cloudflare-cron"
);
const gcRoute = (await import("../cron/gc-stranded-sandbox-keys/route"))
  .default;

const GC_PATH = "/api/cron/gc-stranded-sandbox-keys";
const SCHEDULE = "0 */6 * * *";
const CRON_SECRET = "test-cron-secret";
const DEFAULT_GRACE_MS = 6 * 60 * 60 * 1000;

function makeEnv(extra: Record<string, string> = {}): Bindings {
  return { CRON_SECRET, ...extra } as Bindings;
}

/** Fire the real scheduled() handler at SCHEDULE against an app hosting the gc route. */
async function fireScheduled(env: Bindings): Promise<void> {
  const app = new Hono();
  app.route(GC_PATH, gcRoute);
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

/** The single Date the sweep was last called with. */
function lastCutoff(): Date {
  const call = sweepStrandedAgentKeys.mock.calls.at(-1);
  if (!call) throw new Error("sweepStrandedAgentKeys was never called");
  return call[0];
}

beforeEach(() => {
  sweepStrandedAgentKeys.mockClear();
});

describe("gc-stranded-sandbox-keys cron wiring (#16071)", () => {
  test("CRON_FANOUT registers the gc path on the 6-hourly schedule", () => {
    expect(CRON_FANOUT[SCHEDULE]).toContain(GC_PATH);
  });

  test("scheduled() fires the sweep with a now-minus-6h default cutoff", async () => {
    const before = Date.now();
    await fireScheduled(makeEnv());
    const after = Date.now();

    expect(sweepStrandedAgentKeys).toHaveBeenCalledTimes(1);
    const cutoffMs = lastCutoff().getTime();
    // cutoff == startedAt - 6h, where startedAt is captured inside the handler
    // between `before` and `after`.
    expect(cutoffMs).toBeGreaterThanOrEqual(before - DEFAULT_GRACE_MS);
    expect(cutoffMs).toBeLessThanOrEqual(after - DEFAULT_GRACE_MS);
  });

  test("STRANDED_SANDBOX_KEY_GRACE_MS overrides the grace window", async () => {
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const before = Date.now();
    await fireScheduled(
      makeEnv({ STRANDED_SANDBOX_KEY_GRACE_MS: String(twelveHoursMs) }),
    );
    const after = Date.now();

    expect(sweepStrandedAgentKeys).toHaveBeenCalledTimes(1);
    const cutoffMs = lastCutoff().getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - twelveHoursMs);
    expect(cutoffMs).toBeLessThanOrEqual(after - twelveHoursMs);
  });

  test("an invalid grace override falls back to the 6h default", async () => {
    const before = Date.now();
    await fireScheduled(
      makeEnv({ STRANDED_SANDBOX_KEY_GRACE_MS: "not-a-number" }),
    );
    const after = Date.now();

    const cutoffMs = lastCutoff().getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - DEFAULT_GRACE_MS);
    expect(cutoffMs).toBeLessThanOrEqual(after - DEFAULT_GRACE_MS);
  });

  test("a request without the cron secret is rejected and never reaches the service", async () => {
    const app = new Hono();
    app.route(GC_PATH, gcRoute);
    const res = await app.fetch(
      new Request(`http://internal${GC_PATH}`, { method: "POST" }),
      makeEnv(),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sweepStrandedAgentKeys).not.toHaveBeenCalled();
  });
});
