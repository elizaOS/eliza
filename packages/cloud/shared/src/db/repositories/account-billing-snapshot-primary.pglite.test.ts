/** Exercises the production primary snapshot against migrated PGlite rows; independent PostgreSQL sessions own concurrent-commit coverage. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
let database: typeof import("../client");
beforeAll(async () => {
  database = await import("../client");
  const pglite = database.getPgliteClientForTests();
  // PGlite has no independent backend sessions. The shared fixture retains
  // identical migrated rows while its pause function returns immediately.
  await createBillingSnapshotFixture((query) => pglite.exec(query), "");
}, 120_000);
afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});
test("the full primary reader and public projection preserve source and exact amounts", async () => {
  const { readPrimaryAccountBillingSnapshot } = await import("./account-billing-snapshot");
  const { buildOrganizationSubscriptionSnapshot } = await import(
    "../../lib/services/account-subscription-snapshot"
  );
  const snapshot = await readPrimaryAccountBillingSnapshot("61000000-0000-4000-8000-000000000001");
  expect(snapshot.organization).toMatchObject({ creditBalance: "10.000001", balanceRevision: "1" });
  expect(
    buildOrganizationSubscriptionSnapshot(snapshot.subscription, snapshot.observedAt),
  ).toMatchObject({
    status: "available",
    value: {
      lifecycleRevision: "1",
      cancelAtPeriodEnd: false,
      allowance: { status: "available", value: { unreserved: "25.000001" } },
    },
  });
}, 120_000);
