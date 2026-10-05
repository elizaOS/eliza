/** Real PostgreSQL cleanup authority; provider traffic is synthetic. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";
import { seedOrganizationDowngradeTestAccount } from "./organization-downgrade-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";

let stripeMock: unknown;
mock.module(resolve(import.meta.dir, "../../lib/stripe.ts"), () => ({
  requireStripe: () => stripeMock,
}));
const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `schedule_configured_finalizer_${randomUUID().replaceAll("-", "_")}`;
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

(url ? describe : describe.skip)("original configuration finalization", () => {
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
  async function providerCreated() {
    const f = await claimed();
    const { originalScheduleTestInput } = await import(
      "../../lib/services/organization-schedule-provider-test-fixture"
    );
    const { completeScheduleSubscriptionTestObservation, scheduleCustomerTestObservation } =
      await import("../../lib/services/organization-schedule-test-fixture");
    const start = await repo.markOrganizationScheduleEffectDispatch(
      f.identity,
      f.claim,
      f.effect.id,
    );
    const rawCreate = structuredClone(originalScheduleTestInput().rawCurrentSchedule);
    rawCreate.id = "sub_sched_owned";
    rawCreate.default_settings.description = null;
    rawCreate.customer = f.source.stripe_customer_id;
    rawCreate.subscription = f.source.stripe_subscription_id;
    rawCreate.created = Math.floor(start.started_at!.getTime() / 1000);
    rawCreate.current_phase = {
      start_date: f.source.current_period_start.getTime() / 1000,
      end_date: f.source.current_period_end.getTime() / 1000,
    };
    rawCreate.phases[0]!.start_date = rawCreate.current_phase.start_date;
    rawCreate.phases[0]!.end_date = rawCreate.current_phase.end_date;
    function transport(raw: object, requestId: string, key: string) {
      return Object.defineProperty(raw, "lastResponse", {
        value: { requestId, idempotencyKey: key, apiVersion: "2024-11-20.acacia", statusCode: 200 },
      });
    }
    const createEvidence = {
      kind: "response" as const,
      raw: transport(rawCreate, "req_create", start.provider_idempotency_key),
    };
    await repo.recordAuthenticatedOrganizationScheduleEvidence(
      f.identity,
      f.claim,
      start.id,
      createEvidence,
    );
    return {
      ...f,
      rawCreate,
      createEvidence,
      transport,
      createKey: start.provider_idempotency_key,
      rawSubscription: completeScheduleSubscriptionTestObservation(f.provider),
      rawCustomer: scheduleCustomerTestObservation(f.source.stripe_customer_id),
    };
  }
  async function configured(recordReceipt = true, markDispatch = true) {
    const f = await providerCreated();
    const { mapOrganizationDowngradeSchedulePhases } = await import(
      "../../lib/services/organization-schedule-phase-mapping"
    );
    const { oneMonthlySchedulePhaseEnd } = await import(
      "../../lib/services/organization-schedule-configuration-proof"
    );
    const rawSubscription = { ...f.rawSubscription, schedule: f.rawCreate.id };
    const create = (
      await db.query(
        "SELECT * FROM organization_schedule_effects WHERE command_id=$1 AND kind='schedule_create'",
        [f.identity.commandId],
      )
    ).rows[0];
    const request = mapOrganizationDowngradeSchedulePhases({
      originalReceipt: create.receipt,
      originalRequest: {
        request: create.request_payload,
        providerIdempotencyKey: create.provider_idempotency_key,
        customerId: create.customer_id,
        subscriptionId: create.subscription_id,
        livemode: create.livemode,
        startedAt: create.started_at,
      },
      evidence: f.createEvidence,
      rawCurrentSchedule: f.rawCreate,
      rawSubscription,
      rawCustomer: f.rawCustomer,
      originalTerms: f.retainedTerms,
      observedAt: new Date(),
      targetPriceId: f.providerBinding.targetPriceId,
    });
    if (request.kind !== "schedule_configure") throw Error("Expected configuration");
    const prepared = await repo.prepareOrganizationScheduleConfiguration(
      f.identity,
      f.claim,
      request,
    );
    const started = markDispatch
      ? await repo.markOrganizationScheduleEffectDispatch(f.identity, f.claim, prepared.id)
      : prepared;
    const snapshot = {
      ...structuredClone(f.rawCreate),
      phases: request.params.phases.map((p, i) => ({
        ...f.rawCreate.phases[0],
        ...p,
        end_date: i === 0 ? p.end_date : oneMonthlySchedulePhaseEnd(p.start_date),
        items: p.items.map((item) => ({
          ...(f.rawCreate.phases[0]!.items as Record<string, unknown>[])[0],
          ...item,
          plan: item.price,
        })),
      })),
    };
    for (const phase of snapshot.phases) Reflect.deleteProperty(phase, "iterations");
    const configurationEvidence = {
      kind: "response" as const,
      raw: f.transport(
        structuredClone(snapshot),
        "req_configured",
        started.provider_idempotency_key,
      ),
    };
    if (recordReceipt)
      await repo.recordAuthenticatedOrganizationScheduleEvidence(
        f.identity,
        f.claim,
        started.id,
        configurationEvidence,
      );
    const input = {
      ...f.identity,
      leaseToken: f.claim.leaseToken,
      executionGeneration: f.claim.generation,
      createEvidence: f.createEvidence,
      configurationEvidence,
      rawCurrentSchedule: snapshot,
      rawSubscription,
      rawCustomer: f.rawCustomer,
    };
    const { finalizeConfiguredOrganizationSchedule: finalize } = await import(
      "./organization-schedule-finalization"
    );
    return { ...f, input, finalize, configurationEffect: started };
  }
  async function state(f: Awaited<ReturnType<typeof configured>>) {
    const source = (
      await db.query("SELECT * FROM billing_subscriptions WHERE id=$1", [f.captured.source.id])
    ).rows[0];
    const projection = (
      await db.query(
        "SELECT * FROM organization_entitlements WHERE organization_id=$1 AND billing_scope_id IS NULL",
        [f.identity.organizationId],
      )
    ).rows[0];
    const allowance = (
      await db.query(
        "SELECT to_jsonb(t) AS value FROM subscription_allowance_transactions t WHERE organization_id=$1 ORDER BY id",
        [f.identity.organizationId],
      )
    ).rows;
    const periods = (
      await db.query(
        "SELECT to_jsonb(t) AS value FROM subscription_allowance_periods t WHERE organization_id=$1 ORDER BY id",
        [f.identity.organizationId],
      )
    ).rows;
    const command = (
      await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [
        f.identity.commandId,
      ])
    ).rows[0];
    if (!source || !projection || !command) throw new Error("Fixture authority row missing");
    return { source, projection, allowance, periods, command };
  }
  test("original configuration atomically publishes only a pending plan and immutable replay", async () => {
    const f = await configured();
    const before = await state(f);
    const result = await f.finalize(f.input);
    const after = await state(f);
    expect(result.command.status).toBe("APPLIED");
    expect(result.replayed).toBeFalse();
    const snapshot = result.command.organization_schedule_configuration_snapshot;
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(f.input.rawCurrentSchedule)));
    const { settlementDigest } = await import("../../lib/services/settlement-digest");
    expect(settlementDigest(snapshot)).toBe(
      result.command.organization_schedule_configuration_evidence!.snapshotDigest,
    );
    expect(snapshot).not.toHaveProperty("lastResponse");
    expect(after.command.organization_schedule_configuration_snapshot).toEqual(snapshot);
    expect(after.source.plan_key).toBe("pro_monthly");
    expect(after.source.pending_plan_key).toBe("plus_monthly");
    expect(Number(after.source.lifecycle_revision)).toBe(
      Number(before.source.lifecycle_revision) + 1,
    );
    expect(after.projection.plan_key).toBe("pro_monthly");
    expect(after.projection.source_subscription_revision).toBe(after.source.lifecycle_revision);
    expect(after.allowance).toEqual(before.allowance);
    expect(after.periods).toEqual(before.periods);
    const replay = await f.finalize({
      ...f.input,
      rawCurrentSchedule: null,
      rawSubscription: null,
      rawCustomer: null,
    });
    expect(replay.replayed).toBeTrue();
    expect((await state(f)).source).toEqual(after.source);
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET organization_schedule_configuration_evidence=NULL WHERE id=$1",
        [f.identity.commandId],
      ),
    ).rejects.toThrow("immutable");
  });
  test("original snapshot cannot be removed or replaced after publication", async () => {
    const f = await configured();
    await f.finalize(f.input);
    const before = await state(f);
    for (const replacement of [
      null,
      {},
      { ...f.input.rawCurrentSchedule, customer: "cus_other" },
    ]) {
      await expect(
        db.query(
          "UPDATE billing_subscription_commands SET organization_schedule_configuration_snapshot=$2::jsonb WHERE id=$1",
          [f.identity.commandId, replacement === null ? null : JSON.stringify(replacement)],
        ),
      ).rejects.toThrow("immutable");
      expect(await state(f)).toEqual(before);
    }
  });
  test("snapshot cannot be attached before original configured publication", async () => {
    const f = await configured();
    const before = await state(f);
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET organization_schedule_configuration_snapshot=$2::jsonb WHERE id=$1",
        [f.identity.commandId, JSON.stringify(f.input.rawCurrentSchedule)],
      ),
    ).rejects.toThrow("requires original publication");
    expect(await state(f)).toEqual(before);
  });
  for (const [name, expression, message] of [
    ["missing", "NULL", "requires its original snapshot"],
    [
      "foreign customer",
      "jsonb_set(NEW.organization_schedule_configuration_snapshot,'{customer}','\"cus_other\"')",
      "requires original schedule scope",
    ],
    [
      "foreign target",
      "jsonb_set(NEW.organization_schedule_configuration_snapshot,'{phases,1,items,0,price}','\"price_other\"')",
      "requires original schedule scope",
    ],
  ] as const)
    test(`database rejects ${name} snapshot and rolls back pending publication`, async () => {
      const f = await configured();
      const before = await state(f);
      await db.query(`CREATE FUNCTION corrupt_snapshot_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.organization_schedule_configuration_evidence IS NOT NULL THEN
        NEW.organization_schedule_configuration_snapshot=${expression};
      END IF; RETURN NEW; END; $$;
      CREATE TRIGGER aaa_corrupt_snapshot_fixture BEFORE UPDATE ON billing_subscription_commands
      FOR EACH ROW EXECUTE FUNCTION corrupt_snapshot_fixture()`);
      try {
        await expect(f.finalize(f.input)).rejects.toMatchObject({
          cause: { code: "23514", message: expect.stringContaining(message) },
        });
        expect(await state(f)).toEqual(before);
      } finally {
        await db.query(
          "DROP TRIGGER aaa_corrupt_snapshot_fixture ON billing_subscription_commands; DROP FUNCTION corrupt_snapshot_fixture()",
        );
      }
      expect((await f.finalize(f.input)).command.status).toBe("APPLIED");
    });
  test("changed provider configuration retains original uncertainty and paid state", async () => {
    const f = await configured();
    const before = await state(f);
    f.input.rawCurrentSchedule.phases[1]!.items[0]!.price = "price_other";
    await expect(f.finalize(f.input)).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_SCHEDULE_CONFIGURATION_UNVERIFIED" }),
    );
    expect(await state(f)).toEqual(before);
  });
  test("expired lease cannot publish pending state", async () => {
    const f = await configured();
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.identity.commandId],
    );
    const before = await state(f);
    await expect(f.finalize(f.input)).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" }),
    );
    expect(await state(f)).toEqual(before);
  });
  test("foreign original actor cannot settle the command", async () => {
    const f = await configured();
    const before = await state(f);
    await expect(f.finalize({ ...f.input, actorId: randomUUID() })).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" }),
    );
    expect(await state(f)).toEqual(before);
  });
  test("organization fencing blocks pending-plan publication", async () => {
    const f = await configured();
    await db.query("UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1", [
      f.identity.organizationId,
    ]);
    const before = await state(f);
    await expect(f.finalize(f.input)).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" }),
    );
    expect(await state(f)).toEqual(before);
  });
  test("terminal write rollback also rolls back source and projection and supports retry", async () => {
    const f = await configured();
    const before = await state(f);
    await db.query(
      "CREATE FUNCTION reject_configured_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='downgrade' AND NEW.status='APPLIED' THEN RAISE EXCEPTION 'fixture final write rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_configured_fixture BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION reject_configured_fixture();",
    );
    try {
      await expect(f.finalize(f.input)).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "fixture final write rejected" }),
      });
      expect(await state(f)).toEqual(before);
    } finally {
      await db.query(
        "DROP TRIGGER reject_configured_fixture ON billing_subscription_commands; DROP FUNCTION reject_configured_fixture()",
      );
    }
    expect((await f.finalize(f.input)).command.status).toBe("APPLIED");
  });
  test("original read-only settlement survives manager revocation", async () => {
    const f = await configured();
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    expect((await f.finalize(f.input)).command.status).toBe("APPLIED");
  });
  test("current source drift cannot be overwritten by the original configured result", async () => {
    const f = await configured();
    await db.query("UPDATE billing_subscriptions SET provider_object_digest=$2 WHERE id=$1", [
      f.captured.source.id,
      "e".repeat(64),
    ]);
    const before = await state(f);
    await expect(f.finalize(f.input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
    expect(await state(f)).toEqual(before);
  });
  for (const lockTarget of ["organization", "association"] as const)
    test(`lease expiry while finalization waits for ${lockTarget} cannot commit stale pending state`, async () => {
      const f = await configured();
      const blocker = new Client({ connectionString: url });
      await blocker.connect();
      await blocker.query(`SET search_path TO ${schema},public`);
      await blocker.query("BEGIN");
      const blockerId = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query(
        lockTarget === "organization"
          ? "SELECT id FROM organizations WHERE id=$1 FOR UPDATE"
          : "SELECT organization_id FROM organization_subscription_authorities WHERE organization_id=$1 FOR UPDATE",
        [f.identity.organizationId],
      );
      const pending = f.finalize(f.input).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      try {
        let blocked = false;
        for (let i = 0; i < 400; i++) {
          blocked = (
            await db.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",
              [blockerId],
            )
          ).rows[0].blocked;
          if (blocked) break;
          await Bun.sleep(25);
        }
        expect(blocked).toBe(true);
        await db.query("SET lock_timeout='1s'");
        await db.query(
          "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [f.identity.commandId],
        );
      } finally {
        await blocker.query("COMMIT");
        await blocker.end();
        await db.query("SET lock_timeout='0'");
      }
      const result = await pending;
      expect(result.error).toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
      expect(
        (
          await db.query(
            "SELECT status,organization_schedule_configuration_evidence AS evidence FROM billing_subscription_commands WHERE id=$1",
            [f.identity.commandId],
          )
        ).rows[0],
      ).toEqual({ status: "OUTCOME_UNKNOWN", evidence: null });
    }, 30000);
  function providerFor(f: Awaited<ReturnType<typeof configured>>, events: unknown[]) {
    const calls: string[] = [];
    const noWrite = () => {
      throw new Error("Unexpected provider mutation during recovery");
    };
    stripeMock = {
      events: {
        list: async () => {
          calls.push("events");
          return { object: "list", data: events, has_more: false };
        },
      },
      customers: {
        retrieve: async () => {
          calls.push("customer");
          return f.input.rawCustomer;
        },
      },
      subscriptions: {
        retrieve: async () => {
          calls.push("subscription");
          return f.input.rawSubscription;
        },
      },
      subscriptionSchedules: {
        retrieve: async () => {
          calls.push("schedule");
          return f.input.rawCurrentSchedule;
        },
        create: noWrite,
        update: noWrite,
        release: noWrite,
      },
    };
    return calls;
  }
  function originalEvents(f: Awaited<ReturnType<typeof configured>>) {
    return [
      {
        id: "evt_originalCreate",
        type: "subscription_schedule.created",
        raw: f.rawCreate,
        key: f.createKey,
        requestId: "req_create",
        created: f.rawCreate.created,
      },
      {
        id: "evt_originalConfigure",
        type: "subscription_schedule.updated",
        raw: f.input.rawCurrentSchedule,
        key: f.configurationEffect.provider_idempotency_key,
        requestId: "req_configured",
        created: Math.floor(f.configurationEffect.started_at!.getTime() / 1000),
      },
    ].map((e) => ({
      id: e.id,
      object: "event",
      type: e.type,
      livemode: false,
      api_version: "2024-11-20.acacia",
      created: e.created,
      request: { id: e.requestId, idempotency_key: e.key },
      data: { object: structuredClone(e.raw) },
    }));
  }
  async function publication() {
    return (await import("../../lib/services/organization-schedule-publication"))
      .observeAndFinalizeOrganizationScheduleConfiguration;
  }
  test("direct publication uses fresh provider reads and no additional financial write", async () => {
    const f = await configured();
    const calls = providerFor(f, []);
    expect(
      (
        await (
          await publication()
        )(f.identity, f.claim, {
          create: f.input.createEvidence,
          configuration: f.input.configurationEvidence,
        })
      ).command.status,
    ).toBe("APPLIED");
    expect(calls).toEqual(["customer", "subscription", "schedule"]);
    const after = await state(f);
    expect(after.source.pending_plan_key).toBe("plus_monthly");
    calls.length = 0;
    expect((await (await publication())(f.identity, f.claim)).replayed).toBeTrue();
    expect(calls).toEqual([]);
  });
  test("lost configure response recovers original events and stores one original receipt", async () => {
    const f = await configured(false);
    const calls = providerFor(f, originalEvents(f));
    const before = await state(f);
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.identity.actorId]);
    expect((await (await publication())(f.identity, f.claim)).command.status).toBe("APPLIED");
    expect(calls).toEqual(["events", "events", "customer", "subscription", "schedule"]);
    const effect = (
      await db.query("SELECT state,receipt FROM organization_schedule_effects WHERE id=$1", [
        f.configurationEffect.id,
      ])
    ).rows[0];
    expect(effect.state).toBe("observed");
    expect(effect.receipt.kind).toBe("event");
    const after = await state(f);
    expect(after.allowance).toEqual(before.allowance);
    expect(after.periods).toEqual(before.periods);
  });
  test("original response receipt survives supplemental configuration event recovery", async () => {
    const f = await configured();
    providerFor(f, originalEvents(f));
    const before = (
      await db.query(
        "SELECT receipt,receipt_digest FROM organization_schedule_effects WHERE id=$1",
        [f.configurationEffect.id],
      )
    ).rows;
    expect((await (await publication())(f.identity, f.claim)).command.status).toBe("APPLIED");
    expect(
      (
        await db.query(
          "SELECT receipt,receipt_digest FROM organization_schedule_effects WHERE id=$1",
          [f.configurationEffect.id],
        )
      ).rows,
    ).toEqual(before);
  });
  test("missing event history never retires or replays uncertain configuration", async () => {
    const f = await configured(false);
    const calls = providerFor(f, []);
    const before = await state(f);
    await expect((await publication())(f.identity, f.claim)).rejects.toMatchObject({
      code: "SUBSCRIPTION_SCHEDULE_RECOVERY_UNAVAILABLE",
    });
    expect(calls).toEqual(["events"]);
    expect(await state(f)).toEqual(before);
    expect(
      (
        await db.query("SELECT state FROM organization_schedule_effects WHERE id=$1", [
          f.configurationEffect.id,
        ])
      ).rows[0].state,
    ).toBe("started");
  });
  test("later schedule drift retains recovered receipt but cannot publish a pending plan", async () => {
    const f = await configured(false);
    const events = originalEvents(f);
    f.input.rawCurrentSchedule.phases[1]!.items[0]!.price = "price_foreign";
    providerFor(f, events);
    const before = await state(f);
    await expect((await publication())(f.identity, f.claim)).rejects.toMatchObject({
      code: "SUBSCRIPTION_SCHEDULE_CONFIGURATION_UNVERIFIED",
    });
    expect(await state(f)).toEqual(before);
    expect(
      (
        await db.query("SELECT state FROM organization_schedule_effects WHERE id=$1", [
          f.configurationEffect.id,
        ])
      ).rows[0].state,
    ).toBe("observed");
  });
  test("lease lost during fresh observation retains evidence without stale publication", async () => {
    const f = await configured(false);
    providerFor(f, originalEvents(f));
    (stripeMock as { customers: unknown }).customers = {
      retrieve: async () => {
        await db.query(
          "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [f.identity.commandId],
        );
        return f.input.rawCustomer;
      },
    };
    await expect((await publication())(f.identity, f.claim)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
    const after = await state(f);
    expect(after.source.pending_plan_key).toBeNull();
    expect(after.command.status).toBe("OUTCOME_UNKNOWN");
    expect(
      (
        await db.query("SELECT state FROM organization_schedule_effects WHERE id=$1", [
          f.configurationEffect.id,
        ])
      ).rows[0].state,
    ).toBe("observed");
  });
  function recurringInvoice(f: Awaited<ReturnType<typeof configured>>) {
    const start = Math.floor(f.source.current_period_end.getTime() / 1000);
    return {
      id: "upcoming_in_lower",
      object: "invoice",
      status: "draft",
      livemode: false,
      customer: f.source.stripe_customer_id,
      subscription: f.source.stripe_subscription_id,
      currency: "usd",
      charge: null,
      payment_intent: null,
      paid: false,
      paid_out_of_band: false,
      amount_paid: 0,
      amount_due: 3000,
      amount_remaining: 0,
      billing_reason: "subscription_cycle",
      subtotal: 3000,
      subtotal_excluding_tax: 3000,
      total: 3000,
      tax: 0,
      total_discount_amounts: [],
      total_tax_amounts: [],
      starting_balance: 0,
      period_start: start,
      period_end: start + 30 * 86400,
      hosted_invoice_url: null,
      collection_method: "charge_automatically",
      on_behalf_of: null,
      transfer_data: null,
      application_fee_amount: null,
      automatic_tax: { enabled: false, status: null },
      lines: {
        has_more: false,
        data: [
          {
            id: "il_lower",
            type: "subscription",
            subscription: f.source.stripe_subscription_id,
            subscription_item: f.source.stripe_subscription_item_id,
            price: { id: "price_plus" },
            quantity: 1,
            currency: "usd",
            amount: 3000,
            discount_amounts: [],
            tax_amounts: [],
            period: { start, end: start + 30 * 86400 },
            proration: false,
          },
        ],
      },
    };
  }
  function dispatchProvider(f: Awaited<ReturnType<typeof configured>>, loseResponse = false) {
    process.env.STRIPE_SECRET_KEY = ["sk", "test", "schedulepublication"].join("_");
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
    process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
    let updated = false,
      updates = 0;
    const calls = providerFor(f, []);
    const stripe = stripeMock as Record<string, unknown>;
    stripe.prices = {
      retrieve: async (id: string) => ({
        id,
        active: true,
        currency: "usd",
        currency_options: {},
        unit_amount: id === "price_plus" ? 3000 : 10000,
        type: "recurring",
        billing_scheme: "per_unit",
        transform_quantity: null,
        recurring: {
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
        product: id === "price_plus" ? "prod_plus" : "prod_pro",
        livemode: false,
      }),
    };
    stripe.products = { retrieve: async (id: string) => ({ id, active: true, livemode: false }) };
    stripe.invoices = {
      createPreview: async (request: unknown) => {
        expect(request).toEqual({
          customer: f.source.stripe_customer_id,
          schedule: f.rawCreate.id,
          preview_mode: "recurring",
          schedule_details:
            f.configurationEffect.request_payload.kind === "schedule_configure"
              ? f.configurationEffect.request_payload.params
              : null,
        });
        return recurringInvoice(f);
      },
    };
    stripe.subscriptionSchedules = {
      retrieve: async () => (updated ? f.input.rawCurrentSchedule : f.rawCreate),
      update: async (id: string, params: unknown, options: unknown) => {
        updates++;
        expect(id).toBe(f.rawCreate.id);
        expect(options).toEqual({
          apiVersion: "2024-11-20.acacia",
          idempotencyKey: f.configurationEffect.provider_idempotency_key,
          maxNetworkRetries: 0,
        });
        expect(params).toEqual(
          f.configurationEffect.request_payload.kind === "schedule_configure"
            ? f.configurationEffect.request_payload.params
            : null,
        );
        updated = true;
        if (loseResponse) throw new Error("lost original configure response");
        return f.transport(
          structuredClone(f.input.rawCurrentSchedule),
          "req_configured",
          f.configurationEffect.provider_idempotency_key,
        );
      },
    };
    return { calls, updates: () => updates, stripe };
  }
  test("one-shot dispatcher persists original receipt then atomically publishes through fresh reads", async () => {
    const f = await configured(false, false);
    const provider = dispatchProvider(f);
    const before = await state(f);
    const { dispatchOrganizationScheduleConfiguration } = await import(
      "../../lib/services/organization-schedule-configuration"
    );
    const result = await dispatchOrganizationScheduleConfiguration(
      f.identity,
      f.claim,
      f.configurationEffect.id,
      async () => {},
      f.input.createEvidence,
    );
    expect(result.resolution.command.status).toBe("APPLIED");
    expect(provider.updates()).toBe(1);
    const after = await state(f);
    expect(after.source.plan_key).toBe("pro_monthly");
    expect(after.source.pending_plan_key).toBe("plus_monthly");
    expect(after.allowance).toEqual(before.allowance);
  });
  test("actual dispatch lost response reconciles original event without a second update", async () => {
    const f = await configured(false, false);
    const provider = dispatchProvider(f, true);
    const { dispatchOrganizationScheduleConfiguration } = await import(
      "../../lib/services/organization-schedule-configuration"
    );
    await expect(
      dispatchOrganizationScheduleConfiguration(
        f.identity,
        f.claim,
        f.configurationEffect.id,
        async () => {},
        f.input.createEvidence,
      ),
    ).rejects.toThrow("lost original configure response");
    const effect = (
      await db.query("SELECT * FROM organization_schedule_effects WHERE id=$1", [
        f.configurationEffect.id,
      ])
    ).rows[0];
    expect(effect.state).toBe("started");
    f.configurationEffect = effect;
    provider.stripe.events = {
      list: async () => ({ object: "list", has_more: false, data: originalEvents(f) }),
    };
    expect((await (await publication())(f.identity, f.claim)).command.status).toBe("APPLIED");
    expect(provider.updates()).toBe(1);
  });
});
