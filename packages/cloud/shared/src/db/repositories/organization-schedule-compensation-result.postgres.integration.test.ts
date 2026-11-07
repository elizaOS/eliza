/** Real PostgreSQL schedule effect fencing. These tests perform no provider writes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { OrganizationScheduleEffectReceipt } from "../../lib/services/organization-schedule-effect-contract";
import { seedOrganizationDowngradeTestAccount } from "./organization-downgrade-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `schedule_compensation_result_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
let repo: typeof import("./organization-schedule-effects");
async function seed(validityMs = 60000) {
  const f = await seedOrganizationDowngradeTestAccount((q, v) => db.query(q, v), validityMs);
  const { prepareOrganizationDowngrade } = await import("./organization-downgrade-commands");
  const prepared = await prepareOrganizationDowngrade({
    ...f.input,
    quoteId: f.quote.id,
    idempotencyKey: randomUUID(),
  });
  const identity = {
    organizationId: f.input.organizationId,
    actorId: f.input.actorId,
    commandId: prepared.command.id,
  };
  return { ...f, identity };
}
async function claimed(validityMs = 60000) {
  const f = await seed(validityMs),
    result = await repo.claimOrganizationSchedule(f.identity);
  if (!result) throw new Error("Fixture claim unavailable");
  return { ...f, ...result };
}
function receipt(
  f: Awaited<ReturnType<typeof claimed>>,
  effect = f.effect,
  scheduleId = "sub_sched_original",
): OrganizationScheduleEffectReceipt {
  return {
    kind: "response",
    scheduleId,
    customerId: effect.customer_id,
    subscriptionId: effect.subscription_id,
    livemode: effect.livemode,
    apiVersion: "2024-11-20.acacia",
    providerRequestId: "req_original",
    providerIdempotencyKey: effect.provider_idempotency_key,
    eventId: null,
    evidenceDigest: "a".repeat(64),
    observedAt: new Date().toISOString(),
  };
}

async function released(observe = true) {
  const f = await claimed();
  await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
  await repo.recordOrganizationScheduleEffectReceipt(f.identity, f.claim, f.effect.id, receipt(f));
  const release = await repo.prepareOrganizationScheduleCompensation(f.identity, f.claim);
  await repo.markOrganizationScheduleCompensationDispatch(f.identity, f.claim, release.id);
  if (observe)
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      release.id,
      receipt(f, release),
    );
  const context = (
    await db.query(
      `SELECT c.receipt_digest AS create_digest,r.receipt_digest AS release_digest,t.snapshot_digest
 FROM organization_schedule_effects c JOIN organization_schedule_effects r ON r.predecessor_id=c.id
 JOIN organization_plan_change_quotes q ON q.consumed_by_command_id=c.command_id
 JOIN organization_schedule_quote_terms t ON t.quote_id=q.id WHERE c.id=$1 AND r.id=$2`,
      [f.effect.id, release.id],
    )
  ).rows[0];
  return {
    ...f,
    proof: {
      kind: "original_unconfigured_schedule_released",
      scheduleId: "sub_sched_original",
      quoteId: f.quote.id,
      createEffectId: f.effect.id,
      releaseEffectId: release.id,
      createReceiptDigest: context.create_digest,
      releaseReceiptDigest: context.release_digest ?? "d".repeat(64),
      retainedTermsDigest: context.snapshot_digest,
      sourceDigest: f.quote.source_digest,
      snapshotDigest: "b".repeat(64),
      observedAt: new Date().toISOString(),
    },
  };
}
function finish(f: Awaited<ReturnType<typeof released>>, proof: unknown = f.proof) {
  return db.query(
    `UPDATE billing_subscription_commands SET status='FAILED',error_code='ORIGINAL_SCHEDULE_CREATE_COMPENSATED',
 organization_schedule_failure_evidence=$2::jsonb,provider_response_digest=repeat('c',64),lease_token=NULL,lease_expires_at=NULL,
 state_revision=state_revision+1,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING status`,
    [f.identity.commandId, JSON.stringify(proof)],
  );
}
(url ? describe : describe.skip)("original compensation result authority", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((q) => db.query(q));
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    repo = await import("./organization-schedule-effects");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("original released receipts retire failure without changing source or projection", async () => {
    const f = await released();
    const before = await db.query(
      "SELECT to_jsonb(s) AS source FROM billing_subscriptions s WHERE id=$1",
      [f.input.subscriptionId],
    );
    const projectionBefore = (
      await db.query(
        "SELECT to_jsonb(p) AS projection FROM organization_entitlements p WHERE organization_id=$1",
        [f.identity.organizationId],
      )
    ).rows;
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    expect((await finish(f)).rows[0].status).toBe("FAILED");
    expect(
      (
        await db.query("SELECT to_jsonb(s) AS source FROM billing_subscriptions s WHERE id=$1", [
          f.input.subscriptionId,
        ])
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await db.query(
          "SELECT to_jsonb(p) AS projection FROM organization_entitlements p WHERE organization_id=$1",
          [f.identity.organizationId],
        )
      ).rows,
    ).toEqual(projectionBefore);
    await expect(
      db.query("UPDATE billing_subscription_commands SET error_code='changed' WHERE id=$1", [
        f.identity.commandId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(repo.claimOrganizationSchedule(f.identity, "recovery")).resolves.toBeNull();
  });
  test("unknown release cannot become a terminal result", async () => {
    const f = await released(false);
    await expect(finish(f)).rejects.toMatchObject({ code: "23514" });
  });
  test("missing evidence cannot retire observed effects", async () => {
    const f = await released();
    await expect(finish(f, null)).rejects.toMatchObject({ code: "23514" });
  });
  test("foreign and changed original provenance cannot become a terminal result", async () => {
    const f = await released();
    for (const changed of [
      { quoteId: randomUUID() },
      { createEffectId: randomUUID() },
      { releaseEffectId: randomUUID() },
      { scheduleId: "sub_sched_foreign" },
      { createReceiptDigest: "f".repeat(64) },
      { releaseReceiptDigest: "f".repeat(64) },
      { retainedTermsDigest: "f".repeat(64) },
      { sourceDigest: "f".repeat(64) },
      { unexpected: true },
      { observedAt: new Date(Date.now() + 60000).toISOString() },
      { observedAt: new Date(0).toISOString() },
    ]) {
      await expect(finish(f, { ...f.proof, ...changed })).rejects.toMatchObject({ code: "23514" });
    }
  });
  test("expired original lease cannot commit the result", async () => {
    const f = await released();
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.identity.commandId],
    );
    await expect(finish(f)).rejects.toMatchObject({ code: "23514" });
  });
  test("changed organization customer prevents terminal cleanup publication", async () => {
    const f = await released();
    await db.query("UPDATE organizations SET stripe_customer_id='cus_changed' WHERE id=$1", [
      f.identity.organizationId,
    ]);
    await expect(finish(f)).rejects.toMatchObject({ code: "23514" });
  });
});
