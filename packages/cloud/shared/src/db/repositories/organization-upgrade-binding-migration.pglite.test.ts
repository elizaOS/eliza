/** A real pre-binding quote remains unknown after migration and cannot acquire dispatch authority. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { organizationUpgradeIntentDigest } from "../../lib/services/organization-upgrade-provider-binding";
import { settlementDigest } from "../../lib/services/settlement-digest";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "./organization-upgrade-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
let client: typeof import("../client");
let legacy: Awaited<ReturnType<typeof seedOrganizationUpgradeTestAccount>>;
let quoteId: string, commandId: string;
beforeAll(async () => {
  client = await import("../client");
  const db = client.getPgliteClientForTests();
  await installOrganizationUpgradeTestSchema((q) => db.exec(q), false);
  legacy = await seedOrganizationUpgradeTestAccount();
  quoteId = randomUUID();
  commandId = randomUUID();
  const sourceDigest = settlementDigest(legacy.captured),
    reviewDigest = settlementDigest(legacy.review);
  await db.query(
    `INSERT INTO organization_plan_change_quotes(id,organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,review,created_at,expires_at)
 VALUES($1,$2,$3,$4,1,'pro_monthly','v1',$5,$6,$7,clock_timestamp(),$8)`,
    [
      quoteId,
      legacy.input.organizationId,
      legacy.input.actorId,
      legacy.input.subscriptionId,
      sourceDigest,
      reviewDigest,
      legacy.review,
      legacy.review.expiresAt,
    ],
  );
  const digest = organizationUpgradeIntentDigest({
    organizationId: legacy.input.organizationId,
    actorId: legacy.input.actorId,
    quoteId,
    reviewDigest,
    sourceDigest,
    providerBinding: null,
  });
  await db.query(
    `INSERT INTO billing_subscription_commands(id,organization_id,requested_by_user_id,subscription_id,expected_subscription_revision,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest,organization_upgrade_dispatch_state)
 VALUES($1,$2,$3,$4,1,'upgrade','pro_monthly',$5,$5,$6,'ready')`,
    [
      commandId,
      legacy.input.organizationId,
      legacy.input.actorId,
      legacy.input.subscriptionId,
      randomUUID(),
      digest,
    ],
  );
  await db.query(
    "UPDATE organization_plan_change_quotes SET consumed_by_command_id=$2,consumed_at=clock_timestamp() WHERE id=$1",
    [quoteId, commandId],
  );
  const migration = await readFile(
    new URL("../migrations/0514_organization_upgrade_quote_binding.sql", import.meta.url),
    "utf8",
  );
  for (const q of migration.split("--> statement-breakpoint")) if (q.trim()) await db.exec(q);
}, 120000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
test("migration does not fabricate price identity and runtime retires only the unstarted command", async () => {
  const db = client.getPgliteClientForTests();
  expect(
    (
      await db.query("SELECT provider_binding FROM organization_plan_change_quotes WHERE id=$1", [
        quoteId,
      ])
    ).rows[0],
  ).toEqual({ provider_binding: null });
  await expect(
    db.query("UPDATE organization_plan_change_quotes SET provider_binding=$2 WHERE id=$1", [
      quoteId,
      legacy.providerBinding,
    ]),
  ).rejects.toThrow();
  const execution = await import("./organization-upgrade-execution");
  expect(
    await execution.claimOrganizationUpgrade({
      organizationId: legacy.input.organizationId,
      actorId: legacy.input.actorId,
      commandId,
    }),
  ).toBeNull();
  expect(
    (
      await db.query(
        "SELECT status,provider_started_at FROM billing_subscription_commands WHERE id=$1",
        [commandId],
      )
    ).rows[0],
  ).toEqual({ status: "SUPERSEDED", provider_started_at: null });
});
