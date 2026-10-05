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
const schema = `schedule_${randomUUID().replaceAll("-", "_")}`;
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
async function state(commandId: string) {
  return (
    await db.query(
      "SELECT status,lease_token,execution_generation FROM billing_subscription_commands WHERE id=$1",
      [commandId],
    )
  ).rows[0];
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
  test("concurrent claims allocate one original create request and one live lease", async () => {
    const f = await seed();
    const results = await Promise.all([
      repo.claimOrganizationSchedule(f.identity),
      repo.claimOrganizationSchedule(f.identity),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const r = results.find(Boolean)!;
    expect(r.effect.request_payload).toEqual({
      kind: "schedule_create",
      subscriptionId: f.source.stripe_subscription_id,
    });
    expect(r.effect.state).toBe("ready");
    expect(r.canDispatch).toBe(true);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM organization_schedule_effects WHERE command_id=$1",
          [f.identity.commandId],
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });
  test("recovery cannot mint an initial effect or take a live lease", async () => {
    const f = await seed();
    expect(await repo.claimOrganizationSchedule(f.identity, "recovery")).toBeNull();
    const r = await repo.claimOrganizationSchedule(f.identity);
    expect(r).not.toBeNull();
    expect(await repo.claimOrganizationSchedule(f.identity, "recovery")).toBeNull();
  });
  test("each request can cross dispatch once; a replacement lease never redispatches a started effect", async () => {
    const f = await claimed();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await expect(
      repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id),
    ).rejects.toThrow();
    await repo.finishOrganizationScheduleAttempt(f.identity, f.claim);
    const recovered = await repo.claimOrganizationSchedule(f.identity, "recovery");
    expect(recovered!.canDispatch).toBe(false);
    expect(recovered!.effect.provider_idempotency_key).toBe(f.effect.provider_idempotency_key);
    await expect(
      repo.markOrganizationScheduleEffectDispatch(f.identity, recovered!.claim, f.effect.id),
    ).rejects.toThrow();
  });
  test("an expired original lease cannot dispatch or observe after replacement", async () => {
    const f = await claimed();
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.identity.commandId],
    );
    await expect(
      repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id),
    ).rejects.toThrow();
    const replacement = await repo.claimOrganizationSchedule(f.identity);
    expect(replacement!.claim.generation).toBe(f.claim.generation + 1);
    await repo.markOrganizationScheduleEffectDispatch(f.identity, replacement!.claim, f.effect.id);
    await expect(
      repo.recordOrganizationScheduleEffectReceipt(f.identity, f.claim, f.effect.id, receipt(f)),
    ).rejects.toThrow();
    expect(await repo.finishOrganizationScheduleAttempt(f.identity, f.claim)).toBe(false);
  });
  test("foreign identity, request key, mode or premature receipt cannot become original evidence", async () => {
    const f = await claimed();
    await expect(
      repo.recordOrganizationScheduleEffectReceipt(f.identity, f.claim, f.effect.id, receipt(f)),
    ).rejects.toThrow();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    for (const mutation of [
      { customerId: "cus_foreign" },
      { subscriptionId: "sub_foreign" },
      { livemode: true },
      { providerIdempotencyKey: "foreign-original-request" },
      { observedAt: new Date(Date.now() + 60000).toISOString() },
    ])
      await expect(
        repo.recordOrganizationScheduleEffectReceipt(f.identity, f.claim, f.effect.id, {
          ...receipt(f),
          ...mutation,
        }),
      ).rejects.toThrow();
  });
  test("original receipts are immutable, idempotent, and survive manager revocation without granting new dispatch", async () => {
    const f = await claimed();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    const evidence = receipt(f);
    const saved = await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      f.effect.id,
      evidence,
    );
    expect(saved.state).toBe("observed");
    expect(
      (
        await repo.recordOrganizationScheduleEffectReceipt(
          f.identity,
          f.claim,
          f.effect.id,
          evidence,
        )
      ).receipt_digest,
    ).toBe(saved.receipt_digest);
    await expect(
      repo.recordOrganizationScheduleEffectReceipt(f.identity, f.claim, f.effect.id, {
        ...evidence,
        scheduleId: "sub_sched_other",
      }),
    ).rejects.toThrow();
    await expect(
      repo.prepareOrganizationScheduleConfiguration(f.identity, f.claim, configuration(f)),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" });
    expect(await repo.finishOrganizationScheduleAttempt(f.identity, f.claim)).toBe(true);
  });
  test("configuration requires the original observed create and retains a different stable request key", async () => {
    const f = await claimed();
    await expect(
      repo.prepareOrganizationScheduleConfiguration(f.identity, f.claim, configuration(f)),
    ).rejects.toThrow();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      f.effect.id,
      receipt(f),
    );
    await expect(
      repo.prepareOrganizationScheduleConfiguration(
        f.identity,
        f.claim,
        configuration(f, "sub_sched_other"),
      ),
    ).rejects.toThrow();
    const configured = await repo.prepareOrganizationScheduleConfiguration(
      f.identity,
      f.claim,
      configuration(f),
    );
    expect(configured.predecessor_id).toBe(f.effect.id);
    expect(configured.provider_idempotency_key).not.toBe(f.effect.provider_idempotency_key);
    expect(
      (await repo.prepareOrganizationScheduleConfiguration(f.identity, f.claim, configuration(f)))
        .id,
    ).toBe(configured.id);
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, configured.id);
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      configured.id,
      receipt(f, configured),
    );
    expect(
      (
        await db.query("SELECT plan_key,pending_plan_key FROM billing_subscriptions WHERE id=$1", [
          f.input.subscriptionId,
        ])
      ).rows[0],
    ).toEqual({ plan_key: "pro_monthly", pending_plan_key: null });
    expect(
      (await db.query("SELECT count(*)::int n FROM subscription_allowance_transactions")).rows[0],
    ).toEqual({ n: 0 });
    expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
  });
  test("configuration cannot change boundary, current price, target price or approved request", async () => {
    const f = await claimed();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await repo.recordOrganizationScheduleEffectReceipt(
      f.identity,
      f.claim,
      f.effect.id,
      receipt(f),
    );
    for (const field of ["boundary", "source", "target"]) {
      const r = configuration(f);
      if (field === "boundary") r.params.phases[1].start_date++;
      else r.params.phases[field === "source" ? 0 : 1].items[0]!.price = "price_foreign";
      await expect(
        repo.prepareOrganizationScheduleConfiguration(f.identity, f.claim, r),
      ).rejects.toThrow();
    }
    await repo.prepareOrganizationScheduleConfiguration(f.identity, f.claim, configuration(f));
    const altered = configuration(f);
    altered.params.phases[1].description = "changed after staging";
    await expect(
      repo.prepareOrganizationScheduleConfiguration(f.identity, f.claim, altered),
    ).rejects.toThrow();
  });
  test("database guards reject request edits, dispatch without complete provenance, and audit deletion", async () => {
    const f = await claimed();
    for (const query of [
      "UPDATE organization_schedule_effects SET request_digest=repeat('b',64) WHERE id=$1",
      "UPDATE organization_schedule_effects SET state='started',started_at=clock_timestamp() WHERE id=$1",
      "DELETE FROM organization_schedule_effects WHERE id=$1",
    ])
      await expect(db.query(query, [f.effect.id])).rejects.toMatchObject({ code: "23514" });
  });
  test("another tenant cannot claim, dispatch, release or retain the original effect", async () => {
    const f = await claimed(),
      other = await seed();
    for (const identity of [
      { ...f.identity, organizationId: other.identity.organizationId },
      { ...f.identity, actorId: other.identity.actorId },
    ]) {
      await expect(repo.claimOrganizationSchedule(identity)).rejects.toThrow();
      await expect(
        repo.markOrganizationScheduleEffectDispatch(identity, f.claim, f.effect.id),
      ).rejects.toThrow();
      await expect(repo.finishOrganizationScheduleAttempt(identity, f.claim)).rejects.toThrow();
    }
  });
  test("expired unstarted effects can retire; partial creation remains unknown for recovery", async () => {
    for (const started of [false, true]) {
      const f = await claimed(2500);
      if (started) {
        await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
        await repo.recordOrganizationScheduleEffectReceipt(
          f.identity,
          f.claim,
          f.effect.id,
          receipt(f),
        );
      }
      await Bun.sleep(2600);
      await repo.finishOrganizationScheduleAttempt(f.identity, f.claim);
      expect((await state(f.identity.commandId)).status).toBe(
        started ? "OUTCOME_UNKNOWN" : "FAILED",
      );
    }
  }, 20000);
  test("effect lock waits use fresh time before dispatch", async () => {
    const f = await claimed(4000);
    await db.query("BEGIN");
    let checked: Promise<unknown> | undefined;
    try {
      await db.query("SELECT id FROM organization_schedule_effects WHERE id=$1 FOR UPDATE", [
        f.effect.id,
      ]);
      checked = repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id).then(
        () => null,
        (error: unknown) => error,
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (
          await db.query(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid()=ANY(pg_blocking_pids(pid))) waiting",
          )
        ).rows[0].waiting;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await Bun.sleep(Math.max(0, f.quote.expires_at.getTime() - Date.now() + 50));
    } finally {
      await db.query("COMMIT");
    }
    expect(await checked).toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
  }, 20000);
  test("claim and initial request insertion roll back together", async () => {
    const f = await seed();
    await db.query(
      "CREATE FUNCTION fixture_reject_schedule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture insert failure'; END; $$",
    );
    await db.query(
      "CREATE TRIGGER fixture_reject_schedule BEFORE INSERT ON organization_schedule_effects FOR EACH ROW EXECUTE FUNCTION fixture_reject_schedule()",
    );
    try {
      await expect(repo.claimOrganizationSchedule(f.identity)).rejects.toThrow();
      expect(await state(f.identity.commandId)).toMatchObject({
        status: "PREPARED",
        lease_token: null,
        execution_generation: "0",
      });
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM organization_schedule_effects WHERE command_id=$1",
            [f.identity.commandId],
          )
        ).rows[0],
      ).toEqual({ n: 0 });
    } finally {
      await db.query("DROP TRIGGER fixture_reject_schedule ON organization_schedule_effects");
      await db.query("DROP FUNCTION fixture_reject_schedule()");
    }
  });
  test("source customer changes block dispatch while original evidence remains retainable", async () => {
    const ready = await claimed();
    await db.query("UPDATE organizations SET stripe_customer_id='cus_changed' WHERE id=$1", [
      ready.identity.organizationId,
    ]);
    await expect(
      repo.markOrganizationScheduleEffectDispatch(ready.identity, ready.claim, ready.effect.id),
    ).rejects.toThrow();
    const started = await claimed();
    await repo.markOrganizationScheduleEffectDispatch(
      started.identity,
      started.claim,
      started.effect.id,
    );
    await db.query("UPDATE organizations SET stripe_customer_id='cus_changed' WHERE id=$1", [
      started.identity.organizationId,
    ]);
    expect(
      (
        await repo.recordOrganizationScheduleEffectReceipt(
          started.identity,
          started.claim,
          started.effect.id,
          receipt(started),
        )
      ).state,
    ).toBe("observed");
  });
  test("read-only recovery after revocation can retain the original result but cannot configure", async () => {
    const f = await claimed();
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await repo.finishOrganizationScheduleAttempt(f.identity, f.claim);
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    const recovered = await repo.claimOrganizationSchedule(f.identity, "recovery");
    expect(recovered!.canDispatch).toBe(false);
    expect(
      (
        await repo.recordOrganizationScheduleEffectReceipt(
          f.identity,
          recovered!.claim,
          f.effect.id,
          receipt(f),
        )
      ).state,
    ).toBe("observed");
    await expect(
      repo.prepareOrganizationScheduleConfiguration(f.identity, recovered!.claim, configuration(f)),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" });
  });
  test("database refuses a predecessor receipt borrowed from another command and tenant", async () => {
    const original = await claimed(),
      other = await claimed();
    for (const f of [original, other]) {
      await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
      await repo.recordOrganizationScheduleEffectReceipt(
        f.identity,
        f.claim,
        f.effect.id,
        receipt(f, f.effect, f === original ? "sub_sched_original" : "sub_sched_other"),
      );
    }
    await expect(
      db.query(
        `INSERT INTO organization_schedule_effects
      (organization_id,command_id,predecessor_id,kind,provider_idempotency_key,customer_id,subscription_id,livemode,request_payload,request_digest,created_at)
      VALUES ($1,$2,$3,'schedule_configure',$4,$5,$6,false,$7::jsonb,$8,clock_timestamp())`,
        [
          other.identity.organizationId,
          other.identity.commandId,
          original.effect.id,
          `organization-schedule:${other.identity.commandId}:schedule_configure`,
          other.effect.customer_id,
          other.effect.subscription_id,
          JSON.stringify(configuration(other)),
          "a".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  test("database command guards preserve started uncertainty and forbid lease revival", async () => {
    const f = await claimed();
    for (const sql of [
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
      "UPDATE billing_subscription_commands SET execution_generation=execution_generation+1 WHERE id=$1",
      "UPDATE billing_subscription_commands SET lease_token=gen_random_uuid(),execution_generation=execution_generation+1 WHERE id=$1",
    ])
      await expect(db.query(sql, [f.identity.commandId])).rejects.toMatchObject({ code: "23514" });
    await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, f.effect.id);
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET status='FAILED',error_code='injected',completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,state_revision=state_revision+1 WHERE id=$1",
        [f.identity.commandId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
  });
  test("authenticated evidence uses stored identity and retains its first observation on replay", async () => {
    const f = await claimed();
    const started = await repo.markOrganizationScheduleEffectDispatch(
      f.identity,
      f.claim,
      f.effect.id,
    );
    const raw = {
      id: "sub_sched_authenticated",
      object: "subscription_schedule",
      customer: f.effect.customer_id,
      subscription: f.effect.subscription_id,
      livemode: f.effect.livemode,
      created: Math.floor(started.started_at!.getTime() / 1000),
      application: null,
      status: "active",
      canceled_at: null,
      completed_at: null,
      released_at: null,
      released_subscription: null,
      end_behavior: "release",
      current_phase: {
        start_date: f.source.current_period_start.getTime() / 1000,
        end_date: f.source.current_period_end.getTime() / 1000,
      },
      phases: [{ items: [{ price: "price_pro", quantity: 1 }] }],
      default_settings: { default_payment_method: "pm_original" },
    };
    const transport = {
      requestId: "req_authenticated",
      statusCode: 200,
      apiVersion: "2024-11-20.acacia",
      idempotencyKey: f.effect.provider_idempotency_key,
    };
    Object.defineProperty(raw, "lastResponse", { value: transport });
    const evidence = { kind: "response" as const, raw };
    const first = await repo.recordAuthenticatedOrganizationScheduleEvidence(
      f.identity,
      f.claim,
      f.effect.id,
      evidence,
    );
    const replay = await repo.recordAuthenticatedOrganizationScheduleEvidence(
      f.identity,
      f.claim,
      f.effect.id,
      evidence,
    );
    expect(first.state).toBe("observed");
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.observed_at).toEqual(first.observed_at);
    expect(replay.observation_generation).toBe(first.observation_generation);
    raw.default_settings.default_payment_method = "pm_changed";
    await expect(
      repo.recordAuthenticatedOrganizationScheduleEvidence(
        f.identity,
        f.claim,
        f.effect.id,
        evidence,
      ),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
    expect((await state(f.identity.commandId)).status).toBe("OUTCOME_UNKNOWN");
  });
  test("foreign authenticated event cannot mark a started effect observed", async () => {
    const f = await claimed();
    const started = await repo.markOrganizationScheduleEffectDispatch(
      f.identity,
      f.claim,
      f.effect.id,
    );
    const created = Math.floor(started.started_at!.getTime() / 1000);
    const raw = {
      id: "evt_schedule",
      object: "event",
      type: "subscription_schedule.created",
      api_version: "2024-11-20.acacia",
      created,
      livemode: f.effect.livemode,
      request: { id: "req_schedule", idempotency_key: "another-command" },
      data: {
        object: {
          id: "sub_sched_event",
          object: "subscription_schedule",
          customer: f.effect.customer_id,
          subscription: f.effect.subscription_id,
          livemode: f.effect.livemode,
          created,
          application: null,
          status: "active",
          canceled_at: null,
          completed_at: null,
          released_at: null,
          released_subscription: null,
          end_behavior: "release",
          current_phase: { start_date: created - 100, end_date: created + 100 },
          phases: [{}],
          default_settings: {},
        },
      },
    };
    const evidence = { kind: "event" as const, raw };
    await expect(
      repo.recordAuthenticatedOrganizationScheduleEvidence(
        f.identity,
        f.claim,
        f.effect.id,
        evidence,
      ),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_SCHEDULE_ORIGIN_UNVERIFIED" });
    expect(
      (await db.query("SELECT state FROM organization_schedule_effects WHERE id=$1", [f.effect.id]))
        .rows[0].state,
    ).toBe("started");
    raw.request.idempotency_key = f.effect.provider_idempotency_key;
    const saved = await repo.recordAuthenticatedOrganizationScheduleEvidence(
      f.identity,
      f.claim,
      f.effect.id,
      evidence,
    );
    expect(saved.state).toBe("observed");
    expect(saved.receipt?.eventId).toBe("evt_schedule");
  });
});
