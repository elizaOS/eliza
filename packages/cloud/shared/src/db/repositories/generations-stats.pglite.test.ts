/**
 * Proves generation credit stats against PGlite: video renders whose pending
 * hold the reconcile sweep refunded (`refunded` / `refunded_expired`) keep their
 * quoted `credits` on the row, but the organization was not charged for them,
 * so they must not count toward reported credits. Conservatively charged
 * submission-unknown failures and completed renders still count.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";

let client: typeof import("../client");
let generations: typeof import("./generations");

const ORG = "73000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  client = await import("../client");
  generations = await import("./generations");
  const pglite = client.getPgliteClientForTests();
  await pglite.exec(`
    CREATE TABLE generations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      type text NOT NULL,
      status text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      credits numeric(10, 2) NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now()
    );
  `);
  await pglite.query(
    `INSERT INTO generations(organization_id, type, status, metadata, credits) VALUES
       ($1, 'video', 'completed', '{}', 10),
       ($1, 'video', 'completed', '{"settlement_state":"charged"}', 20),
       ($1, 'video', 'failed', '{"settlement_state":"refunded"}', 30),
       ($1, 'video', 'failed', '{"settlement_state":"refunded_expired"}', 40),
       ($1, 'video', 'failed', '{"settlement_state":"charged_unverified"}', 5),
       ($1, 'image', 'completed', '{}', 2)`,
    [ORG],
  );
}, 120_000);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

describe("generationsRepository.getStats credits", () => {
  test("excludes refunded video holds from total and per-type credits", async () => {
    const stats = await generations.generationsRepository.getStats(ORG);

    expect(stats.totalCredits).toBe(37);
    expect(stats.byType.find((entry) => entry.type === "video")).toEqual({
      type: "video",
      count: 5,
      totalCredits: 35,
    });
    expect(stats.failedGenerations).toBe(3);
  });
});
