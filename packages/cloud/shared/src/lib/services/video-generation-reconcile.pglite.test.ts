/**
 * The pending-settlement sweep must give every pending video a turn. A row the
 * sweep cannot settle (unusable payload, unknown provider, probe that keeps
 * failing) stays pending; if those rows fill the batch, newer rows behind them
 * are never probed, never charged and never refunded.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";

const ORG = "74000000-0000-4000-8000-000000000001";
const probed: string[] = [];
mock.module("../providers/video/registry", () => ({
  findVideoProvider: (billingSource: string) =>
    billingSource === "fal"
      ? {
          async getJobStatus({ requestId }: { requestId: string }) {
            probed.push(requestId);
            if (requestId === "job-unreachable") throw new Error("upstream 503");
            return { state: "pending" as const };
          },
        }
      : undefined,
}));

let client: typeof import("../../db/client");
let reconcile: typeof import("./video-generation-reconcile");

beforeAll(async () => {
  client = await import("../../db/client");
  const schemas = await import("../../db/schemas");
  const pglite = client.getPgliteClientForTests();
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson({ generations: schemas.generations }, empty.id),
  )) {
    if (/REFERENCES "/.test(statement)) continue;
    await pglite.exec(statement.replaceAll('"public".', ""));
  }
  reconcile = await import("./video-generation-reconcile");

  const settlement = (billingSource: string) =>
    JSON.stringify({
      settlement_marker: "video_pending_settlement_v1",
      reservation_transaction_id: "11111111-0000-4000-8000-000000000001",
      reserved_amount: 1.5,
      billed_cost: 1.5,
      billing_source: billingSource,
    });
  // Oldest first: a row with no settlement payload, a row whose probe keeps
  // failing, then a healthy pending row behind them.
  await pglite.query(
    `INSERT INTO generations(organization_id, type, status, model, provider, prompt, job_id, metadata, created_at, updated_at) VALUES
       ($1, 'video', 'pending', 'fal/video', 'fal', 'a cat', 'job-no-payload', '{"settlement_marker":"video_pending_settlement_v1"}', now() - interval '30 minutes', now() - interval '30 minutes'),
       ($1, 'video', 'pending', 'fal/video', 'fal', 'a dog', 'job-unreachable', $2, now() - interval '20 minutes', now() - interval '20 minutes'),
       ($1, 'video', 'pending', 'fal/video', 'fal', 'a bird', 'job-healthy', $3, now() - interval '10 minutes', now() - interval '10 minutes')`,
    [ORG, settlement("fal"), settlement("fal")],
  );
}, 120_000);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

test("rows the sweep cannot settle do not keep newer pending videos from being probed", async () => {
  const first = await reconcile.reconcilePendingVideoGenerations({ apiKeys: {}, batchSize: 2 });
  expect(first).toMatchObject({ scanned: 2, skipped: 2, stillPending: 0 });
  expect(probed).toEqual(["job-unreachable"]);

  // Next tick: the two stuck rows must rotate to the back so the healthy row gets its turn.
  const second = await reconcile.reconcilePendingVideoGenerations({ apiKeys: {}, batchSize: 2 });
  expect(second.stillPending).toBe(1);
  expect(probed).toContain("job-healthy");

  // Nothing was refunded blind: the stuck rows are still pending.
  const rows = await client
    .getPgliteClientForTests()
    .query<{ job_id: string; status: string }>(
      "SELECT job_id, status FROM generations ORDER BY created_at",
    );
  expect(rows.rows.map((row) => `${row.job_id}:${row.status}`)).toEqual([
    "job-no-payload:pending",
    "job-unreachable:pending",
    "job-healthy:pending",
  ]);
});
