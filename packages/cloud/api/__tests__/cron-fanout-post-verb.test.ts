/**
 * Generic cron-wiring guard (#22508).
 *
 * `makeCronHandler` dispatches every fanned-out path with `method: "POST"`, so
 * a route that only registers `app.get("/")` 404s on every scheduled tick and
 * the job silently never runs. Three routes had been failing that way in
 * production (cleanup-webhook-events,
 * compute-metrics) plus cleanup-expired-crypto-payments, because no test
 * asserted the invariant across the whole map.
 *
 * This drives the REAL dispatcher over the REAL `CRON_FANOUT` against the REAL
 * route modules, and asserts no path answers 404. The env deliberately carries
 * no CRON_SECRET, so `requireCronSecret` fails closed inside every handler
 * before it can touch a service or the database — the only thing under test is
 * whether Hono matched the POST.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { CRON_FANOUT, makeCronHandler } from "@/lib/cron/cloudflare-cron";
import type { Bindings } from "@/types/cloud-worker-env";

const FANOUT_PATHS = [...new Set(Object.values(CRON_FANOUT).flat())].sort();

/** `/api/v1/cron/health-check` -> `../v1/cron/health-check/route` */
function moduleSpecifier(path: string): string {
  return `../${path.replace(/^\/api\//, "")}/route`;
}

/** Every fanout path mounted at its own path on one Hono app, as the Worker does. */
async function mountFanoutApp(): Promise<Hono> {
  const app = new Hono();
  for (const path of FANOUT_PATHS) {
    const mod = await import(moduleSpecifier(path));
    app.route(path, mod.default);
  }
  return app;
}

/**
 * Fire the real scheduled() handler for every schedule and return the status
 * each dispatched path answered with.
 */
async function dispatchEverySchedule(): Promise<Map<string, number>> {
  const app = await mountFanoutApp();
  const statuses = new Map<string, number>();
  // No CRON_SECRET: every handler fails closed at requireCronSecret, so no
  // service or db is reached. A 404 can then only mean "verb not registered".
  const env = {} as Bindings;
  const scheduled = makeCronHandler(async (req, e, ctx) => {
    const res = await app.fetch(req, e, ctx);
    statuses.set(new URL(req.url).pathname, res.status);
    return res;
  });

  for (const cron of Object.keys(CRON_FANOUT)) {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
    };
    await scheduled({ cron, scheduledTime: Date.now() }, env, ctx as never);
    await Promise.all(pending);
  }
  return statuses;
}

describe("CRON_FANOUT POST-verb guard (#22508)", () => {
  test("every fanned-out path answers the dispatcher's POST", async () => {
    const statuses = await dispatchEverySchedule();

    // Nothing may be skipped: a path the dispatcher never reached would hide a
    // 404 behind an empty result.
    expect([...statuses.keys()].sort()).toEqual(FANOUT_PATHS);

    const notFound = [...statuses.entries()]
      .filter(([, status]) => status === 404)
      .map(([path]) => path)
      .sort();
    expect(notFound).toEqual([]);
  });

  test("the guard's fail-closed env keeps handlers off the database", async () => {
    const statuses = await dispatchEverySchedule();
    // Every route rejects the secret-less dispatch (403 from
    // requireCronSecret, 503 from routes that check CRON_SECRET themselves),
    // proving each handler stopped at the auth gate rather than doing work.
    const succeeded = [...statuses.entries()]
      .filter(([, status]) => status < 400)
      .map(([path, status]) => `${path} -> ${status}`)
      .sort();
    expect(succeeded).toEqual([]);
  });
});
