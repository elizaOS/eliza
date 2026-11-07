/** Real PostgreSQL schedule effect fencing. These tests perform no provider writes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type {
  OrganizationScheduleEffectReceipt,
  OrganizationScheduleEffectRequest,
} from "../../lib/services/organization-schedule-effect-contract";
import { seedOrganizationDowngradeTestAccount } from "./organization-downgrade-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `schedule_dispatch_reader_${randomUUID().replaceAll("-", "_")}`;
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
function configuration(
  f: Awaited<ReturnType<typeof claimed>>,
  scheduleId = "sub_sched_original",
): Extract<OrganizationScheduleEffectRequest, { kind: "schedule_configure" }> {
  return {
    kind: "schedule_configure",
    scheduleId,
    params: {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: f.source.current_period_start.getTime() / 1000,
          end_date: f.source.current_period_end.getTime() / 1000,
          items: [{ price: "price_pro", quantity: 1 }],
          proration_behavior: "none",
        },
        {
          start_date: f.source.current_period_end.getTime() / 1000,
          iterations: 1,
          items: [{ price: "price_plus", quantity: 1 }],
          proration_behavior: "none",
        },
      ],
    },
  };
}
(url ? describe : describe.skip)("original schedule effects PostgreSQL authority", () => {
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

  test("ready source read returns only the original quote terms without publishing", async () => {
    const f = await claimed();
    const read = await repo.readOrganizationScheduleDispatchSource(
      f.identity,
      f.claim,
      f.effect.id,
    );
    expect(read.quoteId).toBe(f.quote.id);
    expect(read.retainedTerms.subscription.id).toBe(f.source.stripe_subscription_id);
    expect(read.effect.state).toBe("ready");
    expect(read.predecessor).toBeNull();
    expect(
      (
        await db.query("SELECT pending_plan_key FROM billing_subscriptions WHERE id=$1", [
          f.input.subscriptionId,
        ])
      ).rows[0].pending_plan_key,
    ).toBeNull();
  });
  test("started effects lose dispatch reads and configuration reads require observed create", async () => {
    const f = await claimed();
    await expect(
      repo.readOrganizationScheduleConfigurationSource(f.identity, f.claim, f.effect.id),
    ).rejects.toThrow();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await expect(
      repo.readOrganizationScheduleDispatchSource(f.identity, f.claim, f.effect.id),
    ).rejects.toThrow();
    await expect(
      repo.readOrganizationScheduleConfigurationSource(f.identity, f.claim, f.effect.id),
    ).rejects.toThrow();
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      f.effect.id,
      receipt(f),
    );
    const read = await repo.readOrganizationScheduleConfigurationSource(
      f.identity,
      f.claim,
      f.effect.id,
    );
    expect(read.effect.receipt?.scheduleId).toBe("sub_sched_original");
    const configured = await repo.prepareOrganizationScheduleConfiguration(
      f.identity,
      f.claim,
      configuration(f),
    );
    const dispatch = await repo.readOrganizationScheduleDispatchSource(
      f.identity,
      f.claim,
      configured.id,
    );
    expect(dispatch.predecessor?.id).toBe(f.effect.id);
    await expect(
      repo.readOrganizationScheduleConfigurationSource(f.identity, f.claim, configured.id),
    ).rejects.toThrow();
  });
  test("revoked manager and changed customer cannot read dispatch authority", async () => {
    const f = await claimed();
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    await expect(
      repo.readOrganizationScheduleDispatchSource(f.identity, f.claim, f.effect.id),
    ).rejects.toThrow();
    const g = await claimed();
    await db.query("UPDATE organizations SET stripe_customer_id='cus_changed' WHERE id=$1", [
      g.identity.organizationId,
    ]);
    await expect(
      repo.readOrganizationScheduleDispatchSource(g.identity, g.claim, g.effect.id),
    ).rejects.toThrow();
  });
  test("foreign actor or organization cannot read original retained financial context", async () => {
    const f = await claimed(),
      other = await seed();
    for (const identity of [
      { ...f.identity, actorId: other.identity.actorId },
      { ...f.identity, organizationId: other.identity.organizationId },
    ])
      await expect(
        repo.readOrganizationScheduleDispatchSource(identity, f.claim, f.effect.id),
      ).rejects.toThrow();
  });
  test("expired original lease cannot supply dispatch or configuration authority", async () => {
    const f = await claimed();
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.identity.commandId],
    );
    await expect(
      repo.readOrganizationScheduleDispatchSource(f.identity, f.claim, f.effect.id),
    ).rejects.toThrow();
    await expect(
      repo.readOrganizationScheduleConfigurationSource(f.identity, f.claim, f.effect.id),
    ).rejects.toThrow();
  });
  test("compensation survives quote expiry and manager revocation without retiring uncertainty", async () => {
    const f = await claimed(10000);
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      f.effect.id,
      receipt(f),
    );
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    await Bun.sleep(Math.max(0, f.quote.expires_at.getTime() - Date.now() + 50));
    const release = await repo.prepareOrganizationScheduleCompensation(f.identity, f.claim);
    expect(release.request_payload).toEqual({
      kind: "schedule_release",
      scheduleId: "sub_sched_original",
      params: { preserve_cancel_date: true },
    });
    expect((await repo.prepareOrganizationScheduleCompensation(f.identity, f.claim)).id).toBe(
      release.id,
    );
    await repo.markOrganizationScheduleCompensationDispatch(f.identity, f.claim, release.id);
    await expect(
      repo.markOrganizationScheduleCompensationDispatch(f.identity, f.claim, release.id),
    ).rejects.toThrow();
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      release.id,
      receipt(f, release),
    );
    expect(
      (
        await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
          f.identity.commandId,
        ])
      ).rows[0].status,
    ).toBe("OUTCOME_UNKNOWN");
    expect(
      (
        await db.query("SELECT pending_plan_key FROM billing_subscriptions WHERE id=$1", [
          f.input.subscriptionId,
        ])
      ).rows[0].pending_plan_key,
    ).toBeNull();
    // This test intentionally waits out a real ten-second quote; it must not
    // inherit Bun's five-second default when CI runs with --config=/dev/null.
  }, 30000);
  test("a ready configuration cannot dispatch after original release has been staged", async () => {
    const f = await claimed();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      f.effect.id,
      receipt(f),
    );
    const configured = await repo.prepareOrganizationScheduleConfiguration(
      f.identity,
      f.claim,
      configuration(f),
    );
    await repo.prepareOrganizationScheduleCompensation(f.identity, f.claim);
    await expect(
      repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, configured.id),
    ).rejects.toThrow();
    const row = (
      await db.query("SELECT state FROM organization_schedule_effects WHERE id=$1", [configured.id])
    ).rows[0];
    expect(row.state).toBe("ready");
  });
  test("unknown configuration blocks release in the repository and direct SQL", async () => {
    const f = await claimed();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      f.effect.id,
      receipt(f),
    );
    const configured = await repo.prepareOrganizationScheduleConfiguration(
      f.identity,
      f.claim,
      configuration(f),
    );
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, configured.id);
    await expect(
      repo.prepareOrganizationScheduleCompensation(f.identity, f.claim),
    ).rejects.toThrow();
    const payload = {
      kind: "schedule_release",
      scheduleId: "sub_sched_original",
      params: { preserve_cancel_date: true },
    };
    await expect(
      db.query(
        `INSERT INTO organization_schedule_effects
      (organization_id,command_id,predecessor_id,kind,provider_idempotency_key,customer_id,subscription_id,livemode,request_payload,request_digest,created_at)
      VALUES ($1,$2,$3,'schedule_release',$4,$5,$6,$7,$8,repeat('a',64),clock_timestamp())`,
        [
          f.identity.organizationId,
          f.identity.commandId,
          f.effect.id,
          `organization-schedule:${f.identity.commandId}:schedule_release`,
          f.effect.customer_id,
          f.effect.subscription_id,
          f.effect.livemode,
          JSON.stringify(payload),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
