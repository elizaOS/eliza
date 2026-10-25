/** Applies the new migration to actual pre-binding quote/command/effect rows. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { organizationDowngradeIntentDigest } from "../../lib/services/organization-downgrade-intent";
import { scheduleEffectRequestDigest } from "../../lib/services/organization-schedule-effect-contract";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { buildOrganizationDowngradeTestAccount } from "./organization-downgrade-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `schedule_legacy_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
let unconsumed: Awaited<ReturnType<typeof legacyQuote>>;
let started: Awaited<ReturnType<typeof legacyQuote>>;
let commandId: string;
let effectId: string;
async function legacyQuote() {
  const f = await buildOrganizationDowngradeTestAccount((q, v) => db.query(q, v));
  const quoteId = randomUUID();
  await db.query(
    `INSERT INTO organization_plan_change_quotes(id,organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,review,provider_binding,created_at,expires_at)
    VALUES($1,$2,$3,$4,1,'plus_monthly','v1',$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [
      quoteId,
      f.input.organizationId,
      f.input.actorId,
      f.input.subscriptionId,
      settlementDigest(f.captured),
      settlementDigest(f.review),
      JSON.stringify(f.review),
      JSON.stringify(f.providerBinding),
      f.review.observedAt,
      f.review.expiresAt,
    ],
  );
  return { ...f, quoteId };
}
(url ? describe : describe.skip)("historical schedule quote binding migration", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((q) => db.query(q), true, false);
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
    unconsumed = await legacyQuote();
    started = await legacyQuote();
    commandId = randomUUID();
    effectId = randomUUID();
    const token = randomUUID();
    const f = started;
    const digest = organizationDowngradeIntentDigest({
      organizationId: f.input.organizationId,
      actorId: f.input.actorId,
      quoteId: f.quoteId,
      reviewDigest: settlementDigest(f.review),
      sourceDigest: settlementDigest(f.captured),
      providerBinding: f.providerBinding,
    });
    await db.query(
      `INSERT INTO billing_subscription_commands(id,organization_id,requested_by_user_id,subscription_id,expected_subscription_revision,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest,created_at,updated_at)
      VALUES($1,$2,$3,$4,1,'downgrade','plus_monthly',$5,$6,$7,clock_timestamp(),clock_timestamp())`,
      [
        commandId,
        f.input.organizationId,
        f.input.actorId,
        f.input.subscriptionId,
        randomUUID(),
        `organization-downgrade:${commandId}`,
        digest,
      ],
    );
    await db.query(
      "UPDATE organization_plan_change_quotes SET consumed_by_command_id=$2,consumed_at=clock_timestamp() WHERE id=$1",
      [f.quoteId, commandId],
    );
    await db.query(
      "UPDATE billing_subscription_commands SET status='OUTCOME_UNKNOWN',state_revision=state_revision+1,execution_generation=1,attempt_count=1,lease_token=$2,lease_expires_at=clock_timestamp()+interval '60 seconds',provider_started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
      [commandId, token],
    );
    const request = {
      kind: "schedule_create" as const,
      subscriptionId: f.source.stripe_subscription_id,
    };
    await db.query(
      `INSERT INTO organization_schedule_effects(id,organization_id,command_id,kind,provider_idempotency_key,customer_id,subscription_id,livemode,request_payload,request_digest,state,created_at)
      VALUES($1,$2,$3,'schedule_create',$4,$5,$6,false,$7::jsonb,$8,'ready',clock_timestamp())`,
      [
        effectId,
        f.input.organizationId,
        commandId,
        `organization-schedule:${commandId}:schedule_create`,
        f.source.stripe_customer_id,
        f.source.stripe_subscription_id,
        JSON.stringify(request),
        scheduleEffectRequestDigest(request),
      ],
    );
    await db.query(
      "UPDATE organization_schedule_effects SET state='started',started_at=clock_timestamp(),started_generation=1,started_lease_token=$2 WHERE id=$1",
      [effectId, token],
    );
    await db.query(
      "UPDATE billing_subscription_commands SET lease_token=NULL,lease_expires_at=NULL,state_revision=state_revision+1 WHERE id=$1",
      [commandId],
    );
    const migration = await readFile(
      new URL("../migrations/0522_organization_schedule_quote_terms.sql", import.meta.url),
      "utf8",
    );
    for (const sql of migration.split("--> statement-breakpoint"))
      if (sql.trim()) await db.query(sql);
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("old unconsumed quotes require fresh review instead of silently adopting new terms", async () => {
    const { prepareOrganizationDowngrade } = await import("./organization-downgrade-commands");
    await expect(
      prepareOrganizationDowngrade({
        ...unconsumed.input,
        quoteId: unconsumed.quoteId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM billing_subscription_commands WHERE organization_id=$1",
          [unconsumed.input.organizationId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  test("a historical started effect remains recoverable but cannot acquire fabricated terms", async () => {
    const repo = await import("./organization-schedule-effects");
    const identity = {
      organizationId: started.input.organizationId,
      actorId: started.input.actorId,
      commandId,
    };
    const originalStart = (
      await db.query(
        "SELECT provider_started_at::text AS value FROM billing_subscription_commands WHERE id=$1",
        [commandId],
      )
    ).rows[0].value;
    const result = await repo.claimOrganizationSchedule(identity, "recovery");
    expect(
      (
        await db.query(
          "SELECT provider_started_at::text AS value FROM billing_subscription_commands WHERE id=$1",
          [commandId],
        )
      ).rows[0].value,
    ).toBe(originalStart);
    expect(result).not.toBeNull();
    expect(result!.canDispatch).toBe(false);
    expect(result!.claim.generation).toBe(2);
    const receipt = {
      kind: "response" as const,
      scheduleId: "sub_sched_historical",
      customerId: started.source.stripe_customer_id,
      subscriptionId: started.source.stripe_subscription_id,
      livemode: false,
      apiVersion: "2024-11-20.acacia" as const,
      providerRequestId: "req_historical",
      providerIdempotencyKey: `organization-schedule:${commandId}:schedule_create`,
      eventId: null,
      evidenceDigest: "a".repeat(64),
      observedAt: new Date().toISOString(),
    };
    expect(
      (
        await repo.recordOrganizationScheduleEffectReceipt(
          identity,
          result!.claim,
          effectId,
          receipt,
        )
      ).state,
    ).toBe("observed");
    await expect(
      db.query(
        "INSERT INTO organization_schedule_quote_terms(quote_id,organization_id,snapshot,snapshot_digest,created_at) VALUES($1,$2,$3::jsonb,$4,clock_timestamp())",
        [
          started.quoteId,
          identity.organizationId,
          JSON.stringify(started.retainedTerms),
          settlementDigest(started.retainedTerms),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      repo.prepareOrganizationScheduleConfiguration(identity, result!.claim, {
        kind: "schedule_configure",
        scheduleId: "sub_sched_historical",
        params: {
          end_behavior: "release",
          proration_behavior: "none",
          phases: [
            {
              start_date: started.provider.current_period_start,
              end_date: started.provider.current_period_end,
              items: [{ price: "price_pro", quantity: 1 }],
              proration_behavior: "none",
            },
            {
              start_date: started.provider.current_period_end,
              iterations: 1,
              items: [{ price: "price_plus", quantity: 1 }],
              proration_behavior: "none",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
    expect(
      (await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [commandId]))
        .rows[0].status,
    ).toBe("OUTCOME_UNKNOWN");
  });
});
