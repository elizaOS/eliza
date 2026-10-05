/** Real PostgreSQL cleanup authority; provider traffic is synthetic. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { seedOrganizationDowngradeTestAccount } from "./organization-downgrade-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";

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
  async function configured() {
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
    const started = await repo.markOrganizationScheduleEffectDispatch(
      f.identity,
      f.claim,
      prepared.id,
    );
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
    return { ...f, input, finalize };
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
});
