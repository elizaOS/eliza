/**
 * Cron wiring test for #11058: the Worker `scheduled()` handler must fan out
 * to /api/cron/reclaim-stale-domains, whose handler calls
 * `managedDomainsService.releaseStaleUnverifiedExternals` with the configured
 * TTL (48h default, MANAGED_DOMAIN_UNVERIFIED_TTL_MS override).
 *
 * The scheduled handler is driven for real (makeCronHandler + the real
 * CRON_FANOUT + the real route module); only the service function is spied.
 * Reverting either the CRON_FANOUT entry or the route's service call turns
 * these red.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { Bindings } from "@/types/cloud-worker-env";

// Mock the whole service module so the route never pulls the real db client
// chain (same pattern as domains-buy-credit-debit.test.ts). The spy mirrors
// the real signature: releaseStaleUnverifiedExternals(olderThanMs) -> count.
const releaseStaleUnverifiedExternals = mock(async (_olderThanMs: number) => 3);
mock.module("@/lib/services/managed-domains", () => ({
  releaseStaleUnverifiedExternals,
  managedDomainsService: { releaseStaleUnverifiedExternals },
}));

const { CRON_FANOUT, makeCronHandler } = await import(
  "@/lib/cron/cloudflare-cron"
);
const reclaimRoute = (await import("../cron/reclaim-stale-domains/route"))
  .default;

const RECLAIM_PATH = "/api/cron/reclaim-stale-domains";
const SCHEDULE = "0 3 * * *";
const CRON_SECRET = "test-cron-secret";
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

function makeEnv(extra: Record<string, string> = {}): Bindings {
  return { CRON_SECRET, ...extra } as Bindings;
}

/** Fire the real scheduled() handler at SCHEDULE against an app hosting the reclaim route. */
async function fireScheduled(env: Bindings): Promise<void> {
  const app = new Hono();
  app.route(RECLAIM_PATH, reclaimRoute);
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
  releaseStaleUnverifiedExternals.mockClear();
});

describe("reclaim-stale-domains cron wiring (#11058)", () => {
  test("CRON_FANOUT registers the reclaim path on the daily 3am schedule", () => {
    expect(CRON_FANOUT[SCHEDULE]).toContain(RECLAIM_PATH);
  });

  test("scheduled() fires the sweep with the default 48h TTL", async () => {
    await fireScheduled(makeEnv());
    expect(releaseStaleUnverifiedExternals).toHaveBeenCalledTimes(1);
    expect(releaseStaleUnverifiedExternals).toHaveBeenCalledWith(
      DEFAULT_TTL_MS,
    );
  });

  test("MANAGED_DOMAIN_UNVERIFIED_TTL_MS overrides the TTL", async () => {
    const seventyTwoHoursMs = 72 * 60 * 60 * 1000;
    await fireScheduled(
      makeEnv({ MANAGED_DOMAIN_UNVERIFIED_TTL_MS: String(seventyTwoHoursMs) }),
    );
    expect(releaseStaleUnverifiedExternals).toHaveBeenCalledTimes(1);
    expect(releaseStaleUnverifiedExternals).toHaveBeenCalledWith(
      seventyTwoHoursMs,
    );
  });

  test("an invalid TTL override falls back to the 48h default", async () => {
    await fireScheduled(
      makeEnv({ MANAGED_DOMAIN_UNVERIFIED_TTL_MS: "not-a-number" }),
    );
    expect(releaseStaleUnverifiedExternals).toHaveBeenCalledWith(
      DEFAULT_TTL_MS,
    );
  });

  test("a request without the cron secret is rejected and never reaches the service", async () => {
    const app = new Hono();
    app.route(RECLAIM_PATH, reclaimRoute);
    const res = await app.fetch(
      new Request(`http://internal${RECLAIM_PATH}`, { method: "POST" }),
      makeEnv(),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(releaseStaleUnverifiedExternals).not.toHaveBeenCalled();
  });
});
