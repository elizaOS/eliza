/**
 * Runs the container health sweep the health-check cron drives against a
 * PGlite containers table with a stubbed fetch: a transient failure must be
 * re-probed up to the configured threshold, and an unreachable container must
 * be marked failed without aborting the sweep for the others.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const client = new PGlite();
const db = drizzle(client);
mock.module("../../db/client", () => ({ dbRead: db, dbWrite: db }));

const { monitorAllContainers } = await import("./health-monitor");

const FLAKY = "11111111-1111-4111-8111-111111111111";
const DOWN = "22222222-2222-4222-8222-222222222222";
const HEALTHY = "33333333-3333-4333-8333-333333333333";
const CRON_CONFIG = {
  checkIntervalMs: 60000,
  timeout: 10000,
  unhealthyThreshold: 3,
  retryOnFailure: true,
};
const realFetch = globalThis.fetch;

await client.exec(`
  CREATE TABLE containers (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    load_balancer_url text,
    health_check_path text,
    last_health_check timestamp,
    error_message text,
    updated_at timestamp
  );
`);

beforeEach(async () => {
  await client.exec("DELETE FROM containers");
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await client.close();
});

async function insertRunning(id: string, host: string) {
  await client.query(
    "INSERT INTO containers (id, status, load_balancer_url, health_check_path) VALUES ($1, 'running', $2, '/health')",
    [id, `https://${host}.apps.example`],
  );
}

async function statusOf(id: string) {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM containers WHERE id = $1",
    [id],
  );
  return result.rows[0]?.status;
}

test("re-probes a transient failure before marking a container failed", async () => {
  await insertRunning(FLAKY, "flaky");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("x", { status: calls === 1 ? 503 : 200 });
  }) as unknown as typeof fetch;

  await monitorAllContainers(CRON_CONFIG);

  expect(await statusOf(FLAKY)).toBe("running");
  expect(calls).toBe(2);
});

test("marks a container failed after the threshold of failed probes", async () => {
  await insertRunning(FLAKY, "flaky");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("x", { status: 503 });
  }) as unknown as typeof fetch;

  await monitorAllContainers(CRON_CONFIG);

  expect(await statusOf(FLAKY)).toBe("failed");
  expect(calls).toBe(3);
});

test("an unreachable container is marked failed without aborting the sweep", async () => {
  await insertRunning(DOWN, "down");
  await insertRunning(HEALTHY, "healthy");
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("down.apps.example")) {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const results = await monitorAllContainers(CRON_CONFIG);

  expect(results.map((r) => [r.containerId, r.healthy]).sort()).toEqual(
    [
      [DOWN, false],
      [HEALTHY, true],
    ].sort(),
  );
  expect(await statusOf(DOWN)).toBe("failed");
  expect(await statusOf(HEALTHY)).toBe("running");
});
