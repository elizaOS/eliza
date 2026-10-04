/**
 * Runs the container health sweep the health-check cron drives against a
 * PGlite containers table with a stubbed fetch: one unreachable container
 * must be recorded as failed without aborting the sweep for the others.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const client = new PGlite();
const db = drizzle(client);
mock.module("../../db/client", () => ({ dbRead: db, dbWrite: db }));

const { monitorAllContainers } = await import("./health-monitor");

const DOWN = "22222222-2222-4222-8222-222222222222";
const HEALTHY = "33333333-3333-4333-8333-333333333333";
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

afterAll(async () => {
  globalThis.fetch = realFetch;
  await client.close();
});

async function statusOf(id: string) {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM containers WHERE id = $1",
    [id],
  );
  return result.rows[0]?.status;
}

test("an unreachable container is marked failed without aborting the sweep", async () => {
  for (const [id, host] of [
    [DOWN, "down"],
    [HEALTHY, "healthy"],
  ]) {
    await client.query(
      "INSERT INTO containers (id, status, load_balancer_url, health_check_path) VALUES ($1, 'running', $2, '/health')",
      [id, `https://${host}.apps.example`],
    );
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("down.apps.example")) {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const results = await monitorAllContainers({ timeout: 10000 });

  expect(results.map((r) => [r.containerId, r.healthy]).sort()).toEqual(
    [
      [DOWN, false],
      [HEALTHY, true],
    ].sort(),
  );
  expect(await statusOf(DOWN)).toBe("failed");
  expect(await statusOf(HEALTHY)).toBe("running");
});
